// Static server for the browser spike.
//
// Sets COOP/COEP so the page is cross-origin isolated — which is what unlocks
// SharedArrayBuffer and therefore duckdb-wasm's threaded `coi` bundle. The page
// reports crossOriginIsolated so you can see whether it actually took effect.

import { createServer } from 'node:http'
import { createReadStream, statSync, existsSync, readdirSync } from 'node:fs'
import { extname, join, normalize, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const PORT = Number(process.env.PORT ?? 8099)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.parquet': 'application/octet-stream',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
}

const MOUNTS = [
  ['/duckdb/', join(ROOT, 'node_modules/@duckdb/duckdb-wasm/dist/')],
  ['/data/', join(ROOT, 'data/')],
  ['/', join(ROOT, 'web/')],
]

const DATA = join(ROOT, 'data')
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const p = join(dir, e.name)
  return e.isDirectory() ? walk(p) : (p.endsWith('.parquet') ? [p] : [])
})

// Synthesized so the page knows what to pull into OPFS without hardcoding 76 paths.
function manifest() {
  const files = walk(DATA).map(p => {
    const rel = relative(DATA, p)
    return {
      path: '/data/' + rel.split(/[/\\]/).join('/'),
      // OPFS is flat here — encode the partition into the name.
      name: rel.split(/[/\\]/).join('__'),
      table: rel.split(/[/\\]/)[0].replace(/\.parquet$/, ''),
      bytes: statSync(p).size,
    }
  })
  return { files, totalBytes: files.reduce((a, f) => a + f.bytes, 0) }
}

createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0])
  let file = null

  if (url === '/manifest.json') {
    const body = JSON.stringify(manifest())
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cache-Control': 'no-store',
    })
    res.end(body)
    return
  }

  for (const [prefix, dir] of MOUNTS) {
    if (!url.startsWith(prefix)) continue
    const rel = normalize(url.slice(prefix.length)).replace(/^(\.\.[/\\])+/, '')
    const candidate = join(dir, rel === '' || rel === '.' ? 'index.html' : rel)
    if (!candidate.startsWith(dir)) continue           // path traversal guard
    if (existsSync(candidate) && statSync(candidate).isFile()) { file = candidate; break }
  }

  // Cross-origin isolation — the whole point of this server.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  res.setHeader('Cache-Control', 'no-store')

  if (!file) { res.writeHead(404); res.end('not found: ' + url); return }

  const size = statSync(file).size
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Content-Length': size,
  })
  createReadStream(file).pipe(res)
}).listen(PORT, () => {
  console.log(`\n  Spike harness:  http://localhost:${PORT}/`)
  console.log(`  COOP/COEP set — page should report crossOriginIsolated = true\n`)
})
