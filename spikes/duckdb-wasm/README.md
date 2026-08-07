# Spike 1 — DuckDB-Wasm feasibility harness

Measures what the feasibility plan could only estimate. See the plan's
"Spike 1 — MEASURED RESULTS" section for findings.

## Run

```bash
npm install
node gen-data.mjs 1        # ~7s — generates 10M rows as 345 MB of Parquet in ./data
node probe-wasm-memory.mjs # reads MAXIMUM_MEMORY out of the .wasm binaries
node bench-native.mjs      # native DuckDB baseline + chasm-trap demonstration
npm run build              # bundles web/spike.js (duckdb-browser.mjs has a bare
                           # 'apache-arrow' import the browser cannot resolve)
node serve.mjs             # http://localhost:8099  (sets COOP/COEP)
```

Then click through steps 1–5 in the page. `?bundle=eh|coi|mvp` forces a build.

`gen-data.mjs 0.02` generates a 2% dataset for a fast loop.

## Findings that shape the code

- **Use the `eh` bundle, not `coi`.** The threaded build cannot load the parquet
  extension (shared-memory `LinkError`) and cannot register OPFS files
  (`FileSystemSyncAccessHandle` is not structured-cloneable). `eh` does both.
- **Never `db.open({path:'opfs://…'})`.** It breaks the statically-linked parquet
  extension. Use the default in-memory catalogue plus `registerOPFSFileName()`.
- **Pin the duckdb-wasm version.** The npm `latest` dist-tag points at a prerelease
  (`1.33.1-dev57.0`); last stable is `1.32.0`.
- Money is `DECIMAL(19,4)` end-to-end; no free-text column in the fact table.
- Parquet written sorted by `(date, company_key)`, ZSTD(3), `ROW_GROUP_SIZE 122880`,
  partitioned by fiscal year/period.

## Re-run in managed Chrome

All OPFS, quota and `persist()` numbers were taken in the Claude browser
(Chromium 148 / Electron), whose quota is ~2.7 GB rather than Chrome's ~60% of disk.
Re-run there before treating them as final.
