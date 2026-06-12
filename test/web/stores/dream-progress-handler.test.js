/**
 * dream-progress-handler.test.js — v0.1.755 Issue A regression.
 *
 * YeaftDebugPanel needs a single most-recent dream-pass row for the
 * active session's scope ("dream只需要看最新的一次就行"). The chat-store
 * `handleYeaftOutput` switch case `'dream_progress'` is the projection
 * point: each inbound progress event is reduced into
 * `state.yeaftDreamLatest[scope]` as a single record with
 * `{ scope, phase, status, startedAt, finishedAt, mergedCount, error,
 *    manual, durationMs, isRunning }`.
 *
 * What this file pins:
 *   1. Per-target events (`target: 'session/...'`) route to that scope.
 *   2. Per-session events (only `sessionId`) route to `sessions/<id>`.
 *   3. Top-level events (no target / no sessionId) land in the '*'
 *      broadcast bucket AND are mirrored onto every existing scope.
 *   4. Phase transitions:
 *      - running phases (`triage`, `merge`, …) → status='running',
 *        `startedAt` preserved across updates, no `finishedAt`.
 *      - `phase === 'done'`                  → status='success',
 *        `finishedAt` set.
 *      - `phase === 'error'` or status='error' → status='error',
 *        `finishedAt` set, `error` populated.
 *   5. `manual: true` carried into running phase persists through done.
 *
 * Unit-only — same Pinia.defineStore shim pattern as
 * chat-input-dispatch.test.js. Invokes the captured `actions.handleYeaftOutput`
 * against a hand-rolled `this` with `yeaftDreamLatest: {}`.
 */
import { describe, it, expect, beforeAll } from 'vitest';

let capturedOptions = null;
globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = (_id, options) => {
  if (options && options.actions && options.actions.handleYeaftOutput) {
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

/**
 * Minimal `this` surface that the dream_progress branch actually
 * touches. Everything else in handleYeaftOutput short-circuits before
 * the switch when there's no msg.data and event.type !== other cases.
 */
function mkStore() {
  return {
    yeaftDreamLatest: {},
    // PR feat-dream-debug-panel-full: ring buffer + sibling action are
    // touched by the same dream_progress branch we're exercising.
    yeaftDreamEvents: {},
    _appendDreamEvent: actions._appendDreamEvent,
    // Other state the function MAY read on un-related branches. Safe
    // defaults so the function never crashes if it walks past our case.
    yeaftConversationId: null,
    messagesMap: {},
    processingConversations: {},
    executionStatusMap: {},
    activeConversations: [],
    currentView: 'yeaft',
    sendWsMessage() {},
  };
}

const send = (store, event) => {
  actions.handleYeaftOutput.call(store, { event });
};

describe('handleYeaftOutput — dream_progress projection', () => {
  it('routes per-target events into target scope', () => {
    const store = mkStore();
    send(store, {
      type: 'dream_progress',
      phase: 'merge',
      target: 'session/grp_demo',
      ts: 1000,
    });
    expect(Object.keys(store.yeaftDreamLatest)).toEqual(['sessions/grp_demo']);
    const entry = store.yeaftDreamLatest['sessions/grp_demo'];
    expect(entry.scope).toBe('sessions/grp_demo');
    expect(entry.status).toBe('running');
    expect(entry.phase).toBe('merge');
    expect(entry.startedAt).toBe(1000);
    expect(entry.finishedAt).toBeNull();
    expect(entry.isRunning).toBe(true);
  });

  it('routes per-session events (sessionId only) into sessions/<id>', () => {
    const store = mkStore();
    send(store, {
      type: 'dream_progress',
      phase: 'triage',
      sessionId: 'grp_x',
      ts: 2000,
    });
    expect(store.yeaftDreamLatest['sessions/grp_x']).toBeDefined();
    expect(store.yeaftDreamLatest['sessions/grp_x'].scope).toBe('sessions/grp_x');
    expect(store.yeaftDreamLatest['sessions/grp_x'].status).toBe('running');
  });

  it('top-level events (no target/sessionId) land in "*" bucket', () => {
    const store = mkStore();
    send(store, {
      type: 'dream_progress',
      phase: 'start',
      ts: 3000,
    });
    expect(store.yeaftDreamLatest['*']).toBeDefined();
    expect(store.yeaftDreamLatest['*'].scope).toBe('*');
    expect(store.yeaftDreamLatest['*'].isRunning).toBe(true);
  });

  it('top-level events mirror onto every existing scope', () => {
    const store = mkStore();
    // Prime two scopes with running entries.
    send(store, { type: 'dream_progress', phase: 'triage', target: 'session/g1', ts: 100 });
    send(store, { type: 'dream_progress', phase: 'triage', target: 'session/g2', ts: 110 });
    // Now a top-level "done" event arrives.
    send(store, { type: 'dream_progress', phase: 'done', ts: 200 });
    // Both prior scopes plus '*' bucket all reflect done.
    expect(store.yeaftDreamLatest['*'].status).toBe('success');
    expect(store.yeaftDreamLatest['sessions/g1'].status).toBe('success');
    expect(store.yeaftDreamLatest['sessions/g2'].status).toBe('success');
    expect(store.yeaftDreamLatest['sessions/g1'].finishedAt).toBe(200);
  });

  it('phase=done flips status to success and stamps finishedAt', () => {
    const store = mkStore();
    send(store, {
      type: 'dream_progress',
      phase: 'merge',
      target: 'session/grp_demo',
      ts: 1000,
    });
    send(store, {
      type: 'dream_progress',
      phase: 'done',
      target: 'session/grp_demo',
      ts: 1500,
      mergedCount: 3,
    });
    const entry = store.yeaftDreamLatest['sessions/grp_demo'];
    expect(entry.status).toBe('success');
    expect(entry.phase).toBe('done');
    expect(entry.finishedAt).toBe(1500);
    expect(entry.mergedCount).toBe(3);
    expect(entry.isRunning).toBe(false);
  });

  it('preserves startedAt across running-phase transitions', () => {
    const store = mkStore();
    send(store, {
      type: 'dream_progress',
      phase: 'triage',
      target: 'session/grp_demo',
      ts: 500,
    });
    send(store, {
      type: 'dream_progress',
      phase: 'merge',
      target: 'session/grp_demo',
      ts: 700,
    });
    expect(store.yeaftDreamLatest['sessions/grp_demo'].startedAt).toBe(500);
    expect(store.yeaftDreamLatest['sessions/grp_demo'].phase).toBe('merge');
  });

  it('phase=error sets status=error + carries error message', () => {
    const store = mkStore();
    send(store, {
      type: 'dream_progress',
      phase: 'error',
      target: 'session/grp_demo',
      ts: 800,
      error: 'fts segment write failed',
    });
    const entry = store.yeaftDreamLatest['sessions/grp_demo'];
    expect(entry.status).toBe('error');
    expect(entry.error).toBe('fts segment write failed');
    expect(entry.finishedAt).toBe(800);
    expect(entry.isRunning).toBe(false);
  });

  it('status=error (without phase=error) is also treated as error', () => {
    const store = mkStore();
    send(store, {
      type: 'dream_progress',
      phase: 'merge',
      status: 'error',
      target: 'session/grp_demo',
      ts: 900,
      error: 'boom',
    });
    expect(store.yeaftDreamLatest['sessions/grp_demo'].status).toBe('error');
    expect(store.yeaftDreamLatest['sessions/grp_demo'].error).toBe('boom');
  });

  it('manual flag from a running event survives to the done event', () => {
    const store = mkStore();
    send(store, {
      type: 'dream_progress',
      phase: 'triage',
      target: 'session/grp_demo',
      manual: true,
      ts: 100,
    });
    // Subsequent events from the same pass typically don't repeat
    // `manual` — the projection should fall back to the prior value.
    send(store, {
      type: 'dream_progress',
      phase: 'done',
      target: 'session/grp_demo',
      ts: 200,
    });
    expect(store.yeaftDreamLatest['sessions/grp_demo'].manual).toBe(true);
  });

  it('manual=false is preserved when later events omit the flag', () => {
    const store = mkStore();
    send(store, {
      type: 'dream_progress',
      phase: 'triage',
      target: 'session/grp_demo',
      manual: false,
      ts: 100,
    });
    send(store, {
      type: 'dream_progress',
      phase: 'done',
      target: 'session/grp_demo',
      ts: 200,
    });
    expect(store.yeaftDreamLatest['sessions/grp_demo'].manual).toBe(false);
  });

  it('durationMs from event.duration is captured on done', () => {
    const store = mkStore();
    send(store, {
      type: 'dream_progress',
      phase: 'done',
      target: 'session/grp_demo',
      duration: 1234,
      ts: 1000,
    });
    expect(store.yeaftDreamLatest['sessions/grp_demo'].durationMs).toBe(1234);
  });

  it('mergedCount falls back to event.targets when mergedCount absent', () => {
    const store = mkStore();
    send(store, {
      type: 'dream_progress',
      phase: 'merge',
      target: 'session/grp_demo',
      targets: 5,
      ts: 100,
    });
    expect(store.yeaftDreamLatest['sessions/grp_demo'].mergedCount).toBe(5);
  });
});
