// Host-side helpers shared by all three arms: the responsiveness heartbeat and a
// dependency-free canvas chart.
//
// The heartbeat matters more than it looks. requestAnimationFrame can only fire when
// the browser is free to paint, so the gap between consecutive frames IS the measure of
// how long the application was frozen. A stopwatch inside .NET cannot see this: if the
// UI thread is blocked, the code doing the measuring is blocked too. That is precisely
// why an in-process engine on the UI thread looks fine on paper and terrible in the room.

let rafId = null
let lastFrame = 0
let longestBlockMs = 0
let droppedFrames = 0
let dotEl = null
let dotnetRef = null
let angle = 0
let lastReport = 0

const FRAME_BUDGET_MS = 1000 / 60

export function startHeartbeat(dotnet, dotElementId) {
  dotnetRef = dotnet
  dotEl = document.getElementById(dotElementId)
  lastFrame = performance.now()
  lastReport = lastFrame

  const tick = (now) => {
    const gap = now - lastFrame
    lastFrame = now

    // A gap far beyond one frame means the main thread was busy and could not paint.
    if (gap > FRAME_BUDGET_MS * 2) {
      longestBlockMs = Math.max(longestBlockMs, gap)
      droppedFrames += Math.round(gap / FRAME_BUDGET_MS) - 1
    }

    angle = (angle + gap * 0.36) % 360
    if (dotEl) dotEl.style.transform = `translateX(${(Math.sin(angle * Math.PI / 180) * 0.5 + 0.5) * 100}%)`

    // Report at ~4Hz. Marshalling to .NET on every frame would make the measurement
    // part of what is being measured.
    if (now - lastReport > 250) {
      lastReport = now
      dotnetRef?.invokeMethodAsync('ReportHeartbeat', longestBlockMs, droppedFrames)
    }

    rafId = requestAnimationFrame(tick)
  }
  rafId = requestAnimationFrame(tick)
}

export function resetHeartbeat() {
  longestBlockMs = 0
  droppedFrames = 0
  lastFrame = performance.now()
}

export function stopHeartbeat() {
  if (rafId !== null) cancelAnimationFrame(rafId)
  rafId = null
  dotnetRef = null
}

/**
 * Minimal canvas bar chart. Deliberately dependency-free: adding a charting library
 * would put its rendering cost inside the numbers being compared, and every arm must
 * paint through exactly the same code for the comparison to mean anything.
 */
export function drawChart(elementId, series) {
  const host = document.getElementById(elementId)
  if (!host) return

  let canvas = host.querySelector('canvas')
  if (!canvas) {
    canvas = document.createElement('canvas')
    host.appendChild(canvas)
  }

  const dpr = window.devicePixelRatio || 1
  const w = host.clientWidth || 800
  const h = host.clientHeight || 280
  canvas.width = w * dpr
  canvas.height = h * dpr
  canvas.style.width = `${w}px`
  canvas.style.height = `${h}px`

  const ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, w, h)

  const values = series.values ?? []
  if (!values.length) return

  const pad = { l: 64, r: 12, t: 14, b: 34 }
  const plotW = w - pad.l - pad.r
  const plotH = h - pad.t - pad.b
  const max = Math.max(...values)
  const min = Math.min(0, Math.min(...values))
  const range = (max - min) || 1

  const css = getComputedStyle(document.documentElement)
  const ink = css.getPropertyValue('--ink')?.trim() || '#1a1a1a'
  const accent = css.getPropertyValue('--accent')?.trim() || '#2f6f4f'
  const muted = css.getPropertyValue('--muted')?.trim() || '#8a8a8a'

  // axes
  ctx.strokeStyle = muted
  ctx.globalAlpha = 0.35
  ctx.beginPath()
  ctx.moveTo(pad.l, pad.t)
  ctx.lineTo(pad.l, pad.t + plotH)
  ctx.lineTo(pad.l + plotW, pad.t + plotH)
  ctx.stroke()
  ctx.globalAlpha = 1

  // gridlines + y labels
  ctx.fillStyle = muted
  ctx.font = '11px ui-monospace, Menlo, monospace'
  ctx.textAlign = 'right'
  for (let g = 0; g <= 4; g++) {
    const y = pad.t + plotH - (plotH * g / 4)
    const v = min + (range * g / 4)
    ctx.globalAlpha = 0.15
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + plotW, y); ctx.stroke()
    ctx.globalAlpha = 1
    ctx.fillText(abbreviate(v), pad.l - 8, y + 3)
  }

  // bars
  const bw = Math.max(1, plotW / values.length)
  ctx.fillStyle = accent
  for (let i = 0; i < values.length; i++) {
    const bh = ((values[i] - min) / range) * plotH
    ctx.fillRect(pad.l + i * bw, pad.t + plotH - bh, Math.max(1, bw - (bw > 3 ? 1 : 0)), bh)
  }

  // x labels — only as many as will fit legibly
  ctx.fillStyle = muted
  ctx.textAlign = 'center'
  const labels = series.labels ?? []
  const every = Math.max(1, Math.ceil(labels.length / Math.floor(plotW / 70)))
  for (let i = 0; i < labels.length; i += every) {
    ctx.fillText(String(labels[i] ?? '').slice(0, 10), pad.l + i * bw + bw / 2, pad.t + plotH + 16)
  }

  ctx.textAlign = 'left'
  ctx.fillStyle = ink
  ctx.fillText(series.name ?? '', pad.l, 10)
  if (series.downsampled) {
    ctx.fillStyle = muted
    ctx.fillText(`downsampled to ${values.length} points`, pad.l + 120, 10)
  }
}

function abbreviate(v) {
  const a = Math.abs(v)
  if (a >= 1e9) return (v / 1e9).toFixed(1) + 'B'
  if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M'
  if (a >= 1e3) return (v / 1e3).toFixed(0) + 'k'
  return v.toFixed(0)
}
