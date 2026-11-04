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

test('clarity discovery works for a county site and skips the primary', async () => {
  const DETAIL_MI = `<ElectionResult><Timestamp>11/3/2026 9:15:03 PM EST</Timestamp><Region>Oakland</Region>
<Contest key="7" text="Representative in Congress 10th District" voteFor="1">
  <Choice key="1" text="Rep Candidate" party="REP"><VoteType name="Election Day"><Precinct name="Troy, Pct 1" votes="300"/></VoteType></Choice>
  <Choice key="2" text="Dem Candidate" party="DEM"><VoteType name="Election Day"><Precinct name="Troy, Pct 1" votes="200"/></VoteType></Choice>
</Contest></ElectionResult>`;
  const srv = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const routes = {
      '/county': `<a href="${base}/MI/Oakland/126183/web.345435/#/summary">Official Election Results</a>
                  <a href="${base}/MI/Oakland/127074/web.345435/#/summary">Official Election Results</a>
                  <a href="${base}/MI/127000/">statewide link that must be ignored</a>`,
      '/MI/Oakland/126183/current_ver.txt': '5',
      '/MI/Oakland/126183/5/json/en/electionsettings.json': JSON.stringify({ settings: { electiondetails: { electiondate: '8/4/2026' } } }),
      '/MI/Oakland/126183/5/json/en/summary.json': JSON.stringify([{ C: 'Representative in Congress 10th District - DEM' }]),
      '/MI/Oakland/127074/current_ver.txt': '9',
      '/MI/Oakland/127074/9/json/en/electionsettings.json': JSON.stringify({ settings: { electiondetails: { electiondate: '11/3/2026' } } }),
      '/MI/Oakland/127074/9/json/en/summary.json': JSON.stringify([{ C: 'Representative in Congress 10th District' }]),
      '/MI/Oakland/127074/9/reports/detailxml.zip': DETAIL_MI,
    };
    const body = routes[req.url];
    if (body == null) res.writeHead(404).end('nf');
    else res.end(body);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const feed = { adapter: 'clarity', discover: { state: 'MI', county: 'Oakland', date: '2026-11-03', pages: [`${base}/county`], hostPattern: '127\\.0\\.0\\.1' } };
    const res = await fetchFeed(feed, { contestFilters: [houseContestRegex(10)] });
    assert.equal(res.meta.url, `${base}/MI/Oakland/127074/`);
    assert.equal(res.rows.length, 2);
    assert.equal(res.rows[0].precinct, 'Troy, Pct 1');
  } finally {
    srv.close();
  }
});

test('clarity discovery never uses an election whose date it could not confirm', async () => {
  const srv = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const routes = {
      '/county': `<a href="${base}/MI/Kent/127074/web.345435/#/summary">Official Election Results</a>`,
      '/MI/Kent/127074/current_ver.txt': '3',
      '/MI/Kent/127074/3/json/en/electionsettings.json': JSON.stringify({ settings: { electiondetails: { electiondate: '8/4/2026' } } }),
      '/MI/Kent/127074/3/json/en/summary.json': JSON.stringify([{ C: 'United States Senator' }]),
    };
    const body = routes[req.url];
    if (body == null) res.writeHead(404).end('nf');
    else res.end(body);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const feed = { adapter: 'clarity', discover: { state: 'MI', county: 'Kent', date: '2026-11-03', pages: [`${base}/county`], hostPattern: '127\\.0\\.0\\.1' } };
    await assert.rejects(fetchFeed(feed, {}), /could not find the 2026-11-03 election/);
  } finally {
    srv.close();
  }
});

test('clarity: per-pass download cap, unchanged counties reused, and a 405 refusal stops the pass without retries', async () => {
  const detail = (county, votes) => `<ElectionResult><Timestamp>11/3/2026 9:15:03 PM EST</Timestamp><Region>${county}</Region>
<Contest key="5" text="U.S. House of Representatives District 1" voteFor="1">
  <Choice key="1" text="Rep Candidate" party="REP"><VoteType name="Election Day"><Precinct name="${county} 1" votes="${votes}"/></VoteType></Choice>
</Contest></ElectionResult>`;
  const statewide = `<ElectionResult><Timestamp>11/3/2026 9:15:03 PM EST</Timestamp>
<Contest key="5" text="U.S. House of Representatives District 1" voteFor="1">
  <Choice key="1" text="Rep Candidate" party="REP"><VoteType name="Election Day"><County name="Aiken" votes="11"/><County name="Beaufort" votes="22"/><County name="Colleton" votes="33"/></VoteType></Choice>
</Contest></ElectionResult>`;
  let ver = 1;
  let refuse = false;
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.url);
    if (refuse) return res.writeHead(405, { 'x-amzn-waf-action': 'captcha' }).end('captcha');
    const counties = ['Aiken|200|' + ver, 'Beaufort|300|' + ver, 'Colleton|400|' + ver].map((s) => `${s}|11/3/2026 9:00:00 PM|8`);
    const routes = {
      '/SC/126000/current_ver.txt': String(ver),
      [`/SC/126000/${ver}/json/en/electionsettings.json`]: JSON.stringify({ settings: { electiondetails: { participatingcounties: counties } } }),
      [`/SC/126000/${ver}/reports/detailxml.zip`]: statewide,
      [`/SC/Aiken/200/${ver}/reports/detailxml.zip`]: detail('Aiken', 100 * ver),
      [`/SC/Beaufort/300/${ver}/reports/detailxml.zip`]: detail('Beaufort', 200 * ver),
      [`/SC/Colleton/400/${ver}/reports/detailxml.zip`]: detail('Colleton', 300 * ver),
    };
    const body = routes[req.url];
    if (body == null) res.writeHead(404).end('nf');
    else res.end(body);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${srv.address().port}/SC/126000/`;
    const feed = { adapter: 'clarity', url, maxDownloads: 2, concurrency: 1 };
    const filters = [houseContestRegex(1)];
    const precincts = (rows) => rows.filter((r) => r.level !== 'county').map((r) => `${r.county}:${r.votes}`).sort();
    const countyRows = (rows) => rows.filter((r) => r.level === 'county').map((r) => `${r.county}:${r.votes}`).sort();

    // Pass 1: two county files; the third county comes from the statewide county-level file.
    let res = await fetchFeed(feed, { contestFilters: filters });
    assert.deepEqual(precincts(res.rows), ['Aiken:100', 'Beaufort:200']);
    assert.deepEqual(countyRows(res.rows), ['Colleton:33']);
    assert.match(res.meta.note, /1 counties county-level/);

    // Pass 2, nothing changed: only Colleton is downloaded.
    hits.length = 0;
    res = await fetchFeed(feed, { contestFilters: filters });
    assert.deepEqual(precincts(res.rows), ['Aiken:100', 'Beaufort:200', 'Colleton:300']);
    assert.equal(hits.filter((h) => /\/(Aiken|Beaufort|Colleton)\//.test(h)).length, 1);

    // Pass 3, every county updated: two downloads (oldest first), the third keeps its last file.
    ver = 2;
    hits.length = 0;
    res = await fetchFeed(feed, { contestFilters: filters });
    assert.equal(hits.filter((h) => /\/(Aiken|Beaufort|Colleton)\//.test(h)).length, 2);
    assert.deepEqual(precincts(res.rows), ['Aiken:200', 'Beaufort:400', 'Colleton:300']);
    assert.match(res.meta.note, /1 updated next pass/);

    // Refused: blocked error, one request, no retries.
    refuse = true;
    hits.length = 0;
    await assert.rejects(fetchFeed(feed, { contestFilters: filters }), (e) => e.blocked === true && /HTTP 405/.test(e.message));
    assert.equal(hits.length, 1);
  } finally {
    srv.close();
  }
});
