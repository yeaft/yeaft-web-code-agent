/**
 * PR feat-dream-debug-panel-full — dream_progress event routing.
 *
 * The debug panel's per-group event timeline only works if every
 * dream_progress event reaches the active group's bucket in the
 * frontend store. The runner emits some events without a groupId
 * (start / merge / done — top-level wrap events). Before this PR
 * those events landed in the store's `'*'` bucket and never
 * cross-contaminated the active group's bucket, leaving the panel
 * empty until the next pass.
 *
 * The bridge fix: `handleUnifyDreamTrigger({groupId})` wraps the
 * session's `_dreamProgressSink` for the lifetime of the trigger
 * with a closure that injects the active groupId onto top-level
 * events. The base sink is a pure passthrough. Concurrent scoped
 * triggers for the SAME group are rejected with an error envelope
 * so the wrappers don't race each other.
 *
 * Note: post-review, the bridge no longer mirrors a synthetic
 * `phase:'result'` dream_progress event after `unify_dream_result`.
 * That mirror raced the store's `unifyDreamLatest` projection. The
 * terminal record now comes from the store appending into the ring
 * buffer when it sees `unify_dream_result` — see
 * `test/web/stores/dream-event-ring-buffer-handler.test.js`.
 *
 * This suite pins the stamping + concurrency contracts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const outbound = [];

vi.mock('../../../agent/connection/buffer.js', () => ({
  sendToServer: (msg) => { outbound.push(msg); },
  flushMessageBuffer: () => {},
}));

import {
  handleUnifyDreamTrigger,
  installUnifyRuntimeBridge,
  __testSetSession,
} from '../../../agent/unify/web-bridge.js';

function makeSession(dreamSchedulerOverrides = {}) {
  return {
    dreamScheduler: {
      triggerDreamForScopes: vi.fn(async () => ({
        startedAt: '2026-05-15T08:00:00.000Z',
        targets: [{ target: 'group/g1', status: 'done' }],
      })),
      triggerDreamNow: vi.fn(async () => ({
        startedAt: '2026-05-15T08:00:00.000Z',
        targets: [{ target: 'user', status: 'done' }],
      })),
      ...dreamSchedulerOverrides,
    },
  };
}

function findAll(type) {
  return outbound.filter(m => m && m.type === type);
}

function findProgress() {
  // dream_progress events are wrapped in `unify_output` envelopes with
  // an `event.type === 'dream_progress'` inner payload.
  return outbound
    .filter(m => m && m.type === 'unify_output' && m.event && m.event.type === 'dream_progress')
    .map(m => ({ envelope: m, event: m.event }));
}

beforeEach(() => {
  outbound.length = 0;
  __testSetSession(null);
});

describe('dream_progress event routing', () => {
  it('stamps the active groupId onto events emitted without one during a scoped run', async () => {
    // Wire a real `_dreamProgressSink` via installUnifyRuntimeBridge so
    // we exercise the production sink, not a stub. The scheduler mock
    // emits events through that sink as the runner would.
    const session = makeSession({
      triggerDreamForScopes: vi.fn(async () => {
        // Simulate runner-style events: start (no groupId), one
        // per-group event WITH groupId, then merge + done (no groupId).
        session._dreamProgressSink({ phase: 'start', manual: true, ts: 1 });
        session._dreamProgressSink({ phase: 'load-diff', groupId: 'g1' });
        session._dreamProgressSink({ phase: 'merge', targets: 1 });
        session._dreamProgressSink({ phase: 'done', groups: 1, targets: 1, duration: 42 });
        return {
          startedAt: '2026-05-15T08:00:00.000Z',
          targets: [{ target: 'group/g1', status: 'done' }],
        };
      }),
    });
    installUnifyRuntimeBridge(session);
    __testSetSession(session);

    await handleUnifyDreamTrigger({ groupId: 'g1' });

    const progress = findProgress();
    // start, load-diff, merge, done — no synthetic phase:'result' mirror
    // any longer (terminal is unify_dream_result, see suite docstring).
    expect(progress.length).toBe(4);

    // Top-level events (start / merge / done) — runner did NOT supply
    // a groupId, but the bridge stamped it.
    const top = progress.filter(p => ['start', 'merge', 'done'].includes(p.event.phase));
    expect(top.length).toBe(3);
    for (const p of top) {
      expect(p.event.groupId).toBe('g1');
      // envelope's outer groupId is set so server-side scope filters work
      expect(p.envelope.groupId).toBe('g1');
    }

    // The per-group event already had groupId — it passes through unchanged.
    const loadDiff = progress.find(p => p.event.phase === 'load-diff');
    expect(loadDiff.event.groupId).toBe('g1');
  });

  it('does NOT mirror a synthetic phase:"result" event after a successful scoped run', async () => {
    const session = makeSession();
    installUnifyRuntimeBridge(session);
    __testSetSession(session);

    await handleUnifyDreamTrigger({ groupId: 'g1' });

    // Synthetic mirror removed — the terminal record is appended by the
    // store when it receives `unify_dream_result`. The bridge only sends
    // `unify_dream_result` here, no extra dream_progress.
    const progress = findProgress();
    expect(progress.find(p => p.event.phase === 'result')).toBeUndefined();
    const result = findAll('unify_dream_result');
    expect(result.length).toBe(1);
    expect(result[0].success).toBe(true);
    expect(result[0].entriesCreated).toBe(1);
    expect(result[0].groupId).toBe('g1');
  });

  it('does NOT mirror a synthetic phase:"result" event when the scheduler throws', async () => {
    const session = makeSession({
      triggerDreamForScopes: vi.fn(async () => {
        throw new Error('disk full');
      }),
    });
    installUnifyRuntimeBridge(session);
    __testSetSession(session);

    await handleUnifyDreamTrigger({ groupId: 'g1' });

    const progress = findProgress();
    expect(progress.find(p => p.event.phase === 'result')).toBeUndefined();
    // The terminal envelope is the error-shaped `unify_dream_result`.
    const result = findAll('unify_dream_result');
    expect(result.length).toBe(1);
    expect(result[0].success).toBe(false);
    expect(result[0].error).toBe('disk full');
    expect(result[0].groupId).toBe('g1');
  });

  it('restores the base sink after the trigger settles', async () => {
    const session = makeSession();
    installUnifyRuntimeBridge(session);
    __testSetSession(session);

    await handleUnifyDreamTrigger({ groupId: 'g1' });

    // A subsequent sink call (e.g. an auto-dream firing later) should
    // NOT inherit the prior groupId. We emit a top-level event after
    // the trigger has settled and verify it carries no groupId — proves
    // the wrapper was uninstalled and the base passthrough sink is back.
    outbound.length = 0;
    session._dreamProgressSink({ phase: 'start', manual: false, ts: 99 });
    const progress = findProgress();
    expect(progress.length).toBe(1);
    expect(progress[0].event.groupId).toBeUndefined();
    expect(progress[0].envelope.groupId).toBeUndefined();
  });

  it('does NOT stamp groupId during vpId (unscoped) runs', async () => {
    const session = makeSession({
      triggerDreamNow: vi.fn(async () => {
        session._dreamProgressSink({ phase: 'start', manual: true });
        session._dreamProgressSink({ phase: 'done', groups: 0, targets: 0, duration: 1 });
        return {
          startedAt: '2026-05-15T08:00:00.000Z',
          targets: [],
        };
      }),
    });
    installUnifyRuntimeBridge(session);
    __testSetSession(session);

    await handleUnifyDreamTrigger({ vpId: 'steve' });

    const progress = findProgress();
    expect(progress.length).toBe(2);
    for (const p of progress) {
      expect(p.event.groupId).toBeUndefined();
      expect(p.envelope.groupId).toBeUndefined();
    }
  });

  it('reports a second concurrent scoped trigger as skipped while one is inflight', async () => {
    // Trigger A starts a slow scoped run and never finishes during the
    // test. While it's awaiting, trigger B fires (same group, then
    // also a different group). Both should be reported immediately
    // with an explicit skipped envelope — the existing scheduler shares
    // the inflight promise across callers and silently drops the
    // second's scope filter, so letting B install a second sink wrapper
    // would only mis-stamp A's events.
    let resolveA;
    const session = makeSession({
      triggerDreamForScopes: vi.fn(() => new Promise((res) => { resolveA = res; })),
    });
    installUnifyRuntimeBridge(session);
    __testSetSession(session);

    const a = handleUnifyDreamTrigger({ groupId: 'g1' });
    // Give microtasks a tick so A reaches its await.
    await Promise.resolve();
    await handleUnifyDreamTrigger({ groupId: 'g1' }); // same-group reject
    await handleUnifyDreamTrigger({ groupId: 'g2' }); // cross-group reject

    const results = findAll('unify_dream_result');
    expect(results.length).toBe(2);
    expect(results.map(r => r.groupId)).toEqual(['g1', 'g2']);
    for (const r of results) {
      expect(r.success).toBe(false);
      expect(r.skipped).toBe(true);
      expect(r.skippedReason).toBe('already-running');
      expect(r.trigger).toBe('manual');
      expect(r.error).toBeNull();
    }

    // Let A finish so we don't leak unhandled promises.
    resolveA({ startedAt: '2026-05-15T08:00:00.000Z', targets: [] });
    await a;
  });

  it('rejects scoped manual trigger during an already-running unscoped dream before wrapping the sink', async () => {
    const session = makeSession({
      isRunning: true,
      triggerDreamForScopes: vi.fn(async () => {
        throw new Error('should not start scoped run');
      }),
    });
    installUnifyRuntimeBridge(session);
    const baseSink = session._dreamProgressSink;
    __testSetSession(session);

    await handleUnifyDreamTrigger({ groupId: 'g1' });

    expect(session.dreamScheduler.triggerDreamForScopes).not.toHaveBeenCalled();
    expect(session._dreamActiveGroupId).toBeUndefined();
    expect(session._dreamProgressSink).toBe(baseSink);

    const results = findAll('unify_dream_result');
    expect(results).toHaveLength(1);

    // Existing unscoped auto-run events must keep flowing without a stamped groupId.
    outbound.length = 0;
    session._dreamProgressSink({ phase: 'done', manual: false });
    const progress = findProgress();
    expect(progress).toHaveLength(1);
    expect(progress[0].event.groupId).toBeUndefined();
    expect(progress[0].envelope.groupId).toBeUndefined();
    expect(results[0]).toEqual(expect.objectContaining({
      groupId: 'g1',
      success: false,
      skipped: true,
      skippedReason: 'already-running',
    }));
  });
});

