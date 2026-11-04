// Clarity / Scytl election-night reporting. Runs on results.enr.clarityelections.com and on
// state-branded hosts (South Carolina: www.enr-scvotes.org). Used statewide in SC, CO, IA, AR, WV and by
// many counties elsewhere.
//
// Config, either:
//   { "adapter": "clarity", "url": "<the results page URL from your browser>" }
//       https://www.enr-scvotes.org/SC/122436/web.345435/#/summary                  (statewide)
//       https://results.enr.clarityelections.com/PA/Bucks/123457/web.345435/#/summary  (one county)
// or let the collector find tonight's election by itself:
//   { "adapter": "clarity", "discover": { "state": "SC", "date": "2026-11-03",
//       "pages": ["<official pages that link to the results site>", ...] } }
//   Discovery collects every <host>/<ST>/<election id> link on those pages, then checks the newest
//   ones for the election date before using one. A pasted url always wins over discovery.
// For a statewide page the adapter reads the list of participating counties and downloads each
// county's precinct-level detail.xml. Limit counties with feed.counties: ["Charleston", ...].
import { get } from '../lib/http.js';
import { unzipEntry, isZip } from '../lib/zip.js';

export function parseClarityUrl(url) {
  const m = String(url).match(/^(https?:\/\/[^/]+)\/+([A-Z]{2})(?:\/([^/#?]+?))?\/(\d+)(?:\/|$|#|\?)/i);
  if (!m) throw new Error(`Not a Clarity results URL: ${url}`);
  const [, origin, st, county, eid] = m;
  if (county && /^\d+$/.test(county)) return { origin, st: st.toUpperCase(), county: null, eid: county };
  return { origin, st: st.toUpperCase(), county: county || null, eid };
}

async function currentVersion(origin, path) {
  const res = await get(`${origin}/${path}/current_ver.txt`, { conditional: false, retries: 2 });
  const v = res.text().trim();
  if (!/^\d+$/.test(v)) throw new Error(`Unexpected current_ver.txt for ${path}: ${v.slice(0, 40)}`);
  return v;
}

/** Participating counties are strings like "Abbeville|115217|300123|11/8/2022 9:15:00 PM|8"; find them anywhere. */
function findCountyList(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return [];
  if (Array.isArray(node) && node.length && node.every((x) => typeof x === 'string' && /^[^|]+\|\d+\|\d+/.test(x))) return node;
  for (const v of Object.values(node)) {
    const r = findCountyList(v, depth + 1);
    if (r.length) return r;
  }
  return [];
}

const countyCache = new Map(); // county detail by results version, so unchanged counties aren't refetched
const countyMissing = new Map(); // county precinct file -> time to look again after a 404 (e.g. Colorado has none)

// ---------------------------------------------------------------- discovery
const discovered = new Map(); // feed key -> { url, verified, at }

function datePatterns(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const month = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1];
  return new RegExp(
    [`\\b0?${m}/0?${d}/${y}\\b`, `${y}-0?${m}-0?${d}`, `${month}\\s+0?${d},?\\s+${y}`, `${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`].join('|'),
    'i'
  );
}

/**
 * Find this state's (or, with cfg.county, one county's) results URL for the configured election date.
 * Returns { url, verified, note }.
 */
export async function discover(cfg, log = () => {}) {
  const st = String(cfg.state).toUpperCase();
  // County sites live at /<ST>/<County>/<id>/ (spaces as underscores, e.g. MI/St_Clair).
  const county = cfg.county ? String(cfg.county).replace(/\s+/g, '_') : null;
  const base = county ? `${st}/${county}` : st;
  const key = `${base}|${cfg.date}`;
  if (discovered.has(key)) return discovered.get(key);
  const segRe = county ? `${st}\\/${county.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` : st;
  const linkRe = new RegExp(`(https?:\\/\\/[a-z0-9.-]+)?\\/${segRe}\\/(\\d{5,7})(?=[\\/#?"'\\s<]|$)`, 'gi');
  const hostRe = cfg.hostPattern ? new RegExp(cfg.hostPattern, 'i') : /clarity|enr|electionresult/i;
  const cands = new Map();
  const seen = [];
  for (const page of cfg.pages || []) {
    try {
      const res = await get(page, { timeoutMs: 30000, retries: 1, conditional: false, headers: { accept: 'text/html,*/*' } });
      const html = res.text();
      const origin = new URL(page).origin;
      let n = 0;
      for (const m of html.matchAll(linkRe)) {
        const host = m[1] || origin;
        if (!hostRe.test(host)) continue;
        cands.set(`${host}|${m[2]}`, { origin: host, eid: Number(m[2]) });
        n += 1;
      }
      seen.push(`${new URL(page).host}: ${n} links`);
    } catch (e) {
      seen.push(`${new URL(page).host}: ${e.message.slice(0, 60)}`);
    }
  }
  const dateRe = datePatterns(cfg.date);
  // Same-day specials and primaries share the election date, so also require a federal contest.
  const contestRe = new RegExp(cfg.requireContest || String.raw`U\.?\s?S\.?\s*(House|Rep|Senat)|United States (Senat|Rep|Congress)|Congress`, 'i');
  const ranked = [...cands.values()].sort((a, b) => b.eid - a.eid).slice(0, cfg.maxCandidates || 12);
  let withContest = null;
  let fallback = null;
  const tried = [];
  let blockedErr = null;
  for (const c of ranked) {
    tried.push(`${c.origin}/${base}/${c.eid}`);
    try {
      const ver = await currentVersion(c.origin, `${base}/${c.eid}`);
      const url = `${c.origin}/${base}/${c.eid}/`;
      fallback ||= url;
      let text = '';
      for (const f of ['json/en/electionsettings.json', 'json/electionsettings.json', 'json/en/summary.json', 'json/summary.json']) {
        try {
          text += (await get(`${c.origin}/${base}/${c.eid}/${ver}/${f}`, { conditional: false, retries: 0, timeoutMs: 20000 })).text().slice(0, 400000);
        } catch {
          /* try the next file */
        }
      }
      const hasDate = dateRe.test(text);
      const hasContest = contestRe.test(text);
      tried[tried.length - 1] += hasContest ? (hasDate ? ' (date + federal contests)' : ' (federal contests)') : hasDate ? ' (date, no federal contests)' : '';
      if (hasDate && hasContest) {
        const hit = { url, verified: true, note: `discovered ${url} (election date ${cfg.date} and federal contests confirmed)` };
        discovered.set(key, hit);
        log(`clarity ${base}: ${hit.note}`);
        return hit;
      }
      if (hasContest && !withContest) withContest = url;
    } catch (e) {
      if (e.blocked) blockedErr = e;
      tried[tried.length - 1] += ` (${e.message.replace(/ for https?:\S+/, '').slice(0, 50)})`;
    }
  }
  // An election whose date couldn't be confirmed is never used unless the feed opts in
  // (discover.allowUnconfirmed): a county page's newest link can be a past election with full results.
  if (cfg.allowUnconfirmed && (withContest || fallback)) {
    // Not cached, so the next pass tries again to confirm.
    const url = withContest || fallback;
    const hit = { url, verified: false, note: `using ${url}: ${withContest ? 'has federal contests, date not confirmed' : 'newest election found, not confirmed'} (checked ${tried.slice(0, 6).join(', ')})` };
    log(`clarity ${base}: ${hit.note}`);
    return hit;
  }
  if (blockedErr) {
    const e = new Error(`${blockedErr.message}; newest ${base} election linked: ${ranked[0].origin}/${base}/${ranked[0].eid}/`);
    e.blocked = true;
    throw e;
  }
  throw new Error(
    `could not find the ${cfg.date} election (pages: ${seen.join('; ') || 'none configured'}; newest candidates: ${tried.slice(0, 4).join(', ') || 'none'}); paste the results URL into config/sources.json`
  );
}

const attrRe = /([\w:-]+)="([^"]*)"/g;
const decode = (s) =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
function attrs(tag) {
  const o = {};
  let m;
  attrRe.lastIndex = 0;
  while ((m = attrRe.exec(tag))) o[m[1]] = decode(m[2]);
  return o;
}

/**
 * Parse Clarity detail.xml into rows. Precinct-level for county pages; county-level for state pages.
 */
export function parseDetailXml(xml, { county = null, contestFilters = null } = {}) {
  const rows = [];
  const ts = (xml.match(/<Timestamp>([^<]*)<\/Timestamp>/) || [])[1] || null;
  const region = (xml.match(/<Region>([^<]*)<\/Region>/) || [])[1] || null;
  const contestRe = /<Contest\b([^>]*)>([\s\S]*?)<\/Contest>/g;
  let cm;
  const allContests = [];
  while ((cm = contestRe.exec(xml))) {
    const ca = attrs(cm[1]);
    const contest = ca.text || '';
    allContests.push(contest);
    if (contestFilters && !contestFilters.some((re) => re.test(contest))) continue;
    const choiceRe = /<Choice\b([^>]*)>([\s\S]*?)<\/Choice>/g;
    let ch;
    while ((ch = choiceRe.exec(cm[2]))) {
      const cha = attrs(ch[1]);
      const vtRe = /<VoteType\b([^>]*)>([\s\S]*?)<\/VoteType>/g;
      let vt;
      while ((vt = vtRe.exec(ch[2]))) {
        const vta = attrs(vt[1]);
        const unitRe = /<(Precinct|County)\b([^>]*?)\/?>/g;
        let u;
        while ((u = unitRe.exec(vt[2]))) {
          const ua = attrs(u[2]);
          const isCounty = u[1] === 'County';
          rows.push({
            county: isCounty ? ua.name : county || region || '',
            precinct: isCounty ? null : ua.name,
            level: isCounty ? 'county' : 'precinct',
            contest,
            candidate: cha.text,
            party: cha.party || '',
            mode: vta.name,
            votes: Number(ua.votes) || 0,
          });
        }
      }
    }
  }
  // Precinct reporting flags (county pages)
  const reporting = {};
  const tr = xml.match(/<VoterTurnout\b[\s\S]*?<\/VoterTurnout>/);
  if (tr) {
    const pr = /<(Precinct|County)\b([^>]*?)\/>/g;
    let m;
    while ((m = pr.exec(tr[0]))) {
      const a = attrs(m[2]);
      reporting[a.name] = a;
    }
  }
  return { rows, timestamp: ts, region, reporting, allContests };
}

async function detailFor(origin, path, ver, opts) {
  const res = await get(`${origin}/${path}/${ver}/reports/detailxml.zip`, { timeoutMs: 90000 });
  const xml = (isZip(res.buf) ? unzipEntry(res.buf, /\.xml$/i) : res.buf).toString('utf8');
  return parseDetailXml(xml, opts);
}

export async function fetchFeed(feed, ctx = {}) {
  let url = feed.url;
  let found = null;
  if (!url && feed.discover) {
    found = await discover(feed.discover, ctx.log);
    url = found.url;
  }
  if (!url) throw new Error('no URL configured yet');
  const res = await fetchClarity({ ...feed, url }, ctx);
  if (found) res.meta.note = `${found.note}; ${res.meta.note || ''}`;
  res.meta.url = url;
  return res;
}

async function fetchClarity(feed, ctx) {
  const { origin, st, county, eid } = parseClarityUrl(feed.url);
  const filters = ctx.contestFilters || null;
  const filterKey = (filters || []).map((re) => re.source).join('|');
  if (county) {
    const path = `${st}/${county}/${eid}`;
    const ver = await currentVersion(origin, path);
    // The precinct file is only downloaded again when the results version changes.
    const key = `${origin}/${path}|${filterKey}`;
    const hit = countyCache.get(key);
    const d = hit && hit.ver === ver ? hit.d : await detailFor(origin, path, ver, { county: county.replace(/_/g, ' '), contestFilters: filters });
    if (!hit || hit.ver !== ver) countyCache.set(key, { ver, d, at: Date.now() });
    return { rows: d.rows, meta: { url: feed.url, sourceUpdatedAt: d.timestamp, note: `version ${ver}${hit && hit.ver === ver ? ' (unchanged)' : ''}` } };
  }
  const path = `${st}/${eid}`;
  const ver = await currentVersion(origin, path);
  let counties = [];
  // Older Clarity sites keep settings at json/electionsettings.json, newer ones at json/en/.
  let settingsErr = null;
  for (const f of ['json/en/electionsettings.json', 'json/electionsettings.json']) {
    try {
      const settings = (await get(`${origin}/${path}/${ver}/${f}`, { conditional: false, retries: 1 })).json();
      const list = findCountyList(settings);
      if (!list.length) {
        settingsErr = new Error(`no county list in ${f} (keys: ${Object.keys(settings?.settings || settings || {}).slice(0, 12).join(', ')})`);
        continue;
      }
      counties = list.map((s) => {
        const [name, ceid, cver] = String(s).split('|');
        return { name, ceid, cver };
      });
      settingsErr = null;
      break;
    } catch (e) {
      settingsErr = e;
      if (e.blocked) break;
    }
  }
  if (settingsErr) ctx.log?.(`clarity ${path}: no county list (${settingsErr.message}); using statewide county-level detail`);
  const want = feed.counties ? new Set(feed.counties.map((c) => c.toUpperCase())) : null;
  if (want) counties = counties.filter((c) => want.has(c.name.toUpperCase()) || want.has(c.name.replace(/_/g, ' ').toUpperCase()));

  const rows = [];
  const failed = [];
  let ts = null;
  const covered = new Set();
  const limit = feed.concurrency || 6;
  let reused = 0;
  let stale = 0;
  let deferred = 0;
  let blocked = null;
  // feed.maxDownloads caps the county precinct files downloaded per pass (the home relay sets it, so a
  // state with ~100 counties all updating doesn't send hundreds of requests every 90 s). Counties never
  // downloaded go first, then the ones downloaded longest ago; the rest keep their last file this pass.
  const keyOf = (c) => `${origin}/${st}/${c.name}/${c.ceid}|${filterKey}`;
  counties.sort((a, b) => (countyCache.get(keyOf(a))?.at || 0) - (countyCache.get(keyOf(b))?.at || 0));
  let budget = feed.maxDownloads > 0 ? feed.maxDownloads : Infinity;
  for (let i = 0; i < counties.length && !blocked; i += limit) {
    await Promise.all(
      counties.slice(i, i + limit).map(async (c) => {
        try {
          const cpath = `${st}/${c.name}/${c.ceid}`;
          const ver2 = c.cver && /^\d+$/.test(c.cver) ? c.cver : await currentVersion(origin, cpath);
          // Only download a county's precinct file when its results version changes.
          const key = keyOf(c);
          const hit = countyCache.get(key);
          let d;
          if (hit && hit.ver === ver2) {
            d = hit.d;
            reused += 1;
          } else if (budget <= 0 || blocked || countyMissing.get(key) > Date.now()) {
            if (!hit) {
              deferred += 1; // filled in from the statewide county-level file below
              return;
            }
            d = hit.d;
            stale += 1;
          } else {
            budget -= 1;
            d = await detailFor(origin, cpath, ver2, { county: c.name.replace(/_/g, ' '), contestFilters: filters });
            countyCache.set(key, { ver: ver2, d, at: Date.now() });
          }
          rows.push(...d.rows);
          covered.add(c.name.replace(/_/g, ' ').toUpperCase());
          ts = d.timestamp || ts;
        } catch (e) {
          if (e.blocked) blocked = e;
          // No precinct file for this county: use its county total and ask again in 30 minutes.
          if (e.status === 404) countyMissing.set(keyOf(c), Date.now() + 30 * 60000);
          failed.push(`${c.name}: ${e.message}`);
        }
      })
    );
  }
  // Refused by the site: stop asking now, so the caller can back off.
  if (blocked) throw blocked;
  // Counties we could not get precinct detail for fall back to the statewide county-level numbers.
  if (!counties.length || failed.length || deferred || !rows.length) {
    try {
      const d = await detailFor(origin, path, ver, { contestFilters: filters });
      if (!d.rows.length) failed.push(`statewide file matched no board contest; it has ${d.allContests.length} contests, e.g. ${d.allContests.filter((c) => /congress|house|rep|senat/i.test(c)).slice(0, 4).join(' | ') || d.allContests.slice(0, 4).join(' | ')}`);
      ts = ts || d.timestamp;
      for (const r of d.rows) if (r.level === 'county' && !covered.has(String(r.county).toUpperCase())) rows.push(r);
    } catch (e) {
      failed.push(`statewide: ${e.message}`);
    }
  }
  return {
    rows,
    meta: {
      url: feed.url,
      sourceUpdatedAt: ts,
      note: `${covered.size} county precinct files (${reused} unchanged${stale ? `, ${stale} updated next pass` : ''})${deferred ? `; ${deferred} counties county-level until their precinct file is fetched` : ''}${failed.length ? `; ${failed.length} failed (${failed.slice(0, 3).join('; ')})` : ''}`,
    },
  };
}
