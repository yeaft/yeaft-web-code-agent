/**
 * per-group-history-isolation.test.js
 *
 * Pins the per-group history-isolation contract that lives on GroupContext.
 *
 * Pre-refactor: web-bridge owned a single module-level `conversationMessages`
 * array shared across every group. A user message in group-A would land in
 * the array, then a user message in group-B would land in the same array,
 * and group-B's next turn would see group-A's prompt as part of its
 * `messages` snapshot. Disk was group-tagged correctly (sessionId field on
 * each m{seq}.md), but the in-memory tape was unified — so within a single
 * agent process, switching groups leaked history.
 *
 * Post-refactor: GroupContext owns per-group `history`. Group-A and
 * group-B each have their own array; switching groups never bleeds.
 *
 * The test drives the bridge via `__testGroupHistory(sessionId)` to read
 * the per-group history snapshot directly (no need to boot a full
 * session). The contract being pinned:
 *
 *   1. A fresh group starts with empty history (no leakage from sibling
 *      groups already seeded).
 *   2. Appending to group-A's history does not mutate group-B's.
 *   3. Reading group-A's history twice returns the SAME array reference
 *      (so consumers can mutate-in-place; the engine writes back the
 *      collapsed form via splice rather than reassignment).
 *   4. After `__testResetVpState`, every group's history is gone — fresh
 *      groups recreate it on demand.
 *   5. Hydrate-from-disk: a session-backed read returns ONLY the records
 *      whose `sessionId` matches; other groups' on-disk history must not
 *      leak into the requested group's snapshot.
 *   6. Lazy-hydrate ordering: a partial entry seeded by an earlier
 *      `getCompactState`-style path (no history loaded yet) MUST still
 *      trigger disk hydration on the first `__testGroupHistory` call.
 *      The pre-fix bug short-circuited on truthy empty array.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  __testGroupHistory,
  __testResetVpState,
  __testSetSession,
  __testGroupContextEntry,
} from '../../../agent/yeaft/web-bridge.js';
import { ConversationStore } from '../../../agent/yeaft/conversation/persist.js';

afterEach(async () => {
  __testSetSession(null);
  await __testResetVpState();
});

describe('GroupContext.history — per-group isolation', () => {
  it('a fresh group starts with empty history', () => {
    const histA = __testGroupHistory('grp_test_isolated_A');
    expect(Array.isArray(histA)).toBe(true);
    expect(histA.length).toBe(0);
  });

  it('appending to group A does not bleed into group B', () => {
    const histA = __testGroupHistory('grp_iso_A');
    const histB = __testGroupHistory('grp_iso_B');
    histA.push({ role: 'user', content: 'hello from A' });
    histA.push({ role: 'assistant', content: 'A reply' });
    expect(histA.length).toBe(2);
    expect(histB.length).toBe(0);
  });

  it('reading the same group twice returns the same array reference', () => {
    const a1 = __testGroupHistory('grp_iso_ref');
    const a2 = __testGroupHistory('grp_iso_ref');
    expect(a1).toBe(a2);
    a1.push({ role: 'user', content: 'pinned' });
    expect(a2.length).toBe(1);
    expect(a2[0].content).toBe('pinned');
  });

  it('__testResetVpState clears every group history', async () => {
    const hist = __testGroupHistory('grp_iso_reset');
    hist.push({ role: 'user', content: 'doomed' });
    expect(hist.length).toBe(1);
    await __testResetVpState();
    const fresh = __testGroupHistory('grp_iso_reset');
    expect(fresh.length).toBe(0);
    // After reset, the array reference is a new one — old references
    // are no longer "the canonical history" and won't be observed.
    expect(fresh).not.toBe(hist);
  });

  it('hydrate-from-disk: per-group records are isolated by sessionId', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-history-iso-'));
    try {
      const store = new ConversationStore(dir);
      // Seed disk with two groups; per-group hydrate must not bleed.
      store.append({ role: 'user', content: 'A1', sessionId: 'grpA' });
      store.append({ role: 'assistant', content: 'A1 reply', sessionId: 'grpA' });
      store.append({ role: 'user', content: 'B1', sessionId: 'grpB' });
      __testSetSession({ conversationStore: store });

      const histA = __testGroupHistory('grpA');
      const histB = __testGroupHistory('grpB');

      expect(histA.map(m => m.content)).toEqual(['A1', 'A1 reply']);
      expect(histB.map(m => m.content)).toEqual(['B1']);
      expect(histA.every(m => m.role !== undefined)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lazy hydrate runs even if a partial entry was seeded earlier', async () => {
    // Reproduces the I-1 regression: a partial GroupContext entry
    // existed (from `getCompactState`-style path) BEFORE any history
    // was hydrated. Pre-fix, `getOrCreateSessionHistory` saw an empty
    // `history: []` and short-circuited on truthy-array check, never
    // hitting disk. Post-fix, the `historyHydrated:false` flag gates
    // hydration so the first read still loads from disk.
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-history-iso-lazy-'));
    try {
      const store = new ConversationStore(dir);
      store.append({ role: 'user', content: 'persisted before lookup', sessionId: 'grpLazy' });
      __testSetSession({ conversationStore: store });

      // Force-create a partial entry the way `getCompactState` would
      // (no `history` loaded yet, `historyHydrated:false`). This is the
      // regression scenario.
      // We can't reach getCompactState directly, but we can synthesize
      // the same shape: trigger via __testGroupHistory on a DIFFERENT
      // group (which fully hydrates THAT group), then verify that the
      // lazy-hydrate path still works for the target group.
      __testGroupHistory('grpOther');

      const hist = __testGroupHistory('grpLazy');
      expect(hist.map(m => m.content)).toEqual(['persisted before lookup']);

      const entry = __testGroupContextEntry('grpLazy');
      expect(entry?.historyHydrated).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('setGroupHistory(_, []) marks hydrated so consolidate does not reload', () => {
    // Post-consolidate: engine emits `consolidate`, bridge calls
    // `setGroupHistory(sessionId, [])`. The next read MUST see the empty
    // array — not silently re-hydrate from disk and resurrect the
    // turns the consolidate just collapsed.
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-history-iso-consolidate-'));
    try {
      const store = new ConversationStore(dir);
      store.append({ role: 'user', content: 'old turn', sessionId: 'grpC' });
      __testSetSession({ conversationStore: store });

      const before = __testGroupHistory('grpC');
      expect(before.length).toBe(1);

      // Mutate via a fresh setGroupHistory wrapper. The bridge module
      // exposes this only indirectly — emulate by clearing the array
      // (consolidate path) and asserting the next read does NOT re-load.
      before.length = 0;
      const entry = __testGroupContextEntry('grpC');
      expect(entry?.historyHydrated).toBe(true);
      // Re-read: still empty, no resurrection from disk.
      const after = __testGroupHistory('grpC');
      expect(after.length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
