// Enhanced Voting results sites (Georgia: results.sos.ga.gov, Virginia: enr.elections.virginia.gov, ...).
// Their public pages look like  https://<host>/results/public/<State>/elections/<ElectionSlug>
// and offer a JSON export. The export's exact layout is not documented, so this adapter walks the JSON
// looking for ballot items whose name matches the race and reads precinct results wherever it finds
// them. Check it against the real export on election night; if it misreads, point the race at the
// generic `json` or `delimited` adapter instead.
//
// Config: { "adapter": "enhanced-voting", "url": "<public page URL or direct JSON export URL>" }
import { get } from '../lib/http.js';

export function exportUrl(url) {
  if (/\.json(\?|$)/i.test(url)) return url;
  const m = String(url).match(/^(https?:\/\/[^/]+)\/results\/public\/([^/]+)\/elections\/([^/#?]+)/i);
  if (!m) throw new Error(`Not an Enhanced Voting election URL: ${url}`);
  return `${m[1]}/cdn/results/${m[2]}/export-${m[3]}.json`;
}

const nameOf = (o) => o?.name ?? o?.Name ?? o?.title ?? o?.ballotItemName ?? null;
const arr = (o, ...keys) => {
  for (const k of keys) if (Array.isArray(o?.[k])) return o[k];
  return null;
};
const votesOf = (o) => Number(o?.voteCount ?? o?.votes ?? o?.VoteCount ?? 0) || 0;

function groups(o) {
  const g = arr(o, 'groupResults', 'voteTypeResults', 'groups');
  if (!g || !g.length) return [['TOTAL', votesOf(o)]];
  return g.map((x) => [x.groupName ?? x.name ?? 'TOTAL', votesOf(x)]);
}

export function walkExport(json, contestFilters) {
  const rows = [];
  // A node holding ballot items inside an array called localResults / counties / jurisdictions is a county.
  const visit = (node, county, parentKey) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const x of node) visit(x, county, parentKey);
      return;
    }
    const items = arr(node, 'ballotItems', 'contests', 'BallotItems');
    const here = items && /local|count|jurisdiction|parish/i.test(parentKey || '') && nameOf(node) ? nameOf(node) : county;
    if (items) {
      for (const item of items) {
        const contest = nameOf(item) || '';
        if (contestFilters && !contestFilters.some((re) => re.test(contest))) continue;
        for (const opt of arr(item, 'ballotOptions', 'options', 'candidates') || []) {
          const cand = nameOf(opt);
          const party = opt.politicalParty ?? opt.party ?? opt.partyName ?? '';
          const prec = arr(opt, 'precinctResults', 'precincts');
          if (prec && prec.length) {
            for (const p of prec) {
              for (const [mode, v] of groups(p)) {
                rows.push({ county: p.countyName ?? here ?? '', precinct: nameOf(p), contest, candidate: cand, party, mode, votes: v, level: 'precinct' });
              }
            }
          } else if (here) {
            for (const [mode, v] of groups(opt)) {
              rows.push({ county: here, precinct: null, contest, candidate: cand, party, mode, votes: v, level: 'county' });
            }
          }
        }
      }
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === 'ballotItems' || k === 'contests' || k === 'BallotItems') continue;
      if (v && typeof v === 'object') visit(v, here, k);
    }
  };
  visit(json, undefined, '');
  // If both precinct- and county-level rows exist for a county, keep the precinct rows.
  const precCounties = new Set(rows.filter((r) => r.level === 'precinct').map((r) => r.county));
  return rows.filter((r) => r.level === 'precinct' || !precCounties.has(r.county));
}

export async function fetchFeed(feed, ctx = {}) {
  const url = exportUrl(feed.url);
  const res = await get(url, { timeoutMs: 120000, headers: { accept: 'application/json' } });
  const json = res.json();
  const rows = walkExport(json, ctx.contestFilters);
  return { rows, meta: { url, sourceUpdatedAt: json?.lastUpdated ?? json?.LastUpdated ?? res.headers.get('last-modified') ?? null } };
}
