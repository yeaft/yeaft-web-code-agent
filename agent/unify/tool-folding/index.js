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
 */

export const TOOL_BATCH_SIZE = 13;
export const TURN_SUMMARY_THRESHOLD = 5;
export const DUP_TOOL_THRESHOLD = 3;

export { ExecLog, buildEntry, argsHashOf } from './exec-log.js';
export { buildReflectionPrompt, REFLECTION_TEMPLATE } from './reflection-prompt.js';
export { runT1Reflection } from './t1-reflector.js';
export { runT2Reflection } from './t2-reflector.js';
export { buildFallbackStub } from './fallback-stub.js';

/**
 * Collapse messages[startIdx..endIdx] (inclusive) into a single
 * `{ role: 'assistant', content }` message. Returns a NEW array; does not
 * mutate the input.
 *
 * The original assistant+tool sequence (the action arc) is replaced by the
 * reflection; user messages within that range stay put (defensive — the
 * caller normally passes a range that contains only assistant+tool).
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

  // Preserve any user messages that happened to appear inside the range
  // (not expected per V7 spec, but defensive). Everything else (assistant +
  // tool) is replaced by ONE assistant reflection message.
  const preservedUsers = collapsed.filter(m => m && m.role === 'user');
  const reflectionMsg = {
    role: 'assistant',
    content: reflectionContent,
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
