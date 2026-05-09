/**
 * per-group-history-isolation.test.js
 *
 * Pins the per-group history-isolation contract that lives on GroupContext.
 *
 * Pre-refactor: web-bridge owned a single module-level `conversationMessages`
 * array shared across every group. A user message in group-A would land in
 * the array, then a user message in group-B would land in the same array,
 * and group-B's next turn would see group-A's prompt as part of its
 * `messages` snapshot. Disk was group-tagged correctly (groupId field on
 * each m{seq}.md), but the in-memory tape was unified — so within a single
 * agent process, switching groups leaked history.
 *
 * Post-refactor: GroupContext owns per-group `history`. Group-A and
 * group-B each have their own array; switching groups never bleeds.
 *
 * The test drives the bridge via `__testGroupHistory(groupId)` to read
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
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  __testGroupHistory,
  __testResetVpState,
} from '../../../agent/unify/web-bridge.js';

afterEach(async () => {
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
});
