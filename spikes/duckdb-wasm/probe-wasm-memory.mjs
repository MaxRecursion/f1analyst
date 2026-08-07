// Answers the plan's biggest unverified question: what MAXIMUM_MEMORY is actually
// compiled into the pinned duckdb-wasm bundles?
//
// Reads it directly out of the WebAssembly binary rather than inferring it.
// Spec: the memory section (id 5) and memory imports carry `limits`:
//   flags byte  (bit0 = has max, bit1 = shared, bit2 = memory64)
//   min pages   (LEB128 u32)
//   max pages   (LEB128 u32, only if bit0)
// One page = 64 KiB.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const DIST = new URL('./node_modules/@duckdb/duckdb-wasm/dist/', import.meta.url).pathname
const PAGE = 65536

// Multiplier form, not bit-shift: section sizes in a 34MB module exceed what
// JS 32-bit bitwise ops handle, and `<<` silently wraps past shift 31.
function leb128(buf, i) {
  let result = 0, shift = 1, byte
  do { byte = buf[i++]; result += (byte & 0x7f) * shift; shift *= 128 } while (byte & 0x80)
  return [result, i]
}

function parseLimits(buf, i) {
  const flags = buf[i++]
  let min, max = null
  ;[min, i] = leb128(buf, i)
  if (flags & 0x01) [max, i] = leb128(buf, i)
  return [{ flags, min, max, shared: !!(flags & 0x02), memory64: !!(flags & 0x04) }, i]
}

function readString(buf, i) {
  let len; [len, i] = leb128(buf, i)
  return [buf.toString('utf8', i, i + len), i + len]
}

function inspect(file) {
  const buf = readFileSync(file)
  if (buf.readUInt32LE(0) !== 0x6d736100) throw new Error('not a wasm module')

  let i = 8
  const found = []

  while (i < buf.length) {
    const id = buf[i++]
    let size; [size, i] = leb128(buf, i)
    const end = i + size
    let p = i

    if (id === 5) {                                  // memory section (module-defined)
      let count; [count, p] = leb128(buf, p)
      for (let m = 0; m < count; m++) {
        let lim; [lim, p] = parseLimits(buf, p)
        found.push({ kind: 'defined', ...lim })
      }
    } else if (id === 2) {                           // import section
      let count; [count, p] = leb128(buf, p)
      for (let m = 0; m < count; m++) {
        let mod, name; [mod, p] = readString(buf, p); [name, p] = readString(buf, p)
        const kind = buf[p++]
        if (kind === 0x02) {                         // imported memory
          let lim; [lim, p] = parseLimits(buf, p)
          found.push({ kind: `imported (${mod}.${name})`, ...lim })
        } else if (kind === 0x00) {                  // function: type index
          let x; [x, p] = leb128(buf, p)
        } else if (kind === 0x01) {                  // table: reftype + limits
          p++; let lim; [lim, p] = parseLimits(buf, p)
        } else if (kind === 0x03) {                  // global: valtype + mutability
          p++; p++
        } else if (kind === 0x04) {                  // tag (exception handling):
          p++                                        //   attribute byte
          let x; [x, p] = leb128(buf, p)             //   type index
        } else {
          throw new Error(`unknown import kind 0x${kind.toString(16)} at ${p - 1}`)
        }
      }
    }
    i = end
  }
  return found
}

const gb = (bytes) => (bytes / 1024 ** 3).toFixed(2) + ' GiB'
const mb = (bytes) => (bytes / 1024 ** 2).toFixed(0) + ' MiB'

console.log('\nduckdb-wasm compiled memory limits — read from the .wasm binaries\n')
console.log('  ' + 'bundle'.padEnd(20) + 'initial'.padStart(12) + 'MAXIMUM'.padStart(14) + '   flags')
console.log('  ' + '-'.repeat(62))

for (const f of readdirSync(DIST).filter(f => f.endsWith('.wasm')).sort()) {
  try {
    for (const m of inspect(join(DIST, f))) {
      const tags = [m.shared && 'shared', m.memory64 && 'memory64', m.kind].filter(Boolean).join(', ')
      console.log('  ' + f.padEnd(20) +
        mb(m.min * PAGE).padStart(12) +
        (m.max === null ? 'unbounded' : gb(m.max * PAGE)).padStart(14) +
        '   ' + tags)
    }
  } catch (e) {
    console.log('  ' + f.padEnd(20) + '  ERROR: ' + e.message)
  }
}

console.log(`
  Interpretation:
    4.00 GiB  = the full wasm32 address space; DuckDB gets the whole budget.
    2.00 GiB  = the maintainer's "short of 2GB" answer still applies; the plan's
                DuckDB memory budget must be halved and memory governance tightens.
    shared    = the coi/threaded bundle; requires COOP/COEP + SharedArrayBuffer.
`)
