/**
 * vp-id-validator.js — Client-side mirror of agent/unify/groups/ids.js
 * validateVpId.
 *
 * Task-334-ui-g: we need synchronous onBlur validation in the form without
 * a WS round-trip. Keeping a small mirror module with IDENTICAL rule set
 * (6 reasons — empty_or_non_string / too_long / illegal_character /
 * underscore_prefix_reserved / pure_digits / reserved) is cheaper than
 * streaming a debounced request for every keystroke.
 *
 * CONTRACT: this file must stay in sync with ids.js's validateVpId. If the
 * backend rule set changes, update both. Tests (test/web/vp-crud-ui.test.js)
 * assert the two return the same {ok, reason} for every canonical input.
 */

const VP_ID_RE = /^[A-Za-z0-9_-]+$/;
const PURE_DIGITS_RE = /^[0-9]+$/;
const VP_ID_MAX_LEN = 40;
const RESERVED = ['all', 'user', 'system', 'everyone'];

/**
 * @param {string} id
 * @returns {{ok:true}|{ok:false, reason:string}}
 */
export function validateVpId(id) {
  if (!id || typeof id !== 'string') {
    return { ok: false, reason: 'empty_or_non_string' };
  }
  if (id.length > VP_ID_MAX_LEN) return { ok: false, reason: 'too_long' };
  if (!VP_ID_RE.test(id)) return { ok: false, reason: 'illegal_character' };
  if (id.startsWith('_')) return { ok: false, reason: 'underscore_prefix_reserved' };
  if (PURE_DIGITS_RE.test(id)) return { ok: false, reason: 'pure_digits' };
  if (RESERVED.includes(id.toLowerCase())) return { ok: false, reason: 'reserved' };
  return { ok: true };
}

/** Convenience boolean wrapper. */
export function isValidVpId(id) {
  return validateVpId(id).ok;
}

/**
 * N4 mapping table — reason enum → i18n key. Consumed by VpCrudModal.
 * Keeping the mapping here (not inlined in the component) so tests can
 * round-trip every reason without rendering a Vue component.
 */
export const REASON_I18N_KEY = Object.freeze({
  empty_or_non_string: 'unify.vp.idError.empty_or_non_string',
  too_long: 'unify.vp.idError.too_long',
  illegal_character: 'unify.vp.idError.illegal_character',
  underscore_prefix_reserved: 'unify.vp.idError.underscore_prefix_reserved',
  pure_digits: 'unify.vp.idError.pure_digits',
  reserved: 'unify.vp.idError.reserved',
  // Backend-only codes surfaced by vp-crud.js.
  duplicate: 'unify.vp.idError.duplicate',
});

/** Return the i18n key for a reason, or the reason itself as a fallback. */
export function i18nKeyForReason(reason) {
  return REASON_I18N_KEY[reason] || reason;
}
