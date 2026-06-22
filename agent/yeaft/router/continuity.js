/**
 * router/continuity.js — DESIGN.md §9.15 priorPlan carry-back.
 *
 * Phase 3b scope:
 *   - `attachRouterPlan(message, plan)` — write the plan as `_meta.routerPlan`
 *     on the assistant message that produced it.
 *   - `extractPriorPlan(messages, vpId)` — find the most recent assistant
 *     message belonging to the given VP and return its `_meta.routerPlan`.
 *   - `stripMetaForWire(messages)` — drop `_meta` before sending to the LLM
 *     (it's bookkeeping, never model-visible).
 *
 * The skip-router heuristic (§9.15 #1) is intentionally NOT implemented in
 * Phase 3b — DESIGN.md §8 line 391 says "do NOT ship the skip-router
 * heuristic yet". We just plumb the metadata; the dispatcher can decide.
 *
 * Per-VP attribution: an assistant message belongs to a VP when its
 * `_meta.routerPlan.vpId` matches; we never guess from content. First turn
 * of a fresh group has no priorPlan — that is the expected cold-start.
 */

/** @typedef {{
 *   vpId: string,
 *   forwardQuery?: { userOriginal?: string, intent?: string },
 *   preselect?: { memoryPaths?: string[], taskIds?: string[] },
 *   thinking?: 'high'|'max'|null,
 *   thinkingReason?: string,
 * }} RouterPlanLike
 */

/**
 * Attach a router plan to an assistant message. Mutates `message` in place
 * and returns it. We mutate (rather than clone) because the caller is the
 * engine appending to its own `conversationMessages` array — cloning would
 * just discard the work.
 *
 * Tool messages do not carry plans (no plan attached to a tool result).
 *
 * @param {object} message
 * @param {RouterPlanLike|null|undefined} plan
 * @returns {object}
 */
export function attachRouterPlan(message, plan) {
  if (!message || typeof message !== 'object') return message;
  if (message.role !== 'assistant') return message;
  if (!plan || typeof plan !== 'object' || !plan.vpId) return message;
  message._meta = message._meta || {};
  message._meta.routerPlan = {
    vpId: plan.vpId,
    forwardQuery: plan.forwardQuery
      ? {
        userOriginal: plan.forwardQuery.userOriginal || '',
        intent: plan.forwardQuery.intent || '',
      } : undefined,
    preselect: plan.preselect
      ? {
        memoryPaths: Array.isArray(plan.preselect.memoryPaths)
          ? [...plan.preselect.memoryPaths] : [],
        taskIds: Array.isArray(plan.preselect.taskIds)
          ? [...plan.preselect.taskIds] : [],
      } : undefined,
    thinking: plan.thinking ?? null,
    thinkingReason: plan.thinkingReason || '',
  };
  return message;
}

/**
 * Walk `messages` from the end, return the most recent assistant message's
 * `_meta.routerPlan` whose `vpId` matches. Returns null if none found —
 * that's a cold start, not an error.
 *
 * @param {object[]} messages
 * @param {string} vpId
 * @returns {RouterPlanLike | null}
 */
export function extractPriorPlan(messages, vpId) {
  if (!Array.isArray(messages) || !vpId) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || m.role !== 'assistant') continue;
    const plan = m._meta && m._meta.routerPlan;
    if (plan && plan.vpId === vpId) return plan;
  }
  return null;
}

/**
 * Return a copy of the messages array with engine-private metadata stripped
 * from every message. The serialisers (anthropic/openai-responses) read this;
 * these fields are NEVER part of the wire payload. Cheap because we only
 * shallow-clone the messages that actually have private fields.
 *
 * @param {object[]} messages
 * @returns {object[]}
 */
export function stripMetaForWire(messages) {
  if (!Array.isArray(messages)) return messages;
  let mutated = false;
  const out = messages.map(m => {
    if (m && typeof m === 'object'
        && ('_meta' in m || '_runtimeTurnId' in m || '_partialTurn' in m)) {
      mutated = true;
      const { _meta, _runtimeTurnId, _partialTurn, ...rest } = m;
      return rest;
    }
    return m;
  });
  return mutated ? out : messages;
}
