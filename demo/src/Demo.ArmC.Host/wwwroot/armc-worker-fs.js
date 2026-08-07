// Loaded BY THE WORKER's own .NET runtime, so `Module.FS` here is the worker's
// filesystem — which is exactly where DuckDB (linked into that same instance) reads
// from. The main thread never holds these bytes.
export async function fetchIntoFs(url, path) {
  // Inside a worker a relative URL resolves against the WORKER SCRIPT's location
  // (/_content/Demo.ArmC.Worker/), not the page — so 'data/demo.parquet' 404s.
  // Same trap as duckdb-wasm's worker; resolve against the origin explicitly.
  const abs = new URL(url, self.location.origin).href
  const resp = await fetch(abs)
  if (!resp.ok) throw new Error(`fetch ${abs} -> ${resp.status}`)
  const bytes = new Uint8Array(await resp.arrayBuffer())
  const FS = globalThis.getDotnetRuntime?.(0)?.Module?.FS
  if (!FS) throw new Error('worker Emscripten FS not reachable')
  FS.writeFile(path, bytes)
  return bytes.length
}
