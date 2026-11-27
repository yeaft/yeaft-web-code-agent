import { resolveHttpUrl } from './rss-parser.js';
import { safeFetch } from './safe-fetch.js';

const maxBytes = 6 * 1024 ** 2;
const maxEntries = 48;
const maxCacheBytes = 24 * 1024 ** 2;
const ttl = 30 * 60_000;
const failure = (status, message) => Object.assign(new Error(message), { status });
const allow = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']);
const headers = Object.freeze({
  'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
  accept: 'image/avif,image/webp,image/gif,image/png,image/jpeg,*/*;q=0.5',
});

export function toProxyMediaUrl(rawUrl) {
  return resolveHttpUrl(rawUrl) ? `/api/cosmic-web/media-proxy?url=${encodeURIComponent(rawUrl)}` : null;
}

function sniff(bytes) {
  if (!Buffer.isBuffer(bytes)) return null;
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  const first = bytes.toString('latin1', 0, 12);
  if (/^GIF(?:87|89)a/.test(first)) return 'image/gif';
  if (first.startsWith('RIFF') && first.slice(8) === 'WEBP') return 'image/webp';
  if (['ftypavif', 'ftypavis'].includes(first.slice(4))) return 'image/avif';
  return null;
}

/** Fetch buffered bytes under strict limits; callers must not forward inbound headers. */
export function createMediaProxy({ fetcher = safeFetch, dnsLookup, now = Date.now } = {}) {
  const cache = new Map(), inflight = new Map();
  let size = 0;
  const drop = key => { size -= cache.get(key).value.body.length; cache.delete(key); };
  return async function proxyMedia(rawUrl) {
    const valid = resolveHttpUrl(rawUrl);
    if (!valid) throw failure(400, 'Expected an HTTP(S) image URL');
    const target = new URL(valid);
    target.hash = '';
    const key = target.href;
    for (const [url, entry] of cache) if (entry.expires <= now()) drop(url);
    const hit = cache.get(key);
    if (hit) { cache.delete(key); cache.set(key, hit); return hit.value; }
    if (inflight.has(key)) return inflight.get(key);
    if (inflight.size >= 6) throw failure(429, 'Too many active image requests');
    const task = Promise.resolve().then(async () => {
      let response;
      try {
        response = await fetcher(key, { dnsLookup, headers, timeoutMs: 8000, maxBytes, maxDecompressedBytes: maxBytes });
      } catch {
        throw failure(502, 'Image unavailable');
      }
      if (response.status < 200 || response.status >= 300) throw failure(502, 'Image unavailable');
      const mime = String(response.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      const body = response.bodyBuffer;
      if (!allow.has(mime) || sniff(body) !== mime || body.length > maxBytes) throw failure(415, 'Unsupported image format');
      const value = { body, headers: { 'Content-Type': mime, 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, max-age=3600',
        'Cross-Origin-Resource-Policy': 'same-origin' } };
      cache.set(key, { value, expires: now() + ttl });
      size += body.length;
      while (cache.size > maxEntries || size > maxCacheBytes) drop(cache.keys().next().value);
      return value;
    }).finally(() => inflight.delete(key));
    inflight.set(key, task);
    return task;
  };
}

export const proxyMedia = createMediaProxy();
