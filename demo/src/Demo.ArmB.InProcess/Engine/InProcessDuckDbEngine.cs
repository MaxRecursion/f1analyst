using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.JavaScript;
using Demo.Shared;

namespace Demo.ArmB.InProcess.Engine;

/// <summary>
/// Arm B — DuckDB statically linked into the .NET WebAssembly runtime and called by
/// P/Invoke. One wasm module, one linear memory, no JavaScript in the query path.
/// </summary>
/// <remarks>
/// The genuine advantages are real and worth stating plainly: there is no serialization,
/// no cross-heap copy and no decode stage, because DuckDB's result vectors are raw
/// pointers into the very memory .NET is running in. The Decode stage of this arm's
/// timings is a span cast.
/// <para>
/// The cost is equally real and shows up in a column no query-latency table would
/// contain: every one of these calls is synchronous on the UI thread. While a query
/// runs, the browser cannot paint, cannot process input, and cannot honour a Cancel
/// button — because the code that would handle the click is queued behind the query.
/// </para>
/// </remarks>
public sealed partial class InProcessDuckDbEngine : IQueryEngine
{
    private IntPtr _db, _con;
    private string _tableRef = "";
    private bool _initialized;

    public string Name => "Arm B — DuckDB in-process (P/Invoke)";
    public string Topology => "Blazor + DuckDB in ONE wasm module, ONE linear memory, executing on the UI thread";
    public bool SupportsCancellation => false;   // nothing is free to signal an interrupt
    public bool RunsOffUiThread => false;

    public ValueTask InitializeAsync(StageRecorder timings, IProgress<string>? progress = null, CancellationToken ct = default)
    {
        if (_initialized) return ValueTask.CompletedTask;
        progress?.Report("Opening in-process DuckDB…");

        var start = Stopwatch.GetTimestamp();
        if (DuckDbNative.Open(null, out _db) != DuckDbNative.Success)
            throw new InvalidOperationException("duckdb_open failed");
        if (DuckDbNative.Connect(_db, out _con) != DuckDbNative.Success)
            throw new InvalidOperationException("duckdb_connect failed");

        Exec("SET memory_limit='1500MB'");
        Exec("SET preserve_insertion_order=false");
        Exec("SET default_null_order='NULLS LAST'");

        timings.Record(Stage.EngineInit, Stopwatch.GetElapsedTime(start).TotalMilliseconds,
                       $"DuckDB {DuckDbNative.Version()} linked into dotnet.native.wasm");
        progress?.Report($"DuckDB {DuckDbNative.Version()} ready (in-process)");
        _initialized = true;
        return ValueTask.CompletedTask;
    }

    /// <summary>
    /// Fetch the Parquet and hand it to DuckDB.
    /// </summary>
    /// <remarks>
    /// Because DuckDB is linked into the same module, it shares the .NET runtime's
    /// Emscripten filesystem — so writing the bytes with <see cref="File.WriteAllBytes"/>
    /// makes them readable by DuckDB's own synchronous file API. That neatly sidesteps
    /// the usual objection that a synchronous engine cannot reach browser storage.
    /// <para>
    /// The price is that the entire file is resident in the single shared heap for the
    /// lifetime of the app, alongside Mono's heap and DuckDB's working memory, under one
    /// 2 GiB ceiling — where Arm A keeps the data on disk and streams row groups.
    /// </para>
    /// </remarks>
    public async ValueTask AttachDatasetAsync(string datasetUrl, StageRecorder timings, CancellationToken ct = default)
    {
        var start = Stopwatch.GetTimestamp();
        const string path = "/demo.parquet";

        // Pulling the bytes through .NET (HttpClient.GetByteArrayAsync +
        // File.WriteAllBytes) does not complete in any usable time on single-threaded
        // wasm — both copy byte-by-byte through the interpreter. Writing straight into
        // the Emscripten FS from JS is the only practical route, and it works because
        // DuckDB shares this module's filesystem.
        await JSHost.ImportAsync("wasmFs", "/wasmfs-loader.js");
        var byteCount = await JsLoadIntoWasmFs(datasetUrl, path);

        var stat = JsStatWasmFs(path);
        _tableRef = $"read_parquet('{path}')";

        timings.Record(Stage.DataAttach, Stopwatch.GetElapsedTime(start).TotalMilliseconds,
                       $"{byteCount / 1024.0 / 1024.0:N1} MB resident in the shared wasm heap ({stat})");
    }

    [JSImport("loadIntoWasmFs", "wasmFs")]
    private static partial Task<int> JsLoadIntoWasmFs(string url, string path);

    [JSImport("statWasmFs", "wasmFs")]
    private static partial string JsStatWasmFs(string path);

    /// <summary>Base address for the dataset fetch; set by Program.cs.</summary>
    public static string Navigation { get; set; } = "/";

    public ValueTask<QueryResult> ExecuteAsync(QuerySpec spec, StageRecorder timings, CancellationToken ct = default)
    {
        if (!_initialized) throw new InvalidOperationException("InitializeAsync must run first.");

        var sql = spec.Bind(_tableRef);
        var result = Marshal.AllocHGlobal(DuckDbNative.ResultStructBytes);
        try
        {
            // Everything from here to the closing brace runs synchronously on the UI
            // thread. There is no await, because there is nothing to await — which is
            // precisely why the browser cannot paint until it finishes.
            var start = Stopwatch.GetTimestamp();
            var rc = DuckDbNative.Query(_con, sql, result);
            var queryMs = Stopwatch.GetElapsedTime(start).TotalMilliseconds;

            if (rc != DuckDbNative.Success)
            {
                var err = Marshal.PtrToStringUTF8(DuckDbNative.ResultError(result)) ?? "unknown error";
                throw new InvalidOperationException($"DuckDB: {err}");
            }

            timings.Record(Stage.QueryExecute, queryMs, "no serialization — results are already in this heap");

            // No boundary to cross: the bytes never leave the module.
            timings.Record(Stage.ResultTransfer, 0, "zero — single linear memory, nothing to copy");

            var decodeStart = Stopwatch.GetTimestamp();
            var qr = ReadResult(result, spec.RowLimit);
            timings.Record(Stage.Decode, Stopwatch.GetElapsedTime(decodeStart).TotalMilliseconds,
                           $"{qr.RowCount:N0} rows read directly from DuckDB vectors");

            return ValueTask.FromResult(qr);
        }
        finally
        {
            DuckDbNative.DestroyResult(result);
            Marshal.FreeHGlobal(result);
        }
    }

    private void Exec(string sql)
    {
        var r = Marshal.AllocHGlobal(DuckDbNative.ResultStructBytes);
        try { DuckDbNative.Query(_con, sql, r); DuckDbNative.DestroyResult(r); }
        finally { Marshal.FreeHGlobal(r); }
    }

    /// <summary>Walk the chunks, reading each vector as a span over DuckDB's own memory.</summary>
    private QueryResult ReadResult(IntPtr result, int rowLimit)
    {
        var colCount = (int)DuckDbNative.ColumnCount(result);
        if (colCount == 0) return QueryResult.Empty;

        var names = new string[colCount];
        var types = new DuckDbType[colCount];
        for (var c = 0; c < colCount; c++)
        {
            names[c] = Marshal.PtrToStringUTF8(DuckDbNative.ColumnName(result, (ulong)c)) ?? $"col{c}";
            types[c] = (DuckDbType)DuckDbNative.ColumnType(result, (ulong)c);
        }

        var builders = new List<object>[colCount];
        for (var c = 0; c < colCount; c++) builders[c] = new List<object>();

        var rows = 0;
        while (rows < rowLimit)
        {
            var chunk = DuckDbNative.FetchChunk(result);
            if (chunk == IntPtr.Zero) break;
            try
            {
                var n = (int)DuckDbNative.DataChunkGetSize(chunk);
                if (n == 0) break;

                for (var c = 0; c < colCount; c++)
                {
                    var vec = DuckDbNative.DataChunkGetVector(chunk, (ulong)c);
                    var data = DuckDbNative.VectorGetData(vec);
                    var validity = DuckDbNative.VectorGetValidity(vec);
                    ReadVector(builders[c], types[c], data, validity, n);
                }
                rows += n;
            }
            finally
            {
                var ch = chunk;
                DuckDbNative.DestroyDataChunk(ref ch);
            }
        }

        var columns = new List<ResultColumn>(colCount);
        for (var c = 0; c < colCount; c++)
            columns.Add(Materialize(names[c], types[c], builders[c]));

        return new QueryResult
        {
            Columns = columns,
            RowCount = rows,
            TransferredBytes = 0,
            EngineName = Name,
        };
    }

    private static unsafe void ReadVector(List<object> into, DuckDbType type, IntPtr data, IntPtr validity, int n)
    {
        var valid = (ulong*)validity;
        bool IsValid(int i) => valid == null || (valid[i >> 6] & (1UL << (i & 63))) != 0;

        switch (type)
        {
            case DuckDbType.Boolean:
                { var p = (byte*)data; for (var i = 0; i < n; i++) into.Add(IsValid(i) ? p[i] != 0 : (object?)null!); break; }
            case DuckDbType.TinyInt:
                { var p = (sbyte*)data; for (var i = 0; i < n; i++) into.Add(IsValid(i) ? (long)p[i] : (object?)null!); break; }
            case DuckDbType.SmallInt:
                { var p = (short*)data; for (var i = 0; i < n; i++) into.Add(IsValid(i) ? (long)p[i] : (object?)null!); break; }
            case DuckDbType.Integer:
                { var p = (int*)data; for (var i = 0; i < n; i++) into.Add(IsValid(i) ? (long)p[i] : (object?)null!); break; }
            case DuckDbType.BigInt:
            case DuckDbType.HugeInt:
                { var p = (long*)data; for (var i = 0; i < n; i++) into.Add(IsValid(i) ? p[i] : (object?)null!); break; }
            case DuckDbType.UInteger:
                { var p = (uint*)data; for (var i = 0; i < n; i++) into.Add(IsValid(i) ? (long)p[i] : (object?)null!); break; }
            case DuckDbType.UBigInt:
                { var p = (ulong*)data; for (var i = 0; i < n; i++) into.Add(IsValid(i) ? (long)p[i] : (object?)null!); break; }
            case DuckDbType.Float:
                { var p = (float*)data; for (var i = 0; i < n; i++) into.Add(IsValid(i) ? (double)p[i] : (object?)null!); break; }
            case DuckDbType.Double:
            case DuckDbType.Decimal:
                { var p = (double*)data; for (var i = 0; i < n; i++) into.Add(IsValid(i) ? p[i] : (object?)null!); break; }
            case DuckDbType.Date:
                { var p = (int*)data; for (var i = 0; i < n; i++) into.Add(IsValid(i) ? (long)p[i] + 719162 : (object?)null!); break; }
            case DuckDbType.Timestamp:
                { var p = (long*)data; for (var i = 0; i < n; i++) into.Add(IsValid(i) ? p[i] / 1000 : (object?)null!); break; }
            default:
                {
                    // Varchar: duckdb_string_t is inlined up to 12 bytes, else a pointer.
                    var p = (byte*)data;
                    for (var i = 0; i < n; i++)
                    {
                        if (!IsValid(i)) { into.Add(null!); continue; }
                        var rec = p + i * 16;
                        var len = *(uint*)rec;
                        into.Add(len <= DuckDbStringT.InlineLimit
                            ? Marshal.PtrToStringUTF8((IntPtr)(rec + 4), (int)len)
                            : Marshal.PtrToStringUTF8(*(IntPtr*)(rec + 8), (int)len));
                    }
                    break;
                }
        }
    }

    private static ResultColumn Materialize(string name, DuckDbType type, List<object> values)
    {
        var n = values.Count;
        var nulls = new ulong[(n + 63) / 64];
        var hasNulls = false;
        for (var i = 0; i < n; i++)
        {
            if (values[i] is null) hasNulls = true;
            else nulls[i >> 6] |= 1UL << (i & 63);
        }

        ColumnType ct;
        Array store;

        if (type is DuckDbType.Boolean)
        {
            ct = ColumnType.Boolean;
            var b = new bool[n];
            for (var i = 0; i < n; i++) b[i] = values[i] is bool v && v;
            store = b;
        }
        else if (type is DuckDbType.Float or DuckDbType.Double or DuckDbType.Decimal)
        {
            ct = ColumnType.Double;
            var d = new double[n];
            for (var i = 0; i < n; i++) d[i] = values[i] is double v ? v : 0;
            store = d;
        }
        else if (type is DuckDbType.TinyInt or DuckDbType.SmallInt or DuckDbType.Integer
                      or DuckDbType.BigInt or DuckDbType.HugeInt or DuckDbType.UInteger
                      or DuckDbType.UBigInt or DuckDbType.Date or DuckDbType.Timestamp)
        {
            // Date and Timestamp share int64 storage; only the display type differs.
            ct = type switch
            {
                DuckDbType.Date => ColumnType.Date,
                DuckDbType.Timestamp => ColumnType.Timestamp,
                _ => ColumnType.Int64,
            };
            var l = new long[n];
            for (var i = 0; i < n; i++) l[i] = values[i] is long v ? v : 0;
            store = l;
        }
        else
        {
            ct = ColumnType.String;
            var s = new string[n];
            for (var i = 0; i < n; i++) s[i] = values[i] as string ?? "";
            store = s;
        }

        return new ResultColumn
        {
            Name = name, Type = ct, Length = n, Values = store,
            Nulls = hasNulls ? nulls : null,
        };
    }

    public ValueTask DisposeAsync()
    {
        if (_con != IntPtr.Zero) DuckDbNative.Disconnect(ref _con);
        if (_db != IntPtr.Zero) DuckDbNative.Close(ref _db);
        return ValueTask.CompletedTask;
    }
}
