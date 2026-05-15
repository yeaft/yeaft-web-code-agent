/**
 * reflection-prompt.js — V7 reflection prompt builder (PR-L).
 *
 * One template, used by both T1 (in-turn) and T2 (end-of-turn) reflectors.
 * The primary model is asked to REFLECT on a sequence of tool calls — not
 * just summarise. The output is markdown with five fixed sections so the
 * frontend ReflectionCard can render each independently.
 *
 * Bilingual: the prompt itself is rendered in the user's language (en/zh)
 * so the model's output (which the user reads inside the ReflectionCard
 * and which the next adapter loop sees as a synthetic user message) is
 * in the matching language. Falls back to English for any other lang
 * value or when `language` is omitted.
 *
 * Section headings stay English in both templates because the frontend
 * ReflectionCard parses them by literal string match ("## What was
 * attempted" et al.) and a localised heading would break rendering.
 */

const TEMPLATE_EN = `You are reviewing a sequence of {N} tool calls executed by an AI agent.
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

const TEMPLATE_ZH = `你正在复盘一个 AI agent 刚刚执行的 {N} 次工具调用。
你的任务不是简单总结，而是要"反思"。

请用 markdown 输出，必须严格包含以下五个段落（标题保持英文，便于前端解析）：

## What was attempted
2-3 句话说明本批工具调用的目标和动作链路。

## Key findings
具体事实：路径、行号、ID、错误码（必须逐字保留原始值，不要改写）。

## Direction check
- 当前轨迹是否仍然贴合用户最初的请求？
- 是否有偏离 / 范围漂移？
- 是否有看起来重复或多余的工具调用？
- 是否有迹象表明陷入了无效循环？

## Suggested next direction
下一轮 loop 应该聚焦什么？应该避免什么？

## Tool execution log
紧凑列表：<tool_name> × <count>（附上值得注意的参数）。

注意：所有标识符、路径、URL、行号、错误消息必须逐字保留，不允许改写数据值。

用户最初的请求：
{originalUserMessage}

工具执行序列：
{toolCallsAndResults}`;

/**
 * Render the prompt.
 *
 * @param {{ originalUserMsg: string, toolPairs: Array<{ name: string, input: any, output: string, isError: boolean }>, assistantText?: string, language?: string }} p
 * @returns {string}
 */
export function buildReflectionPrompt({ originalUserMsg, toolPairs, assistantText, language }) {
  const N = toolPairs.length;
  const seq = toolPairs.map((p, i) => formatPair(i + 1, p)).join('\n\n');
  const isZh = String(language || '').toLowerCase().startsWith('zh');
  const head = assistantText && assistantText.trim()
    ? (isZh
      ? `本批工具调用期间助手输出的文本：\n${assistantText.trim()}\n\n`
      : `Assistant text emitted during this batch:\n${assistantText.trim()}\n\n`)
    : '';
  const template = isZh ? TEMPLATE_ZH : TEMPLATE_EN;
  return template
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

// Kept as the English template constant for compatibility with the
// existing reflection-prompt test that asserts on the literal
// "CRITICAL: Preserve all identifiers" string.
export const REFLECTION_TEMPLATE = TEMPLATE_EN;
export const REFLECTION_TEMPLATE_EN = TEMPLATE_EN;
export const REFLECTION_TEMPLATE_ZH = TEMPLATE_ZH;
