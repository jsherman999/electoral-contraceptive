// North Carolina State Board of Elections precinct results file.
// Election night: https://s3.amazonaws.com/dl.ncsbe.gov/ENRS/2026_11_03/results_pct_20261103.zip
// (updated through the night; the file already exists with zero counts before polls close).
// Tab-separated columns: County, Election Date, Precinct, Contest Group ID, Contest Type, Contest Name,
// Choice, Choice Party, Vote For, Election Day, Early Voting, Absentee by Mail, Provisional, Total Votes,
// Real Precinct
import { get } from '../lib/http.js';
import { unzipEntry, isZip } from '../lib/zip.js';
import { splitLine, toNum } from '../lib/csv.js';

const MODE_COLS = [
  ['Election Day', 'ED'],
  ['Early Voting', 'EV'],
  ['Absentee by Mail', 'MAIL'],
  ['Provisional', 'PROV'],
];

export async function fetchFeed(feed, ctx = {}) {
  const res = await get(feed.url, { timeoutMs: 120000 });
  if (res.notModified && ctx.previous) return { ...ctx.previous, notModified: true };
  const text = (isZip(res.buf) ? unzipEntry(res.buf, /\.txt$/i) : res.buf).toString('utf8');
  const lines = text.split(/\r?\n/);
  const header = lines[0].split('\t').map((h) => h.trim());
  const ix = (name) => header.indexOf(name);
  const iC = ix('County');
  const iP = ix('Precinct');
  const iN = ix('Contest Name');
  const iCh = ix('Choice');
  const iPa = ix('Choice Party');
  const iT = ix('Total Votes');
  const iReal = ix('Real Precinct');
  const modeIx = MODE_COLS.map(([col, m]) => [ix(col), m]).filter(([i]) => i >= 0);
  if (iC < 0 || iP < 0 || iN < 0 || iCh < 0) throw new Error('Unexpected NC SBE file header: ' + header.join(','));
  const filters = ctx.contestFilters || null;
  const keep = new Map();
  const rows = [];
  for (let k = 1; k < lines.length; k++) {
    const line = lines[k];
    if (!line) continue;
    const f = splitLine(line, '\t');
    const contest = f[iN];
    if (filters) {
      let ok = keep.get(contest);
      if (ok === undefined) {
        ok = filters.some((re) => re.test(contest));
        keep.set(contest, ok);
      }
      if (!ok) continue;
    }
    const base = {
      county: f[iC],
      precinct: f[iP],
      contest,
      candidate: f[iCh],
      party: (f[iPa] || '').trim(),
      virtual: iReal >= 0 ? f[iReal].trim() === 'N' : undefined,
    };
    if (modeIx.length) {
      for (const [i, m] of modeIx) rows.push({ ...base, mode: m, votes: toNum(f[i]) });
    } else rows.push({ ...base, mode: 'TOTAL', votes: toNum(f[iT]) });
  }
  return {
    rows,
    meta: { url: feed.url, sourceUpdatedAt: res.headers.get('last-modified') || null },
  };
}
