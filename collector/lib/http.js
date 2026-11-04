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
      if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!res.ok) {
        // 405 on a GET is AWS WAF asking for a CAPTCHA; 429 is "too many requests". Both mean back off:
        // no retries here, and the caller pauses the source.
        const e = new Error(`HTTP ${res.status} for ${url}${res.status === 429 ? ' (too many requests)' : ''}`);
        e.status = res.status;
        e.fatal = [401, 403, 404, 405, 429].includes(res.status);
        e.blocked = [403, 405, 429].includes(res.status);
        throw e;
      }
      // AWS WAF bot control answers automated clients with a 202 JavaScript challenge page instead of
      // the data. Report it as blocked; the collector does not try to get around it.
      if (
        res.status === 202 &&
        (res.headers.get('x-amzn-waf-action') || buf.length === 0 || /awsWafCookieDomainList|gokuProps/.test(buf.subarray(0, 4000).toString('utf8')))
      ) {
        const e = new Error(`blocked by the site's bot protection (AWS WAF challenge) at ${new URL(url).host}`);
        e.fatal = true;
        e.blocked = true;
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
