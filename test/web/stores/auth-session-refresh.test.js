import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalPinia = globalThis.Pinia;
const originalFetch = globalThis.fetch;
const originalLocalStorage = globalThis.localStorage;

function createStoreFactory() {
  let instance = null;
  return (_id, options) => () => {
    if (!instance) {
      instance = {
        ...(options.state ? options.state() : {}),
      };
      for (const [name, action] of Object.entries(options.actions || {})) {
        instance[name] = action.bind(instance);
      }
    }
    return instance;
  };
}

function createLocalStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn(key => values.get(key) || null),
    setItem: vi.fn((key, value) => values.set(key, String(value))),
    removeItem: vi.fn(key => values.delete(key)),
  };
}

function jsonResponse({ ok = true, status = 200, body = {}, headers = {} } = {}) {
  return {
    ok,
    status,
    headers: { get: name => headers[name] || headers[name.toLowerCase()] || null },
    json: vi.fn(async () => body),
  };
}

async function loadAuthStore() {
  vi.resetModules();
  globalThis.Pinia = { defineStore: createStoreFactory() };
  const mod = await import('../../../web/stores/auth.js');
  return mod.useAuthStore();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  globalThis.Pinia = originalPinia;
  globalThis.fetch = originalFetch;
  globalThis.localStorage = originalLocalStorage;
});

describe('auth store session restore and refresh', () => {
  it('preserves Yeaft history on same-owner refresh and clears it on owner replacement', async () => {
    globalThis.localStorage = createLocalStorage({ authToken: 'owner-token' });
    const profiles = ['owner-a', 'owner-b'];
    globalThis.fetch = vi.fn(async () => jsonResponse({
      body: { userId: profiles.shift(), username: 'dev', role: 'pro' },
    }));
    const historyState = {
      messages: [{ sessionId: 'session-a', content: 'private history' }],
      history: { loaded: true },
      cache: { ranges: [[1, 2]] },
      window: { visibleTurns: 40 },
      hydration: { token: 'hydrate-a' },
      reveal: { key: 'reveal-a' },
    };
    const originalHistoryState = structuredClone(historyState);
    const clearYeaftHistoryMemory = vi.fn(() => {
      Object.keys(historyState).forEach(key => { historyState[key] = null; });
    });
    globalThis.Pinia = {
      defineStore: createStoreFactory(),
      useChatStore: () => ({ clearYeaftHistoryMemory }),
    };
    vi.resetModules();
    const { useAuthStore } = await import('../../../web/stores/auth.js');
    const auth = useAuthStore();
    auth.token = 'owner-token';
    auth.isAuthenticated = true;
    auth.userId = 'owner-a';

    expect(await auth.refreshSession()).toBe(true);
    expect(clearYeaftHistoryMemory).not.toHaveBeenCalled();
    expect(historyState).toEqual(originalHistoryState);

    expect(await auth.refreshSession()).toBe(true);
    expect(clearYeaftHistoryMemory).toHaveBeenCalledOnce();
    expect(historyState).toEqual({
      messages: null,
      history: null,
      cache: null,
      window: null,
      hydration: null,
      reveal: null,
    });
    expect(auth.userId).toBe('owner-b');
  });

  it('does not let stale auth failures clear a newer login token', async () => {
    globalThis.localStorage = createLocalStorage({ authToken: 'new-token' });
    const auth = await loadAuthStore();
    auth.token = 'new-token';
    auth.isAuthenticated = true;

    const ok = auth.handleAuthFailure('expired', 'old-token');

    expect(ok).toBe(false);
    expect(auth.isAuthenticated).toBe(true);
    expect(auth.token).toBe('new-token');
    expect(globalThis.localStorage.removeItem).not.toHaveBeenCalledWith('authToken');
  });

  it('clears an authenticated cookie-only session on a current 401', async () => {
    globalThis.localStorage = createLocalStorage({
      'yeaft-work-center-composer-drafts-v1': JSON.stringify({ ownerId: 'user-a', records: { draft: {} } }),
      'yeaft-work-center-message-outbox-v1': JSON.stringify({ ownerId: 'user-a', records: { outbox: {} } }),
    });
    const auth = await loadAuthStore();
    auth.isAuthenticated = true;
    auth.authGeneration = 4;

    const handled = auth.handleAuthResponse(
      jsonResponse({ ok: false, status: 401 }),
      null,
      4,
      true,
    );

    expect(handled).toBe(true);
    expect(auth.isAuthenticated).toBe(false);
    expect(auth.authGeneration).toBe(5);
    expect(globalThis.localStorage.removeItem).toHaveBeenCalledWith('authToken');
    expect(globalThis.localStorage.removeItem)
      .toHaveBeenCalledWith('yeaft-work-center-composer-drafts-v1');
    expect(globalThis.localStorage.removeItem)
      .toHaveBeenCalledWith('yeaft-work-center-message-outbox-v1');
  });

  it('ignores a cookie-only 401 from an older auth generation', async () => {
    globalThis.localStorage = createLocalStorage();
    const auth = await loadAuthStore();
    auth.isAuthenticated = true;
    auth.authGeneration = 8;

    const handled = auth.handleAuthResponse(
      jsonResponse({ ok: false, status: 401 }),
      null,
      7,
      true,
    );

    expect(handled).toBe(false);
    expect(auth.isAuthenticated).toBe(true);
    expect(auth.authGeneration).toBe(8);
    expect(globalThis.localStorage.removeItem).not.toHaveBeenCalled();
  });
});
