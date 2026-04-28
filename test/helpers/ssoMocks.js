/**
 * Test helpers for multi-provider SSO.
 *
 * `mockFetch(routeMap)` installs a global fetch stub that responds based on
 * exact URL prefix matches. Each route's value can be either:
 *   - { ok: true, json: <obj>, status?: 200 }   — JSON response
 *   - { ok: false, status: 4xx, body?: 'text' } — error response
 *   - a function (req) => <response shape above>
 */

let _originalFetch = null;
const _matchers = [];

export function mockFetch(routeMap) {
  if (!_originalFetch) _originalFetch = globalThis.fetch;
  for (const [pattern, response] of Object.entries(routeMap)) {
    _matchers.push({ pattern, response });
  }
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    // Prefer the longest matching prefix so e.g. '/user/emails' wins over '/user'.
    const candidates = _matchers
      .filter(({ pattern }) => u.startsWith(pattern))
      .sort((a, b) => b.pattern.length - a.pattern.length);
    const m = candidates[0];
    if (!m) {
      throw new Error(`mockFetch: no route for ${u}`);
    }
    const r = typeof m.response === 'function' ? m.response({ url: u, init }) : m.response;
    return {
      ok: r.ok !== false,
      status: r.status || (r.ok === false ? 500 : 200),
      json: async () => r.json !== undefined ? r.json : {},
      text: async () => r.body !== undefined ? r.body : (r.json !== undefined ? JSON.stringify(r.json) : '')
    };
  };
}

export function restoreFetch() {
  if (_originalFetch) globalThis.fetch = _originalFetch;
  _originalFetch = null;
  _matchers.length = 0;
}

/**
 * Build a fake Google id_token JWT (header.payload.sig) — payload is base64url-
 * encoded so providers/google.js can decode it without verifying the signature.
 */
export function fakeIdToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fake-signature`;
}
