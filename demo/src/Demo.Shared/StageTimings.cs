namespace Demo.Shared;

/// <summary>
/// The fixed set of stages every arm reports. Keeping this an enum rather than free
/// strings is what makes the three arms comparable — a stage means the same thing in
/// each, or the demo is measuring nothing.
/// </summary>
public enum Stage
{
    /// <summary>Bring the engine up: instantiate wasm, spawn workers, open connections.</summary>
    EngineInit,

    /// <summary>Make the dataset queryable: fetch, place in OPFS, register/attach.</summary>
    DataAttach,

    /// <summary>Engine-side execution only — from SQL submitted to results ready.</summary>
    QueryExecute,

    /// <summary>Move result bytes across whatever boundary the arm has (or none).</summary>
    ResultTransfer,

    /// <summary>Turn transferred bytes into .NET-side columns.</summary>
    Decode,

    /// <summary>Shape decoded columns into what the widgets bind to.</summary>
    Bind,

    /// <summary>Grid reaches first paint.</summary>
    GridPaint,

    /// <summary>Chart reaches first paint.</summary>
    ChartPaint,
}

/// <summary>A single measured stage.</summary>
/// <param name="Stage">Which stage.</param>
/// <param name="Milliseconds">Wall-clock duration.</param>
/// <param name="Detail">Optional context, e.g. bytes moved or rows produced.</param>
public readonly record struct StageTiming(Stage Stage, double Milliseconds, string? Detail = null);

/// <summary>
/// Records stage timings for one run.
/// </summary>
/// <remarks>
/// Deliberately not thread-safe: every arm records from a single logical flow, and
/// adding a lock would make the recorder itself part of what is being measured.
/// </remarks>
public sealed class StageRecorder
{
    private readonly List<StageTiming> _timings = new();
    private readonly long _created = Stopwatch.GetTimestamp();

    public IReadOnlyList<StageTiming> Timings => _timings;

    /// <summary>Total across all recorded stages. Not the same as wall-clock — stages can be skipped.</summary>
    public double TotalMs => _timings.Sum(t => t.Milliseconds);

    /// <summary>Wall-clock since this recorder was created, including any unattributed gaps.</summary>
    public double WallClockMs => Stopwatch.GetElapsedTime(_created).TotalMilliseconds;

    /// <summary>
    /// Longest single span during which the UI thread could not paint, sampled by the
    /// requestAnimationFrame heartbeat. This is the number that separates the arms:
    /// total query time can look similar while responsiveness does not.
    /// </summary>
    public double LongestUiBlockMs { get; set; }

    /// <summary>Frames the heartbeat expected to see minus those it actually saw.</summary>
    public int DroppedFrames { get; set; }

    public void Record(Stage stage, double ms, string? detail = null)
        => _timings.Add(new StageTiming(stage, ms, detail));

    /// <summary>Times <paramref name="work"/> and records it against <paramref name="stage"/>.</summary>
    public async ValueTask<T> MeasureAsync<T>(Stage stage, Func<ValueTask<T>> work, Func<T, string?>? detail = null)
    {
        var start = Stopwatch.GetTimestamp();
        var result = await work().ConfigureAwait(false);
        Record(stage, Stopwatch.GetElapsedTime(start).TotalMilliseconds, detail?.Invoke(result));
        return result;
    }

    /// <summary>Times <paramref name="work"/> and records it against <paramref name="stage"/>.</summary>
    public async ValueTask MeasureAsync(Stage stage, Func<ValueTask> work, string? detail = null)
    {
        var start = Stopwatch.GetTimestamp();
        await work().ConfigureAwait(false);
        Record(stage, Stopwatch.GetElapsedTime(start).TotalMilliseconds, detail);
    }

    public double this[Stage stage]
        => _timings.Where(t => t.Stage == stage).Sum(t => t.Milliseconds);
}
