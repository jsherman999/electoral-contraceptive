import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchFeed, parseClarityUrl } from '../collector/adapters/clarity.js';
import { houseContestRegex } from '../collector/lib/contest.js';
import { buildUnits } from '../collector/lib/units.js';

const DETAIL = `<ElectionResult><Timestamp>11/3/2026 9:15:03 PM EST</Timestamp><ElectionName>2026 Statewide General Election</ElectionName><Region>Charleston</Region>
<Contest key="5" text="U.S. House of Representatives District 1" voteFor="1">
  <Choice key="1" text="Rep Candidate" party="REP"><VoteType name="Election Day"><Precinct name="Charleston 1" votes="300"/></VoteType><VoteType name="Absentee by Mail"><Precinct name="Charleston 1" votes="50"/></VoteType></Choice>
  <Choice key="2" text="Dem Candidate" party="DEM"><VoteType name="Election Day"><Precinct name="Charleston 1" votes="200"/></VoteType><VoteType name="Absentee by Mail"><Precinct name="Charleston 1" votes="90"/></VoteType></Choice>
</Contest></ElectionResult>`;

function server() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const base = `http://127.0.0.1:${srv.address().port}`;
      const routes = {
        '/landing': `<html><a href="${base}/SC/120000/web.1/#/summary">2024 General</a>
          <a href="${base}/SC/125555/web.345435/#/summary">Election night results</a>
          <a href="${base}/SC/125600/web.345435/#/summary">Special</a>
          <a href="${base}/SC/125700/">State Senate special, same day</a></html>`,
        '/SC/125700/current_ver.txt': '2',
        '/SC/125700/2/json/en/electionsettings.json': JSON.stringify({ settings: { electiondetails: { electiondate: '11/3/2026' } } }),
        '/SC/125700/2/json/en/summary.json': JSON.stringify([{ C: 'State  Senate, District 15 - DEM' }]),
        '/SC/120000/current_ver.txt': '3',
        '/SC/120000/3/json/electionsettings.json': JSON.stringify({ settings: { electiondetails: { electiondate: '11/5/2024' } } }),
        '/SC/125600/current_ver.txt': '1',
        '/SC/125600/1/json/electionsettings.json': JSON.stringify({ settings: { electiondetails: { electiondate: '12/15/2026' } } }),
        '/SC/125555/current_ver.txt': '7',
        '/SC/125555/7/json/en/summary.json': JSON.stringify([{ C: 'U.S. House of Representatives District 1' }]),
        '/SC/125555/7/json/electionsettings.json': JSON.stringify({
          settings: { electiondetails: { electiondate: '11/3/2026', participatingcounties: ['Charleston|125556|9|11/3/2026 9:00:00 PM|8'] } },
        }),
        '/SC/Charleston/125556/9/reports/detailxml.zip': DETAIL,
      };
      const body = routes[req.url];
      if (body == null) res.writeHead(404).end('nf');
      else res.end(body);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

test('clarity: state-branded hosts parse', () => {
  assert.deepEqual(parseClarityUrl('https://www.enr-scvotes.org/SC/122436/web.345435/#/access-to-races'), {
    origin: 'https://www.enr-scvotes.org',
    st: 'SC',
    county: null,
    eid: '122436',
  });
});

test('clarity discovery skips same-day specials, picks the general by date + federal contests, reads county precincts', async () => {
  const srv = await server();
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const feed = { adapter: 'clarity', discover: { state: 'SC', date: '2026-11-03', pages: [`${base}/landing`], hostPattern: '127\\.0\\.0\\.1' } };
    const res = await fetchFeed(feed, { contestFilters: [houseContestRegex(1)] });
    assert.equal(res.meta.url, `${base}/SC/125555/`);
    assert.match(res.meta.note, /confirmed/);
    const { units } = buildUnits(res.rows);
    assert.equal(units.length, 1);
    assert.equal(units[0].c, 'Charleston');
    assert.deepEqual(units[0].live, { ED: [200, 300, 0], MAIL: [90, 50, 0] });
  } finally {
    srv.close();
  }
});

test('clarity: a bot-protection challenge is reported as blocked, not parsed', async () => {
  const srv = http.createServer((req, res) => {
    res.writeHead(202, { 'content-type': 'text/html' });
    res.end('<html><script>window.awsWafCookieDomainList = []; window.gokuProps = {"key":"x"};</script></html>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${srv.address().port}/CO/127407/`;
    await assert.rejects(fetchFeed({ adapter: 'clarity', url }, {}), (e) => e.blocked === true && /bot protection/.test(e.message));
  } finally {
    srv.close();
  }
});
