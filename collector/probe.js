#!/usr/bin/env node
// Fetch URLs and print what came back: status, type, size, a snippet, and any results-looking links.
// Used through the "Probe URLs" workflow to look at election sites from GitHub's network.
//   node collector/probe.js <url> [<url> ...]
//   GREP="regex" prints matching snippets; LINKS="regex" limits the link list; SHAPE=1 prints JSON structure.
import { get } from './lib/http.js';

const LINK = /(?:href|src)\s*=\s*["']([^"'#]+[^"']*)["']/gi;
const INTERESTING = /result|clarity|enr|election|export|api|\/[A-Z]{2}\/\d{5,7}|\.json|\.zip|\.txt|\.csv|\.js(\?|$)/i;
// LINKS="regex" lists only matching links (e.g. LINKS=clarity), to keep the output short.
const LINKS_RE = process.env.LINKS ? new RegExp(process.env.LINKS, 'i') : INTERESTING;

function printShape(node, path = '', depth = 0, out = { n: 0 }) {
  if (out.n > 400 || depth > 12) return;
  if (Array.isArray(node)) {
    console.log(`${path}[] (${node.length} items)`);
    out.n += 1;
    if (node.length) printShape(node[0], `${path}[0]`, depth + 1, out);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) printShape(v, path ? `${path}.${k}` : k, depth + 1, out);
    return;
  }
  console.log(`${path} = ${JSON.stringify(node)?.slice(0, 80)}`);
  out.n += 1;
}

for (const url of process.argv.slice(2)) {
  console.log(`\n=== ${url}`);
  try {
    const res = await get(url, { timeoutMs: 30000, retries: 0, conditional: false, headers: { accept: 'text/html,application/json,*/*' } });
    let text = res.buf.toString('utf8');
    // Some APIs (Texas Civix) wrap JSON as {"upload": "<base64>"}; show the decoded content.
    const up = text.match(/^\s*\{\s*"upload"\s*:\s*"([A-Za-z0-9+/=]+)"/);
    if (up) {
      text = Buffer.from(up[1], 'base64').toString('utf8');
      console.log(`(decoded base64 "upload": ${text.length} chars)`);
    }
    console.log(`status ${res.status} · ${res.headers.get('content-type')} · ${res.buf.length} bytes`);
    const hdrs = ['last-modified', 'etag', 'age', 'cache-control', 'x-cache', 'date'].map((h) => (res.headers.get(h) ? `${h}: ${res.headers.get(h)}` : null)).filter(Boolean);
    if (hdrs.length) console.log(`headers: ${hdrs.join(' · ')}`);
    // SHAPE=1 prints a JSON response's structure: every key path, array lengths and sample values.
    if (process.env.SHAPE) {
      try {
        printShape(JSON.parse(text));
      } catch (e) {
        console.log(`(not JSON: ${e.message.slice(0, 60)})`);
      }
    }
    console.log(`snippet: ${text.replace(/\s+/g, ' ').slice(0, 400)}`);
    const links = new Set();
    const base = (text.match(/<base\s+href=["']([^"']+)["']/i) || [])[1];
    const baseUrl = base ? new URL(base, url).href : url;
    for (const m of text.matchAll(LINK)) {
      const abs = new URL(m[1], baseUrl).href;
      if (LINKS_RE.test(abs)) links.add(abs);
    }
    // GREP="regex" prints matching snippets, e.g. API paths inside a JavaScript bundle.
    if (process.env.GREP) {
      const re = new RegExp(process.env.GREP, 'g');
      const hits = new Set();
      const seenKeys = new Set();
      for (const m of text.matchAll(re)) {
        // one snippet per distinct match text, at most 60 in all
        if (seenKeys.has(m[0])) continue;
        seenKeys.add(m[0]);
        hits.add(text.slice(Math.max(0, m.index - 60), m.index + 160).replace(/\s+/g, ' '));
        if (hits.size >= 60) break;
      }
      console.log(`grep /${process.env.GREP}/ (${hits.size}):`);
      for (const h of [...hits].slice(0, 40)) console.log(`  ...${h}...`);
    }
    for (const m of text.matchAll(/https?:\/\/[^\s"'<>]+/g)) if (LINKS_RE.test(m[0])) links.add(m[0]);
    const list = [...links].slice(0, 80);
    console.log(`links (${links.size}):`);
    for (const l of list) console.log(`  ${l}`);
  } catch (e) {
    // fetch() reports network problems as "fetch failed"; the reason is in e.cause.
    const c = e.cause;
    const why = c ? ` (${[c.code, c.message].filter(Boolean).join(': ')}${c.cause ? `; ${c.cause.code || c.cause.message}` : ''})` : '';
    console.log(`error: ${e.message}${why}`);
  }
}
