/**
 * fallback-stub.js — Generated when T2 reflection isn't ready in time
 * (PR-L). Built synchronously from exec-log entries — no LLM call.
 */

/**
 * @param {{ execLogEntries: Array<object>, originalUserMsg?: string }} p
 * @returns {string}
 */
export function buildFallbackStub({ execLogEntries, originalUserMsg }) {
  const entries = Array.isArray(execLogEntries) ? execLogEntries : [];
  const N = entries.length;
  const counts = new Map();
  for (const e of entries) {
    counts.set(e.toolName, (counts.get(e.toolName) || 0) + 1);
  }
  const tally = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `- ${name} × ${n}`)
    .join('\n');

  const errors = entries.filter(e => e.resultStatus === 'error');
  const findings = entries
    .slice(0, 10)
    .map(e => `- \`${e.toolName}(${e.argsBrief})\` → ${e.resultStatus}: ${e.resultBrief}`)
    .join('\n');

  const head = originalUserMsg
    ? `_(Original request: ${String(originalUserMsg).slice(0, 200)})_\n\n`
    : '';

  return `${head}## What was attempted
A previous turn executed ${N} tool call${N === 1 ? '' : 's'}; reflection wasn't generated in time, so this is a mechanical summary.

## Key findings
${findings || '_(no entries)_'}

## Direction check
- ${errors.length} tool call${errors.length === 1 ? '' : 's'} failed.
- This is a fallback stub; no semantic analysis was performed.

## Suggested next direction
Continue per the user's original request; do not assume the previous turn made progress beyond the raw findings above.

## Tool execution log
${tally || '_(empty)_'}`;
}
