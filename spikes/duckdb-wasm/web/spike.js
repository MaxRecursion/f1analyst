// Spike 1 — in-browser measurements for the F1Analyst feasibility gate.
//
// Runs the SAME queries as bench-native.mjs so the Wasm↔native slowdown is directly
// comparable. Everything is logged with numbers; nothing here is a simulation.

// Bundled by esbuild (see package.json "build") because duckdb-browser.mjs carries a
// bare `apache-arrow` import the browser cannot resolve on its own. The .wasm and
// worker files are still fetched from /duckdb/ at runtime as plain URLs.
import * as duckdb from '@duckdb/duckdb-wasm'

const $log = document.getElementById('log')
const $env = document.getElementById('env')

const log = (msg = '', cls = '') => {
  const span = document.createElement('span')
  if (cls) span.className = cls
  span.textContent = msg + '\n'
  $log.appendChild(span)
  $log.scrollTop = $log.scrollHeight
}
const rule = (t = '') => log('\n' + '─'.repeat(74) + (t ? `\n  ${t}\n` : '') + '─'.repeat(74))
const mb = (b) => (b / 1024 ** 2).toFixed(1) + ' MB'

// ─────────────────────────────────────────────────────────── environment report

const envRow = (k, v, cls) => {
  const dt = document.createElement('dt'); dt.textContent = k
  const dd = document.createElement('dd'); dd.textContent = v; if (cls) dd.className = cls
  $env.append(dt, dd)
}

const est = await navigator.storage?.estimate?.() ?? {}
const persisted = await navigator.storage?.persisted?.() ?? false

envRow('crossOriginIsolated', String(crossOriginIsolated), crossOriginIsolated ? 'ok' : 'bad')
envRow('SharedArrayBuffer', typeof SharedArrayBuffer !== 'undefined' ? 'available' : 'MISSING',
       typeof SharedArrayBuffer !== 'undefined' ? 'ok' : 'bad')
envRow('hardwareConcurrency', String(navigator.hardwareConcurrency))
envRow('storage quota', est.quota ? mb(est.quota) + `  (${(est.quota / 1024 ** 3).toFixed(1)} GB)` : 'unknown')
envRow('storage in use', est.usage ? mb(est.usage) : '0 MB')
envRow('persisted()', String(persisted), persisted ? 'ok' : 'warn')
envRow('userAgent', navigator.userAgent)

// ─────────────────────────────────────────────────────────────────── queries
// Mirrors bench-native.mjs exactly. TXN/DIST are replaced with the registered
// OPFS file lists at run time.

const QUERY_TEMPLATES = {
  Q1_scan_aggregate: `
    SELECT txn_type, COUNT(*) AS n, SUM(amount_base) AS total
    FROM {{TXN}} GROUP BY txn_type ORDER BY total DESC`,

  Q2_timeseries: `
    SELECT d.month_key, t.txn_type, COUNT(*) AS n, SUM(t.amount_base) AS total
    FROM {{TXN}} t JOIN {{DATE}} d ON d.date_key = t.date_key
    GROUP BY 1, 2 ORDER BY 1, 2`,

  Q3_dimension_join: `
    SELECT g.region, d.month_key, COUNT(*) AS n, SUM(t.amount_base) AS total
    FROM {{TXN}} t
    JOIN {{DATE}} d  ON d.date_key  = t.date_key
    JOIN {{GROUP}} g ON g.group_key = t.group_key
    WHERE t.status = 'POSTED'
    GROUP BY 1, 2 ORDER BY 1, 2`,

  Q4_fork_post_join: `
    WITH txn AS (
      SELECT g.region AS region, d.month_key AS month_key,
             SUM(t.amount_base) AS m_txn_amount, COUNT(*) AS _legrows_txn
      FROM {{TXN}} t
      JOIN {{DATE}} d  ON d.date_key  = t.date_key
      JOIN {{GROUP}} g ON g.group_key = t.group_key
      GROUP BY 1, 2
    ), dist AS (
      SELECT g.region AS region, d.month_key AS month_key,
             SUM(f.amount_base) AS m_dist_amount, COUNT(*) AS _legrows_dist
      FROM {{DIST}} f
      JOIN {{DATE}} d  ON d.date_key  = f.date_key
      JOIN {{GROUP}} g ON g.group_key = f.group_key
      GROUP BY 1, 2
    )
    SELECT COALESCE(t.region, x.region) AS region,
           COALESCE(t.month_key, x.month_key) AS month_key,
           t.m_txn_amount, x.m_dist_amount,
           x.m_dist_amount / NULLIF(t.m_txn_amount, 0) AS m_dist_ratio,
           t._legrows_txn, x._legrows_dist
    FROM txn t FULL OUTER JOIN dist x
      ON t.region = x.region AND t.month_key = x.month_key
    ORDER BY 1, 2`,
}

// Native medians from bench-native.mjs (10 threads), for the slowdown factor.
const NATIVE_MS = {
  Q1_scan_aggregate: 28, Q2_timeseries: 38,
  Q3_dimension_join: 36, Q4_fork_post_join: 64,
}

// ──────────────────────────────────────────────────────────────────── state

let db = null, conn = null, bundleName = null
let tableFiles = {}          // table -> [registered opfs names]

// Exposed for console poking — this is a spike harness, not production.
window.__spike = { duckdb, get db() { return db }, get conn() { return conn },
                   get tableFiles() { return tableFiles } }

const $ = (id) => document.getElementById(id)
const enable = (...ids) => ids.forEach(i => { $(i).disabled = false })

// ─────────────────────────────────────────────────────── 1 · instantiate

$('btn-init').onclick = async () => {
  $('btn-init').disabled = true
  try {
    rule('INSTANTIATE')

    const BUNDLES = {
      mvp: { mainModule: '/duckdb/duckdb-mvp.wasm', mainWorker: '/duckdb/duckdb-browser-mvp.worker.js' },
      eh:  { mainModule: '/duckdb/duckdb-eh.wasm',  mainWorker: '/duckdb/duckdb-browser-eh.worker.js' },
      coi: { mainModule: '/duckdb/duckdb-coi.wasm', mainWorker: '/duckdb/duckdb-browser-coi.worker.js',
             pthreadWorker: '/duckdb/duckdb-browser-coi.pthread.worker.js' },
    }

    // ?bundle=eh|coi|mvp forces a specific build. Needed because the threaded `coi`
    // build cannot load the published parquet extension (shared-memory LinkError),
    // so comparing eh vs coi is a first-class question, not a detail.
    const forced = new URLSearchParams(location.search).get('bundle')
    const t0 = performance.now()
    const bundle = forced ? BUNDLES[forced] : await duckdb.selectBundle(BUNDLES)
    bundleName = Object.entries(BUNDLES).find(([, b]) => b.mainModule === bundle.mainModule)?.[0]

    const worker = new Worker(bundle.mainWorker)
    db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker)
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker)
    const instantiateMs = performance.now() - t0

    // NOTE: do NOT call db.open({path:'opfs://...'}) here. Opening an OPFS-backed
    // database breaks the statically-linked parquet extension — read_parquet then
    // fails with "did not contain the expected entrypoint function
    // 'parquet_duckdb_cpp_init'". Verified on both 1.32.0 and 1.33.1-dev57.0.
    // The default in-memory catalogue keeps parquet working.
    conn = await db.connect()
    const ver = (await (await conn.query(`SELECT version() AS v`)).toArray())[0].v

    log(`  bundle selected      ${bundleName}${bundleName === 'coi' ? '  (threaded)' : '  (single-threaded)'}`,
        bundleName === 'coi' ? 'ok' : 'warn')
    log(`  DuckDB version       ${ver}`)
    log(`  instantiate          ${instantiateMs.toFixed(0)} ms`)

    if (bundleName !== 'coi') {
      log(`\n  NOT running the threaded build. crossOriginIsolated=${crossOriginIsolated}.`, 'warn')
      log(`  Every timing below is single-threaded and is the pessimistic case.`, 'warn')
    }

    // Pragmas the plan prescribes.
    await conn.query(`SET memory_limit='1500MB'`)
    await conn.query(`SET preserve_insertion_order=false`)
    await conn.query(`SET default_null_order='NULLS LAST'`)
    const threads = (await (await conn.query(`SELECT current_setting('threads') AS t`)).toArray())[0].t
    log(`  threads              ${threads}`)

    enable('btn-load')
  } catch (e) {
    log('  FAILED: ' + e.message, 'bad'); console.error(e)
    $('btn-init').disabled = false
  }
}

// ────────────────────────────────────────────── 2 · pull Parquet into OPFS

$('btn-load').onclick = async () => {
  $('btn-load').disabled = true
  try {
    rule('LOAD PARQUET → OPFS')

    if (!persisted) {
      const granted = await navigator.storage.persist()
      log(`  navigator.storage.persist() → ${granted}`, granted ? 'ok' : 'warn')
      if (!granted) log(`  Storage is evictable. For an offline-required app this is the risk.`, 'warn')
    }

    const { files, totalBytes } = await (await fetch('/manifest.json')).json()
    log(`  manifest: ${files.length} files, ${mb(totalBytes)}\n`)

    const root = await navigator.storage.getDirectory()
    const tDownload = performance.now()
    let done = 0, bytes = 0

    for (const f of files) {
      let handle
      try {
        // Reuse if already present and the right size — makes re-runs fast.
        handle = await root.getFileHandle(f.name)
        const existing = await handle.getFile()
        if (existing.size !== f.bytes) throw new Error('size mismatch')
      } catch {
        handle = await root.getFileHandle(f.name, { create: true })
        const resp = await fetch(f.path)
        const w = await handle.createWritable()
        await resp.body.pipeTo(w)
      }
      bytes += f.bytes
      if (++done % 10 === 0 || done === files.length) {
        log(`  ${String(done).padStart(3)}/${files.length}  ${mb(bytes)}`)
      }
    }
    const downloadMs = performance.now() - tDownload

    log(`\n  download + OPFS write  ${(downloadMs / 1000).toFixed(1)} s   ` +
        `(${(bytes / 1024 ** 2 / (downloadMs / 1000)).toFixed(0)} MB/s)`)

    // How does DuckDB actually get at these files?
    //   Path 1 (wanted): scan in place from OPFS — preserves row-group/column pruning
    //                    and keeps bytes out of the Wasm heap.
    //   Path 2 (fallback): copy every byte into the Wasm heap as a registered buffer.
    // Path 1 is attempted first and its failure is reported, because which one works
    // decides whether the plan's "Parquet blobs in OPFS" storage model is viable.
    tableFiles = {}
    let mode = 'opfs-in-place'
    const tReg = performance.now()
    try {
      for (const f of files) {
        await db.registerOPFSFileName('opfs://' + f.name)
        ;(tableFiles[f.table] ??= []).push('opfs://' + f.name)
      }
      await conn.query(`SELECT COUNT(*) FROM read_parquet('${tableFiles.dim_group[0]}')`)
      log(`  registration           OPFS in-place (${(performance.now() - tReg).toFixed(0)} ms)`, 'ok')
    } catch (e) {
      mode = 'heap-buffer'
      log(`  OPFS in-place FAILED:  ${e.message.slice(0, 96)}`, 'bad')
      log(`  Falling back to registerFileBuffer — every byte enters the Wasm heap,`, 'warn')
      log(`  which defeats scan-in-place and is a real finding for the storage model.`, 'warn')
      tableFiles = {}
      const t2 = performance.now()
      const root2 = await navigator.storage.getDirectory()
      for (const f of files) {
        const fh = await root2.getFileHandle(f.name)
        const bytes = new Uint8Array(await (await fh.getFile()).arrayBuffer())
        await db.registerFileBuffer(f.name, bytes)
        ;(tableFiles[f.table] ??= []).push(f.name)
      }
      log(`  buffer registration    ${((performance.now() - t2) / 1000).toFixed(1)} s for ${mb(bytes)}`)
    }
    window.__spike.mode = mode

    const after = await navigator.storage.estimate()
    log(`  OPFS usage now         ${mb(after.usage)} of ${(after.quota / 1024 ** 3).toFixed(1)} GB quota`)

    for (const [t, fs] of Object.entries(tableFiles)) {
      const n = (await (await conn.query(`SELECT COUNT(*) AS n FROM ${list(fs)}`)).toArray())[0].n
      log(`  ${t.padEnd(16)} ${Number(n).toLocaleString().padStart(12)} rows   ${fs.length} file(s)`)
    }

    enable('btn-bench', 'btn-arrow', 'btn-governor')
  } catch (e) {
    log('  FAILED: ' + e.message, 'bad'); console.error(e)
    $('btn-load').disabled = false
  }
}

const list = (names) => `read_parquet([${names.map(n => `'${n}'`).join(',')}])`

const bind = (sql) => sql
  .replaceAll('{{TXN}}', list(tableFiles.fact_txn))
  .replaceAll('{{DIST}}', list(tableFiles.fact_fund_dist))
  .replaceAll('{{DATE}}', list(tableFiles.dim_date))
  .replaceAll('{{GROUP}}', list(tableFiles.dim_group))
  .replaceAll('{{COMPANY}}', list(tableFiles.dim_company))

// ──────────────────────────────────────────────────────────── 3 · benchmarks

$('btn-bench').onclick = async () => {
  $('btn-bench').disabled = true
  try {
    rule(`BENCHMARKS  (bundle: ${bundleName})`)
    log(`  ${'query'.padEnd(22)} ${'wasm'.padStart(9)} ${'native'.padStart(9)} ${'slowdown'.padStart(10)}   rows`)
    log('  ' + '-'.repeat(66))

    for (const [name, tpl] of Object.entries(QUERY_TEMPLATES)) {
      const sql = bind(tpl)
      let rows = 0
      const ts = []
      for (let i = 0; i < 4; i++) {                      // first run warms, then 3 measured
        const t = performance.now()
        const res = await conn.query(sql)
        const ms = performance.now() - t
        rows = res.numRows
        if (i > 0) ts.push(ms)
      }
      ts.sort((a, b) => a - b)
      const median = ts[1]
      const factor = median / NATIVE_MS[name]
      log(`  ${name.padEnd(22)} ${median.toFixed(0).padStart(6)} ms ${String(NATIVE_MS[name]).padStart(6)} ms ` +
          `${factor.toFixed(1).padStart(9)}x   ${rows}`,
          median < 500 ? 'ok' : median < 1500 ? 'warn' : 'bad')
    }

    log(`\n  Plan's gate: self-service aggregate over 8M rows should land`)
    log(`  200–900 ms single-threaded, 80–300 ms threaded.`)
  } catch (e) {
    log('  FAILED: ' + e.message, 'bad'); console.error(e)
  } finally { $('btn-bench').disabled = false }
}

// ────────────────────────────────────────── 4 · Arrow transfer / marshalling cost

$('btn-arrow').onclick = async () => {
  $('btn-arrow').disabled = true
  try {
    rule('ARROW RESULT SIZE + MATERIALIZATION COST')
    log(`  This is the boundary Blazor pays twice: once out of the DuckDB heap,`)
    log(`  once into the .NET heap. Keeping it small is the whole discipline.\n`)
    log(`  ${'rows'.padStart(8)} ${'arrow bytes'.padStart(13)} ${'query'.padStart(9)} ${'toArray()'.padStart(11)}`)
    log('  ' + '-'.repeat(46))

    for (const limit of [1000, 10000, 50000, 250000]) {
      const sql = bind(`SELECT txn_id, company_key, txn_date, txn_type, status,
                               amount_base, fee, tax, net_amount, fx_rate
                        FROM {{TXN}} LIMIT ${limit}`)
      const t0 = performance.now()
      const res = await conn.query(sql)
      const queryMs = performance.now() - t0

      // Sum the underlying Arrow buffers — a good proxy for IPC payload size.
      let bytes = 0
      for (const batch of res.batches) {
        const stack = [batch.data]
        while (stack.length) {
          const d = stack.pop()
          for (const b of d.buffers ?? []) if (b?.byteLength) bytes += b.byteLength
          for (const c of d.children ?? []) stack.push(c)
        }
      }

      const t1 = performance.now()
      res.toArray()                                     // JS-object materialization
      const toArrayMs = performance.now() - t1

      log(`  ${res.numRows.toLocaleString().padStart(8)} ${mb(bytes).padStart(13)} ` +
          `${queryMs.toFixed(0).padStart(6)} ms ${toArrayMs.toFixed(0).padStart(8)} ms`,
          bytes > 64 * 1024 ** 2 ? 'bad' : '')
    }
    log(`\n  Plan caps a page at 50k rows and aborts above ~64 MB of Arrow.`)
    log(`  Note how toArray() scales — that is the analogue of marshalling into .NET.`)
  } catch (e) {
    log('  FAILED: ' + e.message, 'bad'); console.error(e)
  } finally { $('btn-arrow').disabled = false }
}

// ──────────────────────────────────────────── 5 · runaway query + cancellation

$('btn-governor').onclick = async () => {
  $('btn-governor').disabled = true
  try {
    rule('RUNAWAY QUERY + CANCELLATION')
    log(`  The plan claims conn.query() cannot be cancelled and only conn.send()`)
    log(`  reaches cancelPendingQuery. Testing that directly.\n`)

    // A deliberate cross join — the shape an unguarded designer query can produce.
    const evil = bind(`
      SELECT COUNT(*) FROM {{TXN}} a
      JOIN {{TXN}} b ON a.company_key = b.company_key
      WHERE a.amount_base > 0`)

    const c2 = await db.connect()
    const t0 = performance.now()
    const pending = c2.send(evil)
    log(`  issued via conn.send(); cancelling in 2000 ms...`)
    await new Promise(r => setTimeout(r, 2000))

    const tc = performance.now()
    let cancelled = false
    try { cancelled = await c2.cancelSent() } catch (e) { log('  cancelSent threw: ' + e.message, 'warn') }
    const cancelMs = performance.now() - tc
    log(`  cancelSent() → ${cancelled}  in ${cancelMs.toFixed(0)} ms`, cancelled ? 'ok' : 'bad')

    try {
      const reader = await pending
      let n = 0
      for await (const b of reader) n += b.numRows
      log(`  query still completed with ${n} rows after ${(performance.now() - t0).toFixed(0)} ms`, 'warn')
    } catch (e) {
      log(`  pending query rejected (expected on cancel): ${e.message}`, 'ok')
    }
    await c2.close()

    log(`\n  If cancelSent() returned false or took >1500 ms, the plan's`)
    log(`  worker.terminate() + pre-warmed spare fallback is load-bearing.`)
  } catch (e) {
    log('  FAILED: ' + e.message, 'bad'); console.error(e)
  } finally { $('btn-governor').disabled = false }
}

// ───────────────────────────────────────────────────────────────── reset

$('btn-reset').onclick = async () => {
  const root = await navigator.storage.getDirectory()
  let n = 0
  for await (const name of root.keys()) { await root.removeEntry(name).catch(() => {}); n++ }
  log(`\n  Cleared ${n} OPFS entries. Reload the page.`, 'warn')
}

log('Ready. Run the steps in order.\n')
if (!crossOriginIsolated) {
  log('WARNING: not cross-origin isolated — the threaded coi bundle is unavailable.', 'bad')
  log('Check that COOP/COEP headers are reaching the page.\n', 'bad')
}
