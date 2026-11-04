// Publish results to a dedicated branch (default: election-data) as a single, force-pushed commit,
// so the branch never accumulates hundreds of snapshots. The board reads it through the GitHub API
// (latest commit SHA) + raw.githubusercontent.com.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Git never waits for input here (a credential or SSH prompt would freeze the whole relay or
// collector, since execFileSync blocks), and a stalled network call is killed after a while so the
// next pass can try again.
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=2',
};
const NETWORK = new Set(['push', 'fetch', 'pull', 'clone']);
const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=30', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: GIT_ENV,
    timeout: NETWORK.has(args[0]) ? 90000 : 30000,
    killSignal: 'SIGKILL',
  }).trim();
const tryGit = (cwd, ...args) => {
  try {
    return git(cwd, ...args);
  } catch {
    return null;
  }
};

export function preparePublishDir(repo, dir, branch, log = console.log) {
  if (fs.existsSync(path.join(dir, '.git'))) {
    log(`publish: reusing ${dir}`);
    return;
  }
  const remote = tryGit(repo, 'fetch', '--depth', '1', 'origin', `${branch}:refs/remotes/origin/${branch}`) !== null;
  fs.rmSync(dir, { recursive: true, force: true });
  if (remote) {
    git(repo, 'worktree', 'add', '--force', '-B', branch, dir, `origin/${branch}`);
    log(`publish: checked out existing ${branch} into ${dir}`);
  } else {
    git(repo, 'worktree', 'add', '--force', '--detach', dir);
    git(dir, 'checkout', '--orphan', branch);
    tryGit(dir, 'rm', '-rf', '--quiet', '.');
    for (const f of fs.readdirSync(dir)) if (f !== '.git') fs.rmSync(path.join(dir, f), { recursive: true, force: true });
    fs.writeFileSync(
      path.join(dir, 'README.md'),
      '# election-data\n\nMachine-written results for the election tracker. Each push replaces the previous commit.\n'
    );
    log(`publish: created new orphan branch ${branch} in ${dir}`);
  }
}

export function publish(dir, branch, log = console.log) {
  try {
    git(dir, 'add', '-A');
    const changed = tryGit(dir, 'diff', '--cached', '--quiet') === null;
    if (!changed) {
      log('publish: no changes');
      return;
    }
    const msg = `results ${new Date().toISOString()}`;
    const hasHead = tryGit(dir, 'rev-parse', '--verify', 'HEAD') !== null;
    if (hasHead) git(dir, 'commit', '--amend', '--quiet', '-m', msg);
    else git(dir, 'commit', '--quiet', '-m', msg);
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        git(dir, 'push', '--force', '--quiet', 'origin', `HEAD:refs/heads/${branch}`);
        log(`publish: pushed ${branch}`);
        return;
      } catch (e) {
        if (attempt === 3) throw e;
        execFileSync('sleep', [String(2 ** (attempt + 1))]);
      }
    }
  } catch (e) {
    const why = e.signal === 'SIGKILL' || e.code === 'ETIMEDOUT' ? 'git took too long (network stalled?); will retry next pass' : (e.stderr || e.message || '').toString().trim();
    log(`publish failed: ${why}`);
  }
}
