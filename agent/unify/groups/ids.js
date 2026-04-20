/**
 * ids.js — ID generators for the groups slice.
 *
 * Per slice-spec §4 (ID format): groupId uses a slug, msgId uses ULID-ish
 * lexicographic-sortable form. We implement a small crockford-base32 timestamp
 * + randomness scheme that works cross-platform without external deps.
 */

import { randomBytes } from 'crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encode(num, len) {
  let n = BigInt(num);
  const out = [];
  for (let i = 0; i < len; i++) {
    out.unshift(CROCKFORD[Number(n & 31n)]);
    n >>= 5n;
  }
  return out.join('');
}

function randEncoded(len) {
  const bytes = randomBytes(Math.ceil(len * 5 / 8));
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return encode(n, len);
}

/** Monotonic ULID-lite (10 time chars + 16 random chars). */
export function newUlidLite() {
  const time = encode(Date.now(), 10);
  return `${time}${randEncoded(16)}`;
}

export function nextMsgId() {
  return `msg_${newUlidLite()}`;
}

export function nextGroupId(slug = 'default') {
  // Slug-tolerant: lowercase a-z0-9_- only.
  const safe = String(slug).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 32) || 'group';
  return `grp_${safe}`;
}
