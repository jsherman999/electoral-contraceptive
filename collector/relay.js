#!/usr/bin/env node
// Home relay: fetch feeds that refuse GitHub's servers (Ohio, Michigan) from this computer and push the
// parsed rows to the election-data-relay branch. The GitHub collector reads them back (relay adapter)
// and uses them whenever its own direct fetch fails, so the board on GitHub Pages shows them.
//
//   node collector/relay.js                     # relay Ohio every 90 s
//   node collector/relay.js --feeds oh,sc,co    # also South Carolina and Colorado (if your connection gets through)
//   node collector/relay.js --feeds oh --once   # one pass, Ohio only (good first test)
//   node collector/relay.js --no-push           # fetch and write files, but don't push
//
// Options: --feeds oh  --interval 150  --branch election-data-relay  --dir .relay  --once  --no-push
//          --max-downloads 8 (county precinct files per Clarity feed per pass; keeps request volume low)
//          --label "home relay" (how the board's Sources line describes this relay)
// Needs: Node 18+, a clone of this repo you can push to. On a Mac, keep it awake with:
//   caffeinate -i node collector/relay.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contestMatcher } from './lib/contest.js';
import { preparePublishDir, publish } from './publish.js';
import * as ncsbe from './adapters/ncsbe.js';
import * as clarity from './adapters/clarity.js';
import * as enhanced from './adapters/enhanced-voting.js';
import * as fldos from './adapters/fl-dos.js';
import * as delimited from './adapters/delimited.js';
import * as jsonAdapter from './adapters/json.js';
import * as cdf from './adapters/cdf.js';
import * as txCivix from './adapters/tx-civix.js';
import * as inEnr from './adapters/in-enr.js';
import * as harris from './adapters/harris.js';

const ADAPTERS = { ncsbe, clarity, 'enhanced-voting': enhanced, 'fl-dos': fldos, delimited, json: jsonAdapter, cdf, 'tx-civix': txCivix, 'in-enr': inEnr, harris };
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
const readJSON = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));

const feedIds = opt('--feeds', 'oh').split(',').map((s) => s.trim()).filter(Boolean);
const interval = Number(opt('--interval', 150)) * 1000;
const branch = opt('--branch', 'election-data-relay');
const dir = path.resolve(root, opt('--dir', '.relay'));
const push = !flag('--no-push');

/** Contest patterns for every board race in the states this feed serves. */
function filtersFor(feedId, board, sources) {
  const states = Object.entries(sources.stateFeeds || {})
    .filter(([, list]) => list.flat().includes(feedId))
    .map(([st]) => st);
  const res = [];
  for (const id of Object.keys(board.races)) if (states.includes(id.slice(0, 2))) res.push(contestMatcher('auto', id));
  return { states, res };
}

// Feeds on one platform share its bot protection: when Clarity refuses one feed it is refusing this
// computer, so every Clarity feed pauses, for 5, 10, 20 and then 30 minutes at a time.
const group = (id, feed) => (feed.adapter === 'clarity' ? 'clarity' : id);
const backoff = new Map(); // group -> time to retry after a refusal
const strikes = new Map(); // group -> refusals in a row
const lookupWait = new Map(); // feed -> time to retry after its election could not be found
// The relay is one computer asking many sites: at most this many county precinct files per Clarity
// feed per pass (the rest keep their last file, or the county total, until a later pass).
const maxDownloads = Number(opt('--max-downloads', 8));
const fmt = (t) => new Date(t).toLocaleTimeString();

async function pass() {
  const board = readJSON('site/board.json');
  const sources = readJSON('config/sources.json');
  fs.mkdirSync(path.join(dir, 'relay'), { recursive: true });
  let wrote = 0;
  const paused = [];
  for (const id of feedIds) {
    const feed = sources.feeds?.[id];
    if (!feed) {
      log(`${id}: not defined in config/sources.json`);
      continue;
    }
    if (!feed.url && !feed.discover && !feed.page) {
      log(`${id}: no URL configured yet. Find the state's results data URL (try: node collector/probe.js <url>) and set feeds.${id}.url in config/sources.json`);
      continue;
    }
    const g = group(id, feed);
    if (backoff.get(g) > Date.now()) {
      paused.push(id);
      continue;
    }
    if (lookupWait.get(id) > Date.now()) continue;
    const { states, res } = filtersFor(id, board, sources);
    const t0 = Date.now();
    try {
      const f = feed.adapter === 'clarity' ? { concurrency: 2, maxDownloads, ...feed } : feed;
      const out = await ADAPTERS[feed.adapter].fetchFeed(f, { contestFilters: res, log });
      strikes.delete(g);
      const record = {
        feed: id,
        adapter: feed.adapter,
        states,
        url: out.meta?.url || feed.url,
        sourceUpdatedAt: out.meta?.sourceUpdatedAt || null,
        note: out.meta?.note,
        host: opt('--label', 'home relay'), // shown on the public board; your computer's name is never sent
        fetchedAt: new Date().toISOString(),
        rows: out.rows,
      };
      fs.writeFileSync(path.join(dir, 'relay', `${id}.json`), JSON.stringify(record));
      wrote += 1;
      const contests = new Set(out.rows.map((r) => r.contest));
      log(`${id}: ${out.rows.length} rows, ${contests.size} contests (${[...contests].slice(0, 4).join('; ')}${contests.size > 4 ? '; ...' : ''}) in ${Date.now() - t0} ms`);
      if (out.meta?.note) log(`${id}: ${out.meta.note}`);
    } catch (e) {
      const refused = e.blocked || /HTTP 40[135]|HTTP 429|bot protection/.test(e.message);
      if (refused) {
        const n = (strikes.get(g) || 0) + 1;
        strikes.set(g, n);
        const mins = Math.min(30, 5 * 2 ** (n - 1));
        backoff.set(g, Date.now() + mins * 60000);
        log(`${id}: failed: ${e.message}`);
        log(`${g === 'clarity' ? 'Clarity (all Clarity feeds)' : id}: the site is refusing this computer; pausing ${mins} minutes, until ${fmt(backoff.get(g))}`);
      } else {
        // An election that isn't posted yet is looked for again every 10 minutes, not every pass.
        if (/could not find the/.test(e.message)) lookupWait.set(id, Date.now() + 10 * 60000);
        log(`${id}: failed: ${e.message}`);
      }
    }
  }
  if (paused.length) log(`paused (site refused this computer): ${paused.join(', ')}; next try ${fmt(Math.min(...paused.map((id) => backoff.get(group(id, sources.feeds[id])))))}`);
  if (wrote && push) publish(dir, branch, log);
}

async function main() {
  if (push) preparePublishDir(root, dir, branch, log);
  else fs.mkdirSync(dir, { recursive: true });
  log(`relaying ${feedIds.join(', ')} every ${interval / 1000} s${push ? ` to branch ${branch}` : ' (no push)'}`);
  do {
    const t0 = Date.now();
    try {
      await pass();
    } catch (e) {
      log(`pass failed: ${e.message}`);
    }
    if (flag('--once')) break;
    await new Promise((r) => setTimeout(r, Math.max(5000, interval - (Date.now() - t0))));
  } while (true);
}

main();
