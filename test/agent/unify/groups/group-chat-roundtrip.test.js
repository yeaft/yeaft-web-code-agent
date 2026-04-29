/**
 * group-chat-roundtrip.test.js — GC.3.
 *
 * Integration test for the Unify group-chat dispatch round-trip:
 *
 *   user posts text
 *     → coordinator.ingest() persists + classifies via pre-flow
 *     → captured envelopes drive a stub Engine in parallel
 *     → each VP turn gets its own scope-isolated FTS recall
 *     → AbortController fans out to every in-flight turn
 *
 * The real `handleUnifyGroupChat` is a thin shell over the same pieces:
 *   open group → coord.ingest → for each captured envelope, call
 *   handleUnifyChat in Promise.all. We exercise the load-bearing
 *   coordination here with the real `createCoordinator`, the real
 *   `createGroup` on a tmp ~/.yeaft, and the real `runMemoryPreflow`
 *   over a real SQLite FTS5 index — but stub the LLM call (handleUnifyChat
 *   pulls in adapters/config we don't need).
 *
 * Scenarios:
 *   1. single mention dispatch
 *   2. multi-VP parallel fan-out
 *   3. @all broadcast capped by perGroupFanOut
 *   4. fallback to defaultVpId
 *   5. empty roster → no_default_vp error (auto-heal happens upstream
 *      in handleUnifyGroupChat; coordinator alone reports the error)
 *   6. VP-author no-op (route_forward owns VP→VP)
 *   7. memory pre-injection per VP — alice gets vp/alice; not vp/bob
 *   8. abort cancels every parallel turn
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createGroup } from '../../../../agent/unify/groups/group-store.js';
import { createCoordinator } from '../../../../agent/unify/groups/coordinator.js';
import { runMemoryPreflow } from '../../../../agent/unify/groups/pre-flow.js';
import { openSegmentIndex } from '../../../../agent/unify/memory/index-db.js';
import { makeSegment } from '../../../../agent/unify/memory/segment.js';

let TEST_DIR;
let groupsRoot;
let idx;

beforeEach(() => {
  TEST_DIR = mkdtempSync(join(tmpdir(), 'gc3-'));
  groupsRoot = join(TEST_DIR, 'groups');
  idx = openSegmentIndex(join(TEST_DIR, 'idx.db'));
});

afterEach(() => {
  try { idx.close(); } catch { /* */ }
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* */ }
});

/**
 * Build a stub "engine.query"-like fan-out: take the captured deliver
 * envelopes from coordinator and run a parallel Promise.all over them,
 * collecting per-VP turn records.
 */
async function fanOut(captured, runTurn) {
  return Promise.all(captured.map(({ vpId, envelope }) => runTurn(vpId, envelope)));
}

describe('group-chat round-trip', () => {
  it('1. single mention: coordinator dispatches one envelope, parallel fan-out invokes one turn', async () => {
    createGroup(groupsRoot, {
      id: 'g1', name: 'g1', roster: ['alice', 'bob'], defaultVpId: 'alice',
    });
    const { openGroup } = await import('../../../../agent/unify/groups/group-store.js');
    const group = openGroup(groupsRoot, 'g1');

    const captured = [];
    const coord = createCoordinator(group, {
      deliver: (vpId, envelope) => captured.push({ vpId, envelope }),
    });
    const report = coord.ingest({ from: 'user', role: 'user', text: '@alice hi' });

    expect(report.dispatched).toEqual(['alice']);
    expect(captured).toHaveLength(1);
    expect(captured[0].vpId).toBe('alice');

    const turns = [];
    await fanOut(captured, async (vpId, envelope) => {
      turns.push({ vpId, trigger: envelope.trigger });
    });
    expect(turns).toEqual([{ vpId: 'alice', trigger: 'mention' }]);
  });

  it('2. multi-VP: parallel fan-out runs concurrently (wall-clock < sum)', async () => {
    createGroup(groupsRoot, {
      id: 'g1', name: 'g1', roster: ['alice', 'bob'], defaultVpId: 'alice',
    });
    const { openGroup } = await import('../../../../agent/unify/groups/group-store.js');
    const group = openGroup(groupsRoot, 'g1');

    const captured = [];
    const coord = createCoordinator(group, {
      deliver: (vpId, envelope) => captured.push({ vpId, envelope }),
    });
    coord.ingest({ from: 'user', role: 'user', text: '@alice @bob hi' });

    expect(captured.map(c => c.vpId)).toEqual(['alice', 'bob']);

    // Simulate two slow turns. Serial would be ~200ms; parallel should
    // be ~100ms (we leave generous slack for CI: < 180ms).
    const PER_TURN_MS = 100;
    const start = Date.now();
    await fanOut(captured, async () => {
      await new Promise(r => setTimeout(r, PER_TURN_MS));
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(PER_TURN_MS * 1.8);
  });

  it('3. @all broadcast respects perGroupFanOut cap', async () => {
    createGroup(groupsRoot, {
      id: 'g1', name: 'g1',
      roster: ['a', 'b', 'c', 'd', 'e'],
      defaultVpId: 'a',
    });
    const { openGroup } = await import('../../../../agent/unify/groups/group-store.js');
    const group = openGroup(groupsRoot, 'g1');

    const captured = [];
    const coord = createCoordinator(group, {
      deliver: (vpId, envelope) => captured.push({ vpId, envelope }),
      perGroupFanOut: 2,
    });
    const report = coord.ingest({ from: 'user', role: 'user', text: '@all standup' });

    expect(captured).toHaveLength(2);
    expect(report.broadcast).toBe(true);
    expect(report.truncatedAtFanOutCap).toBe(true);
  });

  it('4. no mention falls back to defaultVpId', async () => {
    createGroup(groupsRoot, {
      id: 'g1', name: 'g1', roster: ['alice', 'bob'], defaultVpId: 'alice',
    });
    const { openGroup } = await import('../../../../agent/unify/groups/group-store.js');
    const group = openGroup(groupsRoot, 'g1');

    const captured = [];
    const coord = createCoordinator(group, {
      deliver: (vpId, envelope) => captured.push({ vpId, envelope }),
    });
    const report = coord.ingest({ from: 'user', role: 'user', text: 'hello group' });

    expect(report.fallback).toBe('alice');
    expect(captured.map(c => c.vpId)).toEqual(['alice']);
    expect(captured[0].envelope.trigger).toBe('fallback');
  });

  it('5. empty roster + no defaultVpId → no_default_vp, no dispatch', async () => {
    createGroup(groupsRoot, {
      id: 'g1', name: 'g1', roster: [], defaultVpId: null,
    });
    const { openGroup } = await import('../../../../agent/unify/groups/group-store.js');
    const group = openGroup(groupsRoot, 'g1');

    const captured = [];
    const coord = createCoordinator(group, {
      deliver: (vpId, envelope) => captured.push({ vpId, envelope }),
    });
    const report = coord.ingest({ from: 'user', role: 'user', text: 'no one home' });

    expect(captured).toEqual([]);
    expect(report.dispatched).toEqual([]);
    expect(report.errors).toEqual([{ error: 'no_default_vp' }]);
  });

  it('6. VP-author message: persisted but never dispatched (route_forward owns VP→VP)', async () => {
    createGroup(groupsRoot, {
      id: 'g1', name: 'g1', roster: ['alice', 'bob'], defaultVpId: 'alice',
    });
    const { openGroup } = await import('../../../../agent/unify/groups/group-store.js');
    const group = openGroup(groupsRoot, 'g1');

    const captured = [];
    const coord = createCoordinator(group, {
      deliver: (vpId, envelope) => captured.push({ vpId, envelope }),
    });
    const report = coord.ingest({ from: 'alice', role: 'assistant', text: '@bob fyi' });

    expect(captured).toEqual([]);
    expect(report.skipped).toBe('vp-author-no-text-routing');
    // Audit log still gets the message.
    expect(report.message).toBeTruthy();
    expect(report.message.from).toBe('alice');
  });

  it('7. memory pre-injection per VP: alice sees vp/alice, bob sees vp/bob — never the other', async () => {
    createGroup(groupsRoot, {
      id: 'g1', name: 'g1', roster: ['alice', 'bob'], defaultVpId: 'alice',
    });
    const { openGroup } = await import('../../../../agent/unify/groups/group-store.js');
    const group = openGroup(groupsRoot, 'g1');

    idx.upsert(makeSegment({
      scope: 'user', kind: 'fact', tags: ['profile'],
      body: 'User loves jwt-based authentication.',
    }));
    idx.upsert(makeSegment({
      scope: 'vp/alice', kind: 'fact', tags: ['auth'],
      body: 'Alice prefers refresh tokens with jwt.',
    }));
    idx.upsert(makeSegment({
      scope: 'vp/bob', kind: 'fact', tags: ['auth'],
      body: 'Bob hates jwt; prefers session cookies.',
    }));

    const captured = [];
    const coord = createCoordinator(group, {
      deliver: (vpId, envelope) => captured.push({ vpId, envelope }),
    });
    coord.ingest({ from: 'user', role: 'user', text: '@alice @bob how should we do jwt auth?' });

    // Drive each captured turn through pre-flow with VP-scoped recall —
    // mirrors how engine.#recallMemory invokes runMemoryPreflow per turn.
    const recalls = await fanOut(captured, async (vpId, envelope) => {
      const recall = runMemoryPreflow(idx, {
        userMsg: envelope.msg.text,
        groupId: 'g1',
        vpId,
      });
      return { vpId, scopes: recall.entries.map(e => e.scope), formatted: recall.formatted };
    });

    const alice = recalls.find(r => r.vpId === 'alice');
    const bob = recalls.find(r => r.vpId === 'bob');

    expect(alice.scopes).toContain('vp/alice');
    expect(alice.scopes).not.toContain('vp/bob');
    expect(alice.formatted).not.toContain('Bob hates');

    expect(bob.scopes).toContain('vp/bob');
    expect(bob.scopes).not.toContain('vp/alice');
    expect(bob.formatted).not.toContain('refresh tokens');
  });

  it('8. abort cancels every parallel turn (each VP gets its own AbortSignal)', async () => {
    createGroup(groupsRoot, {
      id: 'g1', name: 'g1', roster: ['alice', 'bob'], defaultVpId: 'alice',
    });
    const { openGroup } = await import('../../../../agent/unify/groups/group-store.js');
    const group = openGroup(groupsRoot, 'g1');

    const captured = [];
    const coord = createCoordinator(group, {
      deliver: (vpId, envelope) => captured.push({ vpId, envelope }),
    });
    coord.ingest({ from: 'user', role: 'user', text: '@alice @bob hi' });

    // Per-turn AbortControllers, all wired to one session-level abort.
    const controllers = captured.map(() => new AbortController());
    const aborted = [];

    const turns = fanOut(captured, async (vpId, _env) => {
      const ctrl = controllers[captured.findIndex(c => c.vpId === vpId)];
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 1000);
          ctrl.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          });
        });
      } catch (err) {
        aborted.push({ vpId, reason: err.message });
      }
    });

    // Session abort: fan out to every controller (mirrors handleUnifyAbortAll).
    setTimeout(() => { for (const c of controllers) c.abort(); }, 20);

    await turns;
    expect(aborted.map(a => a.vpId).sort()).toEqual(['alice', 'bob']);
  });
});
