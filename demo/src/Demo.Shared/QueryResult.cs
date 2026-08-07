namespace Demo.Shared;

/// <summary>
/// A columnar result set.
/// </summary>
/// <remarks>
/// Columnar rather than <c>List&lt;Dictionary&lt;string, object&gt;&gt;</c> on purpose: a
/// 1M-row row-oriented result would allocate tens of millions of boxed objects and
/// exhaust the wasm heap long before it rendered. Columns keep values in typed arrays
/// the grid can slice without copying.
/// </remarks>
public sealed class QueryResult
{
    public required IReadOnlyList<ResultColumn> Columns { get; init; }
    public required int RowCount { get; init; }

    /// <summary>Bytes that crossed the boundary. Zero for an arm with no boundary.</summary>
    public long TransferredBytes { get; init; }

    /// <summary>Which arm produced this, for the results table.</summary>
    public string? EngineName { get; init; }

    public ResultColumn this[string name]
        => Columns.FirstOrDefault(c => string.Equals(c.Name, name, StringComparison.OrdinalIgnoreCase))
           ?? throw new KeyNotFoundException($"No column '{name}'. Available: {string.Join(", ", Columns.Select(c => c.Name))}");

    public bool TryGetColumn(string name, out ResultColumn column)
    {
        column = Columns.FirstOrDefault(c => string.Equals(c.Name, name, StringComparison.OrdinalIgnoreCase))!;
        return column is not null;
    }

    public static QueryResult Empty { get; } = new() { Columns = [], RowCount = 0 };
}

public enum ColumnType { Int32, Int64, Double, Decimal, Boolean, String, Date, Timestamp }

/// <summary>
/// One column. Values live in a single typed array; <see cref="Nulls"/> is a separate
/// bitmap so the common all-non-null case costs nothing per row.
/// </summary>
public sealed class ResultColumn
{
    public required string Name { get; init; }
    public required ColumnType Type { get; init; }
    public required int Length { get; init; }

    /// <summary>Backing storage — one of long[], double[], bool[], string[] or int[].</summary>
    public required Array Values { get; init; }

    /// <summary>Null bitmap, one bit per row. Null when the column has no nulls.</summary>
    public ulong[]? Nulls { get; init; }

    /// <summary>Decimal scale for <see cref="ColumnType.Decimal"/>: stored as scaled int64.</summary>
    public int Scale { get; init; }

    public bool IsNull(int row)
        => Nulls is not null && (Nulls[row >> 6] & (1UL << (row & 63))) == 0;

    /// <summary>Zero-copy view for numeric columns — the grid slices this per viewport.</summary>
    public ReadOnlySpan<long> AsInt64 => Type is ColumnType.Int64 or ColumnType.Decimal or ColumnType.Date or ColumnType.Timestamp
        ? (long[])Values
        : throw new InvalidOperationException($"Column '{Name}' is {Type}, not an int64-backed type.");

    public ReadOnlySpan<double> AsDouble => Type is ColumnType.Double
        ? (double[])Values
        : throw new InvalidOperationException($"Column '{Name}' is {Type}, not Double.");

    /// <summary>Formatted for display. The grid only ever calls this for visible rows.</summary>
    public string Format(int row)
    {
        if (IsNull(row)) return "";
        return Type switch
        {
            ColumnType.Int32 => ((int[])Values)[row].ToString("N0"),
            ColumnType.Int64 => ((long[])Values)[row].ToString("N0"),
            ColumnType.Double => ((double[])Values)[row].ToString("N2"),
            ColumnType.Decimal => (((long[])Values)[row] / Math.Pow(10, Scale)).ToString("N2"),
            ColumnType.Boolean => ((bool[])Values)[row] ? "yes" : "no",
            ColumnType.String => ((string[])Values)[row] ?? "",
            ColumnType.Date => DateOnly.FromDayNumber((int)((long[])Values)[row]).ToString("yyyy-MM-dd"),
            ColumnType.Timestamp => DateTimeOffset.FromUnixTimeMilliseconds(((long[])Values)[row]).UtcDateTime.ToString("yyyy-MM-dd HH:mm"),
            _ => "",
        };
    }

    /// <summary>Numeric projection for charting. Non-numeric columns throw rather than guess.</summary>
    public double ToDouble(int row) => Type switch
    {
        ColumnType.Int32 => ((int[])Values)[row],
        ColumnType.Int64 => ((long[])Values)[row],
        ColumnType.Double => ((double[])Values)[row],
        ColumnType.Decimal => ((long[])Values)[row] / Math.Pow(10, Scale),
        ColumnType.Boolean => ((bool[])Values)[row] ? 1 : 0,
        _ => throw new InvalidOperationException($"Column '{Name}' ({Type}) is not chartable."),
    };
}
