/**
 * reflection-prompt.js — V7 reflection prompt builder (PR-L).
 *
 * One template, used by both T1 (in-turn) and T2 (end-of-turn) reflectors.
 * The primary model is asked to REFLECT on a sequence of tool calls — not
 * just summarise. The output is markdown with five fixed sections so the
 * frontend ReflectionCard can render each independently.
 */

const TEMPLATE = `You are reviewing a sequence of {N} tool calls executed by an AI agent.
Your job is NOT just to summarize, but to REFLECT.

Output as markdown with these exact sections:

## What was attempted
2-3 sentences on the goal and action arc.

## Key findings
Concrete facts: paths, line numbers, IDs, error codes (preserve verbatim).

## Direction check
- Is the trajectory still aligned with the user's original request?
- Any drift / scope creep?
- Any tool calls that look redundant?
- Any signs of unproductive loops?

## Suggested next direction
What should the next loop focus on? What should it AVOID?

## Tool execution log
Compact list: <tool_name> × <count> (with notable args).

CRITICAL: Preserve all identifiers, paths, URLs, line numbers, and error
messages literally. Do NOT paraphrase data values.

User original request:
{originalUserMessage}

Tool execution sequence:
{toolCallsAndResults}`;

/**
 * Render the prompt.
 *
 * @param {{ originalUserMsg: string, toolPairs: Array<{ name: string, input: any, output: string, isError: boolean }>, assistantText?: string }} p
 * @returns {string}
 */
export function buildReflectionPrompt({ originalUserMsg, toolPairs, assistantText }) {
  const N = toolPairs.length;
  const seq = toolPairs.map((p, i) => formatPair(i + 1, p)).join('\n\n');
  const head = assistantText && assistantText.trim()
    ? `Assistant text emitted during this batch:\n${assistantText.trim()}\n\n`
    : '';
  return TEMPLATE
    .replace('{N}', String(N))
    .replace('{originalUserMessage}', String(originalUserMsg || '').slice(0, 4000))
    .replace('{toolCallsAndResults}', head + seq);
}

function formatPair(idx, p) {
  let inputStr;
  try { inputStr = JSON.stringify(p.input); } catch { inputStr = String(p.input); }
  if (typeof inputStr === 'string' && inputStr.length > 1000) {
    inputStr = inputStr.slice(0, 1000) + '…';
  }
  let outputStr = typeof p.output === 'string' ? p.output : (() => {
    try { return JSON.stringify(p.output); } catch { return String(p.output); }
  })();
  if (outputStr.length > 2000) outputStr = outputStr.slice(0, 2000) + '…';
  const status = p.isError ? ' [ERROR]' : '';
  return `[${idx}] ${p.name}${status}\n  args: ${inputStr}\n  result: ${outputStr}`;
}

export const REFLECTION_TEMPLATE = TEMPLATE;
