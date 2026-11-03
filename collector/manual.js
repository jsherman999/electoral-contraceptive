#!/usr/bin/env node
// Manual import: turn a results file you downloaded (or typed up) into relay data for one state, and push
// it to the election-data-relay branch. The GitHub collector merges it into the public board on its
// next pass. Use it for states whose sites refuse scripts but that you can open in a browser (Michigan).
//
//   node collector/manual.js --state MI --file ~/Downloads/mi-results.csv
//   node collector/manual.js --state MI --file mi.csv --dry-run      # check the file, don't push
//
// The file can be CSV or tab-separated, with a header row. Columns are recognized by name:
//   county      County | CountyName | County Name | Jurisdiction
//   contest     Contest | Office | Race | OfficeDescription (+ District | DistrictCode, appended)
//   candidate   Candidate | Name | Candidate Name, or CandidateFirstName + CandidateLastName
//   party       Party | PartyName | PartyDescription
//   votes       Votes | CandidateVotes | Total | Total Votes | Vote Count
//   precinct    Precinct | Precinct Name                     (optional: precinct-level files)
//   precincts   Precincts | Total Precincts                  (optional: precincts in the county for the race)
//   reporting   Precincts Reporting | Reporting             (optional)
// A blank template is in manual/template.csv.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseDelimited, toNum } from './lib/csv.js';
import { contestMatcher } from './lib/contest.js';
import { preparePublishDir, publish } from './publish.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const flag = (k) => args.includes(k);

const st = String(opt('--state', '')).toUpperCase();
let file = opt('--file');
if (!st || !file) {
  console.error('usage: node collector/manual.js --state MI --file <results.csv> [--dry-run]');
  process.exit(2);
}
file = file.replace(/^~(?=\/)/, os.homedir());

const norm = (s) => String(s).toLowerCase().replace(/[^a-z]/g, '');
const SYN = {
  county: ['county', 'countyname', 'jurisdiction', 'countydescription'],
  contest: ['contest', 'office', 'race', 'officedescription', 'officename', 'contestname', 'racename'],
  district: ['district', 'districtcode', 'districtname'],
  candidate: ['candidate', 'name', 'candidatename', 'choice', 'ballotname'],
  first: ['candidatefirstname', 'firstname'],
  last: ['candidatelastname', 'lastname'],
  party: ['party', 'partyname', 'partydescription', 'partyabbreviation', 'partycode'],
  votes: ['votes', 'candidatevotes', 'total', 'totalvotes', 'votecount', 'vote'],
  precinct: ['precinct', 'precinctname'],
  precincts: ['precincts', 'totalprecincts', 'precinctstotal'],
  reporting: ['precinctsreporting', 'reporting', 'precinctsreported'],
};

const text = fs.readFileSync(file, 'utf8');
const { header, rows: raw } = parseDelimited(text);
const col = {};
for (const [k, names] of Object.entries(SYN)) col[k] = header.find((h) => names.includes(norm(h)));
const missing = ['county', 'contest', 'votes'].filter((k) => !col[k]).concat(col.candidate || (col.first && col.last) ? [] : ['candidate']);
if (missing.length) {
  console.error(`Could not find column(s): ${missing.join(', ')}.\nHeader was: ${header.join(' | ')}\nRename the columns (see manual/template.csv) and try again.`);
  process.exit(1);
}

const rows = [];
for (const r of raw) {
  let contest = r[col.contest] || '';
  const dist = col.district ? String(r[col.district] || '').trim() : '';
  if (dist && !/^0*$/.test(dist) && !/district/i.test(contest)) contest = `${contest} District ${dist}`;
  const candidate = col.candidate ? r[col.candidate] : `${r[col.first] || ''} ${r[col.last] || ''}`.trim();
  if (!r[col.county] || !contest || !candidate) continue;
  rows.push({
    county: r[col.county],
    precinct: col.precinct ? r[col.precinct] || null : null,
    level: col.precinct ? 'precinct' : 'county',
    contest,
    candidate,
    party: col.party ? r[col.party] : '',
    mode: 'TOTAL',
    votes: toNum(r[col.votes]),
    prTot: col.precincts ? toNum(r[col.precincts]) : undefined,
    prRep: col.reporting ? toNum(r[col.reporting]) : undefined,
  });
}

// Which board races does the file cover?
const board = JSON.parse(fs.readFileSync(path.join(root, 'site', 'board.json'), 'utf8'));
const races = Object.keys(board.races).filter((id) => id.startsWith(st + '-'));
const kept = new Set();
for (const id of races) {
  const re = contestMatcher('auto', id);
  const hits = rows.filter((r) => re.test(r.contest));
  hits.forEach((r) => kept.add(r));
  const contests = [...new Set(hits.map((r) => r.contest))];
  const counties = new Set(hits.map((r) => r.county)).size;
  const votes = hits.reduce((a, r) => a + r.votes, 0);
  console.log(`${id.padEnd(7)} ${hits.length ? `${contests.join('; ')} · ${counties} counties · ${votes.toLocaleString()} votes` : 'not found in this file'}`);
}
if (!kept.size) {
  console.error(`\nNo ${st} board race was found. Contest names in the file look like: ${[...new Set(rows.map((r) => r.contest))].slice(0, 8).join(' | ')}`);
  process.exit(1);
}

const record = {
  feed: st.toLowerCase(),
  adapter: 'manual',
  states: [st],
  url: `manual import of ${path.basename(file)}`,
  sourceUpdatedAt: fs.statSync(file).mtime.toISOString(),
  note: 'manually imported',
  host: 'manual import',
  fetchedAt: new Date().toISOString(),
  rows: [...kept],
};
if (flag('--dry-run')) {
  console.log(`\n${kept.size} rows ready (dry run, nothing pushed).`);
  process.exit(0);
}
const dir = path.join(root, '.relay');
const log = (...a) => console.log(...a);
preparePublishDir(root, dir, 'election-data-relay', log);
fs.mkdirSync(path.join(dir, 'relay'), { recursive: true });
fs.writeFileSync(path.join(dir, 'relay', `${st.toLowerCase()}.json`), JSON.stringify(record));
publish(dir, 'election-data-relay', log);
console.log(`\n${kept.size} rows pushed. The board picks them up on the GitHub collector's next pass (about 90 s).`);
