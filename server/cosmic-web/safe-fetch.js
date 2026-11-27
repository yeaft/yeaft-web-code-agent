import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { gunzip, inflate, brotliDecompress } from 'node:zlib';
import { promisify } from 'node:util';

const deny = new BlockList();
for (const [ip, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3],
]) deny.addSubnet(ip, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [ip, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) {
  deny.addSubnet(ip, prefix, 'ipv6');
}
const decoders = new Map(Object.entries({ gzip: gunzip, deflate: inflate, br: brotliDecompress })
  .map(([name, fn]) => [name, promisify(fn)]));
const redirects = new Set([301, 302, 303, 307, 308]);

function deadline(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function abortable(signal, fn) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(fn).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Validate all DNS answers; never let the socket independently resolve the name. */
export async function validateExternalUrl(value, { dnsLookup = lookup, signal, timeoutMs = 10_000 } = {}) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Expected an HTTP(S) URL without credentials');
  }
  url.hash = '';
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literal = isIP(hostname);
  const active = deadline(signal, timeoutMs);
  active.throwIfAborted();
  const records = literal ? [{ address: hostname }] : await abortable(active, () => dnsLookup(hostname, { all: true }));
  if (!Array.isArray(records) || !records.length) throw new Error('External host did not resolve');
  for (const { address } of records) {
    const family = isIP(address);
    if (!(family === 4 && !deny.check(address, 'ipv4')) &&
        !(family === 6 && !address.includes('%') && globalV6.check(address, 'ipv6') && !deny.check(address, 'ipv6'))) {
      throw new Error('External URL resolves to a private or reserved network');
    }
  }
  return { url, hostname, address: records[0].address, family: isIP(records[0].address) };
}

function requestOnce(target, { signal, headers, method, body, requestImpl }) {
  const { url, hostname, address, family } = target;
  const request = requestImpl ?? (url.protocol === 'https:' ? httpsRequest : httpRequest);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const req = request(url, {
      signal, method, headers, agent: false, autoSelectFamily: false,
      ...(url.protocol === 'https:' && !isIP(hostname) ? { servername: hostname } : {}),
      lookup: (_name, opts, cb) => opts.all ? cb(null, [{ address, family }]) : cb(null, address, family),
    }, response => {
      if (signal.aborted) { response.destroy(); reject(signal.reason); } else resolve(response);
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function readBounded(response, limit) {
  if (Number(response.headers['content-length']) > limit) {
    response.destroy();
    throw new Error('External response exceeds byte limit');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of response) {
    size += chunk.length;
    if (size > limit) throw new Error('External response exceeds byte limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

export async function safeFetch(value, {
  signal, dnsLookup, requestImpl, timeoutMs = 10_000, maxBytes = 2 * 1024 ** 2,
  maxDecompressedBytes = 4 * 1024 ** 2, headers = {}, method = 'GET', body, checkHeaders,
} = {}) {
  const active = deadline(signal, timeoutMs);
  let targetUrl = value;
  for (let count = 0; ; count++) {
    const target = await validateExternalUrl(targetUrl, { dnsLookup, signal: active, timeoutMs });
    const response = await requestOnce(target, { signal: active, requestImpl, method, body, headers: {
      'user-agent': 'Yeaft Cosmic Web/1.0', 'accept-encoding': 'gzip, deflate, br', ...headers,
    } });
    const status = response.statusCode;
    if (redirects.has(status) && response.headers.location) {
      response.destroy();
      if (count === 5) throw new Error('External redirect limit exceeded');
      targetUrl = new URL(response.headers.location, target.url);
      // Do not forward source-specific headers or a POST body to another origin.
      if (targetUrl.origin !== target.url.origin) {
        headers = {};
        method = 'GET';
        body = undefined;
      } else if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
        headers = Object.fromEntries(Object.entries(headers).filter(([key]) => !/^content-/i.test(key)));
        method = 'GET';
        body = undefined;
      }
      continue;
    }
    if (typeof checkHeaders === 'function') {
      try {
        checkHeaders(status, response.headers);
      } catch (err) {
        response.destroy();
        throw err;
      }
    }
    let bodyBuffer = await abortable(active, () => readBounded(response, maxBytes)).finally(() => response.destroy());
    const encoding = String(response.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
    if (encoding !== 'identity' && bodyBuffer.length) {
      const decode = decoders.get(encoding);
      if (!decode) throw new Error('Unsupported external content encoding');
      bodyBuffer = await abortable(active, () => decode(bodyBuffer, { maxOutputLength: maxDecompressedBytes }));
    }
    if (bodyBuffer.length > maxDecompressedBytes) throw new Error('External response exceeds decoded byte limit');
    const text = () => bodyBuffer.toString('utf8');
    return { status, headers: response.headers, url: target.url.href, bodyBuffer, text, json: () => JSON.parse(text()) };
  }
}
