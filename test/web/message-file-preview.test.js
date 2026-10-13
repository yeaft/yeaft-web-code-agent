// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workbenchWorkspaceGeneration } from '../../web/utils/workbench-route.js';
import * as Vue from 'vue';

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
  hasAgentCapability(agentId, capability) {
    return agentId === this.currentAgent && this.capabilities.includes(capability);
  },
  openWorkbench: vi.fn(),
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
    workbenchStore.openWorkbench.mockClear();
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
});

describe('message file preview', () => {
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

  it('resolves streaming references in bounded batches and rejects stale or unrelated results', async () => {
    vi.useFakeTimers();
    let sequence = 0;
    const fileReferenceStore = Vue.reactive({
      fileReferenceResolutionContextKey: 'agent-a:session-a:/workspace',
      answerUserQuestion: vi.fn(), cancelVpTurn: vi.fn(), openFileInExplorer: vi.fn(),
      resolveMessageFileReferences: vi.fn(() => `refs-${++sequence}`),
    });
    globalThis.Pinia = { defineStore: () => () => ({}), useChatStore: () => fileReferenceStore };
    globalThis.marked = { setOptions: vi.fn(), parse: vi.fn(value => `<p>${value}</p>`) };
    globalThis.hljs = undefined;
    const { default: AssistantTurn } = await import('../../web/components/AssistantTurn.js');
    const wrapper = mount(AssistantTurn, {
      props: { turn: {
        id: 'streaming-links', textContent: '', textSegments: [],
        toolMsgs: [], imageMsgs: [], isStreaming: true,
      } },
      global: {
        mocks: { $t: key => key }, provide: { t: key => key },
        stubs: { ToolLine: true, AskCard: true, VpSpeakerHeader: true },
      },
    });
    const update = async (content, isStreaming = true) => wrapper.setProps({ turn: {
      ...wrapper.props('turn'), textContent: content,
      textSegments: [{ key: 'result', content, kind: 'result' }], isStreaming,
    } });
    const respond = (requestId, references) => window.dispatchEvent(new CustomEvent('workbench-message', {
      detail: { type: 'file_references_resolved', requestId, references },
    }));
    try {
      const paths = Array.from({ length: 40 }, (_, i) => `src/file-${i}.js`);
      await update(paths.join(' '));
      expect(fileReferenceStore.resolveMessageFileReferences).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(500);
      expect(fileReferenceStore.resolveMessageFileReferences.mock.calls.map(([batch]) => batch.length)).toEqual([32, 8]);
      // Out-of-order batches remain independently correlated. An entry outside
      // the requested batch must never become clickable.
      respond('refs-2', [
        { requestedPath: paths[39], resolvedPath: paths[39] },
        { requestedPath: paths[0], resolvedPath: 'unrelated.js' },
      ]);
      respond('refs-1', [{ requestedPath: paths[0], resolvedPath: paths[0] }]);
      await Vue.nextTick();
      expect(wrapper.findAll('a.message-file-reference')).toHaveLength(2);
      await wrapper.get(`a[href="${paths[39]}"]`).trigger('click');
      expect(fileReferenceStore.openFileInExplorer).toHaveBeenCalledWith(paths[39], { hideTree: true, line: null });

      await update(`${paths.join(' ')} more text`);
      await vi.advanceTimersByTimeAsync(500);
      expect(fileReferenceStore.resolveMessageFileReferences).toHaveBeenCalledTimes(2);
      await update(Array.from({ length: 140 }, (_, i) => `src/file-${i}.js`).join(' '));
      await vi.advanceTimersByTimeAsync(500);
      expect(fileReferenceStore.resolveMessageFileReferences.mock.calls.map(([batch]) => batch.length)).toEqual([32, 8, 32, 32, 24]);

      fileReferenceStore.fileReferenceResolutionContextKey = 'agent-b:session-b:/workspace';
      await Vue.nextTick();
      expect(wrapper.findAll('a.message-file-reference')).toHaveLength(0);
      respond('refs-3', [{ requestedPath: paths[1], resolvedPath: 'stale.js' }]);
      await Vue.nextTick();
      expect(wrapper.findAll('a.message-file-reference')).toHaveLength(0);
      // Completion retries paths that did not yet exist during generation.
      await update('src/newly-created.js', false);
      const lastRequestId = `refs-${sequence}`;
      expect(fileReferenceStore.resolveMessageFileReferences).toHaveBeenLastCalledWith(['src/newly-created.js']);
      respond(lastRequestId, [{ requestedPath: 'src/newly-created.js', resolvedPath: 'src/newly-created.js' }]);
      await Vue.nextTick();
      expect(wrapper.findAll('a.message-file-reference')).toHaveLength(1);
    } finally {
      wrapper.unmount();
      vi.useRealTimers();
    }
  });
});
