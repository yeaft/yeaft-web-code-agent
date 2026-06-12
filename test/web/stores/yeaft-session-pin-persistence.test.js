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
        get() {
          return getter(instance);
        },
      });
    }
    for (const [name, action] of Object.entries(options.actions || {})) {
      instance[name] = action.bind(instance);
    }
    return instance;
  };
}

globalThis.Pinia = {
  defineStore: createStoreFactory,
};

const chatStore = {
  yeaftActiveSessionFilter: null,
  pinnedSessions: [],
  applyServerPinSnapshot(_agentId, pinnedInSnapshot, isOwnedByAgent) {
    const existing = new Set(this.pinnedSessions);
    for (const id of pinnedInSnapshot) {
      if (!existing.has(id)) this.pinnedSessions.unshift(id);
    }
    this.pinnedSessions = this.pinnedSessions.filter(id => !isOwnedByAgent(id) || pinnedInSnapshot.has(id));
    localStorage.setItem('pinned-sessions', JSON.stringify(this.pinnedSessions));
  },
};

globalThis.window = {
  Pinia: {
    useChatStore: () => chatStore,
  },
};

const { useSessionsStore } = await import('../../../web/stores/sessions.js');

function ids(rows) {
  return rows.map(row => row.id);
}

beforeEach(() => {
  localStorageData.clear();
  chatStore.yeaftActiveSessionFilter = null;
  chatStore.pinnedSessions = [];
  const store = useSessionsStore();
  store.sessions = {};
  store.sessionOrder = [];
  store.activeSessionId = null;
  store.lastSnapshotAt = 0;
  store.lastCrudResult = null;
  store.pending = {};
});

describe('Yeaft session pin persistence flow', () => {
  it('hydrates persisted server pin metadata from isPinned and keeps pinned rows above active non-pinned rows', () => {
    const store = useSessionsStore();

    store.applySnapshot([
      { id: 's-active', name: 'Active', updatedAt: 30 },
      { id: 's-pinned', name: 'Pinned', updatedAt: 10, isPinned: true },
      { id: 's-other', name: 'Other', updatedAt: 20 },
    ], 'agent-1');

    expect(store.sessions['s-pinned']).toMatchObject({ pinned: true });
    expect(chatStore.pinnedSessions).toEqual(['s-pinned']);
    expect(ids(store.sessionList)).toEqual(['s-pinned', 's-active', 's-other']);

    store.setActive('s-other');

    expect(store.activeSessionId).toBe('s-other');
    expect(ids(store.sessionList)).toEqual(['s-pinned', 's-other', 's-active']);
  });

  it('keeps server-persisted pins after a later session list refresh', () => {
    const store = useSessionsStore();

    store.applySnapshot([
      { id: 's-pinned', updatedAt: 10, isPinned: true },
      { id: 's-active', updatedAt: 20 },
    ], 'agent-1');
    store.setActive('s-active');

    store.applySnapshot([
      { id: 's-active', updatedAt: 40 },
      { id: 's-pinned', updatedAt: 10, pinned: true },
      { id: 's-new', updatedAt: 50 },
    ], 'agent-1');

    expect(store.sessions['s-pinned']).toMatchObject({ pinned: true });
    expect(chatStore.pinnedSessions).toEqual(['s-pinned']);
    expect(ids(store.sessionList)).toEqual(['s-pinned', 's-active', 's-new']);
  });

  it('updates row metadata for pin and unpin acknowledgements so pinned block membership recovers', () => {
    const store = useSessionsStore();
    store.applySnapshot([
      { id: 's-a', updatedAt: 10, isPinned: true },
      { id: 's-b', updatedAt: 20 },
      { id: 's-c', updatedAt: 30 },
    ], 'agent-1');

    store.applyPinState('s-b', true);

    expect(store.sessions['s-b']).toMatchObject({ pinned: true });
    expect(ids(store.sessionList)).toEqual(['s-b', 's-a', 's-c']);

    store.applyPinState('s-b', false);

    expect(store.sessions['s-b']).toMatchObject({ pinned: false });
    expect(ids(store.sessionList)).toEqual(['s-a', 's-b', 's-c']);
  });
});
