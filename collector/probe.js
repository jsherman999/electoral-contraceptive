#!/usr/bin/env node
// Fetch URLs and print what came back: status, type, size, a snippet, and any results-looking links.
// Used through the "Probe URLs" workflow to look at election sites from GitHub's network.
//   node collector/probe.js <url> [<url> ...]
import { get } from './lib/http.js';

const LINK = /(?:href|src)\s*=\s*["']([^"'#]+[^"']*)["']/gi;
const INTERESTING = /result|clarity|enr|election|export|api|\/[A-Z]{2}\/\d{5,7}|\.json|\.zip|\.txt|\.csv|\.js(\?|$)/i;

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
    console.log(`snippet: ${text.replace(/\s+/g, ' ').slice(0, 400)}`);
    const links = new Set();
    const base = (text.match(/<base\s+href=["']([^"']+)["']/i) || [])[1];
    const baseUrl = base ? new URL(base, url).href : url;
    for (const m of text.matchAll(LINK)) {
      const abs = new URL(m[1], baseUrl).href;
      if (INTERESTING.test(abs)) links.add(abs);
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
    for (const m of text.matchAll(/https?:\/\/[^\s"'<>]+/g)) if (INTERESTING.test(m[0])) links.add(m[0]);
    const list = [...links].slice(0, 80);
    console.log(`links (${links.size}):`);
    for (const l of list) console.log(`  ${l}`);
  } catch (e) {
    console.log(`error: ${e.message}`);
  }
}
