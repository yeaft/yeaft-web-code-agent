/**
 * feature-fold.js — PR-2 of the feature-pill double-track redesign.
 *
 * Pure helpers consumed by MessageList.turnGroups for:
 *
 *   1. featureIdOfTurn(item)  — extract the featureId carried by a turn-list
 *      item, returning null when the item is non-foldable or carries no
 *      featureId.
 *   2. foldByFeatureId(items) — collapse runs of consecutive items that share
 *      a featureId into single `feature-pill` items.
 *   3. injectQuickPreviews(items, previewMap) — insert `quick-preview` marker
 *      items immediately before the assistant-turn whose vpId+turnId matches
 *      a stored preview.
 *
 * These functions stay in a separate module (rather than as nested closures
 * inside MessageList.js) so they can be tested without spinning up a full
 * Vue / Pinia tree. The MessageList computed thinly wraps them.
 *
 * Item shape (input):
 *   - { type: 'user' | 'system' | 'error', id, message }            — never folded
 *   - { type: 'feature-message', id, message: { featureId, ... } }  — foldable
 *   - { type: 'assistant-turn', id, messages: Msg[], speakerVpId, turnId, ... }
 *       — foldable; featureId is read from any inner messages[i].featureId
 *
 * Item shape (output additions):
 *   - { type: 'feature-pill', id, featureId, turns: Item[] }
 *   - { type: 'quick-preview', id, preview, forVpId, forTurnId }
 */

/**
 * @param {object} item — one row from MessageList's pre-fold result array
 * @returns {string|null}
 */
export function featureIdOfTurn(item) {
  if (!item) return null;
  if (item.type === 'feature-message') {
    return (item.message && item.message.featureId) || null;
  }
  if (item.type === 'assistant-turn') {
    const msgs = item.messages || [];
    for (const m of msgs) {
      if (m && m.featureId) return m.featureId;
    }
    return null;
  }
  return null;
}

/**
 * Returns true if an item is the kind that can be folded into a pill.
 * (Used so non-feature rows like users / system / quick-preview break a run.)
 * @param {object} item
 */
export function isFoldable(item) {
  if (!item) return false;
  return item.type === 'assistant-turn' || item.type === 'feature-message';
}

/**
 * Walk `items` and merge consecutive foldable rows that share a non-empty
 * featureId. Items without a featureId — including user / system rows AND
 * untagged assistant turns — pass through unchanged and break the run.
 *
 * @param {Array<object>} items
 * @returns {Array<object>}
 */
export function foldByFeatureId(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  let pendingFeatureId = null;
  let pendingTurns = null;
  const flushPending = () => {
    if (pendingFeatureId && pendingTurns && pendingTurns.length > 0) {
      out.push({
        type: 'feature-pill',
        id: 'feature_' + pendingFeatureId,
        featureId: pendingFeatureId,
        turns: pendingTurns,
      });
    }
    pendingFeatureId = null;
    pendingTurns = null;
  };
  for (const item of items) {
    const fid = isFoldable(item) ? featureIdOfTurn(item) : null;
    if (fid) {
      if (pendingFeatureId === fid) {
        pendingTurns.push(item);
      } else {
        flushPending();
        pendingFeatureId = fid;
        pendingTurns = [item];
      }
    } else {
      flushPending();
      out.push(item);
    }
  }
  flushPending();
  return out;
}

/**
 * Insert a `quick-preview` marker immediately before each assistant-turn
 * whose `vpId:turnId` matches a key in `previewMap`. Each preview is
 * consumed at most once so re-runs of the same VP on a new turn don't
 * produce phantom bubbles for stale previews.
 *
 * @param {Array<object>} items
 * @param {Object<string, {vpId, turnId, intent, preview, ts}>} previewMap
 * @returns {Array<object>}
 */
export function injectQuickPreviews(items, previewMap) {
  if (!Array.isArray(items)) return [];
  const map = previewMap || {};
  const used = new Set();
  const out = [];
  for (const item of items) {
    if (item && item.type === 'assistant-turn' && item.speakerVpId && item.turnId) {
      const key = item.speakerVpId + ':' + item.turnId;
      const preview = map[key];
      if (preview && !used.has(key)) {
        used.add(key);
        out.push({
          type: 'quick-preview',
          id: 'qp_' + key,
          preview,
          forVpId: item.speakerVpId,
          forTurnId: item.turnId,
        });
      }
    }
    out.push(item);
  }
  return out;
}
