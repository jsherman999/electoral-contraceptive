#!/usr/bin/env node
// Fetch URLs and print what came back: status, type, size, a snippet, and any results-looking links.
// Used through the "Probe URLs" workflow to look at election sites from GitHub's network.
//   node collector/probe.js <url> [<url> ...]
import { get } from './lib/http.js';

const LINK = /(?:href|src)\s*=\s*["']([^"'#]+[^"']*)["']/gi;
const INTERESTING = /result|clarity|enr|election|export|\/[A-Z]{2}\/\d{5,7}|\.json|\.zip|\.txt|\.csv/i;

for (const url of process.argv.slice(2)) {
  console.log(`\n=== ${url}`);
  try {
    const res = await get(url, { timeoutMs: 30000, retries: 0, conditional: false, headers: { accept: 'text/html,application/json,*/*' } });
    const text = res.buf.toString('utf8');
    console.log(`status ${res.status} · ${res.headers.get('content-type')} · ${res.buf.length} bytes`);
    console.log(`snippet: ${text.replace(/\s+/g, ' ').slice(0, 400)}`);
    const links = new Set();
    for (const m of text.matchAll(LINK)) if (INTERESTING.test(m[1])) links.add(new URL(m[1], url).href);
    for (const m of text.matchAll(/https?:\/\/[^\s"'<>]+/g)) if (INTERESTING.test(m[0])) links.add(m[0]);
    const list = [...links].slice(0, 80);
    console.log(`links (${links.size}):`);
    for (const l of list) console.log(`  ${l}`);
  } catch (e) {
    console.log(`error: ${e.message}`);
  }
}
