/**
 * dream-event-ring-buffer-handler.test.js — PR feat-dream-debug-panel-full.
 *
 * Companion to `dream-progress-handler.test.js`. The original suite pins
 * the "latest pass" projection (`unifyDreamLatest`); this one pins the
 * timeline projection (`unifyDreamEvents`) and the new
 * `unify_dream_result` projection added in this PR.
 *
 * What this file pins:
 *   1. dream_progress events are appended to the per-scope ring buffer
 *      (`unifyDreamEvents[scope]`).
 *   2. Top-level events (no groupId/target) land in the '*' bucket so
 *      the active-group getter can merge them in chronologically.
 *   3. The ring buffer is bounded — long sessions don't grow it
 *      unboundedly.
 *   4. unify_dream_result projects success/error into the latest map
 *      so the Dream row shows the final tally even after the runner
 *      stops emitting events.
 */
import { describe, it, expect, beforeAll } from 'vitest';

// chat.js reads `window.Pinia.useVpStore()` in the unify_dream_result
// branch to forward into the per-VP store. We stub `window` with a
// Pinia shim that returns null so the branch falls through to the
// chat-store projection we actually want to exercise.
globalThis.window = globalThis.window || { Pinia: { useVpStore: () => null } };

let capturedOptions = null;
globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = (_id, options) => {
  if (options && options.actions && options.actions.handleUnifyOutput) {
    capturedOptions = options;
  }
  return () => ({});
};

let actions;
beforeAll(async () => {
  await import('../../../web/stores/chat.js');
  if (!capturedOptions) {
    throw new Error('chat.js defineStore was not captured — Pinia shim mis-wired');
  }
  actions = capturedOptions.actions;
});

function mkStore() {
  return {
    unifyDreamLatest: {},
    unifyDreamEvents: {},
    unifyConversationId: null,
    messagesMap: {},
    processingConversations: {},
    executionStatusMap: {},
    activeConversations: [],
    currentView: 'unify',
    sendWsMessage() {},
    _appendDreamEvent: actions._appendDreamEvent,
  };
}

const send = (store, event) => {
  actions.handleUnifyOutput.call(store, { event });
};

describe('handleUnifyOutput — dream event ring buffer', () => {
  it('appends per-group events to unifyDreamEvents["group/<id>"]', () => {
    const store = mkStore();
    send(store, { type: 'dream_progress', phase: 'triage', groupId: 'g1', ts: 100 });
    send(store, { type: 'dream_progress', phase: 'merge', groupId: 'g1', targets: 1, ts: 200 });

    const buf = store.unifyDreamEvents['group/g1'];
    expect(Array.isArray(buf)).toBe(true);
    expect(buf.length).toBe(2);
    expect(buf[0].phase).toBe('triage');
    expect(buf[1].phase).toBe('merge');
    // Augmented with receive timestamp `at` so the active-group getter
    // can merge scoped+broadcast buckets in order.
    expect(typeof buf[0].at).toBe('number');
  });

  it('appends per-target events to unifyDreamEvents["<target>"]', () => {
    const store = mkStore();
    send(store, { type: 'dream_progress', phase: 'apply', target: 'group/g1', status: 'done', ts: 100 });

    const buf = store.unifyDreamEvents['group/g1'];
    expect(buf.length).toBe(1);
    expect(buf[0].phase).toBe('apply');
  });

  it('top-level events land in the "*" broadcast bucket', () => {
    const store = mkStore();
    send(store, { type: 'dream_progress', phase: 'start', manual: true, ts: 100 });
    send(store, { type: 'dream_progress', phase: 'done', groups: 1, targets: 1, duration: 50, ts: 200 });

    const buf = store.unifyDreamEvents['*'];
    expect(buf.length).toBe(2);
    expect(buf[0].phase).toBe('start');
    expect(buf[1].phase).toBe('done');
  });

  it('bounds the ring buffer per scope (caps at MAX_UNIFY_DREAM_EVENTS_PER_SCOPE=200)', () => {
    const store = mkStore();
    // Generate 250 events for one group.
    for (let i = 0; i < 250; i++) {
      send(store, { type: 'dream_progress', phase: 'apply', target: 'group/g1', status: 'done', ts: i });
    }
    const buf = store.unifyDreamEvents['group/g1'];
    expect(buf.length).toBe(200);
    // The OLDEST 50 should have been dropped — first remaining entry's
    // ts should be 50 (events 0..49 were evicted).
    expect(buf[0].ts).toBe(50);
    expect(buf[buf.length - 1].ts).toBe(249);
  });

  it('different scopes have independent ring buffers', () => {
    const store = mkStore();
    send(store, { type: 'dream_progress', phase: 'triage', groupId: 'g1', ts: 100 });
    send(store, { type: 'dream_progress', phase: 'triage', groupId: 'g2', ts: 200 });

    expect(store.unifyDreamEvents['group/g1'].length).toBe(1);
    expect(store.unifyDreamEvents['group/g2'].length).toBe(1);
  });
});

describe('handleUnifyOutput — unify_dream_result projection', () => {
  it('projects success into unifyDreamLatest[group/<id>] with status=success', () => {
    const store = mkStore();
    // Prime with a running entry.
    send(store, { type: 'dream_progress', phase: 'triage', groupId: 'g1', ts: 100 });

    // Final result envelope — DOES NOT use type: 'dream_progress';
    // this is the `unify_dream_result` case the bridge sends after
    // the runner returns.
    actions.handleUnifyOutput.call(store, {
      event: {
        type: 'unify_dream_result',
        groupId: 'g1',
        success: true,
        entriesCreated: 3,
      },
    });

    const entry = store.unifyDreamLatest['group/g1'];
    expect(entry).toBeDefined();
    expect(entry.status).toBe('success');
    expect(entry.phase).toBe('result');
    expect(entry.mergedCount).toBe(3);
    expect(entry.error).toBeNull();
    expect(entry.isRunning).toBe(false);
    // startedAt preserved from the prior running entry.
    expect(entry.startedAt).toBe(100);
  });

  it('projects error into unifyDreamLatest[group/<id>] with status=error + error message', () => {
    const store = mkStore();
    actions.handleUnifyOutput.call(store, {
      event: {
        type: 'unify_dream_result',
        groupId: 'g1',
        success: false,
        error: 'disk full',
      },
    });

    const entry = store.unifyDreamLatest['group/g1'];
    expect(entry).toBeDefined();
    expect(entry.status).toBe('error');
    expect(entry.error).toBe('disk full');
    expect(entry.isRunning).toBe(false);
  });

  it('vpId-only results do not write to unifyDreamLatest (per-VP rows go through vpStore)', () => {
    const store = mkStore();
    actions.handleUnifyOutput.call(store, {
      event: {
        type: 'unify_dream_result',
        vpId: 'steve',
        success: true,
        entriesCreated: 1,
      },
    });
    // Per-VP rows are owned by vpStore.dreamStatus, not chat-store's
    // unifyDreamLatest. Without a groupId we should not invent a fake
    // scope key.
    expect(Object.keys(store.unifyDreamLatest)).toEqual([]);
  });
});
