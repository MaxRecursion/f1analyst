using System.Diagnostics;
using System.Runtime.InteropServices.JavaScript;
using System.Text.Json;
using Demo.ArmC.Worker;
using Demo.Shared;
using Microsoft.JSInterop;

namespace Demo.ArmC.Host.Engine;

/// <summary>
/// Arm C — the in-process engine of Arm B, relocated into a .NET Web Worker.
/// </summary>
/// <remarks>
/// Application code calls C# and receives C#. There is no JavaScript anywhere above
/// this class, and cancellation is an ordinary <see cref="CancellationToken"/> passed
/// to <c>WebWorkerClient.InvokeAsync</c>. Inside the worker, DuckDB is statically
/// linked and its result vectors are read with no serialization at all.
/// <para>
/// What is paid for that: the worker's .NET instance has its own heap, so results must
/// be serialized to cross back. Arm B pays nothing here and Arm A pays one memcpy of
/// Arrow bytes; this arm currently pays JSON, which the timings expose rather than
/// bury. Whether that is worth it depends entirely on the result size — which is the
/// interesting finding, not a defect.
/// </para>
/// </remarks>
public sealed class WorkerHostedEngine(IJSRuntime js) : IQueryEngine
{
    private WebWorkerClient? _worker;
    private IJSObjectReference? _loader;
    private string _tableRef = "";

    private const string Q = "Demo.ArmC.Worker.WorkerMethods.";

    public string Name => "Arm C — .NET in a Web Worker (C#↔C#)";
    public string Topology => "Blazor (UI thread) ⇄ WebWorkerClient ⇄ Worker (.NET + DuckDB, one heap)";
    public bool SupportsCancellation => true;    // CancellationToken reaches InvokeAsync
    public bool RunsOffUiThread => true;

    public async ValueTask InitializeAsync(StageRecorder timings, IProgress<string>? progress = null, CancellationToken ct = default)
    {
        if (_worker is not null) return;
        progress?.Report("Starting a .NET instance in a Web Worker…");

        await timings.MeasureAsync(Stage.EngineInit, async () =>
        {
            _worker = await WebWorkerClient.CreateAsync(js, cancellationToken: ct);
            var json = await _worker.InvokeAsync<string>($"{Q}Initialize", [], cancellationToken: ct);
            using var doc = JsonDocument.Parse(json);
            if (!doc.RootElement.GetProperty("ok").GetBoolean())
                throw new InvalidOperationException(doc.RootElement.GetProperty("error").GetString());
            progress?.Report($"Worker ready: DuckDB {doc.RootElement.GetProperty("version").GetString()} (in the worker)");
        }, detail: "second .NET runtime booted in a worker");
    }

    public async ValueTask AttachDatasetAsync(string datasetUrl, StageRecorder timings, CancellationToken ct = default)
    {
        var start = Stopwatch.GetTimestamp();
        const string path = "/demo.parquet";

        // The worker fetches and stores the dataset itself — the main thread never
        // holds the bytes, which is the whole point of this topology.
        var json = await _worker!.InvokeAsync<string>($"{Q}Attach", [datasetUrl, path], cancellationToken: ct);
        using var doc = JsonDocument.Parse(json);
        if (!doc.RootElement.GetProperty("ok").GetBoolean())
            throw new InvalidOperationException($"worker could not read {path}");
        var bytes = doc.RootElement.TryGetProperty("bytes", out var b) ? b.GetInt32() : 0;

        _tableRef = $"read_parquet('{path}')";
        timings.Record(Stage.DataAttach, Stopwatch.GetElapsedTime(start).TotalMilliseconds,
                       $"{bytes / 1024.0 / 1024.0:N1} MB into the WORKER's heap — main thread untouched");
    }

    public async ValueTask<QueryResult> ExecuteAsync(QuerySpec spec, StageRecorder timings, CancellationToken ct = default)
    {
        var sql = spec.Bind(_tableRef);

        var roundTripStart = Stopwatch.GetTimestamp();
        var json = await _worker!.InvokeAsync<string>($"{Q}Execute", [sql, spec.RowLimit], cancellationToken: ct);
        var roundTripMs = Stopwatch.GetElapsedTime(roundTripStart).TotalMilliseconds;

        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        if (!root.GetProperty("ok").GetBoolean())
            throw new InvalidOperationException(root.GetProperty("error").GetString());

        // The worker measured its own execution; report its numbers rather than a
        // blended round trip, so engine time and boundary time stay distinguishable.
        var queryMs = root.GetProperty("queryMs").GetDouble();
        var readMs = root.GetProperty("readMs").GetDouble();
        var serializeMs = root.TryGetProperty("serializeMs", out var s) ? s.GetDouble() : 0;

        timings.Record(Stage.QueryExecute, queryMs, "DuckDB in the worker — zero-copy vector reads");
        timings.Record(Stage.ResultTransfer, Math.Max(0, roundTripMs - queryMs - readMs - serializeMs),
                       $"worker→main hop, {json.Length / 1024.0:N0} KB of JSON");

        var decodeStart = Stopwatch.GetTimestamp();
        var result = Deserialize(root, spec.RowLimit);
        timings.Record(Stage.Decode, Stopwatch.GetElapsedTime(decodeStart).TotalMilliseconds + serializeMs,
                       $"{result.RowCount:N0} rows (JSON serialize {serializeMs:N0} ms + parse)");

        return result;
    }

    private QueryResult Deserialize(JsonElement root, int rowLimit)
    {
        var rows = root.GetProperty("rows").GetInt32();
        var cols = new List<ResultColumn>();

        foreach (var c in root.GetProperty("columns").EnumerateArray())
        {
            var name = c.GetProperty("Name").GetString()!;
            var type = c.GetProperty("Type").GetString()!;
            var values = c.GetProperty("Values");
            var n = values.GetArrayLength();

            var numeric = type is "Integer" or "BigInt" or "SmallInt" or "TinyInt";
            var real = type is "Double" or "Decimal" or "Float";

            if (numeric || real)
            {
                var ct = real ? ColumnType.Double : ColumnType.Int64;
                Array store = real ? new double[n] : new long[n];
                var i = 0;
                foreach (var v in values.EnumerateArray())
                {
                    var s = v.ValueKind == JsonValueKind.Null ? null : v.GetString();
                    if (real) ((double[])store)[i] = double.TryParse(s, out var d) ? d : 0;
                    else ((long[])store)[i] = long.TryParse(s, out var l) ? l : 0;
                    i++;
                }
                cols.Add(new ResultColumn { Name = name, Type = ct, Length = n, Values = store });
            }
            else
            {
                var store = new string[n];
                var i = 0;
                foreach (var v in values.EnumerateArray())
                    store[i++] = v.ValueKind == JsonValueKind.Null ? "" : v.GetString() ?? "";
                cols.Add(new ResultColumn { Name = name, Type = ColumnType.String, Length = n, Values = store });
            }
        }

        return new QueryResult { Columns = cols, RowCount = rows, EngineName = Name };
    }

    public async ValueTask DisposeAsync()
    {
        if (_loader is not null) await _loader.DisposeAsync();
        if (_worker is not null) await _worker.DisposeAsync();
    }
}
