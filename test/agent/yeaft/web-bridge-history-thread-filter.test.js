/**
 * web-bridge-history-thread-filter.test.js — pins Bug #1 from user report
 * 2026-06-10: "依旧没法加载历史的message发送到LLM中".
 *
 * REGRESSION:
 *   web-bridge.js#ensureDriverRunning() used to filter the in-memory
 *   session history to keep only messages whose `threadId` was the
 *   current thread's id (or 'main' for legacy rows):
 *
 *       getOrCreateSessionHistory(sessionId)
 *         .filter(m => !m.threadId || m.threadId === 'main' ||
 *                      m.threadId === thread.threadId)
 *
 *   Every new user turn allocates a fresh `thr_*` id via createThreadId(),
 *   so this filter dropped EVERY prior thread's messages. The LLM saw a
 *   1-message context (just the new prompt) for every turn after the
 *   first. Disk-side `loadSessionHistoryForVp` did NOT apply this filter,
 *   so the in-memory `getOrCreateSessionHistory` (which hydrates from
 *   disk) returned the right messages — but the call-site filter then
 *   threw them away.
 *
 * CONTRACT PINNED:
 *   The session-history snapshot used to build the LLM payload MUST
 *   include messages from every prior thread of the same session.
 *   Threads represent intra-VP CONCURRENT tasks (e.g. one VP working on
 *   two parallel topics), NOT isolated conversations. VP-isolation is
 *   the only filter we apply (via filterSnapshotForVp).
 *
 *   This test seeds disk with messages tagged with three different
 *   `threadId`s for the same (session, vp), then asserts that the
 *   hydrated `__testGroupHistory(sessionId)` snapshot fed through
 *   `filterSnapshotForVp(snapshot, vpId)` contains all three threads'
 *   messages — proving the LLM payload would see the full history.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  __testGroupHistory,
  __testResetVpState,
  __testSetSession,
} from '../../../agent/yeaft/web-bridge.js';
import { filterSnapshotForVp } from '../../../agent/yeaft/snapshot-filter.js';
import { ConversationStore } from '../../../agent/yeaft/conversation/persist.js';

afterEach(async () => {
  __testSetSession(null);
  await __testResetVpState();
});

describe('web-bridge history snapshot — Bug #1 regression', () => {
  it('hydrated snapshot contains messages from every prior thread', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-thread-filter-bug-'));
    try {
      const store = new ConversationStore(dir);
      const sessionId = 'grp_threadbug';
      const vpId = 'vp-alpha';

      // Seed: three prior turns, each on a different thread id, plus a
      // brand-new turn on a fresh thread. This is what the disk looks
      // like after several user prompts: every prompt's reply forms a
      // new `thr_*` id.
      store.append({
        role: 'user',
        content: 'first prompt',
        sessionId,
        threadId: 'thr_t1_aaaaaaaa',
      });
      store.append({
        role: 'assistant',
        content: 'first reply',
        sessionId,
        speakerVpId: vpId,
        threadId: 'thr_t1_aaaaaaaa',
      });
      store.append({
        role: 'user',
        content: 'second prompt',
        sessionId,
        threadId: 'thr_t2_bbbbbbbb',
      });
      store.append({
        role: 'assistant',
        content: 'second reply',
        sessionId,
        speakerVpId: vpId,
        threadId: 'thr_t2_bbbbbbbb',
      });
      store.append({
        role: 'user',
        content: 'third prompt (just received)',
        sessionId,
        threadId: 'thr_t3_cccccccc',
      });

      __testSetSession({ conversationStore: store });

      // Build the snapshot the same way ensureDriverRunning does:
      // hydrate from disk via getOrCreateSessionHistory, then pass
      // through filterSnapshotForVp. The bug was an additional
      // `.filter(threadId === current)` in between — the fix removes it.
      const hydrated = __testGroupHistory(sessionId);
      const snapshot = filterSnapshotForVp(hydrated, vpId);

      const contents = snapshot.map((m) => m.content);
      // Every prior thread's user prompts AND the vp's own replies MUST
      // be present — proving the LLM payload sees full history.
      expect(contents).toContain('first prompt');
      expect(contents).toContain('first reply');
      expect(contents).toContain('second prompt');
      expect(contents).toContain('second reply');
      expect(contents).toContain('third prompt (just received)');

      // The pre-fix filter would have returned ONLY messages whose
      // threadId matched the in-flight thread (here `thr_t3_cccccccc`)
      // — i.e. a 1-message context (just the third prompt). Exact-
      // count assertion (5 = 3 user prompts + 2 vp replies) catches
      // both directions of regression: under-count (filter creeps
      // back) AND over-count (engine-private rows leaking in).
      expect(snapshot.length).toBe(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('filterSnapshotForVp does not itself filter by threadId', () => {
    // Belt-and-braces: confirm the VP-isolation filter is thread-agnostic
    // — the responsibility for thread-level filtering, if ever needed,
    // belongs at the call site, not in filterSnapshotForVp. This locks
    // down the architectural boundary so a future refactor can't reverse
    // the bug by quietly threading threadId into the filter.
    const snapshot = [
      { role: 'user', content: 'A', threadId: 'thr_aaa' },
      { role: 'assistant', content: 'A-reply', speakerVpId: 'vp1', threadId: 'thr_aaa' },
      { role: 'user', content: 'B', threadId: 'thr_bbb' },
      { role: 'assistant', content: 'B-reply', speakerVpId: 'vp1', threadId: 'thr_bbb' },
    ];
    const out = filterSnapshotForVp(snapshot, 'vp1');
    expect(out.map((m) => m.content)).toEqual(['A', 'A-reply', 'B', 'B-reply']);
  });
});
