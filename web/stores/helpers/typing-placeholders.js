/**
 * typing-placeholders.js — pure helper for `MessageList.turnGroups`.
 *
 * Synthesises a placeholder assistant-turn for every VP that is currently
 * marked typing but has no turn in the result tail. AssistantTurn renders
 * just the speaker header (with the typing badge on the avatar) when the
 * body is empty, so the visual matches a freshly-streaming turn with no
 * tokens yet — the avatar is visible from the moment `vp_typing_start`
 * fires until the first chunk lands.
 *
 * The helper is pure so it can be tested without spinning up Vue / Pinia.
 * MessageList.js calls it as the last step of the turn-aggregation
 * pipeline (after finishTurn — the now-deleted Track-A
 * injectQuickPreviews / foldByFeatureId stage was removed in the
 * VP-block redesign).
 *
 * **The bug this guards against** (PR #720): the previous predicate was
 * `r.isStreaming && r.speakerVpId`. Only `type==='assistant'` deltas flip
 * `isStreaming`, so a turn that OPENS with a tool_call (no preceding
 * text-delta) was `isStreaming: false` — and the placeholder was
 * synthesised AFTER the tool-bearing turn → duplicate avatar block below
 * the tools. The current predicate is the broader "any speakerVpId in
 * the tail run covers that VP".
 *
 * @param {Array<object>} items
 *   Pre-built turn-list (output of the inline aggregator). Items in the
 *   tail run are scanned for already-covered VPs.
 * @param {Array<string>} typingVpIds
 *   VPs currently flagged as typing in the active conversation.
 * @param {Object<string, string|null>} [activeFeatureByVp]
 *   Optional VP→featureId map. When set, the placeholder inherits the
 *   featureId so it doesn't break an in-flight feature run during the
 *   typing gap.
 * @returns {Array<object>}
 *   The same items array with placeholder turns appended for any typing
 *   VP that has no turn in the tail run.
 */
export function appendTypingPlaceholders(items, typingVpIds, activeFeatureByVp) {
  if (!Array.isArray(items)) return [];
  if (!Array.isArray(typingVpIds) || typingVpIds.length === 0) return items;

  // Walk the tail run of assistant-turns, stopping at the first
  // non-assistant row (user / system / feature). Same-VP runs further
  // back already have their own non-collapsed turn — only the tail run
  // can produce the orphan-placeholder bug.
  const coveredVps = new Set();
  for (let i = items.length - 1; i >= 0; i--) {
    const r = items[i];
    if (!r) continue;
    if (r.type !== 'assistant-turn') break;
    if (r.speakerVpId) coveredVps.add(r.speakerVpId);
  }

  const featureMap = activeFeatureByVp || {};
  for (const vpId of typingVpIds) {
    if (coveredVps.has(vpId)) continue;
    items.push({
      type: 'assistant-turn',
      id: 'turn_typing_' + vpId,
      textContent: '',
      isStreaming: true,
      todoMsg: null,
      toolMsgs: [],
      imageMsgs: [],
      askMsg: null,
      messages: [],
      atMessageId: null,
      speakerVpId: vpId,
      speakerTimestamp: 0,
      speakerStateCause: '',
      showSpeakerHeader: true,
      turnId: null,
      featureId: featureMap[vpId] || null,
      intent: 'quick',
    });
  }
  return items;
}
