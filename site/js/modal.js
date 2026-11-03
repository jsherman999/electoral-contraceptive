// Race detail panel: summary, charts, county and precinct tables.
import { fmtMargin } from './shared/model.js';
import { MODE_LABELS } from './shared/normalize.js';
import { scatterChart, timelineChart, shiftColor } from './charts.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
const pct = (x, d = 0) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`);
const mcls = (m) => (m == null ? 'muted' : m > 0 ? 'D' : m < 0 ? 'R' : '');

export const modalState = {
  open: false,
  kind: null,
  id: null,
  opts: {},
  baseline: 'pres',
  detail: null,
  key: null,
  error: null,
  sort: { k: 't', dir: -1 },
  csort: { k: 't', dir: -1 },
  filter: { q: '', status: 'all', county: '' },
};

const STATE_TEXT = {
  'hit-strong': ['hit', 'Hitting: the model is confident'],
  hit: ['hit', 'Leaning toward hitting'],
  miss: ['miss', 'Leaning toward missing'],
  'miss-strong': ['miss', 'Missing: the model is confident'],
  pending: ['', 'Not enough comparable votes yet'],
};

function overlay() {
  return $('#overlay');
}
function show() {
  const o = overlay();
  o.classList.add('open');
  o.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}
export function closeModal() {
  const o = overlay();
  o.classList.remove('open');
  o.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  modalState.open = false;
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}

function summaryKey(ctx, id) {
  const s = ctx.summary();
  return `${s?.generatedAt}|${s?.races?.[id]?.updatedAt}`;
}

export async function openRaceModal(id, ctx, opts = {}) {
  Object.assign(modalState, { open: true, kind: 'race', id, opts, detail: null, error: null, key: null });
  modalState.filter = { q: '', status: 'all', county: '' };
  history.replaceState(null, '', `#race=${encodeURIComponent(id)}`);
  show();
  renderShell(ctx);
  await load(ctx);
}

export function openCompositeModal(compId, ctx) {
  Object.assign(modalState, { open: true, kind: 'composite', id: compId, opts: {}, detail: null, error: null });
  show();
  renderComposite(ctx);
}

export async function refreshModal(ctx) {
  if (!modalState.open) return;
  if (modalState.kind === 'composite') return renderComposite(ctx);
  if (summaryKey(ctx, modalState.id) !== modalState.key) await load(ctx, true);
}

async function load(ctx, quiet) {
  const id = modalState.id;
  const key = summaryKey(ctx, id);
  try {
    const d = await ctx.source.race(id);
    if (modalState.id !== id || !modalState.open) return;
    modalState.detail = d;
    modalState.key = key;
    modalState.error = null;
  } catch (e) {
    if (modalState.id !== id) return;
    modalState.error = e.noData ? 'No results have been published for this race yet. Check that it has a feed in config/sources.json.' : e.message;
    modalState.key = key;
  }
  const body = $('.mbody');
  const scroll = overlay().scrollTop;
  render(ctx);
  if (quiet) overlay().scrollTop = scroll;
  void body;
}

function signalFor(ctx) {
  const meta = ctx.board.races[modalState.id] || {};
  if (modalState.opts.signal) return modalState.opts.signal;
  // Opened from a link: use the race's (non-threshold) card on the board.
  for (const row of ctx.board.rows) {
    for (const [colId, cards] of Object.entries(row.cells || {})) {
      if (cards.some((c) => c.race === modalState.id && !c.dashed)) {
        modalState.opts.colId = colId;
        return { party: ctx.board.columns.find((c) => c.id === colId)?.party || 'D' };
      }
    }
  }
  if ((ctx.board.later || []).some((l) => l.races.includes(modalState.id))) return { party: 'D' };
  return { party: meta.holder === 'R' ? 'D' : 'R' };
}

function signalSentence(sig, meta) {
  const who = sig.party === 'D' ? 'Democrats' : 'Republicans';
  if (sig.margin) return `${who} win by ${sig.margin} points or more`;
  return `${who} ${meta.holder === sig.party ? 'hold' : 'flip'} this ${meta.holder}-held seat`;
}

function renderShell(ctx) {
  const id = modalState.id;
  const meta = ctx.board.races[id] || {};
  $('#modal').innerHTML = `
    <div class="mhead ${meta.holder === 'D' ? 'D' : 'R'}">
      <div>
        <h3 id="mtitle">${esc(id)} ${meta.redrawn ? '<span title="Redrawn since 2024" style="color:#ffd23f">★</span>' : ''}</h3>
        <div class="meta">${esc(meta.name || '')} · ${meta.holder === 'D' ? 'Democratic' : 'Republican'}-held · polls close ${esc(fmtClock(meta.close))} ET</div>
      </div>
      <button class="close" aria-label="Close" type="button">×</button>
    </div>
    <div class="mbody"><div class="note">Loading precinct results…</div></div>`;
  $('#modal .close').onclick = closeModal;
}

function fmtClock(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} pm`;
}

function render(ctx) {
  renderShell(ctx);
  const body = $('.mbody');
  const id = modalState.id;
  const meta = ctx.board.races[id] || {};
  const d = modalState.detail;
  const sum = ctx.summary()?.races?.[id];
  const sig = signalFor(ctx);
  const ss = ctx.raceSignal(sum, sig);
  const [scls, stxt] = STATE_TEXT[ss.state] || STATE_TEXT.pending;
  const colTitle = modalState.opts.colId ? ctx.board.columns.find((c) => c.id === modalState.opts.colId)?.title : null;
  const sigHtml = `<div class="signalbox ${scls}"><b>${colTitle ? esc(colTitle) + ' signal' : 'Signal'}:</b> ${esc(signalSentence(sig, meta))}. <b>${esc(stxt)}</b>${ss.final ? ' (final)' : ''}.</div>`;

  if (modalState.error || !d) {
    body.innerHTML = sigHtml + `<div class="banner">${esc(modalState.error || 'No data yet.')}</div>`;
    return;
  }

  const hasHouse = !!d.analyses.house;
  if (!hasHouse) modalState.baseline = 'pres';
  const a = d.analyses[modalState.baseline] || d.analyses.pres;
  const s = a.summary;
  const T = s.votes.T;
  const p = s.projection;

  const cands = (d.candidates || []).filter((c) => c.votes > 0 || T === 0);
  const candHtml = cands.length
    ? cands
        .map((c) => {
          const share = T ? c.votes / T : 0;
          const color = c.party === 'D' ? 'var(--dem)' : c.party === 'R' ? 'var(--rep)' : '#9aa3b2';
          return `<div class="cand"><div class="nm">${esc(c.name)}<small>${esc(c.party === 'O' ? 'Other' : c.party)}</small></div>
            <div class="v"><b>${pct(share, 1)}</b> · ${num(c.votes)}</div>
            <div class="track"><i style="width:${(share * 100).toFixed(1)}%;background:${color}"></i></div></div>`;
        })
        .join('')
    : '<div class="note">Candidate totals appear once votes are counted.</div>';

  const baseName = modalState.baseline === 'house' ? '2024 House' : '2024 President';
  const tiles = [
    ['Margin now', `<span class="t-${mcls(s.margin)}">${fmtMargin(s.margin)}</span>`, `${num(T)} votes counted`],
    ['Swing vs 2024', `<span class="t-${mcls(s.swing)}">${s.swing == null ? '—' : fmtMargin(s.swing)}</span>`, `same precincts and vote types · ${pct(s.compared.share)} of votes comparable`],
    ['Projected final', `<span class="t-${mcls(p.margin)}">${T ? fmtMargin(p.margin) : '—'}</span>`, T ? `90% range ${fmtMargin(p.low)} to ${fmtMargin(p.high)} · ${p.confidence}` : 'waiting for votes'],
    ['Expected vote in', pct(p.expectedPct), `of ~${num(p.expectedVotes)} expected`],
    ['Turnout vs 2024', s.turnout == null ? '—' : pct(s.turnout), 'votes per 2024 vote, same cells'],
    ['Precincts', `${num(s.precincts.full)}/${num(s.precincts.total)}`, `${num(s.precincts.partial)} partial · ${num(s.precincts.none)} not in`],
    [baseName, `<span class="t-${mcls(s.base.all)}">${fmtMargin(s.base.all)}</span>`, `these precincts · ${pct(s.match.rate)} matched to 2024`],
  ]
    .map(([k, v, sub]) => `<div class="tile"><div class="k">${k}</div><div class="val">${v}</div><div class="s">${esc(sub)}</div></div>`)
    .join('');

  const modes = Object.entries(s.byMode || {});
  const modeHtml = modes.length
    ? `<div class="tablewrap" style="max-height:none"><table class="data"><thead><tr><th class="l">Vote type</th><th>Votes</th><th>2026</th><th>2024 same</th><th>Swing</th><th>Turnout</th></tr></thead><tbody>${modes
        .map(
          ([mk, v]) =>
            `<tr><td class="l">${esc(MODE_LABELS[mk] || mk)}</td><td>${num(v.votes)}</td><td class="${mcls(v.m26)}">${fmtMargin(v.m26)}</td><td class="${mcls(v.m24)}">${fmtMargin(v.m24)}</td><td class="${mcls(v.swing)}">${fmtMargin(v.swing)}</td><td>${pct(v.turnout)}</td></tr>`
        )
        .join('')}</tbody></table></div>`
    : '<div class="note">Shown once comparable votes are in.</div>';

  const counties = sortRows(a.counties, modalState.csort);
  const ccols = [
    ['c', 'County', 'l'],
    ['t', 'Votes'],
    ['m', 'Margin now'],
    ['bm', `${baseName.replace('2024 ', "'24 ")}`],
    ['sh', 'Swing'],
    ['tr', 'Turnout'],
    ['pm', 'Projected'],
    ['ep', 'Exp. in'],
    ['n', 'Precincts'],
  ];
  const countyHtml = `<div class="tablewrap" style="max-height:340px"><table class="data" id="ctable"><thead><tr>${ccols
    .map(([k, l, c]) => `<th class="${c || ''}" data-k="${k}">${l}${arrow(modalState.csort, k)}</th>`)
    .join('')}</tr></thead><tbody>${counties
    .map(
      (r) =>
        `<tr><td class="l">${esc(r.c)}</td><td>${num(r.t)}</td><td class="${mcls(r.m)}">${fmtMargin(r.m)}</td><td class="${mcls(r.bm)}">${fmtMargin(r.bm)}</td><td class="${mcls(r.sh)}">${fmtMargin(r.sh)}</td><td>${pct(r.tr)}</td><td class="${mcls(r.pm)}">${fmtMargin(r.pm)}</td><td>${pct(r.ep)}</td><td>${num(r.full)}/${num(r.n)}${r.partial ? ` <span class="muted">(+${r.partial} part.)</span>` : ''}</td></tr>`
    )
    .join('')}</tbody></table></div>`;

  const countyOpts = [...new Set(a.units.map((u) => u.c))].sort();
  const feeds = (d.feeds || [])
    .map(
      (f) =>
        `<div><span class="${f.ok ? 'ok' : 'bad'}">${f.ok ? '●' : '✕'}</span> <b>${esc(f.id)}</b> (${esc(f.adapter || '')}) · fetched ${esc(fmtT(f.fetchedAt))}${f.sourceUpdatedAt ? ` · source updated ${esc(f.sourceUpdatedAt)}` : ''}${f.url ? ` · <a href="${esc(f.url)}" target="_blank" rel="noopener">source</a>` : ''}${f.error ? ` · <span class="bad">${esc(f.error)}</span>` : ''}${f.note ? ` · ${esc(f.note)}` : ''}</div>`
    )
    .join('');

  body.innerHTML = `
    ${sigHtml}
    <div class="sect" style="margin-top:0"><h4>Summary <span class="seg" id="bseg"><button type="button" data-b="pres" class="${modalState.baseline === 'pres' ? 'on' : ''}">vs 2024 President</button><button type="button" data-b="house" class="${modalState.baseline === 'house' ? 'on' : ''}" ${hasHouse ? '' : 'disabled title="No 2024 House baseline for these precincts"'}>vs 2024 House</button></span>
      <span class="hint">${d.level === 'county' ? 'County-level feed: comparisons wait until a county is fully counted.' : ''}</span></h4>
      <div class="row2"><div class="cands">${candHtml}</div><div class="tiles">${tiles}</div></div>
    </div>
    <div class="sect"><div class="charts">
      <div class="chartbox" id="scatter"><div class="ttl">Every precinct: 2026 against 2024</div><div class="cap">Above the line = moved toward Democrats. Dot size = votes; color = shift.</div><div class="plot"></div>
        <div class="chart-legend"><span><span class="swdot" style="background:${shiftColor(12)}"></span>shift toward D</span><span><span class="swdot" style="background:${shiftColor(0)}"></span>no change</span><span><span class="swdot" style="background:${shiftColor(-12)}"></span>shift toward R</span></div></div>
      <div class="chartbox" id="timeline"><div class="ttl">Margin through the night</div><div class="cap">Counted margin and the model's projected final margin.</div><div class="plot"></div>
        <div class="chart-legend"><span><span class="sw"></span>margin now</span><span><span class="sw dash" style="border-color:#5b6680"></span>projected final</span></div></div>
    </div></div>
    <div class="sect"><h4>By vote type <span class="hint">Each type is compared only with the same type in 2024</span></h4>${modeHtml}</div>
    <div class="sect"><h4>Counties</h4>${countyHtml}</div>
    <div class="sect"><h4>Precincts <span class="hint">Click a column to sort. "Shift" compares the same vote types in the same precinct.</span></h4>
      <div class="filters">
        <input type="search" id="pq" placeholder="Search precinct or county" value="${esc(modalState.filter.q)}" />
        <select id="pstatus">
          ${[
            ['all', 'All precincts'],
            ['rep', 'Reporting (any votes)'],
            ['F', 'Fully reported'],
            ['P', 'Partly reported'],
            ['N', 'Not reported'],
            ['unm', 'Not matched to 2024'],
            ['virt', 'Absentee/provisional batches'],
          ]
            .map(([v, l]) => `<option value="${v}" ${modalState.filter.status === v ? 'selected' : ''}>${l}</option>`)
            .join('')}
        </select>
        <select id="pcounty"><option value="">All counties</option>${countyOpts
          .map((c) => `<option ${modalState.filter.county === c ? 'selected' : ''}>${esc(c)}</option>`)
          .join('')}</select>
        <span class="count" id="pcount"></span>
      </div>
      <div class="tablewrap"><table class="data" id="ptable"></table></div>
    </div>
    <div class="sect"><h4>Sources</h4><div class="feeds">${feeds || '<div>No feed information.</div>'}</div>
      <p class="note">Swing compares 2026 votes with 2024 votes in the same precincts and the same vote types (Election Day, early, mail, provisional) where both years report them; otherwise a precinct is compared on totals once it is fully reported. The projection fills uncounted precincts with their 2024 result, scaled by turnout so far and shifted by the swing so far. It is a model estimate, not a race call. Precinct lines can change between elections; unmatched precincts are counted in the totals but not in the swing.</p>
    </div>`;

  $('#bseg').onclick = (e) => {
    const b = e.target.closest('button')?.dataset.b;
    if (b && !e.target.disabled) {
      modalState.baseline = b;
      render(ctx);
    }
  };
  $('#ctable thead').onclick = (e) => {
    const k = e.target.closest('th')?.dataset.k;
    if (!k) return;
    modalState.csort = { k, dir: modalState.csort.k === k ? -modalState.csort.dir : k === 'c' ? 1 : -1 };
    render(ctx);
  };
  scatterChart($('#scatter'), a.units.filter((u) => !u.v), {
    onPick: (u) => {
      modalState.filter.q = u.p;
      $('#pq').value = u.p;
      renderPrecincts(a);
      $('#ptable').scrollIntoView({ behavior: 'smooth', block: 'center' });
    },
  });
  timelineChart($('#timeline'), d.history);
  const rerender = () => {
    modalState.filter.q = $('#pq').value;
    modalState.filter.status = $('#pstatus').value;
    modalState.filter.county = $('#pcounty').value;
    renderPrecincts(a);
  };
  $('#pq').oninput = rerender;
  $('#pstatus').onchange = rerender;
  $('#pcounty').onchange = rerender;
  renderPrecincts(a);
}

function arrow(sort, k) {
  return sort.k === k ? `<span class="arr">${sort.dir > 0 ? '▲' : '▼'}</span>` : '';
}

function sortRows(rows, sort) {
  const { k, dir } = sort;
  return rows.slice().sort((x, y) => {
    const a = x[k];
    const b = y[k];
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    if (typeof a === 'string') return dir * a.localeCompare(b, 'en', { numeric: true });
    return dir * (a - b);
  });
}

const PCOLS = [
  ['c', 'County', 'l'],
  ['p', 'Precinct', 'l'],
  ['s', 'Status', 'l'],
  ['d', 'Dem'],
  ['r', 'Rep'],
  ['o', 'Other'],
  ['t', 'Total'],
  ['m', 'Margin'],
  ['m24', "'24 same votes"],
  ['sh', 'Shift'],
  ['tr', 'Turnout'],
  ['bm', "'24 margin"],
  ['mk', 'Match', 'l'],
];

function renderPrecincts(a) {
  const f = modalState.filter;
  const q = f.q.trim().toLowerCase();
  let rows = a.units.filter((u) => {
    if (f.county && u.c !== f.county) return false;
    if (q && !`${u.p} ${u.c}`.toLowerCase().includes(q)) return false;
    switch (f.status) {
      case 'rep':
        return u.t > 0;
      case 'F':
      case 'P':
      case 'N':
        return u.s === f.status && !u.v;
      case 'unm':
        return !u.mk && !u.v;
      case 'virt':
        return !!u.v;
      default:
        return true;
    }
  });
  rows = sortRows(rows, modalState.sort);
  const total = rows.length;
  const LIMIT = 1500;
  const shown = rows.slice(0, LIMIT);
  const table = $('#ptable');
  const stl = (u) => (u.v ? ['V', 'Batch'] : u.s === 'F' ? ['F', 'Full'] : u.s === 'P' ? ['P', 'Partial'] : ['N', 'Not in']);
  table.innerHTML = `<thead><tr>${PCOLS.map(([k, l, c]) => `<th class="${c || ''}" data-k="${k}">${l}${arrow(modalState.sort, k)}</th>`).join('')}</tr></thead><tbody>${shown
    .map((u) => {
      const [sc, st] = stl(u);
      const shStyle = u.sh == null ? '' : ` style="color:${shiftColor(u.sh)};font-weight:700"`;
      return `<tr><td class="l">${esc(u.c)}</td><td class="l">${esc(u.p)}</td><td class="l"><span class="st ${sc}">${st}</span></td><td>${num(u.d)}</td><td>${num(u.r)}</td><td>${num(u.o)}</td><td>${num(u.t)}</td><td class="${mcls(u.m)}">${fmtMargin(u.m)}</td><td class="${mcls(u.m24)}">${fmtMargin(u.m24)}</td><td${shStyle}>${u.sh == null ? '—' : (u.sh >= 0 ? '▲D ' : '▲R ') + Math.abs(u.sh).toFixed(1)}</td><td>${pct(u.tr)}</td><td class="${mcls(u.bm)}">${fmtMargin(u.bm)}</td><td class="l muted">${esc(u.mk || (u.v ? '' : 'unmatched'))}</td></tr>`;
    })
    .join('')}</tbody>`;
  $('#pcount').textContent = `${num(total)} precinct${total === 1 ? '' : 's'}${total > LIMIT ? ` (showing first ${LIMIT})` : ''}`;
  table.querySelector('thead').onclick = (e) => {
    const k = e.target.closest('th')?.dataset.k;
    if (!k) return;
    modalState.sort = { k, dir: modalState.sort.k === k ? -modalState.sort.dir : ['c', 'p', 's', 'mk'].includes(k) ? 1 : -1 };
    renderPrecincts(a);
  };
}

function fmtT(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: '2-digit' }) + ' ET';
}

function renderComposite(ctx) {
  const comp = ctx.board.composites[modalState.id];
  const races = ctx.summary()?.races || {};
  const cs = ctx.compositeSignal(comp, races);
  const [scls, stxt] = STATE_TEXT[cs.state] || STATE_TEXT.pending;
  const who = comp.party === 'D' ? 'Democrats' : 'Republicans';
  const members = cs.members
    .map((m) => {
      const s = m.sum;
      const meta = ctx.board.races[m.id] || {};
      const live =
        s && s.votes && s.votes.T
          ? `<span class="pill ${s.margin > 0 ? 'D' : 'R'}">${fmtMargin(s.margin)}</span><span class="pct">${Math.round((s.projection.expectedPct || 0) * 100)}% in · proj ${fmtMargin(s.projection.margin)}</span>`
          : '<span class="wait">No votes yet</span>';
      const sc = m.sig.state !== 'pending' ? m.sig.state : '';
      return `<button type="button" class="card ${meta.holder === 'D' ? 'D' : 'R'} ${sc}" data-id="${esc(m.id)}"><div class="code">${esc(m.id)}${meta.redrawn ? ' <span class="star">★</span>' : ''} <span class="check">✓</span></div><div class="who">${esc(meta.name || '')}</div><div class="live">${live}</div><div class="bar"><i style="width:${Math.round((s?.projection?.expectedPct || 0) * 100)}%"></i></div></button>`;
    })
    .join('');
  $('#modal').innerHTML = `
    <div class="mhead X"><div><h3 id="mtitle">${esc(comp.title)}</h3><div class="meta">${esc(comp.sub)} · red signal if ${who} win at least ${comp.atLeast} of ${comp.races.length}</div></div>
    <button class="close" aria-label="Close" type="button">×</button></div>
    <div class="mbody">
      <div class="signalbox ${scls}"><b>${esc(stxt)}.</b> ${who} lead or have won ${cs.hits} of ${comp.races.length}; trailing in ${cs.misses}.</div>
      <div class="members">${members}</div>
      ${comp.note ? `<p class="note">${esc(comp.note)}</p>` : ''}
    </div>`;
  $('#modal .close').onclick = closeModal;
  $('#modal .members').onclick = (e) => {
    const id = e.target.closest('[data-id]')?.dataset.id;
    if (id) openRaceModal(id, ctx, { signal: { party: comp.party } });
  };
}
