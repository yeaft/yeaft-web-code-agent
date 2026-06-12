/**
 * dream-event-ring-buffer-handler.test.js — PR feat-dream-debug-panel-full.
 *
 * Companion to `dream-progress-handler.test.js`. The original suite pins
 * the "latest pass" projection (`yeaftDreamLatest`); this one pins the
 * timeline projection (`yeaftDreamEvents`) and the new
 * `yeaft_dream_result` projection added in this PR.
 *
 * What this file pins:
 *   1. dream_progress events are appended to the per-scope ring buffer
 *      (`yeaftDreamEvents[scope]`).
 *   2. Top-level events (no sessionId/target) land in the '*' bucket so
 *      the active-session getter can merge them in chronologically.
 *   3. The ring buffer is bounded — long sessions don't grow it
 *      unboundedly.
 *   4. yeaft_dream_result projects success/error into the latest map
 *      so the Dream row shows the final tally even after the runner
 *      stops emitting events.
 */
import { describe, it, expect, beforeAll } from 'vitest';

// chat.js reads `window.Pinia.useVpStore()` in the yeaft_dream_result
// branch to forward into the per-VP store. We stub `window` with a
// Pinia shim that returns null so the branch falls through to the
// chat-store projection we actually want to exercise.
globalThis.window = globalThis.window || { Pinia: { useVpStore: () => null } };

let capturedOptions = null;
globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = (_id, options) => {
  if (options && options.actions && options.actions.handleYeaftOutput) {
    capturedOptions = options;
  }
  return () => ({});
};

let actions;
let getters;
beforeAll(async () => {
  await import('../../../web/stores/chat.js');
  if (!capturedOptions) {
    throw new Error('chat.js defineStore was not captured — Pinia shim mis-wired');
  }
  actions = capturedOptions.actions;
  getters = capturedOptions.getters;
});

function mkStore() {
  return {
    yeaftDreamLatest: {},
    yeaftDreamSnapshots: {},
    yeaftDreamPromptLoads: {},
    yeaftDreamEvents: {},
    yeaftDebugTurnsById: {},
    yeaftDebugTurnOrder: [],
    yeaftConversationId: null,
    yeaftDebugSessionFilter: null,
    yeaftActiveSessionFilter: null,
    messagesMap: {},
    processingConversations: {},
    executionStatusMap: {},
    activeConversations: [],
    currentView: 'yeaft',
    sendWsMessage() {},
    _appendDreamEvent: actions._appendDreamEvent,
  };
}

const send = (store, event) => {
  actions.handleYeaftOutput.call(store, { event });
};

describe('handleYeaftOutput — dream event ring buffer', () => {

  it('stores Dream resident summaries that were loaded into the system prompt', () => {
    const store = mkStore();
    globalThis.window.Pinia.useSessionsStore = () => ({ activeSessionId: 'g1' });

    send(store, { type: 'turn_open', turnId: 't1', sessionId: 'g1', userPrompt: 'hello' });
    send(store, {
      type: 'dream_memory_loaded',
      turnId: 't1',
      sessionId: 'g1',
      vpId: 'vp-a',
      loadedInto: 'system_prompt.memory',
      resident: [{
        scope: 'sessions/g1',
        source: 'resident-summary',
        summary: 'Loaded Dream summary',
      }],
    });

    expect(store.yeaftDebugTurnsById.t1.dreamMemoryLoaded[0].summary).toBe('Loaded Dream summary');
    expect(store.yeaftDreamPromptLoads['sessions/g1']).toEqual(expect.objectContaining({
      scope: 'sessions/g1',
      sessionId: 'g1',
      vpId: 'vp-a',
      loadedInto: 'system_prompt.memory',
      summary: 'Loaded Dream summary',
    }));
    expect(getters.yeaftDreamPromptLoadForActiveSession(store).summary).toBe('Loaded Dream summary');
  });

  it('stores loadable dream snapshots and exposes the active session snapshot', () => {
    const store = mkStore();
    globalThis.window.Pinia.useSessionsStore = () => ({ activeSessionId: 'g1' });

    send(store, {
      type: 'yeaft_dream_snapshot',
      snapshot: {
        scope: 'sessions/g1',
        sessionId: 'g1',
        summaryText: 'User prefers concise Chinese summaries.',
        memoryText: 'Longer memory body',
        hasOutput: true,
      },
    });

    expect(store.yeaftDreamSnapshots['sessions/g1'].summaryText)
      .toBe('User prefers concise Chinese summaries.');
    const active = getters.yeaftDreamSnapshotForActiveSession(store);
    expect(active.sessionId).toBe('g1');
    expect(active.hasOutput).toBe(true);
  });

  it('stores embedded dream snapshots from terminal dream results', () => {
    const store = mkStore();
    send(store, {
      type: 'yeaft_dream_result',
      sessionId: 'g2',
      success: true,
      snapshot: {
        scope: 'sessions/g2',
        sessionId: 'g2',
        summaryText: 'Persisted dream output',
        hasOutput: true,
      },
    });

    expect(store.yeaftDreamSnapshots['sessions/g2'].summaryText).toBe('Persisted dream output');
  });


  it('normalizes legacy group prompt-load scopes to sessions scopes', () => {
    const store = mkStore();
    globalThis.window.Pinia.useSessionsStore = () => ({ activeSessionId: 'legacy' });
    send(store, {
      type: 'dream_memory_loaded',
      turnId: 't-legacy',
      sessionId: 'legacy',
      resident: [{
        scope: 'sessions/legacy',
        source: 'resident-summary',
        summary: 'Legacy group scope payload',
      }],
    });

    expect(store.yeaftDreamPromptLoads['sessions/legacy']).toEqual(expect.objectContaining({
      scope: 'sessions/legacy',
      sourceScope: 'sessions/legacy',
      sessionId: 'legacy',
      summary: 'Legacy group scope payload',
    }));
    expect(getters.yeaftDreamPromptLoadForActiveSession(store).scope).toBe('sessions/legacy');
  });

  it('ignores nested group resident scopes for the per-session Dream prompt-load cache', () => {
    const store = mkStore();
    send(store, { type: 'turn_open', turnId: 't-nested', sessionId: 'g1', userPrompt: 'hello' });
    send(store, {
      type: 'dream_memory_loaded',
      turnId: 't-nested',
      sessionId: 'g1',
      resident: [{
        scope: 'sessions/g1/vp/vp-a',
        source: 'resident-summary',
        summary: 'Nested VP summary',
      }],
    });

    expect(store.yeaftDreamPromptLoads).toEqual({});
    expect(store.yeaftDebugTurnsById['t-nested'].dreamMemoryLoaded[0].scope).toBe('sessions/g1/vp/vp-a');
  });

  it('active-group getters fall back to sessionsStore.activeSessionId when the main pane is not filtered', () => {
    const store = mkStore();
    globalThis.window.Pinia.useSessionsStore = () => ({
      activeSessionId: 'grp_default',
      sessions: { grp_default: { id: 'grp_default' } },
    });

    send(store, {
      type: 'dream_progress',
      phase: 'start',
      sessionId: 'grp_default',
      manual: true,
      trigger: 'manual',
      source: 'header-button',
      ts: 100,
    });

    expect(getters.yeaftDreamLatestForActiveSession(store)).toMatchObject({
      scope: 'sessions/grp_default',
      status: 'running',
      manual: true,
    });
    expect(getters.yeaftDreamEventsForActiveSession(store).map(e => e.phase)).toEqual(['start']);
  });

  it('appends per-session events to yeaftDreamEvents["sessions/<id>"]', () => {
    const store = mkStore();
    send(store, { type: 'dream_progress', phase: 'triage', sessionId: 'g1', ts: 100 });
    send(store, { type: 'dream_progress', phase: 'merge', sessionId: 'g1', targets: 1, ts: 200 });

    const buf = store.yeaftDreamEvents['sessions/g1'];
    expect(Array.isArray(buf)).toBe(true);
    expect(buf.length).toBe(2);
    expect(buf[0].phase).toBe('triage');
    expect(buf[1].phase).toBe('merge');
    // Augmented with receive timestamp `at` so the active-session getter
    // can merge scoped+broadcast buckets in order.
    expect(typeof buf[0].at).toBe('number');
  });

  it('appends per-target events to yeaftDreamEvents["<target>"]', () => {
    const store = mkStore();
    send(store, { type: 'dream_progress', phase: 'apply', target: 'sessions/g1', status: 'done', ts: 100 });

    const buf = store.yeaftDreamEvents['sessions/g1'];
    expect(buf.length).toBe(1);
    expect(buf[0].phase).toBe('apply');
  });

  it('top-level events land in the "*" broadcast bucket', () => {
    const store = mkStore();
    send(store, { type: 'dream_progress', phase: 'start', manual: true, ts: 100 });
    send(store, { type: 'dream_progress', phase: 'done', sessions: 1, targets: 1, duration: 50, ts: 200 });

    const buf = store.yeaftDreamEvents['*'];
    expect(buf.length).toBe(2);
    expect(buf[0].phase).toBe('start');
    expect(buf[1].phase).toBe('done');
  });

  it('bounds the ring buffer per scope (caps at MAX_YEAFT_DREAM_EVENTS_PER_SCOPE=200)', () => {
    const store = mkStore();
    // Generate 250 events for one group.
    for (let i = 0; i < 250; i++) {
      send(store, { type: 'dream_progress', phase: 'apply', target: 'sessions/g1', status: 'done', ts: i });
    }
    const buf = store.yeaftDreamEvents['sessions/g1'];
    expect(buf.length).toBe(200);
    // The OLDEST 50 should have been dropped — first remaining entry's
    // ts should be 50 (events 0..49 were evicted).
    expect(buf[0].ts).toBe(50);
    expect(buf[buf.length - 1].ts).toBe(249);
  });

  it('different scopes have independent ring buffers', () => {
    const store = mkStore();
    send(store, { type: 'dream_progress', phase: 'triage', sessionId: 'g1', ts: 100 });
    send(store, { type: 'dream_progress', phase: 'triage', sessionId: 'g2', ts: 200 });

    expect(store.yeaftDreamEvents['sessions/g1'].length).toBe(1);
    expect(store.yeaftDreamEvents['sessions/g2'].length).toBe(1);
  });
});

describe('handleYeaftOutput — yeaft_dream_result projection', () => {
  it('projects success into yeaftDreamLatest[sessions/<id>] with status=success', () => {
    const store = mkStore();
    // Prime with a running entry.
    send(store, { type: 'dream_progress', phase: 'triage', sessionId: 'g1', ts: 100 });

    // Final result envelope — DOES NOT use type: 'dream_progress';
    // this is the `yeaft_dream_result` case the bridge sends after
    // the runner returns.
    actions.handleYeaftOutput.call(store, {
      event: {
        type: 'yeaft_dream_result',
        sessionId: 'g1',
        success: true,
        entriesCreated: 3,
      },
    });

    const entry = store.yeaftDreamLatest['sessions/g1'];
    expect(entry).toBeDefined();
    expect(entry.status).toBe('success');
    expect(entry.phase).toBe('result');
    expect(entry.mergedCount).toBe(3);
    expect(entry.error).toBeNull();
    expect(entry.isRunning).toBe(false);
    // startedAt preserved from the prior running entry.
    expect(entry.startedAt).toBe(100);
  });

  it('projects skipped results with skippedReason and no error', () => {
    const store = mkStore();
    actions.handleYeaftOutput.call(store, {
      event: {
        type: 'yeaft_dream_result',
        sessionId: 'g1',
        success: false,
        skipped: true,
        skippedReason: 'already-running',
        trigger: 'manual',
        entriesCreated: 0,
      },
    });

    const entry = store.yeaftDreamLatest['sessions/g1'];
    expect(entry).toBeDefined();
    expect(entry.status).toBe('skipped');
    expect(entry.error).toBeNull();
    expect(entry.isRunning).toBe(false);

    const terminal = store.yeaftDreamEvents['sessions/g1'][0];
    expect(terminal.status).toBe('skipped');
    expect(terminal.skipped).toBe(true);
    expect(terminal.skippedReason).toBe('already-running');
    expect(terminal.trigger).toBe('manual');
  });

  it('projects error into yeaftDreamLatest[sessions/<id>] with status=error + error message', () => {
    const store = mkStore();
    actions.handleYeaftOutput.call(store, {
      event: {
        type: 'yeaft_dream_result',
        sessionId: 'g1',
        success: false,
        error: 'disk full',
      },
    });

    const entry = store.yeaftDreamLatest['sessions/g1'];
    expect(entry).toBeDefined();
    expect(entry.status).toBe('error');
    expect(entry.error).toBe('disk full');
    expect(entry.isRunning).toBe(false);
  });

  it('vpId-only results do not write to yeaftDreamLatest (per-VP rows go through vpStore)', () => {
    const store = mkStore();
    actions.handleYeaftOutput.call(store, {
      event: {
        type: 'yeaft_dream_result',
        vpId: 'steve',
        success: true,
        entriesCreated: 1,
      },
    });
    // Per-VP rows are owned by vpStore.dreamStatus, not chat-store's
    // yeaftDreamLatest. Without a sessionId we should not invent a fake
    // scope key.
    expect(Object.keys(store.yeaftDreamLatest)).toEqual([]);
  });

  // Pre-PR review pulled out two defaulting bugs in this branch.
  // (1) startedAt was synthesised as Date.now() when no prior running
  //     entry existed (network reorder, fresh-tab reconnect mid-pass),
  //     making the row claim the pass started the instant the result
  //     envelope landed. (2) manual was hard-coded to true unless the
  //     prev entry carried a value, mis-attributing auto runs as
  //     manual. We now leave both null in that case.
  it('leaves startedAt null and manual null when no prior running entry exists', () => {
    const store = mkStore();
    actions.handleYeaftOutput.call(store, {
      event: {
        type: 'yeaft_dream_result',
        sessionId: 'g1',
        success: true,
        entriesCreated: 0,
      },
    });
    const entry = store.yeaftDreamLatest['sessions/g1'];
    expect(entry.startedAt).toBeNull();
    expect(entry.manual).toBeNull();
  });

  it('respects event.manual when the bridge supplies it', () => {
    const store = mkStore();
    actions.handleYeaftOutput.call(store, {
      event: {
        type: 'yeaft_dream_result',
        sessionId: 'g1',
        success: true,
        manual: false,
        entriesCreated: 0,
      },
    });
    expect(store.yeaftDreamLatest['sessions/g1'].manual).toBe(false);
  });

  it('appends a synthetic terminal record into yeaftDreamEvents[sessions/<id>] (timeline marker)', () => {
    const store = mkStore();
    send(store, { type: 'dream_progress', phase: 'apply', target: 'sessions/g1', status: 'done', ts: 100 });
    actions.handleYeaftOutput.call(store, {
      event: {
        type: 'yeaft_dream_result',
        sessionId: 'g1',
        success: true,
        entriesCreated: 4,
      },
    });
    const buf = store.yeaftDreamEvents['sessions/g1'];
    // 1 dream_progress (apply) + 1 synthetic terminal (phase:'result')
    expect(buf.length).toBe(2);
    const terminal = buf[buf.length - 1];
    expect(terminal.type).toBe('dream_progress');
    expect(terminal.phase).toBe('result');
    expect(terminal.status).toBe('success');
    expect(terminal.success).toBe(true);
    expect(terminal.entriesCreated).toBe(4);
  });

  // CRITICAL regression test (PR review pre-merge). Pre-fix the bridge
  // sent BOTH `yeaft_dream_result` (terminal) AND a synthetic
  // `phase:'result'` dream_progress event back-to-back. The store's
  // dream_progress projection didn't recognise `phase:'result'` as
  // terminal, so isRunning evaluated to true and the row was rewritten
  // to status:'running' immediately after being marked success. New
  // design: bridge no longer sends the mirror; store appends the
  // terminal record into the ring buffer itself.
  //
  // This test plays the FULL production sequence for a successful
  // scoped pass — running envelope, then `yeaft_dream_result` — and
  // asserts the final state is success (no clobber).
  it('survives the full production sequence: running → yeaft_dream_result (regression for synthetic-mirror clobber)', () => {
    const store = mkStore();
    // 1. Running event lands first (runner emitted load-diff / triage /
    //    merge / apply with the bridge's stamped sessionId).
    send(store, { type: 'dream_progress', phase: 'triage', sessionId: 'g1', ts: 100 });
    expect(store.yeaftDreamLatest['sessions/g1'].status).toBe('running');

    // 2. Terminal envelope — bridge sends `yeaft_dream_result` only.
    actions.handleYeaftOutput.call(store, {
      event: {
        type: 'yeaft_dream_result',
        sessionId: 'g1',
        success: true,
        entriesCreated: 2,
      },
    });

    // 3. Final state: success, not 'running'. The synthetic-mirror
    //    clobber bug would surface as status === 'running' here.
    expect(store.yeaftDreamLatest['sessions/g1'].status).toBe('success');
    expect(store.yeaftDreamLatest['sessions/g1'].isRunning).toBe(false);
    expect(store.yeaftDreamLatest['sessions/g1'].mergedCount).toBe(2);
    // Ring buffer also has the terminal marker so the timeline shows
    // an outcome row instead of ending on 'triage'.
    const buf = store.yeaftDreamEvents['sessions/g1'];
    expect(buf.length).toBe(2);
    expect(buf[1].phase).toBe('result');
    expect(buf[1].status).toBe('success');
  });
});
