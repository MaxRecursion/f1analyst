namespace Demo.Shared;

/// <summary>
/// The single abstraction all three arms implement. Application code — the grid, the
/// chart, the assessment page — depends only on this and never learns which topology
/// is underneath. That is the architectural claim the demo is making: the engine is a
/// swappable implementation detail, not something the app is coupled to.
/// </summary>
public interface IQueryEngine : IAsyncDisposable
{
    /// <summary>Short name shown in the UI, e.g. "Arm A — duckdb-wasm in Web Worker".</summary>
    string Name { get; }

    /// <summary>One line describing where the engine runs. Displayed under the results.</summary>
    string Topology { get; }

    /// <summary>
    /// Whether an in-flight query can actually be abandoned. False for any arm that
    /// executes synchronously on the UI thread — there is no thread left to cancel from.
    /// </summary>
    bool SupportsCancellation { get; }

    /// <summary>
    /// Whether queries execute off the UI thread. When false, the browser cannot paint
    /// for the duration of a query, regardless of how fast the query itself is.
    /// </summary>
    bool RunsOffUiThread { get; }

    /// <summary>Bring the engine up. Recorded as <see cref="Stage.EngineInit"/>.</summary>
    ValueTask InitializeAsync(StageRecorder timings, IProgress<string>? progress = null, CancellationToken ct = default);

    /// <summary>Make <paramref name="datasetUrl"/> queryable. Recorded as <see cref="Stage.DataAttach"/>.</summary>
    ValueTask AttachDatasetAsync(string datasetUrl, StageRecorder timings, CancellationToken ct = default);

    /// <summary>
    /// Execute and return columnar results. Implementations record
    /// <see cref="Stage.QueryExecute"/>, <see cref="Stage.ResultTransfer"/> and
    /// <see cref="Stage.Decode"/> separately — attributing time to the right stage is
    /// the entire point of the comparison, so a single total is not acceptable.
    /// </summary>
    ValueTask<QueryResult> ExecuteAsync(QuerySpec spec, StageRecorder timings, CancellationToken ct = default);
}

/// <summary>What to run. Deliberately a spec rather than raw SQL so every arm is given
/// identical work and no arm can be accidentally advantaged by a different query.</summary>
/// <param name="Id">Stable identifier, used to look up the SQL and to label results.</param>
/// <param name="Title">Human-readable name for the UI.</param>
/// <param name="Sql">The SQL to execute. Identical across arms.</param>
/// <param name="Description">What this query represents in reporting terms.</param>
/// <param name="RowLimit">Guard against a query that would return an unrenderable result.</param>
public sealed record QuerySpec(
    string Id,
    string Title,
    string Sql,
    string Description,
    int RowLimit = 100_000);
