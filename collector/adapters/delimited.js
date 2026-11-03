// Generic CSV / TSV (optionally zipped) adapter for any precinct-level results file.
//
// Config:
// {
//   "adapter": "delimited",
//   "url": "https://example.gov/results/precincts.csv",
//   "zipEntry": "\\.csv$",                       // optional regex for the file inside a zip
//   "delimiter": ",",                            // optional; sniffed from the header otherwise
//   "columns": {                                  // header names in the file
//     "county": "County", "precinct": "Precinct", "contest": "Contest", "candidate": "Candidate",
//     "party": "Party",
//     "votes": "Votes",                           // long format: one vote column ...
//     "mode": "Vote Type",                        // ... with an optional vote-type column
//     "modes": { "ED": "Election Day", "EV": "Early", "MAIL": "Absentee", "PROV": "Provisional" }
//                                                 // or wide format: one column per vote type
//   },
//   "constants": { "county": "Maricopa" }          // fixed values for columns the file lacks
// }
import { get } from '../lib/http.js';
import { unzipEntry, isZip } from '../lib/zip.js';
import { parseDelimited, toNum } from '../lib/csv.js';

export async function fetchFeed(feed, ctx = {}) {
  const res = await get(feed.url, { timeoutMs: 120000 });
  const buf = isZip(res.buf) ? unzipEntry(res.buf, feed.zipEntry ? new RegExp(feed.zipEntry, 'i') : undefined) : res.buf;
  const { rows: raw } = parseDelimited(buf.toString('utf8'), { delimiter: feed.delimiter });
  const c = feed.columns || {};
  const k = feed.constants || {};
  const val = (r, key) => (k[key] !== undefined ? k[key] : c[key] ? r[c[key]] : undefined);
  const rows = [];
  for (const r of raw) {
    const contest = val(r, 'contest') ?? '';
    if (ctx.contestFilters && !ctx.contestFilters.some((re) => re.test(contest))) continue;
    const base = {
      county: val(r, 'county') ?? '',
      precinct: val(r, 'precinct') ?? null,
      contest,
      candidate: val(r, 'candidate') ?? '',
      party: val(r, 'party') ?? '',
      level: c.precinct || k.precinct ? 'precinct' : 'county',
    };
    if (c.modes) {
      for (const [m, col] of Object.entries(c.modes)) rows.push({ ...base, mode: m, votes: toNum(r[col]) });
    } else {
      rows.push({ ...base, mode: val(r, 'mode') ?? 'TOTAL', votes: toNum(val(r, 'votes')) });
    }
  }
  return { rows, meta: { url: feed.url, sourceUpdatedAt: res.headers.get('last-modified') } };
}
