/**
 * roster.js — Pure roster mutation/query helpers.
 *
 * Roster = `string[]` of vpIds. `defaultVpId` is stored alongside on the
 * group meta; helpers keep both in sync:
 *   - addVp: appends if absent; preserves order.
 *   - removeVp: drops and clears defaultVpId if it matched; falls back to
 *     the first remaining entry by join order (§ D2 Fallback, G2 in arch).
 *   - setDefaultVp: validates membership; throws on stranger.
 *
 * Emits no events directly — callers (group-store/coordinator) persist meta
 * and optionally notify listeners.
 */

import { isReservedVpId, ReservedVpIdError, validateVpId, InvalidVpIdError } from './ids.js';

/** Returns a cloned roster array with `vpId` appended if not already present. */
export function addVp(meta, vpId) {
  if (!vpId || typeof vpId !== 'string') {
    throw new Error('addVp: vpId required (string)');
  }
  if (isReservedVpId(vpId)) {
    throw new ReservedVpIdError(vpId);
  }
  const verdict = validateVpId(vpId);
  if (!verdict.ok) {
    throw new InvalidVpIdError(vpId, verdict.reason);
  }
  const roster = meta.roster.slice();
  if (!roster.includes(vpId)) roster.push(vpId);
  const defaultVpId = meta.defaultVpId || roster[0] || null;
  return { ...meta, roster, defaultVpId };
}

/** Remove a vpId. If it was default, pick the next join-order member. */
export function removeVp(meta, vpId) {
  const roster = meta.roster.filter((v) => v !== vpId);
  let defaultVpId = meta.defaultVpId;
  if (defaultVpId === vpId) {
    defaultVpId = roster[0] || null;
  }
  return { ...meta, roster, defaultVpId };
}

/** Set default; throws if the vp is not in roster. */
export function setDefaultVp(meta, vpId) {
  if (!meta.roster.includes(vpId)) {
    throw new Error(`setDefaultVp: ${vpId} not in roster`);
  }
  return { ...meta, defaultVpId: vpId };
}

/** True iff vpId is a roster member. */
export function isMember(meta, vpId) {
  return meta.roster.includes(vpId);
}

/**
 * Resolve which VP should answer a message with no explicit @-mention.
 * Per architecture G2: defaultVpId if set, else roster[0], else null.
 */
export function resolveFallbackVp(meta) {
  return meta.defaultVpId || meta.roster[0] || null;
}
