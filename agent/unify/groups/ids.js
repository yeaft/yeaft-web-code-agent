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

/**
 * Reserved vpIds that must never be used as actual VP identifiers — they
 * collide with coordinator-level sentinels (`@all` broadcast, `user`/`system`
 * sender roles) and would cause silent footguns (a vpId=`all` VP would be
 * absorbed into broadcast). Enforced at CRUD boundaries (addVp, createGroup).
 *
 * prev-1 nit #4 (blocker-fix): @foo/@all/@user are the mental bedrock of all
 * future UI — protecting the names here prevents dirty data from reaching the
 * Engine and requiring a migration slice later.
 */
export const RESERVED_VP_IDS = Object.freeze(['all', 'user', 'system', 'everyone']);

/** True iff `id` (case-insensitive) is a reserved vp identifier. */
export function isReservedVpId(id) {
  if (!id || typeof id !== 'string') return false;
  return RESERVED_VP_IDS.includes(id.toLowerCase());
}

/** Thrown by CRUD entry points when a reserved vpId is supplied. */
export class ReservedVpIdError extends Error {
  constructor(vpId) {
    super(`vpId "${vpId}" is reserved (${RESERVED_VP_IDS.join(', ')})`);
    this.name = 'ReservedVpIdError';
    this.vpId = vpId;
  }
}
