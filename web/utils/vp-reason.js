/**
 * vp-reason.js — task-334-ui-c (O4 follow-up from 334h).
 *
 * Pure helpers that translate the agent-side live-diff `reason` classifier
 * tag (`persona.edit` / `traits.edit` / `manual.reload` / `file.removed`)
 * into an i18n key the UI can `$t()`. Keeping the map pure so both the
 * toast path and the detail-view activity row can share it.
 *
 * Ruling (334h prev-1 O4): snake_case classifier tags MUST NOT leak to the
 * user. Unknown reasons fall back to `manual.reload` to stay graceful —
 * future tags added on the agent side will display as "Reloaded" until
 * this map catches up (logged once to console for diagnosis).
 */

/** @type {Readonly<Record<string,string>>} */
export const REASON_I18N = Object.freeze({
  'persona.edit': 'yeaft.vp.reason.personaEdit',
  'traits.edit': 'yeaft.vp.reason.traitsEdit',
  'manual.reload': 'yeaft.vp.reason.manualReload',
  'file.removed': 'yeaft.vp.reason.fileRemoved',
});

const FALLBACK_KEY = REASON_I18N['manual.reload'];

/** Dev-only diagnostic: warn at most once per unknown tag so the console
 *  doesn't flood if the agent ships a new reason we haven't mapped yet. */
const _warned = new Set();

/**
 * Translate an agent-side reason tag to an i18n key. Pure.
 *
 * @param {string|null|undefined} reason
 * @returns {string} i18n key (always a known key — never undefined)
 */
export function reasonToI18nKey(reason) {
  if (!reason) return FALLBACK_KEY;
  const key = REASON_I18N[reason];
  if (key) return key;
  if (!_warned.has(reason)) {
    _warned.add(reason);
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[vp-reason] unknown live-diff reason tag:', reason);
    }
  }
  return FALLBACK_KEY;
}

/**
 * Is this reason a "removal" event? Used by the toast path to pick the
 * correct template (`toast.removed` vs `toast.updated`).
 * @param {string|null|undefined} reason
 */
export function isRemovalReason(reason) {
  return reason === 'file.removed';
}

/**
 * @internal Test seam — reset the warn-once cache so tests can exercise
 * the warning path deterministically.
 */
export function _resetReasonWarnCacheForTest() {
  _warned.clear();
}
