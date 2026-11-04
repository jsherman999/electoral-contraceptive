// Harris County (Texas) election-night results, countywide by vote type.
// The live page (app.harrisvotes.com/electionresults/electionday) loads
//   <dnnPrefix>/Data/<electionCode>/resultsbyballot.json
//   { ec: "1126", edt: "November 03, 2026", contests: [{ t: "United States Senator", tp: 1224, pr: 0,
//       ca: ["KEN PAXTON (REP)", ...], ab: [...], ev: [...], ed: [...], tv: [...] }] }
// ab = mail ballots, ev = early voting, ed = election day; tp / pr = precincts total / reporting.
// Config: { "adapter": "harris", "page": "https://app.harrisvotes.com/electionresults/electionday",
//           "date": "November 03, 2026" }   (or "url": "<.../Data/1126/>" to skip reading the page)
import { get } from '../lib/http.js';

export function parseHarris(json, ctx = {}, county = 'Harris') {
  const rows = [];
  for (const c of json.contests || []) {
    const contest = String(c.t || '').trim();
    if (ctx.contestFilters && !ctx.contestFilters.some((re) => re.test(contest))) continue;
    (c.ca || []).forEach((label, i) => {
      const m = String(label).match(/^(.*?)\s*\(([A-Z]+)\)\s*$/);
      const candidate = m ? m[1] : String(label);
      const party = m ? m[2] : '';
      for (const [mode, arr] of [['MAIL', c.ab], ['EV', c.ev], ['ED', c.ed]]) {
        rows.push({
          county,
          precinct: null,
          level: 'county',
          contest,
          candidate,
          party,
          mode,
          votes: Number(arr?.[i]) || 0,
          prTot: Number(c.tp) || 0,
          prRep: Number(c.pr) || 0,
        });
      }
    });
  }
  return rows;
}

async function dataBase(feed) {
  if (feed.url) return feed.url.replace(/\/?$/, '/');
  const html = (await get(feed.page, { conditional: false, timeoutMs: 30000, headers: { accept: 'text/html' } })).text();
  const code = html.match(/electionCode\s*=\s*'([^']+)'/)?.[1];
  const prefix = html.match(/dnnPrefix\s*=\s*'([^']+)'/)?.[1];
  if (!code || !prefix) throw new Error('could not read the election code from the Harris results page');
  return `${prefix.replace(/\/$/, '')}/Data/${code}/`;
}

export async function fetchFeed(feed, ctx = {}) {
  const base = await dataBase(feed);
  const url = `${base}resultsbyballot.json`;
  const res = await get(`${url}?nocache=${Math.floor(Date.now() / 60000) * 60000}`, { conditional: false, timeoutMs: 60000 });
  const json = res.json();
  if (feed.date && !String(json.edt || '').includes(feed.date)) throw new Error(`Harris file is for "${json.edt}", not ${feed.date}`);
  return { rows: parseHarris(json, ctx, feed.county || 'Harris'), meta: { url, sourceUpdatedAt: json.dt || null, note: `${json.et || ''} ${json.edt || ''}`.trim() } };
}
