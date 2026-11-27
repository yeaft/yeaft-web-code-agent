import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { CONFIG } from '../config.js';
import { resolveHttpUrl } from './rss-parser.js';
import { safeFetch } from './safe-fetch.js';

const maxBytes = 6 * 1024 ** 2;
const maxEntries = 48;
const maxCacheBytes = 24 * 1024 ** 2;
const ttl = 30 * 60_000;
const tokenTtlSec = 2 * 3600;
const maxGlobalInflight = 8;
const maxUserInflight = 2;
const maxUserRatePerMin = 60;
const failure = (status, message) => Object.assign(new Error(message), { status });
const allow = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']);
const headers = Object.freeze({
  'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
  accept: 'image/avif,image/webp,image/gif,image/png,image/jpeg,*/*;q=0.5',
});

const fallbackSecret = randomBytes(32).toString('hex');
function signingKey() {
  const base = CONFIG?.jwtSecret || fallbackSecret;
  return `cw-media-proxy-v1:${base}`;
}

function canonicalMediaUrl(rawUrl) {
  const valid = resolveHttpUrl(rawUrl);
  if (!valid) return null;
  const target = new URL(valid);
  target.hash = '';
  return target.href;
}

function computeSignature(userId, canonicalUrl, exp) {
  return createHmac('sha256', signingKey())
    .update(`${userId}\n${canonicalUrl}\n${exp}`)
    .digest('base64url');
}

export function verifyMediaProxySignature({ rawUrl, userId, exp, sig, now = Date.now() } = {}) {
  if (!userId || typeof userId !== 'string') return false;
  const canonicalUrl = canonicalMediaUrl(rawUrl);
  if (!canonicalUrl) return false;
  const expNum = Number.parseInt(String(exp ?? ''), 10);
  if (!Number.isSafeInteger(expNum) || expNum < Math.floor(now / 1000)) return false;
  if (typeof sig !== 'string' || !sig || sig.length > 128) return false;
  const expected = Buffer.from(computeSignature(userId, canonicalUrl, expNum));
  const actual = Buffer.from(sig);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Build a root-relative media proxy URL. When `userId` is supplied, mints an
 * expiring HMAC-SHA256 signature scoped strictly to `(userId, normalizedUrl)`.
 */
export function toProxyMediaUrl(rawUrl, userId = null, now = Date.now()) {
  const canonicalUrl = canonicalMediaUrl(rawUrl);
  if (!canonicalUrl) return null;
  const base = `/api/cosmic-web/media-proxy?url=${encodeURIComponent(canonicalUrl)}`;
  if (!userId) return base;
  const exp = Math.floor(now / 1000) + tokenTtlSec;
  const sig = computeSignature(userId, canonicalUrl, exp);
  return `${base}&exp=${exp}&sig=${encodeURIComponent(sig)}`;
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
export function createMediaProxy({ fetcher = safeFetch, dnsLookup, now = Date.now, requireSigned = false } = {}) {
  const cache = new Map(), inflight = new Map();
  const userInflight = new Map();
  const userRate = new Map();
  let size = 0;
  const drop = key => { size -= cache.get(key).value.body.length; cache.delete(key); };
  return async function proxyMedia(rawUrl, options = {}) {
    const { userId = null, exp = null, sig = null, signal } = options || {};
    const mustVerify = options?.requireSigned ?? requireSigned;
    const key = canonicalMediaUrl(rawUrl);
    if (!key) throw failure(400, 'Expected an HTTP(S) image URL');
    if (mustVerify && !verifyMediaProxySignature({ rawUrl: key, userId, exp, sig, now: now() })) {
      throw failure(403, 'Invalid or expired media reference');
    }
    const currentNow = now();
    for (const [url, entry] of cache) if (entry.expires <= currentNow) drop(url);
    const hit = cache.get(key);
    if (hit) { cache.delete(key); cache.set(key, hit); return hit.value; }
    if (inflight.has(key)) return inflight.get(key);

    const ownerKey = userId || '__anon__';
    // Per-user rate limit on uncached outbound fetches
    const windowStart = currentNow - 60_000;
    for (const [uid, times] of userRate) {
      if (!times.length || times.at(-1) <= windowStart) userRate.delete(uid);
    }
    const recent = (userRate.get(ownerKey) ?? []).filter(t => t > windowStart);
    if (recent.length >= maxUserRatePerMin) throw failure(429, 'Media request rate limit reached');

    const activeForUser = userInflight.get(ownerKey) ?? 0;
    if (activeForUser >= maxUserInflight) throw failure(429, 'Too many active image requests for this user');
    if (inflight.size >= maxGlobalInflight) throw failure(429, 'Too many active image requests');

    userRate.set(ownerKey, [...recent, currentNow]);
    userInflight.set(ownerKey, activeForUser + 1);
    const task = Promise.resolve().then(async () => {
      let response;
      try {
        response = await fetcher(key, {
          dnsLookup,
          headers,
          signal,
          timeoutMs: 8000,
          maxBytes,
          maxDecompressedBytes: maxBytes,
          checkHeaders(status, respHeaders) {
            if (status < 200 || status >= 300) throw failure(502, 'Image unavailable');
            const declaredLen = Number(respHeaders?.['content-length']);
            if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
              throw failure(415, 'Unsupported image format');
            }
            const rawMime = String(respHeaders?.['content-type'] ?? '').split(';')[0].trim().toLowerCase();
            if (rawMime && !allow.has(rawMime)) {
              throw failure(415, 'Unsupported image format');
            }
          },
        });
      } catch (err) {
        if (err?.status === 415 || err?.status === 502) throw err;
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
    }).finally(() => {
      inflight.delete(key);
      const cur = (userInflight.get(ownerKey) ?? 1) - 1;
      if (cur <= 0) userInflight.delete(ownerKey);
      else userInflight.set(ownerKey, cur);
    });
    inflight.set(key, task);
    return task;
  };
}

export const proxyMedia = createMediaProxy({ requireSigned: true });
