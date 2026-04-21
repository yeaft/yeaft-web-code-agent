/**
 * taskMessageRejectCodes.js — web-side mirror of the 6 stable reject codes
 * emitted by `agent/unify/task-message.js#TASK_MESSAGE_REJECT_CODES`.
 *
 * Kept as its own module so components that key i18n off these codes do
 * not need to import anything agent-side (there are no web/agent code
 * dependencies; the strings are authoritatively mirrored here). A change
 * in the agent-side set MUST be mirrored here in the same PR.
 *
 * Used by `TaskMessageRejectToast` to look up i18n messages of the form
 * `unify.task.reject.<code>` (see `web/i18n/en.js` / `zh-CN.js`).
 */

export const TASK_MESSAGE_REJECT_CODES = Object.freeze([
  'missing_group_id',
  'missing_task_id',
  'missing_vp_id',
  'invalid_vp_id',
  'empty_text',
  'text_too_long',
]);

/** True iff `code` is a stable/known reject code. */
export function isKnownRejectCode(code) {
  return typeof code === 'string' && TASK_MESSAGE_REJECT_CODES.includes(code);
}

/** i18n key for a reject code; falls back to the `unknown` key. */
export function i18nKeyForRejectCode(code) {
  if (isKnownRejectCode(code)) return `unify.task.reject.${code}`;
  return 'unify.task.reject.unknown';
}
