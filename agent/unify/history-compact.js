/**
 * history-compact.js — In-memory conversation history compaction for the
 * Unify group-chat fan-out path.
 *
 * Problem this solves:
 *   `agent/unify/web-bridge.js` keeps a flat module-level array
 *   `conversationMessages` that grows unbounded across the lifetime of the
 *   agent process. Every fan-out turn snapshots the whole thing into
 *   `baseSnapshot` and feeds it to `engine.query` for every VP. Without a
 *   cap, prompt size and token cost grow linearly with conversation length.
 *
 * Existing infrastructure (`agent/unify/compact/orchestrator.js`,
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
 * Triggers (either fires):
 *   - turn count > 20  (each user message in `conversationMessages` is a turn)
 *   - estimated tokens > 80,000
 *
 * Defaults match the user-stated requirement; both are overridable via the
 * options bag for tests / future config plumbing.
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

/**
 * Default trigger thresholds — match the user's stated policy:
 *   "如果 turn 超过 20 或者 message 上下文超过 80K，那么就 compact"
 */
export const DEFAULT_TURN_LIMIT = 20;
export const DEFAULT_TOKEN_LIMIT = 80_000;

/**
 * How many user→assistant pairs to leave intact at the tail. The summary
 * replaces everything before this window. 2 keeps "what we were just
 * talking about" lossless.
 */
export const DEFAULT_KEEP_RECENT_TURNS = 2;

/**
 * Estimate the token weight of a single message including role overhead
 * and any tool-call structure. Mirrors `dream-v2/segment.js` approach: a
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
 * Strip a leading `@vp-<id> ` mention prefix from a user prompt. The
 * web bridge prefixes each VP's per-turn prompt with `@vp-<id> ` so
 * the engine knows which VP is replying. When counting "turns" we
 * want the user-facing notion of a turn (one round-trip), not one per
 * VP — so we strip the prefix before deduping consecutive identical
 * user messages.
 *
 * Format mirrors `web-bridge.js#runVpTurn`:
 *   `@vp-${vpId} ${text}`
 *
 * @param {string} content
 * @returns {string}
 */
function stripVpMentionPrefix(content) {
  if (typeof content !== 'string') return '';
  return content.replace(/^@vp-[^\s]+\s+/, '');
}

/**
 * Count "turns" — defined as a user-side round-trip, NOT one per
 * user-role message. Multi-VP fan-out appends one user message per VP
 * (each with an `@vp-<id>` prefix) for the same underlying user prompt;
 * those collapse into a single turn here.
 *
 * Algorithm: walk user-role messages, strip the `@vp-` prefix, count
 * a turn whenever the canonical text changes from the previous user
 * message (or it's the first one).
 *
 * @param {Array<object>} messages
 * @returns {number}
 */
export function countTurns(messages) {
  if (!Array.isArray(messages)) return 0;
  let n = 0;
  let prev = null;
  for (const m of messages) {
    if (!m || m.role !== 'user') continue;
    const canonical = stripVpMentionPrefix(m.content || '');
    if (canonical !== prev) {
      n++;
      prev = canonical;
    }
  }
  return n;
}

/**
 * Pure trigger evaluator. Decides whether the in-memory history needs
 * compaction. No I/O, no LLM call.
 *
 * @param {Array<object>} messages
 * @param {{turnLimit?: number, tokenLimit?: number}} [opts]
 * @returns {{trigger: boolean, reason: 'turn_count'|'token_threshold'|null,
 *            turnCount: number, tokenCount: number,
 *            turnLimit: number, tokenLimit: number}}
 */
export function shouldCompactHistory(messages, opts = {}) {
  const turnLimit = opts.turnLimit ?? DEFAULT_TURN_LIMIT;
  const tokenLimit = opts.tokenLimit ?? DEFAULT_TOKEN_LIMIT;
  const turnCount = countTurns(messages);
  const tokenCount = estimateMessagesTokens(messages);

  let reason = null;
  if (turnCount > turnLimit) reason = 'turn_count';
  else if (tokenCount > tokenLimit) reason = 'token_threshold';

  return {
    trigger: reason !== null,
    reason,
    turnCount,
    tokenCount,
    turnLimit,
    tokenLimit,
  };
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
 * Strategy: walk from the END backwards counting user messages; stop after
 * we've passed `keepRecent` of them. The cut is at that user message's
 * index. If there aren't enough turns to fold (history shorter than
 * keepRecent), returns -1 (caller treats as no-op).
 *
 * @param {Array<object>} messages
 * @param {number} keepRecent
 * @returns {number}
 */
export function findCutIndex(messages, keepRecent) {
  if (!Array.isArray(messages) || messages.length === 0) return -1;
  if (keepRecent <= 0) return messages.length; // fold everything

  // Walk from the end, counting DISTINCT turns (multiple consecutive
  // user messages with the same canonical text — i.e. one fan-out's
  // @vp-X variants — collapse into a single turn). Stop when we've
  // started the (keepRecent)-th turn from the end; everything before
  // its first user-message gets folded.
  let turnsFromEnd = 0;
  let nextCanonical = null; // canonical text of the turn we just opened
  let candidateIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!messages[i] || messages[i].role !== 'user') continue;
    const canonical = stripVpMentionPrefix(messages[i].content || '');
    if (canonical !== nextCanonical) {
      // New (older) turn boundary.
      turnsFromEnd++;
      nextCanonical = canonical;
      if (turnsFromEnd === keepRecent) {
        candidateIdx = i;
        // Keep walking — the same turn might extend further back via
        // earlier @vp variants of the same canonical text.
        continue;
      }
      if (turnsFromEnd > keepRecent) {
        // We've stepped into the (keepRecent+1)-th turn — stop. The
        // last recorded `candidateIdx` is the start of the LAST
        // keepRecent block.
        break;
      }
    } else if (turnsFromEnd === keepRecent) {
      // Same canonical text as the keepRecent-th-from-end turn — this
      // is an earlier @vp-variant of that same turn. Extend candidate
      // backwards to include it.
      candidateIdx = i;
    }
  }
  return candidateIdx;
}

/**
 * Wrap a summary string into the canonical "session continued" recovery
 * message. The wording is deliberately close to Claude Code's compact
 * marker so frontend filters (already in `web/stores/helpers/claudeOutput.js`,
 * `server/db/message-db.js`) recognise it.
 *
 * @param {string} summary
 * @returns {{role:'user', content:string, _compactSummary: true}}
 */
export function wrapSummaryAsUserMessage(summary) {
  const body = (summary || '').trim() || '(no summary produced)';
  const content =
    'This session is being continued from a previous conversation. ' +
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
 * @param {Array<{role:string, content:string}>} cleanedMessages
 * @returns {{system: string, prompt: string}}
 */
export function buildSummaryPrompt(cleanedMessages) {
  const transcript = cleanedMessages
    .map(m => `[${m.role}]\n${m.content}`)
    .join('\n\n---\n\n');
  const system =
    'You are a conversation summarizer for a multi-agent group chat. ' +
    'Produce a concise (4–8 short bullet points) summary of the conversation ' +
    'so far. Preserve: (1) decisions made, (2) facts learned, (3) the user\'s ' +
    'current goal, (4) any open questions or pending actions, (5) which VPs ' +
    'are participating and what each contributed. Do NOT include raw tool ' +
    'output. Do NOT speculate. Be specific.';
  const prompt =
    'Summarize the following conversation. Output ONLY the summary, no ' +
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
    turnLimit = DEFAULT_TURN_LIMIT,
    tokenLimit = DEFAULT_TOKEN_LIMIT,
  } = options || {};

  if (typeof summarize !== 'function') {
    throw new TypeError('compactHistory: options.summarize must be a function');
  }

  const before = shouldCompactHistory(messages, { turnLimit, tokenLimit });
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
    const { system, prompt } = buildSummaryPrompt(cleaned);
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
  }

  const summaryMsg = wrapSummaryAsUserMessage(summaryText);

  // Defensive: if the tail starts with a `role: 'tool'` message, the
  // adapter will reject it (tool messages must follow an assistant with
  // a matching tool_call). Drop leading tool messages from the tail —
  // their preceding assistant has been folded into the summary, so the
  // tool result is orphaned anyway.
  let tailStart = 0;
  while (tailStart < tail.length && tail[tailStart] && tail[tailStart].role === 'tool') {
    tailStart++;
  }
  const safeTail = tail.slice(tailStart);

  const newMessages = [summaryMsg, ...safeTail];
  const after = shouldCompactHistory(newMessages, { turnLimit, tokenLimit });

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
