// Florida Division of Elections election-night file (county-level, all counties):
//   https://flelectionfiles.floridados.gov/enightfilespublic/20261103_ElecResultsFL.txt
// Tab-delimited; typical columns: ElectionDate, PartyCode, PartyName, RaceCode, OfficeDesc, Juris1num,
// Juris2num, Precincts, PrecinctsReporting, CanNameLast, CanNameFirst, CanNameMiddle, CanVotes,
// CountyCode, CountyName. The contest name the adapter emits is
//   "<OfficeDesc> | RACE=<RaceCode> | DIST=<Juris1num as a number>"
// so a race config can match e.g. "RACE=USR \\| DIST=14$" (USR = U.S. Representative).
// Precinct-level detail for Florida comes from county Supervisors of Elections (configure those as
// separate clarity / delimited feeds; precinct rows replace this file's county row for that county).
import { get } from '../lib/http.js';
import { parseDelimited, toNum } from '../lib/csv.js';

const pick = (o, ...keys) => {
  for (const k of keys) if (o[k] !== undefined) return o[k];
  return '';
};

export async function fetchFeed(feed, ctx = {}) {
  const res = await get(feed.url, { timeoutMs: 60000 });
  const { rows: raw } = parseDelimited(res.text(), { delimiter: '\t' });
  const rows = [];
  for (const r of raw) {
    const dist = pick(r, 'Juris1num', 'Juris1Num', 'District');
    const contest = `${pick(r, 'OfficeDesc', 'RaceName')} | RACE=${pick(r, 'RaceCode')} | DIST=${dist ? Number(dist) || dist : ''}`;
    if (ctx.contestFilters && !ctx.contestFilters.some((re) => re.test(contest))) continue;
    const name = [pick(r, 'CanNameFirst'), pick(r, 'CanNameMiddle'), pick(r, 'CanNameLast')].filter(Boolean).join(' ');
    rows.push({
      county: pick(r, 'CountyName', 'County'),
      precinct: null,
      level: 'county',
      contest,
      candidate: name,
      party: pick(r, 'PartyCode', 'PartyName'),
      mode: 'TOTAL',
      votes: toNum(pick(r, 'CanVotes', 'Votes')),
      prTot: toNum(pick(r, 'Precincts')),
      prRep: toNum(pick(r, 'PrecinctsReporting')),
    });
  }
  return { rows, meta: { url: feed.url, sourceUpdatedAt: res.headers.get('last-modified') } };
}
