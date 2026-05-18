/**
 * tool-folding/index.js — V7 reflection subsystem entry (PR-L).
 *
 * Exposes:
 *   - Constants TOOL_BATCH_SIZE, TURN_SUMMARY_THRESHOLD, DUP_TOOL_THRESHOLD
 *   - Reflector helpers (T1 sync, T2 async, fallback stub)
 *   - Helpers for collapsing message ranges into a single assistant
 *     reflection message
 *   - Duplicate-reminder text formatter
 *
 * The constants are NOT config-driven — V7 design freezes them in code.
 *
 * Invariant: TURN_SUMMARY_THRESHOLD < TOOL_BATCH_SIZE. T1 runs inside the
 * turn and collapses history in place; T2 fires at end_turn and is gated
 * by `t1CollapsesDone === 0` (engine.js). If T2 were ever set ≥ T1, T1
 * would collapse first and T2 could never fire — silently disabling the
 * end-of-turn reflection path. Keep a usefully wide gap between the two
 * so the (T2, T1) band where T2-alone applies stays meaningful.
 *
 * TOOL_BATCH_SIZE history: was 13 originally; raised to 30 (2026-05-15)
 * after user feedback that 13 fired too often inside a single task and
 * fragmented otherwise-coherent tool arcs into multiple reflections. 30
 * keeps the periodic-reflection contract (it still fires every N tools,
 * not just once) but gives a single task arc room to breathe before the
 * arc gets collapsed.
 *
 * TURN_SUMMARY_THRESHOLD history: was 5 originally; raised to 8
 * (2026-05-18). 5 was too aggressive — small "read a few files, edit one,
 * run tests" turns crossed it and produced a T2 reflection card the user
 * didn't want. 8 lets short-to-medium turns finish without a reflection
 * while still folding the long ones that genuinely benefit from a summary
 * before the next turn's history grows.
 */

export const TOOL_BATCH_SIZE = 30;
export const TURN_SUMMARY_THRESHOLD = 8;
export const DUP_TOOL_THRESHOLD = 3;

export { ExecLog, buildEntry, argsHashOf } from './exec-log.js';
export {
  buildReflectionPrompt,
  REFLECTION_TEMPLATE_EN,
  REFLECTION_TEMPLATE_ZH,
} from './reflection-prompt.js';
export { runT1Reflection } from './t1-reflector.js';
export { runT2Reflection } from './t2-reflector.js';
export { buildFallbackStub } from './fallback-stub.js';

/**
 * Collapse messages[startIdx..endIdx] (inclusive) into a single
 * `{ role: 'user', content }` reflection message. Returns a NEW array; does
 * not mutate the input.
 *
 * The original assistant+tool sequence (the action arc) is replaced by ONE
 * synthetic user message carrying the reflection summary. User messages
 * that happened to appear inside the range stay put (defensive — the caller
 * normally passes a range that contains only assistant+tool).
 *
 * Why role='user' (not 'assistant'):
 *   The Anthropic Messages API requires the messages array to end with a
 *   user message before the next assistant turn. If we collapsed into an
 *   assistant message and the reflection happened to land at the tail
 *   (e.g. immediately before #applyPendingT2Reflections fires its next
 *   query), the API rejects the request with "model does not support
 *   assistant message prefill".
 *
 *   Following Claude Code's compact pattern, we wrap the reflection as a
 *   synthetic user message — the model treats it as a context-recovery
 *   directive and continues from there. The opening line ("The previous N
 *   tool calls have been folded ...") plus the closing "Continue from
 *   here." make it unambiguous that this is not a fresh user prompt.
 *
 * @param {Array} messages
 * @param {number} startIdx
 * @param {number} endIdx
 * @param {string} reflectionContent
 * @returns {Array}
 */
export function collapseRangeToReflection(messages, startIdx, endIdx, reflectionContent) {
  if (!Array.isArray(messages)) return messages;
  if (startIdx < 0 || endIdx < startIdx || endIdx >= messages.length) return messages;
  const before = messages.slice(0, startIdx);
  const collapsed = messages.slice(startIdx, endIdx + 1);
  const after = messages.slice(endIdx + 1);

  // Count tool_use occurrences inside the collapsed range so the wrapper
  // text can name how many calls were folded. Falls back to "previous"
  // wording when no tool calls are detected.
  let toolCount = 0;
  for (const m of collapsed) {
    if (m && m.role === 'assistant' && Array.isArray(m.toolCalls)) {
      toolCount += m.toolCalls.length;
    }
  }

  // Preserve any user messages that happened to appear inside the range
  // (not expected per V7 spec, but defensive). Everything else (assistant +
  // tool) is replaced by ONE synthetic user reflection message.
  const preservedUsers = collapsed.filter(m => m && m.role === 'user');
  const header = toolCount > 0
    ? `The previous ${toolCount} tool call${toolCount === 1 ? '' : 's'} have been folded for context efficiency.`
    : 'The previous tool calls have been folded for context efficiency.';
  const wrappedContent =
    `${header}\n\nSummary:\n${reflectionContent}\n\nContinue from here.`;
  const reflectionMsg = {
    role: 'user',
    content: wrappedContent,
    _reflection: true,
  };
  return [...before, ...preservedUsers, reflectionMsg, ...after];
}

/**
 * Build the (toolName, argsHash) → 3rd-time reminder text used by the
 * duplicate-call detector.
 *
 * @param {{ toolName: string, count: number, lastResultBrief: string }} p
 * @returns {string}
 */
export function buildDuplicateReminder({ toolName, count, lastResultBrief }) {
  return `[system note] You have called ${toolName} with the same arguments ${count} times. `
    + `Previous result: ${(lastResultBrief || '').trim()}. `
    + `Consider whether re-running this tool is necessary or if you should try a different approach.`;
}

/**
 * Convert assistant.toolCalls + matching tool results into the
 * { name, input, output, isError } pairs the reflector prompt expects.
 *
 * Walks `messages[startIdx..endIdx]` and pairs each tool_use with its
 * tool_result by toolCallId. Unpaired tool_use entries are dropped.
 *
 * @param {Array} messages
 * @param {number} startIdx
 * @param {number} endIdx
 * @returns {{ pairs: Array, assistantText: string }}
 */
export function extractToolPairsFromRange(messages, startIdx, endIdx) {
  const pairs = [];
  const byId = new Map();
  let assistantText = '';
  const lo = Math.max(0, startIdx);
  const hi = Math.min(messages.length - 1, endIdx);
  for (let i = lo; i <= hi; i += 1) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'assistant') {
      if (typeof m.content === 'string' && m.content) {
        assistantText += (assistantText ? '\n' : '') + m.content;
      }
      const calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
      for (const tc of calls) {
        const ent = { name: tc.name, input: tc.input, output: '', isError: false, _id: tc.id };
        pairs.push(ent);
        if (tc.id) byId.set(tc.id, ent);
      }
    } else if (m.role === 'tool') {
      const ent = m.toolCallId ? byId.get(m.toolCallId) : null;
      if (ent) {
        ent.output = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        ent.isError = !!m.isError;
      } else {
        // Orphan tool result — still include for completeness.
        pairs.push({
          name: '(orphan)',
          input: {},
          output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          isError: !!m.isError,
        });
      }
    }
  }
  // Strip internal _id field before returning.
  return {
    pairs: pairs.map(({ name, input, output, isError }) => ({ name, input, output, isError })),
    assistantText,
  };
}
