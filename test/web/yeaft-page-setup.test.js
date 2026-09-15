// @vitest-environment happy-dom
import * as Vue from 'vue';
import { mount } from '@vue/test-utils';
import YeaftSessionActions from '../../web/components/YeaftSessionActions.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let YeaftPage;
let loadHistorySenderPreference;
let saveHistorySenderPreference;

const sessionsStore = Vue.reactive({
  activeSessionId: 'session-1',
  activeSession: { id: 'session-1', roster: ['omni'], defaultVpId: 'omni' },
  activeNeedsInvite: false,
  hasLoadedSnapshot: true,
  isEmpty: false,
  sessions: { 'session-1': { id: 'session-1', roster: ['omni'], defaultVpId: 'omni' } },
  sessionById: sessionId => sessionsStore.sessions[sessionId] || null,
});

const chatStore = Vue.reactive({
  currentAgent: 'agent-1',
  currentAgentInfo: { online: true },
  agents: [{ id: 'agent-1', online: true }],
  _hasHandledAgentList: true,
  _hasHandledYeaftSessionHydrate: true,
  yeaftSessionHydrateError: null,
  yeaftActiveSessionFilter: 'session-1',
  sidebarCollapsed: false,
  sessionSidebarOpen: false,
  workCenterOpen: false,
  workbenchExpanded: false,
  workbenchMaximized: false,
  yeaftAvailableModels: [],
  yeaftActiveTasksBySession: {},
  inputDrafts: {},
  hasCapability: () => false,
  getYeaftHistoryOutlineState: () => ({ results: [], loading: false, hasMore: false, totalCount: 0 }),
  loadYeaftHistoryOutline: vi.fn(),
  yeaftHistorySearchState: { query: '', senderKey: '' },
  searchYeaftHistory: vi.fn(),
  openYeaftTurnDebug: vi.fn(),
  closeYeaftDebugPanel: vi.fn(),
});

beforeAll(async () => {
  globalThis.Vue = Vue;
  globalThis.Pinia = {
    defineStore: () => () => ({}),
    useChatStore: () => chatStore,
    useAuthStore: () => ({}),
    useVpStore: () => ({ vpList: [], vpLabel: vpId => vpId }),
    useSessionsStore: () => sessionsStore,
  };
  window.Pinia = globalThis.Pinia;
  ({ default: YeaftPage, loadHistorySenderPreference, saveHistorySenderPreference } = await import('../../web/components/YeaftPage.js'));
});

beforeEach(() => {
  localStorage.clear();
  sessionsStore.sessions = {
    'session-1': {
      id: 'session-1',
      title: 'Conversation title',
      workDir: '/home/user/projects/yeaft-web-code-agent',
      roster: ['omni'],
      defaultVpId: 'omni',
      config: { model: 'provider/session-model', modelEffort: 'high' },
    },
  };
  sessionsStore.activeSession = sessionsStore.sessions['session-1'];
  chatStore.yeaftModel = 'provider/fallback-model';
  chatStore.yeaftModelEffort = 'medium';
  chatStore.yeaftAvailableModels = [
    { id: 'session-model', provider: 'provider', ref: 'provider/session-model', effortOptions: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
    { id: 'next-model', provider: 'provider', ref: 'provider/next-model', effortOptions: ['medium', 'high'] },
  ];
  chatStore.switchYeaftModel = vi.fn();
  chatStore.yeaftHistorySearchState = { query: '', senderKey: '' };
  chatStore.loadYeaftHistoryOutline.mockReset();
  chatStore.searchYeaftHistory.mockReset();
  chatStore.openYeaftTurnDebug.mockReset();
  chatStore.closeYeaftDebugPanel.mockReset();
  chatStore.toggleWorkbench = vi.fn(() => {
    chatStore.workbenchExpanded = !chatStore.workbenchExpanded;
  });
  chatStore.workbenchExpanded = false;
  chatStore.workbenchMaximized = false;
  chatStore.yeaftDebugPanel = {
    open: false,
    status: 'idle',
    requestId: null,
    agentId: null,
    sessionId: null,
    turnId: null,
    error: null,
  };
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('YeaftPage setup', () => {
  it('uses an accessible flat tab bar for Yeaft settings', () => {
    const panel = readFileSync(resolve(import.meta.dirname, '../../web/components/SettingsPanel.js'), 'utf8');
    const css = readFileSync(resolve(import.meta.dirname, '../../web/styles/settings.css'), 'utf8');

    expect(panel).toContain('class="sp-subtab-bar" role="tablist"');
    expect(panel).toContain('role="tab"');
    expect(panel).toContain(':aria-selected="yeaftSubTab === st.key"');
    expect(panel).toContain('role="tabpanel"');

    expect(css).toMatch(/\.sp-subtab-bar\s*\{[^}]*border-bottom:\s*1px solid var\(--border-color\);/s);
    expect(css).toMatch(/\.sp-subtab::after\s*\{[^}]*height:\s*2px;[^}]*background:\s*transparent;/s);
    expect(css).toMatch(/\.sp-subtab\.active::after[^}]*\{[^}]*background:\s*var\(--text-primary\);/s);
    expect(css).not.toMatch(/\.sp-subtab-bar\s*\{[^}]*border-radius:/s);
    expect(css).not.toMatch(/\.sp-subtab\.active\s*\{[^}]*box-shadow:/s);

    expect(panel).toContain(":class=\"{ 'settings-scroll-yeaft': activeTab === 'yeaft' }\"");
    expect(css).toMatch(/\.settings-scroll-yeaft\s*\{[^}]*overflow-y:\s*hidden;/s);
    expect(css).toMatch(/\.settings-scroll-yeaft\s+\.settings-pane-yeaft\s*\{[^}]*flex:\s*1;[^}]*min-height:\s*0;/s);
    expect(css).toMatch(/\.settings-scroll-yeaft\s+\.sp-subpane\s*\{[^}]*overflow-y:\s*auto;/s);
  });

  it('keeps automatic history hydration and Session inventory out of the manual refresh spinner', () => {
    const source = YeaftPage.template;
    const actionsStart = source.indexOf('<YeaftSessionActions');
    const actionsEnd = source.indexOf('/>', actionsStart);
    const actions = source.slice(actionsStart, actionsEnd);

    expect(actions).toContain(':loading-more-history="store.yeaftManualHistoryRefreshLoading"');
    expect(actions).not.toContain('store.yeaftLoadingMoreHistory');
    expect(actions).not.toContain('yeaftSessionHydrateRequestId');
    expect(actions).toContain('@reload-messages="reloadMessages"');
  });

  it('forks the visible Session from an accessible header action with shared pending state', async () => {
    chatStore.sessionForkUnavailableReason = vi.fn(() => null);
    chatStore.copyCatalogSession = vi.fn(async () => ({ ok: true }));
    const page = YeaftPage.setup();
    expect(page.forkSessionRow.value).toEqual({ routeRef: {
      runtimeProvider: 'yeaft', agentId: 'agent-1', sessionId: 'session-1',
    } });
    await page.forkCurrentSession();
    expect(chatStore.copyCatalogSession).toHaveBeenCalledWith(page.forkSessionRow.value);
    chatStore.sessionForkUnavailableReason = vi.fn(() => 'fork_pending');
    await page.forkCurrentSession();
    expect(chatStore.copyCatalogSession).toHaveBeenCalledTimes(1);
    const actions = mount(YeaftSessionActions, {
      props: { showFork: true }, global: { mocks: { $t: key => key } },
    });
    const fork = actions.get('.yeaft-fork-btn');
    expect(fork.classes()).not.toContain('btn-ghost');
    expect(fork.text()).toBe('');
    expect(fork.find('svg').exists()).toBe(true);
    expect(fork.attributes('aria-label')).toBe('yeaft.session.forkCurrent');
    await fork.trigger('click');
    expect(actions.emitted('fork-session')).toHaveLength(1);
    await actions.setProps({ forkDisabled: true, forkPending: true });
    expect(fork.attributes('disabled')).toBeDefined();
    expect(fork.attributes('aria-busy')).toBe('true');
    await fork.trigger('click');
    expect(actions.emitted('fork-session')).toHaveLength(1);
    await actions.setProps({ showFork: false });
    expect(actions.find('.yeaft-fork-btn').exists()).toBe(false);
    actions.unmount();
  });

  it('defaults Session history search to the user without replacing an explicit sender choice', async () => {
    const page = YeaftPage.setup();


    expect(page.topbarSessionTitle.value).toBe('Conversation title');
    expect(page.topbarFolderPath.value).toBe('/home/user/projects/yeaft-web-code-agent');
    expect(page.topbarModel.value).toBe('provider/session-model');
    expect(page.topbarEffort.value).toBe('high');

    expect(page.topbarModelLabel.value).toBe('session-model');
    expect(page.topbarEffortOptions.value).toEqual(['medium', 'high', 'xhigh', 'max', 'ultra']);

    page.selectModel('provider/next-model', 'medium');
    expect(chatStore.switchYeaftModel).toHaveBeenCalledWith('provider/next-model', 'session-1', 'medium');
    page.selectEffort('ultra');
    expect(chatStore.switchYeaftModel).toHaveBeenLastCalledWith('provider/session-model', 'session-1', 'ultra');

    const source = YeaftPage.template;
    const topbarStart = source.indexOf('<div class="yeaft-topbar">');
    const topbarEnd = source.indexOf('</div>', source.indexOf('<YeaftSessionActions', topbarStart));
    const topbar = source.slice(topbarStart, topbarEnd);
    expect(topbar).toContain('class="yeaft-topbar-folder"');
    expect(topbar).toContain('class="yeaft-topbar-context"');
    expect(topbar).not.toContain('class="yeaft-composer-model"');
    expect(source).toContain('class="yeaft-session-input"');
    expect(source).toContain('<template #actions-end-before>');
    expect(source).toContain('class="yeaft-composer-model-controls"');
    expect(source).toContain('class="yeaft-composer-choice yeaft-composer-model-choice"');
    expect(source).toContain('class="yeaft-composer-model"');
    expect(source).toContain('class="yeaft-composer-choice yeaft-composer-effort-choice"');
    expect(source).toContain('class="yeaft-composer-effort"');
    expect(source).toContain("@click.stop=\"toggleComposerMenu('model')\"");
    expect(source).toContain("@click.stop=\"toggleComposerMenu('effort')\"");
    expect(source).not.toContain('@mouseenter=');
    expect(source).not.toContain('@mouseleave=');
    expect(source).not.toContain('@focusin=');
    expect(source).toContain("$t('yeaft.modelMenu.effort.' + topbarEffort)");
    const enSource = readFileSync(resolve(import.meta.dirname, '../../web/i18n/en.js'), 'utf8');
    const zhSource = readFileSync(resolve(import.meta.dirname, '../../web/i18n/zh-CN.js'), 'utf8');
    expect(enSource).toContain("'yeaft.modelMenu.effort.ultra': 'Ultra'");
    expect(zhSource).toContain("'yeaft.modelMenu.effort.ultra': '极致'");
    expect(source).toContain('class="yeaft-model-option-provider"');
    expect(source).toContain('class="yeaft-model-option-ctx"');
    expect(source).toContain('class="yeaft-model-config-option"');
    expect(source).toContain(':title="topbarFolderPath"');
    const yeaftCss = readFileSync(resolve(import.meta.dirname, '../../web/styles/yeaft.css'), 'utf8');
    expect(yeaftCss).toMatch(/\.yeaft-topbar\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\) minmax\(0, 1fr\);/s);
    expect(yeaftCss).toMatch(/\.yeaft-topbar-context\s*\{[^}]*grid-column:\s*1 \/ -1;[^}]*grid-row:\s*1;/s);
    expect(yeaftCss).toMatch(/\.yeaft-topbar-title-group\s*\{[^}]*grid-column:\s*2;/s);
    expect(yeaftCss).toMatch(/\.yeaft-topbar-right\s*\{[^}]*grid-column:\s*3;[^}]*justify-self:\s*end;/s);
    const mobileTopbar = yeaftCss.slice(yeaftCss.indexOf('@media (max-width: 768px)'));
    expect(mobileTopbar).toMatch(/\.yeaft-topbar-context\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/s);
    expect(mobileTopbar).toMatch(/\.yeaft-topbar-title-group\s*\{[^}]*grid-column:\s*1;[^}]*grid-row:\s*1;/s);
    expect(mobileTopbar).toMatch(/\.yeaft-topbar-folder\s*\{[^}]*grid-column:\s*1;[^}]*grid-row:\s*2;/s);

    page.toggleComposerMenu('model');
    expect(page.composerMenuOpen.value).toBe('model');
    page.toggleComposerMenu('model');
    expect(page.composerMenuOpen.value).toBeNull();
    page.toggleComposerMenu('effort');
    expect(page.composerMenuOpen.value).toBe('effort');
    page.toggleComposerMenu('model');
    expect(page.composerMenuOpen.value).toBe('model');
    page.selectEffort('low');
    expect(chatStore.switchYeaftModel).not.toHaveBeenLastCalledWith('provider/session-model', 'session-1', 'low');
    page.closeComposerMenu();
    expect(page.composerMenuOpen.value).toBeNull();

    page.toggleHistorySearch();
    await Vue.nextTick();
    expect(chatStore.yeaftHistorySearchState.senderKey).toBe('user');
    expect(chatStore.searchYeaftHistory).toHaveBeenCalledWith('', { senderKey: 'user' });

    page.toggleHistorySearch();
    page.toggleHistorySearch();
    await Vue.nextTick();
    expect(chatStore.yeaftHistorySearchState.senderKey).toBe('user');
    expect(chatStore.searchYeaftHistory).toHaveBeenLastCalledWith('', { senderKey: 'user' });
  });

  it('defaults mobile Session navigation to conversation and only opens status explicitly', async () => {
    const originalMatchMedia = window.matchMedia;
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(query => ({
        matches: query === '(max-width: 768px)' || query === '(max-width: 1024px)',
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    localStorage.setItem('yeaft-session-status-visible', '1');
    try {
      const page = YeaftPage.setup();

      expect(page.isMobile.value).toBe(true);
      expect(page.sessionStatusVisible.value).toBe(false);

      page.toggleSessionStatus();
      expect(page.sessionStatusVisible.value).toBe(true);
      expect(localStorage.getItem('yeaft-session-status-visible')).toBe('1');

      chatStore.yeaftActiveSessionFilter = 'session-2';
      await Vue.nextTick();
      expect(page.sessionStatusVisible.value).toBe(false);
    } finally {
      chatStore.yeaftActiveSessionFilter = 'session-1';
      Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia });
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
    }
  });

  it('keeps debug scoped to finished AI messages and removes the header entry', () => {
    const page = YeaftPage.setup();
    const source = YeaftPage.template;
    const actionsStart = source.indexOf('<YeaftSessionActions');
    const actionsEnd = source.indexOf('/>', actionsStart);
    const actions = source.slice(actionsStart, actionsEnd);

    expect(page.debugMode.value).toBe(false);
    expect(actions).not.toContain(':debug-mode=');
    expect(actions).not.toContain('@toggle-debug=');
    expect(page.toggleDebug).toBeUndefined();

    // The per-turn debug icon opens the panel via the store; YeaftPage
    // renders the detail panel as soon as the store opens it.
    chatStore.yeaftDebugPanel = {
      open: true,
      status: 'loading',
      requestId: 'dbgpanel_1',
      agentId: 'agent-1',
      sessionId: 'session-1',
      turnId: 'turn-abc',
      error: null,
    };
    expect(page.debugMode.value).toBe(true);
    page.closeDebug();
    expect(chatStore.closeYeaftDebugPanel).toHaveBeenCalled();

    chatStore.yeaftDebugPanel.open = false;
    chatStore.workbenchExpanded = true;
    expect(page.sessionStatusVisible.value).toBe(false);

    page.toggleSessionStatus();
    expect(page.sessionStatusVisible.value).toBe(true);
    expect(chatStore.toggleWorkbench).toHaveBeenCalledTimes(1);
    expect(chatStore.closeYeaftDebugPanel).toHaveBeenCalledTimes(2);

    page.toggleWorkbench();
    expect(page.sessionStatusVisible.value).toBe(false);
    expect(chatStore.toggleWorkbench).toHaveBeenCalledTimes(2);
  });
});
