/**
 * pair-sanitize.js — Drop tool_use / tool_result orphans from a message
 * slice so it can be safely fed to the LLM adapter.
 *
 * Why this exists:
 *   `agent/unify/conversation/persist.js#loadRecentByGroup` and
 *   `agent/unify/history-compact.js#compactHistory` both produce
 *   sub-slices of a longer message stream. Both paths can — depending on
 *   where the cut lands — produce one of two illegal shapes:
 *     1. A `role: 'tool'` message whose owning assistant `tool_use` is
 *        no longer in the slice.
 *     2. An `assistant` message whose `toolCalls[i].id` has no matching
 *        `role: 'tool'` follow-up inside the slice.
 *   The Anthropic Messages API and the Chat-Completions adapter both
 *   400 on either shape ("`tool_use` blocks must be paired with
 *   `tool_result` blocks").
 *
 * Strategy (Strategy B from the design doc):
 *   Drop orphans rather than extending the slice backwards. Concretely:
 *
 *     - Walk forward. For each `role: 'assistant'` message with
 *       `toolCalls`, look ahead at the contiguous run of `role: 'tool'`
 *       messages (or, in this codebase's flat array form, all `tool`
 *       messages between this assistant and the next assistant/user)
 *       and collect the set of `toolCallId`s that are present.
 *     - Filter the assistant's `toolCalls` to that set. If the result
 *       is empty AND the assistant has no text content, drop the
 *       assistant. Otherwise keep it with the surviving subset (which
 *       may be empty `toolCalls: []` if it had text).
 *     - Drop any `role: 'tool'` whose `toolCallId` is not in the
 *       surviving set of any preceding assistant in the slice.
 *
 * The transform is idempotent: running it twice produces the same
 * result as running it once. It does not mutate the input.
 *
 * It's deliberately tolerant of "weird" inputs — null entries, missing
 * fields, leading orphan tools (which become outright drops) — because
 * the call sites already see all of those.
 */

/**
 * @typedef {Object} UnifiedMessage
 * @property {string} role           - 'user' | 'assistant' | 'tool' | 'system'
 * @property {string} [content]
 * @property {Array<{id: string, name?: string, input?: any}>} [toolCalls]
 * @property {string} [toolCallId]   - present on role:'tool'
 * @property {boolean} [isError]
 */

/**
 * Sanitize a message slice so every `tool_use` is paired with its
 * `tool_result` and vice versa. Returns a new array; never mutates input.
 *
 * @param {UnifiedMessage[]} messages
 * @returns {UnifiedMessage[]}
 */
export function pairSanitize(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return [];

  // Pass 1: collect every toolCallId that has a matching `role:'tool'`
  // message somewhere in the slice. (Pairing is positional, but for
  // the orphan-drop policy a global presence check is sufficient — and
  // it tolerates reorderings that the storage layer occasionally does
  // when sequence ids cross seconds-boundaries.)
  const toolResultIds = new Set();
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'tool' && typeof m.toolCallId === 'string' && m.toolCallId) {
      toolResultIds.add(m.toolCallId);
    }
  }

  // Pass 2: walk messages, filter assistant.toolCalls down to those
  // whose result is in the slice, and track which call-ids survived.
  // A `role:'tool'` is kept iff its toolCallId is in survivingCallIds.
  const survivingCallIds = new Set();
  const out = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') {
      // Pass through non-object junk so callers that intentionally
      // include sentinels don't lose them. (Practically never happens.)
      out.push(m);
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
      const keptCalls = m.toolCalls.filter(tc =>
        tc && typeof tc.id === 'string' && toolResultIds.has(tc.id)
      );
      const text = typeof m.content === 'string' ? m.content : '';
      const hasText = text.trim().length > 0;
      if (keptCalls.length === 0 && !hasText) {
        // No text, all tool_uses orphaned → drop the message entirely.
        // Anthropic / OpenAI both reject empty assistant turns anyway.
        continue;
      }
      // Record surviving call ids so we keep their tool_result counterparts.
      for (const tc of keptCalls) survivingCallIds.add(tc.id);
      // Replace toolCalls with the filtered subset. Preserve other fields.
      out.push({ ...m, toolCalls: keptCalls });
      continue;
    }
    if (m.role === 'tool') {
      if (typeof m.toolCallId !== 'string' || !m.toolCallId) {
        // Tool message with no id — can't pair, drop it.
        continue;
      }
      if (!survivingCallIds.has(m.toolCallId)) {
        // Orphan tool_result: the assistant that called it isn't in the
        // slice (or its tool_use was filtered out above).
        continue;
      }
      out.push(m);
      continue;
    }
    // user / system / assistant-without-toolCalls / unknown — keep as-is.
    out.push(m);
  }

  return out;
}

/**
 * Quick predicate: does this slice contain at least one orphan?
 * Useful for tests and diagnostics. Pure function over `pairSanitize`.
 *
 * @param {UnifiedMessage[]} messages
 * @returns {boolean}
 */
export function hasOrphanPairs(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const sanitized = pairSanitize(messages);
  if (sanitized.length !== messages.length) return true;
  // Same length but maybe an assistant's toolCalls shrank.
  for (let i = 0; i < messages.length; i++) {
    const a = messages[i];
    const b = sanitized[i];
    if (!a || !b) continue;
    const aCalls = Array.isArray(a.toolCalls) ? a.toolCalls.length : 0;
    const bCalls = Array.isArray(b.toolCalls) ? b.toolCalls.length : 0;
    if (aCalls !== bCalls) return true;
  }
  return false;
}
