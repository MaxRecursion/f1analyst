using System.Buffers;
using System.Diagnostics;
using System.Runtime.InteropServices.JavaScript;
using System.Text.Json;
using Apache.Arrow;
using Apache.Arrow.Ipc;
using Demo.Shared;

namespace Demo.ArmA.WasmWorker.Engine;

/// <summary>
/// Arm A — duckdb-wasm in a dedicated Web Worker, driven over a four-function JS gateway.
/// </summary>
/// <remarks>
/// The engine has its own wasm module and its own linear memory, separate from the .NET
/// runtime's. That separation is the architecture's main asset: roughly 2 GiB for .NET
/// plus a distinct 4 GiB for DuckDB, fault isolation (an engine OOM kills a worker we
/// respawn rather than the app), and — the part that decides the demo — queries execute
/// off the UI thread, so the browser keeps painting while they run.
/// </remarks>
public sealed partial class DuckDbWasmEngine : IQueryEngine
{
    private const string Module = "duckdbGateway";

    private string _tableRef = "";
    private int _handleSeq;
    private bool _initialized;

    public string Name => "Arm A — duckdb-wasm in Web Worker";
    public string Topology => "Blazor (.NET wasm heap, UI thread) ⇄ JS gateway ⇄ Worker (duckdb-wasm heap)";
    public bool SupportsCancellation => true;
    public bool RunsOffUiThread => true;

    // ---- interop surface: four functions, and that is the whole of it ----

    [JSImport("initialize", Module)]
    private static partial Task<string> JsInitialize(string baseUrl);

    [JSImport("attachDataset", Module)]
    private static partial Task<string> JsAttachDataset(string url, string name);

    [JSImport("runQuery", Module)]
    private static partial Task<int> JsRunQuery(string sql, string handleId);

    [JSImport("copyResult", Module)]
    private static partial void JsCopyResult(
        string handleId,
        [JSMarshalAs<JSType.MemoryView>] ArraySegment<byte> destination);

    [JSImport("cancelQuery", Module)]
    private static partial Task<bool> JsCancelQuery(string handleId);

    [JSImport("lastStats", Module)]
    private static partial string JsLastStats();

    public async ValueTask InitializeAsync(StageRecorder timings, IProgress<string>? progress = null, CancellationToken ct = default)
    {
        if (_initialized) return;
        progress?.Report("Instantiating duckdb-wasm in a Web Worker…");

        await JSHost.ImportAsync(Module, "/duckdb-gateway.js");
        await timings.MeasureAsync(Stage.EngineInit, async () =>
        {
            var info = await JsInitialize("duckdb");
            progress?.Report($"Engine ready: {info}");
        });

        _initialized = true;
    }

    public async ValueTask AttachDatasetAsync(string datasetUrl, StageRecorder timings, CancellationToken ct = default)
    {
        await timings.MeasureAsync(Stage.DataAttach, async () =>
        {
            var json = await JsAttachDataset(datasetUrl, "demo.parquet");
            using var doc = JsonDocument.Parse(json);
            _tableRef = doc.RootElement.GetProperty("table").GetString()!;
        }, detail: "scanned in place from OPFS — bytes never enter the .NET heap");
    }

    public async ValueTask<QueryResult> ExecuteAsync(QuerySpec spec, StageRecorder timings, CancellationToken ct = default)
    {
        if (!_initialized) throw new InvalidOperationException("InitializeAsync must run first.");

        var handleId = $"q{Interlocked.Increment(ref _handleSeq)}";
        var sql = spec.Bind(_tableRef);

        // Cancellation is real here: the query runs in the worker, so the UI thread is
        // free to observe the token and tell the engine to stop.
        await using var reg = ct.Register(() => _ = JsCancelQuery(handleId));

        // --- execute (in the worker) ---
        var execStart = Stopwatch.GetTimestamp();
        var byteLength = await JsRunQuery(sql, handleId);
        var roundTripMs = Stopwatch.GetElapsedTime(execStart).TotalMilliseconds;

        // Split the round trip into engine time vs everything else, using the engine's
        // own clock. Reporting one blended number would hide where time actually goes.
        var stats = JsonDocument.Parse(JsLastStats()).RootElement;
        var engineMs = stats.GetProperty("queryMs").GetDouble();
        timings.Record(Stage.QueryExecute, engineMs, $"{byteLength / 1024.0:N0} KB of Arrow produced");

        if (byteLength == 0)
            return QueryResult.Empty;

        // --- transfer: the single cross-heap copy ---
        var buffer = ArrayPool<byte>.Shared.Rent(byteLength);
        try
        {
            var transferStart = Stopwatch.GetTimestamp();
            JsCopyResult(handleId, new ArraySegment<byte>(buffer, 0, byteLength));
            var copyMs = Stopwatch.GetElapsedTime(transferStart).TotalMilliseconds;
            timings.Record(Stage.ResultTransfer, copyMs, $"{byteLength / 1024.0 / 1024.0:N1} MB, one memcpy");

            // Anything in the round trip not accounted for by engine time or the copy
            // is gateway/promise overhead. Surface it rather than quietly dropping it.
            var overhead = roundTripMs - engineMs - copyMs;
            if (overhead > 1) timings.Record(Stage.ResultTransfer, overhead, "gateway + promise overhead");

            // --- decode Arrow IPC into columns ---
            return await timings.MeasureAsync(Stage.Decode, async () =>
            {
                using var stream = new MemoryStream(buffer, 0, byteLength, writable: false);
                using var reader = new ArrowStreamReader(stream);
                var result = await ArrowDecoder.ToQueryResultAsync(reader, byteLength, Name, ct);
                return result;
            }, r => $"{r.RowCount:N0} rows x {r.Columns.Count} cols");
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
        }
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}
