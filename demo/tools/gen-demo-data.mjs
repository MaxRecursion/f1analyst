// Demo dataset — 1,000,000 rows of heterogeneous business data.
//
// "Heterogeneous" matters for the demo: the three arms must be compared on data with
// realistic type variety, because type mix is what drives decode cost, Arrow width and
// render cost. This deliberately spans:
//   integers / surrogate keys      cheap, dictionary-friendly
//   DECIMAL(19,4) money            16 bytes per value in Arrow — the expensive one
//   dates and timestamps           delta-encode well when sorted
//   low-cardinality strings        dictionary-encoded, cheap
//   high-cardinality strings       the ones that hurt
//   booleans / small ints          bit-packed
//
// Emits three artifacts so the demo can show the format argument too:
//   demo.parquet        ZSTD, sorted, row groups tuned      <- what the app ships
//   demo.json           the naive baseline                  <- what "just fetch JSON" costs
//   manifest.json       sizes + row counts for the UI
//
// Usage: node gen-demo-data.mjs [rows]   (default 1_000_000)

import { DuckDBInstance } from '@duckdb/node-api'
import { mkdirSync, statSync, writeFileSync, existsSync } from 'node:fs'

const ROWS = Number(process.argv[2] ?? 1_000_000)
const OUT = new URL('../data/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })

const t0 = performance.now()
const db = await (await DuckDBInstance.create(':memory:')).connect()

const step = async (label, sql) => {
  const t = performance.now()
  await db.run(sql)
  console.log(`  ${label.padEnd(30)} ${((performance.now() - t) / 1000).toFixed(1)}s`)
}

console.log(`\nGenerating ${ROWS.toLocaleString()} heterogeneous rows\n`)
await db.run(`SELECT setseed(0.7)`)
await db.run(`SET preserve_insertion_order = false`)

// One wide, deliberately heterogeneous fact table. A single table keeps the demo
// legible on stage — the point being compared is engine topology, not schema design.
await step('build fact table', `
CREATE TABLE demo_fact AS
SELECT
  i                                                                  AS row_id,
  1 + CAST(random() * 49999 AS INTEGER)                              AS company_key,
  1 + CAST(random() *  9999 AS INTEGER)                              AS group_key,
  1 + CAST(random() * 99999 AS INTEGER)                              AS user_key,
  1 + CAST(random() *  4999 AS INTEGER)                              AS fund_key,

  d                                                                  AS txn_date,
  CAST(strftime(d, '%Y%m%d') AS INTEGER)                             AS date_key,
  CAST(strftime(d, '%Y%m') AS INTEGER)                               AS month_key,
  CAST(year(d) AS SMALLINT)                                          AS year_key,
  (d::TIMESTAMP + CAST(random() * 86399 AS INTEGER) * INTERVAL 1 SECOND) AS posted_at,

  -- low cardinality: dictionary-encoded, cheap, and what users group by
  ['FEE','REBATE','TRANSFER','SUBSCRIPTION','REDEMPTION','ADJUSTMENT','ACCRUAL','SETTLEMENT'][1 + CAST(random() * 7.99 AS INTEGER)] AS txn_type,
  ['POSTED','PENDING','REVERSED','PARKED','DRAFT'][1 + CAST(random() * 4.99 AS INTEGER)]  AS status,
  ['EUR','USD','GBP','CHF','INR','SGD'][1 + CAST(random() * 5.99 AS INTEGER)]             AS currency,
  ['EMEA','AMER','APAC','LATAM'][1 + CAST(random() * 3.99 AS INTEGER)]                    AS region,
  ['Banking','Insurance','Asset Mgmt','Corporate'][1 + CAST(random() * 3.99 AS INTEGER)]  AS sector,

  -- money: DECIMAL(19,4) end to end, never DOUBLE
  CAST(round(random() * 250000, 4) AS DECIMAL(19,4))                 AS amount,
  CAST(round(random() * 250000, 4) AS DECIMAL(19,4))                 AS amount_base,
  CAST(round(random() * 900, 4)    AS DECIMAL(19,4))                 AS fee,
  CAST(round(random() * 4500, 4)   AS DECIMAL(19,4))                 AS tax,
  CAST(round(0.8 + random() * 0.6, 6) AS DECIMAL(19,6))              AS fx_rate,

  -- high cardinality strings: the expensive kind, kept few on purpose
  'DOC' || lpad((i % 99999999)::VARCHAR, 10, '0')                    AS doc_number,
  'CTR-' || lpad((CAST(random() * 999999 AS INTEGER))::VARCHAR, 7, '0') AS contract_ref,

  CAST(random() < 0.35 AS BOOLEAN)                                   AS is_reconciled,
  CAST(random() < 0.08 AS BOOLEAN)                                   AS is_disputed,
  CAST(1 + random() * 4 AS TINYINT)                                  AS risk_rating
FROM (
  SELECT i, (DATE '2023-08-01' + CAST(random() * 1094 AS INTEGER) * INTERVAL 1 DAY)::DATE AS d
  FROM generate_series(1, ${ROWS}) t(i)
)`)

await step('write demo.parquet', `
  COPY (SELECT * FROM demo_fact ORDER BY txn_date, company_key)
  TO '${OUT}demo.parquet'
  (FORMAT parquet, COMPRESSION zstd, COMPRESSION_LEVEL 3,
   ROW_GROUP_SIZE 122880, PARQUET_VERSION V2)`)

// The naive baseline the demo contrasts against. Capped — a full 1M-row JSON is
// ~700MB and nobody needs to wait for that on stage to make the point.
const JSON_ROWS = Math.min(ROWS, 200_000)
await step(`write demo.json (${JSON_ROWS.toLocaleString()} rows)`, `
  COPY (SELECT * FROM demo_fact ORDER BY txn_date, company_key LIMIT ${JSON_ROWS})
  TO '${OUT}demo.json' (FORMAT json, ARRAY true)`)

const size = (f) => (existsSync(OUT + f) ? statSync(OUT + f).size : 0)
const mb = (b) => (b / 1024 ** 2).toFixed(1)

const manifest = {
  rows: ROWS,
  generatedBy: 'gen-demo-data.mjs',
  columns: 25,
  files: {
    parquet: { name: 'demo.parquet', bytes: size('demo.parquet') },
    json: { name: 'demo.json', bytes: size('demo.json'), rows: JSON_ROWS },
  },
  // Extrapolated so the demo can state the honest full-size JSON number
  jsonFullEquivalentBytes: Math.round(size('demo.json') * (ROWS / JSON_ROWS)),
}
writeFileSync(OUT + 'manifest.json', JSON.stringify(manifest, null, 2))

console.log(`
${'='.repeat(62)}
  ARTIFACTS
${'='.repeat(62)}
  demo.parquet        ${mb(manifest.files.parquet.bytes).padStart(8)} MB   ${ROWS.toLocaleString()} rows
  demo.json           ${mb(manifest.files.json.bytes).padStart(8)} MB   ${JSON_ROWS.toLocaleString()} rows
  json @ full size    ${mb(manifest.jsonFullEquivalentBytes).padStart(8)} MB   (extrapolated)

  Parquet is ${(manifest.jsonFullEquivalentBytes / manifest.files.parquet.bytes).toFixed(0)}x smaller than equivalent JSON.

  Done in ${((performance.now() - t0) / 1000).toFixed(1)}s
`)

db.closeSync()
