import { afterEach, describe, expect, it, vi } from 'vitest';

const originalPinia = globalThis.Pinia;
const originalWindow = globalThis.window;

async function createStore(overrides = {}) {
  vi.resetModules();
  globalThis.window = { location: { hash: '' } };
  globalThis.Pinia = {
    defineStore: (_name, options) => () => ({
      ...options.state(),
      ...Object.fromEntries(Object.entries(options.actions).map(([name, action]) => [name, action])),
      checkAuthMode: vi.fn(),
      consumeSsoRedirect: vi.fn(() => false),
      restoreSession: vi.fn(),
      ...overrides,
    }),
  };
  const { useAuthStore } = await import('../../web/stores/auth.js');
  return useAuthStore();
}

afterEach(() => {
  vi.resetModules();
  globalThis.Pinia = originalPinia;
  globalThis.window = originalWindow;
});

describe('auth bootstrap', () => {
  it('restores the server-backed session before marking initialization complete', async () => {
    const store = await createStore();
    let initializedDuringRestore = null;
    store.restoreSession.mockImplementation(async () => {
      initializedDuringRestore = store.initialized;
      store.isAuthenticated = true;
      return true;
    });

    await store.initialize();

    expect(store.checkAuthMode).toHaveBeenCalledOnce();
    expect(store.restoreSession).toHaveBeenCalledOnce();
    expect(initializedDuringRestore).toBe(false);
    expect(store.initialized).toBe(true);
    expect(store.isAuthenticated).toBe(true);
  });
});
