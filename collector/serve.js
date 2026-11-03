#!/usr/bin/env node
// Minimal static server for the site (and the collector's results) with caching disabled.
//   node collector/serve.js [--port 8080] [--root site]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function serve({ port = 8080, root = path.join(here, '..', 'site'), mounts = {} } = {}) {
  const base = path.resolve(root);
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    let dir = base;
    for (const [prefix, d] of Object.entries(mounts)) {
      if (p.startsWith(prefix)) {
        dir = path.resolve(d);
        p = '/' + p.slice(prefix.length);
        break;
      }
    }
    const file = path.resolve(dir, '.' + p);
    if (!file.startsWith(dir)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(buf);
    });
  });
  server.listen(port, () => console.log(`Serving ${base} at http://localhost:${port}/`));
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const get = (k, d) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : d;
  };
  serve({ port: Number(get('--port', 8080)), root: get('--root', path.join(here, '..', 'site')) });
}
