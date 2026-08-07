namespace Demo.Shared;

/// <summary>
/// The fixed query set. Every arm runs exactly these, so differences in the results
/// table are attributable to topology and nothing else.
/// </summary>
/// <remarks>
/// <c>{{TABLE}}</c> is substituted by each engine with however it addresses the dataset
/// (an OPFS path, a registered buffer name, an ATTACHed table). That substitution is
/// the only per-arm difference permitted.
/// </remarks>
public static class DemoQueries
{
    public const string TablePlaceholder = "{{TABLE}}";

    /// <summary>Small aggregate. Establishes the floor — what a cheap query costs in each arm.</summary>
    public static readonly QuerySpec Summary = new(
        Id: "summary",
        Title: "1 · Portfolio summary",
        Description: "Aggregate 1M rows into 8 categories. The cheapest realistic report.",
        Sql: $"""
             SELECT txn_type,
                    COUNT(*)                          AS txn_count,
                    SUM(amount_base)                  AS total_amount,
                    AVG(amount_base)                  AS avg_amount,
                    SUM(fee) + SUM(tax)               AS total_charges
             FROM {TablePlaceholder}
             GROUP BY txn_type
             ORDER BY total_amount DESC
             """);

    /// <summary>Time series. This is what the chart widget binds to.</summary>
    public static readonly QuerySpec MonthlyTrend = new(
        Id: "trend",
        Title: "2 · Monthly trend by region",
        Description: "36 months x 4 regions. Drives the chart widget.",
        Sql: $"""
             SELECT month_key,
                    region,
                    SUM(amount_base)                  AS total_amount,
                    COUNT(*)                          AS txn_count
             FROM {TablePlaceholder}
             WHERE status = 'POSTED'
             GROUP BY month_key, region
             ORDER BY month_key, region
             """);

    /// <summary>Grouped, filtered, ranked. The shape most management reports actually take.</summary>
    public static readonly QuerySpec TopCounterparties = new(
        Id: "top",
        Title: "3 · Top counterparties",
        Description: "Group, filter post-aggregation, rank. The most common report shape.",
        Sql: $"""
             SELECT company_key,
                    region,
                    sector,
                    COUNT(*)                                       AS txn_count,
                    SUM(amount_base)                               AS total_amount,
                    SUM(amount_base) FILTER (WHERE is_disputed)    AS disputed_amount,
                    COUNT(*) FILTER (WHERE NOT is_reconciled)      AS unreconciled
             FROM {TablePlaceholder}
             GROUP BY company_key, region, sector
             HAVING SUM(amount_base) > 500000
             ORDER BY total_amount DESC
             LIMIT 500
             """);

    /// <summary>
    /// Large result set. Nothing here is hard for the engine — this measures the
    /// boundary: bytes out of the engine heap, across whatever gap exists, into .NET.
    /// </summary>
    public static readonly QuerySpec DetailRows = new(
        Id: "detail",
        Title: "4 · Detail drill-through (50k rows)",
        Description: "Cheap to compute, expensive to move. Isolates transfer + decode cost.",
        Sql: $"""
             SELECT row_id, company_key, txn_date, txn_type, status, currency, region,
                    amount_base, fee, tax, fx_rate, doc_number, is_reconciled, risk_rating
             FROM {TablePlaceholder}
             WHERE status = 'POSTED'
             ORDER BY amount_base DESC
             LIMIT 50000
             """,
        RowLimit: 50_000);

    /// <summary>
    /// Deliberately expensive — a self-join producing real work.
    /// </summary>
    /// <remarks>
    /// This is the query that decides the demo. While it runs, the heartbeat animation
    /// either keeps moving (engine off the UI thread) or freezes solid (engine on it),
    /// and Cancel either works or does nothing. Total elapsed time is almost the least
    /// interesting thing about it.
    /// </remarks>
    public static readonly QuerySpec HeavyScan = new(
        Id: "heavy",
        Title: "5 · Heavy analytical scan",
        Description: "Expensive on purpose. Watch the heartbeat and try Cancel.",
        Sql: $"""
             WITH monthly AS (
               SELECT company_key, month_key,
                      SUM(amount_base) AS amt,
                      COUNT(*)         AS n
               FROM {TablePlaceholder}
               GROUP BY company_key, month_key
             ),
             ranked AS (
               SELECT month_key, company_key, amt, n,
                      SUM(amt) OVER (PARTITION BY company_key ORDER BY month_key
                                     ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_total,
                      RANK() OVER (PARTITION BY month_key ORDER BY amt DESC)            AS rank_in_month
               FROM monthly
             )
             SELECT month_key,
                    COUNT(*)                                    AS companies,
                    SUM(amt)                                    AS total_amount,
                    MAX(running_total)                          AS peak_running_total,
                    SUM(amt) FILTER (WHERE rank_in_month <= 10) AS top10_amount
             FROM ranked
             GROUP BY month_key
             ORDER BY month_key
             """);

    public static IReadOnlyList<QuerySpec> All { get; } =
        [Summary, MonthlyTrend, TopCounterparties, DetailRows, HeavyScan];

    public static QuerySpec ById(string id)
        => All.FirstOrDefault(q => q.Id == id)
           ?? throw new KeyNotFoundException($"No query '{id}'.");

    /// <summary>Substitute the arm's dataset reference into the SQL.</summary>
    public static string Bind(this QuerySpec spec, string tableReference)
        => spec.Sql.Replace(TablePlaceholder, tableReference);
}
