/* Scevia v2 concept — shell, icons and SVG chart helpers. Colours come only from CSS tokens. */
const I = {
  search: '<path d="m21 21-4.3-4.3"/><circle cx="11" cy="11" r="7"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01"/>',
  flask: '<path d="M9 3h6M10 3v6.5L4.5 19a1.5 1.5 0 0 0 1.3 2h12.4a1.5 1.5 0 0 0 1.3-2L14 9.5V3"/><path d="M7 15h10"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  reset: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  // rail icons
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  pie: '<path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>',
  cal: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  db: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/>',
  trend: '<path d="m22 7-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>',
  bars: '<path d="M3 3v18h18"/><path d="M7 16V9M12 16V5M17 16v-3"/>',
  spark: '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
  target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  table: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
  ladder: '<path d="M4 4v16M4 8h6M4 12h10M4 16h14"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  compare: '<path d="M16 3h5v5M8 21H3v-5M21 3l-7 7M3 21l7-7"/>',
};
const icon = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[n]}</svg>`;

const MARK = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect width="24" height="24" rx="7" style="fill:var(--color-action-primary-bg)"/><path d="M5.5 16.5c2.6 0 3.7-1.8 5-4.4 1.3-2.6 2.5-4.4 5.4-4.4h2.6" style="stroke:var(--color-action-primary-fg)" stroke-width="1.8" stroke-linecap="round"/><circle cx="5.5" cy="16.5" r="1.6" style="fill:var(--color-accent-solid)"/></svg>`;

function shell(active) {
  const tabs = [['overview.html', 'Overview'], ['analytics.html', 'Analytics'], ['risk.html', 'Risk'], ['scenario-lab.html', 'Scenario Lab']];
  document.getElementById('topbar').outerHTML = `<header class="topbar">
    <a class="brand" href="overview.html">${MARK}Scevia</a>
    <nav class="nav" aria-label="Primary">${tabs.map(([h, t]) => `<a href="${h}" class="${t === active ? 'on' : ''}">${t === 'Scenario Lab' ? '<span class="lab-dot"></span>' : ''}${t}</a>`).join('')}</nav>
    <div class="utils">
      <div class="search">${icon('search')}<span>Search markets, positions…</span><kbd>⌘K</kbd></div>
      <div class="sync"><span class="dot"></span>Synced 4m ago</div>
      <span class="chip accent">Sample data</span>
      <a class="icon-btn" aria-label="Help">${icon('help')}</a>
      <a class="icon-btn" aria-label="Notifications">${icon('bell')}</a>
      <a class="icon-btn" aria-label="Settings">${icon('gear')}</a>
      <div class="avatar" aria-label="Account">AR</div>
    </div></header>`;
  document.querySelectorAll('[data-i]').forEach((el) => el.insertAdjacentHTML('afterbegin', icon(el.dataset.i)));
}

const fmt = (v, d = 0) => (v < 0 ? '−' : '') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const sfmt = (v, d = 0) => (v > 0 ? '+' : v < 0 ? '−' : '') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const kfmt = (v) => (v < 0 ? '−' : '') + '$' + (Math.abs(v) >= 1000 ? (Math.abs(v) / 1000).toFixed(Math.abs(v) >= 10000 ? 0 : 1) + 'k' : Math.abs(v));
const rng = (s) => () => (s = (s * 16807) % 2147483647) / 2147483647;
const platBadge = (p) => `<span class="plat ${p}" title="${p === 'pm' ? 'Polymarket' : 'Kalshi'}">${p === 'pm' ? 'P' : 'K'}</span>`;
const heroFig = (v, cur = 'USD') => { const [i, d] = Math.abs(v).toFixed(2).split('.'); return `${v < 0 ? '−' : ''}$${(+i).toLocaleString('en-US')}<span class="dec">.${d}</span><span class="cur">${cur}</span>`; };

/* line/area chart */
function lineChart(el, o) {
  const W = o.w, H = o.h, P = Object.assign({ l: 48, r: 12, t: 12, b: 26 }, o.pad || {});
  const n = o.series[0].data.length, min = o.min, max = o.max;
  const x = (i) => P.l + (i / (n - 1)) * (W - P.l - P.r);
  const y = (v) => P.t + (1 - (v - min) / (max - min)) * (H - P.t - P.b);
  let g = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="overflow:visible"><g class="axis">`;
  (o.yTicks || []).forEach((t) => { g += `<line class="${t === 0 ? 'zero' : 'grid-l'}" x1="${P.l}" x2="${W - P.r}" y1="${y(t)}" y2="${y(t)}" ${t === 0 ? '' : 'stroke-dasharray="2 4"'}/><text x="${P.l - 10}" y="${y(t) + 4}" text-anchor="end">${o.yFmt ? o.yFmt(t) : t}</text>`; });
  (o.xLabels || []).forEach(([i, t]) => { g += `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${t}</text>`; });
  g += '</g>';
  o.series.forEach((s) => {
    const pts = s.data.map((v, i) => [x(i), y(v)]);
    const d = (s.step ? pts.map((p, i) => (i ? `H${p[0]}V${p[1]}` : `M${p[0]},${p[1]}`)) : pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1))).join('');
    if (s.area) {
      const id = 'g' + Math.random().toString(36).slice(2);
      g += `<defs><linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" style="stop-color:${s.color};stop-opacity:${s.area}"/><stop offset="1" style="stop-color:${s.color};stop-opacity:0"/></linearGradient></defs>`;
      g += `<path d="${d}L${x(n - 1)},${y(o.areaBase ?? min)}L${x(0)},${y(o.areaBase ?? min)}Z" fill="url(#${id})"/>`;
    }
    g += `<path d="${d}" fill="none" style="stroke:${s.color}" stroke-width="${s.width || 2}" ${s.dash ? `stroke-dasharray="${s.dash}"` : ''} stroke-linejoin="round" stroke-linecap="round"/>`;
  });
  (o.markers || []).forEach((m) => {
    const s = o.series[m.s ?? 0], v = s.data[m.i];
    g += `<line x1="${x(m.i)}" x2="${x(m.i)}" y1="${P.t}" y2="${H - P.b}" style="stroke:var(--color-border-strong)" stroke-dasharray="2 3"/>`;
    g += `<circle cx="${x(m.i)}" cy="${y(v)}" r="5" style="fill:var(--color-bg-surface);stroke:${s.color}" stroke-width="2.5"/>`;
  });
  (o.events || []).forEach((e) => { g += `<circle cx="${x(e)}" cy="${H - P.b - 6}" r="3" style="fill:var(--color-bg-surface);stroke:var(--color-accent-fg)" stroke-width="1.5"/>`; });
  el.innerHTML = g + '</svg>';
  return { x, y };
}

function donut(el, parts, size = 176, th = 18) {
  const r = size / 2 - th / 2, c = 2 * Math.PI * r, tot = parts.reduce((a, p) => a + p.v, 0);
  let off = 0, g = `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" style="transform:rotate(-90deg)">`;
  parts.forEach((p) => { const len = (p.v / tot) * c; g += `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" style="stroke:${p.c}" stroke-width="${th}" stroke-dasharray="${Math.max(len - 3, 0)} ${c}" stroke-dashoffset="${-off}" stroke-linecap="butt"/>`; off += len; });
  el.innerHTML = g + '</svg>';
}

/* scroll-spy for the section rail */
function spy() {
  const links = [...document.querySelectorAll('.rail ol a[href^="#"]')];
  const map = links.filter((a) => a.getAttribute('href').length > 1).map((a) => [a, document.querySelector(a.getAttribute('href'))]).filter(([, s]) => s);
  const on = () => { let cur = map[0]; for (const m of map) if (m[1].getBoundingClientRect().top < 140) cur = m; links.forEach((l) => l.classList.toggle('on', l === cur[0])); };
  addEventListener('scroll', on, { passive: true });
}
