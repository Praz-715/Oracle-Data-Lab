// Building blocks for the self-contained HTML reports (benchmark run, database assessment).
// Same design tokens as the app (light + dark via prefers-color-scheme), no external assets,
// so a report can be archived, mailed or opened offline and prints cleanly.

export const DASH = '—'

export function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function num(v: number | null | undefined, digits = 0): string {
  if (v == null || Number.isNaN(Number(v))) return DASH
  return Number(v).toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 })
}

export function ms(v: number | null | undefined): string {
  if (v == null || Number.isNaN(Number(v))) return DASH
  const n = Number(v)
  if (n < 1) return `${(n * 1000).toFixed(0)} µs`
  if (n < 1000) return `${n.toFixed(n < 10 ? 2 : 1)} ms`
  return `${(n / 1000).toFixed(2)} s`
}

export function compact(v: number): string {
  return Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(v)
}

export function bytes(v: number | null | undefined): string {
  if (v == null || Number.isNaN(Number(v))) return DASH
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  let x = Math.abs(Number(v))
  let i = 0
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024
    i++
  }
  return `${x.toFixed(i ? 1 : 0)} ${units[i]}`
}

export function date(v: string | null | undefined): string {
  if (!v) return DASH
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v)
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function niceMax(v: number) {
  if (v <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  const m = v / p
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p
}

export interface ChartSpec {
  name: string
  color: string
  area: boolean
  points: { x: number; y: number }[]
  yFormat: (v: number) => string
  xFormat?: (v: number) => string
}

/** Single-series line chart as static SVG; CHART_SCRIPT adds the crosshair tooltip. */
export function lineChart(c: ChartSpec): string {
  const W = 640
  const H = 220
  const pad = { l: 58, r: 14, t: 12, b: 26 }
  if (!c.points.length) return `<p class="muted">No samples.</p>`
  const fx = c.xFormat ?? ((v: number) => `${num(v, 1)}s`)
  const xs = c.points.map((p) => p.x)
  const x0 = Math.min(...xs)
  const x1 = Math.max(...xs) === x0 ? x0 + 1 : Math.max(...xs)
  const y1 = niceMax(Math.max(...c.points.map((p) => p.y), 1e-9))
  const sx = (x: number) => pad.l + ((x - x0) / (x1 - x0)) * (W - pad.l - pad.r)
  const sy = (y: number) => pad.t + (1 - y / y1) * (H - pad.t - pad.b)

  const grid = Array.from({ length: 5 }, (_, i) => (y1 * i) / 4)
    .map((v) => `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${sy(v).toFixed(1)}" y2="${sy(v).toFixed(1)}"/><text class="tick" x="${pad.l - 8}" y="${(sy(v) + 4).toFixed(1)}" text-anchor="end">${esc(c.yFormat(v))}</text>`)
    .join('')
  const xt = Array.from({ length: 5 }, (_, i) => x0 + ((x1 - x0) * i) / 4)
    .map((v) => `<text class="tick" x="${sx(v).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(fx(v))}</text>`)
    .join('')
  const line = c.points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join('')
  const area = c.area && c.points.length > 1 ? `<path class="area" d="${line}L${sx(c.points.at(-1)!.x).toFixed(1)},${sy(0).toFixed(1)}L${sx(c.points[0]!.x).toFixed(1)},${sy(0).toFixed(1)}Z" fill="${c.color}"/>` : ''
  const data = c.points.map((p) => [Number(sx(p.x).toFixed(1)), Number(sy(p.y).toFixed(1)), fx(p.x), c.yFormat(p.y)])

  return `<div class="chart" data-points="${esc(JSON.stringify(data))}" data-name="${esc(c.name)}">
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(c.name)}">
    ${grid}${xt}${area}
    <path class="line" d="${line}" stroke="${c.color}"/>
    <line class="xhair" x1="0" x2="0" y1="${pad.t}" y2="${H - pad.b}" visibility="hidden"/>
    <circle class="dot" r="4" fill="${c.color}" visibility="hidden"/>
    <rect class="hit" x="${pad.l}" y="${pad.t}" width="${W - pad.l - pad.r}" height="${H - pad.t - pad.b}"/>
  </svg>
  <div class="tip" hidden></div>
</div>`
}

export function kpi(label: string, value: string, sub: string, tone?: 'info' | 'ok' | 'warn' | 'bad'): string {
  return `<div class="kpi${tone ? ` ${tone}` : ''}"><div class="kpi-label">${esc(label)}</div><div class="kpi-value">${esc(value)}</div><div class="kpi-sub">${esc(sub)}</div></div>`
}

export function table(head: string[], rows: string[][], numeric: number[] = [], empty = 'None captured.'): string {
  if (!rows.length) return `<p class="muted pad">${esc(empty)}</p>`
  const th = head.map((h, i) => `<th${numeric.includes(i) ? ' class="num"' : ''}>${esc(h)}</th>`).join('')
  const tb = rows.map((r) => `<tr>${r.map((c, i) => `<td class="${numeric.includes(i) ? 'num' : 'mono'}">${esc(c)}</td>`).join('')}</tr>`).join('')
  return `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`
}

export function card(title: string, body: string, opts: { flush?: boolean; id?: string } = {}): string {
  return `<section class="card"${opts.id ? ` id="${esc(opts.id)}"` : ''}><div class="card-head"><h2>${esc(title)}</h2></div>${opts.flush ? body : `<div class="card-body">${body}</div>`}</section>`
}

export function kv(pairs: [string, string][]): string {
  return `<dl>${pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`
}

const REPORT_CSS = `
:root {
  color-scheme: light;
  --font-sans: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  --font-mono: ui-monospace, 'Cascadia Code', 'SFMono-Regular', Menlo, Consolas, monospace;
  --bg: #f4f5f7; --bg-elev: #ffffff; --bg-sunken: #eceef2; --border: #dfe2e8;
  --text: #1b1f27; --text-2: #4a5160; --text-3: #7a8191;
  --ok: #1f8a4c; --ok-soft: #e3f4ea; --warn: #b26a00; --warn-soft: #fdf1dc; --bad: #c43a31; --bad-soft: #fbe6e4;
  --info: #2f6db3; --info-soft: #e4effa; --na: #6f7685; --na-soft: #eceef1;
  --chart-1: #2a78d6; --chart-2: #eb6834; --chart-grid: #e7e9ee;
  --shadow: 0 1px 2px rgb(16 24 40 / 6%), 0 1px 3px rgb(16 24 40 / 8%);
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --bg: #0f1218; --bg-elev: #171b23; --bg-sunken: #0b0e13; --border: #272d39;
    --text: #e6e9ef; --text-2: #aeb5c3; --text-3: #7c8495;
    --ok: #4cc283; --ok-soft: #13291e; --warn: #e5a442; --warn-soft: #2d2212; --bad: #f0746b; --bad-soft: #321716;
    --info: #6fa8e8; --info-soft: #14243a; --na: #8b93a3; --na-soft: #1d2129;
    --chart-1: #3987e5; --chart-2: #d95926; --chart-grid: #232935;
    --shadow: 0 1px 2px rgb(0 0 0 / 40%);
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 13px/1.5 var(--font-sans); }
main { max-width: 1280px; margin: 0 auto; padding: 24px 16px 40px; display: flex; flex-direction: column; gap: 14px; }
h1 { margin: 0; font-size: 18px; }
h2 { margin: 0; font-size: 13.5px; }
h3 { margin: 4px 0 8px; font-size: 15px; }
a { color: var(--info); }
.muted { color: var(--text-3); }
.pad { padding: 12px 14px; margin: 0; }
.mono { font-family: var(--font-mono); font-size: 12px; }
.head { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.head .meta { width: 100%; color: var(--text-3); font-size: 12px; }
.badge { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; border-radius: 999px; font-size: 12px; background: var(--ok-soft); color: var(--ok); white-space: nowrap; }
.badge.bad { background: var(--bad-soft); color: var(--bad); }
.badge.warn { background: var(--warn-soft); color: var(--warn); }
.badge.info { background: var(--info-soft); color: var(--info); }
.badge.na { background: var(--na-soft); color: var(--na); }
.badge::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.card { background: var(--bg-elev); border: 1px solid var(--border); border-radius: 8px; box-shadow: var(--shadow); min-width: 0; }
.card-head { padding: 10px 14px; border-bottom: 1px solid var(--border); }
.card-body { padding: 14px; }
.grid { display: grid; gap: 14px; }
.kpis { grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); }
.two { grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); }
.kpi { background: var(--bg-elev); border: 1px solid var(--border); border-top: 3px solid var(--border); border-radius: 8px; padding: 12px 14px; box-shadow: var(--shadow); min-width: 0; }
.kpi.info { border-top-color: var(--info); }
.kpi.ok { border-top-color: var(--ok); }
.kpi.warn { border-top-color: var(--warn); }
.kpi.bad { border-top-color: var(--bad); }
.kpi-label { font-size: 11.5px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-3); }
.kpi-value { font-size: 22px; font-weight: 650; margin: 2px 0; overflow-wrap: anywhere; }
.kpi-sub { font-size: 12px; color: var(--text-2); }
.chart { position: relative; }
.chart svg { display: block; width: 100%; height: auto; overflow: visible; }
.chart .grid { stroke: var(--chart-grid); stroke-width: 1; }
.chart .tick { fill: var(--text-3); font-size: 11px; }
.chart .line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.chart .area { opacity: .14; }
.chart .xhair { stroke: var(--text-3); stroke-dasharray: 3 3; }
.chart .dot { stroke: var(--bg-elev); stroke-width: 2; }
.chart .hit { fill: transparent; cursor: crosshair; }
.tip { position: absolute; pointer-events: none; background: var(--bg-elev); border: 1px solid var(--border); border-radius: 5px; box-shadow: var(--shadow); padding: 4px 8px; font-size: 12px; white-space: nowrap; transform: translate(-50%, -110%); }
.tip b { font-weight: 600; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 5px 14px; margin: 0; font-size: 12.5px; }
dt { color: var(--text-3); }
dd { margin: 0; overflow-wrap: anywhere; }
.table-wrap { max-height: 420px; overflow: auto; }
table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
th { position: sticky; top: 0; background: var(--bg-sunken); color: var(--text-2); font-weight: 600; text-align: left; padding: 7px 14px; white-space: nowrap; }
td { padding: 6px 14px; border-top: 1px solid var(--border); vertical-align: top; }
.num { text-align: right; font-variant-numeric: tabular-nums; font-family: var(--font-sans); }
pre { margin: 0; padding: 12px; background: var(--bg-sunken); border-radius: 5px; overflow: auto; font: 12px/1.45 var(--font-mono); max-height: 520px; }
pre, .mono { font-variant-ligatures: none; }
ul.errs { margin: 0; padding-left: 18px; font: 12px/1.5 var(--font-mono); }
.unavailable { padding: 12px 14px; color: var(--text-2); background: var(--na-soft); border-radius: 5px; margin: 12px 14px; }
.note { color: var(--text-3); font-size: 12px; padding: 8px 14px 12px; margin: 0; }
nav.toc { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 12.5px; }
footer { color: var(--text-3); font-size: 11.5px; text-align: center; }
@media print {
  body { background: #fff; }
  .card, .kpi { box-shadow: none; break-inside: avoid; }
  .table-wrap, pre { max-height: none; overflow: visible; }
  nav.toc { display: none; }
}
`

const CHART_SCRIPT = `
document.querySelectorAll('.chart').forEach(function (el) {
  var pts = JSON.parse(el.getAttribute('data-points') || '[]');
  var name = el.getAttribute('data-name');
  var svg = el.querySelector('svg'), hit = el.querySelector('.hit'), xh = el.querySelector('.xhair'), dot = el.querySelector('.dot'), tip = el.querySelector('.tip');
  if (!pts.length || !hit) return;
  function hide() { xh.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.hidden = true; }
  hit.addEventListener('mousemove', function (e) {
    var p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY;
    var x = p.matrixTransform(svg.getScreenCTM().inverse()).x, best = pts[0];
    for (var i = 1; i < pts.length; i++) if (Math.abs(pts[i][0] - x) < Math.abs(best[0] - x)) best = pts[i];
    xh.setAttribute('x1', best[0]); xh.setAttribute('x2', best[0]); xh.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', best[0]); dot.setAttribute('cy', best[1]); dot.setAttribute('visibility', 'visible');
    var k = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
    tip.textContent = ''; var b = document.createElement('b'); b.textContent = best[3];
    tip.append(best[2] + ' · ' + name + ' ', b);
    tip.style.left = best[0] * k + 'px'; tip.style.top = best[1] * k + 'px'; tip.hidden = false;
  });
  hit.addEventListener('mouseleave', hide);
});
`

/** Wraps report sections into a complete standalone HTML document. */
export function htmlDocument(title: string, body: string, footer: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<main>
${body}
  <footer>${esc(footer)}</footer>
</main>
<script>${CHART_SCRIPT}</script>
</body>
</html>
`
}
