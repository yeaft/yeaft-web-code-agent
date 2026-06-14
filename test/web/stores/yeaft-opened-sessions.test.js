import { beforeEach, describe, expect, it, vi } from 'vitest';

const localStorageData = new Map();

globalThis.localStorage = {
  getItem: vi.fn((key) => localStorageData.has(key) ? localStorageData.get(key) : null),
  setItem: vi.fn((key, value) => { localStorageData.set(key, String(value)); }),
  removeItem: vi.fn((key) => { localStorageData.delete(key); }),
};

globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = (_id, options) => () => options;
globalThis.window = globalThis.window || globalThis;
globalThis.window.Pinia = globalThis.Pinia;

const {
  addOpenedYeaftSessionId,
  normalizeOpenedYeaftSessionIds,
  OPENED_YEAFT_SESSIONS_STORAGE_KEY,
  resolveOpenedYeaftSessionIds,
} = await import('../../../web/stores/helpers/yeaft-opened-sessions.js');
const { useChatStore } = await import('../../../web/stores/chat.js');

function makeStore(sessionsById = {}) {
  const schema = useChatStore();
  const state = schema.state();
  const sent = [];
  const store = {
    ...state,
    sent,
    sendWsMessage(msg) { sent.push(msg); },
  };
  for (const [name, fn] of Object.entries(schema.actions)) {
    store[name] = fn.bind(store);
  }
  store.sendWsMessage = function sendWsMessage(msg) { sent.push(msg); };
  window.Pinia.useSessionsStore = () => ({
    activeSessionId: 'session-a',
    sessionById: (id) => sessionsById[id] || null,
  });
  return store;
}

beforeEach(() => {
  localStorageData.clear();
  delete window.Pinia.useSessionsStore;
});

describe('opened Yeaft sessions persistence', () => {
  it('dedupes and promotes the most recently opened session', () => {
    expect(normalizeOpenedYeaftSessionIds('["session-a","session-a","",5,"session-b"]'))
      .toEqual(['session-a', 'session-b']);

    expect(addOpenedYeaftSessionId(['session-a', 'session-b'], 'session-b'))
      .toEqual(['session-b', 'session-a']);
  });

  it('filters opened sessions to rows owned by the current agent', () => {
    const rows = {
      'session-a': { id: 'session-a', agentId: 'agent-1' },
      'session-b': { id: 'session-b', agentId: 'agent-2' },
      'session-c': { id: 'session-c' },
    };

    expect(resolveOpenedYeaftSessionIds({
      openedSessionIds: ['session-b', 'missing', 'session-c'],
      activeSessionId: 'session-a',
      sessionById: (id) => rows[id] || null,
      agentId: 'agent-1',
    })).toEqual(['session-a', 'session-c']);
  });

  it('marks selected sessions as opened and persists them', () => {
    const store = makeStore({
      'session-a': { id: 'session-a', agentId: 'agent-1' },
    });

    store.setActiveSessionFilter('session-a');

    expect(store.openedYeaftSessionIds).toEqual(['session-a']);
    expect(localStorageData.get(OPENED_YEAFT_SESSIONS_STORAGE_KEY)).toBe('["session-a"]');
  });

  it('loads every previously opened session for the current agent on Yeaft entry', () => {
    const store = makeStore({
      'session-a': { id: 'session-a', agentId: 'agent-1' },
      'session-b': { id: 'session-b', agentId: 'agent-1' },
      'session-foreign': { id: 'session-foreign', agentId: 'agent-2' },
    });
    store.yeaftAgentId = 'agent-1';
    store.yeaftActiveSessionFilter = 'session-a';
    store.openedYeaftSessionIds = ['session-b', 'session-foreign'];

    const count = store.requestOpenedYeaftSessionsBootstrap({ catchUpHistory: true });

    expect(count).toBe(2);
    expect(store.sent).toEqual([
      { type: 'yeaft_load_history', agentId: 'agent-1', sessionId: 'session-a', limit: 5 },
      { type: 'yeaft_load_history', agentId: 'agent-1', sessionId: 'session-b', limit: 5 },
    ]);
    expect(store.yeaftSessionHistoryState['session-a']).toMatchObject({ loading: true, loaded: false });
    expect(store.yeaftSessionHistoryState['session-b']).toMatchObject({ loading: true, loaded: false });
  });

  it('uses delta catch-up for opened sessions that already have a cursor', () => {
    const store = makeStore({
      'session-a': { id: 'session-a', agentId: 'agent-1' },
    });
    store.yeaftAgentId = 'agent-1';
    store.openedYeaftSessionIds = ['session-a'];
    store.yeaftSessionHistoryState = {
      'session-a': { loaded: true, loading: false, latestSeq: 42, hasMore: false, oldestSeq: 1, count: 3 },
    };

    const count = store.requestOpenedYeaftSessionsBootstrap({ catchUpHistory: true });

    expect(count).toBe(1);
    expect(store.sent).toEqual([
      { type: 'yeaft_load_history', agentId: 'agent-1', sessionId: 'session-a', afterSeq: 42 },
    ]);
  });

  it('does not delta catch-up loaded sessions during ordinary snapshot hydration', () => {
    const store = makeStore({
      'session-a': { id: 'session-a', agentId: 'agent-1' },
      'session-b': { id: 'session-b', agentId: 'agent-1' },
    });
    store.yeaftAgentId = 'agent-1';
    store.openedYeaftSessionIds = ['session-a', 'session-b'];
    store.yeaftSessionHistoryState = {
      'session-a': { loaded: true, loading: false, latestSeq: 42, hasMore: false, oldestSeq: 1, count: 3 },
      'session-b': { loaded: false, loading: false, latestSeq: null, hasMore: false, oldestSeq: null, count: 0 },
    };

    const count = store.requestOpenedYeaftSessionsBootstrap({ catchUpHistory: false });

    expect(count).toBe(1);
    expect(store.sent).toEqual([
      { type: 'yeaft_load_history', agentId: 'agent-1', sessionId: 'session-b', limit: 5 },
    ]);
  });
});
