// Spike 1/4 — generate a realistic synthetic dataset matching the F1Analyst schema shape
// and write it as Parquet using the exact settings prescribed in the plan.
//
// Usage:  node gen-data.mjs [scale]
//         scale 1.0 = full size (8M transactions). Use 0.05 for a fast smoke run.

import { DuckDBInstance } from '@duckdb/node-api'
import { mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SCALE = Number(process.argv[2] ?? 1)
const OUT = new URL('./data/', import.meta.url).pathname

const N_TXN = Math.round(8_000_000 * SCALE)
const N_DIST = Math.round(1_500_000 * SCALE)
const N_COMPANY = Math.round(50_000 * SCALE)
const N_GROUP = Math.round(10_000 * SCALE)
const N_USER = Math.round(100_000 * SCALE)

// 3 years of history, so ~36 monthly partitions on the fact tables.
const START = '2023-09-01'
const DAYS = 1095

mkdirSync(OUT, { recursive: true })

const t0 = performance.now()
const instance = await DuckDBInstance.create(':memory:')
const db = await instance.connect()

const run = async (sql) => { await db.run(sql) }
const step = async (label, sql) => {
  const t = performance.now()
  await run(sql)
  console.log(`  ${label.padEnd(34)} ${((performance.now() - t) / 1000).toFixed(1)}s`)
}

console.log(`\nGenerating at scale ${SCALE} — ${N_TXN.toLocaleString()} transactions\n`)

await run(`SELECT setseed(0.42)`)
await run(`SET preserve_insertion_order = false`)

// ---------------------------------------------------------------- dimensions

await step('dim_date', `
CREATE TABLE dim_date AS
SELECT
  CAST(strftime(d, '%Y%m%d') AS INTEGER)                        AS date_key,
  d                                                             AS date,
  CAST(strftime(d, '%Y%m') AS INTEGER)                          AS month_key,
  CAST(year(d) * 10 + quarter(d) AS INTEGER)                    AS quarter_key,
  CAST(year(d) AS INTEGER)                                      AS year_key,
  CAST(strftime(d, '%G%V') AS INTEGER)                          AS iso_week_key,
  -- fiscal year starts in October
  CAST(year(d) + CASE WHEN month(d) >= 10 THEN 1 ELSE 0 END AS SMALLINT) AS fiscal_year,
  CAST(((month(d) + 2) % 12) / 3 + 1 AS TINYINT)                AS fiscal_quarter,
  CAST(((month(d) + 2) % 12) + 1 AS TINYINT)                    AS fiscal_period,
  CAST(strftime(d - INTERVAL 1 YEAR, '%Y%m') AS INTEGER)        AS prior_year_month_key,
  CAST(strftime(d - INTERVAL 1 MONTH, '%Y%m') AS INTEGER)       AS prior_period_key,
  (d + INTERVAL 1 DAY)::DATE <> (date_trunc('month', d) + INTERVAL 1 MONTH)::DATE AS is_period_end
FROM (SELECT UNNEST(generate_series(DATE '2015-01-01', DATE '2030-12-31', INTERVAL 1 DAY))::DATE AS d)`)

// Parent/child hierarchy: company -> subcompany -> group, deliberately ragged
// so the level-flattening and nested-set work has something real to chew on.
await step('dim_group (hierarchy)', `
CREATE TABLE dim_group AS
WITH raw AS (
  SELECT
    i AS group_key,
    CASE
      WHEN i <= 40                       THEN NULL              -- 40 roots (companies)
      WHEN i <= 800                      THEN 1 + (i % 40)      -- subcompanies
      ELSE 41 + (i % 760)                                       -- groups
    END AS parent_key,
    i AS seq
  FROM generate_series(1, ${N_GROUP}) t(i)
)
SELECT
  group_key,
  parent_key,
  'GRP-' || lpad(group_key::VARCHAR, 6, '0')                    AS group_code,
  'Group ' || group_key                                          AS group_name,
  CASE WHEN parent_key IS NULL THEN 0
       WHEN group_key <= 800 THEN 1 ELSE 2 END                   AS depth,
  ['EMEA','AMER','APAC','LATAM'][1 + (seq % 4)]                  AS region,
  ['DE','FR','GB','US','IN','SG'][1 + (seq % 6)]                 AS country,
  ['Active','Dormant','Closed'][1 + (seq % 3)]                   AS status,
  (DATE '2010-01-01' + INTERVAL (seq % 4000) DAY)::DATE          AS valid_from,
  CAST(1 + (seq % 9) AS TINYINT)                                 AS segment_id
FROM raw`)

await step('dim_company', `
CREATE TABLE dim_company AS
SELECT
  i                                                              AS company_key,
  'CMP-' || lpad(i::VARCHAR, 8, '0')                             AS company_code,
  'Company ' || i                                                AS company_name,
  'Legal Entity Name ' || i                                      AS legal_name,
  1 + (i % ${N_GROUP})                                           AS group_key,
  ['EMEA','AMER','APAC','LATAM'][1 + (i % 4)]                    AS region,
  ['DE','FR','GB','US','IN','SG'][1 + (i % 6)]                   AS country,
  ['Banking','Insurance','Asset Mgmt','Corporate'][1 + (i % 4)]  AS sector,
  ['Active','Dormant','Closed'][1 + (i % 3)]                     AS status,
  CAST(1990 + (i % 35) AS SMALLINT)                              AS founded_year,
  ['EUR','USD','GBP','CHF','INR','SGD'][1 + (i % 6)]             AS currency,
  'TAX' || lpad((i * 7 % 99999999)::VARCHAR, 9, '0')             AS tax_id,
  'LEI' || lpad((i * 13 % 999999)::VARCHAR, 12, '0')             AS lei_code,
  (DATE '2005-01-01' + INTERVAL (i % 7000) DAY)::DATE            AS onboarded_date,
  CAST(1 + (i % 5) AS TINYINT)                                   AS risk_rating,
  CAST(1 + (i % 12) AS TINYINT)                                  AS reporting_unit,
  CAST((i % 100) / 100.0 AS DECIMAL(9,4))                        AS ownership_pct,
  'City ' || (i % 400)                                           AS city,
  'Street ' || (i % 900)                                         AS address_line1,
  lpad((i % 99999)::VARCHAR, 5, '0')                             AS postal_code,
  'contact' || i || '@example.invalid'                           AS contact_email,
  CAST((i % 2 = 0) AS BOOLEAN)                                   AS is_consolidated,
  CAST((i % 7 = 0) AS BOOLEAN)                                   AS is_regulated,
  CAST(1 + (i % 4) AS TINYINT)                                   AS tier,
  (DATE '2024-01-01' + INTERVAL (i % 600) DAY)::DATE             AS last_review_date
FROM generate_series(1, ${N_COMPANY}) t(i)`)

await step('dim_user', `
CREATE TABLE dim_user AS
SELECT
  i                                                              AS user_key,
  'USR' || lpad(i::VARCHAR, 8, '0')                              AS user_id,
  'User ' || i                                                   AS display_name,
  'user' || i || '@example.invalid'                              AS email,
  1 + (i % ${N_COMPANY})                                         AS company_key,
  ['Finance','Ops','Risk','Treasury','Audit'][1 + (i % 5)]       AS department,
  ['Analyst','Manager','Director','VP'][1 + (i % 4)]             AS job_level,
  ['EMEA','AMER','APAC','LATAM'][1 + (i % 4)]                    AS region,
  ['DE','FR','GB','US','IN','SG'][1 + (i % 6)]                   AS country,
  ['Active','Suspended','Left'][1 + (i % 3)]                     AS status,
  (DATE '2015-01-01' + INTERVAL (i % 3800) DAY)::DATE            AS joined_date,
  CAST(1 + (i % 9) AS TINYINT)                                   AS cost_centre,
  CAST((i % 3 = 0) AS BOOLEAN)                                   AS is_approver,
  CAST(1 + (i % 6) AS TINYINT)                                   AS approval_limit_tier,
  (DATE '2026-01-01' + INTERVAL (i % 200) DAY)::DATE             AS last_login_date
FROM generate_series(1, ${N_USER}) t(i)`)

// ---------------------------------------------------------------- fact tables
// NOTE: money is DECIMAL(19,4) end-to-end, per the plan's adjudication.
// NOTE: no wide free-text column — the plan calls that out as a ~112MB trap.

await step('fact_txn', `
CREATE TABLE fact_txn AS
SELECT
  i                                                              AS txn_id,
  1 + CAST(random() * ${N_COMPANY - 1} AS INTEGER)               AS company_key,
  1 + CAST(random() * ${N_GROUP - 1} AS INTEGER)                 AS group_key,
  1 + CAST(random() * ${N_USER - 1} AS INTEGER)                  AS user_key,
  d                                                              AS txn_date,
  CAST(strftime(d, '%Y%m%d') AS INTEGER)                         AS date_key,
  (d + (1 + CAST(random() * 5 AS INTEGER)) * INTERVAL 1 DAY)::DATE AS posting_date,
  ['FEE','REBATE','TRANSFER','SUBSCRIPTION','REDEMPTION','ADJUSTMENT','ACCRUAL','SETTLEMENT'][1 + CAST(random() * 7.99 AS INTEGER)] AS txn_type,
  ['POSTED','PENDING','REVERSED','PARKED','DRAFT'][1 + CAST(random() * 4.99 AS INTEGER)] AS status,
  ['EUR','USD','GBP','CHF','INR','SGD'][1 + CAST(random() * 5.99 AS INTEGER)] AS currency,
  CAST(round(random() * 250000, 4) AS DECIMAL(19,4))             AS amount,
  CAST(round(random() * 250000, 4) AS DECIMAL(19,4))             AS amount_base,
  CAST(round(random() * 900, 4) AS DECIMAL(19,4))                AS fee,
  CAST(round(random() * 4500, 4) AS DECIMAL(19,4))               AS tax,
  CAST(round(random() * 250000, 4) AS DECIMAL(19,4))             AS net_amount,
  CAST(round(0.8 + random() * 0.6, 6) AS DECIMAL(19,6))          AS fx_rate,
  'DOC' || lpad((i % 99999999)::VARCHAR, 10, '0')                AS doc_number,
  CAST(year(d) + CASE WHEN month(d) >= 10 THEN 1 ELSE 0 END AS SMALLINT) AS fiscal_year,
  CAST(((month(d) + 2) % 12) + 1 AS TINYINT)                     AS fiscal_period,
  ['S4H','ECC','BW','LEGACY'][1 + CAST(random() * 3.99 AS INTEGER)] AS source_system
FROM (
  SELECT i, (DATE '${START}' + CAST(random() * ${DAYS - 1} AS INTEGER) * INTERVAL 1 DAY)::DATE AS d
  FROM generate_series(1, ${N_TXN}) t(i)
)`)

await step('fact_fund_dist', `
CREATE TABLE fact_fund_dist AS
SELECT
  i                                                              AS dist_id,
  1 + CAST(random() * 4999 AS INTEGER)                           AS fund_key,
  1 + CAST(random() * ${N_COMPANY - 1} AS INTEGER)               AS company_key,
  1 + CAST(random() * ${N_GROUP - 1} AS INTEGER)                 AS group_key,
  d                                                              AS value_date,
  CAST(strftime(d, '%Y%m%d') AS INTEGER)                         AS date_key,
  ['DIVIDEND','INTEREST','CAPITAL','RETURN','SPECIAL'][1 + CAST(random() * 4.99 AS INTEGER)] AS dist_type,
  ['SETTLED','ANNOUNCED','CANCELLED'][1 + CAST(random() * 2.99 AS INTEGER)] AS status,
  ['EUR','USD','GBP','CHF','INR','SGD'][1 + CAST(random() * 5.99 AS INTEGER)] AS currency,
  CAST(round(random() * 900000, 4) AS DECIMAL(19,4))             AS amount,
  CAST(round(random() * 900000, 4) AS DECIMAL(19,4))             AS amount_base,
  CAST(round(random() * 100000, 6) AS DECIMAL(19,6))             AS units,
  CAST(round(1 + random() * 400, 6) AS DECIMAL(19,6))            AS nav,
  CAST(year(d) + CASE WHEN month(d) >= 10 THEN 1 ELSE 0 END AS SMALLINT) AS fiscal_year,
  CAST(((month(d) + 2) % 12) + 1 AS TINYINT)                     AS fiscal_period
FROM (
  SELECT i, (DATE '${START}' + CAST(random() * ${DAYS - 1} AS INTEGER) * INTERVAL 1 DAY)::DATE AS d
  FROM generate_series(1, ${N_DIST}) t(i)
)`)

// ---------------------------------------------------------------- write Parquet
// Exact settings from the plan: ZSTD(3), ROW_GROUP_SIZE 122880,
// sorted by (date, company_key) so zone maps are selective and dates delta-encode.

const writeFact = async (table, dateCol) => {
  await step(`write ${table} (partitioned)`, `
    COPY (SELECT * FROM ${table} ORDER BY ${dateCol}, company_key)
    TO '${join(OUT, table)}'
    (FORMAT parquet, COMPRESSION zstd, COMPRESSION_LEVEL 3,
     ROW_GROUP_SIZE 122880, PARQUET_VERSION V2,
     PARTITION_BY (fiscal_year, fiscal_period), OVERWRITE_OR_IGNORE)`)
}

const writeDim = async (table) => {
  await step(`write ${table}`, `
    COPY (SELECT * FROM ${table})
    TO '${join(OUT, table + '.parquet')}'
    (FORMAT parquet, COMPRESSION zstd, COMPRESSION_LEVEL 3,
     ROW_GROUP_SIZE 122880, PARQUET_VERSION V2)`)
}

await writeFact('fact_txn', 'txn_date')
await writeFact('fact_fund_dist', 'value_date')
for (const d of ['dim_company', 'dim_group', 'dim_user', 'dim_date']) await writeDim(d)

// ---------------------------------------------------------------- report

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const p = join(dir, e.name)
  return e.isDirectory() ? walk(p) : [{ path: p, size: statSync(p).size }]
})

const files = walk(OUT)
const byTable = new Map()
for (const f of files) {
  const rel = f.path.slice(OUT.length)
  const table = rel.split('/')[0].replace(/\.parquet$/, '')
  const e = byTable.get(table) ?? { n: 0, bytes: 0 }
  e.n++; e.bytes += f.size
  byTable.set(table, e)
}

const mb = (b) => (b / 1024 / 1024).toFixed(1).padStart(8) + ' MB'
console.log('\n' + '='.repeat(58))
console.log('  ON-DISK PARQUET (ZSTD level 3)')
console.log('='.repeat(58))
let total = 0, totalFiles = 0
for (const [t, e] of [...byTable].sort((a, b) => b[1].bytes - a[1].bytes)) {
  console.log(`  ${t.padEnd(20)} ${mb(e.bytes)}   ${String(e.n).padStart(4)} files`)
  total += e.bytes; totalFiles += e.n
}
console.log('  ' + '-'.repeat(52))
console.log(`  ${'TOTAL'.padEnd(20)} ${mb(total)}   ${String(totalFiles).padStart(4)} files`)

// Arrow in-memory footprint is the number that actually matters against the 4GiB ceiling.
const arrow = await db.runAndReadAll(`
  SELECT SUM(estimated_size) AS bytes FROM (
    SELECT estimated_size FROM duckdb_tables() WHERE database_name = 'memory'
  )`)
console.log(`\n  Plan predicted ~399 MB Parquet / ~1.63 GB Arrow at full scale.`)
console.log(`  Scale factor here: ${SCALE}`)
console.log(`\n  Done in ${((performance.now() - t0) / 1000).toFixed(1)}s\n`)

db.closeSync()
