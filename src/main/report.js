// Shareable interactive report generator.
//
// Produces ONE self-contained HTML file — no CDN, no external assets — that a
// visitor can open anywhere. It embeds the current snapshot data as JSON and
// renders interactive SVG charts with vanilla JS: crosshair tooltips, sortable
// session tables, session flyouts with cumulative burn timelines, multi-select
// session comparison overlays, and model head-to-head views.
//
// Visual system: committed dark look, series colors CVD-validated against the
// surface (#10141c): claude #cf6a45 · codex #159d74 · chatgpt #9080e8, compare
// slots #3987e5/#d95926/#199e70/#c98500. Marks: 2px lines, ≤20px bars with 4px
// rounded data-ends, hairline grid, legends for ≥2 series, values in text ink.

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

export function buildReportHtml({ snapshots, range, generatedAt = Date.now(), title = 'FrankToken Usage Report', showWithoutCache = false }) {
  const data = {
    generatedAt,
    // Mirrors the app's Settings toggle: when off the report never mentions
    // the no-cache counterfactual, so a shared file matches what the exporter
    // was looking at.
    showWithoutCache: !!showWithoutCache,
    range: {
      from: range?.resolved?.from ?? null,
      to: range?.resolved?.to ?? null,
      label: range?.spec?.preset && range.spec.preset !== 'custom' ? range.spec.preset.toUpperCase() : 'custom'
    },
    providers: (snapshots || []).map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color,
      available: s.available,
      error: s.error || null,
      windows: s.windows || [],
      windowsNote: s.windowsNote || null,
      // Account-wide burn rate / projection / trend. For a machine whose local
      // transcripts are empty this is the only substantive data in the report,
      // so exporting without it made the shared view far thinner than the app.
      limitStats: s.limitStats || {},
      limitSamples: s.limitSamples || 0,
      tokens: s.tokens,
      cost: s.cost,
      noCache: s.noCache || null,
      series: s.series,
      sessions: s.sessions || [],
      byModel: s.byModel || {},
      meta: s.meta || {}
    }))
  }
  const json = JSON.stringify(data).replace(/</g, '\\u003c')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root {
    --bg: #0b0d12; --surface: #10141c; --card: #161b25; --card2: #1b2230;
    --border: #232b39; --ink: #e7ecf3; --ink-2: #93a0b4; --ink-3: #5e6b7e;
    --accent: #6ea8fe; --good: #34d399; --warn: #fbbf24; --bad: #f87171;
    --grid: #1b2230;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    background: radial-gradient(1200px 500px at 100% -10%, rgba(110,168,254,.10), transparent 60%),
                radial-gradient(900px 400px at -10% 110%, rgba(207,106,69,.10), transparent 55%),
                var(--bg);
    color: var(--ink);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 14px; line-height: 1.45; padding: 28px clamp(14px, 4vw, 48px) 60px;
  }
  h1 { font-size: 24px; margin: 0; letter-spacing: -.4px; }
  h2 { font-size: 15px; margin: 0 0 10px; }
  h3 { margin: 0 0 6px; font-size: 11px; font-weight: 600; color: var(--ink-2); letter-spacing: .4px; text-transform: uppercase; }
  .sub { font-size: 12px; color: var(--ink-3); }
  .head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 12px; margin-bottom: 6px; }
  .mark { display:inline-block; width: 20px; height: 20px; border-radius: 6px; vertical-align: -3px; margin-right: 8px;
          background: conic-gradient(from 200deg, #159d74, #6ea8fe, #cf6a45, #159d74); }
  .pill { font-size: 11px; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--border); color: var(--ink-2); background: var(--card); white-space: nowrap; }
  .pill.est { color: var(--warn); border-color: rgba(251,191,36,.3); }
  .pill.live { color: var(--good); border-color: rgba(52,211,153,.3); }
  .tabs { display: flex; gap: 6px; margin: 22px 0 16px; flex-wrap: wrap; }
  .tab { background: var(--card); border: 1px solid var(--border); color: var(--ink-2); font: inherit; font-size: 12px;
         font-weight: 700; padding: 7px 16px; border-radius: 999px; cursor: pointer; }
  .tab:hover { color: var(--ink); }
  .tab.on { color: #0b0d12; background: var(--accent); border-color: var(--accent); }
  .grid { display: grid; gap: 14px; }
  .cols-2 { grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
  .kpirow { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); margin-bottom: 14px; }
  .card { background: linear-gradient(180deg, var(--card), var(--card2)); border: 1px solid var(--border); border-radius: 16px; padding: 16px; }
  .tile .v { font-size: 26px; font-weight: 800; letter-spacing: -.5px; margin-top: 2px; }
  .tile .d { font-size: 11px; color: var(--ink-3); margin-top: 2px; }
  .hero { font-size: 52px; font-weight: 800; letter-spacing: -1.5px; line-height: 1.05; }
  .legendrow { display: flex; gap: 14px; flex-wrap: wrap; font-size: 11px; color: var(--ink-2); margin-top: 8px; }
  .key { display: inline-flex; align-items: center; gap: 6px; }
  .dotkey { display: inline-block; width: 9px; height: 9px; border-radius: 3px; }
  .linekey { display: inline-block; width: 14px; height: 2px; border-radius: 2px; vertical-align: 3px; }
  .meter { margin: 10px 0; }
  .wspark { width: 100%; height: 30px; display: block; margin-top: 6px; }
  .meter .row { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 5px; }
  .meter .row .name { color: var(--ink-2); }
  .meter .row .val { font-weight: 700; font-variant-numeric: tabular-nums; }
  .track { height: 9px; border-radius: 999px; background: #0e131b; border: 1px solid var(--border); overflow: hidden; }
  .fill { height: 100%; border-radius: 999px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .4px; color: var(--ink-3);
       padding: 9px 10px; border-bottom: 1px solid var(--border); cursor: pointer; user-select: none; white-space: nowrap;
       position: sticky; top: 0; background: var(--card); z-index: 1; }
  th.sorted { color: var(--accent); }
  td { padding: 8px 10px; border-bottom: 1px solid rgba(35,43,57,.55); color: var(--ink-2); white-space: nowrap; }
  td.strong { color: var(--ink); font-weight: 700; font-variant-numeric: tabular-nums; }
  tbody tr { cursor: pointer; }
  tbody tr:hover { background: rgba(255,255,255,.03); }
  .tablewrap { max-height: 480px; overflow: auto; border-radius: 12px; }
  .filterrow { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
  .chip { display: inline-flex; align-items: center; gap: 6px; background: var(--card); border: 1px solid var(--border);
          color: var(--ink-2); font: inherit; font-size: 11px; font-weight: 600; padding: 5px 10px; border-radius: 999px; cursor: pointer; }
  .chip.on { color: var(--accent); border-color: var(--accent); background: rgba(110,168,254,.08); }
  .search { margin-left: auto; background: var(--card); border: 1px solid var(--border); color: var(--ink);
            border-radius: 999px; padding: 6px 12px; font: inherit; font-size: 12px; min-width: 170px; outline: none; }
  .scrim { position: fixed; inset: 0; background: rgba(4,6,10,.6); z-index: 90; }
  .flyout { position: fixed; top: 0; right: 0; bottom: 0; width: min(500px, 94vw); z-index: 100; background: #121722;
            border-left: 1px solid var(--border); padding: 18px; overflow-y: auto; box-shadow: 0 18px 50px rgba(0,0,0,.55); }
  .overlay { position: fixed; inset: 4vh 5vw; z-index: 100; overflow-y: auto; background: #121722;
             border: 1px solid var(--border); border-radius: 16px; padding: 20px; box-shadow: 0 18px 50px rgba(0,0,0,.55); }
  .fly-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; margin-bottom: 12px; }
  .fly-title { font-size: 16px; font-weight: 800; }
  .x { background: var(--card); border: 1px solid var(--border); color: var(--ink-2); width: 30px; height: 30px;
       border-radius: 9px; cursor: pointer; font: inherit; }
  .kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 10px 0; }
  .kpi { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 9px 12px; }
  .kpi .k { font-size: 10px; color: var(--ink-3); }
  .kpi .v { font-size: 14px; font-weight: 700; margin-top: 2px; }
  .comparebar { position: sticky; bottom: 10px; display: none; align-items: center; gap: 12px; z-index: 40;
                background: #121722; border: 1px solid var(--accent); border-radius: 12px; padding: 9px 14px; font-size: 12px; }
  .btn { background: var(--accent); color: #0b0d12; border: none; font: inherit; font-weight: 700; padding: 7px 14px; border-radius: 8px; cursor: pointer; }
  .tooltip { position: fixed; z-index: 200; pointer-events: none; background: #0e131b; border: 1px solid var(--border);
             border-radius: 10px; padding: 8px 11px; font-size: 12px; display: none; max-width: 320px; }
  .tooltip .tl { color: var(--ink-2); font-size: 11px; margin-bottom: 4px; }
  .tooltip .tr { display: flex; align-items: center; gap: 7px; margin-top: 2px; }
  .tooltip .tv { font-weight: 700; color: var(--ink); margin-left: auto; font-variant-numeric: tabular-nums; }
  svg text { font-family: inherit; }
  .foot { margin-top: 34px; font-size: 11px; color: var(--ink-3); border-top: 1px solid var(--border); padding-top: 12px;
          display: flex; gap: 16px; flex-wrap: wrap; }
  @media (max-width: 700px) { .kpis { grid-template-columns: 1fr 1fr; } }
</style>
</head>
<body>
<div class="head">
  <h1><span class="mark"></span>FrankToken — AI Token Consumption</h1>
  <span class="pill" id="range-pill"></span>
  <span class="pill" id="generated-pill"></span>
</div>
<div class="sub">Tokens, sessions, models, and USD cost across Claude (all surfaces), OpenAI Codex, and ChatGPT. Click any session for its flyout; pick sessions to compare; hover any chart.</div>

<div class="tabs" id="tabs"></div>
<div id="view"></div>

<div class="comparebar" id="comparebar">
  <span id="comparecount"></span>
  <button class="btn" id="comparego">Compare</button>
  <button class="chip" id="compareclear">Clear</button>
</div>
<div class="tooltip" id="tooltip"></div>
<div id="modal"></div>

<div class="foot">
  <span><b>Costs are USD estimates</b> from list prices — guidance, not billing.</span>
  <span>Claude rate-limit windows are account-wide (every surface &amp; device); session detail comes from the machine that exported this report.</span>
  <span>Generated by FrankToken.</span>
</div>

<script id="data" type="application/json">${json}</script>
<script>
'use strict';
const DATA = JSON.parse(document.getElementById('data').textContent);
const CMP = ['#3987e5', '#d95926', '#199e70', '#c98500'];
const $ = (sel, el) => (el || document).querySelector(sel);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const fmtTok = (n) => n == null ? '—' : n >= 1e9 ? (n/1e9).toFixed(2)+'B' : n >= 1e6 ? (n/1e6).toFixed(2)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'K' : String(Math.round(n));
const fmtUsd = (n) => n == null ? '—' : '$' + (n >= 1000 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(3));
const fmtDur = (ms) => { if (ms == null) return '—'; const s = Math.round(ms/1000); if (s < 60) return s+'s';
  const m = Math.floor(s/60); if (m < 60) return m+'m '+(s%60)+'s'; const h = Math.floor(m/60);
  return h < 24 ? h+'h '+(m%60)+'m' : Math.floor(h/24)+'d '+(h%24)+'h'; };
const fmtTime = (ms) => ms ? new Date(ms).toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '—';
const SVGNS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs) => { const n = document.createElementNS(SVGNS, tag); for (const k in attrs || {}) n.setAttribute(k, attrs[k]); return n; };

// ---------- tooltip ----------
const tip = $('#tooltip');
function showTip(x, y, label, rows) {
  tip.replaceChildren();
  if (label) tip.appendChild(el('div', 'tl', label));
  for (const r of rows) {
    const row = el('div', 'tr');
    const key = el('span', 'linekey'); key.style.background = r.color; key.style.width = '14px'; key.style.height = '2px'; key.style.display = 'inline-block';
    row.appendChild(key);
    row.appendChild(el('span', null, r.name));
    row.appendChild(el('span', 'tv', r.value));
    tip.appendChild(row);
  }
  tip.style.display = 'block';
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = Math.min(x + 14, innerWidth - w - 10) + 'px';
  tip.style.top = Math.min(y + 14, innerHeight - h - 10) + 'px';
}
const hideTip = () => { tip.style.display = 'none'; };

// ---------- charts (SVG) ----------
// Multi-series step-free line/area over shared x buckets, crosshair + tooltip.
// series: [{name, color, points: Map(xKey -> value)}], xKeys sorted array.
function lineChart(container, xKeys, series, { height = 230, area = false, fmt = fmtTok, xLabel = (k) => k } = {}) {
  if (!xKeys.length) { container.appendChild(el('div', 'sub', 'No data in range.')); return; }
  const render = () => {
    container.replaceChildren();
    const width = container.clientWidth || 640;
    const pad = { l: 48, r: 14, t: 12, b: 24 };
    const iw = width - pad.l - pad.r, ih = height - pad.t - pad.b;
    const max = Math.max(1, ...series.flatMap((s) => xKeys.map((k) => s.points.get(k) || 0)));
    const X = (i) => pad.l + (xKeys.length === 1 ? iw / 2 : (i / (xKeys.length - 1)) * iw);
    const Y = (v) => pad.t + ih - (v / max) * ih;
    const svg = svgEl('svg', { width, height, viewBox: '0 0 ' + width + ' ' + height });
    for (let g = 0; g <= 4; g++) {
      const y = pad.t + (ih * g) / 4;
      svg.appendChild(svgEl('line', { x1: pad.l, x2: width - pad.r, y1: y, y2: y, stroke: '#1b2230', 'stroke-width': 1 }));
      const t = svgEl('text', { x: pad.l - 6, y: y + 3, 'text-anchor': 'end', 'font-size': 10, fill: '#5e6b7e' });
      t.textContent = fmt(max * (1 - g / 4));
      svg.appendChild(t);
    }
    const step = Math.max(1, Math.ceil(xKeys.length / Math.floor(iw / 64)));
    xKeys.forEach((k, i) => {
      if (i % step) return;
      const t = svgEl('text', { x: X(i), y: height - 6, 'text-anchor': 'middle', 'font-size': 10, fill: '#5e6b7e' });
      t.textContent = xLabel(k);
      svg.appendChild(t);
    });
    for (const s of series) {
      const pts = xKeys.map((k, i) => [X(i), Y(s.points.get(k) || 0)]);
      const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
      if (area) {
        svg.appendChild(svgEl('path', {
          d: d + ' L' + pts[pts.length - 1][0] + ' ' + (pad.t + ih) + ' L' + pts[0][0] + ' ' + (pad.t + ih) + ' Z',
          fill: s.color, opacity: 0.10
        }));
      }
      svg.appendChild(svgEl('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      if (xKeys.length === 1) svg.appendChild(svgEl('circle', { cx: pts[0][0], cy: pts[0][1], r: 4, fill: s.color, stroke: '#10141c', 'stroke-width': 2 }));
    }
    const cross = svgEl('line', { y1: pad.t, y2: pad.t + ih, stroke: '#2e3a4d', 'stroke-width': 1, visibility: 'hidden' });
    svg.appendChild(cross);
    const dots = series.map((s) => { const c = svgEl('circle', { r: 4, fill: s.color, stroke: '#10141c', 'stroke-width': 2, visibility: 'hidden' }); svg.appendChild(c); return c; });
    svg.addEventListener('pointermove', (e) => {
      const rect = svg.getBoundingClientRect();
      const px = e.clientX - rect.left;
      let idx = 0, best = Infinity;
      xKeys.forEach((k, i) => { const dd = Math.abs(X(i) - px); if (dd < best) { best = dd; idx = i; } });
      cross.setAttribute('x1', X(idx)); cross.setAttribute('x2', X(idx)); cross.setAttribute('visibility', 'visible');
      series.forEach((s, i) => { dots[i].setAttribute('cx', X(idx)); dots[i].setAttribute('cy', Y(s.points.get(xKeys[idx]) || 0)); dots[i].setAttribute('visibility', 'visible'); });
      showTip(e.clientX, e.clientY, xLabel(xKeys[idx]),
        series.map((s) => ({ color: s.color, name: s.name, value: fmt(s.points.get(xKeys[idx]) || 0) })));
    });
    svg.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); dots.forEach((d) => d.setAttribute('visibility', 'hidden')); hideTip(); });
    container.appendChild(svg);
    if (series.length >= 2) {
      const lg = el('div', 'legendrow');
      for (const s of series) { const k = el('span', 'key'); const sw = el('span', 'linekey'); sw.style.background = s.color; k.appendChild(sw); k.appendChild(el('span', null, s.name)); lg.appendChild(k); }
      container.appendChild(lg);
    }
  };
  render();
  new ResizeObserver(render).observe(container);
}

// Horizontal bars with direct value labels. rows: [{label, value, color, hint}]
function hBars(container, rows, { fmt = fmtTok } = {}) {
  if (!rows.length) { container.appendChild(el('div', 'sub', 'No data.')); return; }
  const render = () => {
    container.replaceChildren();
    const width = container.clientWidth || 640;
    const rowH = 32, pad = { l: Math.min(190, width * 0.32), r: 78, t: 4, b: 4 };
    const height = rows.length * rowH + pad.t + pad.b;
    const iw = width - pad.l - pad.r;
    const max = Math.max(1, ...rows.map((r) => r.value));
    const svg = svgEl('svg', { width, height, viewBox: '0 0 ' + width + ' ' + height });
    rows.forEach((r, i) => {
      const y = pad.t + i * rowH + 7;
      const bw = Math.max(2, (r.value / max) * iw);
      const lab = svgEl('text', { x: pad.l - 8, y: y + 13, 'text-anchor': 'end', 'font-size': 11, fill: '#93a0b4' });
      lab.textContent = r.label.length > 26 ? r.label.slice(0, 25) + '…' : r.label;
      svg.appendChild(lab);
      const bar = svgEl('path', {
        d: 'M' + pad.l + ' ' + y + ' h' + Math.max(0, bw - 4) + ' a4 4 0 0 1 4 4 v10 a4 4 0 0 1 -4 4 h-' + Math.max(0, bw - 4) + ' Z',
        fill: r.color
      });
      bar.style.cursor = 'default';
      bar.addEventListener('pointermove', (e) => showTip(e.clientX, e.clientY, r.hint || r.label, [{ color: r.color, name: '', value: fmt(r.value) }]));
      bar.addEventListener('pointerleave', hideTip);
      svg.appendChild(bar);
      const val = svgEl('text', { x: pad.l + bw + 8, y: y + 13, 'font-size': 11, fill: '#e7ecf3', 'font-weight': 700 });
      val.textContent = fmt(r.value);
      svg.appendChild(val);
    });
    container.appendChild(svg);
  };
  render();
  new ResizeObserver(render).observe(container);
}

// Cumulative token timeline from a session's request list: [{ts, total}].
function timelineOf(s) {
  const reqs = (s.requests || []).slice().sort((a, b) => a.timestamp - b.timestamp);
  let run = 0;
  return reqs.map((r) => { run += r.total || 0; return { ts: r.timestamp, total: run }; });
}

// Cumulative timelines aligned to each session's start (minutes).
function timelineChart(container, sessions, colors, { height = 240 } = {}) {
  const tls = sessions.map(timelineOf).map((tl) => (tl.length ? tl : [{ ts: 0, total: 0 }]));
  const maxMin = Math.max(1, ...tls.map((tl) => (tl.at(-1).ts - tl[0].ts) / 60000));
  const buckets = 60;
  const xKeys = Array.from({ length: buckets + 1 }, (_, i) => (i * maxMin) / buckets);
  const series = sessions.map((s, si) => {
    const tl = tls[si];
    const start = tl[0].ts;
    const pts = new Map();
    let j = 0;
    for (const x of xKeys) {
      while (j < tl.length - 1 && (tl[j + 1].ts - start) / 60000 <= x) j++;
      const done = (tl.at(-1).ts - start) / 60000 < x;
      pts.set(x, done ? tl.at(-1).total : tl[j].total);
    }
    return { name: s.title || s.id, color: colors[si % colors.length], points: pts };
  });
  lineChart(container, xKeys, series, { height, fmt: fmtTok, xLabel: (k) => Math.round(k) + 'm' });
}

// ---------- shared data prep ----------
const provs = DATA.providers.filter((p) => p.available);
const allSessions = provs.flatMap((p) => (p.sessions || []).map((s) => ({ ...s, providerName: p.name, color: p.color, provider: p.id })));
const allModels = [];
for (const p of provs) for (const m in p.byModel) {
  allModels.push({ model: m, provider: p.id, providerName: p.name, color: p.color, ...p.byModel[m],
    sessions: (p.sessions || []).filter((s) => (s.models || []).includes(m)).length });
}
allModels.sort((a, b) => b.tokens.total - a.tokens.total);

$('#range-pill').textContent = 'Range: ' + (DATA.range.label === 'custom'
  ? fmtTime(DATA.range.from) + ' → ' + fmtTime(DATA.range.to) : DATA.range.label);
$('#generated-pill').textContent = 'Generated ' + fmtTime(DATA.generatedAt);

// ---------- views ----------
const view = $('#view');
const picked = new Set();

function card(title) { const c = el('div', 'card'); if (title) c.appendChild(el('h3', null, title)); return c; }

function tile(label, value, detail, color) {
  const t = el('div', 'card tile');
  t.appendChild(el('h3', null, label));
  const v = el('div', 'v', value); if (color) v.style.color = color;
  t.appendChild(v);
  if (detail) t.appendChild(el('div', 'd', detail));
  return t;
}

function renderOverview() {
  view.replaceChildren();
  const totalTok = provs.reduce((a, p) => a + (p.tokens?.total || 0), 0);
  const totalCost = provs.reduce((a, p) => a + (p.cost?.total || 0), 0);
  const todayCost = provs.reduce((a, p) => a + (p.cost?.today || 0), 0);

  const hero = el('div', 'card');
  hero.appendChild(el('h3', null, 'Total tokens in range'));
  hero.appendChild(el('div', 'hero', fmtTok(totalTok)));
  hero.appendChild(el('div', 'sub', allSessions.length + ' sessions · ' + allModels.length + ' models · every provider combined'));
  view.appendChild(hero);

  const row = el('div', 'kpirow'); row.style.marginTop = '14px';
  row.appendChild(tile('Est. spend in range', fmtUsd(totalCost), fmtUsd(todayCost) + ' today', 'var(--good)'));
  for (const p of provs) row.appendChild(tile(p.name, fmtTok(p.tokens?.total || 0), fmtUsd(p.cost?.total || 0) + ' est.', p.color));
  view.appendChild(row);

  // What the same range would have cost with no prompt cache. The token total
  // is unchanged — the same prompt is sent either way — so this compares
  // price, not volume. Both figures come from the same price table.
  if (DATA.showWithoutCache) {
    var ncCost = provs.reduce(function (a, p) { return a + ((p.noCache && p.noCache.cost && p.noCache.cost.total) || 0); }, 0);
    var ncBase = provs.reduce(function (a, p) { return a + ((p.noCache && p.noCache.baseline && p.noCache.baseline.total) || 0); }, 0);
    var ncIn = provs.reduce(function (a, p) { return a + ((p.noCache && p.noCache.tokens && p.noCache.tokens.input) || 0); }, 0);
    if (ncCost > 0) {
      var saved = ncCost - ncBase;
      var mult = ncBase > 0 ? ncCost / ncBase : null;
      var ncRow = el('div', 'kpirow');
      ncRow.appendChild(tile('Spend without cache', fmtUsd(ncCost), 'same ' + fmtTok(totalTok) + ' tokens', 'var(--warn)'));
      ncRow.appendChild(tile('Cache saved', fmtUsd(saved), mult ? mult.toFixed(1) + '\u00d7 cheaper with cache' : 'no cached tokens in range', 'var(--good)'));
      ncRow.appendChild(tile('Uncached input if no cache', fmtTok(ncIn), 'every prompt token billed fresh'));
      view.appendChild(ncRow);
    }
  }

  const grid = el('div', 'grid cols-2');
  const c1 = card('Tokens per day — provider head-to-head');
  const dates = [...new Set(provs.flatMap((p) => p.series.tokensByDay.map((d) => d.date)))].sort();
  const chart1 = el('div'); c1.appendChild(chart1);
  lineChart(chart1, dates, provs.map((p) => ({
    name: p.name, color: p.color,
    points: new Map(p.series.tokensByDay.map((d) => [d.date, d.total]))
  })), { area: true, xLabel: (k) => k.slice(5) });
  grid.appendChild(c1);

  const c2 = card('Est. cost per day (USD)');
  const chart2 = el('div'); c2.appendChild(chart2);
  lineChart(chart2, dates, provs.map((p) => ({
    name: p.name, color: p.color,
    points: new Map(p.series.costByDay.map((d) => [d.date, d.cost]))
  })), { area: true, fmt: fmtUsd, xLabel: (k) => k.slice(5) });
  grid.appendChild(c2);

  // Percentage trend for one window. Scaled 0-100, not to the series maximum,
  // so windows stay comparable and a steady 54% does not look full.
  function spark(series, color) {
    const W = 240, H = 30;
    const ts = series.map((x) => x.t);
    const t0 = Math.min(...ts), t1 = Math.max(...ts);
    const span = (t1 - t0) || 1;
    const pts = series.map((x) => {
      const px = ((x.t - t0) / span) * W;
      const py = H - (Math.max(0, Math.min(100, x.pct)) / 100) * (H - 3) - 1.5;
      return px.toFixed(1) + ',' + py.toFixed(1);
    }).join(' ');
    const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none', class: 'wspark' });
    svg.appendChild(svgEl('polygon', { points: '0,' + H + ' ' + pts + ' ' + W + ',' + H, fill: color, opacity: '0.14' }));
    svg.appendChild(svgEl('polyline', { points: pts, fill: 'none', stroke: color, 'stroke-width': '1.5' }));
    return svg;
  }

  for (const p of provs) {
    if (!p.windows?.length) continue;
    const c = card(p.name + ' — live rate-limit windows');
    const note = el('div', 'sub', p.id === 'claude' ? 'Account-wide: reflects usage from every surface and device.' : '');
    if (note.textContent) c.appendChild(note);
    for (const w of p.windows) {
      const m = el('div', 'meter');
      const r = el('div', 'row');
      r.appendChild(el('span', 'name', w.label));
      r.appendChild(el('span', 'val', w.usedPercent == null ? '—' : Math.round(w.usedPercent) + '%'));
      m.appendChild(r);
      const tr = el('div', 'track'); const f = el('div', 'fill');
      const pct = Math.min(100, w.usedPercent || 0);
      f.style.width = pct + '%';
      f.style.background = pct >= 90 ? 'var(--bad)' : pct >= 70 ? 'var(--warn)' : p.color;
      tr.appendChild(f); m.appendChild(tr);
      var meta = [];
      if (w.resetsAt) meta.push('resets ' + fmtTime(w.resetsAt));
      if (w.usedTokens != null) {
        meta.push(fmtTok(w.usedTokens) + (w.budgetTokens != null ? ' / ' + fmtTok(w.budgetTokens) : '') + ' tok');
      }
      if (meta.length) m.appendChild(el('div', 'sub', meta.join(' · ')));

      // Burn rate and projection, derived from the exporting machine's recorded
      // history of this account-wide window.
      var st = (p.limitStats || {})[w.id] || {};
      if (st.rate) {
        var v = Math.abs(st.rate.perHour);
        var span = Math.round((st.rate.spanMs || 0) / 60000);
        var rateText = v < 0.05
          ? 'flat over ' + span + 'm'
          : (st.rate.perHour > 0 ? '+' : '\u2212') + (v < 1 ? v.toFixed(2) : v.toFixed(1)) + ' pts/hr over ' + span + 'm';
        var line = rateText;
        if (st.projection) {
          var h = st.projection.hoursLeft;
          line += ' \u00b7 100% in ' + (h < 1 ? Math.round(h * 60) + 'm' : h < 48 ? h.toFixed(1) + 'h' : Math.round(h / 24) + 'd');
          if (st.projection.beforeReset != null) {
            line += st.projection.beforeReset ? ' (before reset)' : ' (resets first)';
          }
        }
        m.appendChild(el('div', 'sub', line));
      }
      if (st.series && st.series.length > 1) m.appendChild(spark(st.series, p.color));
      c.appendChild(m);
    }
    if (p.limitSamples > 1) {
      c.appendChild(el('div', 'sub', 'Trend and burn rate from ' + p.limitSamples + ' recorded samples.'));
    }
    if (p.windowsNote) c.appendChild(el('div', 'sub', '\u26a0 ' + p.windowsNote));
    grid.appendChild(c);
  }
  view.appendChild(grid);
}

// ---------- sessions ----------
const sCols = [
  ['Session', (s) => s.title || s.id], ['Provider', (s) => s.providerName], ['Start', (s) => s.startedAt],
  ['Length', (s) => s.durationMs], ['Requests', (s) => s.requestCount], ['Input', (s) => s.tokens.input],
  ['Output', (s) => s.tokens.output], ['Tokens', (s) => s.tokens.total], ['Cost', (s) => s.costUsd]
];
let sSort = 2, sDir = -1, sProv = null, sQuery = '';

function renderSessions() {
  view.replaceChildren();
  const fr = el('div', 'filterrow');
  for (const p of provs) {
    if (!(p.sessions || []).length) continue;
    const c = el('button', 'chip' + (sProv === p.id ? ' on' : ''));
    const d = el('span', 'dotkey'); d.style.background = p.color; c.appendChild(d);
    c.appendChild(document.createTextNode(p.name));
    c.addEventListener('click', () => { sProv = sProv === p.id ? null : p.id; renderSessions(); });
    fr.appendChild(c);
  }
  const inp = el('input', 'search'); inp.placeholder = 'Search sessions…'; inp.value = sQuery;
  inp.addEventListener('input', () => { sQuery = inp.value; renderTable(); });
  fr.appendChild(inp);
  view.appendChild(fr);

  const c = card(null); c.style.padding = '0';
  const wrap = el('div', 'tablewrap'); c.appendChild(wrap); view.appendChild(c);

  function renderTable() {
    wrap.replaceChildren();
    const q = sQuery.trim().toLowerCase();
    const rows = allSessions
      .filter((s) => !sProv || s.provider === sProv)
      .filter((s) => !q || ((s.title || '') + ' ' + s.id + ' ' + (s.primaryModel || '') + ' ' + (s.product || '')).toLowerCase().includes(q))
      .sort((a, b) => { const av = sCols[sSort][1](a), bv = sCols[sSort][1](b); return (av > bv ? 1 : av < bv ? -1 : 0) * sDir; });
    const table = el('table');
    const thead = el('thead'); const trh = el('tr');
    const thPick = el('th', null, '⇄'); thPick.title = 'Pick up to 4 sessions to compare'; trh.appendChild(thPick);
    sCols.forEach((col, i) => {
      const th = el('th', i === sSort ? 'sorted' : '', col[0] + (i === sSort ? (sDir < 0 ? ' ↓' : ' ↑') : ''));
      th.addEventListener('click', () => { if (sSort === i) sDir = -sDir; else { sSort = i; sDir = -1; } renderTable(); });
      trh.appendChild(th);
    });
    thead.appendChild(trh); table.appendChild(thead);
    const tbody = el('tbody');
    for (const s of rows) {
      const tr = el('tr');
      const tdP = el('td'); const cb = document.createElement('input'); cb.type = 'checkbox';
      cb.checked = picked.has(s.provider + ':' + s.id);
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => {
        const key = s.provider + ':' + s.id;
        if (cb.checked) { if (picked.size >= 4) { cb.checked = false; return; } picked.add(key); } else picked.delete(key);
        updateCompareBar();
      });
      tdP.appendChild(cb); tr.appendChild(tdP);
      const tdT = el('td'); const dk = el('span', 'dotkey'); dk.style.background = s.color; dk.style.marginRight = '7px';
      tdT.appendChild(dk); const tt = el('span', null, s.title || s.id); tt.style.color = 'var(--ink)'; tt.style.fontWeight = '600';
      tdT.appendChild(tt);
      if (s.product) { const sf = el('span', 'pill', s.product); sf.style.marginLeft = '7px'; sf.style.fontSize = '9px'; sf.style.padding = '1px 6px'; tdT.appendChild(sf); }
      tr.appendChild(tdT);
      tr.appendChild(el('td', null, s.providerName));
      tr.appendChild(el('td', null, fmtTime(s.startedAt)));
      tr.appendChild(el('td', null, fmtDur(s.durationMs)));
      tr.appendChild(el('td', null, String(s.requestCount)));
      tr.appendChild(el('td', null, fmtTok(s.tokens.input)));
      tr.appendChild(el('td', null, fmtTok(s.tokens.output)));
      tr.appendChild(el('td', 'strong', fmtTok(s.tokens.total)));
      const tdC = el('td', 'strong', fmtUsd(s.costUsd)); tdC.style.color = 'var(--good)'; tr.appendChild(tdC);
      tr.addEventListener('click', () => openSession(s));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    if (!rows.length) wrap.appendChild(el('div', 'sub', 'No sessions match.')).style.padding = '20px';
  }
  renderTable();
}

function kpi(k, v, color) { const d = el('div', 'kpi'); d.appendChild(el('div', 'k', k)); const vv = el('div', 'v', v); if (color) vv.style.color = color; d.appendChild(vv); return d; }

function openSession(s) {
  const modal = $('#modal'); modal.replaceChildren();
  const scrim = el('div', 'scrim'); scrim.addEventListener('click', close);
  const fly = el('div', 'flyout');
  function close() { modal.replaceChildren(); }
  const head = el('div', 'fly-head');
  const left = el('div');
  left.appendChild(el('div', 'fly-title', s.title || s.id));
  const meta = el('div', 'sub');
  const pp = el('span', 'pill', s.providerName); pp.style.color = s.color; pp.style.borderColor = s.color; meta.appendChild(pp);
  if (s.product) { const sp = el('span', 'pill', s.product); sp.style.marginLeft = '6px'; meta.appendChild(sp); }
  if (s.sourceLabel) { const sl = el('span', 'pill', s.sourceLabel); sl.style.marginLeft = '6px'; meta.appendChild(sl); }
  left.appendChild(meta);
  head.appendChild(left);
  const x = el('button', 'x', '✕'); x.addEventListener('click', close); head.appendChild(x);
  fly.appendChild(head);

  const grid = el('div', 'kpis');
  grid.appendChild(kpi('Started', fmtTime(s.startedAt)));
  grid.appendChild(kpi('Ended', fmtTime(s.endedAt)));
  grid.appendChild(kpi('Length', fmtDur(s.durationMs)));
  grid.appendChild(kpi('Requests', String(s.requestCount)));
  grid.appendChild(kpi('Tokens', fmtTok(s.tokens.total)));
  grid.appendChild(kpi('Cost (' + (s.costKind || 'est.') + ')', fmtUsd(s.costUsd), 'var(--good)'));
  grid.appendChild(kpi('Uncached input', fmtTok(s.tokens.input)));
  grid.appendChild(kpi('Cache read', fmtTok(s.tokens.cachedInput)));
  grid.appendChild(kpi('Output', fmtTok(s.tokens.output)));
  fly.appendChild(grid);

  const c = card('Cumulative tokens over the session');
  const ch = el('div'); c.appendChild(ch);
  fly.appendChild(c);
  if ((s.requests || []).length > 1) timelineChart(ch, [s], [s.color], { height: 180 });
  else ch.appendChild(el('div', 'sub', 'Single-request session.'));
  const pace = s.durationMs > 60000 ? s.tokens.total / (s.durationMs / 60000) : null;
  if (pace) c.appendChild(el('div', 'sub', '≈ ' + fmtTok(Math.round(pace)) + ' tokens/min'));

  if ((s.models || []).length) {
    const mc = card('Models in this session');
    mc.style.marginTop = '12px';
    const byModel = new Map();
    for (const r of s.requests || []) {
      if (!r.model) continue;
      const agg = byModel.get(r.model) || { total: 0, usd: 0 };
      agg.total += r.total || 0;
      agg.usd += r.costUsd || 0;
      byModel.set(r.model, agg);
    }
    const rows = [...byModel.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .map(([m, v], i) => ({ label: m, value: v.total, color: CMP[i % CMP.length], hint: m + ' · ' + fmtUsd(v.usd) }));
    const bc = el('div'); mc.appendChild(bc); hBars(bc, rows);
    fly.appendChild(mc);
  }
  modal.appendChild(scrim); modal.appendChild(fly);
}

function updateCompareBar() {
  const bar = $('#comparebar');
  bar.style.display = picked.size >= 2 ? 'flex' : 'none';
  $('#comparecount').textContent = picked.size + ' sessions selected';
}
$('#compareclear').addEventListener('click', () => { picked.clear(); updateCompareBar(); if (currentTab === 'sessions') renderSessions(); });
$('#comparego').addEventListener('click', () => {
  const sel = allSessions.filter((s) => picked.has(s.provider + ':' + s.id));
  if (sel.length < 2) return;
  const modal = $('#modal'); modal.replaceChildren();
  const scrim = el('div', 'scrim'); const ov = el('div', 'overlay');
  const close = () => modal.replaceChildren();
  scrim.addEventListener('click', close);
  const head = el('div', 'fly-head');
  head.appendChild(el('div', 'fly-title', 'Comparing ' + sel.length + ' sessions'));
  const x = el('button', 'x', '✕'); x.addEventListener('click', close); head.appendChild(x);
  ov.appendChild(head);
  const lg = el('div', 'legendrow');
  sel.forEach((s, i) => { const k = el('span', 'key'); const d = el('span', 'dotkey'); d.style.background = CMP[i % CMP.length]; k.appendChild(d);
    k.appendChild(el('span', null, (s.title || s.id) + ' · ' + fmtTime(s.startedAt))); lg.appendChild(k); });
  ov.appendChild(lg);
  const tc = card('Token burn, minute by minute (aligned to each session\\u2019s start)');
  tc.style.marginTop = '12px';
  const tch = el('div'); tc.appendChild(tch); ov.appendChild(tc);
  timelineChart(tch, sel, CMP);
  const grid = el('div', 'grid cols-2'); grid.style.marginTop = '12px';
  const metrics = [
    ['Total tokens', (s) => s.tokens.total, fmtTok],
    ['Est. cost (USD)', (s) => s.costUsd, fmtUsd],
    ['Length (minutes)', (s) => Math.round(s.durationMs / 60000), (v) => v + 'm'],
    ['Tokens per minute', (s) => s.durationMs > 60000 ? Math.round(s.tokens.total / (s.durationMs / 60000)) : s.tokens.total, fmtTok]
  ];
  for (const [label, fn, fmt] of metrics) {
    const c = card(label); const ch = el('div'); c.appendChild(ch);
    hBars(ch, sel.map((s, i) => ({ label: s.title || String(s.id).slice(0, 14), value: fn(s), color: CMP[i % CMP.length] })), { fmt });
    grid.appendChild(c);
  }
  ov.appendChild(grid);
  modal.appendChild(scrim); modal.appendChild(ov);
});

// ---------- models ----------
function renderModels() {
  view.replaceChildren();
  if (!allModels.length) { view.appendChild(card(null)).appendChild(el('div', 'sub', 'No model usage in range.')); return; }
  const c1 = card('Tokens by model — color keyed to provider');
  const ch1 = el('div'); c1.appendChild(ch1);
  hBars(ch1, allModels.slice(0, 10).map((m) => ({ label: m.model, value: m.tokens.total, color: m.color, hint: m.model + ' (' + m.providerName + ')' })));
  const lg = el('div', 'legendrow');
  for (const p of provs) { const k = el('span', 'key'); const d = el('span', 'dotkey'); d.style.background = p.color; k.appendChild(d); k.appendChild(el('span', null, p.name)); lg.appendChild(k); }
  c1.appendChild(lg);
  view.appendChild(c1);

  const c2 = card('Est. cost by model (USD)'); c2.style.marginTop = '14px';
  const ch2 = el('div'); c2.appendChild(ch2);
  hBars(ch2, allModels.slice(0, 10).map((m) => ({ label: m.model, value: m.cost.total, color: m.color, hint: m.model + ' (' + m.providerName + ')' })), { fmt: fmtUsd });
  view.appendChild(c2);

  const top = allModels.slice(0, 4);
  const dates = [...new Set(top.flatMap((m) => m.series.tokensByDay.map((d) => d.date)))].sort();
  if (dates.length > 1) {
    const c3 = card('Daily tokens — top ' + top.length + ' models head-to-head'); c3.style.marginTop = '14px';
    const ch3 = el('div'); c3.appendChild(ch3);
    lineChart(ch3, dates, top.map((m, i) => ({ name: m.model, color: CMP[i], points: new Map(m.series.tokensByDay.map((d) => [d.date, d.total])) })), { xLabel: (k) => k.slice(5) });
    view.appendChild(c3);
  }

  const c4 = card(null); c4.style.marginTop = '14px'; c4.style.padding = '0';
  const wrap = el('div', 'tablewrap'); c4.appendChild(wrap);
  const table = el('table');
  const trh = el('tr');
  for (const h of ['Model', 'Provider', 'Sessions', 'Uncached in', 'Cache read', 'Output', 'Tokens', 'Cost', '$/1M tok']) trh.appendChild(el('th', null, h));
  const thead = el('thead'); thead.appendChild(trh); table.appendChild(thead);
  const tbody = el('tbody');
  for (const m of allModels) {
    const tr = el('tr'); tr.style.cursor = 'default';
    const td = el('td'); const d = el('span', 'dotkey'); d.style.background = m.color; d.style.marginRight = '7px'; td.appendChild(d);
    const nm = el('span', null, m.model); nm.style.color = 'var(--ink)'; nm.style.fontWeight = '600'; td.appendChild(nm); tr.appendChild(td);
    tr.appendChild(el('td', null, m.providerName));
    tr.appendChild(el('td', null, m.sessions ? String(m.sessions) : '—'));
    tr.appendChild(el('td', null, fmtTok(m.tokens.input)));
    tr.appendChild(el('td', null, fmtTok(m.tokens.cachedInput)));
    tr.appendChild(el('td', null, fmtTok(m.tokens.output)));
    tr.appendChild(el('td', 'strong', fmtTok(m.tokens.total)));
    const tc = el('td', 'strong', fmtUsd(m.cost.total)); tc.style.color = 'var(--good)'; tr.appendChild(tc);
    tr.appendChild(el('td', null, m.tokens.total ? fmtUsd((m.cost.total / m.tokens.total) * 1e6) : '—'));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody); wrap.appendChild(table);
  view.appendChild(c4);
}

// ---------- tabs ----------
const TABS = [['overview', 'Overview', renderOverview], ['sessions', 'Sessions (' + allSessions.length + ')', renderSessions], ['models', 'Models (' + allModels.length + ')', renderModels]];
let currentTab = 'overview';
const tabsEl = $('#tabs');
for (const [id, label, fn] of TABS) {
  const b = el('button', 'tab' + (id === currentTab ? ' on' : ''), label);
  b.addEventListener('click', () => {
    currentTab = id;
    tabsEl.querySelectorAll('.tab').forEach((t) => t.classList.remove('on'));
    b.classList.add('on');
    hideTip(); $('#modal').replaceChildren();
    fn();
  });
  tabsEl.appendChild(b);
}
renderOverview();
updateCompareBar();
</script>
</body>
</html>`
}
