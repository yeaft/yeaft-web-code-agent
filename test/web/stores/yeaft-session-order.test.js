import { describe, it, expect, beforeEach } from 'vitest';

globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = (_id, options) => () => options;
globalThis.window = globalThis.window || globalThis;
globalThis.window.Pinia = globalThis.Pinia;
const localStorageData = {};
globalThis.localStorage = {
  getItem: (key) => Object.prototype.hasOwnProperty.call(localStorageData, key) ? localStorageData[key] : null,
  setItem: (key, value) => { localStorageData[key] = String(value); },
  removeItem: (key) => { delete localStorageData[key]; },
};

const { useSessionsStore } = await import('../../../web/stores/sessions.js');

function makeStore() {
  const schema = useSessionsStore();
  const state = schema.state();
  const store = { ...state };
  for (const [name, fn] of Object.entries(schema.actions)) {
    store[name] = fn.bind(store);
  }
  for (const [name, getter] of Object.entries(schema.getters)) {
    Object.defineProperty(store, name, { get: () => getter(store) });
  }
  return store;
}

function session(id) {
  return { id, name: id, roster: [], defaultVpId: null };
}

describe('Yeaft session list ordering', () => {
  beforeEach(() => {
    for (const key of Object.keys(localStorageData)) delete localStorageData[key];
    window.Pinia.useChatStore = () => ({ yeaftActiveSessionFilter: null });
  });

  it('moves the selected session to the first row by insertion instead of swapping', () => {
    const store = makeStore();
    store.applySnapshot([session('a'), session('b'), session('c'), session('d')]);

    store.setActive('c');

    expect(store.activeSessionId).toBe('c');
    expect(store.sessionOrder).toEqual(['c', 'a', 'b', 'd']);
    expect(store.sessionList.map(s => s.id)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('keeps the locally promoted active session at the top across snapshots', () => {
    const store = makeStore();
    store.applySnapshot([session('a'), session('b'), session('c')]);
    store.setActive('c');

    store.applySnapshot([session('a'), session('b'), session('c'), session('d')]);

    expect(store.activeSessionId).toBe('c');
    expect(store.sessionOrder).toEqual(['c', 'a', 'b', 'd']);
  });

  it('inserts newly created sessions at the top', () => {
    const store = makeStore();
    store.applySnapshot([session('a'), session('b')]);

    store.applyCrudResult({ ok: true, op: 'create', session: session('c') });

    expect(store.activeSessionId).toBe('c');
    expect(store.sessionOrder).toEqual(['c', 'a', 'b']);
  });

  it('upserts existing sessions without changing their relative order', () => {
    const store = makeStore();
    store.applySnapshot([session('a'), session('b'), session('c')]);

    store.applySnapshotUpsert({ ...session('b'), name: 'renamed' });

    expect(store.sessionOrder).toEqual(['a', 'b', 'c']);
    expect(store.sessions.b.name).toBe('renamed');
  });

  it('pins sessions to the top by insertion and preserves the rest order', () => {
    const store = makeStore();
    store.applySnapshot([session('a'), session('b'), session('c'), session('d')]);

    store.togglePin('c');
    store.togglePin('b');

    expect(store.pinnedSessionIds).toEqual(['b', 'c']);
    expect(store.sessionOrder).toEqual(['b', 'c', 'a', 'd']);
    expect(JSON.parse(localStorage.getItem('yeaft-pinned-sessions'))).toEqual(['b', 'c']);
  });

  it('keeps the clicked session first even when another session is pinned', () => {
    const store = makeStore();
    store.applySnapshot([session('a'), session('b'), session('c'), session('d')]);

    store.togglePin('b');
    store.setActive('d');

    expect(store.sessionOrder).toEqual(['d', 'b', 'a', 'c']);
  });

  it('drops deleted sessions from the pinned list', () => {
    const store = makeStore();
    store.applySnapshot([session('a'), session('b'), session('c')]);
    store.togglePin('b');

    store.applyCrudResult({ ok: true, op: 'delete', sessionId: 'b' });

    expect(store.pinnedSessionIds).toEqual([]);
    expect(store.sessionOrder).toEqual(['a', 'c']);
    expect(JSON.parse(localStorage.getItem('yeaft-pinned-sessions'))).toEqual([]);
  });
});
