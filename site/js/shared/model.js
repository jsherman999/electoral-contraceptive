// Race model shared by the browser (demo mode) and the Node collector.
//
// Input: a list of units (precincts, or whole counties when a feed is county-level). Each unit carries
// 2026 votes by vote mode and, when it was matched, the same precinct's 2024 votes by mode:
//   { c: county, p: precinct, v: isVirtual, x: complete (true/false/null = unknown),
//     lvl: 'precinct' | 'county', pr: { tot, rep } (county-level precinct counts),
//     live: { ED: [D, R, O], EV: [...], MAIL: [...], PROV: [...] }   (or { TOTAL: [...] }),
//     b:    { ...same shape, 2024 }  | null,
//     mk:   match kind ('exact', 'code', 'digits', 'county', ...) | null }
//
// Output: race summary, a county table and per-precinct rows, all with margins in points (D positive).
//
// Method (see PLAN.md §3):
//  * Like-for-like: only cells (precinct x vote mode) that have reported in 2026 are compared with the
//    same cells in 2024. When either side lacks a mode breakdown, a precinct is compared on totals,
//    and only once it is completely reported.
//  * swing  = margin(2026 compared cells) - margin(2024 compared cells)
//  * turnout = votes(2026 compared) / votes(2024 compared)
//  * Unreported cells are projected from 2024, scaled by that mode's turnout and shifted by that mode's
//    swing (falling back to the race-wide figures when a mode has too few votes yet).

const Z = [0, 0, 0];
const tot = (c) => (c ? c[0] + c[1] + c[2] : 0);
const add = (a, c) => {
  a[0] += c[0];
  a[1] += c[1];
  a[2] += c[2];
  return a;
};
const cellsTotal = (cells) => {
  const r = [0, 0, 0];
  if (cells) for (const k in cells) add(r, cells[k]);
  return r;
};
const mfrac = (c) => {
  const t = tot(c);
  return t > 0 ? (c[0] - c[1]) / t : null;
};
const r1 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 10) / 10);
const r3 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 1000) / 1000);

function newAgg() {
  return { l: [0, 0, 0], b: [0, 0, 0] };
}
function aggSwing(a) {
  const ml = mfrac(a.l);
  const mb = mfrac(a.b);
  return ml == null || mb == null ? null : (ml - mb) * 100;
}
function aggTurnout(a) {
  const tb = tot(a.b);
  return tb > 0 ? tot(a.l) / tb : null;
}

/**
 * @param {Array} units
 * @param {object} [opts]
 * @param {number} [opts.minModeVotes=400]   votes needed before a mode uses its own swing/turnout
 * @param {number} [opts.defaultTurnout=0.8] turnout ratio assumed before any comparable votes exist
 */
export function analyzeRace(units, opts = {}) {
  const minModeVotes = opts.minModeVotes ?? 400;
  const defaultTurnout = opts.defaultTurnout ?? 0.8;

  const agg = {}; // mode -> {l, b} over compared cells
  const all = newAgg();
  const actual = [0, 0, 0];
  const rows = [];
  const counties = new Map();
  const baseAll = [0, 0, 0];
  let comparedVotes = 0;

  const county = (c) => {
    let k = counties.get(c);
    if (!k) {
      k = {
        c,
        live: [0, 0, 0],
        cmp: newAgg(),
        base: [0, 0, 0],
        baseN: 0,
        proj: [0, 0], // [D-R, T] projected remaining
        n: 0,
        full: 0,
        partial: 0,
        none: 0,
        matched: 0,
      };
      counties.set(c, k);
    }
    return k;
  };

  // ---- pass 1: status + comparison ----
  for (const u of units) {
    const live = u.live || {};
    const lt = cellsTotal(live);
    const LT = tot(lt);
    const b = u.b && tot(cellsTotal(u.b)) > 0 ? u.b : null;
    const bt = b ? cellsTotal(b) : null;
    const BT = bt ? tot(bt) : 0;
    const liveKeys = Object.keys(live);
    const liveModes = liveKeys.filter((m) => tot(live[m]) > 0);
    const liveHasModes = liveKeys.some((m) => m !== 'TOTAL');
    const bModes = b ? Object.keys(b).filter((m) => tot(b[m]) > 0) : [];
    const baseModal = !!b && bModes.length > 0 && !bModes.includes('TOTAL');
    const modal = baseModal && liveHasModes && liveModes.every((m) => bModes.includes(m));

    let complete;
    if (u.lvl === 'county' && u.pr && u.pr.tot > 0) complete = LT > 0 && u.pr.rep >= u.pr.tot;
    else if (u.x === true || u.x === false) complete = u.x && LT > 0;
    else if (LT === 0) complete = false;
    else if (modal) complete = bModes.every((m) => tot(b[m]) < Math.max(5, 0.05 * BT) || tot(live[m]) > 0);
    else if (liveHasModes && 'ED' in live) complete = tot(live.ED) > 0;
    else complete = true;
    const status = LT === 0 ? 'N' : complete ? 'F' : 'P';

    const cmpL = [0, 0, 0];
    const cmpB = [0, 0, 0];
    if (b && LT > 0) {
      if (modal) {
        for (const m of liveModes) {
          (agg[m] ||= newAgg());
          add(agg[m].l, live[m]);
          add(agg[m].b, b[m]);
          add(cmpL, live[m]);
          add(cmpB, b[m]);
        }
      } else if (complete) {
        (agg.TOTAL ||= newAgg());
        add(agg.TOTAL.l, lt);
        add(agg.TOTAL.b, bt);
        add(cmpL, lt);
        add(cmpB, bt);
      }
      add(all.l, cmpL);
      add(all.b, cmpB);
      comparedVotes += tot(cmpL);
    }

    add(actual, lt);
    if (b) add(baseAll, bt);

    const k = county(u.c);
    add(k.live, lt);
    add(k.cmp.l, cmpL);
    add(k.cmp.b, cmpB);
    if (b) {
      add(k.base, bt);
      k.baseN += 1;
      k.matched += 1;
    }
    if (!u.v) {
      if (u.lvl === 'county' && u.pr) {
        k.n += u.pr.tot || 0;
        k.full += Math.min(u.pr.rep || 0, u.pr.tot || 0);
      } else {
        k.n += 1;
        if (status === 'F') k.full += 1;
        else if (status === 'P') k.partial += 1;
        else k.none += 1;
      }
    }

    const m26 = mfrac(cmpL);
    const m24 = mfrac(cmpB);
    rows.push({
      u,
      status,
      modal,
      baseModal,
      b,
      bt,
      BT,
      LT,
      lt,
      row: {
        c: u.c,
        p: u.p,
        s: status,
        v: u.v ? 1 : 0,
        lvl: u.lvl === 'county' ? 'county' : undefined,
        d: lt[0],
        r: lt[1],
        o: lt[2],
        t: LT,
        m: LT > 0 ? r1(mfrac(lt) * 100) : null,
        bm: b ? r1(mfrac(bt) * 100) : null,
        bt: BT || null,
        m26: m26 == null ? null : r1(m26 * 100),
        m24: m24 == null ? null : r1(m24 * 100),
        sh: m26 == null || m24 == null ? null : r1((m26 - m24) * 100),
        tr: tot(cmpB) > 0 ? r3(tot(cmpL) / tot(cmpB)) : null,
        mk: u.mk || null,
        modes: liveModes.length ? liveModes : undefined,
      },
    });
  }

  const overallSwing = aggSwing(all);
  const overallTurnout = aggTurnout(all);
  const swingFor = (m) => {
    const a = agg[m];
    if (a && tot(a.l) >= minModeVotes) return aggSwing(a);
    return overallSwing ?? 0;
  };
  const turnoutFor = (m) => {
    const a = agg[m];
    if (a && tot(a.l) >= minModeVotes) return aggTurnout(a);
    return overallTurnout ?? defaultTurnout;
  };

  // ---- pass 2: projection of what has not reported ----
  let projDiff = 0;
  let projT = 0;
  const pending = []; // unmatched, unreported, non-virtual
  for (const x of rows) {
    const { u, b, bt, BT, LT, status } = x;
    let pd = 0;
    let pt = 0;
    if (b && BT > 0) {
      if (x.baseModal && (x.modal || LT === 0)) {
        for (const m of Object.keys(b)) {
          const cell = b[m];
          if (tot(cell) <= 0) continue;
          if (u.live && tot(u.live[m]) > 0) continue;
          const t = tot(cell) * turnoutFor(m);
          const mg = Math.max(-1, Math.min(1, mfrac(cell) + swingFor(m) / 100));
          pd += t * mg;
          pt += t;
        }
      } else if (status !== 'F') {
        const t = Math.max(0, BT * turnoutFor('TOTAL') - LT);
        const mg = Math.max(-1, Math.min(1, mfrac(bt) + swingFor('TOTAL') / 100));
        pd += t * mg;
        pt += t;
      }
    } else if (!u.v && status === 'N') {
      pending.push(x);
    }
    projDiff += pd;
    projT += pt;
    const k = counties.get(u.c);
    k.proj[0] += pd;
    k.proj[1] += pt;
    x.row.pt = pt > 0 ? Math.round(pt) : undefined;
  }
  // Unmatched precincts that have not reported: assume an average matched precinct from the same county.
  for (const x of pending) {
    const k = counties.get(x.u.c);
    const src = k && k.baseN > 0 ? k : null;
    const avgBT = src ? tot(src.base) / src.baseN : baseAll && rows.length ? tot(baseAll) / Math.max(1, rows.filter((r) => r.b).length) : 0;
    if (!avgBT) continue;
    const bm = src ? mfrac(src.base) : mfrac(baseAll);
    const t = avgBT * (overallTurnout ?? defaultTurnout);
    const mg = Math.max(-1, Math.min(1, (bm ?? 0) + (overallSwing ?? 0) / 100));
    projDiff += t * mg;
    projT += t;
    k.proj[0] += t * mg;
    k.proj[1] += t;
    x.row.pt = Math.round(t);
  }

  const T = tot(actual);
  const finalT = T + projT;
  const expectedPct = finalT > 0 ? T / finalT : 0;
  const projMargin = finalT > 0 ? ((actual[0] - actual[1] + projDiff) / finalT) * 100 : null;
  const comparedShare = T > 0 ? comparedVotes / T : 0;
  let sigma = 1 + 9 * Math.sqrt(Math.max(0, 1 - expectedPct));
  if (T > 0 && comparedShare < 0.5) sigma *= 1.5;
  if (T === 0) sigma = 10;

  let confidence = 'none';
  if (T > 0) {
    const z = projMargin == null ? 0 : Math.abs(projMargin) / sigma;
    if (expectedPct < 0.05) confidence = 'too-early';
    else if (z >= 2.6 && expectedPct >= 0.5) confidence = 'clear';
    else if (z >= 1.645) confidence = 'likely';
    else if (z >= 0.67) confidence = 'lean';
    else confidence = 'tossup';
  }

  let nTotal = 0;
  let nFull = 0;
  let nPartial = 0;
  let nNone = 0;
  let nMatched = 0;
  let nUnits = 0;
  for (const k of counties.values()) {
    nTotal += k.n;
    nFull += k.full;
    nPartial += k.partial;
    nNone += k.none;
  }
  for (const x of rows) {
    if (x.u.v) continue;
    nUnits += 1;
    if (x.b) nMatched += 1;
  }

  const byMode = {};
  for (const m of Object.keys(agg)) {
    byMode[m] = {
      votes: tot(agg[m].l),
      swing: r1(aggSwing(agg[m])),
      turnout: r3(aggTurnout(agg[m])),
      m26: r1((mfrac(agg[m].l) ?? 0) * 100),
      m24: r1((mfrac(agg[m].b) ?? 0) * 100),
    };
  }

  const summary = {
    votes: { D: actual[0], R: actual[1], O: actual[2], T },
    margin: T > 0 ? r1(mfrac(actual) * 100) : null,
    precincts: { total: nTotal, full: nFull, partial: nPartial, none: nNone },
    match: { units: nUnits, matched: nMatched, rate: nUnits ? r3(nMatched / nUnits) : null },
    compared: { votes: comparedVotes, share: r3(comparedShare) },
    swing: r1(overallSwing),
    turnout: r3(overallTurnout),
    base: {
      same: r1((mfrac(all.b) ?? NaN) * 100),
      all: r1((mfrac(baseAll) ?? NaN) * 100),
      votes: tot(baseAll),
    },
    projection: {
      margin: r1(projMargin),
      low: projMargin == null ? null : r1(projMargin - 1.645 * sigma),
      high: projMargin == null ? null : r1(projMargin + 1.645 * sigma),
      sigma: r1(sigma),
      expectedPct: r3(expectedPct),
      expectedVotes: Math.round(finalT),
      leader: projMargin == null || T === 0 ? null : projMargin > 0 ? 'D' : projMargin < 0 ? 'R' : null,
      confidence,
    },
    byMode,
  };

  const countyRows = [...counties.values()]
    .map((k) => {
      const lt = tot(k.live);
      const fin = lt + k.proj[1];
      return {
        c: k.c,
        d: k.live[0],
        r: k.live[1],
        o: k.live[2],
        t: lt,
        m: lt > 0 ? r1(mfrac(k.live) * 100) : null,
        bm: tot(k.base) > 0 ? r1(mfrac(k.base) * 100) : null,
        sh: r1(aggSwing(k.cmp)),
        tr: r3(aggTurnout(k.cmp)),
        pm: fin > 0 ? r1(((k.live[0] - k.live[1] + k.proj[0]) / fin) * 100) : null,
        ep: fin > 0 ? r3(lt / fin) : null,
        n: k.n,
        full: k.full,
        partial: k.partial,
        none: k.none,
      };
    })
    .sort((a, b) => (b.t || 0) - (a.t || 0) || (b.n || 0) - (a.n || 0));

  return { summary, counties: countyRows, units: rows.map((x) => x.row) };
}

/** Vote-weighted average swing across race summaries (only races with compared votes). */
export function nationalSwing(summaries) {
  let w = 0;
  let s = 0;
  let n = 0;
  for (const x of summaries) {
    if (!x || x.swing == null || !x.compared || !x.compared.votes) continue;
    const wt = Math.sqrt(x.compared.votes); // sqrt so one big district doesn't swamp the rest
    w += wt;
    s += wt * x.swing;
    n += 1;
  }
  return n ? { swing: r1(s / w), races: n } : { swing: null, races: 0 };
}

export const fmtMargin = (m, digits = 1) => {
  if (m == null || !isFinite(m)) return '—';
  if (Math.abs(m) < 0.05) return 'Even';
  return (m > 0 ? 'D+' : 'R+') + Math.abs(m).toFixed(digits);
};
