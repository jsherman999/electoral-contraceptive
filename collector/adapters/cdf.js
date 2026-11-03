// NIST SP 1500-100 / IEEE VSSC 1622.2 "Common Data Format" (CDF) election results XML.
// Ohio publishes its election-night results in this format:
//   https://liveresults.ohiosos.gov/Api/v1/download?filename=VSSC1622XmlFileBlob
//
// Structure (simplified):
//   <ElectionReport>
//     <Election>
//       <Candidate ObjectId="c1"><BallotName><Text>Jane Doe</Text></BallotName><PartyId>p1</PartyId></Candidate>
//       <Contest xsi:type="CandidateContest" ObjectId="k1">
//         <BallotSelection xsi:type="CandidateSelection" ObjectId="s1">
//           <CandidateIds>c1</CandidateIds>
//           <VoteCounts><GpUnitId>g1</GpUnitId><Type>election-day</Type><Count>123</Count></VoteCounts>
//         </BallotSelection>
//         <ElectionDistrictId>d1</ElectionDistrictId>
//         <Name>Representative to Congress</Name>
//       </Contest>
//     </Election>
//     <GpUnit xsi:type="ReportingUnit" ObjectId="g1"><Name>Adams</Name><Type>county</Type></GpUnit>
//     <Party ObjectId="p1"><Abbreviation>DEM</Abbreviation><Name>Democratic</Name></Party>
//   </ElectionReport>
//
// Config: { "adapter": "cdf", "url": "<XML or zipped XML URL>" }
import { get } from '../lib/http.js';
import { unzipEntry, isZip } from '../lib/zip.js';

const decode = (s) =>
  String(s ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .trim();

/** Text of a child element: plain (<Name>x</Name>) or internationalized (<Text>/<LanguageString>). */
function child(body, tag) {
  const m = body.match(new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`));
  if (!m) return null;
  const t = m[1].match(/<(?:\w+:)?(?:Text|LanguageString)\b[^>]*>([\s\S]*?)<\/(?:\w+:)?(?:Text|LanguageString)>/);
  return decode(t ? t[1] : m[1].replace(/<[^>]+>/g, ''));
}
const attr = (open, name) => {
  const m = open.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  return m ? decode(m[1]) : null;
};
/** A value given either as an attribute (IEEE 1622.2 V1) or as a child element (NIST 1500-100 V2). */
const field = (el, name) => attr(el.open, name) ?? child(el.body, name);
/** All <Tag ...>...</Tag> and <Tag .../> elements. */
function blocks(xml, tag) {
  const re = new RegExp(`<(?:\\w+:)?${tag}\\b((?:[^>"]|"[^"]*")*?)(/>|>([\\s\\S]*?)</(?:\\w+:)?${tag}>)`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push({ open: m[1], body: m[3] || '' });
  return out;
}

const MODE = {
  'election-day': 'ED',
  early: 'EV',
  absentee: 'MAIL',
  'absentee-mail': 'MAIL',
  'absentee-in-person': 'EV',
  provisional: 'PROV',
  total: 'TOTAL',
};

export function parseCdf(xml, { contestFilters = null } = {}) {
  // Reporting units, and which county each precinct belongs to.
  const gp = new Map();
  for (const g of blocks(xml, 'GpUnit')) {
    const id = attr(g.open, 'ObjectId');
    if (!id) continue;
    const type = (field(g, 'Type') || '').toLowerCase().replace(/[^a-z]/g, '');
    const other = (field(g, 'OtherType') || '').toLowerCase().replace(/[^a-z]/g, '');
    const composing = (field(g, 'ComposingGpUnitIds') || '').split(/\s+/).filter(Boolean);
    let t = type === 'other' ? other : type;
    if (!t || t === 'reportingunit') t = attr(g.open, 'IsElectoralDistrict') === 'false' && !/^(state|ohio)$/i.test(field(g, 'Name') || '') ? 'county' : 'district';
    gp.set(id, { id, name: field(g, 'Name') || id, type: t, composing });
  }
  const parentCounty = new Map();
  for (const g of gp.values()) if (g.type === 'county') for (const c of g.composing) parentCounty.set(c, g.name);

  const parties = new Map();
  for (const p of blocks(xml, 'Party')) {
    const id = attr(p.open, 'ObjectId');
    if (id) parties.set(id, field(p, 'Abbreviation') || field(p, 'Name') || '');
  }
  const cands = new Map();
  for (const c of blocks(xml, 'Candidate')) {
    const id = attr(c.open, 'ObjectId');
    if (!id) continue;
    const pid = field(c, 'PartyId');
    cands.set(id, { name: field(c, 'BallotName') || field(c, 'Name') || id, party: pid ? parties.get(pid) || '' : '' });
  }

  const rows = [];
  for (const k of blocks(xml, 'Contest')) {
    const selections = blocks(k.body, 'BallotSelection');
    const outer = k.body.replace(/<(?:\w+:)?BallotSelection\b[\s\S]*?<\/(?:\w+:)?BallotSelection>/g, '');
    let contest = attr(k.open, 'Name') || child(outer, 'Name') || '';
    const did = attr(k.open, 'ElectionDistrictId') || child(outer, 'ElectionDistrictId');
    const district = did ? gp.get(did) : null;
    if (district && !/district/i.test(contest)) contest = `${contest} | ${district.name}`;
    if (contestFilters && !contestFilters.some((re) => re.test(contest))) continue;
    for (const s of selections) {
      const ids = (field(s, 'CandidateIds') || field(s, 'CandidateId') || '').split(/\s+/).filter(Boolean);
      const cand = ids.length ? cands.get(ids[0]) : null;
      const name = cand ? cand.name : field(s, 'Selection') || 'Other';
      const party = cand ? cand.party : '';
      for (const vc of blocks(s.body, 'VoteCounts')) {
        const unit = gp.get(field(vc, 'GpUnitId'));
        if (!unit) continue;
        const t = (field(vc, 'Type') || 'total').toLowerCase();
        const mode = MODE[t] || (t === 'other' ? field(vc, 'OtherType') || 'OTHER' : t);
        const votes = Number(field(vc, 'Count')) || 0;
        if (unit.type === 'county') {
          rows.push({ county: unit.name, precinct: null, level: 'county', contest, candidate: name, party, mode, votes });
        } else if (unit.type === 'precinct' || unit.type === 'split-precinct' || parentCounty.has(unit.id)) {
          rows.push({ county: parentCounty.get(unit.id) || '', precinct: unit.name, level: 'precinct', contest, candidate: name, party, mode, votes });
        }
        // state- or district-level totals are skipped: units carry the detail.
      }
    }
  }
  // If a contest reports both precinct and county units for a county, buildUnits keeps the precincts.
  const generated = (xml.match(/GeneratedDate="([^"]*)"/) || xml.match(/<(?:\w+:)?GeneratedDate>([^<]*)</) || [])[1] || null;
  const isTest = /<(?:\w+:)?ElectionReport\b[^>]*IsTest="true"/.test(xml);
  return { rows, generated, isTest };
}

export async function fetchFeed(feed, ctx = {}) {
  const res = await get(feed.url, { timeoutMs: 120000, headers: { accept: 'application/xml,text/xml,*/*' } });
  const buf = isZip(res.buf) ? unzipEntry(res.buf, /\.xml$/i) : res.buf;
  const { rows, generated, isTest } = parseCdf(buf.toString('utf8'), { contestFilters: ctx.contestFilters });
  // States load fake numbers into test files on election day. Before polls close (feed.ignoreTestUntil),
  // test-flagged votes are zeroed so they can't show as results; after that the data is used regardless.
  let note = isTest ? 'source marks this file as TEST data' : undefined;
  if (isTest && feed.ignoreTestUntil && Date.now() < Date.parse(feed.ignoreTestUntil)) {
    const n = rows.reduce((a, r) => a + (Number(r.votes) || 0), 0);
    for (const r of rows) r.votes = 0;
    note = `source marks this file as TEST data; ${n ? `${n} test votes ignored` : 'no votes'} until ${feed.ignoreTestUntil}`;
  }
  return { rows, meta: { url: feed.url, sourceUpdatedAt: generated || res.headers.get('last-modified'), note } };
}
