import { beforeEach, describe, expect, it, vi } from 'vitest';

const localStorageData = new Map();

globalThis.localStorage = {
  getItem: vi.fn((key) => localStorageData.has(key) ? localStorageData.get(key) : null),
  setItem: vi.fn((key, value) => { localStorageData.set(key, String(value)); }),
  removeItem: vi.fn((key) => { localStorageData.delete(key); }),
};

function createStoreFactory(_id, options) {
  let instance = null;
  return () => {
    if (instance) return instance;
    instance = {
      ...(typeof options.state === 'function' ? options.state() : {}),
    };
    for (const [name, getter] of Object.entries(options.getters || {})) {
      Object.defineProperty(instance, name, {
        enumerable: true,
        get() { return getter(instance); },
      });
    }
    for (const [name, action] of Object.entries(options.actions || {})) {
      instance[name] = action.bind(instance);
    }
    return instance;
  };
}

globalThis.Pinia = { defineStore: createStoreFactory };
globalThis.window = globalThis.window || { addEventListener: vi.fn(), removeEventListener: vi.fn() };
globalThis.document = globalThis.document || { addEventListener: vi.fn(), removeEventListener: vi.fn() };

const { useChatStore } = await import('../../../web/stores/chat.js');
const { buildTimelineRows } = await import('../../../web/stores/helpers/vp-timeline.js');

function freshStore() {
  const store = useChatStore();
  store.yeaftAgentId = null;
  store.yeaftConversationId = null;
  store.yeaftActiveSessionFilter = null;
  store.activeVpTurns = {};
  store.stoppingVpTurnIds = {};
  store.vpStatuses = {};
  store.yeaftProcessingSessions = {};
  store.messagesMap = {};
  store.sendWsMessage = vi.fn();
  return store;
}

describe('Yeaft VP stop', () => {
  beforeEach(() => {
    localStorageData.clear();
  });

  it('sends yeaft_abort_turn with the active turn id and marks it stopping', () => {
    const store = freshStore();
    store.yeaftAgentId = 'agent-1';
    store.sendWsMessage = vi.fn();

    store.cancelVpTurn('turn-1');

    expect(store.sendWsMessage).toHaveBeenCalledWith({
      type: 'yeaft_abort_turn',
      agentId: 'agent-1',
      turnId: 'turn-1',
    });
    expect(store.stoppingVpTurnIds['turn-1']).toEqual(expect.any(Number));
  });

  it('falls back to the VP status turn id before vp_turn_start exists', () => {
    const store = freshStore();
    store.yeaftAgentId = 'agent-1';
    store.yeaftActiveSessionFilter = 'session-1';
    store.sendWsMessage = vi.fn();
    store.activeVpTurns = {};
    store.vpStatuses = {
      'session-1::vp-a': {
        state: 'typing',
        turnId: 'queued-turn-a',
        vpId: 'vp-a',
        sessionId: 'session-1',
      },
    };

    expect(store.cancelVpTurnForSession('vp-a', 'session-1')).toBe(true);

    expect(store.sendWsMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'yeaft_abort_turn',
      turnId: 'queued-turn-a',
    }));
    expect(store.stoppingVpTurnIds['queued-turn-a']).toEqual(expect.any(Number));
  });

  it('clears the stopping state on abort ack and marks timeline rows as stopping while pending', () => {
    const store = freshStore();
    store.yeaftConversationId = 'conv-1';
    store.stoppingVpTurnIds = { 'turn-a': 123 };
    store.activeVpTurns = { 'turn-a': { vpId: 'vp-a', sessionId: 'session-1' } };

    const rowsBefore = buildTimelineRows({
      vpList: [{ vpId: 'vp-a', displayName: 'A' }],
      vpStatuses: { 'vp-a': { state: 'thinking', turnId: 'turn-a' } },
      stoppingVpTurnIds: store.stoppingVpTurnIds,
      connectionState: 'connected',
    });
    expect(rowsBefore[0].isStopping).toBe(true);

    store.handleYeaftOutput({ event: { type: 'yeaft_turn_aborted', turnId: 'turn-a', success: true } });

    expect(store.stoppingVpTurnIds['turn-a']).toBeUndefined();
    expect(store.activeVpTurns['turn-a']).toBeUndefined();
  });
});

describe('Yeaft session active indicator state', () => {
  beforeEach(() => {
    localStorageData.clear();
  });

  it('tracks processing per Yeaft session instead of only the active row', () => {
    const store = freshStore();

    store.yeaftProcessingSessions = { 'session-a': true };
    expect(store.isYeaftSessionProcessing('session-a')).toBe(true);
    expect(store.isYeaftSessionProcessing('session-b')).toBe(false);

    store.activeVpTurns = {
      'turn-b': { sessionId: 'session-b', vpId: 'vp-b', startedAt: 10 },
    };
    expect(store.isYeaftSessionProcessing('session-b')).toBe(true);

    store.clearYeaftSessionProcessingIfIdle('session-a');
    expect(store.isYeaftSessionProcessing('session-a')).toBe(false);
    expect(store.isYeaftSessionProcessing('session-b')).toBe(true);
  });

  it('lights and clears the session active dot from VP turn lifecycle events', () => {
    const store = freshStore();

    store.handleYeaftOutput({ event: {
      type: 'vp_turn_start',
      sessionId: 'session-a',
      vpId: 'vp-a',
      turnId: 'turn-a',
      ts: 100,
    } });
    expect(store.isYeaftSessionProcessing('session-a')).toBe(true);

    store.handleYeaftOutput({ event: {
      type: 'vp_turn_end',
      sessionId: 'session-a',
      vpId: 'vp-a',
      turnId: 'turn-a',
      reason: 'end_turn',
    } });
    expect(store.isYeaftSessionProcessing('session-a')).toBe(false);
  });
});
