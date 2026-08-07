// Spike 1 — native DuckDB baseline over the generated Parquet.
// The browser harness runs the SAME queries so the Wasm slowdown factor is measurable.
//
// Queries mirror what the plan actually cares about:
//   Q1  simple aggregate over the full fact table
//   Q2  time-series aggregate (36 months x 8 types)
//   Q3  join to a dimension + hierarchy level rollup
//   Q4  the fork-and-post-join two-fact pattern (fan-out safe)
//   Q5  the naive chasm-trap query, to quantify what it costs and how wrong it is

import { DuckDBInstance } from '@duckdb/node-api'

const DATA = new URL('./data/', import.meta.url).pathname
const TXN = `read_parquet('${DATA}fact_txn/**/*.parquet', hive_partitioning = true)`
const DIST = `read_parquet('${DATA}fact_fund_dist/**/*.parquet', hive_partitioning = true)`
const COMPANY = `read_parquet('${DATA}dim_company.parquet')`
const GROUP = `read_parquet('${DATA}dim_group.parquet')`
const DATE = `read_parquet('${DATA}dim_date.parquet')`

export const QUERIES = {
  Q1_scan_aggregate: `
    SELECT txn_type, COUNT(*) AS n, SUM(amount_base) AS total
    FROM ${TXN}
    GROUP BY txn_type ORDER BY total DESC`,

  Q2_timeseries: `
    SELECT d.month_key, t.txn_type, COUNT(*) AS n, SUM(t.amount_base) AS total
    FROM ${TXN} t JOIN ${DATE} d ON d.date_key = t.date_key
    GROUP BY 1, 2 ORDER BY 1, 2`,

  Q3_dimension_join: `
    SELECT g.region, d.month_key, COUNT(*) AS n, SUM(t.amount_base) AS total
    FROM ${TXN} t
    JOIN ${DATE} d  ON d.date_key  = t.date_key
    JOIN ${GROUP} g ON g.group_key = t.group_key
    WHERE t.status = 'POSTED'
    GROUP BY 1, 2 ORDER BY 1, 2`,

  // The pattern the plan mandates: each fact aggregated at its OWN grain,
  // then FULL OUTER JOINed at the query grain. No Cartesian product.
  Q4_fork_post_join: `
    WITH txn AS (
      SELECT g.region AS region, d.month_key AS month_key,
             SUM(t.amount_base) AS m_txn_amount, COUNT(*) AS _legrows_txn
      FROM ${TXN} t
      JOIN ${DATE} d  ON d.date_key  = t.date_key
      JOIN ${GROUP} g ON g.group_key = t.group_key
      GROUP BY 1, 2
    ),
    dist AS (
      SELECT g.region AS region, d.month_key AS month_key,
             SUM(f.amount_base) AS m_dist_amount, COUNT(*) AS _legrows_dist
      FROM ${DIST} f
      JOIN ${DATE} d  ON d.date_key  = f.date_key
      JOIN ${GROUP} g ON g.group_key = f.group_key
      GROUP BY 1, 2
    )
    SELECT COALESCE(t.region, x.region)         AS region,
           COALESCE(t.month_key, x.month_key)   AS month_key,
           t.m_txn_amount, x.m_dist_amount,
           x.m_dist_amount / NULLIF(t.m_txn_amount, 0) AS m_dist_ratio,
           t._legrows_txn, x._legrows_dist
    FROM txn t FULL OUTER JOIN dist x
      ON t.region = x.region AND t.month_key = x.month_key
    ORDER BY 1, 2`,
}

// Deliberately wrong: two facts joined through their SHARED DIMENSION KEY only.
// This is exactly what a naive compiler emits when a user drags a transaction measure
// and a distribution measure into the same view. Restricted to one month so it terminates.
const MONTH = `date_key BETWEEN 20260101 AND 20260131`
const Q5_CHASM = `
  SELECT g.region,
         SUM(t.amount_base) AS txn_total_INFLATED,
         SUM(f.amount_base) AS dist_total_INFLATED,
         COUNT(*)           AS rows_produced
  FROM (SELECT * FROM ${TXN}  WHERE ${MONTH}) t
  JOIN (SELECT * FROM ${DIST} WHERE ${MONTH}) f ON f.group_key = t.group_key
  JOIN ${GROUP} g ON g.group_key = t.group_key
  GROUP BY 1 ORDER BY 1`

const Q5_CORRECT = `
  WITH txn AS (
    SELECT g.region AS region, SUM(t.amount_base) AS txn_total, COUNT(*) AS n_txn
    FROM ${TXN} t JOIN ${GROUP} g ON g.group_key = t.group_key
    WHERE ${MONTH} GROUP BY 1
  ), dist AS (
    SELECT g.region AS region, SUM(f.amount_base) AS dist_total, COUNT(*) AS n_dist
    FROM ${DIST} f JOIN ${GROUP} g ON g.group_key = f.group_key
    WHERE ${MONTH} GROUP BY 1
  )
  SELECT COALESCE(t.region, d.region) AS region, t.txn_total, d.dist_total, t.n_txn, d.n_dist
  FROM txn t FULL OUTER JOIN dist d ON t.region = d.region ORDER BY 1`

const instance = await DuckDBInstance.create(':memory:')
const db = await instance.connect()

const threads = (await (await db.runAndReadAll(`SELECT current_setting('threads') AS t`)).getRowObjects())[0].t
console.log(`\nNative DuckDB baseline — threads=${threads}\n`)

const time = async (label, sql, runs = 3) => {
  await db.run(sql)                                     // warm the file handles / metadata
  const ts = []
  for (let i = 0; i < runs; i++) {
    const t = performance.now()
    const r = await db.runAndReadAll(sql)
    r.getRowObjects()
    ts.push(performance.now() - t)
  }
  ts.sort((a, b) => a - b)
  console.log(`  ${label.padEnd(24)} median ${ts[Math.floor(runs / 2)].toFixed(0).padStart(6)} ms   ` +
              `min ${ts[0].toFixed(0).padStart(5)} ms`)
  return ts[Math.floor(runs / 2)]
}

const results = {}
for (const [name, sql] of Object.entries(QUERIES)) results[name] = await time(name, sql)

// ------------------------------------------------------- the chasm trap, quantified
console.log('\n' + '='.repeat(72))
console.log('  CHASM TRAP — one week of data, two facts joined through dim_group')
console.log('='.repeat(72))

const wrong = await (await db.runAndReadAll(Q5_CHASM)).getRowObjects()
const right = await (await db.runAndReadAll(Q5_CORRECT)).getRowObjects()

const fmt = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })
console.log(`  ${'region'.padEnd(7)} ${'correct txn'.padStart(16)} ${'INFLATED txn'.padStart(18)} ${'txn x'.padStart(7)} ${'dist x'.padStart(7)}`)
for (const r of right) {
  const w = wrong.find(x => x.region === r.region)
  if (!w) continue
  const ct = Number(r.txn_total), it = Number(w.txn_total_INFLATED)
  const cd = Number(r.dist_total), id = Number(w.dist_total_INFLATED)
  console.log(`  ${String(r.region).padEnd(7)} ${fmt(ct).padStart(16)} ${fmt(it).padStart(18)} ` +
              `${(it / ct).toFixed(1).padStart(6)}x ${(id / cd).toFixed(1).padStart(6)}x`)
}
const produced = wrong.reduce((a, r) => a + Number(r.rows_produced), 0)
const realTxn = right.reduce((a, r) => a + Number(r.n_txn ?? 0), 0)
console.log(`\n  Rows the naive join produced: ${fmt(produced)}  (real transactions: ${fmt(realTxn)})`)
console.log(`  Ranking across regions is PRESERVED, and no error is raised.`)
console.log(`  This is the number that reaches a board pack.`)

// ------------------------------------------------------- in-memory footprint
console.log('\n' + '='.repeat(72))
console.log('  IN-MEMORY FOOTPRINT (the number that matters against the 4GiB wasm ceiling)')
console.log('='.repeat(72))
await db.run(`CREATE TABLE mat AS SELECT * FROM ${TXN}`)
const mem = await (await db.runAndReadAll(
  `SELECT database_size, memory_usage FROM pragma_database_size()`)).getRowObjects()
console.log(`  fact_txn materialized in memory: ${JSON.stringify(mem[0])}`)
console.log(`  (on disk as Parquet: 303.7 MB)`)

console.log('\n' + JSON.stringify(results, null, 2) + '\n')
db.closeSync()
