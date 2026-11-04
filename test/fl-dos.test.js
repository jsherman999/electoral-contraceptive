import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchFeed, freshUrl } from '../collector/adapters/fl-dos.js';

const HEAD = ['ElectionDate', 'PartyCode', 'PartyName', 'RaceCode', 'RaceName', 'CountyCode', 'CountyName', 'Juris1num', 'Juris2num', 'Precincts', 'PrecinctsReporting', 'CanNameLast', 'CanNameFirst', 'CanNameMiddle', 'CanVotes'].join('\t');
const file = (votes, rep) => `${HEAD}\n${['11/03/2026', 'REP', 'Republican Party', 'USS', 'United States Senator', 'DAD', 'Miami-Dade', '', '', '718', rep, 'Moody', 'Ashley', '', votes].join('\t')}\n`;

test('fl-dos: asks past the CDN cache (the plain URL served the morning file on election night)', async () => {
  const srv = http.createServer((req, res) => {
    // like the real CDN: the plain path is a stale cached copy, any query string reaches the current file
    res.end(req.url.includes('?') ? file('358017', '703') : file('0', '0'));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${srv.address().port}/enightfilespublic/20261103_ElecResultsFL.txt`;
    const { rows, meta } = await fetchFeed({ url });
    assert.equal(rows[0].votes, 358017);
    assert.equal(rows[0].prRep, 703);
    assert.equal(meta.url, url);
    assert.match(freshUrl('https://x/f.txt', 120000), /\?nocache=2$/);
    assert.match(freshUrl('https://x/f.txt?a=1', 120000), /\?a=1&nocache=2$/);
  } finally {
    srv.close();
  }
});
