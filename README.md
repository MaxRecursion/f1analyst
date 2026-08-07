# F1Analyst

Feasibility work for a client-side analytics platform: **Blazor WebAssembly** with a
local query engine, so reporting over millions of rows answers in milliseconds instead
of the minutes a server-side semantic layer costs — and keeps working offline.

Everything here is measurement, not opinion. Where a number appears, a script in this
repo produced it.

## What's in here

| Path | What it is |
|---|---|
| `spikes/duckdb-wasm/` | Feasibility harness — DuckDB-Wasm limits, OPFS behaviour, Arrow transfer cost, and a reproduction of the join fan-out bug |
| `demo/` | Three-arm comparison: the same 1M-row workload against three engine topologies |
| `demo/tools/` | Dataset generator, DuckDB→wasm cross-compile, toolchain acquisition |
| `demo/src/Demo.Shared/` | `IQueryEngine`, query IR, columnar results, stage timing — shared by all arms |

## The three arms

| Arm | Topology | Status |
|---|---|---|
| **A** | duckdb-wasm in a Web Worker, Arrow IPC over a 4-function JS gateway | builds |
| **B** | DuckDB statically linked into the .NET runtime, called by P/Invoke | **links and runs** |
| **C** | .NET 11 with .NET itself on a Web Worker, C#-to-C# via `WebWorkerClient` | in progress |

Arm B is the interesting one. It is widely assumed to be impossible; it is not.

## Findings so far

Measured on an M-series Mac, Chromium 148.

**Data.** 1M rows x 25 heterogeneous columns: **43.2 MB** as ZSTD Parquet against
**483 MB** as equivalent JSON — 11x. A 10M-row set lands at 345 MB.

**DuckDB-Wasm.** All three bundles compile `MAXIMUM_MEMORY` at the full **4 GiB**, not
the 2 GB often cited. Query cancellation via `conn.send()` + `cancelSent()` works and
returns in **74 ms**; `conn.query()` cannot be cancelled at all. Single-threaded scan
and aggregate over 8M rows runs 429–1357 ms.

**A trap worth knowing.** Calling `db.open({path:'opfs://…'})` silently breaks the
statically linked parquet extension — `read_parquet` then fails with *"did not contain
the expected entrypoint function `parquet_duckdb_cpp_init`"*. Use the default in-memory
catalogue plus `registerOPFSFileName()`.

**Threads or Parquet-from-OPFS, not both.** The threaded `coi` bundle cannot load the
parquet extension (shared-memory `LinkError`) and cannot register OPFS files
(`FileSystemSyncAccessHandle` is not structured-cloneable). The `eh` bundle does both.

**Statically linking DuckDB into Blazor WASM works.** DuckDB v1.4.3 cross-compiles with
Emscripten **3.1.56** — the version .NET 10 pins — in 132 s. Linking it needs all 15
archives, and the P/Invoke library name must match the `.a` filename. `dotnet.native.wasm`
grows 2.9 MB → **30.8 MB** (4.5 MB brotli). It then opens a database and executes a
query from P/Invoke. `-fwasm-exceptions` matches .NET's `-exception-model=wasm` cleanly.

**Also confirmed from the linker command line:** the .NET heap is capped at
`--max-memory=2147483648` — 2 GiB.

**On `WasmEnableThreads`.** Verified in `dotnet/runtime` source: on .NET 8 and 9 the
jiterpreter is entirely disabled when threads are on
(`DEFINE_BOOL_READONLY(jiterpreter_traces_enabled, FALSE)` — *"jiterpreter AOT
optimizations aren't thread safe yet"*), and GC safepoints are forced on. Microsoft's
published jiterpreter gains are ~20% faster rendering and ~2x faster JSON
deserialization, so a threaded build hands those back. Blazor on the multithreaded
runtime is not supported in any shipped version.

## Reproducing

```bash
# toolchain (~2 GB: emsdk 3.1.56 + DuckDB source)
demo/tools/prep-duckdb-wasm-toolchain.sh

# cross-compile DuckDB to static wasm (~2 min)
demo/tools/build-duckdb-static.sh

# generate the dataset
cd demo && npm install && node tools/gen-demo-data.mjs 1000000

# the feasibility harness
cd spikes/duckdb-wasm && npm install && npm run build && node serve.mjs
```

Requires the .NET 11 SDK with the `wasm-tools` and `wasm-tools-net10` workloads,
Node 22+, and CMake.

## Caveats

Browser measurements were taken in Chromium 148 (Electron), whose OPFS quota is ~2.7 GB
rather than Chrome's ~60% of disk. Re-run in a managed Chrome before treating storage
and `persist()` numbers as final.

All data is synthetic. Nothing here contains real business data.
