// 3D precinct map. Every precinct on the board is a line standing at (roughly) its location:
//   "Who leads":        height = share of the precinct's expected vote counted, color = who is ahead
//   "Shift since 2024": a vector whose length is the swing against 2024 (same precincts, same vote
//                        types), leaning west and blue for a Democratic shift, east and red for a
//                        Republican one.
// Results come by precinct, not polling place, and the 2024 data carries no coordinates, so each
// precinct is drawn at a fixed pseudo-random spot inside its county (county-level results stand at the
// county's center). Reads the same data as the board: summary.json plus races/<id>.json.
import { resolveSource, LiveSource, DemoSource } from './data.js';
import { ENVIRONMENTS, simulateRace } from './shared/demo.js';
import { geoCountyKey } from './shared/normalize.js';
import { fmtMargin } from './shared/model.js';

const cfg = window.TRACKER_CONFIG || {};
const D = window.deck;
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const KM = 1000;
const FULL_HEIGHT = 140 * KM; // a fully counted precinct at line height 1x
const FULL_SHIFT = 20; // points of swing drawn at full vector length
const VECTOR_LEN = 140 * KM;
const BLUE = [77, 141, 255];
const RED = [255, 90, 90];
const PALE = [205, 212, 228];
const AK_ALIASES = { CHUGACH: 'VALDEZCORDOVA', COPPERRIVER: 'VALDEZCORDOVA' }; // split in 2019

const touch = window.matchMedia?.('(pointer: coarse)').matches;

const state = {
  board: null,
  geo: null,
  counties: new Map(), // "ST|KEY" -> { polys, bbox, center }
  stateBoxes: new Map(), // "ST" -> { bbox, center }
  countyLists: new Map(), // "ST" -> [county entries], for the simulation's made-up counties
  places: new Map(), // "ST|county|precinct" -> [lon, lat]
  source: null,
  liveSource: null,
  fallbackDemo: false,
  summary: null,
  cache: new Map(), // race id -> { key, detail }
  points: [],
  stats: {},
  error: null,
  loading: false,
  lastOk: null,
  timer: null,
  playing: false,
  deck: null,
  view: null,
  opts: { mode: 'lead', chamber: 'house', base: 'pres', scale: 1 },
  pinned: null,
};

// ---------------------------------------------------------------- settings in the URL hash
function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  const o = state.opts;
  if (['lead', 'swing'].includes(h.get('mode'))) o.mode = h.get('mode');
  if (['house', 'senate'].includes(h.get('races'))) o.chamber = h.get('races');
  if (['pres', 'house'].includes(h.get('vs'))) o.base = h.get('vs');
  const sc = Number(h.get('h'));
  if (sc >= 0.25 && sc <= 4) o.scale = sc;
}
function writeHash() {
  const o = state.opts;
  const h = new URLSearchParams();
  if (o.mode !== 'lead') h.set('mode', o.mode);
  if (o.chamber !== 'house') h.set('races', o.chamber);
  if (o.base !== 'pres') h.set('vs', o.base);
  if (o.scale !== 1) h.set('h', String(o.scale));
  const s = h.toString();
  history.replaceState(null, '', s ? `#${s}` : location.pathname + location.search);
}

// ---------------------------------------------------------------- geography
function bboxOf(polys) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of polys) for (const [x, y] of p[0]) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}
function inRing(x, y, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function inPolys(x, y, polys) {
  for (const p of polys) {
    let c = false;
    for (const r of p) if (inRing(x, y, r)) c = !c;
    if (c) return true;
  }
  return false;
}
/** Area-weighted centroid of the largest polygon's outer ring. */
function centroid(polys) {
  let best = null;
  let bestA = -1;
  for (const p of polys) {
    const r = p[0];
    let a = 0, cx = 0, cy = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const f = r[j][0] * r[i][1] - r[i][0] * r[j][1];
      a += f;
      cx += (r[j][0] + r[i][0]) * f;
      cy += (r[j][1] + r[i][1]) * f;
    }
    if (Math.abs(a) > bestA && a !== 0) {
      bestA = Math.abs(a);
      best = [cx / (3 * a), cy / (3 * a)];
    }
  }
  return best;
}

function indexGeo(geo) {
  for (const f of geo.counties.features) {
    const g = f.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    const bbox = bboxOf(polys);
    let center = centroid(polys) || [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
    const entry = { polys, bbox, center, name: f.properties.name };
    if (!inPolys(center[0], center[1], polys)) center = entry.center = randomIn(entry, `${f.properties.fips}|center`) || center;
    state.counties.set(`${f.properties.st}|${f.properties.k}`, entry);
    if (!state.countyLists.has(f.properties.st)) state.countyLists.set(f.properties.st, []);
    state.countyLists.get(f.properties.st).push(entry);
  }
  for (const f of geo.states.features) {
    const g = f.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    const bbox = bboxOf(polys);
    state.stateBoxes.set(f.properties.st, { polys, bbox, center: centroid(polys) || [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2] });
  }
}

function hash32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function rng(seed) {
  let a = seed || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randomIn(entry, seedStr) {
  const r = rng(hash32(seedStr));
  const [x0, y0, x1, y1] = entry.bbox;
  for (let i = 0; i < 60; i++) {
    const x = x0 + r() * (x1 - x0);
    const y = y0 + r() * (y1 - y0);
    if (inPolys(x, y, entry.polys)) return [x, y];
  }
  return null;
}

function findCounty(st, county, raceId) {
  let k = geoCountyKey(county);
  if (st === 'AK' && AK_ALIASES[k]) k = AK_ALIASES[k];
  const hit = state.counties.get(`${st}|${k}`);
  if (hit) return { entry: hit, exact: true };
  // The simulation uses made-up county names; give each one a real county in the state.
  if (state.source?.kind === 'demo') {
    const list = state.countyLists.get(st);
    if (list?.length) return { entry: list[hash32(`${raceId}|${county}`) % list.length], exact: false };
  }
  return null;
}

/** Where to draw a unit: a fixed spot inside its county, the county's center for county-level results. */
function place(st, county, precinct, raceId) {
  const key = `${st}|${county}|${precinct ?? '*'}`;
  let pos = state.places.get(key);
  if (pos) return pos;
  const found = findCounty(st, county, raceId);
  if (found) {
    pos = precinct == null ? found.entry.center : randomIn(found.entry, key) || found.entry.center;
  } else {
    const sb = state.stateBoxes.get(st);
    if (!sb) return null;
    const r = rng(hash32(key));
    pos = [sb.center[0] + (r() - 0.5) * 0.8, sb.center[1] + (r() - 0.5) * 0.6];
    state.stats.unmatchedCounties = (state.stats.unmatchedCounties || 0) + 1;
  }
  state.places.set(key, pos);
  return pos;
}

// ---------------------------------------------------------------- data
function raceIds() {
  const senate = state.opts.chamber === 'senate';
  return Object.entries(state.board.races)
    .filter(([, r]) => (r.chamber === 'senate') === senate)
    .map(([id]) => id);
}

const changeKey = (s) => (s ? [s.votes?.T, s.margin, s.status, s.precincts?.full, s.precincts?.partial, s.match?.matched].join('|') : 'none');

async function pool(items, n, fn) {
  let i = 0;
  const run = async () => {
    while (i < items.length) await fn(items[i++]);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
}

async function raceDetail(id) {
  const src = state.source;
  // The board's demo source also simulates each race's history; the map needs only the current state.
  if (src.kind === 'demo') return simulateRace(src.demo, id, src.minutes, src.env).detail;
  return src.race(id);
}

async function refresh() {
  if (state.loading) return;
  state.loading = true;
  try {
    const s = await state.source.summary();
    state.summary = s;
    state.error = null;
    state.lastOk = Date.now();
    const todo = raceIds().filter((id) => state.cache.get(id)?.key !== changeKey(s.races?.[id]));
    await pool(todo, state.source.kind === 'demo' ? 64 : 6, async (id) => {
      const key = changeKey(s.races?.[id]);
      try {
        state.cache.set(id, { key, detail: await raceDetail(id) });
      } catch (e) {
        if (!e.noData) console.warn(id, e);
        state.cache.set(id, { key, detail: null });
      }
    });
  } catch (e) {
    state.error = e.message;
    if (e.noData && state.source.kind !== 'demo' && cfg.demoWhenNoData !== false) {
      switchToDemo(e.message);
      state.loading = false;
      return refresh();
    }
  } finally {
    state.loading = false;
  }
  rebuild();
}

function switchToDemo(reason) {
  state.liveSource = state.source;
  state.source = new DemoSource(state.board, cfg.defaultDemoEnv || 'wave');
  state.fallbackDemo = true;
  state.error = reason;
  state.cache.clear();
  renderDemoControls();
}

function expectedShare(row, county, turnout) {
  if (row.s === 'F') return 1;
  if (row.s === 'N' || !row.t) return 0;
  if (row.lvl === 'county') return county?.ep ?? 0.5;
  if (row.bt) return Math.min(0.97, Math.max(0.03, row.t / (row.bt * turnout)));
  return 0.5;
}

function buildPoints() {
  const pts = [];
  const seen = new Set();
  const stats = { races: 0, units: 0, reporting: 0, compared: 0, batches: 0, unmatchedCounties: 0, noData: 0 };
  state.stats = stats;
  for (const id of raceIds()) {
    const det = state.cache.get(id)?.detail;
    if (!det) {
      stats.noData += 1;
      continue;
    }
    const an = (state.opts.base === 'house' && det.analyses?.house) || det.analyses?.pres;
    if (!an) continue;
    stats.races += 1;
    const st = id.slice(0, 2);
    const turnout = an.summary?.turnout || 0.8;
    const counties = new Map((an.counties || []).map((k) => [k.c, k]));
    for (const r of an.units || []) {
      if (r.v) {
        stats.batches += 1; // absentee / early-vote batches have no location
        continue;
      }
      const isCounty = r.lvl === 'county';
      const key = `${st}|${r.c}|${isCounty ? '*' : r.p}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const pos = place(st, r.c, isCounty ? null : r.p, id);
      if (!pos) continue;
      const pct = expectedShare(r, counties.get(r.c), turnout);
      stats.units += 1;
      if (r.t > 0) stats.reporting += 1;
      if (r.sh != null) stats.compared += 1;
      pts.push({ id, st, c: r.c, p: r.p, county: isCounty, pos, pct, m: r.m, bm: r.bm, sh: r.sh, t: r.t || 0, s: r.s });
    }
  }
  return pts;
}

// ---------------------------------------------------------------- drawing
const mix = (a, b, t) => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));
function leadColor(m) {
  if (m == null || Math.abs(m) < 0.05) return [...PALE, 230];
  const t = Math.min(1, Math.abs(m) / 30);
  return [...mix(PALE, m > 0 ? BLUE : RED, 0.45 + 0.55 * t), 240];
}
function shiftColor(sh) {
  const t = Math.min(1, Math.abs(sh) / FULL_SHIFT);
  return [...mix(PALE, sh > 0 ? BLUE : RED, 0.35 + 0.65 * t), 240];
}
function target(d) {
  const [lon, lat] = d.pos;
  const sc = state.opts.scale;
  if (state.opts.mode === 'lead') return [lon, lat, Math.max(0.02, d.pct) * FULL_HEIGHT * sc];
  const len = (Math.min(Math.abs(d.sh), FULL_SHIFT * 2) / FULL_SHIFT) * VECTOR_LEN * sc;
  const east = (d.sh > 0 ? -1 : 1) * len * 0.5; // Democratic shift leans west
  return [lon + east / (111320 * Math.cos((lat * Math.PI) / 180)), lat, len * 0.866];
}

function drawn(d) {
  return state.opts.mode === 'lead' ? d.t > 0 : d.sh != null && d.sh !== 0;
}

function layers() {
  const geo = state.geo;
  const boardStates = new Set(raceIds().map((id) => id.slice(0, 2)));
  const pts = state.points;
  const lines = pts.filter(drawn);
  const dots = pts.filter((d) => !drawn(d));
  const { mode, scale, base } = state.opts;
  return [
    new D.GeoJsonLayer({
      id: 'states',
      data: geo.states,
      filled: true,
      stroked: true,
      getFillColor: (f) => (boardStates.has(f.properties.st) ? [24, 38, 68] : [16, 24, 42]),
      getLineColor: [92, 112, 156],
      lineWidthUnits: 'pixels',
      getLineWidth: 1.2,
      updateTriggers: { getFillColor: [state.opts.chamber] },
    }),
    new D.GeoJsonLayer({
      id: 'counties',
      data: geo.counties,
      filled: false,
      stroked: true,
      getLineColor: [70, 88, 128, 150],
      lineWidthUnits: 'pixels',
      getLineWidth: 0.6,
    }),
    new D.ScatterplotLayer({
      id: 'waiting',
      data: dots,
      getPosition: (d) => d.pos,
      getRadius: 400,
      radiusMinPixels: 1.2,
      radiusMaxPixels: 3,
      getFillColor: [125, 138, 170, 150],
      pickable: true,
    }),
    new D.LineLayer({
      id: 'lines',
      data: lines,
      getSourcePosition: (d) => [d.pos[0], d.pos[1], 0],
      getTargetPosition: target,
      getColor: (d) => (mode === 'lead' ? leadColor(d.m) : shiftColor(d.sh)),
      getWidth: (d) => (d.county ? 5 : 2),
      widthUnits: 'pixels',
      pickable: true,
      updateTriggers: { getTargetPosition: [mode, scale, base], getColor: [mode, base] },
    }),
  ];
}

function render() {
  if (!state.deck) return;
  state.deck.setProps({ layers: layers() });
  renderLegend();
  renderStatus();
}

function rebuild() {
  state.points = buildPoints();
  render();
  if (state.pinned) showTip(state.pinned.obj, state.pinned.x, state.pinned.y);
}

// ---------------------------------------------------------------- panel
function renderLegend() {
  const el = $('#legend');
  if (state.opts.mode === 'lead') {
    el.innerHTML = `
      <div><span class="sw" style="background:rgb(${BLUE})"></span>Democrat ahead <span class="sw" style="background:rgb(${RED});margin-left:10px"></span>Republican ahead</div>
      <div>Paler = closer. <b>Height</b> = share of the precinct's expected vote counted (top = all in).</div>
      <div><span class="sw" style="background:#7d8aaa;width:6px;height:6px;border-radius:50%"></span>dot = no votes reported yet</div>`;
  } else {
    el.innerHTML = `
      <div class="ramp" style="background:linear-gradient(90deg, rgb(${BLUE}), rgb(${PALE}), rgb(${RED}))"></div>
      <div class="ends"><span>← bluer than 2024</span><span>redder than 2024 →</span></div>
      <div><b>Length</b> = size of the shift (full length = ${FULL_SHIFT} pts). Lines lean west for a Democratic
        shift, east for a Republican one. Only the same precincts and vote types are compared.</div>
      <div><span class="sw" style="background:#7d8aaa;width:6px;height:6px;border-radius:50%"></span>dot = not comparable yet</div>`;
  }
}

function renderStatus() {
  const el = $('#status');
  const s = state.stats;
  const kind = state.source?.kind;
  const testData = kind !== 'demo' && state.summary?.mode === 'demo';
  const tag =
    kind === 'demo'
      ? `<span class="demo">SIMULATION</span>${state.fallbackDemo ? ' (no live results yet)' : ''}`
      : testData
        ? '<span class="demo">TEST DATA (simulated)</span>'
        : '<span class="live">LIVE</span>';
  const when = state.summary?.generatedAt
    ? new Date(state.summary.generatedAt).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }) + ' ET'
    : '';
  const n = (x) => (x || 0).toLocaleString('en-US');
  const what = state.opts.mode === 'lead' ? `${n(s.reporting)} reporting` : `${n(s.compared)} compared with 2024`;
  let html = `${tag}${when ? ` · ${when}` : ''}<br><b>${n(s.units)}</b> precincts in ${s.races || 0} ${state.opts.chamber === 'senate' ? 'Senate' : 'House'} races · <b>${what}</b>`;
  if (s.batches) html += `<br>${n(s.batches)} absentee/early-vote batches have no location and aren't drawn.`;
  if (s.noData) html += `<br>${s.noData} race${s.noData === 1 ? '' : 's'} with no data yet.`;
  if (kind !== 'demo' && !s.reporting) html += `<br>No votes counted yet. <a href="?demo" style="color:#8ab4ff">Preview with simulated returns</a>.`;
  if (state.error && kind !== 'demo') html += `<br><span class="err">${esc(state.error)}</span>`;
  el.innerHTML = html;
}

function renderDemoControls() {
  const el = $('#democtl');
  const src = state.source;
  if (!src || src.kind !== 'demo') {
    el.innerHTML = '';
    el.style.display = 'none';
    return;
  }
  el.style.display = '';
  const opts = Object.entries(ENVIRONMENTS)
    .map(([k, v]) => `<option value="${k}" ${k === src.env ? 'selected' : ''}>${esc(v.label)}</option>`)
    .join('');
  el.className = 'democtl';
  el.innerHTML = `<div class="top"><b>Simulated night</b><button type="button" id="dplay">${state.playing ? '❚❚ Pause' : '▶ Play'}</button><span id="dclock"></span></div>
    <input type="range" id="dslider" min="-10" max="480" step="5" value="${src.minutes}" aria-label="Simulated time" />
    <label>Environment <select id="denv">${opts}</select></label>`;
  const setClock = () => {
    const d = new Date(Date.UTC(2026, 10, 3, 23, 0, 0) + src.minutes * 60000);
    $('#dclock').textContent = d.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }) + ' ET';
  };
  setClock();
  state._setClock = setClock;
  $('#dslider').oninput = (e) => {
    src.minutes = Number(e.target.value);
    setClock();
    refresh();
  };
  $('#denv').onchange = (e) => {
    src.env = e.target.value;
    state.cache.clear();
    refresh();
  };
  $('#dplay').onclick = () => {
    state.playing = !state.playing;
    $('#dplay').textContent = state.playing ? '❚❚ Pause' : '▶ Play';
  };
}

function bindPanel() {
  const sync = () => {
    for (const b of document.querySelectorAll('[data-mode]')) {
      const on = b.dataset.mode === state.opts.mode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
    for (const b of document.querySelectorAll('[data-chamber]')) {
      const on = b.dataset.chamber === state.opts.chamber;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
    $('#base').value = state.opts.base;
    $('#scale').value = String(state.opts.scale);
  };
  sync();
  for (const b of document.querySelectorAll('[data-mode]'))
    b.onclick = () => {
      state.opts.mode = b.dataset.mode;
      sync();
      writeHash();
      hideTip();
      render();
    };
  for (const b of document.querySelectorAll('[data-chamber]'))
    b.onclick = () => {
      state.opts.chamber = b.dataset.chamber;
      sync();
      writeHash();
      hideTip();
      rebuild();
      refresh();
    };
  $('#base').onchange = (e) => {
    state.opts.base = e.target.value;
    writeHash();
    rebuild();
  };
  $('#scale').oninput = (e) => {
    state.opts.scale = Number(e.target.value);
    writeHash();
    render();
  };
  const panel = $('#panel');
  const toggle = (closed) => {
    panel.classList.toggle('closed', closed);
    $('#collapse').setAttribute('aria-expanded', String(!closed));
    $('#collapse').title = closed ? 'Show controls' : 'Hide controls';
  };
  $('#collapse').onclick = () => toggle(!panel.classList.contains('closed'));
  if (window.innerWidth < 600) toggle(true);
  $('#hint').textContent = touch
    ? 'Pinch to zoom · two-finger drag to rotate & tilt · tap a line'
    : 'Drag to move · scroll to zoom · right-drag or Ctrl+drag to rotate and tilt · hover a line';
}

// ---------------------------------------------------------------- tooltip
function tipHtml(d) {
  const race = state.board.races[d.id] || {};
  const where = d.county ? `${esc(d.c)} County (county total)` : `${esc(d.p)}`;
  const cls = (m) => (m == null ? '' : m > 0 ? 't-D' : m < 0 ? 't-R' : '');
  const base = state.opts.base === 'house' ? '2024 House' : '2024 Pres';
  const pct = d.t > 0 ? `${d.pct >= 1 ? 'all' : `~${Math.round(d.pct * 100)}%`} · ${d.t.toLocaleString('en-US')} votes` : 'none yet';
  return `<div class="h">${where}</div>
    <div class="s">${d.county ? '' : `${esc(d.c)} County · `}${esc(d.id)}${race.name ? ` · ${esc(race.name)}` : ''}</div>
    <table>
      <tr><td>2026 so far</td><td class="${cls(d.m)}">${d.t > 0 ? fmtMargin(d.m) : '—'}</td></tr>
      <tr><td>${base}</td><td class="${cls(d.bm)}">${fmtMargin(d.bm)}</td></tr>
      <tr><td>Shift</td><td class="${cls(d.sh)}">${d.sh == null ? 'not comparable yet' : fmtMargin(d.sh)}</td></tr>
      <tr><td>Counted</td><td>${pct}</td></tr>
    </table>`;
}
function showTip(d, x, y) {
  const el = $('#tip');
  el.innerHTML = tipHtml(d);
  el.style.display = 'block';
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  el.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, x + 14))}px`;
  el.style.top = `${Math.max(8, Math.min(window.innerHeight - h - 8, y + 14))}px`;
}
function hideTip() {
  $('#tip').style.display = 'none';
  state.pinned = null;
}

// ---------------------------------------------------------------- camera
function homeView() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const narrow = w < 600;
  // About 58 degrees of longitude (the lower 48) across ~85% of the narrower screen dimension.
  // On wide screens the control panel covers the left edge, so aim a little west to push the map right.
  const panel = narrow ? 0 : 320;
  const span = narrow ? Math.min(w * 1.15, h * 0.9) : Math.min((w - panel) * 0.95, h * 1.5);
  const zoom = Math.log2(span / ((58 / 360) * 512));
  const lonPerPx = 360 / (512 * 2 ** zoom);
  return { longitude: -95.5 - (panel / 2) * lonPerPx, latitude: narrow ? 35.5 : 37.2, zoom, pitch: 50, bearing: -8, minZoom: 1.5, maxZoom: 13, maxPitch: 80 };
}

function nudge(kind) {
  const v = { ...(state.view || homeView()) };
  if (kind === 'zoomin') v.zoom += 0.6;
  if (kind === 'zoomout') v.zoom -= 0.6;
  if (kind === 'left') v.bearing -= 20;
  if (kind === 'right') v.bearing += 20;
  if (kind === 'up') v.pitch = Math.min(80, v.pitch + 12);
  if (kind === 'down') v.pitch = Math.max(0, v.pitch - 12);
  const next = kind === 'reset' ? homeView() : v;
  state.view = next;
  state.deck.setProps({ initialViewState: { ...next, transitionDuration: 350 } });
}

function initDeck() {
  const view = homeView();
  state.view = view;
  state.deck = new D.Deck({
    parent: $('#map'),
    views: new D.MapView({ repeat: false }),
    initialViewState: view,
    controller: { dragRotate: true, multiTouchDrag: 'rotate', touchZoom: true, scrollZoom: true, keyboard: true, inertia: 300, doubleClickZoom: true },
    useDevicePixels: Math.min(2, window.devicePixelRatio || 1),
    pickingRadius: touch ? 14 : 6,
    layers: [],
    onViewStateChange: ({ viewState }) => {
      state.view = viewState;
      if (state.pinned) hideTip();
    },
    getCursor: ({ isHovering, isDragging }) => (isDragging ? 'grabbing' : isHovering ? 'pointer' : 'grab'),
    onHover: (info) => {
      if (touch || state.pinned) return;
      if (info.object) showTip(info.object, info.x, info.y);
      else $('#tip').style.display = 'none';
    },
    onClick: (info) => {
      if (info.object) {
        state.pinned = { obj: info.object, x: info.x, y: info.y };
        showTip(info.object, info.x, info.y);
      } else hideTip();
    },
  });
  for (const b of document.querySelectorAll('[data-nav]')) b.onclick = () => nudge(b.dataset.nav);
  window.addEventListener('resize', () => state.deck.redraw(true));
}

// ---------------------------------------------------------------- loop
function schedule() {
  clearInterval(state.timer);
  const ps = cfg.pollSeconds || {};
  let tick = 0;
  state.timer = setInterval(async () => {
    tick += 1;
    const src = state.source;
    if (src.kind === 'demo') {
      if (state.playing && tick % 2 === 0) {
        src.minutes = Math.min(480, src.minutes + 5);
        const sl = $('#dslider');
        if (sl) sl.value = src.minutes;
        state._setClock?.();
        await refresh();
        if (src.minutes >= 480) state.playing = false;
      }
      if (state.fallbackDemo && tick % 120 === 0) await tryLive();
      return;
    }
    if (tick % (ps[src.kind] || 30) === 0) await refresh();
  }, 1000);
}

async function tryLive() {
  if (!state.liveSource) return;
  try {
    await state.liveSource.summary();
    state.source = state.liveSource;
    state.liveSource = null;
    state.fallbackDemo = false;
    state.cache.clear();
    renderDemoControls();
    await refresh();
  } catch {
    /* still nothing published */
  }
}

async function main() {
  readHash();
  bindPanel();
  initDeck();
  const [board, geo] = await Promise.all([
    fetch('board.json', { cache: 'no-cache' }).then((r) => r.json()),
    fetch('geo/us-map.json').then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status} loading the map shapes`);
      return r.json();
    }),
  ]);
  state.board = board;
  state.geo = geo;
  indexGeo(geo);
  const q = new URLSearchParams(location.search);
  const src = resolveSource(cfg);
  if (src.kind === 'demo') {
    state.source = new DemoSource(board, q.get('env') || cfg.defaultDemoEnv || 'wave');
    if (q.get('t')) state.source.minutes = Number(q.get('t'));
  } else state.source = new LiveSource(src);
  $('.back').href = `./${location.search}`;
  renderDemoControls();
  render();
  await refresh();
  schedule();
}

main().catch((e) => {
  $('#status').innerHTML = `<span class="err">Could not start the map: ${esc(e.message)}</span>`;
  console.error(e);
});
