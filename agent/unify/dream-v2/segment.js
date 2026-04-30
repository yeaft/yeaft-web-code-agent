/**
 * dream-v2/segment.js.
 *
 * Three independent length-control concerns, kept pure so they can be
 * unit-tested without touching disk or any LLM:
 *
 *   1. truncateMessage — clamp a single message body to
 *      MAX_SINGLE_MESSAGE_CHARS, appending a clear notice. The full
 *      body is still preserved in the conversation log; this only
 *      affects what dream sees. (§17.3)
 *
 *   2. estimateTokens — rough chars-to-tokens approximation (we use 4
 *      chars/token, a stable industry approximation that doesn't drag
 *      a tokenizer into this layer; precise counts aren't required for
 *      "should we segment?" decisions and a small over-count is the
 *      safe direction).
 *
 *   3. segmentDiff — split a long per-group diff into K consecutive
 *      slices, each ≤ MAX_DIFF_TOKENS_PER_TRIAGE, with a 3-message
 *      overlap between adjacent slices for context continuity. (§17.1)
 *
 *   4. needsBatchedApply / batchSourcesForApply — when an Apply target's
 *      memory + summary + sources cumulatively exceed MAX_APPLY_TOKENS,
 *      split the sources (one source = one group's contribution) into
 *      batches; the LLM is then called once per batch, threading the
 *      written-back memory.md as input to the next batch. (§17.2)
 *
 * No side-effects. All functions are deterministic given their inputs.
 */

import {
  MAX_SINGLE_MESSAGE_CHARS,
  MAX_DIFF_TOKENS_PER_TRIAGE,
  MAX_APPLY_TOKENS,
  DREAM_OVERLAP,
} from './limits.js';

const TRUNCATION_NOTICE = '\n\n[message truncated for dream, original preserved in conversation log]';

/**
 * Truncate a single message body if it exceeds the per-message char cap.
 * Idempotent: passing in an already-truncated body returns it unchanged.
 *
 * @param {string} body
 * @returns {string}
 */
export function truncateMessage(body) {
  const s = String(body || '');
  if (s.length <= MAX_SINGLE_MESSAGE_CHARS) return s;
  if (s.endsWith(TRUNCATION_NOTICE)) return s;
  // Reserve room for the notice without overflowing the cap.
  const room = Math.max(0, MAX_SINGLE_MESSAGE_CHARS - TRUNCATION_NOTICE.length);
  return s.slice(0, room) + TRUNCATION_NOTICE;
}

/**
 * Conservative chars-to-tokens approximation. We over-count slightly
 * (1 token ≈ 4 chars) to make MAX_*_TOKENS act as a true upper bound.
 *
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

/**
 * Estimate the token cost of an array of messages (header + body for each).
 * @param {Array<{id?: string, role?: string, body?: string}>} msgs
 */
export function estimateMessagesTokens(msgs) {
  if (!Array.isArray(msgs)) return 0;
  let n = 0;
  for (const m of msgs) {
    n += estimateTokens(m.role || '');
    n += estimateTokens(m.body || '');
    n += 2; // separator overhead
  }
  return n;
}

/**
 * Split a contiguous group diff into ≤MAX-token segments, with a
 * DREAM_OVERLAP-message tail/head overlap between consecutive segments.
 *
 * Returns segments in temporal order. Each segment is `{ messages, kind }`
 * where `kind` is 'overlap' for messages that exist only as continuity
 * preamble (because they appeared in a prior segment), and 'new' for
 * the rest. The first segment has no overlap header.
 *
 * Properties:
 *   - The union of `kind: 'new'` messages across all segments equals
 *     the input diff exactly, in order, with no duplicates.
 *   - Each segment's total token estimate ≤ MAX_DIFF_TOKENS_PER_TRIAGE
 *     unless a single message alone exceeds the cap, in which case
 *     that message gets its own segment (we never split a message).
 *
 * @param {Array<{id?: string, role?: string, body?: string}>} diff
 * @param {number} [maxTokens=MAX_DIFF_TOKENS_PER_TRIAGE]
 * @param {number} [overlap=DREAM_OVERLAP]
 * @returns {Array<{ messages: Array<object>, overlapCount: number, newCount: number }>}
 */
export function segmentDiff(diff, maxTokens = MAX_DIFF_TOKENS_PER_TRIAGE, overlap = DREAM_OVERLAP) {
  const msgs = Array.isArray(diff) ? diff : [];
  if (msgs.length === 0) return [];

  // Fast path: whole diff fits in one segment.
  if (estimateMessagesTokens(msgs) <= maxTokens) {
    return [{ messages: msgs, overlapCount: 0, newCount: msgs.length }];
  }

  const segments = [];
  let cursor = 0;
  while (cursor < msgs.length) {
    const overlapHead = segments.length > 0
      ? msgs.slice(Math.max(0, cursor - overlap), cursor)
      : [];
    let used = estimateMessagesTokens(overlapHead);
    let end = cursor;
    while (end < msgs.length) {
      const cost = estimateTokens(msgs[end].body || '') + estimateTokens(msgs[end].role || '') + 2;
      if (used + cost > maxTokens && end > cursor) break;
      used += cost;
      end += 1;
    }
    // If we made no progress (single oversized message), advance by 1.
    if (end === cursor) end = cursor + 1;
    segments.push({
      messages: [...overlapHead, ...msgs.slice(cursor, end)],
      overlapCount: overlapHead.length,
      newCount: end - cursor,
    });
    cursor = end;
  }
  return segments;
}

// ─── apply batching ───────────────────────────────────────────

/**
 * Decide whether a merged apply target needs to be split into batches.
 *
 * @param {{ memoryMd?: string, summaryMd?: string, sources: Array<{ groupId: string, diff: any }> }} merged
 * @param {number} [maxTokens=MAX_APPLY_TOKENS]
 */
export function needsBatchedApply(merged, maxTokens = MAX_APPLY_TOKENS) {
  return totalApplyTokens(merged) > maxTokens;
}

function totalApplyTokens(merged) {
  let n = estimateTokens(merged.memoryMd || '') + estimateTokens(merged.summaryMd || '');
  for (const src of merged.sources || []) n += estimateMessagesTokens(src.diff || []);
  return n;
}

/**
 * Pack `merged.sources` into ordered batches such that each batch's
 * (memoryMd + summaryMd + that batch's sources) ≤ maxTokens. The first
 * batch uses the original memoryMd; subsequent batches assume the LLM's
 * previous-batch output replaces memoryMd, so we account for the same
 * baseline cost in each batch.
 *
 * If a single source (one group's diff) alone would overflow, it still
 * goes into its own batch — we never split a source diff here (segment
 * happens earlier, in triage).
 *
 * @param {{ memoryMd?: string, summaryMd?: string, sources: Array<{ groupId: string, diff: any }> }} merged
 * @param {number} [maxTokens=MAX_APPLY_TOKENS]
 * @returns {Array<{ groupId: string, diff: any }[]>}
 */
export function batchSourcesForApply(merged, maxTokens = MAX_APPLY_TOKENS) {
  const sources = Array.isArray(merged.sources) ? merged.sources : [];
  if (sources.length === 0) return [];
  const baseline = estimateTokens(merged.memoryMd || '') + estimateTokens(merged.summaryMd || '');
  const batches = [];
  let cur = [];
  let used = baseline;
  for (const src of sources) {
    const cost = estimateMessagesTokens(src.diff || []);
    if (cur.length > 0 && used + cost > maxTokens) {
      batches.push(cur);
      cur = [];
      used = baseline;
    }
    cur.push(src);
    used += cost;
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}
