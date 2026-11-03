import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normMode, normParty, precinctKeys, countyKey, isVirtualPrecinct } from '../site/js/shared/normalize.js';
import { analyzeRace } from '../site/js/shared/model.js';
import { createDemo, simulateRace } from '../site/js/shared/demo.js';
import { houseContestRegex } from '../collector/lib/contest.js';
import { buildUnits } from '../collector/lib/units.js';
import { parseDetailXml, parseClarityUrl } from '../collector/adapters/clarity.js';
import { walkExport } from '../collector/adapters/enhanced-voting.js';

test('vote modes: canonical codes pass through, source labels normalize', () => {
  for (const m of ['ED', 'EV', 'MAIL', 'PROV', 'TOTAL']) assert.equal(normMode(m), m);
  assert.equal(normMode('Election Day'), 'ED');
  assert.equal(normMode('Early Voting'), 'EV');
  assert.equal(normMode('One Stop'), 'EV');
  assert.equal(normMode('Absentee by Mail'), 'MAIL');
  assert.equal(normMode('Advance in Person'), 'EV');
  assert.equal(normMode('Provisional'), 'PROV');
  assert.equal(normMode('Total Votes'), 'TOTAL');
});

test('parties', () => {
  assert.equal(normParty('DEM'), 'D');
  assert.equal(normParty('DEMOCRAT / WORKING FAMILIES'), 'D');
  assert.equal(normParty('Republican'), 'R');
  assert.equal(normParty('LIB'), 'O');
});

test('precinct and county keys', () => {
  assert.equal(precinctKeys('PRECINCT 012')[0], '12');
  assert.equal(precinctKeys('01.1')[0], precinctKeys('1.1')[0]);
  assert.ok(precinctKeys('0012 - Smith Elementary').includes('12'));
  assert.equal(countyKey('St. Lucie County'), countyKey('SAINT LUCIE'));
  assert.notEqual(countyKey('Fairfax County'), countyKey('Fairfax City'));
});

test('batch (pseudo-precinct) names', () => {
  for (const n of ['ABSENTEE', 'ONE STOP 2', 'EV-SELMA', 'MILLERS CREEK EV', 'EVBOE', 'PROVISIONAL', 'Failsafe Provisional', 'EARLYVOTE'])
    assert.ok(isVirtualPrecinct(n), n);
  for (const n of ['01', 'WARD 3', 'EVANS', 'Evers', 'CB/EV', 'PROVIDENCE 2', 'ABBOTT']) assert.ok(!isVirtualPrecinct(n), n);
});

test('House contest matching excludes state legislative races', () => {
  assert.ok(houseContestRegex(1).test('US HOUSE OF REPRESENTATIVES DISTRICT 01'));
  assert.ok(!houseContestRegex(1).test('NC HOUSE OF REPRESENTATIVES DISTRICT 001'));
  assert.ok(!houseContestRegex(1).test('US HOUSE OF REPRESENTATIVES DISTRICT 10'));
  assert.ok(houseContestRegex(7).test('Representative in Congress 7th District'));
  assert.ok(!houseContestRegex(7).test('Representative in Congress 17th District'));
  assert.ok(houseContestRegex(2).test('Member, House of Representatives (2nd District)'));
  assert.ok(!houseContestRegex(2).test('Member House of Delegates (2nd District)'));
  assert.ok(houseContestRegex(14).test('United States Representative | RACE=USR | DIST=14'));
  assert.ok(!houseContestRegex(7).test('State Representative District 7'));
  assert.ok(!houseContestRegex(1).test('United States Senator'));
});

test('like-for-like swing ignores the early-vote mirage', () => {
  // 2024: mail D+40, Election Day R+30. 2026 so far: only mail is in, at D+42 -> swing should be +2, not +70.
  const units = [];
  for (let i = 0; i < 20; i++) {
    units.push({
      c: 'A',
      p: String(i),
      live: { MAIL: [710, 290, 0], ED: [0, 0, 0] },
      b: { MAIL: [700, 300, 0], ED: [700, 1300, 0] },
      mk: 'exact',
    });
  }
  const { summary } = analyzeRace(units);
  assert.equal(summary.margin, 42);
  assert.ok(Math.abs(summary.swing - 2) < 0.01, `swing ${summary.swing}`);
  assert.equal(summary.precincts.partial, 20);
  // projection: Election Day fills in from 2024 (2,000 votes at R+30) shifted by the +2 swing:
  // (+420 mail - 560 ED) / 3,000 = R+4.7
  assert.ok(Math.abs(summary.projection.margin - -4.7) < 0.05, `proj ${summary.projection.margin}`);
});

test('projection converges on the final result in the simulation', () => {
  const board = JSON.parse(fs.readFileSync(new URL('../site/board.json', import.meta.url)));
  const demo = createDemo(board);
  for (const id of ['NC-01', 'PA-08', 'VA-07']) {
    const final = simulateRace(demo, id, 900, 'wave').summary;
    const mid = simulateRace(demo, id, minutesAt(board.races[id].close) + 150, 'wave').summary;
    assert.ok(Math.abs(mid.projection.margin - final.margin) < 4, `${id}: projected ${mid.projection.margin} vs final ${final.margin}`);
  }
});
const minutesAt = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h - 18) * 60 + m;
};

test('units: fusion lines count for the candidate, over/under votes dropped, TOTAL not double counted', () => {
  const rows = [
    { county: 'X', precinct: '1', contest: 'c', candidate: 'Jane Doe', party: 'DEM', mode: 'ED', votes: 100 },
    { county: 'X', precinct: '1', contest: 'c', candidate: 'Jane Doe', party: 'WOR', mode: 'ED', votes: 10 },
    { county: 'X', precinct: '1', contest: 'c', candidate: 'John Roe', party: 'REP', mode: 'ED', votes: 90 },
    { county: 'X', precinct: '1', contest: 'c', candidate: 'Under Votes', party: '', mode: 'ED', votes: 7 },
    { county: 'X', precinct: '1', contest: 'c', candidate: 'John Roe', party: 'REP', mode: 'Total', votes: 90 },
  ];
  const { units, candidates } = buildUnits(rows);
  assert.deepEqual(units[0].live, { ED: [110, 90, 0] });
  assert.equal(candidates.find((c) => c.party === 'D').votes, 110);
});

test('clarity: URL parsing and detail.xml', () => {
  assert.deepEqual(parseClarityUrl('https://results.enr.clarityelections.com/SC/123456/web.345435/#/summary'), { origin: 'https://results.enr.clarityelections.com', st: 'SC', county: null, eid: '123456' });
  assert.deepEqual(parseClarityUrl('https://results.enr.clarityelections.com/PA/Bucks/123457/web.1/#/'), { origin: 'https://results.enr.clarityelections.com', st: 'PA', county: 'Bucks', eid: '123457' });
  const xml = `<ElectionResult><Timestamp>11/3/2026 9:15:03 PM EST</Timestamp><Region>Bucks</Region>
    <Contest key="1" text="Representative in Congress 1st District" voteFor="1">
      <Choice key="1" text="Brian Fitzpatrick" party="REP" totalVotes="30">
        <VoteType name="Election Day" votes="20"><Precinct name="Bensalem 1" votes="20"/></VoteType>
        <VoteType name="Mail-In" votes="10"><Precinct name="Bensalem 1" votes="10"/></VoteType>
      </Choice>
      <Choice key="2" text="Jane D" party="DEM" totalVotes="25">
        <VoteType name="Election Day" votes="12"><Precinct name="Bensalem 1" votes="12"/></VoteType>
        <VoteType name="Mail-In" votes="13"><Precinct name="Bensalem 1" votes="13"/></VoteType>
      </Choice>
    </Contest>
    <Contest key="2" text="State Senate 6"><Choice key="3" text="X" party="REP"><VoteType name="Election Day"><Precinct name="Bensalem 1" votes="5"/></VoteType></Choice></Contest>
  </ElectionResult>`;
  const d = parseDetailXml(xml, { county: 'Bucks', contestFilters: [houseContestRegex(1)] });
  assert.equal(d.rows.length, 4);
  const { units } = buildUnits(d.rows);
  assert.deepEqual(units[0].live, { ED: [12, 20, 0], MAIL: [13, 10, 0] });
});

test('enhanced voting: walker finds precinct results under local results', () => {
  const json = {
    results: { ballotItems: [{ name: 'US House District 1', ballotOptions: [{ name: 'A', politicalParty: 'Dem', voteCount: 5 }] }] },
    localResults: [
      {
        name: 'Chatham',
        ballotItems: [
          {
            name: 'US House District 1',
            ballotOptions: [
              { name: 'A', politicalParty: 'Dem', precinctResults: [{ name: '1-01', voteCount: 5, groupResults: [{ groupName: 'Election Day', voteCount: 5 }] }] },
              { name: 'B', politicalParty: 'Rep', precinctResults: [{ name: '1-01', voteCount: 7, groupResults: [{ groupName: 'Election Day', voteCount: 7 }] }] },
            ],
          },
        ],
      },
    ],
  };
  const rows = walkExport(json, [houseContestRegex(1)]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].county, 'Chatham');
  assert.equal(rows[0].precinct, '1-01');
});

test('Senate contest matching', async () => {
  const { senateContestRegex, contestMatcher } = await import('../collector/lib/contest.js');
  const re = senateContestRegex();
  for (const s of ['US SENATE', 'U.S. Senate', 'United States Senator', 'U.S. Senator (Unexpired Term Ending January 3, 2029)', 'United States Senator | RACE=USS | DIST='])
    assert.ok(re.test(s), s);
  for (const s of ['State Senate District 5', 'NC STATE SENATE DISTRICT 01', 'Ohio Senate District 3', 'Michigan Senate 12th District', 'US HOUSE OF REPRESENTATIVES DISTRICT 01'])
    assert.ok(!re.test(s), s);
  assert.ok(contestMatcher('auto', 'NC-SEN').test('US SENATE'));
  assert.ok(!contestMatcher('auto', 'NC-01').test('US SENATE'));
});

test('Senate tally: net gain counts pickups minus lost holds', async () => {
  const board = JSON.parse(fs.readFileSync(new URL('../site/board.json', import.meta.url)));
  const sum = (m, sigma = 2) => ({ votes: { T: 1000 }, margin: m, status: 'counting', projection: { margin: m, sigma, confidence: 'likely' } });
  const races = { 'NC-SEN': sum(5), 'OH-SEN': sum(4), 'ME-SEN': sum(6), 'TX-SEN': sum(-8), 'MI-SEN': sum(-3) };
  const { senateTally } = await import('../site/js/signals.js');
  const t = senateTally(board.senate, races);
  assert.equal(t.pickups, 3);
  assert.equal(t.losses, 1);
  assert.equal(t.net, 2);
});

test('CDF (IEEE 1622.2 V1, Ohio): attribute-style units, parties and singular CandidateId', async () => {
  const { parseCdf } = await import('../collector/adapters/cdf.js');
  const xml = `<?xml version="1.0"?><ElectionReport IsTest="true" GeneratedDate="2026-11-03T03:15:34Z"><GpUnitCollection>
    <GpUnit xsi:type="ReportingUnit" ObjectId="g1" Name="Adams" IsElectoralDistrict="false"/>
    <GpUnit xsi:type="ReportingUnit" ObjectId="g0" Name="Ohio" IsElectoralDistrict="true"/></GpUnitCollection>
    <PartyCollection><Party ObjectId="p1" Abbreviation="DEM"><Name><LanguageString Language="en">Democratic</LanguageString></Name></Party>
    <Party ObjectId="p2" Abbreviation="REP"/></PartyCollection><Election Date="2026-11-03"><CandidateCollection>
    <Candidate ObjectId="c1"><BallotName><LanguageString Language="en">Sherrod Brown</LanguageString></BallotName><PartyId>p1</PartyId></Candidate>
    <Candidate ObjectId="c2"><BallotName><LanguageString Language="en">Jon Husted</LanguageString></BallotName><PartyId>p2</PartyId></Candidate></CandidateCollection>
    <ContestCollection><Contest xsi:type="CandidateContest" ObjectId="k1" Name="U.S. Senator">
    <BallotSelection xsi:type="CandidateSelection" ObjectId="s1"><VoteCountsCollection><VoteCounts GpUnitId="g1" Type="Total" Count="120"/><VoteCounts GpUnitId="g0" Type="Total" Count="9999"/></VoteCountsCollection><CandidateId>c1</CandidateId></BallotSelection>
    <BallotSelection xsi:type="CandidateSelection" ObjectId="s2"><VoteCountsCollection><VoteCounts GpUnitId="g1" Type="Total" Count="300"/></VoteCountsCollection><CandidateId>c2</CandidateId></BallotSelection>
    </Contest></ContestCollection></Election></ElectionReport>`;
  const { rows, isTest } = parseCdf(xml);
  assert.equal(isTest, true);
  assert.deepEqual(rows.map((r) => [r.county, r.candidate, r.party, r.votes]), [['Adams', 'Sherrod Brown', 'DEM', 120], ['Adams', 'Jon Husted', 'REP', 300]]);
});

test('county-level results in a split county are not compared with the whole county', async () => {
  const { attachBaseline } = await import('../collector/lib/baseline.js');
  const idx = { counties: new Map([['ADAMS', { key: 'ADAMS', name: 'ADAMS', real: 40, pres: { TOTAL: [100, 200, 0] }, house: null, exact: new Map(), alt: new Map() }]]) };
  const split = [{ c: 'Adams', p: null, lvl: 'county', pr: { tot: 12, rep: 0 }, live: {} }];
  const whole = [{ c: 'Adams', p: null, lvl: 'county', pr: { tot: 40, rep: 0 }, live: {} }];
  assert.equal(attachBaseline(split, idx).units[0].mk, null);
  assert.equal(attachBaseline(whole, idx).units[0].mk, 'county');
  assert.equal(attachBaseline([{ c: 'Adams', p: null, lvl: 'county', live: {} }], idx, { statewide: true }).units[0].mk, 'county');
});
