// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isWorkbenchMessageForRoute,
  workbenchWorkspaceGeneration,
} from '../../web/utils/workbench-route.js';
import * as Vue from 'vue';
import {
  collectMessageFileReferences,
  collectMessageImageReferences,
  decorateMessageFileReferences,
  resolveMessageFileReference,
  resolveMessageImageFileReference,
} from '../../web/utils/message-file-reference.js';

const readWeb = path => readFileSync(resolve(process.cwd(), 'web', path), 'utf8');

const capabilityMounts = [];
const capabilityUnmounts = [];

function capabilityStub(name, className) {
  const componentName = {
    terminal: 'TerminalTab',
    git: 'GitStatusTab',
    files: 'FilesTab',
    browser: 'BrowserPanel',
  }[name];
  return {
    name: componentName,
    props: {
      routeKey: { type: String, default: '' },
      runtimeProvider: { type: String, default: '' },
      agentId: { type: String, default: '' },
      sessionId: { type: String, default: '' },
      conversationId: { type: String, default: '' },
      workDir: { type: String, default: '' },
      workspaceGeneration: { type: String, default: '' },
    },
    setup(props) {
      Vue.onMounted(() => capabilityMounts.push({ name, ...props }));
      Vue.onUnmounted(() => capabilityUnmounts.push({ name, ...props }));
      return { props };
    },
    template: `<div :class="'${className}'" :data-route-key="props.routeKey" :data-session-id="props.sessionId" :data-work-dir="props.workDir" :data-workspace-generation="props.workspaceGeneration">${name}</div>`,
  };
}

const workbenchStore = Vue.reactive({
  workbenchExpanded: true,
  workbenchMaximized: false,
  currentAgent: 'agent-1',
  currentConversation: 'yeaft-agent-1',
  activeSessionRoute: {
    runtimeProvider: 'yeaft',
    agentId: 'agent-1',
    sessionId: 'session-a',
  },
  effectiveWorkDir: '/workspace/a',
  capabilities: ['terminal', 'file_editor', 'workbench_session_routes'],
  workbenchRouteProtocolSupported: true,
  hasCapability(capability) {
    return this.capabilities.includes(capability);
  },
  toggleWorkbench: vi.fn(),
  toggleWorkbenchMaximized: vi.fn(),
  rememberWorkbenchPanelState: vi.fn(),
  restoreWorkbenchPanelState: vi.fn(),
  workbenchPanelWidthForRoute: vi.fn(() => null),
});

globalThis.Vue = Vue;
globalThis.Pinia = {
  ...(globalThis.Pinia || {}),
  defineStore: globalThis.Pinia?.defineStore || (() => () => ({})),
  useChatStore: () => workbenchStore,
};
window.Pinia = globalThis.Pinia;

const { default: WorkbenchPanel } = await import('../../web/components/WorkbenchPanel.js');
const { default: ChatHeader } = await import('../../web/components/ChatHeader.js');

function mountWorkbench(t = key => key) {
  return mount(WorkbenchPanel, {
    attachTo: document.body,
    global: {
      mocks: { $t: t },
      stubs: {
        TerminalTab: capabilityStub('terminal', 'terminal-tab-stub'),
        GitStatusTab: capabilityStub('git', 'git-tab-stub'),
        FilesTab: capabilityStub('files', 'files-tab-stub'),
        BrowserPanel: capabilityStub('browser', 'browser-panel-stub'),
      },
    },
  });
}

async function openWorkbenchCapability(wrapper, capabilityId) {
  await wrapper.get('.workbench-add-btn').trigger('click');
  await wrapper.get(`.workbench-add-menu-item[data-workbench-capability="${capabilityId}"]`).trigger('click');
  await Vue.nextTick();
}

describe('Workbench capability launcher', () => {
  beforeEach(() => {
    workbenchStore.workbenchExpanded = true;
    workbenchStore.workbenchMaximized = false;
    workbenchStore.currentAgent = 'agent-1';
    workbenchStore.currentConversation = 'yeaft-agent-1';
    workbenchStore.activeSessionRoute = {
      runtimeProvider: 'yeaft',
      agentId: 'agent-1',
      sessionId: 'session-a',
    };
    workbenchStore.effectiveWorkDir = '/workspace/a';
    workbenchStore.capabilities = ['terminal', 'file_editor', 'workbench_session_routes'];
    workbenchStore.workbenchRouteProtocolSupported = true;
    workbenchStore.browserRuntimeServerEnabled = false;
    workbenchStore.browserRuntimeProtocolSupported = false;
    workbenchStore.browserRuntimeSetupProtocolSupported = false;
    capabilityMounts.length = 0;
    capabilityUnmounts.length = 0;
    workbenchStore.toggleWorkbench.mockClear();
    workbenchStore.toggleWorkbenchMaximized.mockClear();
    workbenchStore.rememberWorkbenchPanelState.mockClear();
    workbenchStore.restoreWorkbenchPanelState.mockClear();
    workbenchStore.workbenchPanelWidthForRoute.mockReset();
    workbenchStore.workbenchPanelWidthForRoute.mockReturnValue(null);
    globalThis.Pinia.useChatStore = () => workbenchStore;
    window.Pinia = globalThis.Pinia;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  it('starts on the four-item chooser and keeps the add button beside opened tabs', async () => {
    const wrapper = mountWorkbench();
    expect(wrapper.findAll('.workbench-item-tab')).toHaveLength(0);
    expect(wrapper.get('.workbench-launcher').isVisible()).toBe(true);
    expect(wrapper.findAll('.workbench-capability-card').map(item => item.attributes('data-workbench-capability')))
      .toEqual(['terminal', 'git', 'files', 'browser']);
    expect(wrapper.find('.workbench-header-title').exists()).toBe(false);
    expect(wrapper.get('.workbench-add-wrap').element.previousElementSibling).toBeNull();

    await wrapper.get('.workbench-add-btn').trigger('click');
    const items = wrapper.findAll('.workbench-add-menu-item');
    expect(items.map(item => item.attributes('data-workbench-capability')))
      .toEqual(['terminal', 'git', 'files', 'browser']);
    expect(wrapper.get('[data-workbench-capability="terminal"] small').text()).toBe('workbench.available');
    expect(wrapper.get('[data-workbench-capability="browser"] small').text()).toBe('workbench.unavailable');
    expect(wrapper.get('[data-workbench-capability="browser"]').attributes('disabled')).toBeUndefined();

    await wrapper.get('[data-workbench-capability="files"]').trigger('click');
    await Vue.nextTick();
    expect(wrapper.get('.files-tab-stub').isVisible()).toBe(true);
    expect(wrapper.findAll('.workbench-item-tab').map(tab => tab.text())).toEqual(['workbench.files×']);
    expect(wrapper.get('.workbench-add-wrap').element.previousElementSibling)
      .toBe(wrapper.get('.workbench-item-tab').element);
    expect(capabilityMounts.map(entry => entry.name)).toEqual(['files']);
    wrapper.unmount();
  });

  it('renders translated labels for empty capability tabs after computed updates', async () => {
    const labels = {
      'workbench.files': '文件',
      'workbench.terminal': '终端',
    };
    const wrapper = mountWorkbench(key => labels[key] || key);

    await openWorkbenchCapability(wrapper, 'files');
    await openWorkbenchCapability(wrapper, 'terminal');

    expect(wrapper.findAll('.workbench-item-tab').map(tab => tab.text())).toEqual(['文件×', '终端×']);
    wrapper.unmount();
  });

  it('lazily opens route-scoped abilities and switches or closes them as peer tabs', async () => {
    const wrapper = mountWorkbench();
    await openWorkbenchCapability(wrapper, 'files');
    await openWorkbenchCapability(wrapper, 'terminal');

    expect(wrapper.get('.terminal-tab-stub').isVisible()).toBe(true);
    expect(wrapper.get('.terminal-tab-stub').attributes()).toMatchObject({
      'data-route-key': 'yeaft:agent-1:session-a',
      'data-session-id': 'session-a',
      'data-work-dir': '/workspace/a',
      'data-workspace-generation': workbenchWorkspaceGeneration(
        'yeaft:agent-1:session-a',
        '/workspace/a',
      ),
    });
    expect(capabilityMounts.map(entry => entry.name)).toEqual(['files', 'terminal']);
    expect(wrapper.findAll('.workbench-item-tab').map(tab => tab.text()))
      .toEqual(['workbench.files×', 'workbench.terminal×']);

    await wrapper.findAll('.workbench-item-select')[0].trigger('click');
    expect(wrapper.get('.files-tab-stub').isVisible()).toBe(true);
    expect(capabilityUnmounts.map(entry => entry.name)).not.toContain('terminal');
    await wrapper.findAll('.workbench-item-select')[0].trigger('keydown', { key: 'ArrowRight' });
    await Vue.nextTick();
    expect(wrapper.get('.terminal-tab-stub').isVisible()).toBe(true);
    expect(capabilityMounts.map(entry => entry.name).filter(name => name === 'terminal')).toHaveLength(1);
    expect(document.activeElement).toBe(wrapper.findAll('.workbench-item-select')[1].element);
    await wrapper.findAll('.workbench-item-close')[1].trigger('click');
    await Vue.nextTick();
    expect(wrapper.findAll('.workbench-item-tab').map(tab => tab.text())).toEqual(['workbench.files×']);
    expect(capabilityUnmounts.map(entry => entry.name)).toContain('terminal');

    await wrapper.get('.workbench-add-btn').trigger('click');
    await wrapper.get('[data-workbench-capability="terminal"]').trigger('click');
    await Vue.nextTick();
    expect(capabilityMounts.map(entry => entry.name).filter(name => name === 'terminal').length).toBeGreaterThan(1);

    await wrapper.get('.workbench-panel-close').trigger('click');
    expect(workbenchStore.toggleWorkbench).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('lets Files veto capability close before pruning its cached instance', async () => {
    const closeRequests = [];
    const rejectClose = event => {
      closeRequests.push(event.detail);
      event.detail.resolve(false);
    };
    window.addEventListener('workbench-close-files-capability', rejectClose);
    const wrapper = mountWorkbench();
    await openWorkbenchCapability(wrapper, 'files');

    await wrapper.get('.workbench-item-close').trigger('click');
    await Vue.nextTick();
    expect(wrapper.findAll('.workbench-item-tab').map(tab => tab.text())).toEqual(['workbench.files×']);
    expect(closeRequests[0]).toMatchObject({
      routeKey: 'yeaft:agent-1:session-a',
      workspaceGeneration: workbenchWorkspaceGeneration('yeaft:agent-1:session-a', '/workspace/a'),
    });
    expect(capabilityUnmounts).toHaveLength(0);

    window.removeEventListener('workbench-close-files-capability', rejectClose);
    const acceptClose = event => event.detail.resolve(true);
    window.addEventListener('workbench-close-files-capability', acceptClose);
    await wrapper.get('.workbench-item-close').trigger('click');
    await Vue.nextTick();
    expect(wrapper.findAll('.workbench-item-tab')).toHaveLength(0);
    expect(capabilityUnmounts.map(entry => entry.name)).toContain('files');

    window.removeEventListener('workbench-close-files-capability', acceptClose);
    wrapper.unmount();
  });

  it('does not close Files in a new workspace after delayed confirmation', async () => {
    let resolveClose;
    const handleClose = event => { resolveClose = event.detail.resolve; };
    window.addEventListener('workbench-close-files-capability', handleClose);
    const wrapper = mountWorkbench();
    await openWorkbenchCapability(wrapper, 'files');

    await wrapper.get('.workbench-item-close').trigger('click');
    expect(resolveClose).toBeTypeOf('function');

    workbenchStore.activeSessionRoute = {
      runtimeProvider: 'yeaft', agentId: 'agent-1', sessionId: 'session-b',
    };
    workbenchStore.effectiveWorkDir = '/workspace/b';
    await Vue.nextTick();
    await openWorkbenchCapability(wrapper, 'files');
    resolveClose(true);
    await Vue.nextTick();

    expect(wrapper.findAll('.workbench-item-tab').map(tab => tab.text())).toEqual(['workbench.files×']);
    expect(wrapper.get('.files-tab-stub').attributes('data-route-key')).toBe('yeaft:agent-1:session-b');

    window.removeEventListener('workbench-close-files-capability', handleClose);
    wrapper.unmount();
  });

  it('implements the launcher menu keyboard and focus contract', async () => {
    const wrapper = mountWorkbench();
    const trigger = wrapper.get('.workbench-add-btn');

    await trigger.trigger('keydown', { key: 'ArrowDown' });
    await Vue.nextTick();
    const items = wrapper.findAll('.workbench-add-menu-item');
    expect(document.activeElement).toBe(items[0].element);

    await items[0].trigger('keydown', { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1].element);
    await items[1].trigger('keydown', { key: 'End' });
    expect(document.activeElement).toBe(items[items.length - 1].element);
    await items[items.length - 1].trigger('keydown', { key: 'Home' });
    expect(document.activeElement).toBe(items[0].element);
    await items[0].trigger('keydown', { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[items.length - 1].element);
    await items[items.length - 1].trigger('keydown', { key: 'Escape' });
    await Vue.nextTick();
    expect(wrapper.find('.workbench-add-menu').exists()).toBe(false);
    expect(document.activeElement).toBe(trigger.element);

    await trigger.trigger('keydown', { key: 'ArrowUp' });
    await Vue.nextTick();
    expect(document.activeElement).toBe(wrapper.findAll('.workbench-add-menu-item')[items.length - 1].element);
    wrapper.unmount();
  });

  it('restores the custom panel width for each Agent Session route', async () => {
    workbenchStore.workbenchPanelWidthForRoute.mockImplementation(route => ({
      'yeaft:agent-1:session-a': 640,
      'yeaft:agent-1:session-b': 480,
    })[`yeaft:${route.agentId}:${route.sessionId}`] || null);

    const wrapper = mountWorkbench();
    expect(wrapper.get('.workbench-panel').attributes('style')).toContain('width: 640px');

    workbenchStore.activeSessionRoute = {
      runtimeProvider: 'yeaft',
      agentId: 'agent-1',
      sessionId: 'session-b',
    };
    workbenchStore.effectiveWorkDir = '/workspace/b';
    await Vue.nextTick();

    expect(workbenchStore.rememberWorkbenchPanelState)
      .toHaveBeenCalledWith('yeaft:agent-1:session-a', 640);
    expect(wrapper.get('.workbench-panel').attributes('style')).toContain('width: 480px');
    wrapper.unmount();
  });

  it.each([
    ['a width transition', 352],
    ['a collapsed panel', 32],
    ['a constrained viewport', 340],
    ['a maximized panel', 1100],
  ])('keeps the user width across Session switches after observing %s', async (_state, measuredWidth) => {
    const savedWidths = new Map([
      ['yeaft:agent-1:session-a', 600],
      ['yeaft:agent-1:session-b', 480],
    ]);
    const routeKey = route => typeof route === 'string'
      ? route : `${route.runtimeProvider}:${route.agentId}:${route.sessionId}`;
    workbenchStore.workbenchPanelWidthForRoute.mockImplementation(route => savedWidths.get(routeKey(route)) ?? null);
    vi.spyOn(workbenchStore, 'rememberWorkbenchPanelState').mockImplementation((route, width) => {
      if (Number.isFinite(width) && width > 0) savedWidths.set(routeKey(route), width);
    });
    let observeResize;
    vi.spyOn(globalThis, 'ResizeObserver').mockImplementation(function (callback) {
      observeResize = callback;
      return { observe() {}, disconnect() {} };
    });
    const onResize = vi.fn();
    window.addEventListener('workbench-panel-resize', onResize);
    const wrapper = mountWorkbench();
    try {
      await wrapper.get('.resize-handle').trigger('mousedown', { clientX: 700 });
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 660 }));
      document.dispatchEvent(new MouseEvent('mouseup'));
      await Vue.nextTick();
      expect(savedWidths.get('yeaft:agent-1:session-a')).toBe(640);

      vi.spyOn(wrapper.get('.workbench-panel').element, 'getBoundingClientRect')
        .mockReturnValue({ width: measuredWidth });
      observeResize();
      await Vue.nextTick();
      expect(onResize.mock.lastCall[0].detail.width).toBe(measuredWidth);
      expect(wrapper.get('.workbench-panel').element.style.width).toBe('640px');

      workbenchStore.activeSessionRoute = {
        runtimeProvider: 'yeaft', agentId: 'agent-1', sessionId: 'session-b',
      };
      await Vue.nextTick();
      expect(savedWidths.get('yeaft:agent-1:session-a')).toBe(640);
      expect(wrapper.get('.workbench-panel').element.style.width).toBe('480px');
      observeResize();
      await Vue.nextTick();

      workbenchStore.activeSessionRoute = {
        runtimeProvider: 'yeaft', agentId: 'agent-1', sessionId: 'session-a',
      };
      await Vue.nextTick();
      expect(savedWidths.get('yeaft:agent-1:session-b')).toBe(480);
      expect(wrapper.get('.workbench-panel').element.style.width).toBe('640px');
    } finally {
      window.removeEventListener('workbench-panel-resize', onResize);
      wrapper.unmount();
    }
  });

  it('starts a resize from the rendered width without a jump when the layout is constrained', async () => {
    workbenchStore.workbenchPanelWidthForRoute.mockReturnValue(640);
    const wrapper = mountWorkbench();
    try {
      vi.spyOn(wrapper.get('.workbench-panel').element, 'getBoundingClientRect')
        .mockReturnValue({ width: 340 });
      await wrapper.get('.resize-handle').trigger('mousedown', { clientX: 700 });
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 660 }));
      document.dispatchEvent(new MouseEvent('mouseup'));
      await Vue.nextTick();
      expect(workbenchStore.rememberWorkbenchPanelState).toHaveBeenLastCalledWith({
        runtimeProvider: 'yeaft', agentId: 'agent-1', sessionId: 'session-a',
      }, 380);
    } finally {
      wrapper.unmount();
    }
  });

  it('saves the resized width for the active Agent Session route', async () => {
    workbenchStore.workbenchPanelWidthForRoute.mockReturnValue(500);
    const wrapper = mountWorkbench();

    await wrapper.get('.resize-handle').trigger('mousedown', { clientX: 700 });
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 600 }));
    document.dispatchEvent(new MouseEvent('mouseup'));
    await Vue.nextTick();

    expect(workbenchStore.rememberWorkbenchPanelState).toHaveBeenLastCalledWith({
      runtimeProvider: 'yeaft', agentId: 'agent-1', sessionId: 'session-a',
    }, 600);
    expect(wrapper.get('.workbench-panel').attributes('style')).toContain('width: 600px');
    wrapper.unmount();
  });

  it.each([
    ['mouse', { runtimeProvider: 'yeaft', agentId: 'agent-1', sessionId: 'session-b' }],
    ['touch', { runtimeProvider: 'yeaft', agentId: 'agent-2', sessionId: 'session-b' }],
  ])('cancels a %s resize when its Agent Session owner changes', async (pointerType, nextRoute) => {
    workbenchStore.workbenchPanelWidthForRoute.mockImplementation(route => (
      route.agentId === 'agent-1' && route.sessionId === 'session-a' ? 500 : 480
    ));
    const wrapper = mountWorkbench();
    const handle = wrapper.get('.resize-handle').element;
    const dispatchTouch = (target, type, clientX) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'touches', {
        value: clientX === undefined ? [] : [{ clientX }],
      });
      target.dispatchEvent(event);
    };

    if (pointerType === 'touch') dispatchTouch(handle, 'touchstart', 700);
    else handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 700 }));
    if (pointerType === 'touch') dispatchTouch(document, 'touchmove', 650);
    else document.dispatchEvent(new MouseEvent('mousemove', { clientX: 650 }));
    await Vue.nextTick();
    expect(wrapper.get('.workbench-panel').attributes('style')).toContain('width: 550px');

    workbenchStore.activeSessionRoute = nextRoute;
    workbenchStore.effectiveWorkDir = '/workspace/b';
    await Vue.nextTick();
    expect(wrapper.get('.workbench-panel').attributes('style')).toContain('width: 480px');
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');

    if (pointerType === 'touch') {
      dispatchTouch(document, 'touchmove', 600);
      dispatchTouch(document, 'touchend');
    } else {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 600 }));
      document.dispatchEvent(new MouseEvent('mouseup'));
    }
    await Vue.nextTick();

    expect(wrapper.get('.workbench-panel').attributes('style')).toContain('width: 480px');
    expect(workbenchStore.rememberWorkbenchPanelState).toHaveBeenCalledWith(
      'yeaft:agent-1:session-a',
      550,
    );
    expect(workbenchStore.rememberWorkbenchPanelState).not.toHaveBeenCalledWith(nextRoute, 600);
    wrapper.unmount();
  });

  it('cleans up an active resize when the workbench unmounts', () => {
    workbenchStore.workbenchPanelWidthForRoute.mockReturnValue(500);
    const wrapper = mountWorkbench();
    wrapper.get('.resize-handle').element.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, clientX: 700 }),
    );

    expect(document.body.style.cursor).toBe('col-resize');
    expect(document.body.style.userSelect).toBe('none');
    wrapper.unmount();
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');

    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 600 }));
    document.dispatchEvent(new MouseEvent('mouseup'));
    expect(workbenchStore.rememberWorkbenchPanelState).not.toHaveBeenCalled();
  });

  it('retains each Session terminal instance while restoring isolated active tabs', async () => {
    const wrapper = mountWorkbench();
    await openWorkbenchCapability(wrapper, 'terminal');
    expect(wrapper.get('.terminal-tab-stub').attributes('data-route-key')).toBe('yeaft:agent-1:session-a');
    expect(capabilityMounts.filter(entry => entry.name === 'terminal')).toHaveLength(1);

    workbenchStore.activeSessionRoute = {
      runtimeProvider: 'yeaft',
      agentId: 'agent-1',
      sessionId: 'session-b',
    };
    workbenchStore.effectiveWorkDir = '/workspace/b';
    await Vue.nextTick();
    expect(workbenchStore.rememberWorkbenchPanelState)
      .toHaveBeenCalledWith('yeaft:agent-1:session-a', undefined);
    expect(workbenchStore.restoreWorkbenchPanelState).toHaveBeenCalledWith({
      runtimeProvider: 'yeaft', agentId: 'agent-1', sessionId: 'session-b',
    });
    expect(wrapper.find('.terminal-tab-stub').exists()).toBe(false);
    expect(wrapper.get('.workbench-launcher').isVisible()).toBe(true);
    expect(capabilityUnmounts.filter(entry => entry.name === 'terminal')).toHaveLength(0);

    await openWorkbenchCapability(wrapper, 'git');
    expect(wrapper.get('.git-tab-stub').attributes()).toMatchObject({
      'data-route-key': 'yeaft:agent-1:session-b',
      'data-session-id': 'session-b',
      'data-work-dir': '/workspace/b',
      'data-workspace-generation': workbenchWorkspaceGeneration(
        'yeaft:agent-1:session-b',
        '/workspace/b',
      ),
    });

    workbenchStore.activeSessionRoute = {
      runtimeProvider: 'yeaft', agentId: 'agent-1', sessionId: 'session-a',
    };
    workbenchStore.effectiveWorkDir = '/workspace/a';
    await Vue.nextTick();
    expect(wrapper.get('.terminal-tab-stub').attributes('data-route-key')).toBe('yeaft:agent-1:session-a');
    expect(capabilityMounts.filter(entry => entry.name === 'terminal')).toHaveLength(1);
    expect(capabilityUnmounts.filter(entry => entry.name === 'terminal')).toHaveLength(0);
    expect(wrapper.find('.git-tab-stub').exists()).toBe(false);
    wrapper.unmount();
  });

  it('rejects delayed responses from an older workspace generation on the same route', () => {
    const routeKey = 'yeaft:agent-1:session-a';
    const oldGeneration = workbenchWorkspaceGeneration(routeKey, '/workspace/a');
    const currentGeneration = workbenchWorkspaceGeneration(routeKey, '/workspace/b');
    for (const type of [
      'git_status_result',
      'directory_listing',
      'file_search_result',
      'file_tabs_restored',
    ]) {
      expect(isWorkbenchMessageForRoute({
        type,
        workbenchRouteKey: routeKey,
        workbenchWorkspaceGeneration: oldGeneration,
      }, routeKey, currentGeneration)).toBe(false);
      expect(isWorkbenchMessageForRoute({
        type,
        workbenchRouteKey: routeKey,
        workbenchWorkspaceGeneration: currentGeneration,
      }, routeKey, currentGeneration)).toBe(true);
    }
  });

  it('keeps Browser discoverable and distinguishes setup-required from unsupported', async () => {
    const unsupported = mountWorkbench();
    await unsupported.get('.workbench-add-btn').trigger('click');
    await unsupported.get('[data-workbench-capability="browser"]').trigger('click');
    expect(unsupported.get('.workbench-browser-view').text()).toContain('workbench.browserUnavailable');
    expect(unsupported.find('video').exists()).toBe(false);
    expect(unsupported.find('iframe').exists()).toBe(false);
    unsupported.unmount();

    workbenchStore.browserRuntimeServerEnabled = true;
    workbenchStore.browserRuntimeProtocolSupported = true;
    workbenchStore.browserRuntimeSetupProtocolSupported = true;
    workbenchStore.capabilities = ['terminal', 'file_editor', 'workbench_session_routes', 'browser_runtime_setup'];
    const setup = mountWorkbench();
    await setup.get('.workbench-add-btn').trigger('click');
    expect(setup.get('[data-workbench-capability="browser"] small').text())
      .toBe('workbench.enableRequired');
    await setup.get('[data-workbench-capability="browser"]').trigger('click');
    expect(setup.find('.workbench-browser-view').exists()).toBe(false);
    expect(setup.get('.browser-panel-stub').attributes('data-route-key'))
      .toBe('yeaft:agent-1:session-a');
    setup.unmount();
  });

  it('maps route-scoped open files into the Workbench tabs and delegates file selection or close', async () => {
    const wrapper = mountWorkbench();
    await openWorkbenchCapability(wrapper, 'files');
    const selectHandler = vi.fn();
    const closeHandler = vi.fn();
    window.addEventListener('workbench-select-file-item', selectHandler);
    window.addEventListener('workbench-close-file-item', closeHandler);

    const currentGeneration = workbenchWorkspaceGeneration(
      'yeaft:agent-1:session-a',
      '/workspace/a',
    );
    window.dispatchEvent(new CustomEvent('workbench-file-items-changed', { detail: {
      routeKey: 'yeaft:agent-1:session-a',
      workspaceGeneration: currentGeneration,
      activePath: 'README.md',
      files: [
        { path: 'README.md', name: 'README.md', isDirty: false },
        { path: 'src/main.js', name: 'main.js', isDirty: true },
      ],
    } }));
    await Vue.nextTick();
    expect(wrapper.findAll('.workbench-item-tab').map(tab => tab.text()))
      .toEqual(['README.md×', '●main.js×']);
    expect(wrapper.findAll('.workbench-item-tab')[0].classes()).toContain('active');

    await wrapper.findAll('.workbench-item-select')[1].trigger('click');
    expect(selectHandler).toHaveBeenCalledTimes(1);
    expect(selectHandler.mock.calls[0][0].detail).toEqual({
      routeKey: 'yeaft:agent-1:session-a',
      workspaceGeneration: currentGeneration,
      path: 'src/main.js',
    });
    await wrapper.findAll('.workbench-item-close')[1].trigger('click');
    expect(closeHandler).toHaveBeenCalledTimes(1);
    expect(closeHandler.mock.calls[0][0].detail).toEqual({
      routeKey: 'yeaft:agent-1:session-a',
      workspaceGeneration: currentGeneration,
      path: 'src/main.js',
    });

    window.dispatchEvent(new CustomEvent('workbench-file-items-changed', { detail: {
      routeKey: 'yeaft:agent-1:session-b',
      workspaceGeneration: workbenchWorkspaceGeneration('yeaft:agent-1:session-b', '/workspace/b'),
      activePath: 'ignored.md',
      files: [{ path: 'ignored.md', name: 'ignored.md', isDirty: false }],
    } }));
    await Vue.nextTick();
    expect(wrapper.findAll('.workbench-item-tab').map(tab => tab.text()))
      .toEqual(['README.md×', '●main.js×']);

    window.dispatchEvent(new CustomEvent('workbench-file-items-changed', { detail: {
      routeKey: 'yeaft:agent-1:session-a',
      workspaceGeneration: workbenchWorkspaceGeneration('yeaft:agent-1:session-a', '/workspace/old'),
      activePath: 'stale.md',
      files: [{ path: 'stale.md', name: 'stale.md', isDirty: false }],
    } }));
    await Vue.nextTick();
    expect(wrapper.findAll('.workbench-item-tab').map(tab => tab.text()))
      .toEqual(['README.md×', '●main.js×']);

    window.removeEventListener('workbench-select-file-item', selectHandler);
    window.removeEventListener('workbench-close-file-item', closeHandler);
    wrapper.unmount();
  });

  it('keeps the active tab visible and lists only hidden items in the overflow menu', async () => {
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      let width = 0;
      if (this.classList.contains('workbench-tab-rail')) width = 270;
      else if (this.classList.contains('workbench-item-tab')) width = 100;
      else if (this.classList.contains('workbench-add-wrap')) width = 32;
      else if (this.classList.contains('workbench-open-items-btn')) width = 32;
      if (!width) return originalGetBoundingClientRect.call(this);
      return {
        x: 0,
        y: 0,
        top: 0,
        right: width,
        bottom: 32,
        left: 0,
        width,
        height: 32,
        toJSON: () => ({}),
      };
    });
    const wrapper = mountWorkbench();
    await openWorkbenchCapability(wrapper, 'files');
    await openWorkbenchCapability(wrapper, 'terminal');
    await openWorkbenchCapability(wrapper, 'git');
    const currentGeneration = workbenchWorkspaceGeneration(
      'yeaft:agent-1:session-a',
      '/workspace/a',
    );
    window.dispatchEvent(new CustomEvent('workbench-file-items-changed', { detail: {
      routeKey: 'yeaft:agent-1:session-a',
      workspaceGeneration: currentGeneration,
      activePath: 'README.md',
      files: [
        { path: 'README.md', name: 'README.md', isDirty: false },
        { path: 'src/main.js', name: 'main.js', isDirty: true },
      ],
    } }));
    window.dispatchEvent(new Event('resize'));
    await Vue.nextTick();
    await Vue.nextTick();
    await Vue.nextTick();

    expect(wrapper.findAll('.workbench-item-tab').map(tab => tab.text()))
      .toEqual(['README.md×', 'workbench.git×']);
    const overflowTrigger = wrapper.get('.workbench-open-items-btn');
    await overflowTrigger.trigger('click');
    await Vue.nextTick();
    let hiddenItems = wrapper.findAll('.workbench-open-items-menu .ctx-menu-item');
    expect(hiddenItems.map(item => item.text()))
      .toEqual(['● main.jssrc/main.js', 'workbench.terminal']);
    expect(document.activeElement).toBe(hiddenItems[0].element);
    await hiddenItems[0].trigger('keydown', { key: 'Escape' });
    await Vue.nextTick();
    expect(document.activeElement).toBe(overflowTrigger.element);

    await overflowTrigger.trigger('keydown', { key: 'ArrowDown' });
    await Vue.nextTick();
    hiddenItems = wrapper.findAll('.workbench-open-items-menu .ctx-menu-item');
    expect(document.activeElement).toBe(hiddenItems[0].element);
    await hiddenItems[0].trigger('keydown', { key: 'ArrowUp' });
    expect(document.activeElement).toBe(hiddenItems[1].element);
    await hiddenItems[1].trigger('keydown', { key: 'Home' });
    expect(document.activeElement).toBe(hiddenItems[0].element);
    await hiddenItems[0].trigger('keydown', { key: 'End' });
    expect(document.activeElement).toBe(hiddenItems[1].element);
    await hiddenItems[1].trigger('keydown', { key: 'Escape' });
    await Vue.nextTick();
    expect(wrapper.find('.workbench-open-items-menu').exists()).toBe(false);
    expect(document.activeElement).toBe(overflowTrigger.element);

    await overflowTrigger.trigger('keydown', { key: 'ArrowDown' });
    await Vue.nextTick();
    hiddenItems = wrapper.findAll('.workbench-open-items-menu .ctx-menu-item');
    await hiddenItems[0].trigger('keydown', { key: 'Tab' });
    await Vue.nextTick();
    expect(wrapper.find('.workbench-open-items-menu').exists()).toBe(false);
    expect(document.activeElement).toBe(wrapper.get('.workbench-maximize-btn').element);

    overflowTrigger.element.focus();
    await overflowTrigger.trigger('keydown', { key: 'ArrowDown' });
    await Vue.nextTick();
    hiddenItems = wrapper.findAll('.workbench-open-items-menu .ctx-menu-item');
    await hiddenItems[0].trigger('keydown', { key: 'Tab', shiftKey: true });
    await Vue.nextTick();
    expect(wrapper.find('.workbench-open-items-menu').exists()).toBe(false);
    expect(document.activeElement).toBe(overflowTrigger.element);

    await overflowTrigger.trigger('keydown', { key: 'ArrowUp' });
    await Vue.nextTick();
    hiddenItems = wrapper.findAll('.workbench-open-items-menu .ctx-menu-item');
    expect(document.activeElement).toBe(hiddenItems[1].element);
    await hiddenItems[1].trigger('click');
    await Vue.nextTick();
    await Vue.nextTick();
    expect(wrapper.get('.terminal-tab-stub').isVisible()).toBe(true);
    expect(wrapper.findAll('.workbench-item-tab').map(tab => tab.text()))
      .toEqual(['README.md×', 'workbench.terminal×']);

    const terminalTab = wrapper.findAll('.workbench-item-tab')
      .find(tab => tab.text().includes('workbench.terminal'));
    await terminalTab.trigger('contextmenu', { clientX: 80, clientY: 40 });
    const actions = wrapper.findAll('.workbench-tab-context-menu .ctx-menu-item');
    expect(actions.map(action => action.text())).toEqual([
      'files.closeTabAction',
      'files.closeOtherTabs',
      'files.closeTabsToLeft',
      'files.closeTabsToRight',
      'files.closeAllTabs',
    ]);

    const closeFiles = vi.fn(event => event.detail.resolve(true));
    window.addEventListener('workbench-close-file-items', closeFiles);
    await actions[1].trigger('click');
    await Vue.nextTick();
    expect(closeFiles).toHaveBeenCalledTimes(1);
    expect(closeFiles.mock.calls[0][0].detail.paths).toEqual(['README.md', 'src/main.js']);
    expect(wrapper.findAll('.workbench-item-tab').map(tab => tab.text()))
      .toEqual(['workbench.terminal×']);
    expect(wrapper.find('.workbench-open-items-btn').exists()).toBe(false);

    window.removeEventListener('workbench-close-file-items', closeFiles);
    wrapper.unmount();
    rectSpy.mockRestore();
  });

  it('routes a message file-open event directly to Files and preserves it on reopen', async () => {
    const forwarded = [];
    const handleForwarded = event => forwarded.push(event.detail);
    window.addEventListener('workbench-open-file-in-active-view', handleForwarded);
    const wrapper = mountWorkbench();

    window.dispatchEvent(new CustomEvent('open-file-in-explorer', { detail: {
      filePath: 'README.md',
      workbenchRoute: workbenchStore.activeSessionRoute,
      workbenchRouteKey: 'yeaft:agent-1:session-a',
      workspaceGeneration: workbenchWorkspaceGeneration('yeaft:agent-1:session-a', '/workspace/a'),
    } }));
    await Vue.nextTick();
    expect(wrapper.get('.files-tab-stub').isVisible()).toBe(true);
    expect(wrapper.get('.files-tab-stub').attributes('data-route-key')).toBe('yeaft:agent-1:session-a');
    expect(forwarded).toEqual([expect.objectContaining({
      filePath: 'README.md',
      agentId: 'agent-1',
      conversationId: '_workbench:yeaft:agent-1:session-a',
      workDir: '/workspace/a',
      workbenchRouteKey: 'yeaft:agent-1:session-a',
      workspaceGeneration: workbenchWorkspaceGeneration('yeaft:agent-1:session-a', '/workspace/a'),
    })]);

    workbenchStore.workbenchExpanded = false;
    await Vue.nextTick();
    workbenchStore.workbenchExpanded = true;
    await Vue.nextTick();
    expect(wrapper.get('.files-tab-stub').isVisible()).toBe(true);
    window.removeEventListener('workbench-open-file-in-active-view', handleForwarded);
    wrapper.unmount();
  });

  it('drops a scheduled file-open when the active workspace drifts', async () => {
    const forwarded = [];
    const handleForwarded = event => forwarded.push(event.detail);
    window.addEventListener('workbench-open-file-in-active-view', handleForwarded);
    const wrapper = mountWorkbench();
    const routeA = { ...workbenchStore.activeSessionRoute };

    window.dispatchEvent(new CustomEvent('open-file-in-explorer', { detail: {
      filePath: 'README.md',
      workbenchRoute: routeA,
      workbenchRouteKey: 'yeaft:agent-1:session-a',
      workspaceGeneration: workbenchWorkspaceGeneration('yeaft:agent-1:session-a', '/workspace/a'),
    } }));
    workbenchStore.activeSessionRoute = {
      runtimeProvider: 'yeaft', agentId: 'agent-1', sessionId: 'session-b',
    };
    workbenchStore.effectiveWorkDir = '/workspace/b';
    await Vue.nextTick();

    expect(forwarded).toEqual([]);
    expect(wrapper.find('.files-tab-stub').exists()).toBe(false);
    expect(wrapper.get('.workbench-launcher').isVisible()).toBe(true);

    window.removeEventListener('workbench-open-file-in-active-view', handleForwarded);
    wrapper.unmount();
  });

  it('shows unavailable detail for unsupported legacy capabilities', async () => {
    workbenchStore.capabilities = ['terminal', 'file_editor'];
    workbenchStore.workbenchRouteProtocolSupported = false;
    const wrapper = mountWorkbench();

    await wrapper.get('.workbench-add-btn').trigger('click');
    await wrapper.get('[data-workbench-capability="git"]').trigger('click');
    expect(wrapper.get('.workbench-capability-empty').text()).toContain('workbench.capabilityUnavailable');
    expect(wrapper.find('.git-tab-stub').exists()).toBe(false);
    wrapper.unmount();
  });
});

describe('Workbench entry', () => {
  it('shows the Chat entry from the page gate instead of unrelated provider capabilities', () => {
    const toggleWorkbench = vi.fn();
    const headerStore = {
      currentConversation: 'conversation-1',
      conversations: [{
        id: 'conversation-1',
        provider: 'copilot',
        capabilities: { clear: true, mcp: true },
      }],
      agents: [],
      currentWorkDir: '/workspace',
      workbenchExpanded: false,
      compactStatus: null,
      clearStatus: null,
      contextUsage: null,
      currentMcpServers: [],
      mcpPanelOpen: false,
      runningSubagentCount: 0,
      expertSelections: [],
      getConversationTitle: () => 'Conversation',
      isRefreshingSession: () => false,
      getPaneRightPanel: () => null,
      toggleWorkbench,
    };
    globalThis.Pinia.useChatStore = () => headerStore;

    const visible = mount(ChatHeader, {
      props: { canUseWorkbench: true },
      global: { mocks: { $t: key => key }, provide: { t: key => key } },
    });
    expect(visible.find('[aria-label="chat.sidebar.workbench"]').exists()).toBe(true);
    visible.unmount();

    const hidden = mount(ChatHeader, {
      global: { mocks: { $t: key => key }, provide: { t: key => key } },
    });
    expect(hidden.find('[aria-label="chat.sidebar.workbench"]').exists()).toBe(false);
    hidden.unmount();
  });
});

describe('message file preview', () => {
  it('accepts local code and document references while leaving web links alone', () => {
    expect(resolveMessageFileReference('docs/design-doc.md#L119')).toEqual({ path: 'docs/design-doc.md', line: 119 });
    expect(resolveMessageFileReference('./src/main.js:42')).toEqual({ path: './src/main.js', line: 42 });
    expect(resolveMessageFileReference('C:\\repo\\src\\main.js:42')).toEqual({ path: 'C:\\repo\\src\\main.js', line: 42 });
    expect(resolveMessageFileReference('/workspace/readme.md')).toEqual({ path: '/workspace/readme.md', line: null });
    expect(resolveMessageFileReference('file:///workspace/spec.pdf')).toEqual({ path: '/workspace/spec.pdf', line: null });
    expect(resolveMessageFileReference('https://example.test/design-doc.md')).toBeNull();
    expect(resolveMessageFileReference('#section')).toBeNull();
    expect(resolveMessageFileReference('/api/files/readme.md')).toBeNull();
    expect(resolveMessageImageFileReference('/assistant.png', '/workspace')).toBeNull();
    expect(resolveMessageImageFileReference('/web/images/assistant.png', '/workspace')).toBeNull();
    expect(resolveMessageImageFileReference('/workspace/screens/result.png', '/workspace')).toEqual({
      path: '/workspace/screens/result.png', line: null,
    });
  });

  it('rejects Git refs and versions without blocking recognizable extensionless files', () => {
    expect(resolveMessageFileReference('origin/main')).toBeNull();
    expect(resolveMessageFileReference('feature/message-preview')).toBeNull();
    expect(resolveMessageFileReference('v1.0.403')).toBeNull();
    expect(resolveMessageFileReference('release/v1.0.403')).toBeNull();
    expect(resolveMessageFileReference('./v1.0.403')).toEqual({ path: './v1.0.403', line: null });
    expect(resolveMessageFileReference('/workspace/v1.0.403')).toEqual({ path: '/workspace/v1.0.403', line: null });
    expect(resolveMessageFileReference('file:///workspace/v1.0.403')).toEqual({ path: '/workspace/v1.0.403', line: null });
    expect(resolveMessageFileReference('artifact.7z')).toBeNull();
    expect(resolveMessageFileReference('./artifact.7z')).toBeNull();
    expect(resolveMessageFileReference('/workspace/archive.tar.gz')).toBeNull();
    expect(resolveMessageFileReference('README')).toEqual({ path: 'README', line: null });
    expect(resolveMessageFileReference('Dockerfile')).toEqual({ path: 'Dockerfile', line: null });
    expect(resolveMessageFileReference('docs/README')).toEqual({ path: 'docs/README', line: null });
    expect(resolveMessageFileReference('.gitignore')).toEqual({ path: '.gitignore', line: null });
  });

  it('holds local Markdown images until an authorized preview URL is available', () => {
    const source = '<p><img src="/workspace/screens/result.png" alt="result"> <img src="https://example.test/remote.png"></p>';
    expect(collectMessageImageReferences(source, '/workspace')).toEqual(['/workspace/screens/result.png']);
    expect(collectMessageFileReferences(source, '/workspace')).toEqual(['/workspace/screens/result.png']);

    const pending = decorateMessageFileReferences(source, new Map(), new Map(), '/workspace');
    expect(pending).not.toContain('src="/workspace/screens/result.png"');
    expect(pending).toContain('data-local-image-path="/workspace/screens/result.png"');
    expect(pending).toContain('src="https://example.test/remote.png"');

    const resolved = decorateMessageFileReferences(source, new Map(), new Map([
      ['/workspace/screens/result.png', '/api/preview/image-1?token=secret'],
    ]), '/workspace');
    expect(resolved).toContain('src="/api/preview/image-1?token=secret"');
    expect(resolved).toContain('data-local-image-path="/workspace/screens/result.png"');
  });

  it('collects and decorates Agent-confirmed file paths in ordinary response text', () => {
    const source = [
      '<p>Changed web/components/AssistantTurn.js:410 and missing/not-created.js.</p>',
      '<p><strong>Also:</strong> docs/design-doc.md#L119, but not origin/main or v1.0.486.</p>',
      '<pre><code>web/components/FilesTab.js:17</code></pre>',
    ].join('');

    expect(collectMessageFileReferences(source)).toEqual([
      'web/components/AssistantTurn.js',
      'missing/not-created.js',
      'docs/design-doc.md',
    ]);
    const html = decorateMessageFileReferences(source, new Map([
      ['web/components/AssistantTurn.js', 'web/components/AssistantTurn.js'],
      ['docs/design-doc.md', 'docs/design-doc.md'],
    ]));

    expect(html).toContain('href="web/components/AssistantTurn.js:410" data-resolved-file-path="web/components/AssistantTurn.js"');
    expect(html).toContain('href="docs/design-doc.md#L119" data-resolved-file-path="docs/design-doc.md"');
    expect(html).toContain('missing/not-created.js');
    expect(html).not.toContain('href="missing/not-created.js"');
    expect(html).not.toContain('href="origin/main"');
    expect(html).not.toContain('href="v1.0.486"');
    expect(html).toContain('<pre><code>web/components/FilesTab.js:17</code></pre>');
  });

  it('decorates file links and standalone inline-code references without touching code blocks', () => {
    const source = [
      '<a href="docs/design-doc.md#L119">design doc</a>',
      '<a class="existing" href="docs/notes.md">notes</a>',
      '<a href="https://example.test">web</a>',
      '<code>web/components/WorkbenchPanel.js:1</code>',
      '<code>origin/main</code>',
      '<code>v1.0.403</code>',
      '<code>artifact.7z</code>',
      '<pre><code>web/components/FilesTab.js:17</code></pre>',
    ].join(' ');
    expect(collectMessageFileReferences(source)).toEqual([
      'docs/design-doc.md', 'docs/notes.md', 'web/components/WorkbenchPanel.js',
    ]);
    const html = decorateMessageFileReferences(source, new Map([
      ['docs/design-doc.md', 'docs/design-doc.md'],
      ['web/components/WorkbenchPanel.js', 'web/components/WorkbenchPanel.js'],
    ]));

    expect(html).toContain('data-resolved-file-path="docs/design-doc.md" class="message-file-reference"');
    expect(html).toContain('notes');
    expect(html).not.toContain('href="docs/notes.md"');
    expect(html).toContain('data-resolved-file-path="web/components/WorkbenchPanel.js" class="message-file-reference"');
    expect(html).toContain('<code>origin/main</code>');
    expect(html).toContain('<code>v1.0.403</code>');
    expect(html).not.toContain('href="origin/main"');
    expect(html).not.toContain('href="v1.0.403"');
    expect(html).toContain('<code>artifact.7z</code>');
    expect(html).not.toContain('href="artifact.7z"');
    expect(html).toContain('<a href="https://example.test">web</a>');
    expect(html).toContain('<pre><code>web/components/FilesTab.js:17</code></pre>');
  });

  it('opens a local Markdown link in the message file panel without intercepting external links', async () => {
    const openFileInExplorer = vi.fn();
    const resolveMessageFileReferences = vi.fn(() => 'file-refs-request');
    globalThis.Vue = Vue;
    globalThis.Pinia = {
      defineStore: () => () => ({}),
      useChatStore: () => ({
        answerUserQuestion: vi.fn(),
        cancelVpTurn: vi.fn(),
        openFileInExplorer,
        resolveMessageFileReferences,
      }),
    };
    globalThis.marked = {
      setOptions: vi.fn(),
      parse: vi.fn(() => '<p><a href="docs/design-doc.md#L119">design doc</a> <a href="https://example.test">web</a></p>'),
    };
    globalThis.hljs = undefined;
    const { default: AssistantTurn } = await import('../../web/components/AssistantTurn.js');
    const wrapper = mount(AssistantTurn, {
      props: {
        turn: {
          id: 'turn-file-preview',
          textContent: 'links',
          textSegments: [{ key: 'result', content: 'links', kind: 'result' }],
          toolMsgs: [], imageMsgs: [], todoMsg: null, askMsg: null, isStreaming: false,
        },
      },
      global: {
        mocks: { $t: key => key },
        provide: { t: key => key },
        stubs: { ToolLine: true, AskCard: true, VpSpeakerHeader: true },
      },
    });

    expect(resolveMessageFileReferences).toHaveBeenCalledWith(['docs/design-doc.md']);
    expect(wrapper.find('a[href="docs/design-doc.md#L119"]').exists()).toBe(false);
    window.dispatchEvent(new CustomEvent('workbench-message', { detail: {
      type: 'file_references_resolved',
      requestId: 'file-refs-request',
      references: [{ requestedPath: 'docs/design-doc.md', resolvedPath: 'src/docs/design-doc.md' }],
    } }));
    await Vue.nextTick();
    await wrapper.get('a[href="docs/design-doc.md#L119"]').trigger('click');
    expect(openFileInExplorer).toHaveBeenCalledWith('src/docs/design-doc.md', { hideTree: true, line: 119 });

    await wrapper.get('a[href="https://example.test"]').trigger('click');
    expect(openFileInExplorer).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('maps a local response image through resolution and a route-scoped preview read', async () => {
    const resolveMessageFileReferences = vi.fn(() => 'resolve-image');
    const requestMessageImagePreview = vi.fn(() => 'read-image');
    const fileReferenceStore = Vue.reactive({
      effectiveWorkDir: '/workspace',
      fileReferenceResolutionContextKey: 'connected:agent-1:session-a:/workspace',
      answerUserQuestion: vi.fn(), cancelVpTurn: vi.fn(), openFileInExplorer: vi.fn(),
      resolveMessageFileReferences, requestMessageImagePreview,
    });
    globalThis.Vue = Vue;
    globalThis.Pinia = {
      defineStore: () => () => ({}),
      useChatStore: () => fileReferenceStore,
    };
    globalThis.marked = {
      setOptions: vi.fn(),
      parse: vi.fn(() => '<p><img src="/workspace/screens/result.png" alt="result"></p>'),
    };
    globalThis.hljs = undefined;
    const { default: AssistantTurn } = await import('../../web/components/AssistantTurn.js');
    const wrapper = mount(AssistantTurn, {
      props: {
        turn: {
          id: 'turn-local-image', textContent: 'image',
          textSegments: [{ key: 'result', content: 'image', kind: 'result' }],
          toolMsgs: [], imageMsgs: [], todoMsg: null, askMsg: null, isStreaming: false,
        },
      },
      global: {
        mocks: { $t: key => key }, provide: { t: key => key },
        stubs: { ToolLine: true, AskCard: true, VpSpeakerHeader: true },
      },
    });

    expect(resolveMessageFileReferences).toHaveBeenCalledWith(['/workspace/screens/result.png']);
    expect(wrapper.find('.turn-text img').exists()).toBe(false);
    window.dispatchEvent(new CustomEvent('workbench-message', { detail: {
      type: 'file_references_resolved', requestId: 'resolve-image',
      references: [{ requestedPath: '/workspace/screens/result.png', resolvedPath: 'screens/result.png' }],
    } }));
    await Vue.nextTick();
    expect(requestMessageImagePreview).toHaveBeenCalledWith('screens/result.png');
    expect(wrapper.find('.turn-text img').exists()).toBe(false);

    window.dispatchEvent(new CustomEvent('workbench-message', { detail: {
      type: 'file_content', requestId: 'read-image', binary: true,
      previewUrl: '/api/preview/image-1?token=secret',
    } }));
    await Vue.nextTick();
    expect(wrapper.get('.turn-text img').attributes('src')).toBe('/api/preview/image-1?token=secret');
    wrapper.unmount();
  });

  it('opens a linked Markdown image without navigating its parent anchor', async () => {
    globalThis.Vue = Vue;
    globalThis.Pinia = {
      defineStore: () => () => ({}),
      useChatStore: () => ({
        effectiveWorkDir: '/workspace', fileReferenceResolutionContextKey: '',
        answerUserQuestion: vi.fn(), cancelVpTurn: vi.fn(),
        resolveMessageFileReferences: vi.fn(() => null), openFileInExplorer: vi.fn(),
      }),
    };
    globalThis.marked = {
      setOptions: vi.fn(),
      parse: vi.fn(() => '<p><a href="https://example.test"><img src="https://cdn.test/image.png" alt="linked"></a></p>'),
    };
    globalThis.hljs = undefined;
    const { default: AssistantTurn } = await import('../../web/components/AssistantTurn.js');
    const wrapper = mount(AssistantTurn, {
      props: {
        turn: {
          id: 'turn-linked-image', textContent: 'image',
          textSegments: [{ key: 'result', content: 'image', kind: 'result' }],
          toolMsgs: [], imageMsgs: [], todoMsg: null, askMsg: null, isStreaming: false,
        },
      },
      global: {
        mocks: { $t: key => key }, provide: { t: key => key },
        stubs: { ToolLine: true, AskCard: true, VpSpeakerHeader: true },
      },
    });
    const bubbled = vi.fn();
    wrapper.element.addEventListener('click', bubbled);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    wrapper.get('.turn-text img').element.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(bubbled).not.toHaveBeenCalled();
    expect(document.body.querySelector('.image-preview-overlay')).not.toBeNull();
    document.body.querySelector('.image-preview-close').click();
    document.body.querySelector('.image-preview-overlay')?.dispatchEvent(new Event('transitionend'));
    wrapper.unmount();
  });

  it('retries file reference resolution when the active route becomes ready', async () => {
    const resolveMessageFileReferences = vi.fn()
      .mockReturnValueOnce(null)
      .mockReturnValueOnce('file-refs-ready');
    const fileReferenceStore = Vue.reactive({
      fileReferenceResolutionContextKey: '',
      answerUserQuestion: vi.fn(),
      cancelVpTurn: vi.fn(),
      openFileInExplorer: vi.fn(),
      resolveMessageFileReferences,
    });
    globalThis.Vue = Vue;
    globalThis.Pinia = {
      defineStore: () => () => ({}),
      useChatStore: () => fileReferenceStore,
    };
    globalThis.marked = {
      setOptions: vi.fn(),
      parse: vi.fn(() => '<p><code>Q:\\M365\\Sydney\\docs\\design-doc.md</code></p>'),
    };
    globalThis.hljs = undefined;
    const { default: AssistantTurn } = await import('../../web/components/AssistantTurn.js');
    const wrapper = mount(AssistantTurn, {
      props: {
        turn: {
          id: 'turn-file-preview-late-route',
          textContent: 'Q:\\M365\\Sydney\\docs\\design-doc.md',
          textSegments: [{
            key: 'result',
            content: 'Q:\\M365\\Sydney\\docs\\design-doc.md',
            kind: 'result',
          }],
          toolMsgs: [], imageMsgs: [], todoMsg: null, askMsg: null, isStreaming: false,
        },
      },
      global: {
        mocks: { $t: key => key },
        provide: { t: key => key },
        stubs: { ToolLine: true, AskCard: true, VpSpeakerHeader: true },
      },
    });

    expect(resolveMessageFileReferences).toHaveBeenCalledTimes(1);
    expect(resolveMessageFileReferences).toHaveBeenLastCalledWith(['Q:\\M365\\Sydney\\docs\\design-doc.md']);

    fileReferenceStore.fileReferenceResolutionContextKey = 'connected:agent-1:session-a:/workspace';
    await Vue.nextTick();

    expect(resolveMessageFileReferences).toHaveBeenCalledTimes(2);
    expect(resolveMessageFileReferences).toHaveBeenLastCalledWith(['Q:\\M365\\Sydney\\docs\\design-doc.md']);
    wrapper.unmount();
  });

  it('revalidates file references when completed response content changes', async () => {
    const resolveMessageFileReferences = vi.fn()
      .mockReturnValueOnce('file-refs-old')
      .mockReturnValueOnce('file-refs-new');
    globalThis.Vue = Vue;
    globalThis.Pinia = {
      defineStore: () => () => ({}),
      useChatStore: () => ({
        answerUserQuestion: vi.fn(),
        cancelVpTurn: vi.fn(),
        openFileInExplorer: vi.fn(),
        resolveMessageFileReferences,
      }),
    };
    globalThis.marked = {
      setOptions: vi.fn(),
      parse: vi.fn(value => `<p>${value}</p>`),
    };
    globalThis.hljs = undefined;
    const { default: AssistantTurn } = await import('../../web/components/AssistantTurn.js');
    const wrapper = mount(AssistantTurn, {
      props: {
        turn: {
          id: 'turn-file-preview-update',
          textContent: 'old/file.js',
          textSegments: [{ key: 'result', content: 'old/file.js', kind: 'result' }],
          toolMsgs: [], imageMsgs: [], todoMsg: null, askMsg: null, isStreaming: false,
        },
      },
      global: {
        mocks: { $t: key => key },
        provide: { t: key => key },
        stubs: { ToolLine: true, AskCard: true, VpSpeakerHeader: true },
      },
    });

    expect(resolveMessageFileReferences).toHaveBeenLastCalledWith(['old/file.js']);
    window.dispatchEvent(new CustomEvent('workbench-message', { detail: {
      type: 'file_references_resolved',
      requestId: 'file-refs-old',
      references: [{ requestedPath: 'old/file.js', resolvedPath: 'old/file.js' }],
    } }));
    await Vue.nextTick();
    expect(wrapper.find('a[href="old/file.js"]').exists()).toBe(true);

    await wrapper.setProps({
      turn: {
        ...wrapper.props('turn'),
        textContent: 'new/file.js',
        textSegments: [{ key: 'result', content: 'new/file.js', kind: 'result' }],
      },
    });
    await Vue.nextTick();

    expect(resolveMessageFileReferences).toHaveBeenLastCalledWith(['new/file.js']);
    expect(wrapper.find('a[href="old/file.js"]').exists()).toBe(false);
    expect(wrapper.find('a[href="new/file.js"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('wires the right panel to the complete Files experience with a visible compact tree by default', () => {
    const filesTab = readWeb('components/FilesTab.js');
    const fileTree = readWeb('components/files/fileTree.js');
    const workbench = readWeb('components/WorkbenchPanel.js');
    const browserPanel = readWeb('components/BrowserPanel.js');
    const capabilityHost = readWeb('components/WorkbenchCapabilityHost.js');
    const chatPage = readWeb('components/ChatPage.js');
    const chatHeader = readWeb('components/ChatHeader.js');
    const yeaftPage = readWeb('components/YeaftPage.js');
    const yeaftActions = readWeb('components/YeaftSessionActions.js');
    const yeaftSidebar = readWeb('components/YeaftSidebar.js');

    expect(filesTab).toContain('treeInitiallyVisible');
    expect(filesTab).toContain("'tree-collapsed': !treeVisible");
    expect(filesTab.match(/class="vscode-action-btn file-tree-collapse-btn"/g)).toHaveLength(2);
    expect(filesTab.match(/d="M8\.59 16\.59 13\.17 12 8\.59 7\.41 10 6l6 6-6 6z"/g)).toHaveLength(2);
    expect(filesTab).not.toContain('d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z"');
    expect(filesTab).toContain('class="file-tree-collapsed-rail"');
    expect(filesTab).not.toContain('class="file-tree-toggle"');
    const filesCss = readWeb('styles/files.css');
    const workbenchCss = readWeb('styles/workbench.css');
    const mobileCss = filesCss.slice(filesCss.indexOf('@media (max-width: 768px)'));
    expect(mobileCss).toMatch(/\.file-tree-collapsed-rail\s*\{[^}]*display:\s*none;/s);
    expect(mobileCss).toMatch(/\.file-two-col\.tree-collapsed \.file-col-tree\s*\{[^}]*display:\s*flex;/s);
    const wsHandler = readWeb('components/files/wsHandler.js');
    expect(wsHandler).toContain('pendingRevealLines.set(nPath, line)');
    expect(wsHandler).toContain('normalizePath(msg.requestedFilePath || msg.filePath)');
    expect(readWeb('../agent/workbench/file-ops.js')).toContain('requestedFilePath: filePath');
    expect(filesCss).toMatch(/\.file-tree-collapsed-rail\s*\{[^}]*order:\s*4;[^}]*border-left:/s);
    expect(filesCss).toMatch(/\.file-col-tree\s*\{[^}]*order:\s*3;/s);
    expect(filesCss).not.toMatch(/\.file-col-tree\s*\{[^}]*border:\s*1px solid var\(--border-color\);/s);
    expect(filesCss).not.toMatch(/\.file-col-content,\s*\.file-col-placeholder\s*\{[^}]*border:/s);
    expect(filesCss).toMatch(/\.file-col-content\s*\{[^}]*order:\s*1;/s);
    expect(filesCss).toMatch(/\.file-tree-splitter\s*\{[^}]*order:\s*2;[^}]*border-right:\s*1px solid var\(--border-color\);/s);
    expect(filesTab).toContain('class="file-content-header"');
    expect(filesTab).toContain('class="file-content-folder"');
    expect(filesTab).toContain('class="file-content-actions"');
    expect(filesTab).toContain('v-if="activeFile?.loading" class="file-load-state"');
    expect(filesTab).toContain('v-else-if="activeFile?.loadError" class="file-load-state file-load-error"');
    expect(filesTab).not.toContain('{{ debugStatus }}');
    expect(filesTab).not.toContain('class="file-tabs-bar"');
    expect(filesTab).not.toContain('@click="collapseAll"');
    expect(workbench).toContain('class="workbench-tabs"');
    expect(workbench).toContain('class="workbench-item-tab"');
    expect(workbench).not.toContain('workbench-header-title');
    expect(workbenchCss).not.toContain('.workbench-files-header');
    expect(workbenchCss).toMatch(/\.workbench-tab-rail\s*\{[^}]*flex:\s*1;[^}]*overflow:\s*hidden;/s);
    expect(workbenchCss).toMatch(/\.workbench-tabs\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;/s);
    expect(workbenchCss).toMatch(/\.workbench-add-wrap\s*\{[^}]*align-self:\s*center;[^}]*flex:\s*0 0 32px;/s);
    expect(workbenchCss).not.toMatch(/\.workbench-add-wrap\s*\{[^}]*position:\s*sticky;/s);
    expect(workbenchCss).toMatch(/\.workbench-add-menu\s*\{[^}]*position:\s*fixed;[^}]*left:\s*0;[^}]*width:\s*min\(190px, calc\(100vw - 16px\)\);/s);
    expect(workbenchCss).toMatch(/@media \(max-width: 768px\)[\s\S]*\.workbench-add-menu\s*\{[^}]*right:\s*auto;/);
    expect(workbench).toContain('window.innerWidth - menuWidth - margin');
    expect(workbench).toContain('menu.style.left = `${viewportLeft}px`');
    expect(workbench).toContain('v-for="item in visibleWorkbenchItems"');
    expect(workbench).toContain('v-for="item in hiddenWorkbenchItems"');
    expect(workbench).toContain('const updateTabOverflow = () =>');
    expect(workbench).not.toContain('scrollIntoView?.');
    expect(workbench).toContain("new CustomEvent('workbench-panel-resize'");
    expect(filesTab).toContain('startWidth - (clientX - startX)');
    expect(filesCss).toMatch(/\.file-two-col\s*\{[^}]*flex:\s*1;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s);
    expect(filesCss).toMatch(/\.file-tree-content\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*scroll;[^}]*scrollbar-gutter:\s*stable;[^}]*scrollbar-color:\s*var\(--border-color\) transparent;/s);
    expect(filesCss).toMatch(/\.file-tree-content::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*var\(--border-color\);/s);
    expect(filesCss).toMatch(/\.file-col-content\s*\{[^}]*overflow:\s*hidden;[^}]*min-height:\s*0;/s);
    expect(filesCss).toMatch(/\.file-editor-container \.CodeMirror-scroll\s*\{[^}]*overflow:\s*scroll !important;[^}]*scrollbar-gutter:\s*stable;/s);
    expect(workbench).toContain('<WorkbenchCapabilityHost');
    expect(workbench).toMatch(/<WorkbenchCapabilityHost\s+v-if="activeRouteKey"\s+v-show="activeToolCapability"/);
    expect(capabilityHost).toContain("activeCapability ? 'capability-' + activeCapability : ''");
    expect(workbenchCss).toMatch(/\.workbench-capability-host\s*\{[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s);
    const terminalTab = readWeb('components/TerminalTab.js');
    expect(terminalTab).toContain('ref="terminalRoot"');
    expect(terminalTab).toContain("window.addEventListener('workbench-panel-resize', handleResize)");
    expect(terminalTab).toContain('terminalResizeObserver = new ResizeObserver(handleResize)');
    expect(terminalTab).not.toContain('<span>Split');
    expect(terminalTab).not.toContain('<span>Close</span>');
    expect(browserPanel).toContain("['installing', 'probing'].includes(status.state)");
    expect(browserPanel).toContain('<template v-if="setupError">');
    expect(browserPanel).toContain('class="browser-install-percent">{{ progressPercent }}%</strong>');
    expect(browserPanel).toContain("code === 'browser_ice_servers_missing'");
    expect(browserPanel).toContain("t('workbench.browserIceConnectionFailed')");
    expect(capabilityHost).toContain("files: 'FilesTab'");
    expect(capabilityHost).toContain('v-for="capability in mountedCapabilities"');
    expect(capabilityHost).toContain('v-show="activeCapability === capability.id"');
    expect(capabilityHost).not.toContain('tree-initially-visible');
    expect(filesTab).toContain("paddingLeft: (6 + entry.depth * 10) + 'px'");
    expect(filesTab).toContain("class=\"markdown-body md-file-preview\" :style=\"{ fontSize: fontSize + 'px' }\"");
    expect(filesTab).not.toContain('@click="toggleRootExpand"');
    expect(filesTab).not.toContain('rootExpanded: tree.rootExpanded');
    expect(fileTree).not.toContain('rootExpanded');
    expect(fileTree).not.toContain('toggleRootExpand');
    expect(workbench).toContain('...(saved?.openCapabilities || [])');
    expect(workbench).toContain('activeCapability: activeCapability.value');
    expect(workbench).toContain('openCapabilities: [...openCapabilities]');
    expect(workbench).toContain('class="workbench-header-action workbench-maximize-btn"');
    expect(workbench).toContain(':aria-label="store.workbenchMaximized ? $t(\'workbench.restore\') : $t(\'workbench.maximize\')"');
    expect(workbench).toContain('d="M7 14H5v5h5v-2H7v-3z');
    expect(workbench).toContain('d="M5 16h3v3h2v-5H5v2z');
    expect(readWeb('stores/chat.js')).toContain('else Vue.nextTick(dispatchOpen);');
    expect(chatPage.indexOf('<WorkbenchPanel')).toBeGreaterThan(chatPage.indexOf('<div class="chat-body"'));
    expect(chatHeader).toContain("$t('chat.sidebar.workbench')");
    expect(chatHeader).toContain('canUseWorkbench: { type: Boolean, default: false }');
    expect(chatHeader).not.toContain("capOn('file_editor')");
    expect(chatPage).toContain('<ChatHeader :can-use-workbench="canUseWorkbench"');
    expect(yeaftActions).toContain("@click=\"$emit('toggle-workbench')\"");
    expect(yeaftPage.indexOf('<WorkbenchPanel')).toBeGreaterThan(yeaftPage.indexOf('<div class="yeaft-main"'));
    const yeaftCss = readWeb('styles/yeaft.css');
    expect(yeaftCss).toMatch(/\.yeaft-main\.workbench-maximized\s*\{[^}]*display:\s*none;/s);
    expect(yeaftCss).toMatch(/\.yeaft-main\s*\{[^}]*min-height:\s*0;/s);
    expect(workbenchCss).toMatch(/\.workbench-panel\s*\{[^}]*min-height:\s*0;/s);
    expect(workbenchCss).toMatch(/\.workbench-content\s*\{[^}]*flex:\s*1;[^}]*min-height:\s*0;/s);
    expect(yeaftCss).not.toContain('.yeaft-main.workbench-maximized > .yeaft-main-center');
    expect(yeaftSidebar).not.toContain('@click="onToggleWorkbench"');
  });
});
