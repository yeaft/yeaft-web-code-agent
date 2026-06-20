import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalFetch = globalThis.fetch;
const originalLocation = globalThis.location;
const originalLocalStorage = globalThis.localStorage;
const originalPinia = globalThis.Pinia;

beforeEach(() => {
  globalThis.Pinia = {
    defineStore: () => () => ({}),
    useChatStore: () => ({ locale: 'en', theme: 'light' }),
  };
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.location = { protocol: 'https:', host: 'example.test' };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.location = originalLocation;
  globalThis.localStorage = originalLocalStorage;
  globalThis.Pinia = originalPinia;
  vi.restoreAllMocks();
});

describe('SettingsPanel Agent secret behavior', () => {
  async function loadComponent() {
    const mod = await import('../../web/components/SettingsPanel.js');
    return mod.default;
  }

  function createInstance(component, overrides = {}) {
    const data = component.data.call({});
    const instance = {
      ...data,
      visible: false,
      initialTab: '',
      initialSubTab: '',
      initialEditVpId: '',
      visibleTabs: [{ key: 'security' }],
      yeaftSubTabs: [{ key: 'vp' }],
      authStore: { role: 'pro', loadIdentities: vi.fn() },
      chatStore: { locale: 'en', theme: 'light', toggleTheme: vi.fn(), changeLocale: vi.fn() },
      $t: key => key,
      showMessage: vi.fn(),
      loadInvitations: vi.fn(),
      _consumeSsoQueryFlags: vi.fn(),
      ...overrides,
    };
    for (const [name, fn] of Object.entries(component.methods)) {
      if (!Object.prototype.hasOwnProperty.call(overrides, name)) {
        instance[name] = fn.bind(instance);
      }
    }
    for (const [name, getter] of Object.entries(component.computed)) {
      if (!(name in instance)) {
        Object.defineProperty(instance, name, { get: () => getter.call(instance) });
      }
    }
    return instance;
  }

  it('normalizes existing Agent secrets from API responses', async () => {
    const component = await loadComponent();
    const instance = createInstance(component);

    instance.applyAgentSecretResponse({ agentSecret: 'fake-secret-existing' });
    expect(instance.agentSecret).toBe('fake-secret-existing');

    instance.applyAgentSecretResponse({ agent_secret: 'fake-secret-snake' });
    expect(instance.agentSecret).toBe('fake-secret-snake');

    instance.applyAgentSecretResponse({ agentSecret: '   ' });
    expect(instance.agentSecret).toBe(null);
  });

  it('keeps Agent install commands out of the Security tab', async () => {
    const component = await loadComponent();
    const noSecret = createInstance(component, { agentSecret: null });

    expect(noSecret.agentInstallCommand).toBeUndefined();
    expect(noSecret.agentLlmCommand).toBeUndefined();
    expect(noSecret.agentRunCommand).toBeUndefined();
    expect(noSecret.agentServiceCommand).toBeUndefined();
    expect(noSecret.agentSecretActionLabel).toBe('settings.security.generateKey');
  });

  it('loads and preserves the secret when settings is mounted already visible', async () => {
    const component = await loadComponent();
    const fetch = vi.fn(async url => {
      if (url === '/api/user/profile') {
        return { ok: true, json: async () => ({ username: 'dev-user', displayName: 'Dev User', role: 'pro' }) };
      }
      if (url === '/api/user/agent-secret') {
        return { ok: true, json: async () => ({ agentSecret: 'fake-secret-reloaded' }) };
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    globalThis.fetch = fetch;
    const instance = createInstance(component, { visible: true, _consumeSsoQueryFlags: vi.fn() });

    await component.mounted.call(instance);

    expect(fetch).toHaveBeenCalledWith('/api/user/agent-secret', expect.any(Object));
    expect(instance.agentSecret).toBe('fake-secret-reloaded');
  });

  it('applies Yeaft VP edit entry point when mounted already visible', async () => {
    const component = await loadComponent();
    const loadData = vi.fn(async () => {});
    const instance = createInstance(component, {
      visible: true,
      initialTab: 'yeaft',
      initialSubTab: 'vp',
      initialEditVpId: 'vp_custom',
      visibleTabs: [{ key: 'general' }, { key: 'yeaft' }],
      yeaftSubTabs: [{ key: 'vp' }, { key: 'search' }, { key: 'mcp' }],
      loadData,
    });

    await component.mounted.call(instance);

    expect(instance.activeTab).toBe('yeaft');
    expect(instance.yeaftSubTab).toBe('vp');
    expect(loadData).toHaveBeenCalledOnce();
    expect(component.template).toContain('<VpCrudPanel :initial-edit-vp-id="initialEditVpId" />');
  });

  it('updates secret and commands immediately after generation', async () => {
    const component = await loadComponent();
    const fetch = vi.fn(async url => {
      expect(url).toBe('/api/user/agent-secret/reset');
      return { ok: true, json: async () => ({ agentSecret: 'fake-secret-generated' }) };
    });
    globalThis.fetch = fetch;
    const instance = createInstance(component, { agentSecret: null, showMessage: vi.fn() });

    await instance.resetSecret();

    expect(instance.agentSecret).toBe('fake-secret-generated');
    expect(instance.showSecret).toBe(true);
    expect(instance.showMessage).toHaveBeenCalledWith('settings.msg.keyReset');
  });
});
