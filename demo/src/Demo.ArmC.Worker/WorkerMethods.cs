using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Text.Json;

namespace Demo.ArmC.Worker;

/// <summary>
/// The query engine, running inside a .NET Web Worker.
/// </summary>
/// <remarks>
/// This is Arm B's engine — DuckDB statically linked, called by P/Invoke, results read
/// straight out of its vectors with no serialization — relocated off the UI thread.
/// The main app reaches it through <c>WebWorkerClient.InvokeAsync</c>, so the boundary
/// is C#-to-C# with a CancellationToken and no JavaScript in the application code.
/// <para>
/// One cost is genuinely new and is measured rather than hidden: results must be
/// serialized to cross the worker boundary, because the worker's .NET instance has its
/// own heap. Zero-copy holds inside the worker; it does not survive the hop to the
/// main thread.
/// </para>
/// </remarks>
[SupportedOSPlatform("browser")]
public static partial class WorkerMethods
{
    private static IntPtr _db, _con;
    private static bool _ready;

    /// <summary>Open DuckDB inside the worker. Returns a JSON status string.</summary>
    [JSExport]
    public static string Initialize()
    {
        if (_ready) return Json(new { ok = true, version = DuckDbNative.Version(), reused = true });

        var sw = Stopwatch.GetTimestamp();
        if (DuckDbNative.Open(null, out _db) != DuckDbNative.Success)
            return Json(new { ok = false, error = "duckdb_open failed" });
        if (DuckDbNative.Connect(_db, out _con) != DuckDbNative.Success)
            return Json(new { ok = false, error = "duckdb_connect failed" });

        Exec("SET memory_limit='1500MB'");
        Exec("SET preserve_insertion_order=false");
        Exec("SET default_null_order='NULLS LAST'");
        _ready = true;

        return Json(new
        {
            ok = true,
            version = DuckDbNative.Version(),
            initMs = Stopwatch.GetElapsedTime(sw).TotalMilliseconds,
        });
    }

    /// <summary>
    /// Register the dataset. The bytes are written into the worker's own Emscripten FS
    /// by JS before this is called, so DuckDB's synchronous file API can reach them —
    /// legitimately, because inside a worker synchronous I/O is not a UI hazard.
    /// </summary>
    [JSExport]
    public static async Task<string> Attach(string url, string path)
    {
        var sw = Stopwatch.GetTimestamp();
        // Fetch and write happen INSIDE the worker, so the 43 MB never touches the
        // main thread's heap and the blocking write cannot stall the UI.
        await JSHost.ImportAsync("armcFs", "/armc-worker-fs.js");
        var bytes = await FetchIntoFs(url, path);
        var probe = QueryScalar($"SELECT COUNT(*) FROM read_parquet('{path}')");
        return Json(new { ok = probe is not null, rows = probe, bytes,
                          attachMs = Stopwatch.GetElapsedTime(sw).TotalMilliseconds });
    }

    [JSImport("fetchIntoFs", "armcFs")]
    private static partial Task<int> FetchIntoFs(string url, string path);

    /// <summary>
    /// Execute and return results as JSON.
    /// </summary>
    /// <remarks>
    /// JSON is what the worker boundary supports today, and its cost is exactly what
    /// this arm exists to measure. The alternative — shipping Arrow IPC bytes across —
    /// would be faster and is the obvious next optimisation, but measuring the
    /// straightforward implementation first is the honest baseline.
    /// </remarks>
    [JSExport]
    public static string Execute(string sql, int rowLimit)
    {
        if (!_ready) return Json(new { ok = false, error = "not initialized" });

        var result = Marshal.AllocHGlobal(DuckDbNative.ResultStructBytes);
        try
        {
            var qsw = Stopwatch.GetTimestamp();
            var rc = DuckDbNative.Query(_con, sql, result);
            var queryMs = Stopwatch.GetElapsedTime(qsw).TotalMilliseconds;

            if (rc != DuckDbNative.Success)
            {
                var err = Marshal.PtrToStringUTF8(DuckDbNative.ResultError(result)) ?? "unknown";
                return Json(new { ok = false, error = err });
            }

            var rsw = Stopwatch.GetTimestamp();
            var payload = ReadAsColumns(result, rowLimit);
            var readMs = Stopwatch.GetElapsedTime(rsw).TotalMilliseconds;

            var ssw = Stopwatch.GetTimestamp();
            var json = Json(new
            {
                ok = true,
                queryMs,
                readMs,
                rows = payload.Rows,
                columns = payload.Columns,
            });
            // Serialization time is reported inside the payload it describes, so it is
            // visible in the timings rather than folded into transport.
            return json.Replace("\"ok\":true", $"\"ok\":true,\"serializeMs\":{Stopwatch.GetElapsedTime(ssw).TotalMilliseconds:F2}");
        }
        finally
        {
            DuckDbNative.DestroyResult(result);
            Marshal.FreeHGlobal(result);
        }
    }

    private sealed record Payload(int Rows, List<ColumnDto> Columns);

    public sealed record ColumnDto(string Name, string Type, List<string?> Values);

    private static Payload ReadAsColumns(IntPtr result, int rowLimit)
    {
        var colCount = (int)DuckDbNative.ColumnCount(result);
        if (colCount == 0) return new Payload(0, []);

        var names = new string[colCount];
        var types = new DuckDbType[colCount];
        var cols = new List<string?>[colCount];
        for (var c = 0; c < colCount; c++)
        {
            names[c] = Marshal.PtrToStringUTF8(DuckDbNative.ColumnName(result, (ulong)c)) ?? $"col{c}";
            types[c] = (DuckDbType)DuckDbNative.ColumnType(result, (ulong)c);
            cols[c] = [];
        }

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
                    Read(cols[c], types[c], DuckDbNative.VectorGetData(vec), DuckDbNative.VectorGetValidity(vec), n);
                }
                rows += n;
            }
            finally { var ch = chunk; DuckDbNative.DestroyDataChunk(ref ch); }
        }

        var dto = new List<ColumnDto>(colCount);
        for (var c = 0; c < colCount; c++) dto.Add(new ColumnDto(names[c], types[c].ToString(), cols[c]));
        return new Payload(rows, dto);
    }

    private static unsafe void Read(List<string?> into, DuckDbType type, IntPtr data, IntPtr validity, int n)
    {
        var valid = (ulong*)validity;
        bool Ok(int i) => valid == null || (valid[i >> 6] & (1UL << (i & 63))) != 0;

        switch (type)
        {
            case DuckDbType.Boolean:
                { var p = (byte*)data; for (var i = 0; i < n; i++) into.Add(Ok(i) ? (p[i] != 0 ? "1" : "0") : null); break; }
            case DuckDbType.Integer:
                { var p = (int*)data; for (var i = 0; i < n; i++) into.Add(Ok(i) ? p[i].ToString() : null); break; }
            case DuckDbType.BigInt:
                { var p = (long*)data; for (var i = 0; i < n; i++) into.Add(Ok(i) ? p[i].ToString() : null); break; }
            case DuckDbType.SmallInt:
                { var p = (short*)data; for (var i = 0; i < n; i++) into.Add(Ok(i) ? p[i].ToString() : null); break; }
            case DuckDbType.TinyInt:
                { var p = (sbyte*)data; for (var i = 0; i < n; i++) into.Add(Ok(i) ? p[i].ToString() : null); break; }
            case DuckDbType.Double or DuckDbType.Decimal:
                { var p = (double*)data; for (var i = 0; i < n; i++) into.Add(Ok(i) ? p[i].ToString("R") : null); break; }
            case DuckDbType.Float:
                { var p = (float*)data; for (var i = 0; i < n; i++) into.Add(Ok(i) ? p[i].ToString("R") : null); break; }
            case DuckDbType.Date:
                { var p = (int*)data; for (var i = 0; i < n; i++) into.Add(Ok(i) ? DateOnly.FromDayNumber(p[i] + 719162).ToString("yyyy-MM-dd") : null); break; }
            case DuckDbType.Timestamp:
                { var p = (long*)data; for (var i = 0; i < n; i++) into.Add(Ok(i) ? DateTimeOffset.FromUnixTimeMilliseconds(p[i] / 1000).UtcDateTime.ToString("yyyy-MM-dd HH:mm") : null); break; }
            default:
                {
                    var p = (byte*)data;
                    for (var i = 0; i < n; i++)
                    {
                        if (!Ok(i)) { into.Add(null); continue; }
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

    private static long? QueryScalar(string sql)
    {
        var r = Marshal.AllocHGlobal(DuckDbNative.ResultStructBytes);
        try
        {
            if (DuckDbNative.Query(_con, sql, r) != DuckDbNative.Success) return null;
            var chunk = DuckDbNative.FetchChunk(r);
            if (chunk == IntPtr.Zero) return null;
            try
            {
                unsafe
                {
                    var vec = DuckDbNative.DataChunkGetVector(chunk, 0);
                    return *(long*)DuckDbNative.VectorGetData(vec);
                }
            }
            finally { var ch = chunk; DuckDbNative.DestroyDataChunk(ref ch); }
        }
        finally { DuckDbNative.DestroyResult(r); Marshal.FreeHGlobal(r); }
    }

    private static void Exec(string sql)
    {
        var r = Marshal.AllocHGlobal(DuckDbNative.ResultStructBytes);
        try { DuckDbNative.Query(_con, sql, r); DuckDbNative.DestroyResult(r); }
        finally { Marshal.FreeHGlobal(r); }
    }

    private static string Json(object o) => JsonSerializer.Serialize(o);
}
