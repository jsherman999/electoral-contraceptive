import { resolveSource, LiveSource, DemoSource } from './data.js';
import { ENVIRONMENTS, minutesAfterSix, demoClockIso } from './shared/demo.js';
import { nationalSwing, fmtMargin } from './shared/model.js';
import { openRaceModal, openCompositeModal, refreshModal, closeModal, modalState } from './modal.js';
import { defaultSignal, raceSignal, compositeSignal, senateTally, isHit } from './signals.js';

const cfg = window.TRACKER_CONFIG || {};
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const state = {
  board: null,
  source: null,
  liveSource: null,
  summary: null,
  fallbackDemo: false,
  error: null,
  lastOk: null,
  timer: null,
  playing: false,
};

function cardSignal(card, colId) {
  const races = state.summary?.races || {};
  if (card.composite) return compositeSignal(state.board.composites[card.composite], races);
  const sig = card.signal || defaultSignal(colId, state.board);
  return raceSignal(races[card.race], sig);
}

function tallies() {
  const out = {};
  for (const col of state.board.columns) out[col.id] = { hit: 0, reporting: 0, total: 0 };
  for (const row of state.board.rows) {
    for (const [colId, cards] of Object.entries(row.cells || {})) {
      for (const card of cards) {
        const s = cardSignal(card, colId).state;
        const t = out[colId];
        t.total += 1;
        if (s !== 'pending') t.reporting += 1;
        if (isHit(s)) t.hit += 1;
      }
    }
  }
  return out;
}

function verdict(t) {
  const share = (x) => (x.reporting ? x.hit / x.reporting : 0);
  const any = Object.values(t).some((x) => x.reporting > 0);
  if (!any) return { cls: '', text: 'Waiting for returns' };
  if (t.riptide && t.riptide.hit >= 1 && share(t.riptide) >= 0.5) return { cls: 'riptide', text: 'Tracking: RED RIPTIDE' };
  for (const id of ['tsunami', 'wave', 'tide']) {
    const x = t[id];
    if (x && x.reporting >= 2 && share(x) >= 0.5) {
      const col = state.board.columns.find((c) => c.id === id);
      return { cls: id, text: `Tracking: ${col.title}` };
    }
  }
  if (t.tide && t.tide.reporting >= 2) return { cls: 'riptide', text: 'Tracking: GOP holding' };
  return { cls: '', text: 'Too early to tell' };
}

// ---------------------------------------------------------------- clock
function nowIso() {
  if (state.source && state.source.kind === 'demo') return demoClockIso(state.source.minutes);
  return new Date().toISOString();
}
function minutesNow() {
  if (state.source && state.source.kind === 'demo') return state.source.minutes;
  // minutes after 6 pm ET on election day
  const base = Date.UTC(2026, 10, 3, 23, 0, 0);
  return (Date.now() - base) / 60000;
}
function fmtClock(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const hh = ((h + 11) % 12) + 1;
  return `${hh}:${String(m).padStart(2, '0')}`;
}
const ampm = (hhmm) => (Number(String(hhmm).split(':')[0]) >= 24 ? 'AM ET' : 'PM ET');
function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: '2-digit' }) + ' ET';
}

// ---------------------------------------------------------------- render: static board
function renderBoard() {
  const b = state.board;
  $('#headline').textContent = b.title;
  $('#chamber').textContent = b.chamber || 'HOUSE';
  const board = $('#board');
  board.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'timehead';
  head.innerHTML = 'POLLS CLOSE<small>Eastern time</small>';
  board.append(head);
  for (const col of b.columns) {
    const h = document.createElement('div');
    h.className = `colhead ${col.id}`;
    h.innerHTML = `<h2>${esc(col.title)}</h2><div class="sub">${esc(col.sub)}</div><div class="tally" id="tally-${col.id}">—</div>`;
    board.append(h);
  }
  b.rows.forEach((row, ri) => {
    const tc = document.createElement('div');
    tc.className = 'timecell';
    tc.dataset.time = row.time;
    tc.innerHTML = `<div class="t">${fmtClock(row.time)}</div><div class="pm">${ampm(row.time)}</div><div class="st">${esc(row.states)}</div><div class="countdown"></div>`;
    board.append(tc);
    for (const col of b.columns) {
      const cell = document.createElement('div');
      cell.className = `cell ${col.id}`;
      cell.dataset.col = col.title;
      for (const card of row.cells[col.id] || []) cell.append(makeCard(card, col.id, row.time));
      board.append(cell);
    }
  });

  const later = $('#later');
  later.innerHTML = '';
  if (b.later && b.later.length) {
    const lbl = document.createElement('div');
    lbl.className = 'lbl';
    lbl.textContent = 'LATER';
    const pills = document.createElement('div');
    pills.className = 'pills';
    for (const grp of b.later) {
      const g = document.createElement('div');
      g.className = 'grp';
      const row = document.createElement('div');
      row.className = 'row';
      for (const id of grp.races) row.append(makeCard({ race: id }, 'later', grp.time, true));
      g.innerHTML = `<div class="tm">${fmtClock(grp.time)} PM ET</div>`;
      g.append(row);
      pills.append(g);
    }
    if (b.laterCaption) {
      const cap = document.createElement('div');
      cap.className = 'caption';
      cap.textContent = b.laterCaption;
      pills.append(cap);
    }
    later.append(lbl, pills);
  }
  $('#footnote').textContent = b.footnote || '';
  renderSenate();
}

// ---------------------------------------------------------------- render: senate section
function renderSenate() {
  const sec = state.board.senate;
  const host = $('#senate');
  if (!sec || !host) return;
  host.innerHTML = `
    <div class="boardhead senatehead">
      <div class="chamber">${esc(sec.title || 'SENATE')}</div>
      <div class="senate-tally"><span id="senate-tally">—</span> <span class="verdict" id="senate-verdict">Waiting for returns</span></div>
    </div>
    <p class="senate-note">${esc(sec.note || '')}</p>
    <div class="board senate-board" id="senate-board"></div>`;
  const grid = $('#senate-board');
  const head = document.createElement('div');
  head.className = 'timehead';
  head.innerHTML = 'POLLS CLOSE<small>Eastern time</small>';
  grid.append(head);
  for (const col of sec.columns) {
    const h = document.createElement('div');
    h.className = `colhead senate-${col.id}`;
    h.innerHTML = `<h2>${esc(col.title)}</h2><div class="sub">${esc(col.sub || '')}</div><div class="tally" id="stally-${col.id}">—</div>`;
    grid.append(h);
  }
  for (const row of sec.rows) {
    const tc = document.createElement('div');
    tc.className = 'timecell';
    tc.dataset.time = row.time;
    tc.innerHTML = `<div class="t">${fmtClock(row.time)}</div><div class="pm">${ampm(row.time)}</div><div class="st">${esc(row.states)}</div><div class="countdown"></div>`;
    grid.append(tc);
    for (const col of sec.columns) {
      const cell = document.createElement('div');
      cell.className = `cell senate-${col.id}`;
      cell.dataset.col = col.title;
      for (const card of (row.cells || {})[col.id] || []) cell.append(makeCard({ ...card, signal: card.signal || { party: col.party || 'D' } }, `senate:${col.id}`, row.time));
      grid.append(cell);
    }
  }
}

function updateSenate() {
  const sec = state.board.senate;
  if (!sec || !$('#senate-tally')) return;
  const t = senateTally(sec, state.summary?.races || {});
  const need = sec.needed || 4;
  $('#senate-tally').textContent = t.reporting
    ? `Projected Democratic net gain: ${t.net >= 0 ? '+' : ''}${t.net} of +${need} needed`
    : `Democrats need a net +${need}`;
  const v = $('#senate-verdict');
  v.className = 'verdict';
  if (!t.reporting) v.textContent = 'Waiting for returns';
  else if (t.net >= need) {
    v.classList.add('wave');
    v.textContent = 'Tracking: DEM MAJORITY';
  } else if (t.net + t.pending < need) {
    v.classList.add('riptide');
    v.textContent = 'Tracking: GOP HOLDS SENATE';
  } else v.textContent = 'Senate in play';
  const sh = $('#stally-hold');
  if (sh) sh.textContent = t.losses ? `${t.losses} at risk` : t.holds ? 'holding' : '—';
  const sf = $('#stally-flip');
  if (sf) sf.textContent = t.reporting ? `${t.pickups} of ${t.targets} flipping` : `${t.targets} targets`;
}

let cardSeq = 0;
function makeCard(card, colId, time, isLater = false) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'card';
  el.dataset.col = colId;
  el.dataset.time = time;
  el.dataset.seq = String(cardSeq++);
  el._card = card;
  if (card.composite) {
    const comp = state.board.composites[card.composite];
    el.classList.add('dashed');
    el.innerHTML = `<div class="code">${esc(comp.title)} <span class="check">✓</span></div><div class="who">${esc(comp.sub)}</div><div class="live"></div><div class="bar"><i></i></div>`;
    el.addEventListener('click', () => openCompositeModal(card.composite, ctx()));
  } else {
    const meta = state.board.races[card.race] || {};
    if (card.dashed) el.classList.add('dashed');
    else el.classList.add(meta.holder === 'D' ? 'D' : 'R');
    const star = meta.redrawn ? '<span class="star" title="Redrawn since 2024">★</span>' : '';
    const who = card.label || meta.name || '';
    el.innerHTML = `<div class="code">${esc(meta.code || card.race)}${star} <span class="check">✓</span></div><div class="who">${esc(who)}</div><div class="live"></div><div class="bar"><i></i></div><span class="badge" hidden></span>`;
    const sig = card.signal || (isLater ? { party: 'D' } : defaultSignal(colId, state.board));
    el._sig = sig;
    el.addEventListener('click', () => openRaceModal(card.race, ctx(), { signal: sig, label: card.label, colId }));
  }
  return el;
}

// ---------------------------------------------------------------- render: live data
function updateCards() {
  const races = state.summary?.races || {};
  const mins = minutesNow();
  document.querySelectorAll('.card').forEach((el) => {
    const card = el._card;
    if (!card) return;
    el.classList.remove('hit', 'hit-strong', 'miss', 'miss-strong');
    const live = $('.live', el);
    const bar = $('.bar i', el);
    if (card.composite) {
      const comp = state.board.composites[card.composite];
      const cs = compositeSignal(comp, races);
      if (cs.state !== 'pending') el.classList.add(cs.state);
      const dots = cs.members
        .map((m) => {
          const s = m.sum;
          const lead = s && s.call ? s.call.party : s && s.votes && s.votes.T ? s.projection.leader : null;
          return `<i class="${lead || 'pend'}" title="${esc(m.id)}"></i>`;
        })
        .join('');
      const reporting = cs.members.filter((m) => m.sum && m.sum.votes && m.sum.votes.T).length;
      const partyLead = cs.members.filter((m) => {
        const s = m.sum;
        return s && ((s.call && s.call.party === comp.party) || (!s.call && s.votes?.T && s.projection.leader === comp.party));
      }).length;
      live.innerHTML = `<span class="dots">${dots}</span>${reporting ? `<span class="pct">${comp.party} ahead ${partyLead}/${comp.races.length}</span>` : `<span class="wait">${comp.races.length} races</span>`}`;
      const ep = avg(cs.members.map((m) => m.sum?.projection?.expectedPct || 0));
      bar.style.width = `${Math.round(ep * 100)}%`;
      el.title = `${comp.title}: ${comp.sub}. ${comp.party} ahead in ${partyLead} of ${comp.races.length}.`;
      return;
    }
    const id = card.race;
    const s = races[id];
    const meta = state.board.races[id] || {};
    const sig = raceSignal(s, el._sig);
    if (sig.state !== 'pending') el.classList.add(sig.state);
    const badge = $('.badge', el);
    badge.hidden = true;
    badge.className = 'badge';
    const close = minutesAfterSix(meta.close || el.dataset.time);
    if (!s || !s.votes || !s.votes.T) {
      const closed = mins >= close;
      live.innerHTML = `<span class="wait">${closed ? (s ? 'Awaiting first votes' : 'No feed yet') : `Polls close ${fmtClock(meta.close || el.dataset.time)}`}</span>`;
      bar.style.width = '0%';
      el.title = `${id} · ${meta.name || ''} (${meta.holder || '?'}-held)`;
      return;
    }
    const lead = s.margin > 0 ? 'D' : s.margin < 0 ? 'R' : 'E';
    const ep = s.projection.expectedPct || 0;
    const pctTxt = s.status === 'complete' ? 'all in' : `${Math.round(ep * 100)}% in`;
    const sw = s.swing == null ? '' : `<span class="swing" title="Swing vs 2024 in the same precincts">${s.swing >= 0 ? '▲D' : '▲R'}${Math.abs(s.swing).toFixed(1)}</span>`;
    live.innerHTML = `<span class="pill ${lead}">${fmtMargin(s.margin)}</span><span class="pct">${pctTxt}</span>${sw}`;
    bar.style.width = `${Math.round((s.status === 'complete' ? 1 : ep) * 100)}%`;
    const projLeader = s.call ? s.call.party : s.projection.leader;
    const confident = s.call || ['lean', 'likely', 'clear'].includes(s.projection.confidence) || s.status === 'complete';
    if (s.call) {
      badge.hidden = false;
      badge.classList.add('call');
      badge.textContent = `✓ ${s.call.party}`;
    } else if (confident && projLeader && meta.holder && projLeader !== meta.holder && !card.dashed) {
      badge.hidden = false;
      badge.classList.add('flip');
      badge.textContent = 'FLIP';
    }
    const p = s.projection;
    el.title =
      `${id} · ${meta.name || ''} (${meta.holder}-held)\n` +
      `Now: ${fmtMargin(s.margin)} with ${Math.round(ep * 100)}% of expected vote\n` +
      `Swing vs 2024 (same precincts): ${s.swing == null ? 'n/a' : fmtMargin(s.swing)}\n` +
      `Projected: ${fmtMargin(p.margin)} (${fmtMargin(p.low)} to ${fmtMargin(p.high)}) · ${p.confidence}`;
  });

  // countdowns on time cells
  document.querySelectorAll('.timecell').forEach((tc) => {
    const close = minutesAfterSix(tc.dataset.time);
    const d = close - mins;
    const cd = $('.countdown', tc);
    if (d > 0) {
      tc.classList.remove('closed');
      cd.textContent = d > 120 ? `in ${Math.round(d / 60)}h` : `in ${Math.max(1, Math.round(d))}m`;
      cd.hidden = mins < -24 * 60;
    } else {
      tc.classList.add('closed');
      cd.hidden = false;
      cd.textContent = 'closed';
    }
  });

  const t = tallies();
  for (const col of state.board.columns) {
    const x = t[col.id];
    const el = $(`#tally-${col.id}`);
    if (el) el.textContent = x.reporting ? `${x.hit} of ${x.total} hitting · ${x.reporting} reporting` : `${x.total} signals`;
  }
  renderStatus(t);
  updateSenate();
}

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

function renderStatus(t) {
  const sb = $('#statusbar');
  const races = state.summary?.races || {};
  const ns = nationalSwing(Object.values(races));
  const counting = Object.values(races).filter((r) => r.votes && r.votes.T).length;
  const v = verdict(t);
  const kind = state.source?.kind;
  const testData = kind !== 'demo' && state.summary?.mode === 'demo';
  const dotCls = state.error ? 'err' : kind === 'demo' || testData ? 'demo' : 'live';
  const srcTxt = kind === 'demo' ? 'SIMULATION' : testData ? 'TEST DATA (simulated)' : 'LIVE';
  const upd = state.summary?.generatedAt;
  sb.innerHTML = `
    <span class="src"><span class="dot ${dotCls}"></span>${srcTxt}</span>
    <span class="metric">Updated <b>${fmtTime(upd)}</b></span>
    <span class="metric">Avg swing vs 2024: <b class="${ns.swing > 0 ? 't-D' : ns.swing < 0 ? 't-R' : ''}">${ns.swing == null ? '—' : fmtMargin(ns.swing)}</b> <span title="Square-root vote-weighted average of race swings, same precincts and vote types">(${ns.races} races)</span></span>
    <span class="metric">Counting: <b>${counting}</b> of ${Object.keys(state.board.races).length}</span>
    <span class="spacer"></span>
    <span class="verdict ${v.cls}">${esc(v.text)}</span>`;
}

function renderBanner() {
  const el = $('#banner');
  if (state.fallbackDemo) {
    el.innerHTML = `<div class="banner">No live results have been published yet${state.error ? ` (${esc(state.error)})` : ''}, so this is a <b>simulation</b>. The board switches to live data automatically once the collector publishes. <button class="linkbtn" id="retry">Check now</button></div>`;
    $('#retry').onclick = () => tryLive(true);
  } else if (state.error && state.summary) {
    el.innerHTML = `<div class="banner err">Last refresh failed: ${esc(state.error)}. Showing data from ${fmtTime(state.summary.generatedAt)}.</div>`;
  } else if (state.source?.kind !== 'demo' && state.summary?.mode === 'demo') {
    el.innerHTML = `<div class="banner">The collector published <b>simulated test data</b>. Real results replace it on the first live pass.</div>`;
  } else if (state.source?.kind === 'demo') {
    el.innerHTML = `<div class="banner">Simulation mode: every number below is synthetic. <a href="${location.pathname}">Switch to live results</a></div>`;
  } else el.innerHTML = '';
}

function renderDemoControls() {
  const el = $('#democtl');
  if (!state.source || state.source.kind !== 'demo') {
    el.innerHTML = '';
    return;
  }
  const src = state.source;
  const opts = Object.entries(ENVIRONMENTS)
    .map(([k, v]) => `<option value="${k}" ${k === src.env ? 'selected' : ''}>${esc(v.label)}</option>`)
    .join('');
  el.innerHTML = `<div class="democtl">
      <b>Simulated night</b>
      <button type="button" id="dplay">${state.playing ? '❚❚ Pause' : '▶ Play'}</button>
      <span class="clock" id="dclock"></span>
      <input type="range" id="dslider" min="-10" max="480" step="5" value="${src.minutes}" aria-label="Simulated time" />
      <label>Environment <select id="denv">${opts}</select></label>
    </div>`;
  const setClock = () => {
    const m = src.minutes;
    const d = new Date(Date.UTC(2026, 10, 3, 23, 0, 0) + m * 60000);
    $('#dclock').textContent = d.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }) + ' ET';
  };
  setClock();
  $('#dslider').oninput = (e) => {
    src.minutes = Number(e.target.value);
    setClock();
    refresh();
  };
  $('#denv').onchange = (e) => {
    src.env = e.target.value;
    refresh();
  };
  $('#dplay').onclick = () => {
    state.playing = !state.playing;
    $('#dplay').textContent = state.playing ? '❚❚ Pause' : '▶ Play';
  };
  state._setClock = setClock;
}

// ---------------------------------------------------------------- data loop
function ctx() {
  return { board: state.board, source: state.source, summary: () => state.summary, raceSignal, compositeSignal, open: openFromCtx };
}
function openFromCtx(id) {
  openRaceModal(id, ctx(), {});
}

async function refresh() {
  try {
    const s = await state.source.summary();
    state.summary = s;
    state.error = null;
    state.lastOk = Date.now();
  } catch (e) {
    state.error = e.message;
    if (e.noData && state.source.kind !== 'demo' && cfg.demoWhenNoData !== false) {
      switchToDemo(e.message);
      return refresh();
    }
  }
  updateCards();
  renderBanner();
  if (modalState.open) refreshModal(ctx());
}

function switchToDemo(reason) {
  state.liveSource = state.source;
  state.source = new DemoSource(state.board, cfg.defaultDemoEnv || 'wave');
  state.fallbackDemo = true;
  state.error = reason;
  renderDemoControls();
}

async function tryLive(manual) {
  if (!state.liveSource) return;
  try {
    const s = await state.liveSource.summary();
    state.source = state.liveSource;
    state.liveSource = null;
    state.fallbackDemo = false;
    state.error = null;
    state.summary = s;
    renderDemoControls();
    updateCards();
    renderBanner();
  } catch (e) {
    if (manual) {
      state.error = e.message;
      renderBanner();
    }
  }
}

function schedule() {
  clearInterval(state.timer);
  const ps = cfg.pollSeconds || {};
  const live = state.source.kind !== 'demo';
  const secs = live ? ps[state.source.kind] || 30 : 2;
  let tick = 0;
  state.timer = setInterval(async () => {
    tick += 1;
    if (state.source.kind === 'demo') {
      if (state.playing) {
        state.source.minutes = Math.min(480, state.source.minutes + 5);
        const sl = $('#dslider');
        if (sl) sl.value = state.source.minutes;
        state._setClock && state._setClock();
        await refresh();
        if (state.source.minutes >= 480) state.playing = false;
      }
      if (state.fallbackDemo && tick % 60 === 0) await tryLive(false); // every ~2 minutes
      return;
    }
    if (tick % secs === 0) await refresh();
    else updateCards(); // keep countdowns ticking
  }, live ? 1000 : 2000);
}

async function main() {
  state.board = await (await fetch('board.json', { cache: 'no-cache' })).json();
  const src = resolveSource(cfg);
  state.source = src.kind === 'demo' ? new DemoSource(state.board, new URLSearchParams(location.search).get('env') || cfg.defaultDemoEnv || 'wave') : new LiveSource(src);
  renderBoard();
  renderDemoControls();
  const ml = $('#maplink');
  if (ml) ml.href = `map.html${location.search}`; // keep ?demo / ?data when switching views
  await refresh();
  schedule();
  // switching between live and demo restarts the timer with the right cadence
  let lastKind = state.source.kind;
  setInterval(() => {
    if (state.source.kind !== lastKind) {
      lastKind = state.source.kind;
      schedule();
    }
  }, 1000);

  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('race')) openRaceModal(hash.get('race'), ctx(), {});
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });
  $('#overlay').addEventListener('click', (e) => {
    if (e.target.id === 'overlay') closeModal();
  });
}

main().catch((e) => {
  $('#headline').textContent = 'Could not start the tracker';
  $('#banner').innerHTML = `<div class="banner err">${esc(e.message)}</div>`;
  console.error(e);
});

export { nowIso };
