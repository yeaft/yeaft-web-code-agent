// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { useUserPreferences } from '../../web/utils/user-preferences.js';
import UnifiedSessionList from '../../web/components/UnifiedSessionList.js';
import en from '../../web/i18n/en.js';

// Capture real actions without creating a socket or bootstrapping a browser owner.
const stores = {};
globalThis.Pinia = { defineStore: (id, options) => { stores[id] = options; return () => ({}); } };
await import('../../web/stores/chat.js');
const { default: YeaftSidebar } = await import('../../web/components/YeaftSidebar.js');
const actions = stores.chat.actions;

const route = { runtimeProvider: 'yeaft', agentId: 'agent-a', sessionId: 'session-a' };
const row = { catalogKey: 'yeaft:agent-a:session-a', runtimeProvider: 'yeaft', routeRef: route, title: 'Session A', availability: 'online' };
const agents = [{ id: 'agent-a', online: true, capabilities: ['work_center'] }];
let wrapper;
let store;
let preferences;
const localize = key => en[key] || key;
const globalOptions = { mocks: { $t: localize } };

beforeEach(() => {
  vi.stubGlobal('Vue', Vue);
  let saved = { sidebarProjectsRatio: 0.5, sidebarActionsCompact: false };
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
    if (options?.method === 'PATCH') saved = { ...saved, ...JSON.parse(options.body) };
    return { ok: true, json: async () => ({ ...saved, version: '' }) };
  }));
  localStorage.clear();
  store = Vue.reactive({
    agents, sessionProjects: [], sessionCatalog: [row], sessionCatalogLoaded: true,
    activeSessionRoute: route, sessionSidebarOpen: true, pluginCenterOpen: false,
    openPluginCenter: vi.fn(() => { store.pluginCenterOpen = true; return true; }),
    closePluginCenter: vi.fn(() => { store.pluginCenterOpen = false; }),
    closeSessionSidebar: vi.fn(() => { store.sessionSidebarOpen = false; }),
    openCatalogSession: vi.fn(),
  });
  const auth = Vue.reactive({ isAuthenticated: true, userId: 'sidebar-owner', authGeneration: 1 });
  vi.stubGlobal('Pinia', { useChatStore: () => store, useAuthStore: () => auth });
  preferences = useUserPreferences();
});
afterEach(() => { wrapper?.unmount(); preferences?.dispose(); vi.unstubAllGlobals(); });

function renderList(extraProps = {}) {
  wrapper = mount(UnifiedSessionList, { props: {
    projectStore: store, sessions: [row], activeRoute: route, agents, ...extraProps,
  }, global: globalOptions });
  return wrapper;
}

describe('Plugin Center sidebar navigation', () => {
  it('keeps labeled shortcuts by default, offers reversible compact mode on overflow and preserves Session identity', async () => {
    renderList();
    await flushPromises();
    const buttons = wrapper.get('.sidebar-primary-actions').findAll('button');
    const names = [en['sidebar.sessions.newChat'], en['scheduledTasks.new'], en['yeaft.plugins.title']];
    expect(buttons.map(button => button.attributes('aria-label'))).toEqual(names);
    expect(buttons.map(button => button.attributes('title'))).toEqual(names);
    expect(buttons.map(button => button.text())).toEqual(names);
    expect(wrapper.find('.sidebar-actions-toggle').exists()).toBe(false);
    const results = wrapper.get('.sidebar-session-results').element;
    const recents = wrapper.get('.recents-section').element;
    Object.defineProperties(results, { clientHeight: { configurable: true, value: 300 }, clientWidth: { configurable: true, value: 260 } });
    Object.defineProperties(recents, { clientHeight: { configurable: true, value: 100 }, scrollHeight: { configurable: true, value: 180 } });
    wrapper.vm.measureSessionOverflow();
    await Vue.nextTick();
    expect(wrapper.get('.sidebar-actions-toggle').attributes('aria-expanded')).toBe('true');
    expect(wrapper.get('.sidebar-primary-actions > .sidebar-actions-toggle').text()).toBe('');
    expect(wrapper.get('.sidebar-actions-toggle').attributes('aria-label')).toBe(en['sidebar.actions.collapse']);
    await wrapper.get('.sidebar-actions-toggle').trigger('click');
    await flushPromises();
    expect(wrapper.get('.sidebar-primary-actions').classes()).toContain('is-compact');
    for (const button of buttons) {
      expect(button.text()).toBe('');
      expect(button.findAll('svg[aria-hidden="true"]')).toHaveLength(1);
    }
    Object.defineProperty(recents, 'scrollHeight', { configurable: true, value: 100 });
    wrapper.vm.measureSessionOverflow();
    await Vue.nextTick();
    // Compact mode must retain its restore control even when all rows now fit.
    expect(wrapper.get('.sidebar-actions-toggle').attributes('aria-expanded')).toBe('false');
    await wrapper.get('.sidebar-actions-toggle').trigger('click');
    await flushPromises();
    expect(buttons.map(button => button.text())).toEqual(names);
    wrapper.vm.measureSessionOverflow();
    await Vue.nextTick();
    expect(wrapper.find('.sidebar-actions-toggle').exists()).toBe(false);
    expect(wrapper.get('.sidebar-session-row').classes()).toContain('active');
    await wrapper.get('.sidebar-plugins-entry').trigger('click');
    expect(store.openPluginCenter).toHaveBeenCalledOnce();
    expect(store.sessionSidebarOpen).toBe(false);
    expect(wrapper.get('.sidebar-plugins-entry').classes()).toContain('active');
    expect(wrapper.get('.sidebar-plugins-entry').attributes('aria-current')).toBe('page');
    expect(wrapper.get('.sidebar-session-row').classes()).not.toContain('active');
    expect(store.activeSessionRoute).toEqual(route);
    await wrapper.setProps({ agents: [{ ...agents[0], online: false }] });
    expect(wrapper.get('.sidebar-plugins-entry').attributes('disabled')).toBeDefined();
  });

  it('renders only one Plugins entry in the native sidebar and none in its Settings footer', () => {
    wrapper = mount(YeaftSidebar, { global: { ...globalOptions, stubs: {
      SidebarAgentHeader: true, SidebarDigitalPerson: true, SidebarWorkCenter: true,
    } } });
    expect(wrapper.findAll('.sidebar-plugins-entry')).toHaveLength(1);
    expect(wrapper.get('.sidebar-bottom').text()).toBe(en['chat.sidebar.settings']);
    expect(wrapper.get('.sidebar-primary-actions').findAll('button')[2].classes()).toContain('sidebar-plugins-entry');
  });

  it('leaves Plugins for both New chat and project Session creation, preserving existing Work Center close events', async () => {
    store.pluginCenterOpen = true;
    renderList({ workCenterOpen: true, projects: [{ id: 'project-a', name: 'Project A' }] });
    await wrapper.get('.sidebar-primary-action').trigger('click');
    expect(store.pluginCenterOpen).toBe(false);
    expect(wrapper.emitted('create')).toHaveLength(1);
    store.pluginCenterOpen = true;
    await wrapper.get('.sidebar-project-session-create').trigger('click');
    expect(store.pluginCenterOpen).toBe(false);
    expect(wrapper.emitted('create-in-project')[0][0].project.id).toBe('project-a');
    expect(wrapper.emitted('close-work-center')).toHaveLength(2);
    store.pluginCenterOpen = true;
    await wrapper.setProps({ loading: true });
    await wrapper.get('.sidebar-primary-action').trigger('click');
    expect(store.pluginCenterOpen).toBe(true);
    expect(wrapper.emitted('create')).toHaveLength(1);
  });

  it('closes Plugins and the mobile drawer before repeated current Session navigation for native and both CLI providers', () => {
    const navigation = [];
    const context = {
      pluginCenterOpen: true, sessionSidebarOpen: true, currentView: 'chat',
      currentConversation: 'session-a', panels: [{ id: 'panel-a' }],
      conversations: [], pendingNewConversation: false,
      closePluginCenter() { this.pluginCenterOpen = false; navigation.push('plugins-closed'); },
      closeSessionSidebar() { this.sessionSidebarOpen = false; navigation.push('drawer-closed'); },
      isSessionHistorySyncing: () => false,
      enterYeaft: vi.fn(() => {
        expect(context.pluginCenterOpen).toBe(false);
        expect(context.sessionSidebarOpen).toBe(false);
      }),
      setActiveSessionFilter: vi.fn(), reloadYeaftMessages: vi.fn(),
      syncChatConversationHistory: vi.fn(), setPanelConversation: vi.fn(),
      selectConversation: actions.selectConversation,
    };
    for (const runtimeProvider of ['yeaft', 'claude-code', 'copilot']) {
      context.pluginCenterOpen = true;
      context.sessionSidebarOpen = true;
      expect(actions.openCatalogSession.call(context, { ...row, routeRef: { ...route, runtimeProvider } })).toBe(true);
      expect(context.pluginCenterOpen).toBe(false);
      expect(context.sessionSidebarOpen).toBe(false);
    }
    expect(context.setActiveSessionFilter).toHaveBeenCalledWith('session-a', { agentId: 'agent-a', force: false });
    expect(context.syncChatConversationHistory).toHaveBeenCalledTimes(2);
    // The CLI helper also returns early in split mode, before its normal close path.
    context.pluginCenterOpen = true;
    context.sessionSidebarOpen = true;
    context.panels.push({ id: 'panel-b' });
    actions.openCatalogSession.call(context, { ...row, routeRef: { ...route, runtimeProvider: 'copilot' } });
    expect(context.setPanelConversation).toHaveBeenCalledWith('panel-a', 'session-a', { refresh: true });
    expect(context.pluginCenterOpen).toBe(false);
    expect(context.sessionSidebarOpen).toBe(false);
    expect(navigation.slice(0, 2)).toEqual(['plugins-closed', 'drawer-closed']);
  });

  it('does not navigate or dismiss Plugins for an invalid catalog descriptor', () => {
    store.pluginCenterOpen = true;
    expect(actions.openCatalogSession.call(store, null)).toBe(false);
    expect(actions.openCatalogSession.call(store, { ...row, routeRef: { ...route, runtimeProvider: 'unknown' } })).toBe(false);
    expect(store.closePluginCenter).not.toHaveBeenCalled();
    expect(store.closeSessionSidebar).not.toHaveBeenCalled();
    expect(store.pluginCenterOpen).toBe(true);
  });

  it('leaves Plugins when entering Work Center without switching the underlying Session Agent', () => {
    Object.assign(store, {
      pluginCenterOpen: true, currentAgent: 'session-agent',
      hydrateWorkCenterBrowserState: () => true,
      listWorkItems: vi.fn(async () => []),
    });
    expect(actions.enterWorkCenter.call(store, 'agent-a')).toBe(true);
    expect(store.pluginCenterOpen).toBe(false);
    expect(store.sessionSidebarOpen).toBe(false);
    expect(store.workCenterOpen).toBe(true);
    expect(store.workCenterAgentId).toBe('agent-a');
    expect(store.currentAgent).toBe('session-agent');
  });
});
