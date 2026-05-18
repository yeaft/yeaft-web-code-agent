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

function mkStore() {
  const sent = [];
  globalThis.window = globalThis.window || {};
  globalThis.window.Pinia = {
    useChatStore: () => ({ sendWsMessage: msg => sent.push(msg) }),
  };
  return {
    sent,
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
    expect(groupStatus(store, 'grp_demo')).toMatchObject({
      status: 'running',
      lastError: null,
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
    });

    expect(groupStatus(store, 'grp_demo')).toMatchObject({
      status: 'success',
      lastRunAt: 1770000000000,
      lastError: null,
      lastResult: {
        entriesCreated: 2,
        targetsApplied: 2,
        groupsProcessed: 1,
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
