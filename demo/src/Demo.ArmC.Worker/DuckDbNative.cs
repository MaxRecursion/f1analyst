using System.Runtime.InteropServices;

namespace Demo.ArmC.Worker;

/// <summary>
/// P/Invoke bindings to the DuckDB C API, statically linked into the .NET WebAssembly
/// runtime.
/// </summary>
/// <remarks>
/// Two things about this are easy to get wrong and cost hours:
/// <list type="number">
/// <item>The library name must match the <c>.a</c> filename — <c>libduckdb_static</c>,
/// not <c>duckdb</c>. The SDK derives the pinvoke-table module name from the file, and a
/// mismatch produces a table with zero entries, an archive that links "successfully",
/// and a binary with none of DuckDB in it.</item>
/// <item>All 15 archives must be referenced. Referencing only <c>libduckdb_static.a</c>
/// leaves undefined symbols in <c>utf8proc</c> and <c>yyjson</c>.</item>
/// </list>
/// </remarks>
public static partial class DuckDbNative
{
    private const string Lib = "libduckdb_static";

    // duckdb_state: 0 = DuckDBSuccess, 1 = DuckDBError
    public const int Success = 0;

    [LibraryImport(Lib, EntryPoint = "duckdb_library_version")]
    public static partial IntPtr LibraryVersion();

    [LibraryImport(Lib, EntryPoint = "duckdb_open", StringMarshalling = StringMarshalling.Utf8)]
    public static partial int Open(string? path, out IntPtr database);

    [LibraryImport(Lib, EntryPoint = "duckdb_close")]
    public static partial void Close(ref IntPtr database);

    [LibraryImport(Lib, EntryPoint = "duckdb_connect")]
    public static partial int Connect(IntPtr database, out IntPtr connection);

    [LibraryImport(Lib, EntryPoint = "duckdb_disconnect")]
    public static partial void Disconnect(ref IntPtr connection);

    [LibraryImport(Lib, EntryPoint = "duckdb_query", StringMarshalling = StringMarshalling.Utf8)]
    public static partial int Query(IntPtr connection, string sql, IntPtr outResult);

    [LibraryImport(Lib, EntryPoint = "duckdb_destroy_result")]
    public static partial void DestroyResult(IntPtr result);

    [LibraryImport(Lib, EntryPoint = "duckdb_result_error")]
    public static partial IntPtr ResultError(IntPtr result);

    [LibraryImport(Lib, EntryPoint = "duckdb_column_count")]
    public static partial ulong ColumnCount(IntPtr result);

    [LibraryImport(Lib, EntryPoint = "duckdb_column_name")]
    public static partial IntPtr ColumnName(IntPtr result, ulong col);

    [LibraryImport(Lib, EntryPoint = "duckdb_column_type")]
    public static partial int ColumnType(IntPtr result, ulong col);

    // ---- chunk API: the reason in-process could be fast ----
    // Vectors hand back raw pointers into the SAME linear memory .NET occupies, so
    // reading them is a span over existing bytes with no copy and no decode step.

    [LibraryImport(Lib, EntryPoint = "duckdb_fetch_chunk")]
    public static partial IntPtr FetchChunk(IntPtr result);

    [LibraryImport(Lib, EntryPoint = "duckdb_destroy_data_chunk")]
    public static partial void DestroyDataChunk(ref IntPtr chunk);

    [LibraryImport(Lib, EntryPoint = "duckdb_data_chunk_get_size")]
    public static partial ulong DataChunkGetSize(IntPtr chunk);

    [LibraryImport(Lib, EntryPoint = "duckdb_data_chunk_get_vector")]
    public static partial IntPtr DataChunkGetVector(IntPtr chunk, ulong colIdx);

    [LibraryImport(Lib, EntryPoint = "duckdb_vector_get_data")]
    public static partial IntPtr VectorGetData(IntPtr vector);

    [LibraryImport(Lib, EntryPoint = "duckdb_vector_get_validity")]
    public static partial IntPtr VectorGetValidity(IntPtr vector);

    [LibraryImport(Lib, EntryPoint = "duckdb_interrupt")]
    public static partial void Interrupt(IntPtr connection);

    public static string Version() => Marshal.PtrToStringUTF8(LibraryVersion()) ?? "unknown";

    /// <summary>duckdb_result is a struct passed by pointer; over-allocate rather than
    /// mirror a layout that has changed across versions.</summary>
    public const int ResultStructBytes = 256;
}

/// <summary>Subset of duckdb_type we map. Values are from duckdb.h and are stable.</summary>
public enum DuckDbType
{
    Invalid = 0, Boolean = 1, TinyInt = 2, SmallInt = 3, Integer = 4, BigInt = 5,
    UTinyInt = 6, USmallInt = 7, UInteger = 8, UBigInt = 9,
    Float = 10, Double = 11, Timestamp = 12, Date = 13, Time = 14,
    Interval = 15, HugeInt = 16, Varchar = 17, Blob = 18, Decimal = 19,
}

/// <summary>
/// duckdb_string_t — inlined up to 12 bytes, otherwise a pointer. Reading it requires
/// knowing this layout because the chunk API hands back raw memory.
/// </summary>
[StructLayout(LayoutKind.Explicit, Size = 16)]
public struct DuckDbStringT
{
    [FieldOffset(0)] internal uint Length;
    [FieldOffset(4)] internal unsafe fixed byte Inlined[12];
    [FieldOffset(8)] internal IntPtr Ptr;

    public const int InlineLimit = 12;
}
