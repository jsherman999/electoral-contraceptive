// Feed rows -> units (precincts or counties) for one race.
import { normMode, normParty, partyFromName, candidateKey, isVirtualPrecinct, isNonCandidate, countyKey, stripPartyPrefix } from '../../site/js/shared/normalize.js';

/**
 * @param {Array} rows  adapter rows already filtered to this race's contest
 * @param {object} [opts]
 * @param {object} [opts.candidates]  overrides { "Candidate Name": "D" | "R" | "O" }
 * @returns {{ units: Array, candidates: Array, contests: string[] }}
 */
export function buildUnits(rows, opts = {}) {
  const overrides = {};
  for (const [n, p] of Object.entries(opts.candidates || {})) overrides[candidateKey(n)] = p;

  // Party per candidate: fusion lines (NY) put one candidate on several party lines, so a
  // candidate with any Democratic (Republican) line counts as D (R) on every line.
  const party = new Map();
  for (const r of rows) {
    if (isNonCandidate(r.candidate)) continue;
    const ck = candidateKey(r.candidate);
    if (overrides[ck]) {
      party.set(ck, overrides[ck]);
      continue;
    }
    const p = normParty(r.party) !== 'O' ? normParty(r.party) : partyFromName(r.candidate) || 'O';
    const prev = party.get(ck);
    if (!prev || (prev === 'O' && p !== 'O')) party.set(ck, p);
  }

  // County names differ in case between feeds (Texas's state file: HARRIS; county sites: Harris).
  const precCounties = new Set(rows.filter((r) => r.precinct != null && r.level !== 'county').map((r) => countyKey(r.county)));
  const units = new Map();
  const cands = new Map();
  const contests = new Set();
  for (const r of rows) {
    if (isNonCandidate(r.candidate)) continue;
    const isCounty = r.precinct == null || r.level === 'county';
    if (isCounty && precCounties.has(countyKey(r.county))) continue; // precinct detail wins over county totals
    contests.add(r.contest);
    const ck = candidateKey(r.candidate);
    const p = party.get(ck) || 'O';
    const key = `${r.county}|${isCounty ? '*' : r.precinct}`;
    let u = units.get(key);
    if (!u) {
      u = {
        c: r.county,
        p: isCounty ? null : String(r.precinct),
        lvl: isCounty ? 'county' : 'precinct',
        v: isCounty ? false : r.virtual ?? isVirtualPrecinct(r.precinct),
        x: null,
        live: {},
      };
      if (isCounty && (r.prTot || r.prRep)) u.pr = { tot: r.prTot || 0, rep: r.prRep || 0 };
      if (isCounty && r.prUnknown) u.prUnknown = true; // feed has no precinct counts (Indiana)
      units.set(key, u);
    }
    const m = normMode(r.mode);
    const cell = (u.live[m] ||= [0, 0, 0]);
    const v = Number(r.votes) || 0;
    cell[p === 'D' ? 0 : p === 'R' ? 1 : 2] += v;
    const c = cands.get(ck) || { name: stripPartyPrefix(r.candidate), party: p, votes: 0 };
    c.votes += v;
    cands.set(ck, c);
  }
  for (const u of units.values()) {
    // A unit reporting both a mode breakdown and a TOTAL row would double count.
    if (u.live.TOTAL && Object.keys(u.live).length > 1) delete u.live.TOTAL;
    if (u.p == null) u.p = 'County total';
  }
  // Fold minor candidates into "Others" for display.
  const list = [...cands.values()].sort((a, b) => b.votes - a.votes);
  const major = list.filter((c) => c.party === 'D' || c.party === 'R');
  const others = list.filter((c) => c.party === 'O');
  const candidates = [...major];
  if (others.length === 1) candidates.push(others[0]);
  else if (others.length > 1) candidates.push({ name: `Others (${others.length})`, party: 'O', votes: others.reduce((a, c) => a + c.votes, 0) });
  return { units: [...units.values()], candidates, contests: [...contests] };
}
