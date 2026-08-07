# Three-way engine assessment — results and demo notes

**1,000,000 rows · 25 heterogeneous columns · identical queries · one shared UI**

Measured 2026-08-07 on an M-series Mac, Chromium 148, .NET 10 runtime.
Every number here was produced by code in this repository.

---

## Recommendation

**Ship Arm A — duckdb-wasm in a Web Worker.** Not because it is fastest (it isn't),
but because it is the only arm that is both non-blocking *and* predictable across
result sizes, and the only one whose engine we do not have to maintain ourselves.

Arm B is genuinely faster and its zero-copy result path is real, but it freezes the
browser for the duration of every query. Arm C removes the freeze and is fastest on
small results, but its JSON boundary makes large results four times slower than Arm A.

**Arm C is the one to watch.** Its problem is an implementation detail we chose, not a
property of the topology — swap JSON for Arrow IPC across the worker boundary and it
plausibly becomes the best of the three. That is the highest-value next experiment.

---

## What was actually built

All three are real, working Blazor WebAssembly applications running the same
`Assessment` page over the same dataset, differing only in which `IQueryEngine` is
registered in `Program.cs`. Application code never learns which engine is underneath.

| | Arm A | Arm B | Arm C |
|---|---|---|---|
| **Engine** | duckdb-wasm | DuckDB statically linked | DuckDB statically linked |
| **Runs in** | Web Worker | UI thread | .NET Web Worker |
| **Called via** | JS gateway (4 functions) | P/Invoke | C#→C# `WebWorkerClient` |
| **Result crosses as** | Arrow IPC, one memcpy | nothing — same heap | JSON |
| **JS in app code** | none above `IQueryEngine` | none | none |
| **Payload** (`dotnet.native.wasm`) | 2.9 MB + 32.7 MB engine | **29.5 MB** | **29.5 MB** |
| **Cancellable** | yes (`cancelSent`, 74 ms) | **no** | yes (`CancellationToken`) |

---

## Results

Warm timings, milliseconds. Lower is better; **bold** is the winner.

| Query | Arm A | Arm B | Arm C |
|---|---|---|---|
| 1 · Portfolio summary (9 rows) | 886 | 734 | **644** |
| 2 · Monthly trend (180 rows) | 550 | 475 | **280** |
| 3 · Top counterparties (500 rows) | 1,647 | **813** | 878 |
| 4 · Detail drill-through (50k rows) | 3,579 | **1,647** | 6,877 |
| 5 · Heavy analytical scan (36 rows) | 1,862 | **1,780** | 1,831 |
| **Cold start** (engine init) | 1,180 | **283** | 627 |
| **Dataset attach** (43 MB) | 215 | **92** | 167 |

### Where the time goes — the 50k-row query

This is the query that separates the arms, because it is cheap to compute and
expensive to move.

| Stage | Arm A | Arm B | Arm C |
|---|---|---|---|
| Query execute | 2,305 | 747 | 800 |
| Result transfer | 27 | **0** | 1,162 |
| Decode into .NET | 1,186 | 810 | 4,835 |
| **Total** | 3,579 | **1,647** | 6,877 |

Arm B's transfer is genuinely zero — the vectors are already in the heap .NET is
running in. Arm C pays 6.0 seconds to serialize and parse JSON for a result Arm A
moves in 1.2 seconds as Arrow IPC.

---

## The measurement that decides it

Raw latency is not the deciding number. This is.

A timer-loop probe runs on the UI thread and records the largest gap between
iterations. If the thread is blocked, the loop cannot iterate, so the maximum gap **is**
the block duration.

| | baseline gap | max gap **during** query | query duration | verdict |
|---|---|---|---|---|
| **Arm A** | 1,001 ms | 1,001 ms | 3,392 ms | unaffected |
| **Arm B** | 650 ms | **1,793 ms** | 1,780 ms | **blocked throughout** |
| **Arm C** | 999 ms | 1,000 ms | 1,831 ms | unaffected |

Arms A and C show no blocking beyond the ambient background-tab timer clamp. Arm B
blocks for the entire query — during which the browser cannot paint, cannot process
input, and cannot honour the Cancel button, because the click handler is queued behind
the query that Cancel is meant to stop.

*Method note:* the `requestAnimationFrame` heartbeat originally built into the demo
reported "0 ms freeze" for every arm. That was wrong — rAF is fully throttled in a
hidden pane, so it was measuring nothing. The timer-loop probe replaced it. Its
resolution is bounded by the ~1 s background timer clamp, so blocks shorter than a
second would not be visible; Arm B's 1.8 s block exceeded it comfortably.

---

## What each arm is genuinely good at

**Arm A — duckdb-wasm in a Web Worker.** Consistent across result sizes, never blocks,
cancellation works and returns in 74 ms, and the engine is maintained by someone else.
Its weakness is decode: turning 50k rows of Arrow into managed columns costs 1,186 ms,
because per-value loops are expensive in the Blazor interpreter. That is fixable by
decoding lazily for visible rows only.

**Arm B — DuckDB in-process.** Fastest engine times, a genuinely zero-copy result path,
fastest cold start (283 ms — no second wasm module to fetch), and the smallest total
payload. It is also disqualified for interactive use by the blocking, and it cannot be
cancelled. Worth remembering it exists: for a batch or export path where blocking does
not matter, it is the best engine here.

**Arm C — .NET in a Web Worker.** The architecture we predicted would win, and on small
results it does — 280 ms on the monthly trend, less than half of Arm A. Application
code is pure C# with a `CancellationToken`. Its JSON boundary is the whole problem, and
it is a problem we introduced, not one the topology forces.

---

## Corrections to earlier claims

Recorded because the analysis was wrong before it was right, and the demo should not
repeat claims that did not survive measurement.

1. **"Statically linking DuckDB into Blazor WASM is a dead end."** False. It compiles
   with Emscripten 3.1.56 in 132 seconds and runs. Arm B exists.
2. **"The interop boundary is cheap, ~6 ms."** Misleading. The *transfer* is cheap
   (27 ms for 50k rows). The *decode* into managed columns is not — 1,186 ms. The
   earlier figure measured JS-side `toArray()`, which is not the boundary that matters.
3. **"The exception-handling scheme matches cleanly."** True for .NET 10 only. Against
   .NET 11 the same archives fail with *"module uses a mix of legacy and new exception
   handling instructions"*. Arms B and C both target net10.0 for this reason.
4. **"UI never blocked — 0 ms, 0 dropped frames."** Not valid evidence; the instrument
   was not running. The conclusion held up, but only on the replacement measurement.

---

## Demo notes

**Audience:** senior leadership. **Duration:** 10 minutes. **Ask:** approval to proceed
with Arm A and to fund the Arrow-over-worker experiment.

### Framing (1 min)

Reporting today runs through WebI at minutes per query. The question is not whether we
can make it faster — it is whether the data can live close enough to the user that
"faster" stops being the conversation. All three prototypes answer a query over a
million rows in under two seconds, on a laptop, with no server involved.

### The opening number (1 min)

Show `demo/data/`. **43 MB of Parquet against 483 MB of equivalent JSON** — 11×. This
is why the whole approach is possible at all.

### Run the three arms (5 min)

Open all three at `localhost:8201`, `:8202`, `:8203`. Run **query 2** on each and read
the totals: 550 / 475 / 280 ms. All three are fast. This is the moment to say that
speed is *not* what separates them.

Then run **query 5 (heavy analytical scan)** on Arm B and **click Cancel while it
runs**. Nothing happens — the button cannot respond, because the query is on the same
thread as the UI. Run the same query on Arm A and click Cancel; it stops in 74 ms.

That contrast is the whole decision. If someone asks for a number, the probe: Arm B
blocks for 1,793 ms on a 1,780 ms query; Arm A does not block at all.

### The scale trap (2 min)

Run **query 4 (50k rows)** on all three: 3,579 / 1,647 / 6,877 ms. Point out that the
ranking *inverted* — the arm that won on small results lost badly on large ones. This
is why the assessment measures stages, not totals: Arm C's 6.9 seconds is 6.0 seconds
of JSON, and JSON was our choice.

### The ask (1 min)

Proceed with Arm A. Fund one experiment: Arrow IPC across the worker boundary in Arm C.
If it lands where the stage timings suggest, we get Arm B's speed with Arm A's
responsiveness and no JavaScript in application code.

### Questions to expect

**"Why not the fastest one?"** Because the fastest one freezes the browser. Show the
Cancel button again.

**"Is the in-process one wasted work?"** No — it proved the ceiling, and it is the
right engine for a non-interactive export path.

**"How much of this is throwaway?"** Almost none. All three share one `IQueryEngine`,
one query set, one UI. Changing engine is one line in `Program.cs`.

**"What is not yet proven?"** Numbers come from a synthetic dataset on one machine in
one browser. Real SAP data, a managed Chrome fleet, and entitlement-scoped extracts are
all still ahead. Nothing here has touched real business data.

---

## Reproducing

```bash
demo/tools/prep-duckdb-wasm-toolchain.sh    # emsdk 3.1.56 + DuckDB source (~2 GB)
demo/tools/build-duckdb-static.sh           # cross-compile, ~2 min, 71 MB of archives
cd demo && npm install && node tools/gen-demo-data.mjs 1000000

dotnet publish src/Demo.ArmA.WasmWorker -c Release -o /tmp/armA
dotnet publish src/Demo.ArmB.InProcess   -c Release -o /tmp/armB
dotnet publish src/Demo.ArmC.Host        -c Release -o /tmp/armC
# serve each wwwroot on 8201 / 8202 / 8203
```

Requires the .NET SDK with `wasm-tools` **and** `wasm-tools-net10` (the latter carries
the Emscripten that DuckDB was built against), Node 22+, CMake, and Python 3.10+.

## Caveats

Measured in Chromium 148 (Electron) with the pane frequently backgrounded, which clamps
timers to ~1 s and throttles rAF entirely. Query timings come from `Stopwatch` inside
the app and are unaffected; the blocking probe is bounded by that clamp as noted above.
Re-run in a foreground managed Chrome before quoting these externally.

All data is synthetic.
