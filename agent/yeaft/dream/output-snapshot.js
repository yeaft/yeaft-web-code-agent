/**
 * dream/output-snapshot.js.
 *
 * Read-only projection of Dream-owned output files for UI observability.
 * The Dream write path remains `runner -> apply -> memory/store`; callers use
 * this module to load the current `memory.md` / `summary.md` contents for a
 * single Yeaft session when emitting status or restoring a switched session.
 */

import { join } from 'node:path';

import { readMemory, readSummary } from '../memory/store.js';
import { readDreamError, readSessionState } from './state.js';
import { buildRunDreamOpts } from './session-wiring.js';

export const DREAM_SNAPSHOT_TEXT_LIMIT = 6000;

export function truncateDreamText(value, limit = DREAM_SNAPSHOT_TEXT_LIMIT) {
  const text = typeof value === 'string' ? value : '';
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true };
}

/**
 * Build the loadable Dream output for one Yeaft session.
 *
 * @param {{ yeaftDir?: string|null }} sessionLike
 * @param {string} sessionId
 * @returns {Promise<object|null>}
 */
export async function buildDreamOutputSnapshot(sessionLike, sessionId) {
  if (!sessionId || !sessionLike?.yeaftDir) return null;
  const scope = `sessions/${sessionId}`;
  const memoryScope = { kind: 'session', id: sessionId };
  const root = join(sessionLike.yeaftDir, 'memory');
  const [memoryRaw, summaryRaw, state, lastError] = await Promise.all([
    readMemory(memoryScope, { root }).catch(() => ''),
    readSummary(memoryScope, { root }).catch(() => ''),
    readSessionState(root, sessionId).catch(() => ({
      lastDreamMessageId: null,
      lastDreamAt: null,
      messageCount: 0,
    })),
    readDreamError(root, scope).catch(() => null),
  ]);
  const totalMessageCount = await countSessionMessages(sessionLike, sessionId);
  const memory = truncateDreamText(memoryRaw);
  const summary = truncateDreamText(summaryRaw);
  return {
    scope,
    sessionId,
    loadedAt: new Date().toISOString(),
    lastDreamAt: state?.lastDreamAt || null,
    lastDreamMessageId: state?.lastDreamMessageId || null,
    messageCount: Number.isFinite(state?.messageCount) ? state.messageCount : 0,
    totalMessageCount,
    hasOutput: !!(memoryRaw || summaryRaw),
    lastError,
    memoryText: memory.text,
    memoryTruncated: memory.truncated,
    summaryText: summary.text,
    summaryTruncated: summary.truncated,
  };
}

async function countSessionMessages(sessionLike, sessionId) {
  try {
    const opts = buildRunDreamOpts({
      yeaftDir: sessionLike.yeaftDir,
      config: sessionLike.config || {},
      adapter: { call: async () => ({ text: '', usage: {} }) },
    });
    const n = await opts.countMessages(sessionId);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}
