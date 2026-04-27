/**
 * compact/orchestrator.js — DESIGN.md §4.2.
 *
 * One trigger, one pass, three tracks. The orchestrator owns the
 * sequencing; the actual LLM-driven summarisation and extraction are
 * supplied as injectables so this file stays small, deterministic, and
 * testable without network.
 *
 * Track 1 — message compaction (always runs):
 *   1. Find the cooling turn-groups (older than the hot window).
 *   2. Generate a `compact_summary` of those groups.
 *   3. Archive each cooling group atomically; replace it in the live
 *      messages array with a single placeholder message.
 *
 * Track 2 — task summary refresh (when `taskId` is provided):
 *   4. Refresh `tasks/<tid>/summary.md` from the cooling groups + the
 *      prior summary. Atomic via the existing `writeSummary` helper.
 *
 * Track 3 — memory extraction (always runs):
 *   5. Extract durable facts/lessons/preferences and write them as
 *      scope entries through the supplied `extract` callback. The
 *      callback owns scope routing and `index.md` upserts; this file
 *      just hands it the cooling groups.
 *
 * Atomicity rule (§9.2): each cooling turn-group is archived as a
 * unit. We never break a `[user, assistant(toolCalls), tool…]` triple.
 * Track 1 is the only place that mutates `messages`.
 */

import { groupTurns, pickCoolingGroups, indicesFromGroups } from './turn-group.js';
import { writeSummary } from '../memory/scope-tree.js';

/**
 * @typedef {{
 *   summarise: (coolingMessages: object[]) => Promise<string>,
 *   archive: (groupIndex: number, coolingMessages: object[]) => Promise<{ turnId: string }>,
 *   extract?: (coolingMessages: object[]) => Promise<{ written: number }>,
 *   refreshTaskSummary?: (coolingMessages: object[], priorSummary: string) => Promise<string>,
 *   readPriorTaskSummary?: () => Promise<string>,
 * }} CompactHooks
 */

/**
 * @param {{
 *   messages: object[],
 *   keepHot?: number,
 *   taskId?: string | null,
 *   root?: string,
 *   hooks: CompactHooks,
 * }} args
 * @returns {Promise<{
 *   archivedGroups: number,
 *   archivedMessages: number,
 *   compactSummary: string,
 *   extractedCount: number,
 *   taskSummaryRefreshed: boolean,
 *   nextMessages: object[],
 * }>}
 */
export async function runCompact({ messages, keepHot = 10, taskId = null, root, hooks }) {
  if (!Array.isArray(messages)) {
    throw new Error('runCompact: messages array required');
  }
  if (!hooks || typeof hooks !== 'object') {
    throw new Error('runCompact: hooks required');
  }
  if (typeof hooks.summarise !== 'function') {
    throw new Error('runCompact: hooks.summarise required');
  }
  if (typeof hooks.archive !== 'function') {
    throw new Error('runCompact: hooks.archive required');
  }

  const groups = groupTurns(messages);
  const { hot, cooling } = pickCoolingGroups(groups, keepHot);

  // Nothing to compact — return early. We still report `nextMessages` so
  // callers can treat the result uniformly (no copy unless we changed
  // anything).
  if (cooling.length === 0) {
    return {
      archivedGroups: 0,
      archivedMessages: 0,
      compactSummary: '',
      extractedCount: 0,
      taskSummaryRefreshed: false,
      nextMessages: messages,
    };
  }

  // Slice out the cooling messages once for the summariser/extractor.
  const coolingIdx = indicesFromGroups(cooling);
  const coolingMessages = coolingIdx.map(i => messages[i]);

  // Track 1.2 — summarise.
  const compactSummary = await hooks.summarise(coolingMessages);

  // Track 1.3 — archive each cooling group atomically.
  const archiveResults = [];
  for (let i = 0; i < cooling.length; i += 1) {
    const g = cooling[i];
    const groupMsgs = messages.slice(g.start, g.end);
    const r = await hooks.archive(i, groupMsgs);
    archiveResults.push({ ...g, turnId: r?.turnId });
  }

  // Track 2 — refresh task summary if applicable.
  let taskSummaryRefreshed = false;
  if (taskId && root && typeof hooks.refreshTaskSummary === 'function') {
    const prior = typeof hooks.readPriorTaskSummary === 'function'
      ? await hooks.readPriorTaskSummary() : '';
    const next = await hooks.refreshTaskSummary(coolingMessages, prior);
    if (typeof next === 'string' && next.trim()) {
      await writeSummary({ kind: 'task', id: taskId }, next, { root });
      taskSummaryRefreshed = true;
    }
  }

  // Track 3 — memory extraction.
  let extractedCount = 0;
  if (typeof hooks.extract === 'function') {
    const extractResult = await hooks.extract(coolingMessages);
    if (extractResult && Number.isFinite(extractResult.written)) {
      extractedCount = extractResult.written;
    }
  }

  // Track 1.3 (cont.) — produce the new messages array with the cooling
  // window replaced by a single `compact_summary` placeholder.
  const placeholder = {
    role: 'system',
    kind: 'compact_summary',
    content: compactSummary || '',
  };
  // Hot starts at the index right after the last cooling group.
  const cutoff = cooling[cooling.length - 1].end;
  const nextMessages = [placeholder, ...messages.slice(cutoff)];

  return {
    archivedGroups: cooling.length,
    archivedMessages: coolingIdx.length,
    compactSummary: compactSummary || '',
    extractedCount,
    taskSummaryRefreshed,
    nextMessages,
  };
}
