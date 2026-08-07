using Apache.Arrow;
using Apache.Arrow.Ipc;
using Apache.Arrow.Types;

namespace Demo.Shared;

/// <summary>
/// Turns an Arrow IPC stream into <see cref="QueryResult"/>.
/// </summary>
/// <remarks>
/// Shared by Arm A and Arm C, which both receive Arrow bytes. Arm B decodes nothing —
/// it reads DuckDB's vectors directly out of the same linear memory — and the absence
/// of this stage in its timings is a real, honest advantage worth showing.
/// <para>
/// Values are copied once into flat typed arrays rather than kept as Arrow arrays.
/// Arrow's own arrays are chunked per record batch, and a grid that has to resolve
/// (batch, offset) per cell pays that on every scroll frame.
/// </para>
/// </remarks>
public static class ArrowDecoder
{
    public static async ValueTask<QueryResult> ToQueryResultAsync(
        ArrowStreamReader reader, long transferredBytes, string? engineName, CancellationToken ct = default)
    {
        var batches = new List<RecordBatch>();
        try
        {
            while (await reader.ReadNextRecordBatchAsync(ct).ConfigureAwait(false) is { } batch)
                batches.Add(batch);

            if (batches.Count == 0)
                return QueryResult.Empty;

            var schema = batches[0].Schema;
            var totalRows = batches.Sum(b => b.Length);
            var columns = new List<ResultColumn>(schema.FieldsList.Count);

            for (var f = 0; f < schema.FieldsList.Count; f++)
            {
                var field = schema.FieldsList[f];
                columns.Add(BuildColumn(field.Name, field.DataType, batches, f, totalRows));
            }

            return new QueryResult
            {
                Columns = columns,
                RowCount = totalRows,
                TransferredBytes = transferredBytes,
                EngineName = engineName,
            };
        }
        finally
        {
            foreach (var b in batches) b.Dispose();
        }
    }

    private static ResultColumn BuildColumn(
        string name, IArrowType type, List<RecordBatch> batches, int fieldIndex, int totalRows)
    {
        // Decimal is carried as scaled int64. DuckDB emits Decimal128, but our demo
        // schema is DECIMAL(19,4) — comfortably inside int64 — and halving the width
        // keeps the wasm heap cost down.
        switch (type.TypeId)
        {
            case ArrowTypeId.Int32:
                return Fill<int>(name, ColumnType.Int32, batches, fieldIndex, totalRows,
                    (arr, dst, at) => CopyInt32((Int32Array)arr, dst, at));

            case ArrowTypeId.Int64:
                return Fill<long>(name, ColumnType.Int64, batches, fieldIndex, totalRows,
                    (arr, dst, at) => CopyInt64((Int64Array)arr, dst, at));

            case ArrowTypeId.Double:
            case ArrowTypeId.Float:
                return Fill<double>(name, ColumnType.Double, batches, fieldIndex, totalRows,
                    (arr, dst, at) => CopyDouble(arr, dst, at));

            case ArrowTypeId.Decimal128:
            {
                var scale = ((Decimal128Type)type).Scale;
                var col = Fill<long>(name, ColumnType.Decimal, batches, fieldIndex, totalRows,
                    (arr, dst, at) => CopyDecimal((Decimal128Array)arr, dst, at, scale));
                return new ResultColumn
                {
                    Name = col.Name, Type = ColumnType.Decimal, Length = col.Length,
                    Values = col.Values, Nulls = col.Nulls, Scale = scale,
                };
            }

            case ArrowTypeId.Boolean:
                return Fill<bool>(name, ColumnType.Boolean, batches, fieldIndex, totalRows,
                    (arr, dst, at) => CopyBool((BooleanArray)arr, dst, at));

            case ArrowTypeId.Date32:
            case ArrowTypeId.Date64:
                return Fill<long>(name, ColumnType.Date, batches, fieldIndex, totalRows,
                    (arr, dst, at) => CopyDate(arr, dst, at));

            case ArrowTypeId.Timestamp:
                return Fill<long>(name, ColumnType.Timestamp, batches, fieldIndex, totalRows,
                    (arr, dst, at) => CopyTimestamp((TimestampArray)arr, dst, at));

            default:
                // Strings and anything unmapped render as text. Formatting at decode
                // time rather than per paint keeps the grid's scroll path allocation-free.
                return Fill<string>(name, ColumnType.String, batches, fieldIndex, totalRows,
                    (arr, dst, at) => CopyString(arr, (string[])dst, at));
        }
    }

    private static ResultColumn Fill<T>(
        string name, ColumnType type, List<RecordBatch> batches, int fieldIndex, int totalRows,
        Action<IArrowArray, System.Array, int> copy)
    {
        var values = new T[totalRows];
        var nulls = new ulong[(totalRows + 63) / 64];
        var hasNulls = false;
        var at = 0;

        foreach (var batch in batches)
        {
            var arr = batch.Column(fieldIndex);
            copy(arr, values, at);

            if (arr.NullCount > 0)
            {
                hasNulls = true;
                for (var i = 0; i < arr.Length; i++)
                    if (arr.IsValid(i))
                        nulls[(at + i) >> 6] |= 1UL << ((at + i) & 63);
            }
            else
            {
                for (var i = 0; i < arr.Length; i++)
                    nulls[(at + i) >> 6] |= 1UL << ((at + i) & 63);
            }
            at += arr.Length;
        }

        return new ResultColumn
        {
            Name = name,
            Type = type,
            Length = totalRows,
            Values = values,
            Nulls = hasNulls ? nulls : null,
        };
    }

    private static void CopyInt32(Int32Array a, System.Array dst, int at)
    { var d = (int[])dst; for (var i = 0; i < a.Length; i++) d[at + i] = a.GetValue(i) ?? 0; }

    private static void CopyInt64(Int64Array a, System.Array dst, int at)
    { var d = (long[])dst; for (var i = 0; i < a.Length; i++) d[at + i] = a.GetValue(i) ?? 0; }

    private static void CopyDouble(IArrowArray a, System.Array dst, int at)
    {
        var d = (double[])dst;
        switch (a)
        {
            case DoubleArray x: for (var i = 0; i < x.Length; i++) d[at + i] = x.GetValue(i) ?? 0; break;
            case FloatArray x: for (var i = 0; i < x.Length; i++) d[at + i] = x.GetValue(i) ?? 0; break;
        }
    }

    private static void CopyDecimal(Decimal128Array a, System.Array dst, int at, int scale)
    {
        var d = (long[])dst;
        var factor = (decimal)Math.Pow(10, scale);
        for (var i = 0; i < a.Length; i++)
            d[at + i] = a.GetValue(i) is { } v ? (long)(v * factor) : 0;
    }

    private static void CopyBool(BooleanArray a, System.Array dst, int at)
    { var d = (bool[])dst; for (var i = 0; i < a.Length; i++) d[at + i] = a.GetValue(i) ?? false; }

    private static void CopyDate(IArrowArray a, System.Array dst, int at)
    {
        var d = (long[])dst;
        switch (a)
        {
            case Date32Array x:
                for (var i = 0; i < x.Length; i++) d[at + i] = x.GetDateOnly(i)?.DayNumber ?? 0;
                break;
            case Date64Array x:
                for (var i = 0; i < x.Length; i++) d[at + i] = x.GetDateOnly(i)?.DayNumber ?? 0;
                break;
        }
    }

    private static void CopyTimestamp(TimestampArray a, System.Array dst, int at)
    { var d = (long[])dst; for (var i = 0; i < a.Length; i++) d[at + i] = a.GetTimestamp(i)?.ToUnixTimeMilliseconds() ?? 0; }

    private static void CopyString(IArrowArray a, string[] dst, int at)
    {
        switch (a)
        {
            case StringArray x:
                for (var i = 0; i < x.Length; i++) dst[at + i] = x.GetString(i);
                break;
            default:
                for (var i = 0; i < a.Length; i++) dst[at + i] = "";
                break;
        }
    }
}
