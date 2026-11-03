// Generic JSON adapter: point at an array of row objects inside any JSON document.
//
// Config:
// {
//   "adapter": "json",
//   "url": "https://example.gov/api/results.json",
//   "rowsPath": "data.precinctResults",           // dotted path to the array of rows
//   "fields": { "county": "county.name", "precinct": "precinct", "contest": "contestName",
//               "candidate": "candidate", "party": "party", "votes": "votes", "mode": "voteType" },
//   "constants": { "county": "Douglas" }
// }
import { get } from '../lib/http.js';
import { toNum } from '../lib/csv.js';

const at = (o, path) => (path ? String(path).split('.').reduce((x, k) => (x == null ? x : x[k]), o) : undefined);

export async function fetchFeed(feed, ctx = {}) {
  const res = await get(feed.url, { timeoutMs: 90000, headers: { accept: 'application/json' } });
  const json = res.json();
  const list = at(json, feed.rowsPath) ?? json;
  if (!Array.isArray(list)) throw new Error(`rowsPath "${feed.rowsPath}" is not an array`);
  const f = feed.fields || {};
  const k = feed.constants || {};
  const val = (r, key) => (k[key] !== undefined ? k[key] : at(r, f[key]));
  const rows = [];
  for (const r of list) {
    const contest = String(val(r, 'contest') ?? '');
    if (ctx.contestFilters && !ctx.contestFilters.some((re) => re.test(contest))) continue;
    rows.push({
      county: val(r, 'county') ?? '',
      precinct: val(r, 'precinct') ?? null,
      level: f.precinct || k.precinct ? 'precinct' : 'county',
      contest,
      candidate: val(r, 'candidate') ?? '',
      party: val(r, 'party') ?? '',
      mode: val(r, 'mode') ?? 'TOTAL',
      votes: toNum(val(r, 'votes')),
    });
  }
  return { rows, meta: { url: feed.url, sourceUpdatedAt: res.headers.get('last-modified') } };
}
