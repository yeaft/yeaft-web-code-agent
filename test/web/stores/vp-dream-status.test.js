/**
 * vp-dream-status.test.js — pin the header Dream button state machine.
 *
 * The topbar Dream control calls vpStore.triggerGroupDream(groupId), then
 * renders its spinner from groupDreamStatusFor(groupId). A terminal
 * unify_dream_result event must always flip that row out of running, both for
 * success and error, so the UI cannot spin forever.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

let capturedOptions = null;
globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = (_id, options) => {
  if (options && options.actions && options.actions.triggerGroupDream) {
    capturedOptions = options;
  }
  return () => ({});
};

let actions;
let getters;
beforeAll(async () => {
  await import('../../../web/stores/vp.js');
  if (!capturedOptions) {
    throw new Error('vp.js defineStore was not captured — Pinia shim mis-wired');
  }
  actions = capturedOptions.actions;
  getters = capturedOptions.getters;
});

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(1770000000000);
});

function mkStore(options = {}) {
  const sent = [];
  const projected = [];
  const sendResult = Object.prototype.hasOwnProperty.call(options, 'sendResult')
    ? options.sendResult
    : true;
  const unifyAgentId = Object.prototype.hasOwnProperty.call(options, 'unifyAgentId')
    ? options.unifyAgentId
    : null;
  globalThis.window = globalThis.window || {};
  globalThis.window.Pinia = {
    useChatStore: () => ({
      unifyAgentId,
      sendWsMessage: msg => {
        sent.push(msg);
        return sendResult;
      },
      handleUnifyOutput: msg => projected.push(msg),
    }),
  };
  return {
    sent,
    projected,
    vps: {},
    vpOrder: [],
    emptyLibrary: false,
    lastSnapshotAt: 0,
    lastChange: null,
    dreamStatus: {},
    groupDreamStatus: {},
  };
}

function groupStatus(store, groupId) {
  return getters.groupDreamStatusFor(store)(groupId);
}

describe('vp store — group Dream status', () => {
  it('triggerGroupDream sends the group-scoped frame and marks the row running', () => {
    const store = mkStore();

    actions.triggerGroupDream.call(store, 'grp_demo');

    expect(store.sent).toEqual([{ type: 'unify_dream_trigger', groupId: 'grp_demo' }]);
    expect(store.projected).toEqual([{
      event: {
        type: 'dream_progress',
        phase: 'start',
        groupId: 'grp_demo',
        manual: true,
        trigger: 'manual',
        source: 'header-button',
        ts: 1770000000000,
      },
    }]);
    expect(groupStatus(store, 'grp_demo')).toMatchObject({
      status: 'running',
      lastError: null,
    });
  });

  it('includes the active Unify agent id so the server can route to the agent bridge', () => {
    const store = mkStore({ unifyAgentId: 'agent-unify' });

    actions.triggerGroupDream.call(store, 'grp_demo');

    expect(store.sent).toEqual([{
      type: 'unify_dream_trigger',
      groupId: 'grp_demo',
      agentId: 'agent-unify',
    }]);
  });

  it('records a skipped dream result when the websocket trigger cannot be sent', () => {
    const store = mkStore({ sendResult: false });

    actions.triggerGroupDream.call(store, 'grp_demo');

    expect(store.sent).toEqual([{ type: 'unify_dream_trigger', groupId: 'grp_demo' }]);
    expect(store.projected).toEqual([
      {
        event: {
          type: 'dream_progress',
          phase: 'start',
          groupId: 'grp_demo',
          manual: true,
          trigger: 'manual',
          source: 'header-button',
          ts: 1770000000000,
        },
      },
      {
        event: {
          type: 'unify_dream_result',
          groupId: 'grp_demo',
          success: false,
          skipped: true,
          skippedReason: 'websocket-not-open',
          trigger: 'manual',
          error: null,
        },
      },
    ]);
  });

  it('skipped result ends the spinner without treating the skip as an error', () => {
    const store = mkStore();
    actions.triggerGroupDream.call(store, 'grp_demo');

    actions.applyDreamResult.call(store, {
      type: 'unify_dream_result',
      groupId: 'grp_demo',
      success: false,
      skipped: true,
      skippedReason: 'websocket-not-open',
    });

    expect(groupStatus(store, 'grp_demo')).toMatchObject({
      status: 'skipped',
      lastRunAt: 1770000000000,
      lastError: null,
      lastResult: {
        skipped: true,
        skippedReason: 'websocket-not-open',
      },
    });
  });

  it('successful result ends the spinner with created-entry counts', () => {
    const store = mkStore();
    actions.triggerGroupDream.call(store, 'grp_demo');

    actions.applyDreamResult.call(store, {
      type: 'unify_dream_result',
      groupId: 'grp_demo',
      success: true,
      entriesCreated: 2,
      targetsApplied: 2,
      groupsProcessed: 1,
      durationMs: 12400,
      llmCallCount: 5,
      inputTokens: 12000,
      outputTokens: 6200,
      totalTokens: 18200,
    });

    expect(groupStatus(store, 'grp_demo')).toMatchObject({
      status: 'success',
      lastRunAt: 1770000000000,
      lastError: null,
      lastResult: {
        entriesCreated: 2,
        targetsApplied: 2,
        groupsProcessed: 1,
        durationMs: 12400,
        llmCallCount: 5,
        totalTokens: 18200,
      },
    });
  });

  it('error result ends the spinner and exposes the failure reason', () => {
    const store = mkStore();
    actions.triggerGroupDream.call(store, 'grp_demo');

    actions.applyDreamResult.call(store, {
      type: 'unify_dream_result',
      groupId: 'grp_demo',
      success: false,
      error: 'Dream scheduler not initialized — session not loaded.',
    });

    expect(groupStatus(store, 'grp_demo')).toMatchObject({
      status: 'error',
      lastRunAt: 1770000000000,
      lastError: 'Dream scheduler not initialized — session not loaded.',
    });
  });
});
