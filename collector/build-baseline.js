#!/usr/bin/env node
// Build 2024 precinct baselines: baseline/<st>.json.gz with 2024 President and 2024 House votes by
// precinct and vote mode.
//
//   node collector/build-baseline.js                 # every state on the board
//   node collector/build-baseline.js --states nc,va  # some states
//   node collector/build-baseline.js --cache /tmp/x  # keep downloads between runs
//
// Sources: MIT Election Data + Science Lab, 2024 precinct returns
// (github.com/MEDSL/2024-elections-official, individual_states/<st>24.zip). North Carolina uses the
// NC State Board of Elections 2024 precinct file instead, because it has exactly the same precinct
// names as the live 2026 file.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { get } from './lib/http.js';
import { unzipStream } from './lib/zip.js';
import { lines, splitLine } from './lib/csv.js';
import { normMode, isNonCandidate } from '../site/js/shared/normalize.js';
import { fetchFeed as ncsbe } from './adapters/ncsbe.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const MEDSL = (st) => `https://raw.githubusercontent.com/MEDSL/2024-elections-official/main/individual_states/${st}24.zip`;
const NC2024 = 'https://s3.amazonaws.com/dl.ncsbe.gov/ENRS/2024_11_05/results_pct_20241105.zip';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};

function boardStates() {
  const board = JSON.parse(fs.readFileSync(path.join(root, 'site', 'board.json'), 'utf8'));
  return [...new Set(Object.keys(board.races).map((id) => id.slice(0, 2).toLowerCase()))].sort();
}

async function download(url, cacheDir) {
  if (cacheDir) {
    const f = path.join(cacheDir, path.basename(new URL(url).pathname));
    if (fs.existsSync(f)) return fs.readFileSync(f);
    const buf = (await get(url, { timeoutMs: 300000, conditional: false })).buf;
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(f, buf);
    return buf;
  }
  return (await get(url, { timeoutMs: 300000, conditional: false })).buf;
}

const addVotes = (cells, mode, p, v) => {
  const c = (cells[mode] ||= [0, 0, 0]);
  c[p === 'D' ? 0 : p === 'R' ? 1 : 2] += v;
};

function finish(recs, state, source) {
  // Drop TOTAL rows where a mode breakdown also exists (MEDSL keeps whatever the state reported).
  for (const r of recs.values()) {
    for (const k of ['pres', 'house']) {
      const c = r[k];
      if (c && c.TOTAL && Object.keys(c).length > 1) delete c.TOTAL;
      if (c && !Object.keys(c).length) r[k] = null;
    }
  }
  // Uncontested 2024 House races make useless baselines: drop them.
  const dist = new Map();
  for (const r of recs.values()) {
    if (!r.house || r.hd == null) continue;
    const t = dist.get(r.hd) || [0, 0];
    for (const c of Object.values(r.house)) {
      t[0] += c[0];
      t[1] += c[1];
    }
    dist.set(r.hd, t);
  }
  const uncontested = new Set([...dist].filter(([, t]) => t[0] === 0 || t[1] === 0).map(([d]) => d));
  const out = [];
  for (const r of recs.values()) {
    if (!r.pres && !r.house) continue;
    const house = r.house && !uncontested.has(r.hd) ? r.house : null;
    const row = [r.county, r.precinct, r.pres, house, house ? r.hd : null];
    if (r.virtual !== undefined) row.push(r.virtual ? 1 : 0); // source's own batch flag (NC 'Real Precinct')
    out.push(row);
  }
  out.sort((a, b) => (a[0] + '|' + a[1]).localeCompare(b[0] + '|' + b[1]));
  return {
    state: state.toUpperCase(),
    election: '2024-11-05',
    source,
    built: new Date().toISOString(),
    uncontestedHouseDistricts: [...uncontested].sort((a, b) => a - b),
    precincts: out,
  };
}

async function buildNC(cacheDir) {
  const buf = await download(NC2024, cacheDir);
  const tmp = { url: 'file' };
  // Reuse the live adapter by handing it the bytes through a data URL-like shim.
  const rows = (await ncsbeFromBuffer(buf)).rows;
  const recs = new Map();
  for (const r of rows) {
    const isPres = /^US PRESIDENT$/i.test(r.contest);
    const hm = r.contest.match(/^US HOUSE OF REPRESENTATIVES DISTRICT (\d+)$/i);
    if (!isPres && !hm) continue;
    if (isNonCandidate(r.candidate)) continue;
    const key = `${r.county}|${r.precinct}`;
    let rec = recs.get(key);
    if (!rec) recs.set(key, (rec = { county: r.county, precinct: r.precinct, pres: null, house: null, hd: null, virtual: r.virtual }));
    const p = /^DEM/i.test(r.party) ? 'D' : /^REP/i.test(r.party) ? 'R' : 'O';
    if (isPres) addVotes((rec.pres ||= {}), r.mode, p, r.votes);
    else {
      addVotes((rec.house ||= {}), r.mode, p, r.votes);
      rec.hd = Number(hm[1]);
    }
  }
  void tmp;
  return finish(recs, 'nc', 'NC State Board of Elections, 2024 general precinct results (results_pct_20241105.zip)');
}

async function ncsbeFromBuffer(buf) {
  // ncsbe.fetchFeed downloads by URL; serve the cached bytes from a throwaway local server.
  const http = await import('node:http');
  const server = http.createServer((q, s) => s.end(buf));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await ncsbe({ url: `http://127.0.0.1:${server.address().port}/nc.zip` }, { contestFilters: [/^US PRESIDENT$/i, /^US HOUSE OF REPRESENTATIVES/i] });
  } finally {
    server.close();
  }
}

async function buildMedsl(st, cacheDir) {
  const buf = await download(MEDSL(st), cacheDir);
  const stream = unzipStream(buf, /\.csv$/i);
  let header = null;
  let ix = {};
  const raw = [];
  for await (const line of lines(stream)) {
    if (!header) {
      header = splitLine(line.replace(/^﻿/, ''), ',');
      header.forEach((h, i) => (ix[h] = i));
      continue;
    }
    if (!line.includes('US PRESIDENT') && !line.includes('US HOUSE')) continue;
    const f = splitLine(line, ',');
    const office = f[ix.office];
    if (office !== 'US PRESIDENT' && office !== 'US HOUSE') continue;
    raw.push(f);
  }
  // Precinct names repeat across municipalities in some states (MI, WI, NJ, ...). If a county has the same
  // precinct name under more than one jurisdiction, prefix the jurisdiction for that county.
  const seen = new Map();
  for (const f of raw) {
    const k = `${f[ix.county_name]}|${f[ix.precinct]}`;
    const j = f[ix.jurisdiction_name];
    const s = seen.get(k) || new Set();
    s.add(j);
    seen.set(k, s);
  }
  const prefixCounty = new Set();
  for (const [k, s] of seen) if (s.size > 1) prefixCounty.add(k.split('|')[0]);

  const recs = new Map();
  for (const f of raw) {
    const cand = f[ix.candidate];
    if (isNonCandidate(cand)) continue;
    const county = f[ix.county_name];
    let precinct = f[ix.precinct];
    const jur = f[ix.jurisdiction_name];
    if (prefixCounty.has(county) && jur && jur !== county && !precinct.toUpperCase().includes(jur.toUpperCase())) precinct = `${jur} ${precinct}`;
    const key = `${county}|${precinct}`;
    let rec = recs.get(key);
    if (!rec) recs.set(key, (rec = { county, precinct, pres: null, house: null, hd: null }));
    const ps = f[ix.party_simplified];
    const p = ps === 'DEMOCRAT' ? 'D' : ps === 'REPUBLICAN' ? 'R' : 'O';
    const v = Number(f[ix.votes]) || 0;
    const mode = normMode(f[ix.mode]);
    if (f[ix.office] === 'US PRESIDENT') addVotes((rec.pres ||= {}), mode, p, v);
    else {
      addVotes((rec.house ||= {}), mode, p, v);
      const d = parseInt(f[ix.district], 10);
      if (isFinite(d)) rec.hd = d;
    }
  }
  return finish(recs, st, 'MIT Election Data + Science Lab, 2024 precinct returns (MEDSL/2024-elections-official)');
}

async function main() {
  const states = (opt('--states') ? opt('--states').split(',') : boardStates()).map((s) => s.trim().toLowerCase());
  const cacheDir = opt('--cache');
  const outDir = opt('--out', path.join(root, 'baseline'));
  fs.mkdirSync(outDir, { recursive: true });
  for (const st of states) {
    const t0 = Date.now();
    try {
      const data = st === 'nc' ? await buildNC(cacheDir) : await buildMedsl(st, cacheDir);
      const gz = zlib.gzipSync(JSON.stringify(data), { level: 9 });
      fs.writeFileSync(path.join(outDir, `${st}.json.gz`), gz);
      const pres = data.precincts.filter((p) => p[2]).length;
      const house = data.precincts.filter((p) => p[3]).length;
      console.log(`${st.toUpperCase()}: ${data.precincts.length} precincts (${pres} with 2024 President, ${house} with contested 2024 House) · ${(gz.length / 1024).toFixed(0)} KB · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (e) {
      console.error(`${st.toUpperCase()}: FAILED ${e.message}`);
      process.exitCode = 1;
    }
  }
}

main();
