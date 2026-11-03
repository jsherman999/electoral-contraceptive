// Texas Secretary of State election-night results (Civix "IVIS ENR", goelect.txelections.civixapps.com).
// County-level results for every race, as base64-wrapped JSON:
//   GET /api-ivis-system/api/s3/enr/electionConstants          -> {"upload": base64(JSON)}
//       { electionInfo: { "2026": { "GE": { "53815": { ID, N: "2026 NOVEMBER GENERAL ELECTION" } } } } }
//   GET /api-ivis-system/api/s3/enr/election/countyInfo/<id>   -> {"upload": base64(JSON)}
//       { "<countyId>": { N: "NOLAN", Races: { "<raceId>": { N: "U. S. SENATOR", PR, TP,
//           C: { "<candId>": { N: "JAMES TALARICO", P: "DEM", V: votes, EV: early votes } } } } } }
//
// Config: { "adapter": "tx-civix", "electionId": 53815 }   (or "year": "2026" to look up the general election)
import { get } from '../lib/http.js';

const BASE = 'https://goelect.txelections.civixapps.com/api-ivis-system/api/s3/enr';

function unwrap(res) {
  const j = res.json();
  return j && typeof j.upload === 'string' ? JSON.parse(Buffer.from(j.upload, 'base64').toString('utf8')) : j;
}

let cachedId = null;
async function generalElectionId(feed) {
  if (feed.electionId) return feed.electionId;
  if (cachedId) return cachedId;
  const info = unwrap(await get(`${feed.base || BASE}/electionConstants`, { conditional: false })).electionInfo || {};
  const year = String(feed.year || new Date().getFullYear());
  for (const group of Object.values(info[year] || {})) {
    for (const e of Object.values(group)) if (/NOVEMBER GENERAL/i.test(e.N || '')) cachedId = e.ID;
  }
  if (!cachedId) throw new Error(`no ${year} November general election in the Texas election list`);
  return cachedId;
}

export async function fetchFeed(feed, ctx = {}) {
  const id = await generalElectionId(feed);
  const url = `${feed.base || BASE}/election/countyInfo/${id}`;
  const res = await get(url, { timeoutMs: 120000 });
  if (res.notModified && ctx.previous) return { ...ctx.previous, notModified: true };
  const data = unwrap(res);
  const rows = [];
  for (const county of Object.values(data)) {
    for (const race of Object.values(county.Races || {})) {
      const contest = String(race.N || '').trim();
      if (ctx.contestFilters && !ctx.contestFilters.some((re) => re.test(contest))) continue;
      for (const c of Object.values(race.C || {})) {
        rows.push({
          county: county.N,
          precinct: null,
          level: 'county',
          contest,
          candidate: c.N,
          party: c.P || '',
          mode: 'TOTAL',
          votes: Number(c.V) || 0,
          prTot: Number(race.TP) || 0,
          prRep: Number(race.PR) || 0,
        });
      }
    }
  }
  return { rows, meta: { url, note: `election ${id}` } };
}
