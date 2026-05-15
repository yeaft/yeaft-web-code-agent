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
 * The bridge fix: `handleUnifyDreamTrigger({groupId})` parks the
 * groupId in a module-level `activeScopedDreamGroupId` field, and
 * `_dreamProgressSink` reads it to stamp ungroupId'd events with
 * the active scope.
 *
 * The second fix: after the unify_dream_result is sent, the bridge
 * mirrors a synthetic `phase:'result'` dream_progress event so the
 * frontend ring buffer has a final "outcome" row showing success or
 * error rather than ending on the last `phase:'apply'` event.
 *
 * This suite pins both contracts so a regression that drops
 * groupId stamping or the result mirror can't ship silently.
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
    // start, load-diff, merge, done, plus the synthetic `phase:'result'`.
    expect(progress.length).toBe(5);

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

  it('mirrors a synthetic phase:"result" event after a successful scoped run', async () => {
    const session = makeSession();
    installUnifyRuntimeBridge(session);
    __testSetSession(session);

    await handleUnifyDreamTrigger({ groupId: 'g1' });

    const progress = findProgress();
    const result = progress.find(p => p.event.phase === 'result');
    expect(result).toBeTruthy();
    expect(result.event.groupId).toBe('g1');
    expect(result.event.status).toBe('success');
    expect(result.event.success).toBe(true);
    expect(result.event.entriesCreated).toBe(1);
    expect(result.envelope.groupId).toBe('g1');
  });

  it('mirrors a synthetic phase:"result" event with status:"error" when the scheduler throws', async () => {
    const session = makeSession({
      triggerDreamForScopes: vi.fn(async () => {
        throw new Error('disk full');
      }),
    });
    installUnifyRuntimeBridge(session);
    __testSetSession(session);

    await handleUnifyDreamTrigger({ groupId: 'g1' });

    const progress = findProgress();
    const result = progress.find(p => p.event.phase === 'result');
    expect(result).toBeTruthy();
    expect(result.event.status).toBe('error');
    expect(result.event.success).toBe(false);
    expect(result.event.error).toBe('disk full');
    expect(result.event.groupId).toBe('g1');
  });

  it('clears the active scoped groupId after the trigger settles', async () => {
    const session = makeSession();
    installUnifyRuntimeBridge(session);
    __testSetSession(session);

    await handleUnifyDreamTrigger({ groupId: 'g1' });

    // A subsequent sink call (e.g. an auto-dream firing later) should
    // NOT inherit the prior groupId. We emit a top-level event after
    // the trigger has settled and verify it carries no groupId.
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
    // start + done — but no `phase:'result'` mirror (only scoped runs emit it
    // since the ring buffer is per-group). Top-level vp runs already get
    // unify_dream_result for the per-VP button row.
    expect(progress.length).toBe(2);
    for (const p of progress) {
      expect(p.event.groupId).toBeUndefined();
      expect(p.envelope.groupId).toBeUndefined();
    }
  });
});
