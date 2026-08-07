// Arm A gateway — the ENTIRE JavaScript surface of this architecture.
//
// Four functions. Everything above this file is C#; everything below is duckdb-wasm
// running in its own Web Worker with its own linear memory. The narrowness is the
// point: if the interop surface is four functions, "we depend on JavaScript" is not a
// meaningful architectural objection.
//
// Results cross as Arrow IPC bytes, parked here and copied into the .NET heap exactly
// once via a MemoryView over an ArraySegment<byte>. Returning JSON instead would be
// 3-5x the bytes and far slower to parse — the single easiest way to squander the
// performance this architecture exists to deliver.

import * as duckdb from '@duckdb/duckdb-wasm'
import * as arrow from 'apache-arrow'

let db = null
let conn = null
const parked = new Map()          // handleId -> Uint8Array awaiting pickup by .NET
const inFlight = new Map()        // handleId -> connection running it, for cancellation

let lastQueryMs = 0
let lastTransferBytes = 0

/**
 * Instantiate duckdb-wasm in a dedicated Worker.
 *
 * Deliberately uses the `eh` bundle rather than `coi`: the threaded build cannot load
 * the parquet extension (shared-memory LinkError) and cannot register OPFS files
 * (FileSystemSyncAccessHandle is not structured-cloneable). Measured, not assumed.
 */
export async function initialize(baseUrl) {
  // Absolute URLs are required. duckdb-wasm's worker fetches mainModule from INSIDE
  // the worker, where a relative path resolves against the worker script's own URL —
  // '/duckdb/duckdb-eh.wasm' would become '/duckdb/duckdb/duckdb-eh.wasm' and 404.
  const root = `${location.origin}/${baseUrl}`.replace(/\/+$/, '')
  const BUNDLES = {
    mvp: { mainModule: `${root}/duckdb-mvp.wasm`, mainWorker: `${root}/duckdb-browser-mvp.worker.js` },
    eh:  { mainModule: `${root}/duckdb-eh.wasm`,  mainWorker: `${root}/duckdb-browser-eh.worker.js` },
  }
  const bundle = BUNDLES.eh
  const worker = new Worker(bundle.mainWorker)
  db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker)
  await db.instantiate(bundle.mainModule)

  // NOTE: no db.open({path:'opfs://...'}). Opening an OPFS-backed database breaks the
  // statically linked parquet extension — read_parquet then fails with
  // "did not contain the expected entrypoint function 'parquet_duckdb_cpp_init'".
  conn = await db.connect()

  await conn.query(`SET memory_limit='1500MB'`)
  await conn.query(`SET preserve_insertion_order=false`)
  await conn.query(`SET default_null_order='NULLS LAST'`)

  const v = await conn.query(`SELECT version() AS v`)
  return JSON.stringify({ version: v.toArray()[0].v, bundle: 'eh', threads: 1 })
}

/**
 * Fetch the dataset, persist it to OPFS, and register it for in-place scanning.
 * The bytes never enter the .NET heap — DuckDB reads row groups it actually needs.
 */
export async function attachDataset(url, name) {
  const root = await navigator.storage.getDirectory()
  let handle
  try {
    handle = await root.getFileHandle(name)
    await handle.getFile()                       // present already; reuse
  } catch {
    handle = await root.getFileHandle(name, { create: true })
    const resp = await fetch(url)
    if (!resp.ok) throw new Error(`fetch ${url} -> ${resp.status}`)
    await resp.body.pipeTo(await handle.createWritable())
  }
  await db.registerOPFSFileName(`opfs://${name}`)

  const est = await navigator.storage.estimate()
  const file = await (await root.getFileHandle(name)).getFile()
  return JSON.stringify({ table: `read_parquet('opfs://${name}')`, bytes: file.size, quota: est.quota })
}

/**
 * Run a query. Uses conn.send() rather than conn.query() because ONLY send() is
 * reachable by cancelSent() — query() routes to runQuery, which has no cancellation
 * hook. Verified against the duckdb-wasm source.
 *
 * Returns the byte length; the caller then pulls the bytes with copyResult.
 */
export async function runQuery(sql, handleId) {
  const c = await db.connect()
  inFlight.set(handleId, c)
  const t0 = performance.now()
  try {
    const reader = await c.send(sql)
    const batches = []
    for await (const batch of reader) batches.push(batch)
    lastQueryMs = performance.now() - t0

    // Serialize once, in the Arrow IPC stream format that Apache.Arrow (NuGet) reads
    // natively on the .NET side. No intermediate JSON, no per-row conversion.
    const bytes = batches.length
      ? arrow.tableToIPC(new arrow.Table(batches), 'stream')
      : new Uint8Array(0)
    parked.set(handleId, bytes)
    lastTransferBytes = bytes.byteLength
    return bytes.byteLength
  } finally {
    inFlight.delete(handleId)
    await c.close()
  }
}

/**
 * Copy parked bytes into a view over the .NET heap. This is the ONLY cross-heap copy
 * in the whole pipeline — measured at roughly 6 ms for a 50k-row page.
 */
export function copyResult(handleId, memoryView) {
  const bytes = parked.get(handleId)
  if (!bytes) throw new Error(`no parked result for handle ${handleId}`)
  parked.delete(handleId)
  memoryView.set(bytes)
}

/** Abandon an in-flight query. Returns whether the engine acknowledged the cancel. */
export async function cancelQuery(handleId) {
  const c = inFlight.get(handleId)
  if (!c) return false
  try { return await c.cancelSent() } catch { return false }
}

/** Timings the engine itself observed, so .NET can attribute time correctly. */
export function lastStats() {
  return JSON.stringify({ queryMs: lastQueryMs, transferBytes: lastTransferBytes })
}
