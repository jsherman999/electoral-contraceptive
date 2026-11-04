// Results relayed from another computer (see collector/relay.js). Some state sites refuse requests from
// GitHub's servers but answer a home connection; the relay script fetches those feeds at home and pushes
// the parsed rows to a branch (default election-data-relay), and this adapter reads them back.
//
// Config: { "adapter": "relay", "file": "relay/oh.json", "branch": "election-data-relay", "maxAgeMinutes": 15, "staleMaxMinutes": 720 }
// Use it in a fallback group so the direct feed wins when it works:  "OH": [["oh", "oh-relay"]]
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });

export async function fetchFeed(feed, ctx = {}) {
  const branch = feed.branch || 'election-data-relay';
  try {
    git('fetch', '--quiet', '--depth', '1', 'origin', `+${branch}:refs/remotes/origin/${branch}`);
  } catch {
    throw new Error(`no relay branch "${branch}" yet (start collector/relay.js on a home computer)`);
  }
  let data;
  try {
    data = JSON.parse(git('show', `origin/${branch}:${feed.file}`));
  } catch {
    throw new Error(`relay branch has no ${feed.file} yet`);
  }
  const ageMin = (Date.now() - Date.parse(data.fetchedAt)) / 60000;
  // Past maxAgeMinutes the file is still used (the relay may be paused because a site is refusing it, and
  // the last numbers beat none), but labelled as not updated. Past staleMaxMinutes it is dropped.
  const maxAge = feed.maxAgeMinutes || 15;
  const staleMax = Math.max(maxAge, feed.staleMaxMinutes || 720);
  if (!(ageMin <= staleMax)) throw new Error(`relayed ${feed.file} is ${Math.round(ageMin)} min old (relay stopped?)`);
  const stale = ageMin > maxAge;
  const rows = ctx.contestFilters ? data.rows.filter((r) => ctx.contestFilters.some((re) => re.test(r.contest))) : data.rows;
  return {
    rows,
    meta: {
      url: data.url,
      sourceUpdatedAt: data.sourceUpdatedAt || null,
      stale,
      note: `relayed from ${data.host || 'a home computer'} ${Math.round(ageMin)} min ago${stale ? ' (not updated since: relay paused or stopped)' : ''}${data.note ? `; ${data.note}` : ''}`,
    },
  };
}
