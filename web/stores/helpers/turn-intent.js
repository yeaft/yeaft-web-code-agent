/**
 * turn-intent.js — Pure helper for the VP-card-vs-AssistantTurn render
 * branch in MessageList.
 *
 * The web store keeps a `unifyQuickPreviews` map keyed by `${vpId}:${turnId}`
 * with shape `{ vpId, turnId, intent, preview, ts, ... }`. Track-A populates
 * the entry shortly after a VP turn starts; if Track-A fails or is still
 * pending, no entry exists and we fall back to `'quick'` (= render the turn
 * inline with the existing AssistantTurn — see design doc 2026-05-07 §
 * "Track-A 失败 fallback").
 *
 * @param {object|null} turn — turnGroups item with `speakerVpId` + `turnId`
 * @param {object|null} previewMap — `store.unifyQuickPreviews`
 * @returns {'quick'|'feature'}
 */
export function deriveTurnIntent(turn, previewMap) {
  if (!turn || !turn.speakerVpId || !turn.turnId) return 'quick';
  const map = previewMap || {};
  const entry = map[turn.speakerVpId + ':' + turn.turnId];
  if (!entry) return 'quick';
  return entry.intent === 'feature' ? 'feature' : 'quick';
}
