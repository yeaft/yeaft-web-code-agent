/**
 * featureMessageRejectCodes.js — web-side mirror of the stable reject codes
 * emitted by `agent/unify/feature-message.js#FEATURE_MESSAGE_REJECT_CODES`.
 *
 * Kept as its own module so components that key i18n off these codes do
 * not need to import anything agent-side (there are no web/agent code
 * dependencies; the strings are authoritatively mirrored here). A change
 * in the agent-side set MUST be mirrored here in the same PR.
 *
 * Used by `FeatureMessageRejectToast` to look up i18n messages of the form
 * `unify.feature.reject.<code>` (see `web/i18n/en.js` / `zh-CN.js`).
 */

export const FEATURE_MESSAGE_REJECT_CODES = Object.freeze([
  'missing_group_id',
  'missing_feature_id',
  'missing_vp_id',
  'invalid_vp_id',
  'empty_text',
  'text_too_long',
]);

/** True iff `code` is a stable/known reject code. */
export function isKnownRejectCode(code) {
  return typeof code === 'string' && FEATURE_MESSAGE_REJECT_CODES.includes(code);
}

/** i18n key for a reject code; falls back to the `unknown` key. */
export function i18nKeyForRejectCode(code) {
  if (isKnownRejectCode(code)) return `unify.feature.reject.${code}`;
  return 'unify.feature.reject.unknown';
}
