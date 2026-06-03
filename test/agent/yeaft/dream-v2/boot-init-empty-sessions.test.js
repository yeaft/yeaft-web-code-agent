/**
 * boot-init-empty-groups.test.js — task-710 boot-time empty-AMS dream.
 *
 * `bootInitEmptyGroups` walks every group on disk, finds the ones with
 * user messages but zero memory segments in the FTS index, and triggers
 * an immediate dream pass scoped to those groups. The test stubs the
 * scheduler + memoryIndex and verifies the routing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bootInitEmptyGroups } from '../../../../agent/yeaft/dream-v2/session-wiring.js';
import { createSession } from '../../../../agent/yeaft/sessions/session-store.js';

let yeaftDir;

beforeEach(() => {
  yeaftDir = mkdtempSync(join(tmpdir(), 'boot-init-'));
});
afterEach(() => {
  rmSync(yeaftDir, { recursive: true, force: true });
});

/** Fake SegmentIndex: only listByScope is exercised. */
function fakeIndex(map) {
  return {
    listByScope: (scope) => map[scope] || [],
  };
}

/** Fake scheduler that records every call. */
function fakeScheduler() {
  const calls = [];
  return {
    triggerDreamForScopes: async (scopeFilter) => { calls.push(scopeFilter); },
    _calls: calls,
  };
}

describe('bootInitEmptyGroups', () => {
  it('returns no-op when memoryIndex is missing', async () => {
    const sched = fakeScheduler();
    const r = await bootInitEmptyGroups({
      yeaftDir, memoryIndex: null, dreamScheduler: sched,
    });
    expect(r.triggered).toEqual([]);
    expect(sched._calls).toEqual([]);
  });

  it('returns no-op when no groups on disk', async () => {
    const sched = fakeScheduler();
    const r = await bootInitEmptyGroups({
      yeaftDir,
      memoryIndex: fakeIndex({}),
      dreamScheduler: sched,
    });
    expect(r.triggered).toEqual([]);
    expect(sched._calls).toEqual([]);
  });

  it('skips groups with zero messages', async () => {
    const sessionsRoot = join(yeaftDir, 'sessions');
    createSession(sessionsRoot, { id: 'empty-grp', roster: [], defaultVpId: null });
    const sched = fakeScheduler();
    const r = await bootInitEmptyGroups({
      yeaftDir,
      memoryIndex: fakeIndex({}), // no segments
      dreamScheduler: sched,
    });
    expect(r.triggered).toEqual([]);
    expect(sched._calls).toEqual([]);
  });

  it('skips groups whose AMS already has segments', async () => {
    const sessionsRoot = join(yeaftDir, 'sessions');
    const h = createSession(sessionsRoot, { id: 'rich-grp', roster: [], defaultVpId: null });
    h.appendMessage({ from: 'user', text: 'hello' });
    const sched = fakeScheduler();
    const r = await bootInitEmptyGroups({
      yeaftDir,
      memoryIndex: fakeIndex({ 'group/rich-grp': [{ id: 'seg_1' }] }),
      dreamScheduler: sched,
    });
    expect(r.triggered).toEqual([]);
    expect(sched._calls).toEqual([]);
  });

  it('triggers a scoped dream pass for groups with messages but no segments', async () => {
    const sessionsRoot = join(yeaftDir, 'sessions');
    const a = createSession(sessionsRoot, { id: 'a', roster: [], defaultVpId: null });
    const b = createSession(sessionsRoot, { id: 'b', roster: [], defaultVpId: null });
    const c = createSession(sessionsRoot, { id: 'c', roster: [], defaultVpId: null });
    a.appendMessage({ from: 'user', text: 'm1' });
    b.appendMessage({ from: 'user', text: 'm1' });
    // c has no messages → must be skipped
    const sched = fakeScheduler();
    const r = await bootInitEmptyGroups({
      yeaftDir,
      memoryIndex: fakeIndex({
        'group/a': [],
        'group/b': [],
        'group/c': [],
      }),
      dreamScheduler: sched,
    });
    // sort to keep assertion order-independent
    expect(r.triggered.sort()).toEqual(['group/a', 'group/b']);
    // Wait for the fire-and-forget Promise to resolve.
    await new Promise(resolve => setImmediate(resolve));
    expect(sched._calls).toHaveLength(1);
    expect(sched._calls[0].sort()).toEqual(['group/a', 'group/b']);
  });

  it('survives a memoryIndex that throws (per-group skip)', async () => {
    const sessionsRoot = join(yeaftDir, 'sessions');
    const a = createSession(sessionsRoot, { id: 'a', roster: [], defaultVpId: null });
    a.appendMessage({ from: 'user', text: 'm1' });
    const sched = fakeScheduler();
    const r = await bootInitEmptyGroups({
      yeaftDir,
      memoryIndex: { listByScope: () => { throw new Error('bad index'); } },
      dreamScheduler: sched,
    });
    expect(r.triggered).toEqual([]);
    expect(sched._calls).toEqual([]);
  });
});
