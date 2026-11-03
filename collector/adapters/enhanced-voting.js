// Enhanced Voting results sites (Georgia: results.sos.ga.gov, Virginia: enr.elections.virginia.gov, ...).
// Public pages look like  https://<host>/results/public/<State>/elections/<publicElectionId>
// The site's own API lists each state's elections:  /results/public/api/jurisdictions/<State>
//   -> { elections: [{ publicElectionId: "11032026GeneralAndSpecialElection", electionDate: "2026-11-03" }, ...] }
// and results are published as one JSON export:  /cdn/results/<State>/export-<publicElectionId>.json
//   -> { results: { ballotItems: [...] }, localResults: [{ name: "Candler County", ballotItems: [...] }] }
//   Each ballot option has groupResults (votes by vote type) and, at county level, precinctResults.
//
// Config: { "adapter": "enhanced-voting", "url": "<public page URL or direct export URL>", "date": "2026-11-03" }
// With "date", the election ID is looked up from the state's election list, so a wrong ID in the URL
// is corrected automatically.
import { get } from '../lib/http.js';

export function parseEvUrl(url) {
  const m = String(url).match(/^(https?:\/\/[^/]+)\/results\/public\/([^/]+)\/elections\/([^/#?]+)/i);
  if (!m) return null;
  return { origin: m[1], state: m[2], id: m[3] };
}

export function exportUrl(url) {
  if (/\.json(\?|$)/i.test(url)) return url;
  const p = parseEvUrl(url);
  if (!p) throw new Error(`Not an Enhanced Voting election URL: ${url}`);
  return `${p.origin}/cdn/results/${p.state}/export-${p.id}.json`;
}

const idCache = new Map();
async function electionIdForDate(origin, state, date) {
  const key = `${origin}|${state}|${date}`;
  if (idCache.has(key)) return idCache.get(key);
  const j = (await get(`${origin}/results/public/api/jurisdictions/${state}`, { conditional: false, timeoutMs: 30000 })).json();
  const hit = (j.elections || []).find((e) => e.electionDate === date);
  const id = hit ? hit.publicElectionId : null;
  if (id) idCache.set(key, id);
  return id;
}

function findExportPath(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'string' && /export/i.test(k) && /\.json$/i.test(v)) return v;
    if (v && typeof v === 'object') {
      const r = findExportPath(v, depth + 1);
      if (r) return r;
    }
  }
  return null;
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
  let candidates = [];
  let note = '';
  if (/\.json(\?|$)/i.test(feed.url)) candidates = [feed.url];
  else {
    const p = parseEvUrl(feed.url);
    if (!p) throw new Error(`Not an Enhanced Voting election URL: ${feed.url}`);
    let id = p.id;
    if (feed.date) {
      try {
        const found = await electionIdForDate(p.origin, p.state, feed.date);
        if (found && found !== id) note = `election ID ${found} (from the state's election list)`;
        id = found || id;
      } catch (e) {
        note = `election list unavailable (${e.message.slice(0, 60)})`;
      }
    }
    candidates.push(`${p.origin}/cdn/results/${p.state}/export-${id}.json`);
    try {
      const meta = (await get(`${p.origin}/results/public/api/elections/${p.state}/${id}`, { conditional: false, retries: 0, timeoutMs: 20000 })).json();
      const path = findExportPath(meta);
      if (path) candidates.unshift(`${p.origin}/cdn/results/${path.replace(/^\/+/, '')}`);
    } catch {
      /* the default export path is still tried */
    }
  }
  let lastErr = null;
  for (const url of [...new Set(candidates)]) {
    try {
      const res = await get(url, { timeoutMs: 180000, headers: { accept: 'application/json' } });
      const json = res.json();
      const rows = walkExport(json, ctx.contestFilters);
      return {
        rows,
        meta: { url, sourceUpdatedAt: json?.asOf ?? json?.lastUpdated ?? json?.createdAt ?? res.headers.get('last-modified') ?? null, note },
      };
    } catch (e) {
      lastErr = e;
    }
  }
  const e = new Error(
    `results export not published yet${lastErr?.status === 404 ? '' : ` (${lastErr?.message || 'unknown error'})`}: ${candidates[candidates.length - 1]}${note ? `; ${note}` : ''}`
  );
  throw e;
}
