/**
 * history-compact.js — In-memory conversation history compaction for the
 * Yeaft group-chat fan-out path.
 *
 * Problem this solves:
 *   `agent/yeaft/web-bridge.js` keeps a flat module-level array
 *   `conversationMessages` that grows unbounded across the lifetime of the
 *   agent process. Every fan-out turn snapshots the whole thing into
 *   `baseSnapshot` and feeds it to `engine.query` for every VP. Without a
 *   cap, prompt size and token cost grow linearly with conversation length.
 *
 * Existing infrastructure (`agent/yeaft/compact/orchestrator.js`,
 * `engine.js#runOrchestratorCompact`) compacts the on-disk
 * `conversationStore` — a different surface. This helper compacts the
 * in-memory array that actually gets passed to the LLM.
 *
 * Approach (Claude-Code-style compact):
 *   1. Skip tool messages and the synthetic `_reflection`/`_compactSummary`
 *      wrappers when feeding the summarizer (tool result bodies are noise;
 *      reflection wrappers are already a summary).
 *   2. Ask the fast model to produce a short structured summary of the
 *      conversation up to a cut-point.
 *   3. Replace `messages[0..cutIdx]` with ONE synthetic user message
 *      carrying that summary, wrapped with the canonical recovery prompt
 *      ("This session is being continued from a previous conversation...").
 *   4. Keep the last `keepRecent` user→assistant turns intact so the model
 *      has fresh, untransformed context for whatever the user just said.
 *
 * Triggers:
 *   - tokens < 12_000 → never compact (cheap chat, no point paying
 *     the summarizer)
 *   - fewer than 5 turns → do not compact unless context pressure is
 *     already high
 *   - tokens > 80 % of `maxContextTokens` (defaults to 200K → 160K)
 *   - tokens > 200,000 hard ceiling
 *
 * The "turn > 20" trigger that an earlier revision used was dropped:
 * under a 30K token floor it's effectively dead code — the fractional
 * threshold fires first in any conversation big enough to matter.
 *
 * Defaults are derived from `maxContextTokens` so the policy auto-adjusts
 * when the user widens or narrows their context budget. All knobs are
 * overridable via the options bag for tests / future config plumbing.
 *
 * Why role='user' for the summary message:
 *   The Anthropic Messages API rejects assistant prefill at the tail
 *   ("messages must end with user before next assistant turn"). Wrapping
 *   as user mirrors what Claude Code does for compact summaries — and
 *   what `tool-folding/index.js#collapseRangeToReflection` already does
 *   for tool-arc reflections in this codebase. The opening sentence
 *   ("This session is being continued ...") makes the model treat it
 *   as a recovery directive rather than a fresh user prompt.
 */

import { estimateTokens } from './conversation/persist.js';
import { pairSanitize } from './pair-sanitize.js';
import { truncateToolResultIfNeeded } from './tools/registry.js';
import {
  countTurns as countTurnsImpl,
  indexOfNthTurnFromEnd,
  sliceLastNTurns,
} from './turn-utils.js';


function truncateToolResultsForModel(messages, opts = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  return messages.map((m) => {
    if (!m || m.role !== 'tool' || typeof m.content !== 'string') return { ...m };
    return {
      ...m,
      content: truncateToolResultIfNeeded(m.content, {
        toolName: m.name || m.toolName || 'tool_result',
        language: opts.language,
      }),
    };
  });
}

/**
 * Re-export `countTurns` so existing callers / tests that import it
 * from this module continue to work. Implementation now lives in
 * `turn-utils.js` and is shared with `ConversationStore`.
 */
export const countTurns = countTurnsImpl;

/**
 * Default trigger thresholds (2026-05-02 policy update):
 *   - never compact while total tokens < 12K (soft floor — most short
 *     conversations under that aren't worth paying the summarizer
 *     cost; the LLM hasn't started feeling the context yet either),
 *   - otherwise compact if ANY of:
 *       turnCount > 30           (back-stop for chats with many small turns)
 *       tokens > 80 % of `maxContextTokens` (default 200K → 160K)
 *       tokens > 200K hard ceiling
 *     Fewer than 5 turns are protected from compact unless the token
 *     threshold is already crossed.
 *
 * Lowered from 30K → 12K and re-enabled a turn-count back-stop because
 * the previous "soft floor of 30K, no turn cap" combination is dead in
 * the multi-VP fan-out path: hundreds of small turns happily stay below
 * 30K and never trigger compact, then `runVpTurn` feeds the whole 720+
 * message snapshot to the LLM and trips the provider's context window.
 * The snapshot trim in `web-bridge.js#trimSnapshotForBudget` is the
 * primary defense; this is the second-line trigger that compresses
 * the on-array form so subsequent turns also stay bounded.
 *
 * `turnLimit` and the `turn_count` reason code are still overridable
 * for tests / future config.
 *
 * Token thresholds are derived from `maxContextTokens` at evaluation
 * time so the policy auto-adjusts to the user's configured context.
 */
export const DEFAULT_TURN_LIMIT = Infinity;
export const DEFAULT_MIN_TOKEN_FLOOR = 0;
export const DEFAULT_MAX_CONTEXT_TOKENS = 200_000;
export const DEFAULT_TOKEN_FRACTION = 0.5;
export const DEFAULT_HARD_TOKEN_CEILING = Infinity;
export const DEFAULT_MIN_TURNS_FOR_COMPACT = 0;
export const DEFAULT_KEEP_TOOL_TURNS = 3;
export const DEFAULT_TOOL_CALL_COMPACT_THRESHOLD = 30;
/**
 * Effective default token trigger when no `maxContextTokens` is provided:
 *   min(80% of 200K, 200K) = 160K. Preserved as `DEFAULT_TOKEN_LIMIT` for
 *   back-compat with existing tests that import this name.
 */
export const DEFAULT_TOKEN_LIMIT = Math.min(
  Math.floor(DEFAULT_MAX_CONTEXT_TOKENS * DEFAULT_TOKEN_FRACTION),
  DEFAULT_HARD_TOKEN_CEILING
);

/**
 * How many user→assistant pairs to leave intact at the tail. The summary
 * replaces everything before this window. 2 keeps "what we were just
 * talking about" lossless.
 */
export const DEFAULT_KEEP_RECENT_TURNS = 3;

/**
 * Default cap on the number of turns kept in the per-call snapshot fed
 * to `engine.query` (see `trimSnapshotForBudget` below). A turn here is
 * one user-side prompt — multi-VP `@vp-X` variants of the same prompt
 * collapse into one turn (see `turn-utils.js#countTurns`).
 *
 * Sized in conjunction with `DEFAULT_TURN_LIMIT` (30, the compact-trigger
 * back-stop): trim to 25 leaves a 5-turn buffer below the compact trigger
 * so a typical chat sees its history compacted before the trim starts
 * dropping turns silently. That ordering matters — compact preserves the
 * tail's lossless 2 turns AND a summary of everything older, whereas trim
 * just discards anything beyond the cap.
 *
 * 25 turns at ~5 messages each (user + assistant + a couple tool steps)
 * is roughly 100–125 messages — well under the LLM context window for
 * any reasonable model, and large enough to preserve "what we've been
 * talking about" context for the model. The hard token-budget cap inside
 * `trimSnapshotForBudget` tightens this further when individual turns
 * are large.
 */
export const DEFAULT_RECENT_TURN_CAP = 25;

/**
 * Default per-query token budget for the snapshot (separate from the
 * `tokenLimit` used by compact triggers). Mirrors the default
 * carried in `~/.yeaft/config.json`'s `messageTokenBudget` field.
 */
export const DEFAULT_MESSAGE_TOKEN_BUDGET = 32768;

/**
 * Estimate the token weight of a single message including role overhead
 * and any tool-call structure. Mirrors `dream/segment.js` approach: a
 * couple of tokens per message for role/wrapping plus the body.
 *
 * @param {{role:string, content?:string, toolCalls?:Array, toolCallId?:string}} m
 * @returns {number}
 */
export function estimateMessageTokens(m) {
  if (!m || typeof m !== 'object') return 0;
  let n = 2; // role + framing
  if (typeof m.content === 'string') n += estimateTokens(m.content);
  if (Array.isArray(m.toolCalls)) {
    for (const tc of m.toolCalls) {
      n += 4; // call framing
      try {
        const inputJson = typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input || {});
        n += estimateTokens(inputJson);
      } catch { /* ignore — JSON.stringify failure on circular input */ }
      if (tc.name) n += estimateTokens(tc.name);
    }
  }
  if (m.toolCallId) n += 2;
  return n;
}

/**
 * Sum estimated tokens across all messages.
 * @param {Array<object>} messages
 * @returns {number}
 */
export function estimateMessagesTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
}

/**
 * Pure trigger evaluator. Decides whether the in-memory history needs
 * compaction. No I/O, no LLM call.
 *
 * Policy (2026-05-22):
 *   1. tokens < `minTokenFloor` (default 12K) → trigger=false (always).
 *   2. fewer than `minTurnsForCompact` turns (default 5) → trigger=false
 *      unless tokenCount already exceeds the fractional context threshold.
 *   3. otherwise trigger if ANY of:
 *        turnCount > turnLimit (default 30 back-stop)
 *        tokenCount > maxContextTokens*fraction (default 80%, reason='token_threshold')
 *        tokenCount > hardTokenCeiling          (reason='token_ceiling')
 *
 * `tokenLimit` is preserved as a back-compat override for callers /
 * tests that pin a specific number; when set, it overrides the
 * fraction-of-context calculation.
 *
 * @param {Array<object>} messages
 * @param {{
 *   turnLimit?: number,
 *   minTurnsForCompact?: number,
 *   tokenLimit?: number,
 *   minTokenFloor?: number,
 *   maxContextTokens?: number,
 *   tokenFraction?: number,
 *   hardTokenCeiling?: number,
 * }} [opts]
 * @returns {{trigger: boolean, reason: 'turn_count'|'token_threshold'|'token_ceiling'|null,
 *            turnCount: number, tokenCount: number,
 *            turnLimit: number, tokenLimit: number, minTurnsForCompact: number,
 *            minTokenFloor: number, hardTokenCeiling: number}}
 */
export function shouldCompactHistory(messages, opts = {}) {
  const turnLimit = opts.turnLimit ?? DEFAULT_TURN_LIMIT;
  const minTokenFloor = opts.minTokenFloor ?? DEFAULT_MIN_TOKEN_FLOOR;
  const hardTokenCeiling = opts.hardTokenCeiling ?? DEFAULT_HARD_TOKEN_CEILING;
  const maxContextTokens = opts.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
  const tokenFraction = opts.tokenFraction ?? DEFAULT_TOKEN_FRACTION;
  const minTurnsForCompact = opts.minTurnsForCompact ?? DEFAULT_MIN_TURNS_FOR_COMPACT;
  // tokenLimit override wins; otherwise compute fractional threshold.
  const tokenLimit =
    opts.tokenLimit
    ?? Math.min(Math.floor(maxContextTokens * tokenFraction), hardTokenCeiling);

  const turnCount = countTurns(messages);
  const tokenCount = estimateMessagesTokens(messages);

  let reason = null;
  // Product rule: async group compact is allowed only when the current
  // conversation exceeds the model context window threshold. Turn count is
  // preserved as an explicit test/future-config override, but defaults to
  // Infinity so it cannot compact a small context by itself.
  if (tokenCount < minTokenFloor || (turnCount < minTurnsForCompact && tokenCount < tokenLimit)) {
    return {
      trigger: false,
      reason: null,
      turnCount,
      tokenCount,
      turnLimit,
      tokenLimit,
      minTurnsForCompact,
      minTokenFloor,
      hardTokenCeiling,
    };
  }
  if (tokenCount > hardTokenCeiling) reason = 'token_ceiling';
  else if (tokenCount > tokenLimit) reason = 'token_threshold';

  return {
    trigger: reason !== null,
    reason,
    turnCount,
    tokenCount,
    turnLimit,
    tokenLimit,
    minTurnsForCompact,
    minTokenFloor,
    hardTokenCeiling,
  };
}

function hasContentAfterToolStrip(content) {
  if (typeof content === 'string') return content.trim().length > 0;
  if (Array.isArray(content)) return content.length > 0;
  return content != null;
}

function countToolCallsInContent(content) {
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'tool_use' || part.type === 'function_call') n++;
  }
  return n;
}

function countToolCallsInMessages(messages) {
  if (!Array.isArray(messages)) return 0;
  let n = 0;
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    if (Array.isArray(m.toolCalls)) n += m.toolCalls.length;
    n += countToolCallsInContent(m.content);
  }
  return n;
}

function stripToolContentParts(content) {
  if (!Array.isArray(content)) return content;
  return content.filter(part => {
    if (!part || typeof part !== 'object') return true;
    return part.type !== 'tool_use'
      && part.type !== 'tool_result'
      && part.type !== 'function_call'
      && part.type !== 'function_call_output';
  });
}

/**
 * Remove tool-call / tool-result noise from turns older than the recent
 * lossless window. The last `keepToolTurns` turns keep their full tool
 * chains; older turns keep user/assistant text but lose `toolCalls`,
 * Anthropic/OpenAI tool content blocks, and `role:'tool'` messages.
 *
 * This is deliberately a wire-history transform, not a summarizer: it
 * never invents a summary and it never mutates input. Pair-sanitize runs
 * afterwards so no orphan tool_use/tool_result can survive.
 *
 * @param {Array<object>} messages
 * @param {{ keepToolTurns?: number }} [opts]
 * @returns {Array<object>}
 */
export function stripToolNoiseFromOlderTurns(messages, opts = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const keepToolTurns = Number.isFinite(opts.keepToolTurns) && opts.keepToolTurns >= 0
    ? opts.keepToolTurns
    : DEFAULT_KEEP_TOOL_TURNS;
  const cutIdx = indexOfNthTurnFromEnd(messages, keepToolTurns);
  if (cutIdx <= 0) return messages.map(m => ({ ...m }));

  const older = messages.slice(0, cutIdx);
  const recent = messages.slice(cutIdx);
  const cleanedOlder = [];

  for (const m of older) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'tool') continue;

    const next = { ...m };
    if (Array.isArray(next.toolCalls)) delete next.toolCalls;
    if (Array.isArray(next.content)) next.content = stripToolContentParts(next.content);

    if (next.role === 'assistant' && !hasContentAfterToolStrip(next.content)) continue;
    if (next.role === 'user' && Array.isArray(next.content) && next.content.length === 0) continue;
    cleanedOlder.push(next);
  }

  return [...cleanedOlder, ...recent.map(m => ({ ...m }))];
}

/**
 * Apply the async compact retained-tail tool policy. Small retained tails keep
 * every tool pair intact. Once the retained tail exceeds the threshold, keep
 * full tool history only for the latest turn and strip tool noise from the
 * earlier retained turns while preserving their normal text.
 *
 * @param {Array<object>} tail
 * @param {{ keepToolTurns?: number, toolCallCompactThreshold?: number }} [opts]
 * @returns {Array<object>}
 */
export function compactRetainedTailToolCalls(tail, opts = {}) {
  if (!Array.isArray(tail) || tail.length === 0) return [];

  const threshold = Number.isFinite(opts.toolCallCompactThreshold) && opts.toolCallCompactThreshold >= 0
    ? opts.toolCallCompactThreshold
    : DEFAULT_TOOL_CALL_COMPACT_THRESHOLD;
  const toolCallCount = countToolCallsInMessages(tail);
  if (toolCallCount <= threshold) return tail.map(m => ({ ...m }));

  const keepToolTurns = Number.isFinite(opts.keepToolTurns) && opts.keepToolTurns >= 0
    ? opts.keepToolTurns
    : 1;
  return stripToolNoiseFromOlderTurns(tail, { keepToolTurns });
}

/**
 * Strip noise from a message list before sending it to the summarizer:
 *   - drop `role: 'tool'` (raw tool results — too verbose, mostly redundant)
 *   - drop messages already tagged `_compactSummary` (avoid summarising
 *     a summary)
 *   - keep `_reflection` messages as-is (they're already a fold-summary
 *     of an earlier tool arc and contain real information)
 *   - elide `toolCalls` from assistant messages: replace each with a tag
 *     line like "[called tool: bash with input ...]" so the summarizer
 *     knows a tool ran without spending tokens on the full input
 *
 * @param {Array<object>} messages
 * @returns {Array<{role:string, content:string}>}
 */
export function buildSummarizerInput(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'tool') continue;
    if (m._compactSummary) continue;
    let content = typeof m.content === 'string' ? m.content : '';
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
      const callTags = m.toolCalls.map(tc => {
        const name = tc.name || 'unknown';
        let inputBrief = '';
        try {
          const json = typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input || {});
          inputBrief = json.length > 120 ? json.slice(0, 120) + '…' : json;
        } catch { inputBrief = '<input>'; }
        return `[tool ${name}: ${inputBrief}]`;
      }).join(' ');
      content = content ? `${content}\n${callTags}` : callTags;
    }
    if (!content) continue;
    out.push({ role: m.role, content });
  }
  return out;
}

/**
 * Find the cut index: keep the last `keepRecent` user→assistant arcs
 * intact, fold everything before. Returns the index that the cut starts
 * AT, i.e. messages[0..cutIdx) gets summarised, messages[cutIdx..] stays.
 *
 * Thin wrapper around `turn-utils.indexOfNthTurnFromEnd` with the
 * historical contract preserved:
 *   - empty input returns -1,
 *   - `keepRecent <= 0` folds everything (returns messages.length),
 *   - "fewer turns than keepRecent" maps to -1 (caller treats as no-op).
 *
 * Multi-VP fan-out: `@vp-X` variants of the same underlying turn count
 * as ONE turn and the boundary extends backwards through them all.
 *
 * @param {Array<object>} messages
 * @param {number} keepRecent
 * @returns {number}
 */
export function findCutIndex(messages, keepRecent) {
  if (!Array.isArray(messages) || messages.length === 0) return -1;
  if (keepRecent <= 0) return messages.length; // fold everything
  const idx = indexOfNthTurnFromEnd(messages, keepRecent);
  // `indexOfNthTurnFromEnd` returns -1 when there are fewer turns than
  // requested — historical contract is the same. Pass through.
  return idx;
}

/**
 * Wrap a summary string into the canonical "session continued" recovery
 * message. The wording is deliberately close to Claude Code's compact
 * marker so frontend filters (already in `web/stores/helpers/assistantOutput.js`,
 * `server/db/message-db.js`) recognise it.
 *
 * @param {string} summary
 * @param {{ language?: string }} [opts]
 * @returns {{role:'user', content:string, _compactSummary: true}}
 */
export function wrapSummaryAsUserMessage(summary, opts = {}) {
  const body = (summary || '').trim() || '(no summary produced)';
  const isZh = String(opts.language || '').toLowerCase().startsWith('zh');
  const content = isZh
    ? '本会话延续自之前的对话。早期上下文已经被概括以节省空间。\n\n' +
      '至此为止的对话摘要：\n' +
      body +
      '\n\n请从中断处继续对话，不要再向用户重复确认。'
    : 'This session is being continued from a previous conversation. ' +
      'The earlier context has been summarized for efficiency.\n\n' +
      'Summary of conversation so far:\n' +
      body +
      '\n\nContinue the conversation from where it left off without asking the user any further questions.';
  return {
    role: 'user',
    content,
    _compactSummary: true,
  };
}

/**
 * Build the prompt fed to the fast-model summarizer. Kept in code (not in
 * a template file) because it's small and lives alongside the call site.
 *
 * The summarizer prompt itself is language-aware: callers pass the live
 * `config.language` so the produced summary is written in the user's
 * preferred language. JSON-style structural cues stay English so the
 * summary remains easy to splice into the next turn regardless of locale.
 *
 * @param {Array<{role:string, content:string}>} cleanedMessages
 * @param {{ language?: string }} [opts]
 * @returns {{system: string, prompt: string}}
 */
export function buildSummaryPrompt(cleanedMessages, opts = {}) {
  const transcript = cleanedMessages
    .map(m => `[${m.role}]\n${m.content}`)
    .join('\n\n---\n\n');
  const isZh = String(opts.language || '').toLowerCase().startsWith('zh');
  const system = isZh
    ? '你是多 agent 群聊的对话摘要器。请用中文写出 4–8 条简明 bullet 摘要。' +
      '保留：(1) 已做的决策，(2) 已学到的事实，(3) 用户当前目标，' +
      '(4) 任何未解决的问题或待办事项，(5) 哪些 VP 参与了对话以及各自贡献。' +
      '不要包含原始工具输出。不要臆测。要具体。'
    : 'You are a conversation summarizer for a multi-agent group chat. ' +
      'Produce a concise (4–8 short bullet points) summary of the conversation ' +
      'so far. Preserve: (1) decisions made, (2) facts learned, (3) the user\'s ' +
      'current goal, (4) any open questions or pending actions, (5) which VPs ' +
      'are participating and what each contributed. Do NOT include raw tool ' +
      'output. Do NOT speculate. Be specific.';
  const prompt = isZh
    ? '请概括下面的对话。只输出摘要正文，不要前言。\n\n' + transcript
    : 'Summarize the following conversation. Output ONLY the summary, no ' +
      'preamble.\n\n' +
      transcript;
  return { system, prompt };
}

/**
 * Apply compaction to a messages array. Pure transform once `summarize`
 * has produced text. Returns a new array — does not mutate the input.
 *
 * @param {Array<object>} messages
 * @param {{
 *   summarize: (args: {system: string, prompt: string}) => Promise<string>,
 *   keepRecent?: number,
 *   turnLimit?: number,
 *   tokenLimit?: number,
 *   minTokenFloor?: number,
 *   maxContextTokens?: number,
 *   tokenFraction?: number,
 *   hardTokenCeiling?: number,
 *   language?: string,
 * }} options
 * @returns {Promise<{
 *   messages: Array<object>,
 *   compacted: boolean,
 *   reason: string|null,
 *   summary: string|null,
 *   archivedCount: number,
 *   beforeTurns: number,
 *   beforeTokens: number,
 *   afterTurns: number,
 *   afterTokens: number,
 * }>}
 */
export async function compactHistory(messages, options) {
  const {
    summarize,
    keepRecent = DEFAULT_KEEP_RECENT_TURNS,
    turnLimit,
    tokenLimit,
    minTokenFloor,
    maxContextTokens,
    tokenFraction,
    hardTokenCeiling,
    language,
    keepToolTurns,
    toolCallCompactThreshold,
  } = options || {};

  if (typeof summarize !== 'function') {
    throw new TypeError('compactHistory: options.summarize must be a function');
  }

  // Pass thresholds through to shouldCompactHistory so a single options
  // bag controls the policy. Undefined keys fall back to module defaults.
  const triggerOpts = {
    turnLimit,
    tokenLimit,
    minTokenFloor,
    maxContextTokens,
    tokenFraction,
    hardTokenCeiling,
    minTurnsForCompact: options?.minTurnsForCompact,
  };
  const before = shouldCompactHistory(messages, triggerOpts);
  if (!before.trigger) {
    return {
      messages,
      compacted: false,
      reason: null,
      summary: null,
      archivedCount: 0,
      beforeTurns: before.turnCount,
      beforeTokens: before.tokenCount,
      afterTurns: before.turnCount,
      afterTokens: before.tokenCount,
    };
  }

  const cutIdx = findCutIndex(messages, keepRecent);
  if (cutIdx <= 0) {
    // Not enough history to fold while preserving the recent window.
    return {
      messages,
      compacted: false,
      reason: before.reason,
      summary: null,
      archivedCount: 0,
      beforeTurns: before.turnCount,
      beforeTokens: before.tokenCount,
      afterTurns: before.turnCount,
      afterTokens: before.tokenCount,
    };
  }

  const archived = messages.slice(0, cutIdx);
  const tail = messages.slice(cutIdx);
  const cleaned = buildSummarizerInput(archived);

  let summaryText = '';
  if (cleaned.length > 0) {
    const { system, prompt } = buildSummaryPrompt(cleaned, { language });
    try {
      summaryText = (await summarize({ system, prompt })) || '';
    } catch (err) {
      // Summarizer failure → return original messages, signal failure.
      return {
        messages,
        compacted: false,
        reason: before.reason,
        summary: null,
        archivedCount: 0,
        beforeTurns: before.turnCount,
        beforeTokens: before.tokenCount,
        afterTurns: before.turnCount,
        afterTokens: before.tokenCount,
        error: err && err.message ? err.message : String(err),
      };
    }
    // Treat an empty / whitespace-only summary as a soft failure rather
    // than a successful compact. Otherwise we'd archive real history
    // behind a "(no summary produced)" placeholder and the next turn
    // would start from useless context.
    if (!summaryText.trim()) {
      return {
        messages,
        compacted: false,
        reason: before.reason,
        summary: null,
        archivedCount: 0,
        beforeTurns: before.turnCount,
        beforeTokens: before.tokenCount,
        afterTurns: before.turnCount,
        afterTokens: before.tokenCount,
        error: 'empty summary',
      };
    }
  }

  const summaryMsg = wrapSummaryAsUserMessage(summaryText, { language });

  // Defensive pair-sanitize: the cut at `cutIdx` lands at a user-message
  // boundary so an `[assistant(toolCalls), tool…]` arc is not split, but
  // we still run `pairSanitize` over the tail as belt-and-suspenders —
  // it idempotently drops any orphan tool messages, and any assistant
  // whose tool_use IDs aren't fully matched in the tail. This is what
  // keeps the next adapter call from 400-ing on tool_use/tool_result
  // mismatch when the storage / fan-out layer reorders messages.
  const compactedTail = compactRetainedTailToolCalls(tail, {
    keepToolTurns,
    toolCallCompactThreshold,
  });
  const safeTail = pairSanitize(compactedTail);

  const newMessages = [summaryMsg, ...safeTail];
  const after = shouldCompactHistory(newMessages, triggerOpts);

  return {
    messages: newMessages,
    compacted: true,
    reason: before.reason,
    summary: summaryText,
    archivedCount: archived.length,
    beforeTurns: before.turnCount,
    beforeTokens: before.tokenCount,
    afterTurns: after.turnCount,
    afterTokens: after.tokenCount,
  };
}

/**
 * Trim a snapshot of conversation messages so the per-call array fed
 * to `engine.query` stays bounded.
 *
 * Two-stage policy:
 *   1. **Turn cap** — keep at most `recentTurnCap` turns (default 25)
 *      via `sliceLastNTurns`. This always cuts at a user-message
 *      boundary and walks forward through `@vp-X` variants of the
 *      cut turn so the slice is pair-safe.
 *   2. **Token budget** — if the trimmed slice still exceeds
 *      `messageTokenBudget` tokens (default 32768 from
 *      `~/.yeaft/config.json`), iteratively drop the oldest turn until
 *      we're under budget. We never drop below 1 turn — even a single
 *      huge turn is preferable to no context.
 *
 * Then run `pairSanitize` as belt-and-suspenders to drop any orphan
 * tool_use/tool_result that survived the cuts. The transform is
 * idempotent and never mutates the input.
 *
 * Why this exists:
 *   `runVpTurn` previously fed the entire `conversationMessages` array
 *   into `engine.query` for every fan-out. With multi-VP turns the
 *   array grows ~5–8 messages per user prompt, so after a few hundred
 *   prompts the per-call payload exceeds 100 KB and routinely OOMs the
 *   provider's context window. `compactHistory` only fires above its
 *   token soft floor — small chats with many turns stay below that
 *   floor but still bloat the messages array. This trim is the second-
 *   line defense: it ALWAYS runs, before every query, regardless of
 *   compact state.
 *
 * Lives in `history-compact.js` alongside `compactHistory` because
 * both functions are part of the same "bound the messages array fed
 * to the LLM" surface — keeping them together makes the relationship
 * between trim (per-call) and compact (global) explicit.
 *
 * @param {Array<object>} snapshot
 * @param {{ messageTokenBudget?: number, recentTurnCap?: number, keepToolTurns?: number, language?: string }} [opts]
 * @returns {Array<object>}
 */
export function trimSnapshotForBudget(snapshot, opts = {}) {
  if (!Array.isArray(snapshot) || snapshot.length === 0) return [];

  const recentTurnCap = Number.isFinite(opts.recentTurnCap) && opts.recentTurnCap > 0
    ? opts.recentTurnCap
    : DEFAULT_RECENT_TURN_CAP;
  const messageTokenBudget = Number.isFinite(opts.messageTokenBudget) && opts.messageTokenBudget > 0
    ? opts.messageTokenBudget
    : DEFAULT_MESSAGE_TOKEN_BUDGET;

  // Stage 1: cap by turn count.
  let trimmed = sliceLastNTurns(snapshot, recentTurnCap);

  // Stage 2: cap by token budget. Drop oldest turn iteratively.
  // We never drop below ~1 turn — pick a safety floor of 1.
  let remainingTurnCap = recentTurnCap;
  let tokens = estimateMessagesTokens(trimmed);
  while (tokens > messageTokenBudget && remainingTurnCap > 1) {
    remainingTurnCap--;
    trimmed = sliceLastNTurns(trimmed, remainingTurnCap);
    tokens = estimateMessagesTokens(trimmed);
  }

  // Stage 3: keep only the recent tool chains lossless. Older turns
  // retain text but drop tool_use/tool_result noise before pair safety.
  trimmed = stripToolNoiseFromOlderTurns(trimmed, {
    keepToolTurns: opts.keepToolTurns,
  });

  // Stage 4: bound the raw tool result copy that is fed back into the model.
  // The in-memory/persisted transcript keeps the full content; this transform
  // only affects the per-query snapshot passed to engine.query().
  trimmed = truncateToolResultsForModel(trimmed, { language: opts.language });

  // Stage 5: pair-sanitize to drop orphan tool_use/tool_result.
  return pairSanitize(trimmed);
}
