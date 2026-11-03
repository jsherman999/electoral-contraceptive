// fetch() wrapper: timeouts, retries with backoff, conditional requests (ETag / Last-Modified).
const UA = 'Mozilla/5.0 (compatible; election-night-tracker/1.0; +https://github.com/)';
const validators = new Map(); // url -> { etag, lastModified, buf, headers }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @returns {Promise<{ url, status, buf: Buffer, notModified: boolean, headers: Headers, text(): string, json(): any }>}
 */
export async function get(url, { timeoutMs = 45000, retries = 3, conditional = true, headers = {} } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const h = { 'user-agent': UA, accept: '*/*', ...headers };
      const prev = conditional ? validators.get(url) : null;
      if (prev?.etag) h['if-none-match'] = prev.etag;
      if (prev?.lastModified) h['if-modified-since'] = prev.lastModified;
      const res = await fetch(url, { headers: h, signal: ctl.signal, redirect: 'follow' });
      if (res.status === 304 && prev) {
        return wrap(url, 200, prev.buf, prev.headers, true);
      }
      if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!res.ok) {
        const e = new Error(`HTTP ${res.status} for ${url}`);
        e.status = res.status;
        e.fatal = res.status === 404 || res.status === 403 || res.status === 401;
        throw e;
      }
      if (conditional) {
        validators.set(url, {
          etag: res.headers.get('etag'),
          lastModified: res.headers.get('last-modified'),
          buf,
          headers: res.headers,
        });
      }
      return wrap(url, res.status, buf, res.headers, false);
    } catch (e) {
      lastErr = e.name === 'AbortError' ? new Error(`timeout after ${timeoutMs} ms: ${url}`) : e;
      if (e.fatal || attempt === retries) break;
      await sleep(1000 * 2 ** attempt);
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

function wrap(url, status, buf, headers, notModified) {
  return {
    url,
    status,
    buf,
    headers,
    notModified,
    text: () => buf.toString('utf8'),
    json: () => JSON.parse(buf.toString('utf8')),
  };
}
