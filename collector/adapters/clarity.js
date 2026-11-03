// Clarity / Scytl election-night reporting (results.enr.clarityelections.com).
// Used statewide in SC, CO, IA, AR, WV and by many counties elsewhere.
//
// Config: paste the results page URL you see in the browser, e.g.
//   https://results.enr.clarityelections.com/SC/123456/web.345435/#/summary        (statewide)
//   https://results.enr.clarityelections.com/PA/Bucks/123457/web.345435/#/summary  (one county)
// For a statewide page the adapter reads the list of participating counties and downloads each
// county's precinct-level detail.xml. Limit counties with feed.counties: ["Charleston", ...].
import { get } from '../lib/http.js';
import { unzipEntry, isZip } from '../lib/zip.js';

const HOST = 'https://results.enr.clarityelections.com';

export function parseClarityUrl(url) {
  const m = String(url).match(/clarityelections\.com\/+([A-Z]{2})(?:\/([^/#?]+?))?\/(\d+)(?:\/|$|#|\?)/i);
  if (!m) throw new Error(`Not a Clarity results URL: ${url}`);
  const [, st, county, eid] = m;
  if (county && /^\d+$/.test(county)) return { st: st.toUpperCase(), county: null, eid: county };
  return { st: st.toUpperCase(), county: county || null, eid };
}

async function currentVersion(path) {
  const res = await get(`${HOST}/${path}/current_ver.txt`, { conditional: false, retries: 2 });
  const v = res.text().trim();
  if (!/^\d+$/.test(v)) throw new Error(`Unexpected current_ver.txt for ${path}: ${v.slice(0, 40)}`);
  return v;
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
  while ((cm = contestRe.exec(xml))) {
    const ca = attrs(cm[1]);
    const contest = ca.text || '';
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
  return { rows, timestamp: ts, region, reporting };
}

async function detailFor(path, ver, opts) {
  const res = await get(`${HOST}/${path}/${ver}/reports/detailxml.zip`, { timeoutMs: 90000 });
  const xml = (isZip(res.buf) ? unzipEntry(res.buf, /\.xml$/i) : res.buf).toString('utf8');
  return parseDetailXml(xml, opts);
}

export async function fetchFeed(feed, ctx = {}) {
  const { st, county, eid } = parseClarityUrl(feed.url);
  const filters = ctx.contestFilters || null;
  if (county) {
    const path = `${st}/${county}/${eid}`;
    const ver = await currentVersion(path);
    const d = await detailFor(path, ver, { county: county.replace(/_/g, ' '), contestFilters: filters });
    return { rows: d.rows, meta: { url: feed.url, sourceUpdatedAt: d.timestamp, note: `version ${ver}` } };
  }
  const path = `${st}/${eid}`;
  const ver = await currentVersion(path);
  let counties = [];
  try {
    const settings = (await get(`${HOST}/${path}/${ver}/json/electionsettings.json`, { conditional: false })).json();
    const list = settings?.settings?.electiondetails?.participatingcounties || [];
    counties = list.map((s) => {
      const [name, ceid, cver] = String(s).split('|');
      return { name, ceid, cver };
    });
  } catch (e) {
    ctx.log?.(`clarity ${path}: no county list (${e.message}); using statewide county-level detail`);
  }
  const want = feed.counties ? new Set(feed.counties.map((c) => c.toUpperCase())) : null;
  if (want) counties = counties.filter((c) => want.has(c.name.toUpperCase()) || want.has(c.name.replace(/_/g, ' ').toUpperCase()));

  const rows = [];
  const failed = [];
  let ts = null;
  const covered = new Set();
  const limit = feed.concurrency || 6;
  for (let i = 0; i < counties.length; i += limit) {
    await Promise.all(
      counties.slice(i, i + limit).map(async (c) => {
        try {
          const cpath = `${st}/${c.name}/${c.ceid}`;
          const ver2 = c.cver && /^\d+$/.test(c.cver) ? c.cver : await currentVersion(cpath);
          const d = await detailFor(cpath, ver2, { county: c.name.replace(/_/g, ' '), contestFilters: filters });
          rows.push(...d.rows);
          covered.add(c.name.replace(/_/g, ' ').toUpperCase());
          ts = d.timestamp || ts;
        } catch (e) {
          failed.push(`${c.name}: ${e.message}`);
        }
      })
    );
  }
  // Counties we could not get precinct detail for fall back to the statewide county-level numbers.
  if (!counties.length || failed.length) {
    try {
      const d = await detailFor(path, ver, { contestFilters: filters });
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
      note: `${covered.size} county precinct files${failed.length ? `; ${failed.length} failed (${failed.slice(0, 3).join('; ')})` : ''}`,
    },
  };
}
