// Arm B dataset loader.
//
// Getting 43 MB into the in-process engine through .NET is pathologically slow: both
// HttpClient.GetByteArrayAsync and File.WriteAllBytes copy byte-by-byte through the
// single-threaded interpreter and do not complete in any reasonable time.
//
// The fast path writes directly into the Emscripten filesystem from JavaScript. This
// works precisely because DuckDB is statically linked into the .NET module and
// therefore shares its MEMFS — the same property that lets DuckDB's synchronous file
// API reach the data at all.
//
// Worth noting for the comparison: Arm B is meant to be the "no JavaScript" option, and
// it still needs JavaScript to load its data. It removes JS from the query path, not
// from the application.

export async function loadIntoWasmFs(url, path) {
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`fetch ${url} -> ${resp.status}`)
  const bytes = new Uint8Array(await resp.arrayBuffer())

  const runtime = globalThis.getDotnetRuntime?.(0)
  const FS = runtime?.Module?.FS
  if (!FS) throw new Error('Emscripten FS not reachable from the .NET runtime')

  // Single typed-array write — no per-byte marshalling.
  FS.writeFile(path, bytes)
  return bytes.length
}

/** Confirms DuckDB can see what we wrote, before we blame the engine for a bad path. */
export function statWasmFs(path) {
  const FS = globalThis.getDotnetRuntime?.(0)?.Module?.FS
  try { return JSON.stringify({ exists: true, size: FS.stat(path).size }) }
  catch (e) { return JSON.stringify({ exists: false, error: String(e && e.message || e) }) }
}
