// Simulated election night. Everything here is synthetic and labelled as such in the UI.
// It produces the same summary/detail shapes as the collector, so the board, the detail panel and the
// collector's --demo flag all run through the real model code.
import { buildRace } from './race.js';

export const ENVIRONMENTS = {
  riptide: { label: 'Red riptide (R+3 swing)', swing: -3 },
  neutral: { label: 'Status quo (no swing)', swing: 0 },
  tide: { label: 'Blue tide (D+3 swing)', swing: 3 },
  wave: { label: 'Blue wave (D+7 swing)', swing: 7 },
  tsunami: { label: 'Blue tsunami (D+11 swing)', swing: 11 },
};

const COUNTY_NAMES = [
  'Adams', 'Lincoln', 'Jefferson', 'Franklin', 'Washington', 'Madison', 'Clay', 'Marion', 'Monroe', 'Jackson',
  'Union', 'Warren', 'Greene', 'Wayne', 'Grant', 'Lake', 'Hamilton', 'Polk', 'Shelby', 'Butler', 'Knox', 'Logan',
];

// Rough 2024-style leans used only to make the simulation look plausible (points, D positive).
const COLUMN_LEAN = { riptide: 4, tide: -3, wave: -7, tsunami: -11, later: -3 };
const LEAN_OVERRIDES = {
  'KY-06': -14, 'IN-05': -16, 'FL-14': -2, 'FL-22': -2, 'FL-25': -2, 'NC-01': -2, 'OH-09': -3,
  'FL-09': -6, 'ME-02': -7, 'TX-09': -7, 'TX-28': -8, 'TX-32': -6, 'TX-34': -7, 'TX-35': -6,
  'PA-07': -1, 'PA-10': -2, 'MT-01': -7, 'CA-22': -1, 'CA-48': -2,
  // statewide Senate races, roughly the 2024 presidential margins
  'FL-SEN': -13, 'NC-SEN': -3, 'OH-SEN': -11, 'MI-SEN': -1.5, 'TX-SEN': -13.5, 'ME-SEN': 7, 'KS-SEN': -16, 'IA-SEN': -13, 'AK-SEN': -13,
};

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r) {
  const u = Math.max(1e-9, r());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const vec = (T, mPts, oShare = 0.02) => {
  const m = clamp(mPts, -96, 96) / 100;
  const two = T * (1 - oShare);
  return [Math.round((two * (1 + m)) / 2), Math.round((two * (1 - m)) / 2), Math.round(T * oShare)];
};

/** Minutes after 6:00 pm ET for "HH:MM". */
export function minutesAfterSix(hhmm) {
  const [h, m] = String(hhmm || '19:00').split(':').map(Number);
  return (h - 18) * 60 + (m || 0);
}

function columnOf(board) {
  const col = {};
  for (const row of board.rows) {
    for (const [c, cards] of Object.entries(row.cells || {})) {
      for (const card of cards) if (card.race && !card.dashed && !col[card.race]) col[card.race] = c;
    }
  }
  for (const l of board.later || []) for (const id of l.races) col[id] ||= 'later';
  return col;
}

/** Build the synthetic precinct universe for every race on the board (deterministic). */
export function createDemo(board, seed = 2026) {
  const col = columnOf(board);
  const races = {};
  for (const [id, meta] of Object.entries(board.races)) {
    const r = rng(hash(id) ^ seed);
    const st = id.slice(0, 2);
    const lean = (LEAN_OVERRIDES[id] ?? COLUMN_LEAN[col[id] || 'tide']) + gauss(r) * 1;
    const nCounties = 1 + Math.floor(r() * 5);
    const start = Math.floor(r() * COUNTY_NAMES.length);
    const counties = [];
    for (let i = 0; i < nCounties; i++) {
      counties.push({
        name: COUNTY_NAMES[(start + i * 3) % COUNTY_NAMES.length],
        off: gauss(r) * 10,
        swing: gauss(r) * 2,
        speed: 0.55 + r() * 1.3,
        mailAt: 6 + r() * 30,
        evAt: 12 + r() * 40,
      });
    }
    const nPrec = 90 + Math.floor(r() * 160);
    const slow = st === 'CA' ? 2.2 : st === 'ME' || st === 'AZ' ? 1.5 : 1;
    // Urban precincts are bigger and bluer, which would drag the district average away from `lean`;
    // estimate that drift from a throwaway draw and subtract it.
    const probe = rng(hash(id) ^ seed ^ 0x9e3779b9);
    let pw = 0;
    let pm = 0;
    for (let i = 0; i < 400; i++) {
      const urban = probe() < 0.25;
      const T = 400 + Math.pow(probe(), 0.7) * 3200 * (urban ? 1.4 : 1);
      const k = counties[Math.floor(Math.pow(probe(), 1.3) * nCounties)];
      pw += T;
      pm += T * (k.off + (urban ? 14 : 0));
    }
    const recentre = pm / pw;
    const units = [];
    for (let i = 0; i < nPrec; i++) {
      const k = counties[Math.floor(Math.pow(r(), 1.3) * nCounties)];
      const urban = r() < 0.25;
      const T = Math.round(400 + Math.pow(r(), 0.7) * 3200 * (urban ? 1.4 : 1));
      const m = clamp(lean + k.off + gauss(r) * 18 + (urban ? 14 : 0) - recentre, -90, 90);
      // 2024 vote mix and mode-specific leans (mail most Democratic, Election Day most Republican)
      let mix = { ED: 0.42 + gauss(r) * 0.05, EV: 0.32 + gauss(r) * 0.05, MAIL: 0.23 + gauss(r) * 0.04, PROV: 0.03 };
      const s = Object.values(mix).reduce((a, b) => a + Math.max(0.01, b), 0);
      for (const kk in mix) mix[kk] = Math.max(0.01, mix[kk]) / s;
      const off = { ED: -7, EV: -2, MAIL: 16, PROV: 8 };
      const mean = Object.keys(mix).reduce((a, kk) => a + mix[kk] * off[kk], 0);
      const b = {};
      const bh = {};
      const houseShift = (meta.holder === 'D' ? 3 : -3) + gauss(r) * 2;
      for (const kk of Object.keys(mix)) {
        b[kk] = vec(T * mix[kk], m + off[kk] - mean);
        bh[kk] = vec(T * mix[kk], m + off[kk] - mean + houseShift, 0.01);
      }
      const pnum = String(i + 1).padStart(3, '0');
      units.push({
        c: k.name,
        p: `${k.name.slice(0, 3).toUpperCase()}-${pnum}`,
        lvl: 'precinct',
        b,
        bh,
        mk: 'exact',
        k,
        noise: gauss(r) * 3.5,
        turn: 0.74 + gauss(r) * 0.07,
        modeTurn: { ED: 0.96 + gauss(r) * 0.04, EV: 0.98 + gauss(r) * 0.04, MAIL: 1.05 + gauss(r) * 0.05, PROV: 0.85 },
        edAt: 35 + k.speed * Math.pow(r(), 0.85) * 200 * slow,
        mailAt: k.mailAt * (st === 'CA' ? 0.3 : 1),
        evAt: k.evAt,
        provAt: 900,
      });
    }
    races[id] = {
      id,
      meta,
      close: minutesAfterSix(meta.close),
      raceNoise: gauss(r) * 2.5,
      units,
      names: { D: 'Democratic candidate', R: 'Republican candidate' },
    };
  }
  return { races, seed };
}

function liveUnits(race, minutes, envSwing) {
  const elapsed = minutes - race.close;
  return race.units.map((u) => {
    const swing = envSwing + race.raceNoise + u.k.swing + u.noise;
    const live = {};
    const at = { ED: u.edAt, EV: u.evAt, MAIL: u.mailAt, PROV: u.provAt };
    for (const m of Object.keys(u.b)) {
      const bc = u.b[m];
      const T = bc[0] + bc[1] + bc[2];
      if (elapsed >= at[m]) {
        const bm = T ? ((bc[0] - bc[1]) / T) * 100 : 0;
        live[m] = vec(T * u.turn * u.modeTurn[m], bm + swing, 0.02);
      } else live[m] = [0, 0, 0];
    }
    return { c: u.c, p: u.p, lvl: 'precinct', live, b: u.b, bh: u.bh, mk: u.mk, x: null };
  });
}

/** Simulate one race at a given clock (minutes after 6 pm ET). */
export function simulateRace(demo, id, minutes, envKey = 'wave', opts = {}) {
  const race = demo.races[id];
  const env = ENVIRONMENTS[envKey] || ENVIRONMENTS.wave;
  const units = liveUnits(race, minutes, env.swing);
  const totals = { D: 0, R: 0, O: 0 };
  for (const u of units) for (const c of Object.values(u.live)) {
    totals.D += c[0];
    totals.R += c[1];
    totals.O += c[2];
  }
  const now = demoClockIso(minutes);
  let history = [];
  if (opts.withHistory) {
    for (let t = race.close; t < minutes; t += 10) {
      const h = buildRace(id, liveUnits(race, t, env.swing), { now: demoClockIso(t), history });
      history = h.detail.history;
    }
  }
  return buildRace(id, units, {
    now,
    history,
    candidates: [
      { name: race.names.D, party: 'D', votes: totals.D },
      { name: race.names.R, party: 'R', votes: totals.R },
      { name: 'Others', party: 'O', votes: totals.O },
    ],
    feeds: [{ id: 'demo', adapter: 'demo', ok: true, fetchedAt: now, note: 'Simulated returns' }],
  });
}

/** Simulate the whole board at a clock time. Returns the same shape as results/summary.json. */
export function simulateBoard(demo, minutes, envKey = 'wave') {
  const races = {};
  for (const id of Object.keys(demo.races)) races[id] = simulateRace(demo, id, minutes, envKey).summary;
  return { generatedAt: demoClockIso(minutes), mode: 'demo', env: envKey, races };
}

/** Election-night clock in ET as an ISO string (Nov 3, 2026, EST = UTC-5). */
export function demoClockIso(minutes) {
  const base = Date.UTC(2026, 10, 3, 23, 0, 0); // 6:00 pm EST
  return new Date(base + minutes * 60000).toISOString();
}
