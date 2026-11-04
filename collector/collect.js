#!/usr/bin/env node
// Election-night collector: fetch every configured feed, join precincts to their 2024 baseline, compute
// swing and projections, and write results JSON for the board.
//
//   node collector/collect.js --once                    # one pass into site/results/
//   node collector/collect.js --watch --serve           # loop every 90 s and serve http://localhost:8080
//   node collector/collect.js --watch --publish         # loop and push results to the election-data branch
//   node collector/collect.js --demo --demo-clock 21:30 # write simulated results (pipeline test)
//
// Options: --interval <sec> (90)  --minutes <run time, 0 = forever>  --out <dir>  --only NC-01,NC-09
//          --sources <file> (config/sources.json)  --calls <file> (config/calls.json)
//          --refresh-config <branch>  before every pass, pull config/ and site/board.json from that branch
//                                     on origin, so edits made on GitHub during the night take effect
//          --branch <name> (election-data)  --port <n> (8080)  --verbose
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contestMatcher } from './lib/contest.js';
import { buildUnits } from './lib/units.js';
import { countyKey } from '../site/js/shared/normalize.js';
import { loadBaseline, attachBaseline } from './lib/baseline.js';
import { buildRace } from '../site/js/shared/race.js';
import { nationalSwing } from '../site/js/shared/model.js';
import { createDemo, simulateRace, minutesAfterSix, demoClockIso } from '../site/js/shared/demo.js';
import { preparePublishDir, publish } from './publish.js';
import { serve } from './serve.js';
import { execFileSync } from 'node:child_process';

import * as ncsbe from './adapters/ncsbe.js';
import * as clarity from './adapters/clarity.js';
import * as enhanced from './adapters/enhanced-voting.js';
import * as fldos from './adapters/fl-dos.js';
import * as delimited from './adapters/delimited.js';
import * as jsonAdapter from './adapters/json.js';
import * as cdf from './adapters/cdf.js';
import * as txCivix from './adapters/tx-civix.js';
import * as relay from './adapters/relay.js';
import * as inEnr from './adapters/in-enr.js';

const ADAPTERS = { ncsbe, clarity, 'enhanced-voting': enhanced, 'fl-dos': fldos, delimited, json: jsonAdapter, cdf, 'tx-civix': txCivix, relay, 'in-enr': inEnr };

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const VERBOSE = flag('--verbose');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const readJSON = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    if (d !== undefined && e.code === 'ENOENT') return d;
    throw new Error(`${path.relative(root, f)}: ${e.message}`);
  }
};

function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

// ------------------------------------------------------------------ race -> feed plan
// A plan entry names one feed, or a fallback group (["oh", "oh-relay"]): the first feed in the group
// that returned data on this pass is used.
function racePlan(id, sources) {
  const st = id.slice(0, 2);
  let spec = sources.races?.[id];
  if (spec == null) spec = sources.stateFeeds?.[st] || [];
  if (!Array.isArray(spec)) spec = [spec];
  return spec
    .map((s) => (typeof s === 'string' ? { feed: s, contest: 'auto' } : Array.isArray(s) ? { group: s, feed: s[0], contest: 'auto' } : s))
    .map((s) => ({ ...s, re: contestMatcher(s.contest, id) }));
}

function resolveGroup(p, feedStatus) {
  if (!p.group) return p.feed;
  const live = p.group.find((f) => feedStatus[f]?.ok && feedCache.get(f)?.rows?.length);
  if (live) return live;
  return p.group.find((f) => feedCache.get(f)?.rows?.length) || p.group[0];
}

// ------------------------------------------------------------------ feeds
const feedCache = new Map(); // feed id -> last good { rows, meta, fetchedAt }
const blockedUntil = new Map(); // feed id -> { until, error, key }

async function fetchFeeds(needed, sources) {
  const status = {};
  const ids = [...needed.keys()];
  const limit = 4;
  for (let i = 0; i < ids.length; i += limit) {
    await Promise.all(
      ids.slice(i, i + limit).map(async (id) => {
        const feed = sources.feeds?.[id];
        const fetchedAt = new Date().toISOString();
        if (!feed) {
          status[id] = { id, ok: false, error: 'feed not defined in config/sources.json', fetchedAt };
          return;
        }
        const base = { id, adapter: feed.adapter, url: feed.url || null, fetchedAt, note: feed.note };
        if (!feed.url && !feed.discover && !feed.file) {
          status[id] = { ...base, ok: false, configured: false, error: feed.hint ? `no URL configured yet: ${feed.hint}` : 'no URL configured yet' };
          return;
        }
        const adapter = ADAPTERS[feed.adapter];
        if (!adapter) {
          status[id] = { ...base, ok: false, error: `unknown adapter "${feed.adapter}"` };
          return;
        }
        // A site that refused automated access is only asked again every 10 minutes.
        const wait = blockedUntil.get(id);
        if (wait && Date.now() < wait.until && wait.key === JSON.stringify(feed)) {
          status[id] = { ...base, ok: false, blocked: true, error: `${wait.error}; next try ${new Date(wait.until).toISOString().slice(11, 16)} UTC` };
          return;
        }
        const t0 = Date.now();
        try {
          const res = await adapter.fetchFeed(feed, { contestFilters: needed.get(id), log, previous: feedCache.get(id) });
          feedCache.set(id, { ...res, fetchedAt });
          blockedUntil.delete(id);
          status[id] = { ...base, url: res.meta?.url || base.url, ok: true, rows: res.rows.length, sourceUpdatedAt: res.meta?.sourceUpdatedAt || null, note: res.meta?.note || feed.note, ms: Date.now() - t0 };
          log(`feed ${id}: ${res.rows.length} rows in ${Date.now() - t0} ms${res.notModified ? ' (unchanged)' : ''}`);
        } catch (e) {
          const prev = feedCache.get(id);
          const blocked = e.blocked || /bot protection/.test(e.message);
          if (blocked) blockedUntil.set(id, { until: Date.now() + 10 * 60000, error: e.message, key: JSON.stringify(feed) });
          status[id] = { ...base, ok: false, blocked: blocked || undefined, error: e.message, stale: prev ? prev.fetchedAt : null };
          log(`feed ${id} failed: ${e.message}${prev ? ' (using last good copy)' : ''}`);
        }
      })
    );
  }
  return status;
}

// ------------------------------------------------------------------ one pass
/**
 * When two feeds give county totals for the same county (Texas's state file and a county's own site),
 * keep only the feed with more votes there, so the county isn't counted twice. Rows are edited in place.
 */
export function dedupeCountyTotals(rows) {
  const byCounty = new Map(); // county key -> Map(feed -> votes)
  for (const r of rows) {
    if (!(r.precinct == null || r.level === 'county')) continue;
    const k = countyKey(r.county);
    if (!byCounty.has(k)) byCounty.set(k, new Map());
    const m = byCounty.get(k);
    m.set(r._feed, (m.get(r._feed) || 0) + (Number(r.votes) || 0));
  }
  const keep = new Map();
  for (const [k, m] of byCounty) if (m.size > 1) keep.set(k, [...m].sort((a, b) => b[1] - a[1])[0][0]);
  if (!keep.size) return rows;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (!(r.precinct == null || r.level === 'county')) continue;
    const want = keep.get(countyKey(r.county));
    if (want && r._feed !== want) rows.splice(i, 1);
  }
  return rows;
}

const histories = new Map();

function loadHistories(outDir) {
  const dir = path.join(outDir, 'races');
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (d.id && Array.isArray(d.history)) histories.set(d.id, d.history);
    } catch {
      /* ignore */
    }
  }
}

async function runOnce(outDir) {
  const board = readJSON(path.join(root, 'site', 'board.json'));
  const sources = readJSON(path.resolve(opt('--sources', path.join(root, 'config', 'sources.json'))));
  const calls = readJSON(path.resolve(opt('--calls', path.join(root, 'config', 'calls.json'))), {});
  const only = opt('--only') ? new Set(opt('--only').split(',')) : null;
  const ids = Object.keys(board.races).filter((id) => !only || only.has(id));
  const baselineDir = path.join(root, 'baseline');
  const now = new Date().toISOString();

  const plans = new Map(ids.map((id) => [id, racePlan(id, sources)]));
  const needed = new Map();
  for (const plan of plans.values())
    for (const p of plan) for (const f of p.group || [p.feed]) needed.set(f, [...(needed.get(f) || []), p.re]);
  const feedStatus = await fetchFeeds(needed, sources);

  const races = {};
  for (const id of ids) {
    const plan = plans.get(id);
    const rows = [];
    for (const p of plan) {
      p.feed = resolveGroup(p, feedStatus);
      const fr = feedCache.get(p.feed);
      if (!fr) continue;
      const counties = p.counties ? new Set(p.counties.map((c) => c.toUpperCase())) : null;
      for (const r of fr.rows) {
        if (!p.re.test(r.contest)) continue;
        if (counties && !counties.has(String(r.county).toUpperCase())) continue;
        rows.push({ ...r, _feed: p.feed });
      }
    }
    dedupeCountyTotals(rows);
    const cfg = sources.races?.[id] && !Array.isArray(sources.races[id]) ? sources.races[id] : {};
    const built = buildUnits(rows, { candidates: cfg.candidates || plan.find((p) => p.candidates)?.candidates });
    const { candidates, contests } = built;
    const idx = loadBaseline(baselineDir, id.slice(0, 2));
    const dist = Number(id.split('-')[1]);
    const { units } = attachBaseline(built.units, idx, { statewide: /-SEN$/.test(id), district: Number.isFinite(dist) ? dist : null });
    const feeds = plan.map((p) => ({ ...(feedStatus[p.feed] || { id: p.feed, ok: false }), contests: contests.length ? contests : undefined }));
    if (!units.length && plan.length && feeds.some((f) => f.ok)) feeds.forEach((f) => f.ok && (f.note = `no contest matched ${p_re(plan)}`));
    const { summary, detail } = buildRace(id, units, { now, candidates, call: calls[id] || null, feeds, history: histories.get(id) || [] });
    histories.set(id, detail.history);
    summary.baseline = idx ? { source: idx.source } : null;
    writeJSON(path.join(outDir, 'races', `${id}.json`), detail);
    races[id] = summary;
  }
  const found = Object.values(races).filter((r) => r.precincts.total > 0);
  if (found.length) log(`races with precincts: ${found.map((r) => `${r.id} (${r.precincts.total}, ${Math.round((r.match.rate || 0) * 100)}% matched)`).join(', ')}`);
  const ns = nationalSwing(Object.values(races));
  writeJSON(path.join(outDir, 'summary.json'), { generatedAt: now, mode: 'live', national: ns, feeds: feedStatus, races });
  const counting = Object.values(races).filter((r) => r.votes.T > 0).length;
  const bad = Object.values(feedStatus).filter((f) => !f.ok && f.configured !== false).length;
  log(`wrote ${ids.length} races · ${counting} counting · national swing ${ns.swing ?? '—'} · feeds ok ${Object.values(feedStatus).filter((f) => f.ok).length}/${Object.keys(feedStatus).length}${bad ? ` (${bad} failing)` : ''}`);
}
const p_re = (plan) => plan.map((p) => p.re.source.slice(-40)).join(' / ');

// ------------------------------------------------------------------ demo pipeline
function runDemo(outDir) {
  const board = readJSON(path.join(root, 'site', 'board.json'));
  const demo = createDemo(board);
  const clock = opt('--demo-clock', '21:30');
  const minutes = minutesAfterSix(clock);
  const env = opt('--demo-env', 'wave');
  const races = {};
  for (const id of Object.keys(board.races)) {
    const { summary, detail } = simulateRace(demo, id, minutes, env, { withHistory: true });
    writeJSON(path.join(outDir, 'races', `${id}.json`), detail);
    races[id] = summary;
  }
  writeJSON(path.join(outDir, 'summary.json'), { generatedAt: demoClockIso(minutes), mode: 'demo', env, national: nationalSwing(Object.values(races)), races });
  log(`demo results for ${clock} ET (${env}) written to ${outDir}`);
}

function refreshConfig(branch) {
  try {
    execFileSync('git', ['fetch', '--quiet', '--depth', '1', 'origin', branch], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['checkout', 'FETCH_HEAD', '--', 'config', 'site/board.json'], { cwd: root, stdio: 'ignore' });
  } catch (e) {
    log(`config refresh from ${branch} failed: ${e.message.split('\n')[0]}`);
  }
}

// ------------------------------------------------------------------ main
async function main() {
  const branch = opt('--branch', 'election-data');
  let outDir = path.resolve(opt('--out', path.join(root, 'site', 'results')));
  let pubDir = null;
  if (flag('--publish')) {
    pubDir = path.resolve(opt('--publish-dir', path.join(root, '.publish')));
    preparePublishDir(root, pubDir, branch, log);
    outDir = path.join(pubDir, 'results');
  }
  fs.mkdirSync(outDir, { recursive: true });
  if (flag('--serve')) serve({ port: Number(opt('--port', 8080)), root: path.join(root, 'site'), mounts: { '/results/': outDir } });

  if (flag('--demo')) {
    runDemo(outDir);
    if (pubDir) publish(pubDir, branch, log);
    return;
  }
  loadHistories(outDir);
  const watch = flag('--watch');
  const interval = Number(opt('--interval', 90)) * 1000;
  const stopAt = Number(opt('--minutes', 0)) > 0 ? Date.now() + Number(opt('--minutes')) * 60000 : Infinity;
  const refresh = opt('--refresh-config');
  do {
    const t0 = Date.now();
    if (refresh) refreshConfig(refresh);
    try {
      await runOnce(outDir);
      if (pubDir) publish(pubDir, branch, log);
    } catch (e) {
      log(`pass failed: ${e.stack || e.message}`);
      if (!watch) process.exitCode = 1;
    }
    if (!watch) break;
    const wait = Math.max(5000, interval - (Date.now() - t0));
    if (Date.now() + wait > stopAt) break;
    await new Promise((r) => setTimeout(r, wait));
  } while (Date.now() < stopAt);
  if (flag('--serve') && !watch) log('serving; press Ctrl+C to stop');
}

main();
