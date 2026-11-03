// Indiana Election Division election-night results (enr.indianavoters.in.gov), county level.
//   data/settings.json             VersionType: the current file suffix ("A" or "B", flips on each update)
//   data/OffCatC_<id>_<suffix>.json every race in an office category, by district, then by county
// Office category 1005 is "US Representative". Contest names come out as the site's OFFICE_TITLE,
// e.g. "United States Representative, Fifth District".
// Config: { "adapter": "in-enr", "url": "https://enr.indianavoters.in.gov/site/", "categories": ["1005"] }
import { get } from '../lib/http.js';

const arr = (x) => (Array.isArray(x) ? x : x == null ? [] : [x]);
const num = (x) => {
  const n = Number(String(x ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};

export function parseOfficeCategory(json, ctx = {}) {
  const root = json.Root || json;
  const rows = [];
  for (const region of arr(root.OfficeCategory?.Regions?.Region)) {
    for (const race of arr(region.Races?.Race)) {
      const contest = race.OFFICE_TITLE || race.SubSortOrder || '';
      if (ctx.contestFilters && !ctx.contestFilters.some((re) => re.test(contest))) continue;
      const county = race.Jurisdiction?.JURISDICTION_NAME;
      if (!county) continue;
      for (const c of arr(race.Candidates?.Candidate)) {
        rows.push({
          county,
          precinct: null,
          level: 'county',
          contest,
          candidate: c.NAME_ON_BALLOT || c.CandidateName || '',
          party: c.PARTY_ABBREV || c.PARTY || '',
          mode: 'TOTAL',
          votes: num(c.TOTAL_VOTES ?? c.TOTAL),
        });
      }
    }
  }
  return { rows, writeTime: root.WriteTime || null };
}

export async function fetchFeed(feed, ctx = {}) {
  const base = String(feed.url || 'https://enr.indianavoters.in.gov/site/')
    .replace(/#.*$/, '')
    .replace(/index\.html?$/i, '')
    .replace(/\/?$/, '/');
  const settings = (await get(`${base}data/settings.json`, { conditional: false, retries: 2 })).json();
  const s = settings.Root || settings;
  const suffix = s.VersionType || 'A';
  const rows = [];
  let ts = null;
  for (const cat of feed.categories || ['1005']) {
    const res = await get(`${base}data/OffCatC_${cat}_${suffix}.json`, { conditional: false, retries: 2, timeoutMs: 60000 });
    const d = parseOfficeCategory(res.json(), ctx);
    rows.push(...d.rows);
    ts = d.writeTime || ts;
  }
  return {
    rows,
    meta: {
      url: base,
      sourceUpdatedAt: ts ? `${ts}-05:00` : null,
      note: `version ${s.VersionCode || '?'} ${suffix}; county level`,
    },
  };
}
