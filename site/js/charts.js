// Small dependency-free SVG charts for the race detail panel.
import { fmtMargin } from './shared/model.js';

const NS = 'http://www.w3.org/2000/svg';
const DEM = [31, 91, 196];
const REP = [198, 40, 40];
const MID = [176, 182, 192];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Diverging color for a shift in points: gray at 0, full party color at |shift| >= 15. */
export function shiftColor(sh) {
  if (sh == null || !isFinite(sh)) return 'rgb(176,182,192)';
  const t = Math.min(1, Math.abs(sh) / 15);
  const to = sh > 0 ? DEM : REP;
  const c = MID.map((m, i) => Math.round(m + (to[i] - m) * t));
  return `rgb(${c.join(',')})`;
}

const tickLabel = (v) => (v === 0 ? 'Even' : (v > 0 ? 'D+' : 'R+') + Math.abs(v));

function el(tag, attrs = {}, text) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}

function tooltip(box) {
  let tip = box.querySelector('.tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'tip';
    box.append(tip);
  }
  return {
    show(html, x, y) {
      tip.innerHTML = html;
      tip.style.display = 'block';
      const bw = box.clientWidth;
      const tw = tip.offsetWidth;
      tip.style.left = `${Math.max(4, Math.min(bw - tw - 4, x + 12))}px`;
      tip.style.top = `${Math.max(4, y - tip.offsetHeight - 10)}px`;
    },
    hide() {
      tip.style.display = 'none';
    },
  };
}

/**
 * Precinct scatter: x = 2024 margin, y = 2026 margin, both over the same vote types.
 * Dots above the diagonal moved toward Democrats.
 */
export function scatterChart(box, units, opts = {}) {
  const pts = units.filter((u) => u.m26 != null && u.m24 != null);
  const svgHost = box.querySelector('.plot');
  svgHost.innerHTML = '';
  if (!pts.length) {
    svgHost.innerHTML = '<div class="empty">Dots appear as matched precincts report.</div>';
    return;
  }
  const W = 460;
  const H = 360;
  const m = { l: 46, r: 12, t: 12, b: 38 };
  const maxAbs = Math.max(20, ...pts.map((p) => Math.max(Math.abs(p.m26), Math.abs(p.m24))));
  const lim = Math.min(100, Math.ceil(maxAbs / 10) * 10);
  const x = (v) => m.l + ((v + lim) / (2 * lim)) * (W - m.l - m.r);
  const y = (v) => H - m.b - ((v + lim) / (2 * lim)) * (H - m.t - m.b);
  const maxT = Math.max(...pts.map((p) => p.t || 0), 1);
  const rad = (t) => 2.5 + 5.5 * Math.sqrt((t || 0) / maxT);

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Precinct margins, 2026 against 2024' });
  const step = lim > 60 ? 25 : lim > 30 ? 20 : 10;
  const g = el('g');
  for (let v = -Math.floor(lim / step) * step; v <= lim; v += step) {
    g.append(el('line', { x1: x(v), x2: x(v), y1: m.t, y2: H - m.b, stroke: v === 0 ? '#c3cad6' : '#edf0f5', 'stroke-width': 1 }));
    g.append(el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), stroke: v === 0 ? '#c3cad6' : '#edf0f5', 'stroke-width': 1 }));
    g.append(el('text', { x: x(v), y: H - m.b + 15, 'text-anchor': 'middle', 'font-size': 10.5, fill: '#6b7489' }, tickLabel(v)));
    g.append(el('text', { x: m.l - 6, y: y(v) + 3.5, 'text-anchor': 'end', 'font-size': 10.5, fill: '#6b7489' }, tickLabel(v)));
  }
  svg.append(g);
  svg.append(el('line', { x1: x(-lim), y1: y(-lim), x2: x(lim), y2: y(lim), stroke: '#8a93a6', 'stroke-width': 1 }));
  svg.append(el('text', { x: x(lim * 0.92), y: y(lim * 0.92) + 14, 'text-anchor': 'end', 'font-size': 10.5, fill: '#6b7489' }, 'same as 2024'));
  svg.append(el('text', { x: x(-lim) + 6, y: y(lim) + 12, 'font-size': 11, fill: '#1a4fae', 'font-weight': 700 }, '↖ moved toward D'));
  svg.append(el('text', { x: x(lim) - 6, y: y(-lim) - 6, 'text-anchor': 'end', 'font-size': 11, fill: '#b81f1f', 'font-weight': 700 }, 'moved toward R ↘'));
  svg.append(el('text', { x: (m.l + W - m.r) / 2, y: H - 4, 'text-anchor': 'middle', 'font-size': 11.5, fill: '#44506b', 'font-weight': 600 }, '2024 margin (same vote types)'));
  svg.append(el('text', { x: 12, y: (m.t + H - m.b) / 2, transform: `rotate(-90 12 ${(m.t + H - m.b) / 2})`, 'text-anchor': 'middle', 'font-size': 11.5, fill: '#44506b', 'font-weight': 600 }, '2026 margin'));

  const sorted = pts.slice().sort((a, b) => (b.t || 0) - (a.t || 0));
  const dots = el('g');
  const screen = [];
  for (const p of sorted) {
    const cx = x(p.m24);
    const cy = y(p.m26);
    const r = rad(p.t);
    dots.append(el('circle', { cx, cy, r, fill: shiftColor(p.sh), 'fill-opacity': 0.88, stroke: '#fff', 'stroke-width': 1 }));
    screen.push({ p, cx, cy, r });
  }
  svg.append(dots);
  const hl = el('circle', { r: 0, fill: 'none', stroke: '#13234b', 'stroke-width': 2, 'pointer-events': 'none' });
  svg.append(hl);
  svgHost.append(svg);

  const tip = tooltip(box);
  const pick = (ev) => {
    const rect = svg.getBoundingClientRect();
    const sx = ((ev.clientX - rect.left) / rect.width) * W;
    const sy = ((ev.clientY - rect.top) / rect.height) * H;
    let best = null;
    let bd = Infinity;
    for (const s of screen) {
      const d = Math.hypot(s.cx - sx, s.cy - sy) - s.r;
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    const scale = rect.width / W;
    if (!best || bd * scale > 24) {
      hl.setAttribute('r', 0);
      tip.hide();
      return null;
    }
    hl.setAttribute('cx', best.cx);
    hl.setAttribute('cy', best.cy);
    hl.setAttribute('r', best.r + 2);
    const p = best.p;
    const brect = box.getBoundingClientRect();
    tip.show(
      `<b>${esc(p.p)}</b> · ${esc(p.c)}<br>2026: <b>${fmtMargin(p.m26)}</b> &nbsp; 2024: ${fmtMargin(p.m24)}<br>Shift: <b>${fmtMargin(p.sh)}</b> · ${(p.t || 0).toLocaleString()} votes`,
      ev.clientX - brect.left,
      ev.clientY - brect.top
    );
    return p;
  };
  svg.addEventListener('mousemove', pick);
  svg.addEventListener('mouseleave', () => {
    hl.setAttribute('r', 0);
    tip.hide();
  });
  svg.addEventListener('click', (ev) => {
    const p = pick(ev);
    if (p && opts.onPick) opts.onPick(p);
  });
}

/** Margin now (solid) and projected final margin (dashed) over the night. */
export function timelineChart(box, history) {
  const host = box.querySelector('.plot');
  host.innerHTML = '';
  const rows = (history || []).filter((h) => h[1] != null);
  if (rows.length < 2) {
    host.innerHTML = '<div class="empty">The timeline fills in as updates arrive.</div>';
    return;
  }
  const W = 460;
  const H = 300;
  const m = { l: 46, r: 56, t: 14, b: 30 };
  const t0 = rows[0][0];
  const t1 = rows[rows.length - 1][0];
  const vals = rows.flatMap((h) => [h[1], h[3]]).filter((v) => v != null);
  let lo = Math.min(0, ...vals);
  let hi = Math.max(0, ...vals);
  const pad = Math.max(2, (hi - lo) * 0.12);
  lo = Math.floor((lo - pad) / 5) * 5;
  hi = Math.ceil((hi + pad) / 5) * 5;
  const x = (t) => m.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - m.l - m.r);
  const y = (v) => m.t + ((hi - v) / (hi - lo)) * (H - m.t - m.b);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Race margin over time' });

  const span = hi - lo;
  const step = span > 60 ? 20 : span > 30 ? 10 : 5;
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    svg.append(el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), stroke: v === 0 ? '#aeb6c4' : '#edf0f5', 'stroke-width': 1 }));
    svg.append(el('text', { x: m.l - 6, y: y(v) + 3.5, 'text-anchor': 'end', 'font-size': 10.5, fill: '#6b7489' }, tickLabel(v)));
  }
  const fmtT = (t) => new Date(t * 1000).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
  const nT = 5;
  for (let i = 0; i <= nT; i++) {
    const t = t0 + ((t1 - t0) * i) / nT;
    svg.append(el('text', { x: x(t), y: H - 10, 'text-anchor': 'middle', 'font-size': 10.5, fill: '#6b7489' }, fmtT(t)));
  }
  const path = (idx) =>
    rows
      .filter((h) => h[idx] != null)
      .map((h, i) => `${i ? 'L' : 'M'}${x(h[0]).toFixed(1)},${y(h[idx]).toFixed(1)}`)
      .join('');
  svg.append(el('path', { d: path(3), fill: 'none', stroke: '#5b6680', 'stroke-width': 2, 'stroke-dasharray': '5 4' }));
  svg.append(el('path', { d: path(1), fill: 'none', stroke: '#13234b', 'stroke-width': 2 }));
  const last = rows[rows.length - 1];
  const labels = [
    { v: last[1], t: 'now', c: '#13234b' },
    { v: last[3], t: 'proj.', c: '#5b6680' },
  ].filter((l) => l.v != null);
  if (labels.length === 2 && Math.abs(y(labels[0].v) - y(labels[1].v)) < 12) {
    const mid = (y(labels[0].v) + y(labels[1].v)) / 2;
    const up = labels[0].v >= labels[1].v ? 0 : 1;
    labels[up].yy = mid - 7;
    labels[1 - up].yy = mid + 7;
  }
  for (const l of labels) {
    svg.append(el('text', { x: W - m.r + 4, y: (l.yy ?? y(l.v)) + 3.5, 'font-size': 10.5, fill: l.c, 'font-weight': 700 }, `${fmtMargin(l.v)} ${l.t}`));
  }
  const cross = el('line', { y1: m.t, y2: H - m.b, stroke: '#13234b', 'stroke-width': 1, 'stroke-opacity': 0, 'pointer-events': 'none' });
  svg.append(cross);
  host.append(svg);
  const tip = tooltip(box);
  svg.addEventListener('mousemove', (ev) => {
    const rect = svg.getBoundingClientRect();
    const sx = ((ev.clientX - rect.left) / rect.width) * W;
    let best = rows[0];
    for (const h of rows) if (Math.abs(x(h[0]) - sx) < Math.abs(x(best[0]) - sx)) best = h;
    cross.setAttribute('x1', x(best[0]));
    cross.setAttribute('x2', x(best[0]));
    cross.setAttribute('stroke-opacity', 0.35);
    const brect = box.getBoundingClientRect();
    tip.show(
      `<b>${fmtT(best[0])} ET</b><br>Now: <b>${fmtMargin(best[1])}</b><br>Projected: ${fmtMargin(best[3])}<br>Swing: ${fmtMargin(best[2])} · ${Math.round((best[4] || 0) * 100)}% in`,
      ev.clientX - brect.left,
      ev.clientY - brect.top
    );
  });
  svg.addEventListener('mouseleave', () => {
    cross.setAttribute('stroke-opacity', 0);
    tip.hide();
  });
}
