/**
 * ids.js — ID generators for the groups slice.
 *
 * Per slice-spec §4 (ID format): sessionId uses a slug, msgId uses ULID-ish
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

export function nextSessionId(slug = 'default') {
  // Slug-tolerant: lowercase a-z0-9_- only, capped at 24 chars so the
  // total id stays compact after the suffix is appended.
  const safe = String(slug).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 24) || 'session';
  // Append 8 crockford-base32 chars (~40 bits) so re-creating a session
  // with the same display name yields a fresh id instead of throwing
  // `duplicate` on the existsSync check in session-crud.js. The
  // `duplicate` branch is now a true defensive guard rather than the
  // first-collision footgun it used to be.
  return `session_${safe}_${randEncoded(8)}`;
}

/**
 * Reserved vpIds that must never be used as actual VP identifiers — they
 * collide with coordinator-level sentinels (`@all` broadcast, `user`/`system`
 * sender roles) and would cause silent footguns (a vpId=`all` VP would be
 * absorbed into broadcast). Enforced at CRUD boundaries (addVp, createSession).
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

/**
 * Character + shape whitelist for a user-facing vpId. Stricter than
 * `parseMentions` (Postel's law: be lenient on input, be strict on storage).
 *
 * Rules (task-334d, absorbing 334b follow-up #1):
 *   - Must be a non-empty string
 *   - Length 1..40
 *   - Characters: `[A-Za-z0-9_-]` only
 *   - Must NOT start with `_` (underscore reserved for future system roles)
 *   - Must NOT be purely digits
 *   - Must NOT be a reserved vpId (delegates to isReservedVpId)
 *
 * Returns `{ ok, reason? }`. The callsites that want a boolean use
 * `isValidVpId(id)` (truthy only when ok). Error strings are stable so UI
 * can key on them for i18n (prev-1 nit: UX-friendly messages come later;
 * this layer exposes raw reasons).
 */
const VP_ID_RE = /^[A-Za-z0-9_-]+$/;
const PURE_DIGITS_RE = /^[0-9]+$/;
const VP_ID_MAX_LEN = 40;

export function validateVpId(id) {
  if (!id || typeof id !== 'string') {
    return { ok: false, reason: 'empty_or_non_string' };
  }
  if (id.length > VP_ID_MAX_LEN) {
    return { ok: false, reason: 'too_long' };
  }
  if (!VP_ID_RE.test(id)) {
    return { ok: false, reason: 'illegal_character' };
  }
  if (id.startsWith('_')) {
    return { ok: false, reason: 'underscore_prefix_reserved' };
  }
  if (PURE_DIGITS_RE.test(id)) {
    return { ok: false, reason: 'pure_digits' };
  }
  if (isReservedVpId(id)) {
    return { ok: false, reason: 'reserved' };
  }
  return { ok: true };
}

/** Convenience boolean wrapper for call-sites that don't care about the reason. */
export function isValidVpId(id) {
  return validateVpId(id).ok;
}

/** Thrown by CRUD entry points on an invalid (non-reserved) vpId shape. */
export class InvalidVpIdError extends Error {
  constructor(vpId, reason) {
    super(`vpId "${vpId}" is invalid (${reason})`);
    this.name = 'InvalidVpIdError';
    this.vpId = vpId;
    this.reason = reason;
  }
}
