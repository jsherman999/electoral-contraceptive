// Where results come from: the collector's JSON (local folder, any URL, or the repo's election-data
// branch on GitHub), or the in-browser simulation.
import { createDemo, simulateBoard, simulateRace } from './shared/demo.js';

const slash = (s) => (s.endsWith('/') ? s : s + '/');

export function resolveSource(cfg) {
  const q = new URLSearchParams(location.search);
  if (q.has('demo') || cfg.dataSource === 'demo') return { kind: 'demo' };
  if (q.get('data')) return { kind: 'url', base: slash(q.get('data')) };
  if (cfg.dataSource && cfg.dataSource !== 'auto') return { kind: 'url', base: slash(cfg.dataSource) };
  const gh = { branch: 'election-data', dir: 'results', ...(cfg.github || {}) };
  if (location.hostname.endsWith('.github.io')) {
    gh.owner ||= location.hostname.split('.')[0];
    gh.repo ||= location.pathname.split('/').filter(Boolean)[0] || location.hostname;
  }
  if (gh.owner && gh.repo) return { kind: 'github', ...gh };
  return { kind: 'url', base: 'results/' };
}

export class LiveSource {
  constructor(src) {
    this.src = src;
    this.kind = src.kind;
    this.base = src.base || null;
    this.viaApi = false;
    this.sha = null;
  }

  describe() {
    if (this.kind === 'github') {
      const { owner, repo, branch } = this.src;
      return `${owner}/${repo}@${branch}${this.sha ? ' · ' + this.sha.slice(0, 7) : ''}${this.viaApi ? '' : ' (CDN, may lag ~5 min)'}`;
    }
    return this.base;
  }

  async refreshBase() {
    if (this.kind !== 'github') return;
    const { owner, repo, branch, dir } = this.src;
    try {
      const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`, {
        headers: { Accept: 'application/vnd.github.sha' },
        cache: 'no-cache',
      });
      if (r.ok) {
        const sha = (await r.text()).trim();
        if (/^[0-9a-f]{40}$/.test(sha)) {
          this.sha = sha;
          this.viaApi = true;
          this.base = `https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${dir}/`;
          return;
        }
      }
      if (r.status === 404 || r.status === 422) {
        const e = new Error(`No "${branch}" branch has been published yet`);
        e.noData = true;
        throw e;
      }
    } catch (e) {
      if (e.noData) throw e;
    }
    // Rate limited or API unreachable: read the branch head through the CDN instead.
    this.viaApi = false;
    this.base = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${dir}/`;
  }

  async getJSON(path) {
    const immutable = this.kind === 'github' && this.viaApi;
    const url = this.base + path + (immutable ? '' : `?t=${Date.now()}`);
    const r = await fetch(url, { cache: immutable ? 'force-cache' : 'no-store' });
    if (r.status === 404) {
      const e = new Error(`Not published yet: ${path}`);
      e.noData = true;
      throw e;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status} loading ${path}`);
    return r.json();
  }

  async summary() {
    await this.refreshBase();
    return this.getJSON('summary.json');
  }

  async race(id) {
    if (!this.base) await this.refreshBase();
    return this.getJSON(`races/${encodeURIComponent(id)}.json`);
  }
}

export class DemoSource {
  constructor(board, env = 'wave') {
    this.kind = 'demo';
    this.demo = createDemo(board);
    this.env = env;
    this.minutes = 165; // 8:45 pm ET
  }
  describe() {
    return 'simulated returns';
  }
  async summary() {
    return simulateBoard(this.demo, this.minutes, this.env);
  }
  async race(id) {
    return simulateRace(this.demo, id, this.minutes, this.env, { withHistory: true }).detail;
  }
}
