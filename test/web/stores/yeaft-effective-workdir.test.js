import { describe, it, expect } from 'vitest';

globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = (_id, options) => () => options;
globalThis.window = globalThis.window || globalThis;
globalThis.window.Pinia = globalThis.Pinia;
globalThis.localStorage = globalThis.localStorage || {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { useChatStore } = await import('../../../web/stores/chat.js');

function makeStore() {
  const schema = useChatStore();
  const state = schema.state();
  const store = { ...state };
  for (const [name, fn] of Object.entries(schema.actions)) {
    store[name] = fn.bind(store);
  }
  // Materialize getters as plain accessors over the live store object.
  for (const [name, fn] of Object.entries(schema.getters)) {
    Object.defineProperty(store, name, { get: () => fn(store), configurable: true });
  }
  return store;
}

describe('effectiveWorkDir getter — Yeaft defaults to ~/.yeaft', () => {
  it('Chat mode prefers the conversation workDir', () => {
    const store = makeStore();
    store.currentView = 'chat';
    store.currentWorkDir = '/projects/foo';
    store.currentAgentInfo = { workDir: '/home/user' };
    store.yeaftYeaftDir = '/home/user/.yeaft';
    expect(store.effectiveWorkDir).toBe('/projects/foo');
  });

  it('Chat mode falls back to agent workDir when no conv workDir', () => {
    const store = makeStore();
    store.currentView = 'chat';
    store.currentWorkDir = null;
    store.currentAgentInfo = { workDir: '/home/user' };
    expect(store.effectiveWorkDir).toBe('/home/user');
  });

  it('Yeaft mode uses ~/.yeaft, ignoring stale Chat conv workDir', () => {
    const store = makeStore();
    store.currentView = 'yeaft';
    // Stale leftover from before entering Yeaft — must not leak.
    store.currentWorkDir = '/projects/some-chat-project';
    store.currentAgentInfo = { workDir: '/home/user/agent-cwd' };
    store.yeaftYeaftDir = '/home/user/.yeaft';
    expect(store.effectiveWorkDir).toBe('/home/user/.yeaft');
  });

  it('Yeaft mode falls back to agent cwd if session_ready never delivered yeaftDir', () => {
    const store = makeStore();
    store.currentView = 'yeaft';
    store.yeaftYeaftDir = null;
    store.currentAgentInfo = { workDir: '/home/user/agent-cwd' };
    expect(store.effectiveWorkDir).toBe('/home/user/agent-cwd');
  });

  it('Yeaft mode prefers the active group workDir when one is set (forward-compat)', () => {
    // Groups don't carry workDir on main yet; this test pins the precedence
    // so the day the feature lands, no consumer changes are required.
    const fakeGroups = { activeSession: { workDir: '/projects/group-workdir' } };
    globalThis.window.Pinia.useSessionsStore = () => fakeGroups;
    try {
      const store = makeStore();
      store.currentView = 'yeaft';
      store.yeaftYeaftDir = '/home/user/.yeaft';
      store.currentAgentInfo = { workDir: '/home/user/agent-cwd' };
      expect(store.effectiveWorkDir).toBe('/projects/group-workdir');
    } finally {
      delete globalThis.window.Pinia.useSessionsStore;
    }
  });
});
