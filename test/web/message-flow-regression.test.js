// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import {
  addMessageToConversation,
  appendToAssistantMessageForConversation,
  finishStreamingForConversation,
  maxDbMessageId,
} from '../../web/stores/helpers/messages.js';
import { YEAFT_HISTORY_CACHE_LIMITS } from '../../web/stores/helpers/yeaft-history-cache.js';
import {
  calculateFloatingMenuPosition,
  calculateFloatingSubmenuPosition,
  default as UnifiedSessionList,
  reorderProjectRows,
  reorderSessionCatalogRows,
} from '../../web/components/UnifiedSessionList.js';
import { openImagePreview } from '../../web/utils/imagePreview.js';
import SidebarWorkCenter from '../../web/components/SidebarWorkCenter.js';
import enMessages from '../../web/i18n/en.js';
import zhCNMessages from '../../web/i18n/zh-CN.js';
import { yeaftHistoryIdentityKey } from '../../web/stores/helpers/yeaft-history-identity.js';
import { yeaftSessionIdentityKey } from '../../web/stores/helpers/yeaft-session-identity.js';
import { migrateYeaftConversationState } from '../../web/stores/helpers/yeaft-conversation-state.js';
import {
  pauseYeaftWatchdog,
  resumeYeaftWatchdog,
  startYeaftWatchdog,
  stopProcessingWatchdog,
} from '../../web/stores/helpers/watchdog.js';
import { resolveTimelineSession } from '../../web/stores/helpers/vp-timeline.js';
import { buildYeaftSidebarSessionList } from '../../web/stores/helpers/yeaft-sidebar-sessions.js';
import {
  bindWorkCenterBrowserOwner,
  clearWorkCenterBrowserOwner,
  currentWorkCenterBrowserOwner,
  readWorkCenterBrowserState,
  WORK_CENTER_BROWSER_STORAGE_KEYS,
  writeWorkCenterDrafts,
} from '../../web/stores/helpers/work-center-browser-state.js';
import {
  beginCatalogMutation,
  beginChatHistoryRequest,
  cancelChatHistoryRequest,
  catalogKeyForRoute,
  chatCatalogKey,
  chatRouteRef,
  finishCatalogMutation,
  normalizeChatRuntimeProvider,
  yeaftCatalogKey,
  yeaftRouteRef,
} from '../../web/stores/helpers/session-catalog.js';

const SIDEBAR_SECTION_SELECTOR = /\.(?:sidebar-section|projects-section|recents-section)(?![-\w])/;
const CSS_ZERO = /^0(?:\.0+)?(?:[a-z%]+)?$/i;

function translatePluginCenterMessage(key, values = {}) {
  const template = enMessages[key] || key;
  return Object.entries(values).reduce((text, [name, value]) => (
    text.replaceAll(`{${name}}`, String(value))
  ), template);
}

function sidebarSectionTopValues(css, property) {
  const declarationPattern = new RegExp(`(?:^|;)\\s*(${property}(?:-top)?)\\s*:\\s*([^;]+)`, 'g');
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selector]) => SIDEBAR_SECTION_SELECTOR.test(selector))
    .flatMap(([, , declarations]) => [...declarations.matchAll(declarationPattern)])
    .map(([, declaration, value]) => declaration.endsWith('-top')
      ? value.trim()
      : value.trim().split(/\s+/)[0]);
}

const storeFactories = new Map();
function defineStore(id, options) {
  return () => {
    if (storeFactories.has(id)) return storeFactories.get(id);
    const instance = Vue.reactive({ ...(typeof options.state === 'function' ? options.state() : {}) });
    for (const [name, getter] of Object.entries(options.getters || {})) {
      Object.defineProperty(instance, name, {
        enumerable: true,
        get() { return getter.call(instance, instance); },
      });
    }
    for (const [name, action] of Object.entries(options.actions || {})) {
      instance[name] = action.bind(instance);
    }
    storeFactories.set(id, instance);
    return instance;
  };
}
const runtimeSessionsStore = Vue.reactive({
  sessionList: [],
  activeSessionId: null,
  activeAgentId: null,
  activeSessionKey: null,
  sessions: {},
  sessionById(sessionId, agentId = null) {
    return this.sessionList.find(row => row.id === sessionId && (!agentId || row.agentId === agentId)) || null;
  },
  setActive(sessionId, agentId = null) {
    this.activeSessionId = sessionId;
    this.activeAgentId = agentId;
    this.activeSessionKey = agentId && sessionId ? `${agentId}\u001f${sessionId}` : sessionId;
    if (this.activeSessionKey && !this.sessions[this.activeSessionKey]) {
      this.sessions[this.activeSessionKey] = { id: sessionId, agentId };
    }
  },
});
globalThis.Pinia = {
  ...(globalThis.Pinia || {}),
  defineStore,
  useSessionsStore: () => runtimeSessionsStore,
};
const { useChatStore } = await import('../../web/stores/chat.js');
const { answerUserQuestion, resumeConversation } = await import('../../web/stores/helpers/conversation.js');

describe('CLI resume identity', () => {
  it.each(['claude-code', 'copilot'])('keeps other Agent/provider rows on a %s resume response', provider => {
    const store = {
      agents: [{ id: 'agent-a' }, { id: 'agent-b' }],
      conversations: [
        { id: 'other-agent', agentId: 'agent-b', provider, claudeSessionId: 'cli-id' },
        { id: 'other-provider', agentId: 'agent-a', provider: provider === 'copilot' ? 'claude-code' : 'copilot', claudeSessionId: 'cli-id' },
        { id: 'stale', agentId: 'agent-a', provider: provider === 'claude-code' ? undefined : provider, claudeSessionId: 'cli-id' },
      ],
      panels: [], messagesMap: {}, chatSessionState: {},
      sendWsMessage: vi.fn(), addMessage: vi.fn(), saveOpenSessions: vi.fn(),
    };
    handleConversationResumed(store, {
      conversationId: 'web-id', agentId: 'agent-a', provider,
      claudeSessionId: 'cli-id', workDir: '/repo', dbMessages: [],
    });
    expect(store.conversations.map(row => row.id)).toEqual(['other-agent', 'other-provider', 'web-id']);
    expect(store.sendWsMessage).toHaveBeenCalledWith({ type: 'select_conversation', conversationId: 'web-id' });
  });

  it.each(['claude-code', 'copilot'])('retains the hidden Web identity for %s on the selected Agent', provider => {
    vi.useFakeTimers();
    try {
      const row = {
        catalogKey: 'chat:web-id',
        routeRef: { runtimeProvider: provider, agentId: 'agent-a', sessionId: 'web-id' },
      };
      const store = {
        currentAgent: 'agent-a',
        conversations: [
          { id: 'other-agent', agentId: 'agent-b', provider, claudeSessionId: 'cli-id' },
          { id: 'other-provider', agentId: 'agent-a', provider: provider === 'copilot' ? 'claude-code' : 'copilot', claudeSessionId: 'cli-id' },
          { id: 'web-id', agentId: 'agent-a', provider, claudeSessionId: 'cli-id' },
        ],
        hiddenSessionCatalog: [row],
        restoreCatalogSession: vi.fn(() => true),
        sendWsMessage: vi.fn(),
      };
      resumeConversation(store, 'cli-id', '/repo', null, { provider });
      expect(store.restoreCatalogSession).toHaveBeenCalledWith(row);
      expect(store.sendWsMessage).toHaveBeenCalledWith(expect.objectContaining({
        type: 'resume_conversation', conversationId: 'web-id', claudeSessionId: 'cli-id', agentId: 'agent-a', provider,
      }));

      store.restoreCatalogSession.mockReturnValue(false);
      store.sendWsMessage.mockClear();
      resumeConversation(store, 'cli-id', '/repo', null, { provider });
      expect(store.sendWsMessage).not.toHaveBeenCalled();

      store.hiddenSessionCatalog = [];
      resumeConversation(store, 'cli-id', '/repo', null, { provider });
      expect(store.sendWsMessage).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'web-id' }));

      store.sendWsMessage.mockClear();
      resumeConversation(store, 'unknown-cli-id', '/repo', null, { provider });
      expect(store.sendWsMessage).toHaveBeenCalledWith(expect.objectContaining({ claudeSessionId: 'unknown-cli-id' }));
      expect(store.sendWsMessage.mock.calls[0][0]).not.toHaveProperty('conversationId');
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
const { default: AssistantTurn } = await import('../../web/components/AssistantTurn.js');
const { default: MessageItem } = await import('../../web/components/MessageItem.js');
const { useSessionsStore } = await import('../../web/stores/sessions.js');
const { useVpStore } = await import('../../web/stores/vp.js');
const { default: SessionCreateModal } = await import('../../web/components/SessionCreateModal.js');
const { default: ChatPage } = await import('../../web/components/ChatPage.js');
const { default: YeaftSidebar } = await import('../../web/components/YeaftSidebar.js');
const { default: WorkCenterPage } = await import('../../web/components/WorkCenterPage.js');
const { default: PluginCenterPage } = await import('../../web/components/PluginCenterPage.js');
const {
  __testSortYeaftRowsBySequence,
  handleConversationCreated,
  handleConversationResumed,
  handleSyncMessagesResult,
} = await import('../../web/stores/helpers/handlers/conversationHandler.js');
const { handleAgentSelected } = await import('../../web/stores/helpers/handlers/agentHandler.js');
const { handleMessage } = await import('../../web/stores/helpers/messageHandler.js');
const { createInitialConversationViewState } = await import('../../web/stores/helpers/yeaft-view.js');
const { createFileOperations } = await import('../../web/components/files/fileOperations.js');
const { createGitOperations } = await import('../../web/components/git/gitOperations.js');
const { createFileTabs } = await import('../../web/components/files/fileTabs.js');
const { createFileCloseEventHandlers } = await import('../../web/components/FilesTab.js');
const dialogModule = await import('../../web/utils/dialog.js');
const { workbenchWorkspaceGeneration } = await import('../../web/utils/workbench-route.js');

import {
  buildYeaftMessageTurnSpans,
  hasHiddenYeaftMessageTurns,
  sliceYeaftMessagesByRecentTurns,
} from '../../web/stores/helpers/yeaft-message-window.js';

function makeStore() {
  return {
    yeaftConversationId: 'conv-1',
    _currentYeaftSessionId: 'session-1',
    _currentYeaftVpId: 'vp-1',
    _currentYeaftTurnId: 'turn-1',
    messagesMap: { 'conv-1': [] },
    yeaftSessionHistoryState: {},
  };
}

function createFileTabsHarness() {
  globalThis.Vue = Vue;
  const store = {
    currentAgent: 'agent-1',
    currentConversation: 'conversation-1',
    clientId: 'client-1',
    sendWsMessage: vi.fn(),
  };
  const cleanupUndoHistory = vi.fn();
  const tabs = createFileTabs(store, {
    normalizePath: path => path,
    getEffectiveWorkDir: () => '/workspace',
    editorContainer: Vue.ref(null),
    createEditor: vi.fn(),
    destroyEditor: vi.fn(),
    clearFindMarkers: vi.fn(),
    saveCurrentUndoHistory: vi.fn(),
    saveAllUndoHistory: vi.fn(),
    cleanupUndoHistory,
    deleteConversationHistory: vi.fn(),
    debugStatus: Vue.ref(''),
    mdPreviewMode: Vue.ref(false),
    renderOfficeLocal: vi.fn(),
    performFind: vi.fn(),
    findBarVisible: Vue.ref(false),
    findQuery: Vue.ref(''),
    t: (key, params) => `${key}:${params?.name || params?.count || ''}`,
  });
  const open = (path, dirty = false) => {
    tabs.openFileInTab(path, path.split('/').pop(), {
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      workDir: '/workspace',
    });
    const file = tabs.openFiles.value.at(-1);
    file.isDirty = dirty;
    return file;
  };
  return { store, tabs, cleanupUndoHistory, open };
}

function currentWorkspace() {
  return {
    routeKey: 'yeaft:agent-1:session-1',
    workspaceGeneration: 'yeaft:agent-1:session-1@generation-1',
  };
}

function fileCloseHandlers(harness, { disposed = () => false, liveStore } = {}) {
  const workspace = currentWorkspace();
  const store = liveStore || {
    activeSessionRoute: { runtimeProvider: 'yeaft', agentId: 'agent-1', sessionId: 'session-1' },
    effectiveWorkDir: '/workspace',
  };
  // The generation helper is deterministic; use its real value in the fixture.
  workspace.workspaceGeneration = workbenchWorkspaceGeneration(workspace.routeKey, store.effectiveWorkDir);
  return {
    workspace,
    handlers: createFileCloseEventHandlers({
      liveStore: store,
      props: workspace,
      tabs: harness.tabs,
      isDisposed: disposed,
    }),
  };
}

describe('file tab async close fences', () => {
  it('aborts capability close when a tab is added during confirmation', async () => {
    const harness = createFileTabsHarness();
    harness.open('/workspace/a.txt', true);
    const { workspace, handlers } = fileCloseHandlers(harness);
    let resolved;
    const close = handlers.handleCloseFilesCapability({
      detail: { ...workspace, resolve: value => { resolved = value; } },
    });
    harness.open('/workspace/b.txt');
    dialogModule.resolveDialog(true);
    await close;

    expect(resolved).toBe(false);
    expect(harness.tabs.openFiles.value.map(file => file.path)).toEqual([
      '/workspace/a.txt', '/workspace/b.txt',
    ]);
    expect(harness.cleanupUndoHistory).not.toHaveBeenCalled();
  });

  it('uses stable file identity and rejects queued dirty closes after index drift', async () => {
    const harness = createFileTabsHarness();
    harness.open('/workspace/a.txt', true);
    harness.open('/workspace/b.txt', true);
    harness.open('/workspace/c.txt');
    const first = harness.tabs.closeFileTab(0);
    const second = harness.tabs.closeFileTab(1);

    dialogModule.resolveDialog(true);
    await first;
    await Vue.nextTick();
    dialogModule.resolveDialog(true);
    await second;

    expect(harness.tabs.openFiles.value.map(file => file.path)).toEqual([
      '/workspace/b.txt', '/workspace/c.txt',
    ]);
    expect(harness.cleanupUndoHistory).toHaveBeenCalledTimes(1);
    expect(harness.cleanupUndoHistory).toHaveBeenCalledWith('conversation-1', '/workspace/a.txt');
  });

  it('rejects capability close after FilesTab disposal', async () => {
    const harness = createFileTabsHarness();
    harness.open('/workspace/a.txt', true);
    let disposed = false;
    const { workspace, handlers } = fileCloseHandlers(harness, { disposed: () => disposed });
    let resolved;
    const close = handlers.handleCloseFilesCapability({
      detail: { ...workspace, resolve: value => { resolved = value; } },
    });
    disposed = true;
    dialogModule.resolveDialog(true);
    await close;

    expect(resolved).toBe(false);
    expect(harness.tabs.openFiles.value).toHaveLength(1);
  });

  it.each([
    ['route', liveStore => { liveStore.activeSessionRoute.sessionId = 'session-2'; }],
    ['workspace generation', liveStore => { liveStore.effectiveWorkDir = '/other-workspace'; }],
  ])('rejects single-tab dirty close after %s drift', async (_label, drift) => {
    const harness = createFileTabsHarness();
    harness.open('/workspace/a.txt', true);
    const liveStore = {
      activeSessionRoute: { runtimeProvider: 'yeaft', agentId: 'agent-1', sessionId: 'session-1' },
      effectiveWorkDir: '/workspace',
    };
    const { workspace, handlers } = fileCloseHandlers(harness, { liveStore });
    const close = handlers.handleCloseFileItem({ detail: { ...workspace, path: '/workspace/a.txt' } });
    drift(liveStore);
    dialogModule.resolveDialog(true);
    await close;

    expect(harness.tabs.openFiles.value).toHaveLength(1);
    expect(harness.cleanupUndoHistory).not.toHaveBeenCalled();
  });
});

describe('app dialog contracts', () => {
  it('queues requests FIFO and resolves each request exactly once', async () => {
    globalThis.Vue = Vue;
    const dialogModule = await import('../../web/utils/dialog.js');
    const first = dialogModule.confirmDialog('first');
    const second = dialogModule.promptDialog('second', 'seed');
    expect(dialogModule.useDialogState()).toMatchObject({ type: 'confirm', message: 'first' });

    dialogModule.resolveDialog(true);
    dialogModule.resolveDialog(false);
    await expect(first).resolves.toBe(true);
    await Vue.nextTick();
    expect(dialogModule.useDialogState()).toMatchObject({ type: 'prompt', message: 'second', value: 'seed' });
    dialogModule.resolveDialog(true, 'edited');
    await expect(second).resolves.toBe('edited');
    await Vue.nextTick();
    expect(dialogModule.useDialogState().open).toBe(false);
  });

  it('enforces keyboard, overlay, focus trap, inert background, and focus restoration', async () => {
    globalThis.Vue = Vue;
    const dialogModule = await import('../../web/utils/dialog.js');
    const { default: AppDialog } = await import('../../web/components/AppDialog.js');
    const trigger = document.createElement('button');
    trigger.textContent = 'trigger';
    document.body.appendChild(trigger);
    trigger.focus();
    const wrapper = mount(AppDialog, {
      attachTo: document.body,
      global: { mocks: { $t: key => key } },
    });
    const element = selector => document.body.querySelector(selector);

    const confirm = dialogModule.confirmDialog('confirm');
    await Vue.nextTick();
    await Vue.nextTick();
    expect(trigger.inert).toBe(true);
    expect(document.activeElement).toBe(element('.app-dialog-confirm'));
    element('.app-dialog-confirm').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(element('.btn-secondary'));
    element('.btn-secondary').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(element('.app-dialog-confirm'));
    element('.app-dialog-overlay').click();
    await expect(confirm).resolves.toBe(false);
    await Vue.nextTick();
    await Vue.nextTick();
    expect(trigger.inert).toBe(false);
    expect(document.activeElement).toBe(trigger);

    const prompt = dialogModule.promptDialog('prompt', 'seed');
    await Vue.nextTick();
    await Vue.nextTick();
    expect(document.activeElement).toBe(element('.app-dialog-input'));
    element('.app-dialog-input').value = 'edited';
    element('.app-dialog-input').dispatchEvent(new Event('input', { bubbles: true }));
    element('.app-dialog-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await expect(prompt).resolves.toBe('edited');

    const escapedPrompt = dialogModule.promptDialog('escape');
    await Vue.nextTick();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await expect(escapedPrompt).resolves.toBeNull();
    const alert = dialogModule.alertDialog('alert');
    await Vue.nextTick();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await expect(alert).resolves.toBeUndefined();

    wrapper.unmount();
    trigger.remove();
  });
});

describe('message flow regressions', () => {
  it('resolves file references per response instead of dropping later turns at the 32-path cap', () => {
    storeFactories.clear();
    runtimeSessionsStore.sessionList = [{ id: 'session-files', agentId: 'agent-files' }];
    const store = useChatStore();
    store.currentView = 'yeaft';
    store.currentAgent = 'agent-files';
    store.currentAgentInfo = {
      id: 'agent-files',
      workDir: '/workspace/files',
      capabilities: ['file_reference_resolution', 'workbench_session_routes'],
    };
    store.workbenchRouteProtocolSupported = true;
    store.yeaftAgentId = 'agent-files';
    store.yeaftConversationId = 'yeaft-agent-files';
    store.yeaftConversationIdsByAgent = { 'agent-files': 'yeaft-agent-files' };
    store.yeaftActiveSessionFilter = 'session-files';
    store.sendWsMessage = vi.fn(() => true);

    const requestIds = Array.from({ length: 33 }, (_unused, index) => (
      store.resolveMessageFileReferences([`src/file-${index}.js`])
    ));

    expect(new Set(requestIds).size).toBe(33);
    expect(store.sendWsMessage).toHaveBeenCalledTimes(33);
    expect(store.sendWsMessage.mock.calls.at(-1)[0]).toMatchObject({
      type: 'resolve_file_references',
      references: ['src/file-32.js'],
      agentId: 'agent-files',
      conversationId: 'yeaft-agent-files',
      workDir: '/workspace/files',
    });
  });

  it.each([
    ['old Agent', true, ['file_reference_resolution']],
    ['old Server', false, ['file_reference_resolution', 'workbench_session_routes']],
    ['reconnecting Server', null, ['file_reference_resolution', 'workbench_session_routes']],
  ])('does not send automatic file-reference requests to an incompatible %s', (_label, protocol, capabilities) => {
    storeFactories.clear();
    runtimeSessionsStore.sessionList = [{ id: 'session-files', agentId: 'agent-files' }];
    const store = useChatStore();
    store.currentView = 'yeaft';
    store.currentAgent = 'agent-files';
    store.currentAgentInfo = { id: 'agent-files', workDir: '/workspace/files', capabilities };
    store.agents = [store.currentAgentInfo];
    store.workbenchRouteProtocolSupported = protocol;
    store.yeaftAgentId = 'agent-files';
    store.yeaftConversationIdsByAgent = { 'agent-files': 'yeaft-agent-files' };
    store.yeaftActiveSessionFilter = 'session-files';
    store.sendWsMessage = vi.fn(() => true);

    expect(store.resolveMessageFileReferences(['src/file.js'])).toBeNull();
    expect(store.sendWsMessage).not.toHaveBeenCalled();

    // Capability refresh/reconnect must allow resolution again without clearing
    // Session caches or asking the user to reload the page.
    store.workbenchRouteProtocolSupported = true;
    store.currentAgentInfo.capabilities = ['file_reference_resolution', 'workbench_session_routes'];
    expect(store.resolveMessageFileReferences(['src/file.js'])).toEqual(expect.any(String));
    expect(store.sendWsMessage).toHaveBeenCalledOnce();
    expect(store.sendWsMessage.mock.calls[0][0].workbenchRoute).toEqual({
      runtimeProvider: 'yeaft', agentId: 'agent-files', sessionId: 'session-files',
    });
  });

  it('changes the file-reference resolution context when route readiness changes', () => {
    storeFactories.clear();
    runtimeSessionsStore.sessionList = [{ id: 'session-files', agentId: 'agent-files' }];
    const store = useChatStore();
    store.currentView = 'yeaft';
    store.connectionState = 'connecting';
    store.authenticated = false;
    store.workbenchRouteProtocolSupported = false;
    store.currentAgent = 'agent-files';
    store.currentAgentInfo = {
      id: 'agent-files',
      workDir: '/workspace/files',
      capabilities: ['file_reference_resolution'],
    };
    store.agents = [store.currentAgentInfo];
    store.yeaftAgentId = 'agent-files';
    store.yeaftConversationId = 'yeaft-agent-files';
    store.yeaftConversationIdsByAgent = { 'agent-files': 'yeaft-agent-files' };
    store.yeaftActiveSessionFilter = 'session-files';

    const connectingKey = store.fileReferenceResolutionContextKey;
    expect(connectingKey).not.toBe('');

    store.connectionState = 'connected';
    store.authenticated = true;
    store.workbenchRouteProtocolSupported = true;
    store.currentAgentInfo.capabilities.push('file_editor', 'workbench_session_routes');
    const readyKey = store.fileReferenceResolutionContextKey;
    expect(readyKey).not.toBe(connectingKey);

    store.yeaftYeaftDir = '/workspace/ready';
    const workDirKey = store.fileReferenceResolutionContextKey;
    expect(workDirKey).not.toBe(readyKey);

    runtimeSessionsStore.sessionList.push({ id: 'session-other', agentId: 'agent-files' });
    store.yeaftActiveSessionFilter = 'session-other';
    const routeKey = store.fileReferenceResolutionContextKey;
    expect(routeKey).not.toBe(workDirKey);

    store.currentAgentInfo.capabilities = ['file_editor', 'workbench_session_routes'];
    expect(store.fileReferenceResolutionContextKey).toBe('');
  });

  it('does not keep a phantom file-reference request when the socket send fails', () => {
    storeFactories.clear();
    runtimeSessionsStore.sessionList = [{ id: 'session-files', agentId: 'agent-files' }];
    const store = useChatStore();
    store.currentView = 'yeaft';
    store.connectionState = 'connected';
    store.authenticated = true;
    store.workbenchRouteProtocolSupported = true;
    store.currentAgent = 'agent-files';
    store.currentAgentInfo = {
      id: 'agent-files',
      workDir: '/workspace/files',
      capabilities: ['file_editor', 'file_reference_resolution', 'workbench_session_routes'],
    };
    store.agents = [store.currentAgentInfo];
    store.yeaftAgentId = 'agent-files';
    store.yeaftConversationId = 'yeaft-agent-files';
    store.yeaftConversationIdsByAgent = { 'agent-files': 'yeaft-agent-files' };
    store.yeaftActiveSessionFilter = 'session-files';
    store.sendWsMessage = vi.fn(() => false);

    expect(store.resolveMessageFileReferences(['src/file.js'])).toBeNull();
    expect(store.sendWsMessage).toHaveBeenCalledOnce();
  });

  it('keeps container upgrade guidance separate from the npm manual-upgrade path', () => {
    for (const messages of [enMessages, zhCNMessages]) {
      const text = messages['chat.agent.containerImageUpgradeRequired'];
      expect(text).toContain('docker pull');
      expect(text).toContain('/home/yeaft/.yeaft');
      expect(text).toContain('/workspace');
      expect(text).toContain('agent-secret');
      expect(text).toMatch(/Do not remove|不要删除|不要在重建时删除/);
      expect(text).not.toMatch(/npm install -g/);
    }
  });

  it('keeps a submitted AskUser answer through replay until the Agent confirms it', () => {
    vi.useFakeTimers();
    try {
      const conversationId = 'yeaft-ask-replay';
      const sessionId = 'session-ask-replay';
      const store = useChatStore();
      store.currentView = 'yeaft';
      store.currentAgent = 'agent-ask';
      store.yeaftAgentId = 'agent-ask';
      store.yeaftConversationId = conversationId;
      store.yeaftConversationIdsByAgent = { 'agent-ask': conversationId };
      store.yeaftActiveSessionFilter = sessionId;
      store.messagesMap = {
        [conversationId]: [{
          id: 'ask-row',
          type: 'tool-use',
          toolName: 'AskUserQuestion',
          toolId: 'call-ask-replay',
          askRequestId: 'ask-replay',
          askQuestions: [{ question: 'Continue?', options: [{ label: 'Yes', description: '' }] }],
          sessionId,
          vpId: 'vp-ask',
          turnId: 'turn-ask',
          threadId: 'main',
          hasResult: false,
        }],
      };
      const sendWsMessage = vi.fn(() => true);
      store.sendWsMessage = sendWsMessage;

      answerUserQuestion(store, 'ask-replay', { 'Continue?': 'Yes' }, conversationId);
      expect(store.messagesMap[conversationId][0]).toMatchObject({
        askPending: true,
        pendingAnswers: { 'Continue?': 'Yes' },
        askRequestId: 'ask-replay',
      });

      vi.advanceTimersByTime(10_001);
      expect(store.messagesMap[conversationId][0]).toMatchObject({
        askPending: true,
        pendingAnswers: { 'Continue?': 'Yes' },
        askRequestId: 'ask-replay',
      });

      store.handleYeaftOutput({
        type: 'yeaft_output',
        agentId: 'agent-ask',
        conversationId,
        sessionId,
        vpId: 'vp-ask',
        turnId: 'turn-ask',
        threadId: 'main',
        event: {
          type: 'ask_user_question',
          requestId: 'ask-replay',
          toolCallId: 'call-ask-replay',
          replay: true,
          questions: [{ question: 'Continue?', options: [{ label: 'Yes', description: '' }] }],
        },
      });

      expect(store.messagesMap[conversationId][0]).toMatchObject({
        askPending: true,
        pendingAnswers: { 'Continue?': 'Yes' },
        askRequestId: 'ask-replay',
      });

      store.handleYeaftOutput({
        type: 'yeaft_output',
        agentId: 'agent-ask',
        conversationId,
        sessionId,
        vpId: 'vp-ask',
        turnId: 'turn-ask',
        threadId: 'main',
        event: {
          type: 'ask_user_answered',
          requestId: 'ask-replay',
          toolCallId: 'call-ask-replay',
          answers: { 'Continue?': 'Yes' },
        },
      });

      expect(store.messagesMap[conversationId][0]).toMatchObject({
        askAnswered: true,
        selectedAnswers: { 'Continue?': 'Yes' },
        askPending: false,
        askRequestId: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves the configured MCP cache when an error broadcast omits servers', () => {
    const store = useChatStore();
    store.yeaftMcpServers = [{ name: 'github', command: 'node', args: [], env: {} }];
    store.yeaftMcpRuntime = { connected: true, toolCount: 1, perServer: [{ name: 'github', ready: true, toolCount: 1 }] };
    store.yeaftMcpError = null;

    handleMessage(store, {
      type: 'yeaft_mcp_updated',
      reason: 'base-runtime-load',
      runtime: { connected: true, toolCount: 1, perServer: [{ name: 'github', ready: true, toolCount: 1 }] },
      error: 'Failed to read config.json: plugins.tools must be an array',
    });

    expect(store.yeaftMcpServers).toEqual([{ name: 'github', command: 'node', args: [], env: {} }]);
    expect(store.yeaftMcpRuntime).toMatchObject({
      connected: true,
      perServer: [expect.objectContaining({ name: 'github', ready: true })],
    });
    expect(store.yeaftMcpError).toContain('Failed to read config.json');
  });

  it('renders an immediate upgrade requirement instead of waiting for an unsupported Plugin Agent', async () => {
    const pluginStore = Vue.reactive({
      agents: [{
        id: 'agent-old',
        name: 'Old Agent',
        online: true,
        capabilities: ['plaintext-ok'],
        capabilityMetadataProvided: true,
      }],
      currentAgent: 'agent-old',
      pluginCenterAgentId: 'agent-old',
      pluginConfigByAgent: {},
      pluginCatalogByKey: {},
      pluginCatalogKey: (agentId, workDir = '') => `${agentId}:${workDir}`,
      loadPluginConfig: vi.fn(),
      loadPluginCatalog: vi.fn(),
      savePluginConfig: vi.fn(),
      sendWsMessage: vi.fn(),
    });
    const priorStore = globalThis.Pinia.useChatStore;
    globalThis.Pinia.useChatStore = () => pluginStore;
    const pluginCenter = mount(PluginCenterPage, {
      global: { mocks: { $t: translatePluginCenterMessage } },
    });
    await Vue.nextTick();

    expect(pluginStore.loadPluginConfig).not.toHaveBeenCalled();
    expect(pluginStore.loadPluginCatalog).not.toHaveBeenCalled();
    expect(pluginCenter.text()).toContain(enMessages['yeaft.plugins.upgradeRequired']);
    expect(pluginCenter.get('.plugin-center-icon-button').attributes('disabled')).toBeDefined();
    expect(pluginCenter.get('.btn-primary').attributes('disabled')).toBeDefined();

    pluginCenter.unmount();
    globalThis.Pinia.useChatStore = priorStore;
  });

  it('keeps the active Agent selection intact when another Agent save resolves late', async () => {
    const configRequests = [];
    const saveRequests = [];
    const pluginStore = Vue.reactive({
      agents: [
        { id: 'agent-a', name: 'Agent A', online: true, capabilities: ['yeaft_plugins'] },
        { id: 'agent-b', name: 'Agent B', online: true, capabilities: ['yeaft_plugins'] },
      ],
      currentAgent: 'agent-a',
      pluginCenterAgentId: 'agent-a',
      pluginConfigByAgent: {
        'agent-a': { loaded: true, plugins: { tools: ['A'] } },
      },
      pluginCatalogByKey: {
        'agent-a:': { loading: false, catalog: { tools: [], skills: [], mcpServers: [] } },
        'agent-b:': { loading: false, catalog: { tools: [], skills: [], mcpServers: [] } },
      },
      pluginCatalogKey: (agentId, workDir = '') => `${agentId}:${workDir}`,
      loadPluginConfig: vi.fn(agentId => new Promise(resolve => {
        configRequests.push({ agentId, resolve });
      })),
      loadPluginCatalog: vi.fn(() => Promise.resolve()),
      savePluginConfig: vi.fn((plugins, agentId) => new Promise(resolve => {
        saveRequests.push({ plugins, agentId, resolve });
      })),
    });
    const priorStore = globalThis.Pinia.useChatStore;
    globalThis.Pinia.useChatStore = () => pluginStore;
    const pluginCenter = mount(PluginCenterPage, {
      global: { mocks: { $t: translatePluginCenterMessage } },
    });
    await Vue.nextTick();

    pluginCenter.vm.selection = { tools: ['A-draft'] };
    const saveA = pluginCenter.vm.save();
    expect(pluginStore.savePluginConfig).toHaveBeenLastCalledWith({ tools: ['A-draft'] }, 'agent-a');
    expect(pluginCenter.vm.saving).toBe(true);

    pluginStore.pluginCenterAgentId = 'agent-b';
    await Vue.nextTick();
    expect(pluginCenter.vm.selection).toBeNull();
    expect(pluginCenter.vm.savedSelection).toBeNull();
    expect(pluginCenter.vm.saving).toBe(false);
    expect(configRequests).toHaveLength(1);
    expect(configRequests[0].agentId).toBe('agent-b');

    configRequests[0].resolve({ plugins: { tools: ['B'] } });
    await vi.waitFor(() => expect(pluginCenter.vm.configReady).toBe(true));
    expect(pluginCenter.vm.selection).toEqual({ tools: ['B'] });
    expect(pluginCenter.vm.savedSelection).toEqual({ tools: ['B'] });

    pluginCenter.vm.selection = { tools: ['B-draft'] };
    expect(pluginCenter.vm.isDirty).toBe(true);
    const saveB = pluginCenter.vm.save();
    expect(pluginStore.savePluginConfig).toHaveBeenLastCalledWith({ tools: ['B-draft'] }, 'agent-b');
    expect(pluginCenter.vm.saving).toBe(true);

    saveRequests[0].resolve({ plugins: { tools: ['A'] } });
    await saveA;
    await Vue.nextTick();
    expect(pluginCenter.vm.agentId).toBe('agent-b');
    expect(pluginCenter.vm.selection).toEqual({ tools: ['B-draft'] });
    expect(pluginCenter.vm.savedSelection).toEqual({ tools: ['B'] });
    expect(pluginCenter.vm.isDirty).toBe(true);
    expect(pluginCenter.vm.saving).toBe(true);
    expect(pluginStore.savePluginConfig).toHaveBeenCalledTimes(2);

    saveRequests[1].resolve({ plugins: { tools: ['B-draft'] } });
    await saveB;
    await Vue.nextTick();
    expect(pluginCenter.vm.selection).toEqual({ tools: ['B-draft'] });
    expect(pluginCenter.vm.savedSelection).toEqual({ tools: ['B-draft'] });
    expect(pluginCenter.vm.isDirty).toBe(false);
    expect(pluginCenter.vm.saving).toBe(false);

    pluginCenter.unmount();
    globalThis.Pinia.useChatStore = priorStore;
  });

  it('ignores a stale catalog refresh error after switching Agents', async () => {
    let resolveRefreshA;
    const pluginStore = Vue.reactive({
      agents: [
        { id: 'agent-a', name: 'Agent A', online: true, capabilities: ['yeaft_plugins'], capabilityMetadataProvided: true },
        { id: 'agent-b', name: 'Agent B', online: true, capabilities: ['yeaft_plugins'], capabilityMetadataProvided: true },
      ],
      currentAgent: 'agent-a',
      pluginCenterAgentId: 'agent-a',
      pluginConfigByAgent: {
        'agent-a': { loaded: true, plugins: { tools: ['A'] } },
        'agent-b': { loaded: true, plugins: { tools: ['B'] } },
      },
      pluginCatalogByKey: {
        'agent-a:': { loading: false, catalog: { tools: [{ id: 'A', label: 'A' }], skills: [], mcpServers: [] } },
        'agent-b:': { loading: false, catalog: { tools: [{ id: 'B', label: 'B' }], skills: [], mcpServers: [] } },
      },
      pluginCatalogKey: (agentId, workDir = '') => `${agentId}:${workDir}`,
      loadPluginConfig: vi.fn(() => Promise.resolve()),
      loadPluginCatalog: vi.fn(() => Promise.resolve()),
      savePluginConfig: vi.fn(),
    });
    const priorStore = globalThis.Pinia.useChatStore;
    globalThis.Pinia.useChatStore = () => pluginStore;
    const pluginCenter = mount(PluginCenterPage, {
      global: { mocks: { $t: translatePluginCenterMessage } },
    });
    await Vue.nextTick();
    expect(pluginCenter.vm.selection).toEqual({ tools: ['A'] });
    expect(pluginCenter.vm.savedSelection).toEqual({ tools: ['A'] });

    pluginStore.loadPluginCatalog.mockImplementationOnce(() => new Promise(resolve => {
      resolveRefreshA = resolve;
    }));
    const refreshA = pluginCenter.vm.refresh();
    expect(resolveRefreshA).toBeTypeOf('function');
    expect(pluginStore.loadPluginCatalog).toHaveBeenLastCalledWith('agent-a', '');

    pluginStore.pluginCenterAgentId = 'agent-b';
    await Vue.nextTick();
    expect(pluginCenter.vm.agentId).toBe('agent-b');
    expect(pluginCenter.vm.configReady).toBe(true);
    expect(pluginCenter.vm.selection).toEqual({ tools: ['B'] });
    expect(pluginCenter.vm.savedSelection).toEqual({ tools: ['B'] });
    expect(pluginCenter.vm.saving).toBe(false);
    expect(pluginCenter.vm.error).toBe('');

    resolveRefreshA({ error: 'Agent A catalog refresh failed' });
    await refreshA;
    await Vue.nextTick();
    expect(pluginCenter.vm.error).toBe('');
    expect(pluginCenter.vm.selection).toEqual({ tools: ['B'] });
    expect(pluginCenter.vm.savedSelection).toEqual({ tools: ['B'] });
    expect(pluginCenter.vm.saving).toBe(false);

    pluginCenter.unmount();
    globalThis.Pinia.useChatStore = priorStore;
  });

  it('ignores an older refresh error when a newer refresh for the same Agent finishes first', async () => {
    const refreshRequests = [];
    const pluginStore = Vue.reactive({
      agents: [
        { id: 'agent-a', name: 'Agent A', online: true, capabilities: ['yeaft_plugins'], capabilityMetadataProvided: true },
      ],
      currentAgent: 'agent-a',
      pluginCenterAgentId: 'agent-a',
      pluginConfigByAgent: {
        'agent-a': { loaded: true, plugins: { tools: ['A'] } },
      },
      pluginCatalogByKey: {
        'agent-a:': { loading: false, catalog: { tools: [{ id: 'A', label: 'A' }], skills: [], mcpServers: [] } },
      },
      pluginCatalogKey: (agentId, workDir = '') => `${agentId}:${workDir}`,
      loadPluginConfig: vi.fn(() => Promise.resolve()),
      loadPluginCatalog: vi.fn(() => Promise.resolve()),
      savePluginConfig: vi.fn(),
    });
    const priorStore = globalThis.Pinia.useChatStore;
    globalThis.Pinia.useChatStore = () => pluginStore;
    const pluginCenter = mount(PluginCenterPage, {
      global: { mocks: { $t: translatePluginCenterMessage } },
    });
    await Vue.nextTick();

    pluginStore.loadPluginCatalog.mockImplementation(() => new Promise(resolve => {
      refreshRequests.push(resolve);
    }));
    const olderRefresh = pluginCenter.vm.refresh();
    const newerRefresh = pluginCenter.vm.refresh();
    expect(refreshRequests).toHaveLength(2);

    refreshRequests[1]({ error: 'Newer refresh failed' });
    await newerRefresh;
    expect(pluginCenter.vm.error).toBe('Newer refresh failed');

    refreshRequests[0]({ error: 'Older refresh failed' });
    await olderRefresh;
    await Vue.nextTick();
    expect(pluginCenter.vm.error).toBe('Newer refresh failed');
    expect(pluginCenter.vm.selection).toEqual({ tools: ['A'] });
    expect(pluginCenter.vm.savedSelection).toEqual({ tools: ['A'] });

    pluginCenter.unmount();
    globalThis.Pinia.useChatStore = priorStore;
  });

  it('clears the dirty baseline when switching to an explicitly unsupported Plugin Agent', async () => {
    const pluginStore = Vue.reactive({
      agents: [
        { id: 'agent-a', name: 'Agent A', online: true, capabilities: ['yeaft_plugins'], capabilityMetadataProvided: true },
        { id: 'agent-b', name: 'Agent B', online: true, capabilities: ['plaintext-ok'], capabilityMetadataProvided: true },
      ],
      currentAgent: 'agent-a',
      pluginCenterAgentId: 'agent-a',
      pluginConfigByAgent: {
        'agent-a': { loaded: true, plugins: { tools: ['FileRead'] } },
      },
      pluginCatalogByKey: {
        'agent-a:': { loading: false, catalog: { tools: [{ id: 'FileRead', label: 'FileRead' }], skills: [], mcpServers: [] } },
      },
      pluginCatalogKey: (agentId, workDir = '') => `${agentId}:${workDir}`,
      loadPluginConfig: vi.fn(() => Promise.resolve()),
      loadPluginCatalog: vi.fn(() => Promise.resolve()),
      savePluginConfig: vi.fn(),
    });
    const priorStore = globalThis.Pinia.useChatStore;
    globalThis.Pinia.useChatStore = () => pluginStore;
    const pluginCenter = mount(PluginCenterPage, {
      global: { mocks: { $t: translatePluginCenterMessage } },
    });
    await Vue.nextTick();
    expect(pluginCenter.vm.savedSelection).toEqual({ tools: ['FileRead'] });

    pluginStore.pluginCenterAgentId = 'agent-b';
    await Vue.nextTick();
    expect(pluginCenter.vm.agentSupportsPlugins).toBe(false);
    expect(pluginCenter.vm.selection).toBeNull();
    expect(pluginCenter.vm.savedSelection).toBeNull();
    expect(pluginCenter.vm.isDirty).toBe(false);
    expect(pluginCenter.find('.plugin-center-unsaved').exists()).toBe(false);
    expect(pluginCenter.get('.plugin-center-save').attributes('disabled')).toBeDefined();
    await pluginCenter.vm.save();
    expect(pluginStore.savePluginConfig).not.toHaveBeenCalled();

    pluginCenter.unmount();
    globalThis.Pinia.useChatStore = priorStore;
  });

  it('keeps the latest same-key Plugin catalog cache when replies arrive out of order', async () => {
    const store = useChatStore();
    const key = store.pluginCatalogKey('agent-a');
    store.agents = [{
      id: 'agent-a', name: 'Agent A', online: true,
      capabilities: ['yeaft_plugins'], capabilityMetadataProvided: true,
    }];
    store.currentAgent = 'agent-a';
    store.pluginCenterAgentId = 'agent-a';
    store.pluginCatalogByKey = {
      [key]: {
        catalog: { tools: [{ id: 'seed-tool' }], skills: [], mcpServers: [] },
        loading: false,
        error: null,
        loaded: true,
      },
    };
    store.pluginCatalogRequestByKey = {};
    store._pluginPending = {};
    store.sendWsMessage = vi.fn(() => true);

    const older = store.loadPluginCatalog('agent-a');
    const olderRequest = store.sendWsMessage.mock.calls.at(-1)[0];
    const newer = store.loadPluginCatalog('agent-a');
    const newerRequest = store.sendWsMessage.mock.calls.at(-1)[0];
    expect(olderRequest.requestId).not.toBe(newerRequest.requestId);
    expect(store.pluginCatalogRequestByKey[key]).toBe(newerRequest.requestId);

    handleMessage(store, {
      type: 'yeaft_plugin_catalog_result',
      agentId: 'agent-a',
      requestId: newerRequest.requestId,
      catalog: { tools: [{ id: 'new-tool' }], skills: [], skillSources: [], mcpServers: [] },
      error: null,
    });
    await expect(newer).resolves.toEqual({
      catalog: { tools: [{ id: 'new-tool' }], skills: [], skillSources: [], mcpServers: [] },
      error: null,
    });
    expect(store.pluginCatalogByKey[key]).toMatchObject({
      catalog: { tools: [{ id: 'new-tool' }], skills: [], skillSources: [], mcpServers: [] },
      loading: false,
      error: null,
    });

    handleMessage(store, {
      type: 'yeaft_plugin_catalog_result',
      agentId: 'agent-a',
      requestId: olderRequest.requestId,
      catalog: { tools: [{ id: 'old-tool' }], skills: [], skillSources: [], mcpServers: [] },
      error: 'old request failed late',
    });
    await expect(older).resolves.toEqual({
      catalog: { tools: [{ id: 'old-tool' }], skills: [], skillSources: [], mcpServers: [] },
      error: 'old request failed late',
    });
    expect(store.pluginCatalogRequestByKey[key]).toBe(newerRequest.requestId);
    expect(store.pluginCatalogByKey[key]).toMatchObject({
      catalog: { tools: [{ id: 'new-tool' }], skills: [], skillSources: [], mcpServers: [] },
      loading: false,
      error: null,
    });
    expect(store._pluginPending).toEqual({});
  });

  it('keeps a newer Plugin catalog cache after an older request times out and replies late', async () => {
    vi.useFakeTimers();
    try {
      const store = useChatStore();
      const key = store.pluginCatalogKey('agent-a');
      store.agents = [{
        id: 'agent-a', name: 'Agent A', online: true,
        capabilities: ['yeaft_plugins'], capabilityMetadataProvided: true,
      }];
      store.currentAgent = 'agent-a';
      store.pluginCenterAgentId = 'agent-a';
      store.pluginCatalogByKey = {
        [key]: {
          catalog: { tools: [{ id: 'seed-tool' }], skills: [], mcpServers: [] },
          loading: false,
          error: null,
          loaded: true,
        },
      };
      store.pluginCatalogRequestByKey = {};
      store._pluginPending = {};
      store.sendWsMessage = vi.fn(() => true);

      const older = store.loadPluginCatalog('agent-a');
      const olderRequest = store.sendWsMessage.mock.calls.at(-1)[0];
      await vi.advanceTimersByTimeAsync(1);
      const newer = store.loadPluginCatalog('agent-a');
      const newerRequest = store.sendWsMessage.mock.calls.at(-1)[0];
      expect(store.pluginCatalogRequestByKey[key]).toBe(newerRequest.requestId);

      await vi.advanceTimersByTimeAsync(9_999);
      await expect(older).resolves.toEqual({
        catalog: { tools: [], skills: [], mcpServers: [] },
        error: 'timeout',
      });
      expect(store.pluginCatalogByKey[key]).toMatchObject({
        catalog: { tools: [{ id: 'seed-tool' }], skills: [], mcpServers: [] },
        loading: true,
        error: null,
      });

      handleMessage(store, {
        type: 'yeaft_plugin_catalog_result',
        agentId: 'agent-a',
        requestId: 'unknown-catalog-result',
        catalog: { tools: [{ id: 'unknown-tool' }], skills: [], mcpServers: [] },
        error: 'unknown request error',
      });
      expect(store.pluginCatalogByKey[key]).toMatchObject({
        catalog: { tools: [{ id: 'seed-tool' }], skills: [], mcpServers: [] },
        loading: true,
        error: null,
      });

      handleMessage(store, {
        type: 'yeaft_plugin_catalog_result',
        agentId: 'agent-a',
        requestId: olderRequest.requestId,
        catalog: { tools: [{ id: 'old-tool' }], skills: [], skillSources: [], mcpServers: [] },
        error: 'late old error',
      });
      expect(store.pluginCatalogByKey[key]).toMatchObject({
        catalog: { tools: [{ id: 'seed-tool' }], skills: [], mcpServers: [] },
        loading: true,
        error: null,
      });

      handleMessage(store, {
        type: 'yeaft_plugin_catalog_result',
        agentId: 'agent-a',
        requestId: newerRequest.requestId,
        catalog: { tools: [{ id: 'new-tool' }], skills: [], skillSources: [], mcpServers: [] },
        error: null,
      });
      await expect(newer).resolves.toEqual({
        catalog: { tools: [{ id: 'new-tool' }], skills: [], skillSources: [], mcpServers: [] },
        error: null,
      });
      expect(store.pluginCatalogByKey[key]).toMatchObject({
        catalog: { tools: [{ id: 'new-tool' }], skills: [], skillSources: [], mcpServers: [] },
        loading: false,
        error: null,
      });
      expect(store._pluginPending).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it('distinguishes explicit Plugin incompatibility from missing capability metadata', async () => {
    const store = useChatStore();
    store.agents = [{
      id: 'agent-old',
      online: true,
      capabilities: ['plaintext-ok'],
      capabilityMetadataProvided: true,
    }];
    store.sendWsMessage = vi.fn();

    await expect(store.loadPluginConfig('agent-old')).resolves.toMatchObject({
      error: expect.stringContaining('does not support Plugins'),
    });
    await expect(store.savePluginConfig({}, 'agent-old')).resolves.toMatchObject({
      error: expect.stringContaining('does not support Plugins'),
    });
    await expect(store.loadPluginCatalog('agent-old')).resolves.toMatchObject({
      error: expect.stringContaining('does not support Plugins'),
    });
    expect(store.sendWsMessage).not.toHaveBeenCalled();

    store.agents = [{ id: 'agent-legacy', online: true, capabilities: ['plaintext-ok'] }];
    const config = store.loadPluginConfig('agent-legacy');
    const catalog = store.loadPluginCatalog('agent-legacy');

    expect(store.sendWsMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'get_yeaft_plugins', agentId: 'agent-legacy',
    }));
    expect(store.sendWsMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'yeaft_plugin_catalog', agentId: 'agent-legacy',
    }));

    for (const [requestId, pending] of Object.entries(store._pluginPending)) {
      clearTimeout(pending.timer);
      delete store._pluginPending[requestId];
      pending.resolve(pending.kind === 'catalog'
        ? { catalog: { tools: [], skills: [], mcpServers: [] }, error: null }
        : { plugins: {}, error: null });
    }
    await Promise.all([config, catalog]);
  });


  it('applies the final serialized MCP mutation broadcast to the configured cache', () => {
    const store = useChatStore();
    const github = { name: 'github', command: 'node', args: [], env: {} };
    const linear = { name: 'linear', command: 'node', args: [], env: {} };
    store.yeaftMcpServers = [github];
    store.yeaftMcpRuntime = { connected: true, toolCount: 1, perServer: [{ name: 'github', ready: true, toolCount: 1 }] };
    store.yeaftMcpError = null;

    handleMessage(store, {
      type: 'yeaft_mcp_updated',
      reason: 'add',
      servers: [github, linear],
      runtime: {
        connected: true,
        toolCount: 2,
        perServer: [
          { name: 'github', ready: true, toolCount: 1 },
          { name: 'linear', ready: true, toolCount: 1 },
        ],
      },
      error: null,
    });
    handleMessage(store, {
      type: 'yeaft_mcp_updated',
      reason: 'remove',
      servers: [linear],
      runtime: { connected: true, toolCount: 1, perServer: [{ name: 'linear', ready: true, toolCount: 1 }] },
      error: null,
    });

    expect(store.yeaftMcpServers.map(server => server.name)).toEqual(['linear']);
    expect(store.yeaftMcpRuntime).toMatchObject({
      connected: true,
      perServer: [expect.objectContaining({ name: 'linear', ready: true })],
    });
    expect(store.yeaftMcpError).toBeNull();
  });

  it('keeps the manual upgrade bridge in stop-install-start order in both languages', () => {
    const installCommand = 'npm install -g @yeaft/webchat-agent@latest --registry=https://pkg.yeaft.com/';
    const guides = [
      {
        message: enMessages['chat.agent.manualUpgradeRequired'],
        stopAnchor: 'First stop the selected Agent/service',
        managerAnchor: 'PM2 or another service manager',
        foregroundAnchor: 'foreground terminal',
        exitAnchor: 'Confirm that process has exited',
        startAnchor: 'start the same Agent instance again with its original configuration',
      },
      {
        message: zhCNMessages['chat.agent.manualUpgradeRequired'],
        stopAnchor: '先停止该机器上所选的 Agent/服务',
        managerAnchor: 'PM2 或其他服务管理器',
        foregroundAnchor: '前台终端',
        exitAnchor: '确认该进程已经退出',
        startAnchor: '使用原配置启动同一 Agent 实例',
      },
    ];

    for (const guide of guides) {
      expect(guide.message).toContain(guide.managerAnchor);
      expect(guide.message).toContain(guide.foregroundAnchor);
      const stopIndex = guide.message.indexOf(guide.stopAnchor);
      const exitIndex = guide.message.indexOf(guide.exitAnchor);
      const installIndex = guide.message.indexOf(installCommand);
      const startIndex = guide.message.indexOf(guide.startAnchor);
      expect(stopIndex).toBeGreaterThanOrEqual(0);
      expect(exitIndex).toBeGreaterThan(stopIndex);
      expect(installIndex).toBeGreaterThan(exitIndex);
      expect(startIndex).toBeGreaterThan(installIndex);
    }
  });
  it('does not refresh Work Center for routine agent inventory broadcasts', () => {
    const store = useChatStore();
    store.workCenterOpen = true;
    store.workCenterAgentId = 'agent-work-center';
    store.currentAgent = 'agent-work-center';
    store.currentView = 'yeaft';
    store._hasHandledAgentList = true;
    store._yeaftReconnectCatchUpPending = false;
    store.agents = [{
      id: 'agent-work-center',
      name: 'server',
      online: true,
      version: '1.0.369',
      capabilities: ['work_center'],
      conversations: [],
    }];
    store.currentAgentInfo = store.agents[0];
    store.listWorkItems = vi.fn(() => Promise.resolve([]));
    store.loadOpenedYeaftSessionsForConnectedAgents = vi.fn();
    store.requestYeaftSessionBootstrap = vi.fn();
    store.sendWsMessage = vi.fn(() => true);

    handleMessage(store, {
      type: 'agent_list',
      agents: [{ ...store.agents[0], latency: 12 }],
    });
    handleMessage(store, {
      type: 'agent_list',
      agents: [{ ...store.agents[0], latency: 18 }],
    });

    expect(store.listWorkItems).not.toHaveBeenCalled();
  });

  it('refreshes Work Center once after a genuine reconnect and preserves active filters', () => {
    const store = useChatStore();
    const activeFilters = {
      lane: 'active',
      keyword: 'reconnect',
      vpId: 'vp-reviewer',
    };
    store.workCenterOpen = true;
    store.workCenterAgentId = 'agent-work-center';
    store.currentAgent = 'agent-work-center';
    store.currentView = 'chat';
    store.recoveryDismissed = true;
    store._hasHandledAgentList = false;
    store._yeaftReconnectCatchUpPending = true;
    store._workCenterListFiltersByAgent = {
      'agent-work-center': activeFilters,
    };
    store.agents = [{
      id: 'agent-work-center',
      name: 'server',
      online: true,
      version: '1.0.369',
      capabilities: ['work_center'],
      conversations: [],
    }];
    store.currentAgentInfo = store.agents[0];
    store.listWorkItems = vi.fn(() => Promise.resolve([]));
    store.loadOpenedYeaftSessionsForConnectedAgents = vi.fn();
    store.requestYeaftSessionBootstrap = vi.fn();
    store.sendWsMessage = vi.fn(() => true);

    handleMessage(store, {
      type: 'agent_list',
      agents: [{ ...store.agents[0], latency: 12 }],
    });

    expect(store.listWorkItems).toHaveBeenCalledTimes(1);
    expect(store.listWorkItems).toHaveBeenCalledWith('agent-work-center', activeFilters);
    expect(store._yeaftReconnectCatchUpPending).toBe(false);
    expect(store.sendWsMessage).toHaveBeenCalledWith({
      type: 'select_agent',
      agentId: 'agent-work-center',
      silent: true,
    });

    handleMessage(store, {
      type: 'agent_list',
      agents: [{ ...store.agents[0], latency: 18 }],
    });

    expect(store.listWorkItems).toHaveBeenCalledTimes(1);
  });

  it('refreshes an open Work Center once when its Agent process comes back online', () => {
    const store = useChatStore();
    const activeFilters = { lane: 'needs_attention', keyword: 'restart' };
    store.workCenterOpen = true;
    store.workCenterAgentId = 'agent-work-center';
    store.currentAgent = 'agent-work-center';
    store.currentView = 'chat';
    store.recoveryDismissed = true;
    store._hasHandledAgentList = true;
    store._yeaftReconnectCatchUpPending = false;
    store._yeaftAgentSeen = {
      id: 'agent-work-center',
      online: false,
      version: '1.0.369',
    };
    store._workCenterListFiltersByAgent = {
      'agent-work-center': activeFilters,
    };
    store.agents = [];
    store.currentAgentInfo = null;
    store.listWorkItems = vi.fn(() => Promise.resolve([]));
    store.loadOpenedYeaftSessionsForConnectedAgents = vi.fn();
    store.requestYeaftSessionBootstrap = vi.fn();
    store.sendWsMessage = vi.fn(() => true);

    const onlineAgent = {
      id: 'agent-work-center',
      name: 'server',
      online: true,
      version: '1.0.370',
      capabilities: ['work_center'],
      conversations: [],
    };
    handleMessage(store, {
      type: 'agent_list',
      agents: [onlineAgent],
    });

    expect(store.listWorkItems).toHaveBeenCalledTimes(1);
    expect(store.listWorkItems).toHaveBeenCalledWith('agent-work-center', activeFilters);
    expect(store._yeaftReconnectCatchUpPending).toBe(false);

    handleMessage(store, {
      type: 'agent_list',
      agents: [{ ...onlineAgent, latency: 24 }],
    });

    expect(store.listWorkItems).toHaveBeenCalledTimes(1);
  });

  it('prunes completed Yeaft resident turns at terminal metadata boundaries', async () => {
    const { useChatStore } = await import('../../web/stores/chat.js');
    const store = useChatStore();
    const conversationId = 'yeaft-memory-bound';
    const sessionId = 'session-memory-bound';
    store.currentView = 'yeaft';
    store.currentAgent = 'agent-memory';
    store.yeaftAgentId = 'agent-memory';
    store.yeaftConversationId = conversationId;
    store.yeaftConversationIdsByAgent = { 'agent-memory': conversationId };
    store.yeaftActiveSessionFilter = sessionId;
    store.messagesMap = { [conversationId]: [] };
    store.activeVpTurns = {};
    store.stoppingVpTurnIds = {};
    store.vpStatuses = {};
    store.yeaftProcessingSessions = {};

    const turnCount = YEAFT_HISTORY_CACHE_LIMITS.maxTurnsPerSession + 20;
    for (let index = 1; index <= turnCount; index += 1) {
      store.messagesMap[conversationId].push(
        {
          id: `user-${index}`,
          dbMessageId: index,
          type: 'user',
          content: `prompt ${index}`,
          sessionId,
          clientMessageId: `client-${index}`,
        },
        {
          id: `assistant-${index}`,
          type: 'assistant',
          content: `response ${index}`,
          sessionId,
          turnId: `turn-${index}`,
          status: index === turnCount ? 'pending' : 'completed',
          isStreaming: false,
        },
      );
    }

    store.handleYeaftOutput({
      agentId: 'agent-memory',
      conversationId,
      event: {
        type: 'vp_turn_end',
        sessionId,
        vpId: 'omni',
        turnId: `turn-${turnCount}`,
        reason: 'end_turn',
      },
    });

    const kept = store.messagesMap[conversationId];
    expect(kept.length).toBeLessThanOrEqual(YEAFT_HISTORY_CACHE_LIMITS.maxTurnsPerSession * 2);
    expect(kept.some(row => row.id === `user-${turnCount}`)).toBe(true);
    expect(kept.some(row => row.id === `assistant-${turnCount}`)).toBe(true);
    expect(kept.some(row => row.id === 'user-1')).toBe(false);
  });

  it('drops oversized live debug detail from legacy Agent events', async () => {
    const { useChatStore } = await import('../../web/stores/chat.js');
    const store = useChatStore();
    const large = 'x'.repeat(1024 * 1024);
    store.yeaftDebugLoops = [];
    store.yeaftDebugTurnsById = {
      'turn-legacy-debug': {
        turnId: 'turn-legacy-debug',
        sessionId: 'session-debug',
        tools: [],
        closedAt: null,
      },
    };
    store.yeaftDebugTurnOrder = ['turn-legacy-debug'];

    store.handleYeaftOutput({
      agentId: 'agent-debug',
      conversationId: 'conv-debug',
      sessionId: 'session-debug',
      event: {
        type: 'loop',
        turnId: 'turn-legacy-debug',
        loopNumber: 1,
        model: 'provider/model',
        systemPrompt: large,
        messages: [{ role: 'user', content: large }],
        response: large,
        toolCalls: [{ id: 'call-1', name: 'Bash', input: { command: large } }],
        rawRequest: { body: large },
        rawResponse: large,
        usage: { totalTokens: 42 },
      },
    });
    store.handleYeaftOutput({
      agentId: 'agent-debug',
      conversationId: 'conv-debug',
      sessionId: 'session-debug',
      event: {
        type: 'tool_exec',
        turnId: 'turn-legacy-debug',
        loopNumber: 1,
        callId: 'call-1',
        name: 'Bash',
        toolOutput: large,
      },
    });

    expect(store.yeaftDebugLoops).toHaveLength(1);
    expect(store.yeaftDebugLoops[0]).toMatchObject({
      turnId: 'turn-legacy-debug',
      loopNumber: 1,
      model: 'provider/model',
      usage: { totalTokens: 42 },
    });
    expect(store.yeaftDebugLoops[0]).not.toHaveProperty('systemPrompt');
    expect(store.yeaftDebugLoops[0]).not.toHaveProperty('messages');
    expect(store.yeaftDebugLoops[0]).not.toHaveProperty('rawRequest');
    expect(store.yeaftDebugLoops[0]).not.toHaveProperty('rawResponse');
    expect(store.yeaftDebugLoops[0]).not.toHaveProperty('response');
    expect(store.yeaftDebugLoops[0]).not.toHaveProperty('toolCalls');
    expect(store.yeaftDebugTurnsById['turn-legacy-debug'].tools[0]).not.toHaveProperty('toolOutput');
    expect(JSON.stringify(store.yeaftDebugLoops).length).toBeLessThan(2048);
  });

  it('refreshes debug idle timeout for accepted chunks, retries once, and fences close/foreign replies', () => {
    vi.useFakeTimers();
    try {
      const store = useChatStore();
      store.currentAgent = 'agent-debug';
      store.sendWsMessage = vi.fn();
      store.loadYeaftDebugHistory({ detailTurnId: 'turn-chunks' });
      const first = store.sendWsMessage.mock.calls.at(-1)[0];
      expect(first.agentId).toBe('agent-debug');
      const body = JSON.stringify({ type: 'yeaft_debug_history', agentId: first.agentId,
        requestId: first.requestId, detailTurnId: 'turn-chunks', turns: [], loops: [] });
      const chunk = (index, agentId = first.agentId) => ({ type: 'yeaft_debug_history_chunk', agentId,
        requestId: first.requestId, chunkCount: 3, chunkIndex: index,
        data: index === 0 ? body.slice(0, 20) : index === 1 ? body.slice(20, 40) : body.slice(40) });
      vi.advanceTimersByTime(20_000);
      handleMessage(store, chunk(0));
      vi.advanceTimersByTime(20_000);
      expect(store.sendWsMessage).toHaveBeenCalledTimes(1);
      handleMessage(store, chunk(1, 'other-agent'));
      vi.advanceTimersByTime(10_000);
      expect(store.sendWsMessage).toHaveBeenCalledTimes(2);
      const retry = store.sendWsMessage.mock.calls.at(-1)[0];
      expect(retry.requestId).not.toBe(first.requestId);
      handleMessage(store, { ...JSON.parse(body), turns: [{ turnId: 'stale' }] });
      expect(store.yeaftDebugHistoryLoading).toBe(true);
      vi.advanceTimersByTime(30_000);
      expect(store.sendWsMessage).toHaveBeenCalledTimes(2);
      expect(store.yeaftDebugHistoryError).toBe('debug_history_timeout');
      expect(store._yeaftDebugHistoryPending).toBeNull();
      store.loadYeaftDebugHistory({ detailTurnId: 'turn-chunks' });
      const final = store.sendWsMessage.mock.calls.at(-1)[0];
      store.closeYeaftDebugPanel();
      handleMessage(store, { ...JSON.parse(body), requestId: final.requestId, turns: [{ turnId: 'closed' }] });
      vi.advanceTimersByTime(60_000);
      expect(store.sendWsMessage).toHaveBeenCalledTimes(3);
      expect(store.yeaftDebugTurnsById.closed).toBeUndefined();
      expect(store.yeaftDebugHistoryLoading).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces live debug refresh only for the open Agent/Session/Turn and cancels on close', () => {
    vi.useFakeTimers();
    try {
      const store = useChatStore();
      store.yeaftDebugHistoryLoading = false;
      store.yeaftDebugPanel = { open: true, turnId: 'live-turn', agentId: 'live-agent', sessionId: 'live-session', requestId: 'panel-open' };
      const load = vi.spyOn(store, 'loadYeaftDebugHistory').mockImplementation(() => {});
      store.scheduleYeaftDebugDetailRefresh({ agentId: 'foreign', sessionId: 'live-session' }, 'live-turn');
      vi.advanceTimersByTime(600);
      expect(load).not.toHaveBeenCalled();
      const identity = { agentId: 'live-agent', sessionId: 'live-session' };
      store.scheduleYeaftDebugDetailRefresh(identity, 'live-turn');
      store.scheduleYeaftDebugDetailRefresh(identity, 'live-turn');
      vi.advanceTimersByTime(500);
      expect(load).toHaveBeenCalledExactlyOnceWith({ groupId: 'live-session', detailTurnId: 'live-turn' });
      store.scheduleYeaftDebugDetailRefresh(identity, 'live-turn');
      store.closeYeaftDebugPanel();
      vi.advanceTimersByTime(500);
      expect(load).toHaveBeenCalledTimes(1);
      load.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('hydrates full persisted debug detail over the same live metadata loop', () => {
    const turnId = 'turn-debug-detail';
    const store = {
      _yeaftDebugHistoryLatestDetailRequestId: 'detail-request',
      _yeaftDebugHistoryLatestListRequestId: null,
      _fetchYeaftDebugHistoryTimer: null,
      _yeaftDebugHistoryInFlightKey: 'session-debug:turn-debug-detail',
      yeaftDebugTurnsById: {
        [turnId]: {
          turnId,
          sessionId: 'session-debug',
          closedAt: 123,
          liveOnlyStatus: 'complete',
        },
      },
      yeaftDebugLoops: [{
        turnId,
        loopNumber: 1,
        model: 'provider/model',
        usage: { totalTokens: 42 },
        liveOnlySequence: 9,
      }],
      yeaftDebugTurnOrder: [turnId],
      yeaftDebugHistoryLoading: true,
    };
    const fullMessages = [{ role: 'user', content: 'full persisted message' }];
    const fullRawRequest = { body: { input: 'full persisted request' } };

    handleMessage(store, {
      type: 'yeaft_debug_history',
      requestId: 'detail-request',
      detailTurnId: turnId,
      turns: [{ turnId, sessionId: 'session-debug', detailsLoaded: true }],
      loops: [{
        turnId,
        loopNumber: 1,
        model: 'provider/model',
        systemPrompt: 'full persisted prompt',
        messages: fullMessages,
        response: 'full persisted response',
        toolCalls: [{ id: 'call-1', name: 'Bash', input: { command: 'true' } }],
        rawRequest: fullRawRequest,
        rawResponse: { output: 'full persisted raw response' },
        usage: { totalTokens: 42 },
      }],
    });

    expect(store.yeaftDebugHistoryLoading).toBe(false);
    expect(store.yeaftDebugLoops).toHaveLength(1);
    expect(store.yeaftDebugLoops[0]).toMatchObject({
      turnId,
      loopNumber: 1,
      liveOnlySequence: 9,
      systemPrompt: 'full persisted prompt',
      messages: fullMessages,
      response: 'full persisted response',
      rawRequest: fullRawRequest,
      rawResponse: { output: 'full persisted raw response' },
    });

    // Older Agents send structural deltas without a materialized rawRequest.
    handleMessage(store, {
      type: 'yeaft_debug_history', requestId: 'detail-request', detailTurnId: turnId,
      turns: [{ turnId, detailsLoaded: true }],
      loops: [{ turnId, loopNumber: 1, requestDelta: { rawRequestDelta: { replacement: fullRawRequest } } }],
    });
    expect(store.yeaftDebugLoops[0].rawRequest).toEqual(fullRawRequest);
    handleMessage(store, {
      type: 'yeaft_debug_history', requestId: 'detail-request', detailTurnId: turnId,
      turns: [{ turnId, detailsLoaded: true }],
      loops: [{ turnId, loopNumber: 1, rawRequest: null,
        requestDelta: { rawRequestDelta: { replacement: fullRawRequest } } }],
    });
    expect(store.yeaftDebugLoops[0].rawRequest).toBeNull();
  });

  it('keeps same-id streaming updates in one assistant message', () => {
    const store = makeStore();

    appendToAssistantMessageForConversation(store, 'conv-1', 'hello ', {
      id: 'msg-1',
      sessionId: 'session-1',
      vpId: 'vp-1',
      turnId: 'turn-1',
    });
    appendToAssistantMessageForConversation(store, 'conv-1', 'world', {
      id: 'msg-1',
      sessionId: 'session-1',
      vpId: 'vp-1',
      turnId: 'turn-1',
    });

    expect(store.messagesMap['conv-1']).toHaveLength(1);
    expect(store.messagesMap['conv-1'][0]).toMatchObject({
      type: 'assistant',
      content: 'hello world',
      isStreaming: true,
      speakerVpId: 'vp-1',
      turnId: 'turn-1',
    });

    appendToAssistantMessageForConversation(store, 'conv-1', 'hello world!', {
      id: 'msg-1',
      turnId: 'turn-1',
    });

    expect(store.messagesMap['conv-1']).toHaveLength(1);
    expect(store.messagesMap['conv-1'][0]).toMatchObject({
      type: 'assistant',
      content: 'hello world!',
      isStreaming: true,
      speakerVpId: 'vp-1',
      turnId: 'turn-1',
    });

    finishStreamingForConversation(store, 'conv-1', { completeLifecycle: false });
    expect(store.messagesMap['conv-1'][0]).toMatchObject({
      content: 'hello world!',
      isStreaming: false,
      status: 'pending',
      turnId: 'turn-1',
    });
    expect(store.messagesMap['conv-1'][0]).not.toHaveProperty('turnEndAt');
  });

  it('keeps the largest persisted DB id when a streaming row is at the tail', () => {
    expect(maxDbMessageId([
      { id: 'optimistic-user', dbMessageId: 17 },
      { id: 'streaming-assistant-uuid', isStreaming: true },
    ])).toBe(17);
  });

  it('links only typed Work Center URL outputs', () => {
    const isExternalOutput = WorkCenterPage.methods.isExternalOutput;
    expect(isExternalOutput({ kind: 'link', ref: 'https://example.test/artifact' })).toBe(true);
    expect(isExternalOutput({ kind: 'pr', ref: 'https://github.com/example/repo/pull/1' })).toBe(true);
    expect(isExternalOutput({ kind: 'link', ref: 'javascript:alert(1)' })).toBe(false);
    expect(isExternalOutput({ kind: 'commit', ref: 'https://example.test/callback#access_token=secret' })).toBe(false);
    expect(isExternalOutput({ kind: 'file', ref: 'https://example.test/callback#access_token=secret' })).toBe(false);
    expect(isExternalOutput('https://example.test/untyped')).toBe(false);
  });

  it('keeps Work Center inputs available and detail layouts responsive', async () => {
    const component = readFileSync(resolve(import.meta.dirname, '../../web/components/ChatInput.js'), 'utf8');
    const messageComposer = readFileSync(resolve(import.meta.dirname, '../../web/components/MessageComposer.js'), 'utf8');
    const websocket = readFileSync(resolve(import.meta.dirname, '../../web/stores/helpers/websocket.js'), 'utf8');
    const chatStoreSource = readFileSync(resolve(import.meta.dirname, '../../web/stores/chat.js'), 'utf8');
    const chatPageSource = readFileSync(resolve(import.meta.dirname, '../../web/components/ChatPage.js'), 'utf8');
    const yeaftSidebarSource = readFileSync(resolve(import.meta.dirname, '../../web/components/YeaftSidebar.js'), 'utf8');
    const vpAvatarSource = readFileSync(resolve(import.meta.dirname, '../../web/components/VpAvatar.js'), 'utf8');
    const chatMessagesCss = readFileSync(resolve(import.meta.dirname, '../../web/styles/chat-messages.css'), 'utf8');
    const vpCss = readFileSync(resolve(import.meta.dirname, '../../web/styles/yeaft-vp.css'), 'utf8');
    const sidebarCss = readFileSync(resolve(import.meta.dirname, '../../web/styles/sidebar.css'), 'utf8');
    const chatInputCss = readFileSync(resolve(import.meta.dirname, '../../web/styles/chat-input.css'), 'utf8');
    const yeaftCss = readFileSync(resolve(import.meta.dirname, '../../web/styles/yeaft.css'), 'utf8');
    const yeaftSidebarCss = readFileSync(resolve(import.meta.dirname, '../../web/styles/yeaft-sidebar.css'), 'utf8');
    const variables = readFileSync(resolve(import.meta.dirname, '../../web/styles/variables.css'), 'utf8');
    const lightThemeVariables = variables.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] || '';
    const darkThemeVariables = variables.match(/\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/)?.[1] || '';
    expect(sidebarCss).toMatch(/\.unread-dot\s*\{[^}]*background:\s*var\(--success\)/);
    expect(lightThemeVariables).toMatch(/--session-content-width:\s*90%/);
    expect(sidebarCss).toMatch(/\.messages\s*\{[^}]*max-width:\s*var\(--session-content-width\)/);
    for (const selector of ['input-quote-preview', 'attachments-preview', 'input-hints', 'input-wrapper']) {
      expect(chatInputCss).toMatch(new RegExp(`\\.${selector}\\s*\\{[^}]*max-width:\\s*var\\(--session-content-width\\)`));
    }
    expect(yeaftCss).not.toMatch(/\.yeaft-page \.messages\s*\{[^}]*max-width:\s*90%/);
    expect(yeaftCss).not.toMatch(/\.yeaft-page \.(?:input-wrapper|input-quote-preview|attachments-preview)\s*\{[^}]*max-width:\s*90%/);
    expect(yeaftCss).toMatch(/\.yeaft-session-input > \.input-wrapper\.chat-composer,[\s\S]*?\.yeaft-page \.expert-chips-bar\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*var\(--session-content-width\)/);
    expect(variables).not.toContain('--yeaft-composer-max-width');
    expect(yeaftSidebarCss).toMatch(/\.sidebar-primary-actions\s*\{[^}]*padding:\s*6px 8px 4px/);
    expect(yeaftSidebarCss).toMatch(/\.sidebar-primary-action\s*\{[^}]*min-height:\s*34px[^}]*border:\s*0[^}]*background:\s*transparent[^}]*font:\s*inherit[^}]*font-size:\s*14px/);
    expect(yeaftSidebarCss).toMatch(/\.sidebar-primary-action:hover,[^{]*\{[^}]*background:\s*var\(--sidebar-hover\)/);
    expect(yeaftSidebarCss).toMatch(/\.sidebar-primary-action:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent-blue\)/);
    expect(yeaftSidebarCss).toMatch(/\.sidebar-primary-action-icon\s*\{[^}]*color:\s*var\(--text-secondary\)/);
    expect(yeaftSidebarCss).not.toMatch(/\.sidebar-primary-action-icon\s*\{[^}]*color:\s*var\(--accent/);
    expect(yeaftSidebarCss).toMatch(/\.sidebar-project-add-button\s*\{[^}]*opacity:\s*0[^}]*pointer-events:\s*none/);
    expect(yeaftSidebarCss).toMatch(/\.sidebar-section-heading > \.sidebar-project-add-button:disabled\s*\{[^}]*opacity:\s*0[^}]*pointer-events:\s*none/);
    expect(yeaftSidebarCss).toMatch(/\.sidebar-section-heading:hover > \.sidebar-project-add-button:not\(:disabled\),[\s\S]*?\.sidebar-section-heading > \.sidebar-project-add-button:not\(:disabled\):focus-visible\s*\{[^}]*opacity:\s*1[^}]*pointer-events:\s*auto/);
    expect(yeaftSidebarCss).not.toContain('.sidebar-section-heading:focus-within > .sidebar-project-add-button');
    expect(yeaftSidebarCss).toMatch(/@media \(pointer:\s*coarse\)\s*\{\s*\.sidebar-project-add-button:not\(:disabled\), \.sidebar-section-chevron\s*\{[^}]*opacity:\s*1[^}]*pointer-events:\s*auto/);
    const sectionPaddingTopValues = sidebarSectionTopValues(yeaftSidebarCss, 'padding');
    const sectionMarginTopValues = sidebarSectionTopValues(yeaftSidebarCss, 'margin');
    expect(sectionPaddingTopValues.length).toBeGreaterThan(0);
    expect(sectionPaddingTopValues.every(value => CSS_ZERO.test(value))).toBe(true);
    expect(sectionMarginTopValues.length).toBeGreaterThan(0);
    expect(sectionMarginTopValues.every(value => CSS_ZERO.test(value))).toBe(true);
    const nonzeroOverride = `${yeaftSidebarCss}\n.projects-section { padding-top: 4px; }`;
    expect(sidebarSectionTopValues(nonzeroOverride, 'padding').every(value => CSS_ZERO.test(value))).toBe(false);
    expect(yeaftSidebarCss).toMatch(/\.sidebar-session-row\s*\{[^}]*background:\s*transparent/);
    expect(yeaftSidebarCss).toMatch(/\.sidebar-session-title-text\s*\{[^}]*flex:\s*1[^}]*text-overflow:\s*ellipsis/);
    expect(yeaftSidebarCss).toMatch(/\.sidebar-session-unread\s*\{[^}]*background:\s*var\(--success\)/);
    expect(yeaftSidebarCss).toMatch(/\.sidebar-session-row\[role="button"\]\s*\{[^}]*cursor:\s*default/);
    expect(yeaftSidebarCss).toMatch(/\.sidebar-session-row\[draggable="true"\]\s*\{[^}]*user-select:\s*none/);
    expect(yeaftSidebarCss).not.toMatch(/\.sidebar-session-row\[draggable="true"\](?::active)?\s*\{[^}]*cursor:\s*grab(?:bing)?/);
    expect(yeaftSidebarCss).toMatch(/\.sidebar-session-row\.drag-before\s*\{[^}]*box-shadow:\s*inset 0 2px 0 var\(--accent-blue\)/);
    expect(yeaftSidebarCss).toMatch(/\.sidebar-session-row\.drag-after\s*\{[^}]*box-shadow:\s*inset 0 -2px 0 var\(--accent-blue\)/);
    expect(yeaftSidebarCss).toMatch(/\.sidebar-project-create\s*\{[^}]*background:\s*var\(--bg-input-wrapper\)/);
    expect(yeaftSidebarCss).toMatch(/\.sidebar-session-results\s*\{[^}]*display:\s*flex[^}]*overflow:\s*hidden/);
    expect(yeaftSidebarCss).toMatch(/\.projects-section\s*\{[^}]*flex:\s*0 0 auto[^}]*max-height:\s*50%[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/);
    expect(yeaftSidebarCss).toMatch(/\.recents-section\s*\{[^}]*flex:\s*1 1 auto[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/);
    expect(yeaftSidebarCss).not.toMatch(/\.projects-section, \.recents-section\s*\{[^}]*flex:\s*1 1 50%/);
    expect(yeaftSidebarCss).toMatch(/\.sidebar-section-heading\s*\{[^}]*min-height:\s*38px[^}]*color:\s*var\(--text-muted\)[^}]*font-size:\s*14px[^}]*font-weight:\s*600/);
    expect(yeaftSidebarCss).toMatch(/\.projects-section > \.sidebar-section-heading, \.recents-section > \.sidebar-section-heading\s*\{[^}]*position:\s*sticky[^}]*top:\s*0[^}]*z-index:\s*1[^}]*background:\s*var\(--bg-sidebar\)/);
    expect(yeaftSidebarCss).toMatch(/\.sidebar-recents-create\s*\{[^}]*opacity:\s*0[^}]*pointer-events:\s*none/);
    expect(yeaftSidebarCss).toMatch(/\.recents-section > \.sidebar-section-heading:hover > \.sidebar-recents-create,[\s\S]*?\.recents-section > \.sidebar-section-heading > \.sidebar-recents-create:focus-visible\s*\{[^}]*opacity:\s*1[^}]*pointer-events:\s*auto/);
    expect(yeaftSidebarCss).not.toContain('.sidebar-section-heading:focus-within > .sidebar-recents-create');
    expect(yeaftSidebarCss).toMatch(/@media \(pointer:\s*coarse\)\s*\{\s*\.sidebar-recents-create\s*\{[^}]*opacity:\s*1[^}]*pointer-events:\s*auto/);
    expect(yeaftSidebarCss).toMatch(/\.sidebar-session-menu-info\s*\{[^}]*display:\s*flex[^}]*justify-content:\s*space-between/);
    expect(yeaftSidebarCss).toMatch(/\.sidebar-session-row \.session-actions\s*\{[^}]*position:\s*absolute[^}]*opacity:\s*0[^}]*pointer-events:\s*none[^}]*linear-gradient\(90deg, transparent, var\(--sidebar-hover\) 22px\)/);
    expect(yeaftSidebarCss).toMatch(/\.sidebar-session-row:hover \.session-actions,[\s\S]*?\.sidebar-session-row \.session-actions:focus-within,[\s\S]*?\.sidebar-session-row \.session-actions\.menu-open\s*\{[^}]*opacity:\s*1[^}]*pointer-events:\s*auto/);
    expect(yeaftSidebarCss).not.toContain('.sidebar-session-row:focus-within .session-actions');
    expect(yeaftSidebarCss).toMatch(/\.sidebar-session-row\.actions-suppressed \.session-actions\s*\{[^}]*opacity:\s*0[^}]*pointer-events:\s*none/);
    expect(yeaftSidebarCss).not.toMatch(/\.yeaft-sidebar \.session-dots-btn\s*\{[^}]*opacity:\s*1/);
    expect(yeaftSidebarCss).toMatch(/\.sidebar-project-header > \.session-dots-btn:focus-visible\s*\{[^}]*opacity:\s*1/);
    expect(yeaftSidebarCss).toMatch(/@media \(pointer:\s*coarse\)[\s\S]*?\.sidebar-project-header > \.sidebar-project-session-create\s*\{[^}]*opacity:\s*1[^}]*pointer-events:\s*auto[\s\S]*?\.sidebar-project-header > \.session-dots-btn\s*\{[^}]*opacity:\s*1/);
    expect(yeaftSidebarCss).not.toContain('.sidebar-session-menu-divider');
    expect(yeaftSidebarCss).toMatch(/\.sidebar-section-toggle\s*\{[^}]*background:\s*transparent/);
    expect(yeaftSidebarCss).toMatch(/\.sidebar-section-chevron\s*\{[^}]*opacity:\s*0[^}]*pointer-events:\s*none/);
    expect(yeaftSidebarCss).toMatch(/\.sidebar-section-heading:hover \.sidebar-section-chevron,[\s\S]*?\.sidebar-section-toggle:focus-visible \.sidebar-section-chevron\s*\{[^}]*opacity:\s*1[^}]*pointer-events:\s*auto/);
    expect(yeaftSidebarCss).not.toContain('.sidebar-section-heading:focus-within .sidebar-section-chevron');
    expect(yeaftSidebarCss).toMatch(/\.sidebar-project-icon\s*\{[^}]*width:\s*var\(--sidebar-project-icon-width\)[^}]*height:\s*var\(--sidebar-project-icon-height\)/);
    expect(yeaftSidebarCss).toMatch(/\.sidebar-project-count\s*\{[^}]*font-size:\s*var\(--sidebar-project-count-font-size\)[^}]*font-variant-numeric:\s*tabular-nums/);
    expect(yeaftSidebarCss).toMatch(/\.sidebar-project-header\.project-drag-before\s*\{[^}]*var\(--accent-blue\)/);
    expect(yeaftSidebarCss).toMatch(/\.sidebar-project-header\.project-drag-after\s*\{[^}]*var\(--accent-blue\)/);
    expect(chatMessagesCss).toMatch(/\.image-preview-navigation\s*\{[^}]*background:\s*var\(--bg-main\)/);
    expect(chatMessagesCss).toMatch(/\.image-preview-position\s*\{[^}]*color:\s*var\(--text-primary\)/);
    expect(lightThemeVariables).toContain('--image-preview-control-size: 44px');
    expect(darkThemeVariables).toContain('--image-preview-control-size: 44px');
    expect(vpAvatarSource).not.toContain('/assets/avatars/');
    expect(vpAvatarSource).not.toContain('<img');
    expect(vpCss).not.toContain('.vp-avatar-img');

    const first = chatRouteRef({ id: 'conversation-1', agentId: 'agent-a', provider: 'copilot' });
    const moved = chatRouteRef({ id: 'conversation-1', agentId: 'agent-b', provider: 'copilot' });
    expect(catalogKeyForRoute(first)).toBe('chat:conversation-1');
    expect(catalogKeyForRoute(moved)).toBe('chat:conversation-1');
    expect(yeaftCatalogKey('agent-a', 'same-id')).not.toBe(yeaftCatalogKey('agent-b', 'same-id'));
    expect(catalogKeyForRoute(yeaftRouteRef({ id: 'same-id', agentId: 'agent-b' }))).toBe('yeaft:agent-b:same-id');
    expect(normalizeChatRuntimeProvider(null)).toBe('claude-code');
    expect(normalizeChatRuntimeProvider('copilot')).toBe('copilot');
    expect(() => normalizeChatRuntimeProvider('unknown')).toThrow(/Unknown Chat runtime provider/);
    expect(() => chatCatalogKey('')).toThrow(/conversationId/);

    const orderFixture = ['a', 'b', 'c', 'd'].map((catalogKey, sortRank) => ({ catalogKey, sortRank }));
    expect(reorderSessionCatalogRows(orderFixture, 'd', 'b', 'before').map(row => row.catalogKey))
      .toEqual(['a', 'd', 'b', 'c']);
    expect(reorderSessionCatalogRows(orderFixture, 'a', 'c', 'after').map(row => row.catalogKey))
      .toEqual(['b', 'c', 'a', 'd']);
    expect(reorderSessionCatalogRows(orderFixture, 'b', null, 'append').map(row => row.catalogKey))
      .toEqual(['a', 'c', 'd', 'b']);
    expect(reorderSessionCatalogRows(orderFixture, 'missing', 'b', 'before')).toBeNull();
    expect(reorderSessionCatalogRows(orderFixture, 'b', 'missing', 'before')).toBeNull();
    const projectOrderFixture = ['project-a', 'project-b', 'project-c']
      .map((id, sortOrder) => ({ id, sortOrder }));
    expect(reorderProjectRows(projectOrderFixture, 'project-c', 'project-a', 'before').map(row => row.id))
      .toEqual(['project-c', 'project-a', 'project-b']);
    expect(reorderProjectRows(projectOrderFixture, 'project-a', 'project-c', 'after').map(row => row.id))
      .toEqual(['project-b', 'project-c', 'project-a']);
    expect(reorderProjectRows(projectOrderFixture, 'missing', 'project-a', 'before')).toBeNull();
    expect(UnifiedSessionList.computed.hasCompleteCatalogOrder.call({
      sessions: [{ sortRank: 0 }, { sortRank: 0 }],
    })).toBe(false);

    const previewTrigger = document.createElement('button');
    document.body.appendChild(previewTrigger);
    const previewOverlay = openImagePreview('/preview-a.png', {
      alt: 'First preview',
      closeLabel: 'Close preview',
      previousLabel: 'Previous preview',
      nextLabel: 'Next preview',
      positionLabel: (current, total) => `${current} / ${total}`,
      gallery: [
        { src: '/preview-a.png', alt: 'First preview' },
        { src: '/preview-b.png', alt: 'Second preview' },
        { src: '/preview-c.png', alt: 'Third preview' },
      ],
      initialIndex: 0,
      trigger: previewTrigger,
    });
    expect(previewOverlay.querySelector('.image-preview-img').getAttribute('src')).toBe('/preview-a.png');
    expect(previewOverlay.querySelector('.image-preview-position').textContent).toBe('1 / 3');
    previewOverlay.querySelector('.image-preview-next').click();
    expect(previewOverlay.querySelector('.image-preview-img').getAttribute('src')).toBe('/preview-b.png');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(previewOverlay.querySelector('.image-preview-img').getAttribute('src')).toBe('/preview-a.png');
    previewOverlay.querySelector('.image-preview-previous').click();
    expect(previewOverlay.querySelector('.image-preview-img').getAttribute('src')).toBe('/preview-c.png');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    previewOverlay.dispatchEvent(new Event('transitionend'));
    expect(document.body.querySelector('.image-preview-overlay')).toBeNull();
    expect(document.activeElement).toBe(previewTrigger);
    previewTrigger.remove();

    const previousImagePreviewStore = globalThis.Pinia.useChatStore;
    const previousGlobalVue = globalThis.Vue;
    globalThis.Pinia.useChatStore = useChatStore;
    globalThis.Vue = Vue;
    const userImageMessage = mount(MessageItem, {
      attachTo: document.body,
      props: {
        message: {
          type: 'user',
          attachments: [
            { isImage: true, preview: '/user-a.png', name: 'User A' },
            { isImage: true, preview: '/user-b.png', name: 'User B' },
            { isImage: false, name: 'notes.txt', mimeType: 'text/plain' },
          ],
        },
      },
      global: { mocks: { $t: key => key }, provide: { t: key => key } },
    });
    await userImageMessage.get('.attachments-badge').trigger('click');
    await userImageMessage.findAll('.user-attachment-item.is-image')[1].trigger('click');
    expect(document.body.querySelector('.image-preview-img').getAttribute('src')).toBe('/user-b.png');
    expect(document.body.querySelector('.image-preview-position').textContent).toBe('message.imagePosition');
    document.body.querySelector('.image-preview-close').click();
    document.body.querySelector('.image-preview-overlay').dispatchEvent(new Event('transitionend'));
    userImageMessage.unmount();

    const externalImage = {
      id: 'work-center-image', isImage: true, preview: '/work-center-image.png', name: 'Work Center image',
    };
    const externalFile = {
      id: 'work-center-file', isImage: false, name: 'work-center.txt', mimeType: 'text/plain',
    };
    const workCenterMessage = mount(MessageItem, {
      attachTo: document.body,
      props: {
        externalAttachmentOpen: true,
        message: { type: 'user', attachments: [externalImage, externalFile] },
      },
      global: { mocks: { $t: key => key }, provide: { t: key => key } },
    });
    await workCenterMessage.get('.attachments-badge').trigger('click');
    const externalAttachmentButtons = workCenterMessage.findAll('.user-attachment-item');
    await externalAttachmentButtons[0].trigger('click');
    await externalAttachmentButtons[1].trigger('click');
    expect(workCenterMessage.emitted('open-attachment')).toEqual([
      [expect.objectContaining({
        attachment: expect.objectContaining({ id: externalImage.id }),
        trigger: externalAttachmentButtons[0].element,
      })],
      [expect.objectContaining({
        attachment: expect.objectContaining({ id: externalFile.id }),
        trigger: externalAttachmentButtons[1].element,
      })],
    ]);
    expect(document.body.querySelector('.image-preview-overlay')).toBeNull();
    workCenterMessage.unmount();

    const assistantImages = mount(AssistantTurn, {
      attachTo: document.body,
      props: {
        turn: {
          imageMsgs: [
            { id: 'assistant-a', src: '/assistant-a.png', filename: 'Assistant A' },
            { id: 'assistant-b', src: '/assistant-b.png', filename: 'Assistant B' },
          ],
          textContent: '',
          toolMsgs: [],
        },
      },
      global: { mocks: { $t: key => key }, provide: { t: key => key } },
    });
    await assistantImages.findAll('.turn-image-item')[0].trigger('click');
    document.body.querySelector('.image-preview-next').click();
    expect(document.body.querySelector('.image-preview-img').getAttribute('src')).toBe('/assistant-b.png');
    document.body.querySelector('.image-preview-close').click();
    document.body.querySelector('.image-preview-overlay').dispatchEvent(new Event('transitionend'));
    assistantImages.unmount();
    if (previousImagePreviewStore) globalThis.Pinia.useChatStore = previousImagePreviewStore;
    else delete globalThis.Pinia.useChatStore;
    if (previousGlobalVue) globalThis.Vue = previousGlobalVue;
    else delete globalThis.Vue;

    localStorage.removeItem('yeaft-sidebar-section-collapse');
    const projectStore = {
      mutateProject: vi.fn(() => Promise.resolve({ ok: true })),
      reorderCatalogSessions: vi.fn(() => true),
    };
    const catalogRows = [
      {
        catalogKey: 'yeaft:user_1770305719:server-instance:pinned',
        runtimeProvider: 'yeaft',
        routeRef: { runtimeProvider: 'yeaft', agentId: 'user_1770305719:server-instance', sessionId: 'pinned' },
        title: 'Pinned',
        workDir: '/repo',
        pinned: true,
        availability: 'online',
        createdAt: '2026-07-29T10:00:00.000Z',
        metadataUpdatedAt: '2026-07-29T10:00:00.000Z',
      },
      {
        catalogKey: 'chat:offline',
        runtimeProvider: 'copilot',
        routeRef: { runtimeProvider: 'copilot', agentId: 'agent-b', sessionId: 'offline' },
        title: 'Offline',
        pinned: false,
        availability: 'offline',
      },
      {
        catalogKey: 'chat:visible',
        runtimeProvider: 'copilot',
        routeRef: { runtimeProvider: 'copilot', agentId: 'agent-a', sessionId: 'visible' },
        title: 'Visible',
        pinned: false,
        availability: 'online',
        createdAt: '2026-07-29T09:00:00.000Z',
        metadataUpdatedAt: '2026-07-29T09:00:00.000Z',
        updatedAt: '2026-07-31T23:00:00.000Z',
      },
      {
        catalogKey: 'chat:visible-2',
        runtimeProvider: 'copilot',
        routeRef: { runtimeProvider: 'copilot', agentId: 'agent-a', sessionId: 'visible-2' },
        title: 'Visible 2',
        pinned: false,
        availability: 'online',
        createdAt: '2026-07-29T08:00:00.000Z',
        metadataUpdatedAt: '2026-07-29T11:00:00.000Z',
      },
    ];
    const sidebar = mount(UnifiedSessionList, {
      attachTo: document.body,
      props: {
        sessions: [],
        activeRoute: { runtimeProvider: 'copilot', agentId: 'agent-a', sessionId: 'visible' },
        processingConversations: { visible: true },
        isYeaftSessionProcessing: (sessionId, agentId) => sessionId === 'pinned' && agentId === 'user_1770305719:server-instance',
        isSessionSyncing: row => row.catalogKey === 'chat:visible',
        isSessionUnread: row => row.catalogKey === 'chat:visible' || row.catalogKey.endsWith(':pinned'),
        workCenterOpen: true,
        agents: [
          { id: 'agent-a', name: 'Agent A', online: true },
          { id: 'user_1770305719:server-instance', name: 'server', online: true, capabilities: ['work_center'] },
          { id: 'agent-b', name: 'Agent B', online: false },
        ],
        projects: [
          {
            id: 'project-shared',
            name: 'Shared project',
            members: [
              { agentId: 'user_1770305719:server-instance', sessionId: 'pinned' },
              { agentId: 'agent-b', sessionId: 'offline' },
            ],
          },
          { id: 'project-empty', name: 'Empty project', members: [] },
        ],
      },
      global: { mocks: { $t: key => key } },
    });
    expect(sidebar.findAll('.sidebar-primary-actions')).toHaveLength(1);
    const createSessionButton = sidebar.get('.sidebar-primary-action');
    const createProjectButton = sidebar.get('.sidebar-project-add-button');
    expect(createSessionButton.text()).toBe('sidebar.sessions.newChat');
    expect(createSessionButton.attributes('aria-label')).toBe('sidebar.sessions.newChat');
    expect(createSessionButton.attributes('title')).toBe('sidebar.sessions.newChat');
    expect(createSessionButton.find('.sidebar-primary-action-icon').exists()).toBe(true);
    expect(createSessionButton.get('.sidebar-primary-action-frame').attributes('d')).toBe('M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7');
    expect(createSessionButton.get('.sidebar-primary-action-pen').attributes('d')).toBe('M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852Z');
    expect(createSessionButton.get('.sidebar-primary-action-frame').attributes('d')).not.toBe(createProjectButton.get('svg path').attributes('d'));
    expect(createProjectButton.attributes('aria-label')).toBe('sidebar.projects.new');
    expect(createProjectButton.attributes('title')).toBe('sidebar.projects.new');
    expect(createProjectButton.find('.sidebar-project-add-icon').exists()).toBe(true);
    expect(createProjectButton.get('.sidebar-project-add-mark').attributes('d')).toBe('M12 5v14M5 12h14');
    expect(enMessages['sidebar.sessions.newChat']).toBe('New chat');
    expect(zhCNMessages['sidebar.sessions.newChat']).toBe('新建聊天');
    expect(enMessages['sidebar.projects.newSession']).toBe('New Session in {name}');
    expect(zhCNMessages['sidebar.projects.newSession']).toBe('在{name}中创建 Session');
    expect(enMessages['sidebar.projects.assignFailed']).toContain('{message}');
    expect(zhCNMessages['sidebar.projects.assignFailed']).toContain('{message}');
    expect(sidebar.get('.sidebar-navigation').element.children[0].classList).toContain('sidebar-primary-actions');
    expect(sidebar.get('.sidebar-navigation').element.children[1].classList).toContain('sidebar-session-results');
    expect(sidebar.get('.sidebar-session-results').element.children[0].classList).toContain('projects-section');
    expect(sidebar.get('.sidebar-session-results').element.children[1].classList).toContain('recents-section');
    expect(sidebar.find('input[type="search"]').exists()).toBe(false);
    expect(sidebar.findAll('.sidebar-tool-button')).toHaveLength(2);
    const recentsCreate = sidebar.get('.recents-section .sidebar-recents-create');
    expect(recentsCreate.attributes('title')).toBe('sidebar.sessions.newChat');
    expect(recentsCreate.attributes('aria-label')).toBe('sidebar.sessions.newChat');
    expect(recentsCreate.get('.sidebar-recents-create-frame').attributes('d')).toBe(createSessionButton.get('.sidebar-primary-action-frame').attributes('d'));
    expect(recentsCreate.get('.sidebar-recents-create-pen').attributes('d')).toBe(createSessionButton.get('.sidebar-primary-action-pen').attributes('d'));
    expect(sidebar.findAll('.sidebar-section')).toHaveLength(2);
    const sectionToggles = sidebar.findAll('.sidebar-section-toggle');
    expect(sectionToggles).toHaveLength(2);
    expect(sectionToggles.map(button => button.attributes('aria-expanded'))).toEqual(['true', 'true']);
    expect(sectionToggles.every(button => (
      button.get('span').element.compareDocumentPosition(button.get('.sidebar-section-chevron').element)
      & Node.DOCUMENT_POSITION_FOLLOWING
    ))).toBe(true);
    await sectionToggles[0].trigger('click');
    expect(sidebar.get('.projects-section').classes()).toContain('is-collapsed');
    expect(sidebar.findAll('.sidebar-project')).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem('yeaft-sidebar-section-collapse'))).toMatchObject({ projects: true });
    await sectionToggles[0].trigger('click');
    expect(sidebar.findAll('.session-item')).toHaveLength(0);
    await sidebar.setProps({ sessions: catalogRows });
    expect(sidebar.findAll('.session-item')).toHaveLength(3);
    expect(sidebar.findAll('.session-item').some(item => item.text().includes('Offline'))).toBe(false);
    expect(sidebar.findAll('.sidebar-project')).toHaveLength(2);
    expect(sidebar.findAll('.sidebar-project-icon-open')).toHaveLength(2);
    expect(sidebar.findAll('.sidebar-project-icon-closed')).toHaveLength(0);
    expect(sidebar.findAll('.sidebar-project-icon-open').every(icon => icon.attributes('viewBox') === '0 0 20 24')).toBe(true);
    expect(sidebar.findAll('.sidebar-project-unread')).toHaveLength(1);
    expect(Object.fromEntries(sidebar.findAll('.sidebar-project').map(item => [
      item.get('.sidebar-project-toggle').text().replace(/\d+$/, ''),
      item.get('.sidebar-project-count').text(),
    ]))).toEqual({ 'Shared project': '1', 'Empty project': '0' });
    expect(sidebar.findAll('.sidebar-project').every(item => (
      item.get('.sidebar-project-name').element.compareDocumentPosition(item.get('.sidebar-project-count').element)
      & Node.DOCUMENT_POSITION_FOLLOWING
    ))).toBe(true);
    expect(sidebar.findAll('.sidebar-project-header .sidebar-project-session-create')).toHaveLength(2);
    const projectCreateSessionButton = sidebar.findAll('.sidebar-project-header .sidebar-project-session-create')[0];
    expect(projectCreateSessionButton.attributes('aria-label')).toBe('sidebar.projects.newSession');
    await projectCreateSessionButton.trigger('click');
    expect(sidebar.emitted('create-in-project').at(-1)[0]).toEqual({
      project: sidebar.props('projects')[0],
    });
    expect(sidebar.emitted('close-work-center')).toHaveLength(1);
    expect(sidebar.findAll('.sidebar-project-header .session-dots-btn')).toHaveLength(2);
    const projectMenuButton = sidebar.findAll('.sidebar-project-header .session-dots-btn')[0];
    expect(projectMenuButton.attributes('aria-label')).toBe('sidebar.projects.menu');
    projectMenuButton.element.focus();
    expect(document.activeElement).toBe(projectMenuButton.element);
    await projectMenuButton.trigger('click');
    expect([...document.body.querySelectorAll('.session-menu-item')].map(item => item.textContent))
      .toContain('sidebar.projects.instructions');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await Vue.nextTick();
    expect(document.body.querySelector('.session-menu-floating')).toBeNull();

    await sidebar.get('.sidebar-tool-button').trigger('click');
    const projectCreateInput = sidebar.get('.sidebar-project-create input');
    expect(document.activeElement).toBe(projectCreateInput.element);
    await projectCreateInput.setValue('   ');
    expect(sidebar.get('.sidebar-project-create-confirm').attributes('disabled')).toBeDefined();
    await sidebar.get('.sidebar-project-create').trigger('keydown', { key: 'Escape' });
    expect(sidebar.find('.sidebar-project-create').exists()).toBe(false);

    await sidebar.get('.sidebar-tool-button').trigger('click');
    await sidebar.get('.sidebar-project-create input').setValue('  Workspace  ');
    let finishCreate;
    const createResult = new Promise(resolve => { finishCreate = resolve; });
    const dispatchProjectAction = vi.fn(() => createResult);
    sidebar.vm.dispatchProjectAction = dispatchProjectAction;
    const firstCreate = sidebar.vm.submitProjectCreate();
    const duplicateCreate = sidebar.vm.submitProjectCreate();
    expect(dispatchProjectAction).toHaveBeenCalledTimes(1);
    expect(dispatchProjectAction).toHaveBeenCalledWith({
      action: 'create',
      name: 'Workspace',
    });
    finishCreate({ ok: true });
    await Promise.all([firstCreate, duplicateCreate]);
    await Vue.nextTick();
    expect(sidebar.find('.sidebar-project-create').exists()).toBe(false);

    dispatchProjectAction.mockClear();
    UnifiedSessionList.methods.editProjectInstruction.call(sidebar.vm, {
      id: 'project-shared',
      name: 'Shared project',
      instruction: 'Existing Project rule.',
    });
    await Vue.nextTick();
    const instructionModal = document.body.querySelector('.project-instruction-modal');
    expect(instructionModal).not.toBeNull();
    const instructionInput = instructionModal.querySelector('textarea');
    expect(instructionInput.value).toBe('Existing Project rule.');
    instructionInput.value = 'Updated Project rule.';
    instructionInput.dispatchEvent(new Event('input', { bubbles: true }));
    instructionModal.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Vue.nextTick();
    await Promise.resolve();
    expect(dispatchProjectAction).toHaveBeenCalledWith({
      action: 'update-instruction',
      project: {
        id: 'project-shared',
        name: 'Shared project',
        instruction: 'Existing Project rule.',
      },
      instruction: 'Updated Project rule.',
    });
    expect(document.body.querySelector('.project-instruction-modal')).toBeNull();
    sidebar.vm.dispatchProjectAction = UnifiedSessionList.methods.dispatchProjectAction.bind(sidebar.vm);

    const projectToggles = sidebar.findAll('.sidebar-project-toggle');
    await projectToggles[0].trigger('click');
    expect(sidebar.findAll('.sidebar-project-sessions')).toHaveLength(1);
    expect(sidebar.findAll('.sidebar-project-icon-open')).toHaveLength(1);
    expect(sidebar.findAll('.sidebar-project-icon-closed')).toHaveLength(1);
    expect(sidebar.findAll('.sidebar-project-unread')).toHaveLength(1);
    expect(Object.fromEntries(sidebar.findAll('.sidebar-project').map(item => [
      item.get('.sidebar-project-toggle').text().replace(/\d+$/, ''),
      item.get('.sidebar-project-count').text(),
    ]))).toEqual({ 'Shared project': '1', 'Empty project': '0' });
    await projectToggles[0].trigger('click');
    expect(sidebar.get('.session-dots-btn svg path').attributes('d')).toContain('M6 10');
    expect(sidebar.text()).toContain('Visible');
    expect(sidebar.text()).toContain('Pinned');
    expect(sidebar.findAll('.session-item').map(item => item.get('.sidebar-session-title-text').text())).toEqual(['Pinned', 'Visible 2', 'Visible']);
    await sectionToggles[1].trigger('click');
    expect(sidebar.get('.recents-section').classes()).toContain('is-collapsed');
    expect(sidebar.findAll('.recents-section .session-item')).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem('yeaft-sidebar-section-collapse'))).toMatchObject({ recents: true });
    await sectionToggles[1].trigger('click');
    const visibleRow = sidebar.findAll('.recents-section .session-item')
      .find(item => item.text().includes('Visible') && !item.text().includes('Visible 2'));
    const visibleTwoRow = sidebar.findAll('.recents-section .session-item')
      .find(item => item.text().includes('Visible 2'));
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn() };
    await visibleRow.trigger('dragstart', { dataTransfer });
    expect(dataTransfer.effectAllowed).toBe('move');
    Object.defineProperty(visibleTwoRow.element, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 100, bottom: 134, height: 34 }),
    });
    await visibleTwoRow.trigger('dragover', { dataTransfer, clientY: 101 });
    expect(visibleTwoRow.classes()).toContain('drag-before');
    await visibleTwoRow.trigger('drop', { dataTransfer, clientY: 101 });
    expect(sidebar.emitted('action').at(-1)[0]).toMatchObject({
      action: 'reorder',
      row: { catalogKey: 'chat:visible' },
    });
    expect(sidebar.emitted('action').at(-1)[0].sessions.map(row => row.catalogKey)).toEqual([
      'yeaft:user_1770305719:server-instance:pinned',
      'chat:visible',
      'chat:visible-2',
      'chat:offline',
    ]);
    const rejectedProjectDrag = { effectAllowed: '', setData: vi.fn() };
    sidebar.vm.startDrag(catalogRows[2], { dataTransfer: rejectedProjectDrag });
    expect(sidebar.vm.draggedRow?.catalogKey).toBe('chat:visible');
    const rejectedProjectDrop = { preventDefault: vi.fn(), stopPropagation: vi.fn(), dataTransfer: rejectedProjectDrag };
    sidebar.vm.dragOverRow(catalogRows[0], sidebar.props('projects')[0], rejectedProjectDrop);
    expect(rejectedProjectDrop.preventDefault).not.toHaveBeenCalled();
    sidebar.vm.finishDrag();

    projectStore.mutateProject.mockClear();
    await sidebar.setProps({ projectStore });
    const projectHeaders = sidebar.findAll('.sidebar-project-header');
    expect(projectHeaders.map(header => header.attributes('draggable'))).toEqual(['true', 'true']);
    const projectDataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn() };
    await projectHeaders[1].trigger('dragstart', { dataTransfer: projectDataTransfer });
    expect(projectDataTransfer.effectAllowed).toBe('move');
    Object.defineProperty(projectHeaders[0].element, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 100, bottom: 134, height: 34 }),
    });
    await projectHeaders[0].trigger('dragover', { dataTransfer: projectDataTransfer, clientY: 101 });
    expect(projectHeaders[0].classes()).toContain('project-drag-before');
    await projectHeaders[0].trigger('drop', { dataTransfer: projectDataTransfer, clientY: 101 });
    await Promise.resolve();
    expect(projectStore.mutateProject).toHaveBeenLastCalledWith('reorder', {
      projectIds: ['project-empty', 'project-shared'],
    });
    await sidebar.setProps({ projectStore: null });

    const projectDragRows = [
      {
        catalogKey: 'yeaft:user_1770305719:server-instance:project-first',
        runtimeProvider: 'yeaft',
        routeRef: { runtimeProvider: 'yeaft', agentId: 'user_1770305719:server-instance', sessionId: 'project-first' },
        title: 'Project first',
        pinned: false,
        availability: 'online',
        sortRank: 0,
      },
      {
        catalogKey: 'yeaft:user_1770305719:server-instance:project-second',
        runtimeProvider: 'yeaft',
        routeRef: { runtimeProvider: 'yeaft', agentId: 'user_1770305719:server-instance', sessionId: 'project-second' },
        title: 'Project second',
        pinned: false,
        availability: 'online',
        sortRank: 1,
      },
      {
        catalogKey: 'yeaft:user_1770305719:server-instance:recent-yeaft',
        runtimeProvider: 'yeaft',
        routeRef: { runtimeProvider: 'yeaft', agentId: 'user_1770305719:server-instance', sessionId: 'recent-yeaft' },
        title: 'Recent Yeaft',
        pinned: false,
        availability: 'online',
        sortRank: 2,
      },
    ];
    await sidebar.setProps({
      sessions: projectDragRows,
      projects: [{
        id: 'project-shared',
        name: 'Shared project',
        members: [
          { agentId: 'user_1770305719:server-instance', sessionId: 'project-first' },
          { agentId: 'user_1770305719:server-instance', sessionId: 'project-second' },
        ],
      }],
    });
    const projectFirst = sidebar.findAll('.sidebar-project-sessions .session-item')
      .find(item => item.text().includes('Project first'));
    const projectSecond = sidebar.findAll('.sidebar-project-sessions .session-item')
      .find(item => item.text().includes('Project second'));
    await projectSecond.trigger('dragstart', { dataTransfer });
    Object.defineProperty(projectFirst.element, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 100, bottom: 134, height: 34 }),
    });
    await projectFirst.trigger('dragover', { dataTransfer, clientY: 101 });
    await projectFirst.trigger('drop', { dataTransfer, clientY: 101 });
    expect(sidebar.emitted('action').at(-1)[0].sessions.map(row => row.catalogKey)).toEqual([
      'yeaft:user_1770305719:server-instance:project-second',
      'yeaft:user_1770305719:server-instance:project-first',
      'yeaft:user_1770305719:server-instance:recent-yeaft',
    ]);

    const legacyProject = {
      id: 'user_1770305719:server-instance\u001flegacy-project',
      legacyProjectId: 'legacy-project',
      legacyAgentId: 'user_1770305719:server-instance',
      name: 'Legacy project',
      members: [
        { agentId: 'user_1770305719:server-instance', sessionId: 'project-first' },
        { agentId: 'user_1770305719:server-instance', sessionId: 'project-second' },
      ],
    };
    await sidebar.setProps({ projects: [legacyProject] });
    expect(sidebar.vm.canDragProject(legacyProject)).toBe(false);
    expect(sidebar.find('.sidebar-project-header').attributes('draggable')).toBe('false');
    expect(sidebar.vm.canDragRow(projectDragRows[0], legacyProject)).toBe(true);
    expect(sidebar.vm.canDropRow(projectDragRows[0], legacyProject)).toBe(true);

    projectStore.mutateProject.mockClear();
    projectStore.reorderCatalogSessions.mockClear();
    await sidebar.setProps({
      sessions: projectDragRows.map(row => ({ ...row })),
      projects: [{
        id: 'project-shared',
        name: 'Shared project',
        members: [
          { agentId: 'user_1770305719:server-instance', sessionId: 'project-first' },
          { agentId: 'user_1770305719:server-instance', sessionId: 'project-second' },
        ],
      }],
      projectStore,
    });
    expect(sidebar.vm.resolvedProjectStore.mutateProject).toBe(projectStore.mutateProject);
    expect(sidebar.vm.dragOperationPending).toBe(false);
    const recentYeaft = sidebar.get('.recents-section .session-item');
    const currentProjectSecond = sidebar.findAll('.sidebar-project-sessions .session-item')
      .find(item => item.text().includes('Project second'));
    Object.defineProperty(currentProjectSecond.element, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 100, bottom: 134, height: 34 }),
    });
    await recentYeaft.trigger('dragstart', { dataTransfer });
    expect(sidebar.vm.draggedRow?.catalogKey).toBe('yeaft:user_1770305719:server-instance:recent-yeaft');
    await currentProjectSecond.trigger('dragover', { dataTransfer, clientY: 101 });
    expect(sidebar.vm.dragTargetRowKey).toBe('yeaft:user_1770305719:server-instance:project-second');
    await currentProjectSecond.trigger('drop', { dataTransfer, clientY: 101 });
    expect(projectStore.mutateProject).toHaveBeenLastCalledWith('move_session', {
      sessionId: 'recent-yeaft',
      projectId: 'project-shared',
      catalogOrder: [
        expect.objectContaining({ catalogKey: 'yeaft:user_1770305719:server-instance:project-first' }),
        expect.objectContaining({ catalogKey: 'yeaft:user_1770305719:server-instance:recent-yeaft' }),
        expect.objectContaining({ catalogKey: 'yeaft:user_1770305719:server-instance:project-second' }),
      ],
    }, 'user_1770305719:server-instance');
    expect(projectStore.reorderCatalogSessions).not.toHaveBeenCalled();

    projectStore.mutateProject.mockResolvedValueOnce({ ok: false });
    const currentProjectFirst = sidebar.findAll('.sidebar-project-sessions .session-item')
      .find(item => item.text().includes('Project first'));
    await currentProjectFirst.trigger('dragstart', { dataTransfer });
    await sidebar.get('.recents-section').trigger('drop', { dataTransfer });
    expect(projectStore.mutateProject).toHaveBeenLastCalledWith('move_session', {
      sessionId: 'project-first',
      projectId: null,
      catalogOrder: expect.any(Array),
    }, 'user_1770305719:server-instance');
    expect(projectStore.reorderCatalogSessions).not.toHaveBeenCalled();
    await sidebar.setProps({ projectStore: null, sessions: catalogRows, projects: [
      {
        id: 'project-shared',
        name: 'Shared project',
        members: [
          { agentId: 'user_1770305719:server-instance', sessionId: 'pinned' },
          { agentId: 'agent-b', sessionId: 'offline' },
        ],
      },
      { id: 'project-empty', name: 'Empty project', members: [] },
    ] });
    expect(sidebar.findAll('.session-item.processing')).toHaveLength(2);
    expect(sidebar.findAll('.processing-dot')).toHaveLength(2);
    expect(sidebar.findAll('.sidebar-session-syncing')).toHaveLength(0);
    expect(sidebar.findAll('.session-pin-icon')).toHaveLength(1);
    expect(sidebar.findAll('.sidebar-session-meta')).toHaveLength(0);
    expect(sidebar.findAll('.sidebar-session-unread')).toHaveLength(3);
    expect(sidebar.find('.sidebar-project-unread').exists()).toBe(true);
    expect(sidebar.find('.session-item.active').text()).toContain('Visible');
    await sidebar.setProps({
      activeRoute: {
        runtimeProvider: 'yeaft',
        agentId: 'user_1770305719:server-instance',
        sessionId: 'pinned',
      },
    });
    expect(sidebar.findAll('.session-item')).toHaveLength(3);
    const firstRow = sidebar.findAll('.session-item')[0];
    expect(firstRow.get('.sidebar-session-copy').text()).toContain('Pinned');
    expect(firstRow.get('.sidebar-session-copy').text()).not.toContain('server');
    expect(firstRow.attributes('role')).toBe('button');
    expect(firstRow.attributes('tabindex')).toBe('0');
    expect(UnifiedSessionList.methods.providerLabel({ runtimeProvider: 'claude-code' })).toBe('Claude');
    expect(sidebar.text()).not.toContain('user_1770305719');
    expect(sidebar.findAll('.sidebar-project-header .session-dots-btn')).toHaveLength(2);
    expect(sidebar.findAll('.session-item .session-dots-btn')).toHaveLength(3);
    expect(sidebar.findAll('.session-item .session-quick-action')).toHaveLength(6);
    expect(sidebar.findAll('.session-remove-icon')).toHaveLength(3);
    expect(sidebar.findAll('.session-remove-icon path').every(path => path.attributes('d').includes('m3 0-1 13'))).toBe(true);
    expect(sidebar.get('.sidebar-session-results').attributes('class')).toContain('sidebar-session-results');
    const pinnedQuickActions = firstRow.findAll('.session-quick-action');
    expect(pinnedQuickActions.map(button => button.attributes('aria-label'))).toEqual([
      'chat.sidebar.unpin',
      'sidebar.sessions.remove',
    ]);
    const selectCountBeforeQuickActions = sidebar.emitted('select')?.length || 0;
    firstRow.element.focus();
    expect(document.activeElement).toBe(firstRow.element);
    await firstRow.trigger('click');
    expect(document.activeElement).not.toBe(firstRow.element);
    expect(firstRow.classes()).toContain('actions-suppressed');
    expect(sidebar.emitted('select')).toHaveLength(selectCountBeforeQuickActions + 1);
    await firstRow.trigger('pointerleave');
    expect(firstRow.classes()).not.toContain('actions-suppressed');
    firstRow.element.focus();
    await firstRow.trigger('keydown', { key: 'Enter' });
    expect(firstRow.classes()).not.toContain('actions-suppressed');
    expect(document.activeElement).toBe(firstRow.element);
    await firstRow.trigger('keydown', { key: ' ' });
    expect(firstRow.classes()).not.toContain('actions-suppressed');
    expect(document.activeElement).toBe(firstRow.element);
    pinnedQuickActions[0].element.focus();
    expect(document.activeElement).toBe(pinnedQuickActions[0].element);
    const selectCountAfterRowClick = sidebar.emitted('select').length;
    await pinnedQuickActions[0].trigger('click');
    expect(sidebar.emitted('select')?.length || 0).toBe(selectCountAfterRowClick);
    expect(sidebar.emitted('action').at(-1)[0]).toMatchObject({
      action: 'pin',
      row: { catalogKey: 'yeaft:user_1770305719:server-instance:pinned' },
    });
    await pinnedQuickActions[1].trigger('click');
    expect(sidebar.emitted('select')?.length || 0).toBe(selectCountAfterRowClick);
    expect(sidebar.emitted('action').at(-1)[0]).toMatchObject({
      action: 'remove',
      row: { catalogKey: 'yeaft:user_1770305719:server-instance:pinned' },
    });
    const selectCountBeforeSettingsKeyboard = sidebar.emitted('select')?.length || 0;
    const pinnedSettingsButton = firstRow.get('.session-dots-btn');
    await pinnedSettingsButton.trigger('keydown', { key: 'Enter' });
    expect(sidebar.emitted('select')?.length || 0).toBe(selectCountBeforeSettingsKeyboard);
    expect(document.body.querySelector('.session-menu-floating')).toBeNull();
    Object.defineProperty(pinnedSettingsButton.element, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 740, bottom: 764, left: 980, right: 1004, width: 24, height: 24 }),
    });
    await pinnedSettingsButton.trigger('click');
    const teleportedMenu = document.body.querySelector('.session-menu-floating');
    expect(teleportedMenu).not.toBeNull();
    expect(sidebar.find('.session-menu').exists()).toBe(false);
    expect(document.body.querySelectorAll('.session-menu-floating')).toHaveLength(1);
    await pinnedSettingsButton.trigger('keydown', { key: ' ' });
    expect(sidebar.emitted('select')?.length || 0).toBe(selectCountBeforeSettingsKeyboard);
    expect(document.body.querySelector('.session-menu-floating')).not.toBeNull();
    const runtimeFooter = document.body.querySelector('.sidebar-session-menu-info');
    expect(runtimeFooter.textContent).toContain('server');
    expect(runtimeFooter.textContent).toContain('Yeaft');
    expect(runtimeFooter.querySelectorAll('strong')).toHaveLength(2);
    expect(runtimeFooter.querySelectorAll('span')).toHaveLength(0);
    expect(runtimeFooter.textContent).not.toContain('sidebar.sessions.agent');
    expect(runtimeFooter.textContent).not.toContain('sidebar.sessions.provider');
    expect(sidebar.find('.sidebar-session-menu-divider').exists()).toBe(false);
    const mainMenuLabels = [...document.body.querySelectorAll('.session-menu-item')]
      .map(item => item.textContent);
    expect(mainMenuLabels.some(label => label.includes('sidebar.projects.moveMenu'))).toBe(true);
    expect(mainMenuLabels).not.toContain('chat.sidebar.unpin');
    expect(mainMenuLabels).not.toContain('common.delete');
    expect(mainMenuLabels).not.toContain('Shared project');
    expect(mainMenuLabels).not.toContain('Empty project');
    const moveMenuAction = [...document.body.querySelectorAll('.session-menu-item')]
      .find(item => item.textContent.includes('sidebar.projects.moveMenu'));
    moveMenuAction.click();
    await Vue.nextTick();
    expect(document.body.querySelectorAll('.session-menu-floating')).toHaveLength(2);
    expect(document.body.querySelector('.session-menu-parent').getAttribute('aria-expanded')).toBe('true');
    expect(document.body.querySelector('.sidebar-session-menu-info')).toBe(runtimeFooter);
    const projectMenuLabels = [...document.body.querySelectorAll('.session-submenu .session-menu-item')]
      .map(item => item.textContent);
    expect(projectMenuLabels).toContain('Empty project');
    expect(projectMenuLabels).not.toContain('Shared project');
    expect([...document.body.querySelectorAll('.session-menu-floating:not(.session-submenu) .session-menu-item')]
      .map(item => item.textContent)).toContain('yeaft.session.openSettings');
    moveMenuAction.click();
    await Vue.nextTick();
    expect(document.body.querySelector('.session-submenu')).toBeNull();
    expect(document.body.querySelector('.session-menu-parent').getAttribute('aria-expanded')).toBe('false');
    const settingsAction = [...document.body.querySelectorAll('.session-menu-item')]
      .find(item => item.textContent === 'yeaft.session.openSettings');
    expect(settingsAction).toBeTruthy();
    settingsAction.click();
    await Vue.nextTick();
    expect(sidebar.emitted('action').at(-1)[0]).toMatchObject({
      action: 'settings',
      row: { catalogKey: 'yeaft:user_1770305719:server-instance:pinned' },
    });
    await sidebar.get('.sidebar-project-toggle').trigger('click');
    expect(sidebar.findAll('.recents-section .session-item').some(item => item.text().includes('Pinned'))).toBe(false);
    expect(sidebar.findAll('.recents-section .session-item').map(item => item.text())).toEqual([
      expect.stringContaining('Visible 2'),
      expect.stringContaining('Visible'),
    ]);
    await recentsCreate.trigger('click');
    expect(sidebar.emitted('close-work-center').at(-1)).toEqual([]);
    expect(sidebar.emitted('create').at(-1)).toEqual([]);
    const createCountAfterRecents = sidebar.emitted('create').length;
    await sidebar.get('.sidebar-primary-action').trigger('click');
    expect(sidebar.emitted('close-work-center').at(-1)).toEqual([]);
    expect(sidebar.emitted('create')).toHaveLength(createCountAfterRecents + 1);
    const offlineRow = sidebar.findAll('.session-item').find(item => item.text().includes('Offline'));
    expect(offlineRow).toBeUndefined();
    await sidebar.setProps({
      sessions: [catalogRows[0]],
      agents: [{ id: 'agent-a', name: 'Agent A', online: true }],
    });
    expect(sidebar.findAll('.session-item')).toHaveLength(0);
    await sidebar.setProps({
      sessions: [catalogRows[0]],
      agents: [{ id: 'user_1770305719:server-instance', name: 'server', online: false }],
    });
    expect(sidebar.findAll('.session-item')).toHaveLength(0);
    expect(sidebar.findAll('.sidebar-project-unread')).toHaveLength(1);
    await sidebar.setProps({
      sessions: [{ ...catalogRows[0], availability: 'offline' }],
      agents: [{ id: 'user_1770305719:server-instance', name: 'server', online: true }],
    });
    expect(sidebar.findAll('.session-item')).toHaveLength(0);
    expect(sidebar.findAll('.sidebar-project-unread')).toHaveLength(1);
    await sidebar.setProps({
      sessions: catalogRows,
      agents: [
        { id: 'agent-a', name: 'Agent A', online: true },
        { id: 'user_1770305719:server-instance', name: 'server', online: true, capabilities: ['work_center'] },
        { id: 'agent-b', name: 'Agent B', online: false },
      ],
    });
    globalThis.Vue = Vue;
    const dialogModule = await import('../../web/utils/dialog.js');
    const { default: AppDialog } = await import('../../web/components/AppDialog.js');
    const dialog = mount(AppDialog, {
      attachTo: document.body,
      global: { mocks: { $t: key => ({ 'common.confirm': 'OK', 'common.cancel': 'Cancel' })[key] || key } },
    });
    const dialogElement = selector => document.body.querySelector(selector);
    const renamePromise = UnifiedSessionList.methods.renameProject.call(sidebar.vm, { id: 'project-shared', name: 'Shared project' });
    await Vue.nextTick();
    expect(dialogElement('.app-dialog-input').value).toBe('Shared project');
    dialogElement('.app-dialog-confirm').click();
    await renamePromise;
    const deletePromise = UnifiedSessionList.methods.deleteProject.call(sidebar.vm, { id: 'project-shared', name: 'Shared project' });
    await Vue.nextTick();
    expect(dialogElement('.app-dialog-body').textContent).toContain('sidebar.projects.deleteConfirm');
    dialogElement('.btn-secondary').click();
    await deletePromise;
    await sidebar.setProps({ processingConversations: {}, isYeaftSessionProcessing: () => false });
    expect(sidebar.findAll('.processing-dot')).toHaveLength(0);
    expect(UnifiedSessionList.template).toContain(':key="row.catalogKey"');
    expect(UnifiedSessionList.emits).toContain('project-action');
    expect(UnifiedSessionList.template).toContain('sidebar-project-header');
    expect(UnifiedSessionList.template).toContain("runAction('pin', row)");
    expect(UnifiedSessionList.template).toContain("runAction('delete', row)");
    expect(UnifiedSessionList.template).not.toContain("runAction('pin', floatingMenu.row)");
    expect(UnifiedSessionList.template).not.toContain("runAction('delete', floatingMenu.row)");
    expect(UnifiedSessionList.template).toContain("runAction('settings', floatingMenu.row)");
    expect(UnifiedSessionList.template).toContain("moveRow(floatingMenu.row, project)");
    expect(UnifiedSessionList.template).toContain('session-submenu');
    expect(UnifiedSessionList.template).not.toContain("floatingMenu.page === 'projects'");
    expect(UnifiedSessionList.template).toContain('sidebar.projects.moveMenu');
    expect(UnifiedSessionList.template).toContain('project-instruction-modal');
    expect(UnifiedSessionList.template).toContain('sidebar-primary-actions');
    expect(UnifiedSessionList.template).toContain('projects-section');
    expect(UnifiedSessionList.template).toContain('recents-section');
    expect(UnifiedSessionList.template).not.toContain('sidebar-session-menu-divider');
    expect(UnifiedSessionList.template).not.toContain('sidebar-session-meta');
    expect(UnifiedSessionList.template).toContain('processing-dot');
    const bottomRightMenu = calculateFloatingMenuPosition(
      { top: 740, bottom: 764, left: 980, right: 1004 },
      { width: 220, height: 240 },
      { width: 1024, height: 768 },
    );
    expect(bottomRightMenu).toEqual({
      top: 496,
      left: 784,
      width: 220,
      maxHeight: 240,
      placement: 'above',
    });
    const leftCollisionMenu = calculateFloatingMenuPosition(
      { top: 20, bottom: 44, left: -20, right: 4 },
      { width: 220, height: 80 },
      { width: 200, height: 300 },
    );
    expect(leftCollisionMenu.left).toBe(8);
    expect(leftCollisionMenu.width).toBe(184);
    expect(calculateFloatingSubmenuPosition(
      { top: 120, bottom: 260, left: 300, right: 480 },
      { width: 180, height: 160 },
      { width: 900, height: 700 },
    )).toEqual({ top: 120, left: 484, width: 180, maxHeight: 160, placement: 'right' });
    expect(calculateFloatingSubmenuPosition(
      { top: 620, bottom: 760, left: 700, right: 880 },
      { width: 180, height: 160 },
      { width: 900, height: 700 },
    )).toEqual({ top: 532, left: 516, width: 180, maxHeight: 160, placement: 'left' });
    const documentAdd = vi.spyOn(document, 'addEventListener');
    const documentRemove = vi.spyOn(document, 'removeEventListener');
    const windowAdd = vi.spyOn(window, 'addEventListener');
    const windowRemove = vi.spyOn(window, 'removeEventListener');
    sidebar.unmount();
    localStorage.setItem('yeaft-sidebar-section-collapse', JSON.stringify({ projects: true, recents: false }));
    const lifecycleSidebar = mount(UnifiedSessionList, {
      attachTo: document.body,
      props: { sessions: catalogRows, agents: [{ id: 'agent-a', online: true }] },
      global: { mocks: { $t: key => key } },
    });
    expect(documentAdd).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
    expect(documentAdd).toHaveBeenCalledWith('keydown', expect.any(Function));
    expect(windowAdd).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(windowAdd).toHaveBeenCalledWith('scroll', expect.any(Function), true);
    expect(lifecycleSidebar.findAll('.sidebar-section-toggle').map(button => button.attributes('aria-expanded')))
      .toEqual(['false', 'true']);
    await lifecycleSidebar.find('.session-dots-btn').trigger('click');
    expect(document.body.querySelector('.session-menu-floating')).not.toBeNull();
    expect(lifecycleSidebar.find('.session-menu').exists()).toBe(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await Vue.nextTick();
    expect(document.body.querySelector('.session-menu-floating')).toBeNull();
    lifecycleSidebar.unmount();
    localStorage.removeItem('yeaft-sidebar-section-collapse');
    expect(documentRemove).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
    expect(documentRemove).toHaveBeenCalledWith('keydown', expect.any(Function));
    expect(windowRemove).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(windowRemove).toHaveBeenCalledWith('scroll', expect.any(Function), true);
    documentAdd.mockRestore();
    documentRemove.mockRestore();
    windowAdd.mockRestore();
    windowRemove.mockRestore();

    const legacyProjectStore = useChatStore();
    const agentASession = {
      catalogKey: 'yeaft:agent-a:session-a',
      runtimeProvider: 'yeaft',
      routeRef: { runtimeProvider: 'yeaft', agentId: 'agent-a', sessionId: 'session-a' },
      title: 'Agent A session',
      availability: 'online',
    };
    const agentBSession = {
      catalogKey: 'yeaft:agent-b:session-b',
      runtimeProvider: 'yeaft',
      routeRef: { runtimeProvider: 'yeaft', agentId: 'agent-b', sessionId: 'session-b' },
      title: 'Agent B session',
      availability: 'online',
    };
    legacyProjectStore.sessionCatalog = [agentASession, agentBSession];
    legacyProjectStore.sessionProjects = [];
    legacyProjectStore.applyLegacyProjectSnapshot([{
      id: 'legacy-a',
      name: 'Agent A legacy',
      sessionIds: [],
    }], 'agent-a');
    legacyProjectStore.applyLegacyProjectSnapshot([{
      id: 'legacy-b',
      name: 'Agent B legacy',
      sessionIds: [],
    }], 'agent-b');
    legacyProjectStore.applySessionCatalogSnapshot(legacyProjectStore.sessionCatalog, [
      ...legacyProjectStore.sessionProjects,
      { id: 'server-project', name: 'Server project', members: [] },
    ]);
    const mutateProject = vi.fn(() => Promise.resolve({ ok: true }));
    legacyProjectStore.mutateProject = mutateProject;
    const previousUseChatStore = globalThis.Pinia.useChatStore;
    globalThis.Pinia.useChatStore = () => legacyProjectStore;
    const compatibilitySidebar = mount(UnifiedSessionList, {
      attachTo: document.body,
      props: {
        sessions: [agentASession, agentBSession],
        agents: [
          { id: 'agent-a', online: true },
          { id: 'agent-b', online: true },
        ],
      },
      global: {
        mocks: {
          $t: (key, values) => values?.name ? `${key}:${values.name}` : key,
        },
      },
    });
    const agentARow = compatibilitySidebar.findAll('.recents-section .session-item')
      .find(item => item.text().includes('Agent A session'));
    expect(agentARow).toBeTruthy();
    const agentAMenuButton = agentARow.get('.session-dots-btn');
    Object.defineProperty(agentAMenuButton.element, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 20, bottom: 44, left: 180, right: 204, width: 24, height: 24 }),
    });
    await agentAMenuButton.trigger('click');
    const primaryMenuTargets = [...document.body.querySelectorAll('.session-menu-floating .session-menu-item')]
      .map(item => item.textContent);
    expect(primaryMenuTargets.some(label => label.includes('sidebar.projects.moveMenu'))).toBe(true);
    expect(primaryMenuTargets).not.toContain('Agent A legacy');
    expect(primaryMenuTargets).not.toContain('Server project');
    const moveToProjects = [...document.body.querySelectorAll('.session-menu-floating .session-menu-item')]
      .find(item => item.textContent.includes('sidebar.projects.moveMenu'));
    moveToProjects.click();
    await Vue.nextTick();
    const moveTargets = [...document.body.querySelectorAll('.session-menu-floating .session-menu-item')]
      .map(item => item.textContent);
    expect(moveTargets).toContain('Agent A legacy');
    expect(moveTargets).toContain('Server project');
    expect(moveTargets).not.toContain('Agent B legacy');

    const agentALegacyProject = legacyProjectStore.sessionProjects
      .find(project => project.legacyAgentId === 'agent-a');
    const agentBLegacyProject = legacyProjectStore.sessionProjects
      .find(project => project.legacyAgentId === 'agent-b');
    const serverProject = legacyProjectStore.sessionProjects
      .find(project => project.id === 'server-project');
    expect(compatibilitySidebar.vm.projectMoveTargets(agentASession).map(project => project.id)).toEqual([
      agentALegacyProject.id,
      serverProject.id,
    ]);
    const emittedBeforeRejectedMoves = compatibilitySidebar.emitted('project-action')?.length || 0;
    expect(compatibilitySidebar.vm.moveRow(agentASession, agentBLegacyProject)).toBe(false);
    expect(compatibilitySidebar.vm.dispatchProjectAction({
      action: 'move-session',
      row: agentASession,
      project: agentBLegacyProject,
    })).toBe(false);
    expect(mutateProject).not.toHaveBeenCalled();
    expect(compatibilitySidebar.emitted('project-action')?.length || 0).toBe(emittedBeforeRejectedMoves);

    compatibilitySidebar.vm.draggedRow = agentASession;
    compatibilitySidebar.vm.dragTargetProjectId = agentALegacyProject.id;
    const rejectedDragOver = { preventDefault: vi.fn(), dataTransfer: { dropEffect: 'none' } };
    compatibilitySidebar.vm.dragOverProject(agentBLegacyProject, rejectedDragOver);
    expect(rejectedDragOver.preventDefault).not.toHaveBeenCalled();
    expect(compatibilitySidebar.vm.dragTargetProjectId).toBeNull();
    const rejectedDrop = { preventDefault: vi.fn() };
    compatibilitySidebar.vm.dropOnProject(agentBLegacyProject, rejectedDrop);
    expect(rejectedDrop.preventDefault).toHaveBeenCalledOnce();
    expect(mutateProject).not.toHaveBeenCalled();
    expect(compatibilitySidebar.vm.draggedRow).toBeNull();

    await compatibilitySidebar.vm.moveRow(agentASession, agentALegacyProject);
    expect(mutateProject).toHaveBeenLastCalledWith('move_session', {
      sessionId: 'session-a',
      projectId: 'legacy-a',
    }, 'agent-a');
    await compatibilitySidebar.vm.moveRow(agentASession, serverProject);
    expect(mutateProject).toHaveBeenLastCalledWith('move_session', {
      sessionId: 'session-a',
      projectId: 'server-project',
    }, 'agent-a');
    expect(mutateProject).toHaveBeenCalledTimes(2);
    compatibilitySidebar.unmount();
    if (previousUseChatStore) globalThis.Pinia.useChatStore = previousUseChatStore;
    else delete globalThis.Pinia.useChatStore;
    storeFactories.delete('chat');

    const fallbackWorkCenter = mount(SidebarWorkCenter, {
      props: { agents: [] },
      global: { mocks: { $t: key => key } },
    });
    expect(fallbackWorkCenter.get('.sidebar-work-center-trigger').attributes('disabled')).toBeDefined();
    expect(fallbackWorkCenter.get('.sidebar-work-center-icon path').attributes('d'))
      .toBe('M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm2 5v2h10V8H7zm0 4v2h7v-2H7zm0 4v2h5v-2H7z');
    expect(component).not.toContain('M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm2 5v2h10V8H7zm0 4v2h7v-2H7zm0 4v2h5v-2H7z');
    await fallbackWorkCenter.get('.sidebar-work-center-trigger').trigger('click');
    expect(fallbackWorkCenter.emitted('open')).toBeUndefined();
    fallbackWorkCenter.unmount();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ version: '' }) }));
    const parentStore = Vue.reactive({
      sessionSidebarOpen: false,
      sidebarCollapsed: false,
      isSplitMode: false,
      workbenchExpanded: false,
      runningSubagentCount: 0,
      connectionState: 'connected',
      sessionCatalogLoaded: true,
      sessionCatalog: catalogRows,
      activeSessionRoute: { runtimeProvider: 'copilot', agentId: 'agent-a', sessionId: 'visible' },
      processingConversations: {},
      isYeaftSessionProcessing: () => false,
      isYeaftSessionUnread: () => false,
      agents: [{ id: 'agent-a', name: 'Agent A', online: true, capabilities: ['work_center'] }],
      workCenterOpen: false,
      workCenterAgentId: 'stale-agent',
      sessionProjects: [{ id: 'project-shared', name: 'Shared project', members: [] }],
      mutateProject: vi.fn(() => Promise.resolve({ ok: true })),
      currentAgent: 'agent-a',
      currentView: 'chat',
      activeConversationId: 'visible',
      conversations: [],
      folders: [],
      listFoldersForAgent: vi.fn(() => Promise.resolve([])),
      theme: 'light',
      openUnifiedSessionCreate: false,
      openUnifiedChatCreate: false,
      enterWorkCenter: vi.fn(),
      leaveWorkCenter: vi.fn(),
      openCatalogSession: vi.fn(),
      hideCatalogSession: vi.fn(),
      isSessionPinned: vi.fn(() => false),
      getConversationTitle: vi.fn(() => 'Legacy chat'),
      enterYeaft: vi.fn(),
      leaveYeaft: vi.fn(),
    });
    storeFactories.set('chat', parentStore);
    globalThis.Pinia.useChatStore = () => parentStore;
    const shellStub = { template: '<aside><slot name="collapsed"/><slot/></aside>' };
    const chatPage = mount(ChatPage, {
      global: {
        mocks: { $t: key => key },
        stubs: {
          SessionSidebarShell: shellStub,
          ChatHeader: true,
          MessageList: true,
          ChatInput: true,
          WorkbenchPanel: true,
          WorkCenterPage: true,
          SettingsPanel: true,
          ExpertPanel: true,
          SubAgentPanel: true,
          BtwOverlay: true,
          SplitPane: true,
          ModernSelect: true,
          SidebarModeToggle: true,
          SidebarAgentHeader: true,
          SidebarWorkCenter: true,
        },
      },
    });
    await chatPage.get('.sidebar-primary-action').trigger('click');
    expect(chatPage.vm.unifiedSessionCreateOpen).toBe(true);
    expect(chatPage.vm.unifiedSessionCreateProvider).toBe('yeaft');
    chatPage.vm.closeUnifiedSessionCreate();
    chatPage.vm.onUnifiedCreateInProject({ project: parentStore.sessionProjects[0] });
    expect(chatPage.vm.unifiedSessionCreateProject).toBe(parentStore.sessionProjects[0]);
    await chatPage.vm.onUnifiedSessionCreated({ id: 'created-session', agentId: 'agent-a' });
    expect(parentStore.mutateProject).toHaveBeenCalledWith('move_session', {
      sessionId: 'created-session',
      projectId: 'project-shared',
    }, 'agent-a');
    expect(chatPage.vm.unifiedSessionCreateProject).toBeNull();
    let upgradeAckDetail = null;
    const upgradeRequestId = 'upgrade-regression';
    parentStore.agentOperations = {
      'agent-a': { upgrade: { pending: true, requestId: upgradeRequestId } },
    };
    window.addEventListener('agent-upgrade-ack', event => { upgradeAckDetail = event.detail; }, { once: true });
    handleMessage(parentStore, {
      type: 'upgrade_agent_ack',
      agentId: 'agent-a',
      requestId: upgradeRequestId,
      success: false,
      reason: 'manual_upgrade_required',
      version: '1.0.369',
      requiredCapability: 'remote_upgrade_safe',
    });
    expect(upgradeAckDetail).toMatchObject({
      reason: 'manual_upgrade_required',
      version: '1.0.369',
      requiredCapability: 'remote_upgrade_safe',
    });
    await Vue.nextTick();
    expect(dialogModule.useDialogState().message).toBe('chat.agent.manualUpgradeRequired');
    dialogElement('.app-dialog-confirm').click();
    window.dispatchEvent(new CustomEvent('agent-upgrade-ack', {
      detail: {
        agentId: 'agent-a',
        success: false,
        reason: 'container_image_upgrade_required',
        version: '1.0.415',
      },
    }));
    await Vue.nextTick();
    expect(dialogModule.useDialogState().message).toBe('chat.agent.containerImageUpgradeRequired');
    dialogElement('.app-dialog-confirm').click();
    parentStore.mutateProject.mockResolvedValueOnce({ ok: false, error: { code: 'timeout' } });
    chatPage.vm.onUnifiedCreateInProject({ project: parentStore.sessionProjects[0] });
    const assignmentPromise = chatPage.vm.onUnifiedSessionCreated({ id: 'unassigned-session', agentId: 'agent-a' });
    await Vue.nextTick();
    expect(dialogModule.useDialogState().message).toBe('sidebar.projects.assignFailed');
    dialogModule.resolveDialog(true);
    await assignmentPromise;
    chatPage.vm.hideSessionFromSidebar({
      id: 'legacy-chat',
      provider: 'copilot',
      agentId: 'agent-a',
      workDir: '/repo',
      agentName: 'Agent A',
      agentOnline: true,
    });
    expect(parentStore.hideCatalogSession).toHaveBeenCalledWith(expect.objectContaining({
      catalogKey: 'chat:legacy-chat',
      runtimeProvider: 'copilot',
      routeRef: { runtimeProvider: 'copilot', agentId: 'agent-a', sessionId: 'legacy-chat' },
    }));
    expect(chatPage.find('.sidebar-work-center-header-btn').exists()).toBe(false);
    chatPage.unmount();

    parentStore.currentView = 'yeaft';
    parentStore.activeSessionRoute = {
      runtimeProvider: 'yeaft',
      agentId: 'user_1770305719:server-instance',
      sessionId: 'pinned',
    };
    parentStore.openUnifiedChatCreate = false;
    parentStore.currentAgent = 'user_1770305719:server-instance';
    parentStore.sessionCatalog = [];
    parentStore.hiddenSessionCatalog = [];
    parentStore.hideCatalogSession.mockClear();
    const yeaftSidebar = mount(YeaftSidebar, {
      global: {
        mocks: { $t: key => key },
        stubs: {
          SessionSidebarShell: shellStub,
          SessionCreateModal: true,
          SidebarModeToggle: true,
          SidebarAgentHeader: true,
          SidebarWorkCenter: true,
        },
      },
    });
    window.dispatchEvent(new CustomEvent('agent-upgrade-ack', {
      detail: {
        agentId: 'agent-a',
        success: false,
        reason: 'manual_upgrade_required',
        version: '1.0.369',
        requiredCapability: 'remote_upgrade_safe',
      },
    }));
    await Vue.nextTick();
    expect(dialogModule.useDialogState().message).toBe('chat.agent.manualUpgradeRequired');
    dialogElement('.app-dialog-confirm').click();
    await yeaftSidebar.get('.sidebar-primary-action').trigger('click');
    expect(yeaftSidebar.vm.sessionCreateOpen).toBe(true);
    yeaftSidebar.vm.closeSessionCreate();
    yeaftSidebar.vm.onUnifiedCreateInProject({ project: parentStore.sessionProjects[0] });
    expect(yeaftSidebar.vm.sessionCreateProject).toBe(parentStore.sessionProjects[0]);
    await yeaftSidebar.vm.onSessionCreated({ id: 'created-from-yeaft', agentId: 'agent-a' });
    expect(parentStore.mutateProject).toHaveBeenLastCalledWith('move_session', {
      sessionId: 'created-from-yeaft',
      projectId: 'project-shared',
    }, 'agent-a');
    expect(yeaftSidebar.vm.sessionCreateProject).toBeNull();
    parentStore.mutateProject.mockResolvedValueOnce({ ok: false, error: { message: 'denied' } });
    yeaftSidebar.vm.onUnifiedCreateInProject({ project: parentStore.sessionProjects[0] });
    const yeaftAssignmentPromise = yeaftSidebar.vm.onSessionCreated({ id: 'unassigned-from-yeaft', agentId: 'agent-a' });
    await Vue.nextTick();
    expect(dialogModule.useDialogState().message).toBe('sidebar.projects.assignFailed');
    dialogModule.resolveDialog(true);
    await yeaftAssignmentPromise;
    yeaftSidebar.vm.onRemoveFromList({
      id: 'legacy-yeaft',
      name: 'Legacy Yeaft',
      agentId: 'user_1770305719:server-instance',
      workDir: '/repo',
    });
    expect(parentStore.hideCatalogSession).toHaveBeenCalledWith(expect.objectContaining({
      catalogKey: 'yeaft:user_1770305719:server-instance:legacy-yeaft',
      runtimeProvider: 'yeaft',
      routeRef: {
        runtimeProvider: 'yeaft',
        agentId: 'user_1770305719:server-instance',
        sessionId: 'legacy-yeaft',
      },
    }));
    yeaftSidebar.unmount();
    dialog.unmount();
    globalThis.fetch = originalFetch;
    delete globalThis.Pinia.useChatStore;
    storeFactories.clear();

    expect(chatPageSource).toContain('@create="onUnifiedCreate"');
    expect(chatPageSource).toContain('@create-in-project="onUnifiedCreateInProject"');
    expect(chatPageSource).not.toContain('</template>\n      </main>');
    expect(chatPageSource).not.toContain('sidebar-work-center-header-btn');
    expect(chatPageSource).not.toContain('workCenterAgents');
    expect(chatPageSource).not.toContain('openWorkCenter');
    expect(yeaftSidebarSource).toContain(':is-session-unread="isCatalogSessionUnread"');
    expect(chatPageSource).toContain('@action="onUnifiedSessionAction"');
    expect(yeaftSidebarSource).toContain('@action="onUnifiedSessionAction"');
    expect(yeaftSidebarSource).toContain('@create="onUnifiedCreate"');
    expect(yeaftSidebarSource).toContain('@create-in-project="onUnifiedCreateInProject"');
    expect(yeaftSidebarSource).not.toContain('sidebar-work-center-header-btn');
    const workItemIconPath = 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm2 5v2h10V8H7zm0 4v2h7v-2H7zm0 4v2h5v-2H7z';
    expect(component).not.toContain(workItemIconPath);
    expect(chatPageSource).not.toContain(workItemIconPath);
    expect(yeaftSidebarSource).not.toContain(workItemIconPath);
    expect(chatPageSource).toContain(':project-store="store"');
    expect(chatPageSource).toContain(':active-route="store.activeSessionRoute"');
    expect(yeaftSidebarSource).toContain(':project-store="chatStore"');
    expect(yeaftSidebarSource).toContain(':active-route="chatStore.activeSessionRoute"');
    expect(chatPageSource).toContain(':processing-conversations="store.processingConversations"');
    expect(chatPageSource).not.toContain(':is-session-syncing=');
    expect(chatPageSource).not.toContain(':session-sync-refresh-token=');
    expect(chatPageSource).toContain(':agents="store.agents"');
    expect(yeaftSidebarSource).toContain(':is-yeaft-session-processing="chatStore.isYeaftSessionProcessing"');
    expect(yeaftSidebarSource).not.toContain(':is-session-syncing=');
    expect(yeaftSidebarSource).not.toContain(':session-sync-refresh-token=');
    expect(yeaftSidebarSource).toContain(':agents="chatStore.agents"');
    expect(chatPageSource).not.toContain("action === 'split'");
    expect(chatPageSource).not.toContain('splitScreen.splitToPanel');
    expect(chatPageSource).not.toContain('split-to-panel-item');
    expect(yeaftSidebarSource).not.toContain("action === 'split'");
    expect(websocket).toContain('store.sessionCatalogLoaded = false;');
    expect(websocket).toContain('store.sessionCatalog = [];');
    expect(chatStoreSource).toContain("this.setActiveSessionFilter(sessionId, { agentId, force: true });");
    expect(chatStoreSource).toContain('requestChatHistory(conversationId');
    expect(readFileSync(resolve(import.meta.dirname, '../../web/components/ChatHeader.js'), 'utf8')).not.toContain('store.messagesMap[effectiveConvId.value] = []');
    expect(chatStoreSource).toContain("type: 'set_session_ui_metadata'");
    expect(chatStoreSource).toContain("type: 'reorder_session_catalog'");
    expect((chatStoreSource.match(/type: 'sync_messages'/g) || [])).toHaveLength(1);
    expect(readFileSync(resolve(import.meta.dirname, '../../web/components/ChatHeader.js'), 'utf8')).not.toContain("type: 'sync_messages'");
    expect(readFileSync(resolve(import.meta.dirname, '../../web/stores/helpers/handlers/agentHandler.js'), 'utf8')).not.toContain("type: 'sync_messages'");

    const catalogStore = {
      sessionCatalog: [{ catalogKey: 'chat:offline', pinned: false }],
      sessionCatalogMutationRequests: {},
    };
    const previousCatalog = beginCatalogMutation(catalogStore, 'pin-1');
    catalogStore.sessionCatalog[0].pinned = true;
    expect(finishCatalogMutation(catalogStore, { requestId: 'pin-1', ok: false })).toBe(true);
    expect(catalogStore.sessionCatalog).toEqual(previousCatalog);
    expect(catalogStore.sessionCatalogMutationRequests).toEqual({});

    const persistedYeaftOrder = vi.fn(() => []);
    const previousSessionsStoreForOrder = globalThis.Pinia.useSessionsStore;
    globalThis.Pinia.useSessionsStore = () => ({ reorderSessionsGlobally: persistedYeaftOrder });
    const reorderStore = useChatStore();
    reorderStore.sessionCatalog = orderFixture.map((row, index) => ({
      ...row,
      catalogKey: index === 1 ? 'chat:b' : `yeaft:agent-a:${row.catalogKey}`,
      runtimeProvider: index === 1 ? 'copilot' : 'yeaft',
      routeRef: {
        runtimeProvider: index === 1 ? 'copilot' : 'yeaft',
        agentId: 'agent-a',
        sessionId: row.catalogKey,
      },
    }));
    reorderStore.sessionCatalogMutationRequests = {};
    reorderStore.sendWsMessage = vi.fn(() => true);
    expect(reorderStore.reorderCatalogSessions(reorderStore.sessionCatalog)).toBe(true);
    expect(persistedYeaftOrder).not.toHaveBeenCalled();
    const reorderRequest = reorderStore.sendWsMessage.mock.calls.at(-1)[0];
    expect(reorderRequest).toEqual(expect.objectContaining({
      type: 'reorder_session_catalog',
      sessions: expect.arrayContaining([
        expect.objectContaining({ catalogKey: 'chat:b', sortRank: 1 }),
      ]),
    }));
    expect(reorderStore.finishSessionCatalogMutation({
      type: 'session_catalog_reorder_result',
      requestId: reorderRequest.requestId,
      ok: true,
    })).toBe(true);
    expect(persistedYeaftOrder).toHaveBeenCalledWith([
      'agent-a\u001fa',
      'agent-a\u001fc',
      'agent-a\u001fd',
    ]);
    persistedYeaftOrder.mockClear();
    expect(reorderStore.finishSessionCatalogMutation({
      type: 'session_catalog_reorder_result',
      requestId: reorderRequest.requestId,
      ok: false,
    })).toBe(false);
    expect(persistedYeaftOrder).not.toHaveBeenCalled();

    const atomicOrder = [
      reorderStore.sessionCatalog[3],
      reorderStore.sessionCatalog[0],
      reorderStore.sessionCatalog[1],
      reorderStore.sessionCatalog[2],
    ].map(row => ({ catalogKey: row.catalogKey, routeRef: row.routeRef }));
    reorderStore.sessionProjects = [{
      id: 'project-old',
      members: [{ agentId: 'agent-a', sessionId: 'a' }],
    }];
    reorderStore.projectMutationRequests = {};
    reorderStore.sendWsMessage = vi.fn(() => true);
    const rejectedMove = reorderStore.mutateProject('move_session', {
      sessionId: 'a',
      projectId: 'project-new',
      catalogOrder: atomicOrder,
    }, 'agent-a');
    const rejectedRequest = reorderStore.sendWsMessage.mock.calls.at(-1)[0];
    expect(reorderStore.sessionCatalog.map(row => row.catalogKey)).toEqual([
      'yeaft:agent-a:a',
      'chat:b',
      'yeaft:agent-a:c',
      'yeaft:agent-a:d',
    ]);
    expect(reorderStore.finishProjectMutation({
      requestId: rejectedRequest.requestId,
      ok: false,
      projects: [{ id: 'project-new', members: [{ agentId: 'agent-a', sessionId: 'a' }] }],
    })).toBe(true);
    await expect(rejectedMove).resolves.toMatchObject({ ok: false });
    expect(reorderStore.sessionProjects).toEqual([{
      id: 'project-old',
      members: [{ agentId: 'agent-a', sessionId: 'a' }],
    }]);
    expect(persistedYeaftOrder).not.toHaveBeenCalled();

    const acceptedMove = reorderStore.mutateProject('move_session', {
      sessionId: 'a',
      projectId: 'project-new',
      catalogOrder: atomicOrder,
    }, 'agent-a');
    const acceptedRequest = reorderStore.sendWsMessage.mock.calls.at(-1)[0];
    expect(acceptedRequest).toMatchObject({
      type: 'yeaft_project_mutation',
      op: 'move_session',
      targetAgentId: 'agent-a',
      catalogOrder: atomicOrder,
    });
    expect(reorderStore.finishProjectMutation({
      requestId: acceptedRequest.requestId,
      ok: true,
      projects: [{ id: 'project-new', members: [{ agentId: 'agent-a', sessionId: 'a' }] }],
    })).toBe(true);
    await expect(acceptedMove).resolves.toMatchObject({ ok: true });
    expect(reorderStore.sessionCatalog.map(row => row.catalogKey)).toEqual([
      'yeaft:agent-a:d',
      'yeaft:agent-a:a',
      'chat:b',
      'yeaft:agent-a:c',
    ]);
    expect(reorderStore.sessionProjects).toEqual([{
      id: 'project-new',
      members: [{ agentId: 'agent-a', sessionId: 'a' }],
    }]);
    expect(persistedYeaftOrder).toHaveBeenLastCalledWith([
      'agent-a\u001fd',
      'agent-a\u001fa',
      'agent-a\u001fc',
    ]);

    persistedYeaftOrder.mockClear();
    const catalogAfterAcceptedMove = reorderStore.sessionCatalog.map(row => ({ ...row }));
    const projectsAfterAcceptedMove = reorderStore.sessionProjects.map(project => ({
      ...project,
      members: project.members.map(member => ({ ...member })),
    }));
    reorderStore.sendWsMessage = vi.fn(() => false);
    await expect(reorderStore.mutateProject('move_session', {
      sessionId: 'a',
      projectId: null,
      catalogOrder: atomicOrder,
    }, 'agent-a')).resolves.toMatchObject({ ok: false, error: { code: 'send_failed' } });
    expect(reorderStore.sessionCatalog).toEqual(catalogAfterAcceptedMove);
    expect(reorderStore.sessionProjects).toEqual(projectsAfterAcceptedMove);
    expect(reorderStore.projectMutationRequests).toEqual({});
    expect(persistedYeaftOrder).not.toHaveBeenCalled();
    globalThis.Pinia.useSessionsStore = previousSessionsStoreForOrder;

    const historyStore = {
      messagesMap: { a: [], b: [] },
      activeConversations: ['b'],
      currentConversation: 'b',
      loadingMoreMessages: true,
      refreshingSessionMap: { a: true, b: true },
      chatSessionState: {},
      hasMoreMessages: false,
      chatHistoryRequests: {
        'chat:a': { requestId: 'request-a', catalogKey: 'chat:a', loading: true },
        'chat:b': { requestId: 'request-b', catalogKey: 'chat:b', loading: true },
      },
      formatDbMessage: vi.fn(row => ({ id: `row-${row.id}`, dbMessageId: row.id, type: row.role, content: row.content })),
      isCurrentChatHistoryResponse(msg) {
        return msg.catalogKey === `chat:${msg.conversationId}`
          && this.chatHistoryRequests[msg.catalogKey]?.requestId === msg.requestId;
      },
      finishChatHistoryRequest(msg) {
        if (!this.isCurrentChatHistoryResponse(msg)) return false;
        this.chatHistoryRequests[msg.catalogKey].loading = false;
        return true;
      },
      setRefreshingSession(id, value) { this.refreshingSessionMap[id] = value; },
    };
    expect(handleSyncMessagesResult(historyStore, {
      conversationId: 'a', catalogKey: 'chat:a', requestId: 'stale', mode: 'recent', messages: [], hasMore: false,
    })).toBe(false);
    expect(historyStore.refreshingSessionMap.a).toBe(true);
    expect(handleSyncMessagesResult(historyStore, {
      conversationId: 'a', catalogKey: 'chat:a', requestId: 'request-a', mode: 'recent', messages: [], hasMore: false,
    })).toBe(true);
    expect(historyStore.loadingMoreMessages).toBe(true);
    expect(historyStore.refreshingSessionMap.a).toBe(false);

    historyStore.chatHistoryRequestIdSupported = null;
    historyStore.chatHistoryRequests['chat:b'] = {
      requestId: 'legacy-b', catalogKey: 'chat:b', mode: 'recent', loading: true,
    };
    expect(handleSyncMessagesResult(historyStore, {
      conversationId: 'b', messages: [], hasMore: false,
    })).toBe(true);
    expect(historyStore.chatHistoryRequests['chat:b'].loading).toBe(false);
    expect(handleSyncMessagesResult(historyStore, {
      conversationId: 'b', messages: [{ id: 99, role: 'assistant', content: 'late' }], hasMore: false,
    })).toBe(false);
    expect(historyStore.messagesMap.b).toEqual([]);

    const historyActions = {
      chatHistoryConnectionGeneration: 2,
      chatHistoryRequests: {},
    };
    const failedRequestId = beginChatHistoryRequest(historyActions, 'offline', 'recent');
    expect(cancelChatHistoryRequest(historyActions, 'chat:offline', failedRequestId, 'send_failed')).toBe(true);
    expect(historyActions.chatHistoryRequests['chat:offline']).toMatchObject({
      loading: false,
      cancelled: true,
      error: 'send_failed',
      connectionGeneration: 2,
    });

    const workCenter = readFileSync(resolve(import.meta.dirname, '../../web/components/WorkCenterPage.js'), 'utf8');
    const workCenterCss = readFileSync(resolve(import.meta.dirname, '../../web/styles/work-center.css'), 'utf8');

    expect(component).toContain(':show-stop="isStopVisible"');
    expect(messageComposer).toContain('v-if="showStop"');
    expect(messageComposer).not.toContain('v-else\n            type="button"\n            class="send-btn"');
    expect(component).toContain('if (isCompacting.value) return false;');
    expect(component).not.toContain('if (isCompacting.value || isStopVisible.value) return false;');
    expect(component).toContain('if (!canSend.value) return;');
    expect(component).not.toContain('if (isStopVisible.value || !canSend.value) return;');
    expect(workCenter).toContain('@change="onWorkItemMessageAttachmentInput"');
    expect(workCenter).toContain("import ModernSelect from './ModernSelect.js'");
    expect(workCenter).toContain('class="work-center-composer-target"');
    expect(workCenter).toContain('menu-class="work-center-composer-target-menu yeaft-model-dropdown"');
    expect(workCenter).toContain('@update:model-value="composerTargetValue = $event"');
    expect(workCenter).not.toContain('<select v-model="composerTargetValue"');
    expect(workCenter).toContain(':options="workCenterAgentOptions"');
    expect(workCenter).toContain('@update:model-value="selectWorkCenterAgent"');
    expect(workCenter).not.toContain('<label class="work-center-agent-picker">');
    expect(workCenter).not.toContain('<select :value="agentId"');
    expect(workCenter).toContain("this.store.enterWorkCenter(nextAgentId)");
    expect(workCenterCss).toMatch(/\.work-center-agent-picker \.modern-select-trigger\s*\{[^}]*background:\s*var\(--bg-input\)/s);
    const pluginCenterCss = readFileSync(resolve(import.meta.dirname, '../../web/styles/plugin-center.css'), 'utf8');
    expect(pluginCenterCss).toContain('background: var(--bg-main);');
    expect(pluginCenterCss).toContain('background: var(--bg-sidebar);');
    expect(pluginCenterCss).toContain('background: var(--session-active);');
    expect(pluginCenterCss).toContain('background: var(--sidebar-hover);');
    expect(pluginCenterCss).toContain('border-radius: var(--plugin-center-radius-lg);');
    expect(pluginCenterCss).toContain('gap: var(--plugin-center-space-8);');
    expect(pluginCenterCss).toContain('font-size: var(--plugin-center-font-size-md);');
    expect(pluginCenterCss).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(/i);
    expect(pluginCenterCss).not.toMatch(/(?:^|[;{])\s*(?:gap|margin(?:-[a-z]+)?|padding(?:-[a-z]+)?|font-size|min-(?:width|height)|max-width|width|height|border(?:-(?:top|right|bottom|left))?|outline(?:-offset)?|border-radius)\s*:\s*-?\d+(?:\.\d+)?(?:px|rem|em)/im);
    const workCenterStore = {
      workCenterAgentId: 'agent-a',
      currentAgent: 'agent-a',
      agents: [
        { id: 'agent-a', name: 'server', online: true, capabilities: ['work_center'] },
        { id: 'agent-b', name: 'C1', online: true, capabilities: ['work_center'] },
        { id: 'agent-c', name: 'C2', online: true, capabilities: ['work_center'] },
        { id: 'agent-d', name: 'C3', online: true, capabilities: ['work_center'] },
        { id: 'agent-e', name: 'C4', online: true, capabilities: ['work_center'] },
        { id: 'agent-f', name: 'C5', online: true, capabilities: ['work_center'] },
      ],
      workCenterWatcherByAgent: {},
      workCenterListPageByAgent: {},
      workCenterListMoreLoadingByAgent: {},
      workCenterSettingsByAgent: {},
      workCenterRuntimeByAgent: {},
      workCenterItemsByAgent: { 'agent-a': [] },
      workCenterLoadingByAgent: {},
      workCenterLoadedByAgent: {},
      workCenterErrorByAgent: {},
      workCenterDetailByAgent: {},
      workCenterActionMessages: {},
      workCenterActionMessagesLoading: {},
      workCenterActionMessagesError: {},
      workCenterActionRequests: {},
      workCenterActionRequestDetails: {},
      workCenterActionRequestDetailsLoading: {},
      workCenterActionRequestDetailsError: {},
      workCenterActionRequestsLoading: {},
      workCenterActionRequestsError: {},
      workbenchMaximized: false,
      workbenchExpanded: false,
      workCenterCreateDraft: null,
      listWorkItems: vi.fn(() => Promise.resolve([])),
      loadWorkCenterSettings: vi.fn(() => Promise.resolve(null)),
      enterWorkCenter: vi.fn(),
      toggleSessionSidebar: vi.fn(),
    };
    globalThis.Pinia.useChatStore = () => workCenterStore;
    globalThis.Vue = Vue;
    const workCenterPage = mount(WorkCenterPage, {
      global: {
        mocks: { $t: key => key },
        stubs: {
          WorkCenterActionDetail: true,
          WorkCenterSettingsModal: true,
          LlmTab: true,
        },
      },
    });
    expect(workCenterPage.get('.work-center-agent-picker .modern-select-label').text()).toBe('server');
    workCenterStore.refreshWorkCenterRuntime = vi.fn(() => Promise.resolve());
    await WorkCenterPage.methods.refreshWorkCenterRuntime.call(workCenterPage.vm, 'agent-b');
    expect(workCenterStore.refreshWorkCenterRuntime).not.toHaveBeenCalled();
    await WorkCenterPage.methods.refreshWorkCenterRuntime.call(workCenterPage.vm, 'agent-a');
    expect(workCenterStore.refreshWorkCenterRuntime).toHaveBeenCalledOnce();
    expect(workCenterStore.refreshWorkCenterRuntime).toHaveBeenCalledWith('agent-a');

    const pluginConfigRequests = [];
    const pluginStore = Vue.reactive({
      agents: [{ id: 'agent-a', name: 'Agent A', online: true, capabilities: ['yeaft_plugins', 'yeaft_managed_skills'], capabilityMetadataProvided: true }],
      currentAgent: 'agent-a',
      pluginCenterAgentId: 'agent-a',
      pluginConfigByAgent: {},
      pluginCatalogByKey: {
        'agent-a:': {
          loading: false,
          catalog: {
            tools: [{ id: 'FileRead', label: 'FileRead' }],
            skills: [
              { id: 'skill-a', label: 'skill-a', tier: 'user' },
              { id: 'skill-b', label: 'skill-b', tier: 'project' },
            ],
            skillSources: [
              { id: 'user:skill-a', name: 'skill-a', label: 'skill-a', tier: 'user', managed: true },
              { id: 'project:skill-b', name: 'skill-b', label: 'skill-b', tier: 'project', managed: true },
            ],
            mcpServers: [],
          },
        },
      },
      pluginCatalogKey: (agentId, workDir = '') => `${agentId}:${workDir}`,
      activePluginSession: () => ({ sessionId: 'session-a', agentId: 'agent-a', workDir: '' }),
      mutateManagedSkill: vi.fn(() => Promise.resolve({ result: { name: 'created-skill' }, catalog: { tools: [], skills: [], skillSources: [], mcpServers: [] }, error: null })),
      loadPluginConfig: vi.fn(() => new Promise(resolve => {
        pluginConfigRequests.push(resolve);
      })),
      loadPluginCatalog: vi.fn(() => Promise.resolve()),
      savePluginConfig: vi.fn(plugins => Promise.resolve({ plugins })),
    });
    globalThis.Pinia.useChatStore = () => pluginStore;
    const pluginCenter = mount(PluginCenterPage, {
      global: { mocks: { $t: translatePluginCenterMessage } },
    });
    await Vue.nextTick();
    expect(pluginCenter.findAll('input[type="checkbox"]').every(input => input.element.disabled)).toBe(true);
    expect(pluginCenter.get('.btn-primary').attributes('disabled')).toBeDefined();
    pluginCenter.vm.toggle('skills', { name: 'skill-a', label: 'skill-a' }, false);
    await pluginCenter.vm.save();
    expect(pluginStore.savePluginConfig).not.toHaveBeenCalled();

    pluginConfigRequests[0]({ plugins: {}, error: 'Failed to read plugin config: malformed config' });
    await Promise.resolve();
    await Promise.resolve();
    await Vue.nextTick();
    expect(pluginCenter.vm.configReady).toBe(false);
    expect(pluginCenter.get('.btn-primary').attributes('disabled')).toBeDefined();
    expect(pluginCenter.vm.selection).toBeNull();
    pluginStore.pluginConfigByAgent['agent-a'] = {
      plugins: {},
      error: 'Failed to read plugin config: malformed config',
      loaded: true,
    };
    pluginCenter.vm.loadConfig('agent-a');
    await Vue.nextTick();
    expect(pluginConfigRequests).toHaveLength(2);
    expect(pluginCenter.vm.configReady).toBe(false);
    expect(pluginCenter.get('.btn-primary').attributes('disabled')).toBeDefined();
    await pluginCenter.vm.save();
    expect(pluginStore.savePluginConfig).not.toHaveBeenCalled();

    pluginConfigRequests[1]({ plugins: { tools: ['FileRead'] } });
    await Promise.resolve();
    await Promise.resolve();
    await Vue.nextTick();
    expect(pluginCenter.vm.configReady).toBe(true);
    expect(pluginCenter.vm.selection).toEqual({ tools: ['FileRead'] });
    Object.assign(pluginCenter.vm.skillForm, {
      name: 'allow-all-skill', description: 'Created while Skills inherit allow-all', content: 'Keep inherited policy.',
    });
    await pluginCenter.vm.createSkill();
    expect(pluginCenter.vm.selection).toEqual({ tools: ['FileRead'] });
    expect(pluginCenter.vm.selection).not.toHaveProperty('skills');

    pluginCenter.vm.toggle('skills', { name: 'skill-a', label: 'skill-a' }, false);
    expect(pluginCenter.vm.selection).toEqual({
      tools: ['FileRead'],
      skills: ['skill-b'],
    });
    expect(pluginCenter.get('.plugin-center-skill-remove').text()).toBe(enMessages['yeaft.plugins.removeSkill']);
    expect(pluginCenter.vm.projectSkillAvailable).toBe(false);
    pluginCenter.vm.skillScope = 'project';
    await pluginCenter.vm.createSkill();
    expect(pluginCenter.vm.skillMutationError).toBe(enMessages['yeaft.plugins.projectScopeUnavailable']);
    pluginCenter.vm.skillScope = 'user';
    Object.assign(pluginCenter.vm.skillForm, {
      name: 'created-skill', description: 'Created in UI', content: 'Use this Skill.',
    });
    await pluginCenter.vm.createSkill();
    expect(pluginStore.mutateManagedSkill).toHaveBeenCalledWith(expect.objectContaining({
      action: 'create', scope: 'user', sessionId: '',
    }), 'agent-a');
    expect(pluginCenter.vm.selection.skills).toEqual(['skill-b', 'created-skill']);
    await pluginCenter.vm.save();
    expect(pluginStore.savePluginConfig).toHaveBeenCalledWith({
      tools: ['FileRead'],
      skills: ['skill-b', 'created-skill'],
    }, 'agent-a');
    expect(pluginCenter.vm.enabledCount).toBe(3);
    expect(pluginCenter.vm.isDirty).toBe(false);
    expect(pluginCenter.find('.plugin-center-save').attributes('disabled')).toBeDefined();

    await pluginCenter.get('input[type="search"]').setValue('skill-b');
    expect(pluginCenter.vm.visibleCategories).toEqual(['skills']);
    expect(pluginCenter.vm.visibleResultCount).toBe(1);
    expect(pluginCenter.findAll('.plugin-center-card')).toHaveLength(1);
    expect(pluginCenter.text()).toContain('skill-b');

    pluginCenter.vm.activeCategory = 'tools';
    await Vue.nextTick();
    expect(pluginCenter.vm.hasSearchResults).toBe(false);
    expect(pluginCenter.find('.plugin-center-empty-search').exists()).toBe(true);

    pluginCenter.vm.activeCategory = 'skills';
    pluginCenter.vm.searchQuery = '';
    await Vue.nextTick();
    const skillToggle = pluginCenter.findAll('input[type="checkbox"]').find(input => input.element.checked);
    await skillToggle.setValue(false);
    expect(pluginCenter.vm.isDirty).toBe(true);
    expect(pluginCenter.get('.plugin-center-save').attributes('disabled')).toBeUndefined();
    expect(pluginCenter.text()).toContain(enMessages['yeaft.plugins.unsavedChanges']);
    pluginCenter.unmount();

    globalThis.Pinia.useChatStore = () => workCenterStore;
    await workCenterPage.get('.work-center-agent-picker .modern-select-trigger').trigger('click');
    await Vue.nextTick();
    const agentMenu = document.body.querySelector('.work-center-agent-menu');
    expect(agentMenu).not.toBeNull();
    expect([...agentMenu.querySelectorAll('.modern-select-option-label')].map(row => row.textContent.trim())).toEqual([
      'server', 'C1', 'C2', 'C3', 'C4', 'C5',
    ]);
    expect(workCenterCss).toMatch(/\.work-center-agent-menu \.modern-select-list\s*\{[^}]*max-height:\s*min\(164px, var\(--modern-select-list-max-height, 164px\)\);/s);
    const workCenterAgentListRule = workCenterCss.match(/\.work-center-agent-menu \.modern-select-list\s*\{([^}]*)\}/s)?.[1] || '';
    expect(workCenterAgentListRule).not.toMatch(/(^|[;\s])height\s*:/);
    expect(workCenterCss).toMatch(/\.work-center-agent-menu \.modern-select-option\s*\{[^}]*min-height:\s*32px;[^}]*box-sizing:\s*border-box;/s);
    const agentList = agentMenu.querySelector('.modern-select-list');
    Object.defineProperty(agentList, 'scrollHeight', { configurable: true, value: 260 });
    Object.defineProperty(agentMenu, 'scrollHeight', { configurable: true, value: 48 });
    window.dispatchEvent(new Event('scroll'));
    await Vue.nextTick();
    const stableMenuHeight = agentMenu.style.maxHeight;
    expect(stableMenuHeight).not.toBe('48px');
    for (let index = 0; index < 6; index += 1) {
      agentList.dispatchEvent(new Event('scroll', { bubbles: true }));
      await Vue.nextTick();
      expect(agentMenu.style.maxHeight).toBe(stableMenuHeight);
    }
    agentMenu.querySelectorAll('.modern-select-option')[1].click();
    await Vue.nextTick();
    expect(workCenterStore.enterWorkCenter).toHaveBeenCalledWith('agent-b');
    workCenterPage.unmount();
    delete globalThis.Vue;
    delete globalThis.Pinia.useChatStore;
    expect(workCenter).toContain('workItemMessageAttachments.length > 0');
    expect(workCenter).toContain('class="work-center-breadcrumb-button"');
    expect(workCenter).not.toContain('class="work-center-action-content-summary"');
    expect(workCenter).toContain("contentPanelOpen: false");
    expect(workCenter).toContain("v-if=\"contentPanelOpen\"");
    expect(workCenter).toContain("if (this.contentPanelOpen) url.searchParams.set('workContent'");
    expect(workCenter).toContain('work-center-conversation-topbar');
    expect(workCenter).toContain('work-center-work-item-overview');
    expect(workCenter).toContain('work-center-conversation-column');
    expect(workCenter).toContain('work-center-composer-column');
    expect(workCenterCss).toMatch(/\.work-center-detail-layout\s*\{[^}]*display:\s*flex;[^}]*overflow:\s*hidden;/s);
    expect(workCenterCss).toMatch(/\.work-center-content-pane\s*\{[^}]*width:\s*var\(--work-center-actions-pane-width\);[^}]*flex:\s*0 0 var\(--work-center-actions-pane-width\);/s);
    expect(workCenterCss).toMatch(/\.work-center-conversation-scroll\s*\{[^}]*overflow-y:\s*auto;[^}]*overflow-x:\s*hidden;/s);
    expect(workCenterCss).toMatch(/\.work-center-conversation-composer\s*\{[^}]*padding:\s*8px 0 calc\(14px \+ env\(safe-area-inset-bottom, 0px\)\);/s);
    expect(workCenterCss).toMatch(/\.work-center-item-message-input \.work-center-composer-target \.modern-select-trigger\s*\{[^}]*height:\s*var\(--chat-composer-control-size\);[^}]*border-radius:\s*var\(--chat-composer-radius\);[^}]*background:\s*transparent;/s);
    expect(workCenterCss).toMatch(/\.work-center-composer-target-menu\.modern-select-menu\s*\{[^}]*box-shadow:\s*var\(--modal-shadow\);/s);
    expect(workCenterCss).toMatch(/\.work-center-conversation-column,[\s\S]*?\.work-center-composer-column\s*\{[^}]*max-width:\s*var\(--work-center-conversation-column-width\);/s);
    expect(workCenterCss).not.toMatch(/\.work-center-work-item-overview\s*\{[^}]*overflow-y:/s);
    expect(workCenterCss).not.toContain('.work-center-triage-summary');
    expect(workCenterCss).toMatch(/@container work-center \(max-width:\s*1024px\)\s*\{[\s\S]*?\.work-center-detail-layout\.content-open \.work-center-conversation-pane\s*\{[^}]*display:\s*none;/s);
    expect(workCenterCss).not.toContain('@container work-center (max-width: 700px)');
    expect(workCenterCss).toMatch(/\.work-center-detail-heading\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 2fr\) minmax\(0, 1fr\);/s);
    expect(workCenterCss).toMatch(/\.work-center-action-description,[\s\S]*?white-space:\s*nowrap;/);
    expect(workCenter).not.toContain('coordinatorRequestedSelectedActionInput');
    expect(workCenter).not.toContain("next?.routedTo === 'coordinator'");
    expect(workCenter).not.toContain("[...(this.selected.messages || [])].reverse().some");
    expect(workCenter).not.toContain("message.recovery?.actionId === this.selectedAction.id");
    expect(workCenter).toContain(":class=\"{ 'showing-detail': narrowPane !== 'items' }\"");
    expect(workCenterCss).toMatch(/\.work-center-shell\.showing-detail\s*\{[\s\S]*?padding: 0;/);
    expect(workCenterCss).toMatch(/\.work-center-detail-heading\s*\{[\s\S]*?min-height: 40px;[\s\S]*?padding: 4px 16px;/);
    expect(workCenter).toContain('workItemMessageSpeaker(message)');
    expect(workCenter).toContain('workCenter.messageSpeakerRole');
    expect(workCenter).not.toContain("tr('workCenter.assistant', 'Yeaft')");
    expect(workCenter).not.toContain('class="work-center-detail-controls"');
    expect(workCenter).not.toContain('target-action');
    expect(workCenter).not.toContain('get_action_requests');
    expect(workCenter).not.toContain('get_action_request');
    expect(workCenter).not.toContain('work-center-action-view-switch');
    expect(workCenter).not.toContain('work-center-action-execution');
    expect(workCenterCss).not.toContain('width: min(100%, 1120px);');
    expect(variables).toContain('--work-center-conversation-column-width: var(--session-content-width);');
    expect(variables).toContain('--work-center-conversation-gutter: 16px;');
    expect(variables).toContain('--work-center-actions-pane-width: 400px;');
    expect(workCenter).toContain("import UserTurnBlock from './UserTurnBlock.js'");
    expect(workCenter).toContain("import VpTurnBlock from './VpTurnBlock.js'");
    expect(workCenter).toContain(':display-name-override="block.speakerName"');
    expect(workCenter).toContain('@edit-as-new="editWorkItemMessageAsNew"');
    expect(workCenter).not.toContain('<article v-for="message in selected.messages"');
    const modernSelect = readFileSync(resolve(import.meta.dirname, '../../web/components/ModernSelect.js'), 'utf8');
    expect(modernSelect).toContain('const desiredHeight = Math.min(list.scrollHeight + chromeHeight, 304);');
    expect(modernSelect).not.toContain('Math.min(menu.scrollHeight, 304)');
    expect(variables).not.toContain('--work-center-triage-max-height');
    expect(variables).not.toContain('--work-center-conversation-min-height');
    expect(workCenterCss).toMatch(/@media \(max-width: 768px\)\s*\{[\s\S]*?\.work-center-detail-layout\.content-open \.work-center-conversation-pane\s*\{[\s\S]*?display: none;/);
    expect(workCenterCss).not.toMatch(/\.work-center-mobile-pane-tabs\s*\{[\s\S]*?display: grid;/);

    const turnBlock = readFileSync(resolve(import.meta.dirname, '../../web/components/VpTurnBlock.js'), 'utf8');
    const chatStore = readFileSync(resolve(import.meta.dirname, '../../web/stores/chat.js'), 'utf8');
    const bridge = readFileSync(resolve(import.meta.dirname, '../../agent/yeaft/web-bridge.js'), 'utf8');
    const en = readFileSync(resolve(import.meta.dirname, '../../web/i18n/en.js'), 'utf8');
    const zh = readFileSync(resolve(import.meta.dirname, '../../web/i18n/zh-CN.js'), 'utf8');
    expect(bridge).toContain("RUNNING_THREAD_STATES = new Set(['queued', 'typing', 'thinking', 'retrying', 'streaming', 'tool'])");
    expect(bridge).toContain("recoveryMode: event.recoveryMode || 'restart'");
    expect(chatStore).toContain("case 'llm_retry': {");
    expect(chatStore).toContain('retryAttempt: event.attempt || 0');
    expect(chatStore).toContain('const frameTurnKey = msg.turnId ? yeaftTurnStateKey(this, msg.agentId || null, msg.turnId)');
    expect(chatStore).toContain('retryRecoveryMode: _retryRecoveryMode');
    expect(chatStore).toContain("'thinking', 'retrying', 'streaming'");
    const timelinePane = readFileSync(resolve(import.meta.dirname, '../../web/components/VpTimelinePane.js'), 'utf8');
    expect(timelinePane).toContain("task.kind === 'sub_agent' && !!task.runtime?.subAgentId");
    expect(turnBlock).toContain('turn.isStreaming && retryText');
    expect(turnBlock).toContain("'yeaft.vp.turnBlock.retryingContinue'");
    expect(en).toContain("'yeaft.vp.turnBlock.retryingRequest': 'Response stalled;");
    expect(zh).toContain("'yeaft.vp.turnBlock.retryingRequest': '响应停滞");

    storeFactories.clear();
    runtimeSessionsStore.sessionList = [
      { id: 'shared', agentId: 'agent-a' },
      { id: 'shared', agentId: 'agent-b' },
    ];
    const store = useChatStore();
    clearWorkCenterBrowserOwner();
    bindWorkCenterBrowserOwner('owner-a');
    expect(store.hydrateWorkCenterBrowserState()).toBe(true);
    expect(store.saveWorkCenterComposerDraft('agent-a', 'work-item-owner', {
      text: 'owner A private draft',
      quote: { id: 'assistant-1', role: 'assistant', author: 'Omni', content: 'Original answer' },
      target: { kind: 'coordinator' },
    })).toBe(true);
    const ownerAEnvelope = store.prepareWorkCenterMessageEnvelope({
      agentId: 'agent-a', workItemId: 'work-item-owner',
      target: { kind: 'coordinator' }, text: 'owner A durable outbox',
      quote: { id: 'assistant-1', role: 'assistant', author: 'Omni', content: 'Original answer' },
      attachments: [{ fileId: 'old-file', name: 'old.txt', mimeType: 'text/plain', size: 3 }],
      revision: 1, planRevision: 2, ledgerRevision: 3, coordinatorRevision: 4,
    });
    const ownerAFence = { ...store._workCenterBrowserFence };
    expect(ownerAEnvelope.clientMessageId).toEqual(expect.any(String));
    const replacedOwnerAEnvelope = store.replaceWorkCenterMessageEnvelopeAttachments(
      'agent-a', 'work-item-owner',
      [{ fileId: 'new-file', name: 'new.txt', mimeType: 'text/plain', size: 4 }],
    );
    expect(replacedOwnerAEnvelope).toEqual({
      ...ownerAEnvelope,
      attachments: [{ fileId: 'new-file', name: 'new.txt', mimeType: 'text/plain', size: 4 }],
    });
    expect(replacedOwnerAEnvelope).toMatchObject({
      clientMessageId: ownerAEnvelope.clientMessageId,
      target: ownerAEnvelope.target,
      text: ownerAEnvelope.text,
      quote: ownerAEnvelope.quote,
      revision: 1,
      planRevision: 2,
      ledgerRevision: 3,
      coordinatorRevision: 4,
      createdAt: ownerAEnvelope.createdAt,
    });
    store.workCenterComposerDrafts = {};
    store.workCenterMessageOutbox = {};
    store._workCenterBrowserFence = null;
    expect(store.hydrateWorkCenterBrowserState()).toBe(true);
    expect(store.loadWorkCenterComposerDraft('agent-a', 'work-item-owner'))
      .toMatchObject({ text: 'owner A private draft', quote: { content: 'Original answer' } });
    expect(store.loadWorkCenterMessageEnvelope('agent-a', 'work-item-owner'))
      .toMatchObject({ clientMessageId: ownerAEnvelope.clientMessageId, quote: { content: 'Original answer' } });

    bindWorkCenterBrowserOwner('owner-b');
    expect(store.workCenterComposerDrafts).toEqual({});
    expect(store.workCenterMessageOutbox).toEqual({});
    expect(writeWorkCenterDrafts({ leaked: { text: 'stale A write' } }, ownerAFence)).toBe(false);
    expect(store.saveWorkCenterComposerDraft('agent-a', 'work-item-owner', {
      text: 'stale Pinia write', target: { kind: 'coordinator' },
    })).toBe(false);
    expect(globalThis.localStorage.getItem(WORK_CENTER_BROWSER_STORAGE_KEYS.drafts)).toBe(null);
    expect(globalThis.localStorage.getItem(WORK_CENTER_BROWSER_STORAGE_KEYS.outbox)).toBe(null);

    globalThis.localStorage.setItem(
      WORK_CENTER_BROWSER_STORAGE_KEYS.drafts,
      JSON.stringify({ legacy: { text: 'unowned legacy draft' } }),
    );
    store._workCenterBrowserFence = null;
    expect(store.hydrateWorkCenterBrowserState()).toBe(true);
    expect(readWorkCenterBrowserState(currentWorkCenterBrowserOwner()).drafts).toEqual({});
    expect(globalThis.localStorage.getItem(WORK_CENTER_BROWSER_STORAGE_KEYS.drafts)).toBe(null);
    clearWorkCenterBrowserOwner();

    const productionSendWsMessage = store.sendWsMessage;
    store.sendWsMessage = vi.fn();
    store.agents = [
      { id: 'agent-a', name: 'Agent A', online: true },
      { id: 'agent-b', name: 'Agent B', online: true },
    ];
    store.currentAgent = 'agent-old';
    const requestA = store.selectAgent('agent-a');
    const requestB = store.selectAgent('agent-b');
    store.activateYeaftAgent('agent-b', store.agents[1]);
    expect(requestA).not.toBe(requestB);
    expect(handleAgentSelected(store, {
      type: 'agent_selected', requestId: requestA, agentId: 'agent-a', agentName: 'Agent A', conversations: [],
    })).toBe(false);
    expect(store.currentAgent).toBe('agent-b');
    expect(handleAgentSelected(store, {
      type: 'agent_selected', requestId: requestB, agentId: 'agent-b', agentName: 'Agent B', conversations: [],
    })).toBe(true);
    expect(store.currentAgent).toBe('agent-b');
    expect(store.pendingAgentSelection).toBeNull();

    const legacyRequest = store.selectAgent('agent-a');
    expect(legacyRequest).toBeTruthy();
    expect(handleAgentSelected(store, {
      type: 'agent_selected', agentId: 'agent-b', agentName: 'Agent B', conversations: [],
    })).toBe(false);
    expect(handleAgentSelected(store, {
      type: 'agent_selected', agentId: 'agent-a', agentName: 'Agent A', conversations: [],
    })).toBe(true);
    expect(store.currentAgent).toBe('agent-a');

    store.currentAgent = 'agent-a';
    store.sendWsMessage = vi.fn(() => false);
    expect(store.selectAgent('agent-b')).toBeNull();
    expect(store.pendingAgentSelection).toBeNull();
    expect(store.agentSwitching).toBe(false);
    store.pendingAgentSelection = { agentId: 'agent-b', requestId: 'failed-agent' };
    store.agentSwitching = true;
    expect(handleAgentSelected(store, {
      type: 'agent_selected', agentId: 'agent-b', requestId: 'failed-agent', ok: false,
    })).toBe(false);
    expect(store.pendingAgentSelection).toBeNull();
    expect(store.agentSwitching).toBe(false);

    vi.useFakeTimers();
    store.conversations = [{ id: 'chat-one' }];
    store.yeaftSessionInventoryCompleteSupported = true;
    store.sendWsMessage = vi.fn(() => true);
    const inventoryRequest = store.requestYeaftSessionInventory();
    expect(inventoryRequest).toMatch(/^session_inventory_/);
    expect(store.sendWsMessage).toHaveBeenLastCalledWith({
      type: 'get_agents', requestId: inventoryRequest, conversationIds: ['chat-one'],
    });
    expect(store.yeaftSessionHydrateError).toBeNull();
    vi.advanceTimersByTime(15_000);
    expect(store.yeaftSessionHydrateRequestId).toBeNull();
    expect(store.yeaftSessionHydrateSlices).toEqual([]);
    expect(store.yeaftSessionHydrateError).toBe('session_inventory_timeout');
    expect(store._yeaftSessionInventorySocketQuarantined).toBe(false);
    const staleTimeoutState = {
      yeaftSessionInventoryCompleteSupported: true,
      yeaftSessionHydrateRequestId: null,
      yeaftSessionHydrateSlices: [],
      _hasHandledYeaftSessionHydrate: false,
      yeaftSessionHydrateError: 'session_inventory_timeout',
    };
    handleMessage(staleTimeoutState, {
      type: 'yeaft_session_hydrate_complete', requestId: inventoryRequest, ok: true,
    });
    expect(staleTimeoutState.yeaftSessionHydrateError).toBe('session_inventory_timeout');
    vi.useRealTimers();

    const staleDebugDetailStore = {
      _yeaftDebugHistoryLatestDetailRequestId: 'detail-current',
      _yeaftDebugHistoryLatestListRequestId: null,
      _fetchYeaftDebugHistoryTimer: 'pending',
      _yeaftDebugHistoryInFlightKey: 'session-a:turn-a',
      yeaftDebugTurnsById: { current: { turnId: 'current' } },
      yeaftDebugLoops: [],
      yeaftDebugTurnOrder: ['current'],
      yeaftDebugHistoryLoading: true,
    };
    handleMessage(staleDebugDetailStore, {
      type: 'yeaft_debug_history', detailTurnId: 'turn-old', turns: [{ turnId: 'stale' }], loops: [],
    });
    expect(staleDebugDetailStore.yeaftDebugTurnOrder).toEqual(['current']);
    expect(staleDebugDetailStore._fetchYeaftDebugHistoryTimer).toBe('pending');
    handleMessage(staleDebugDetailStore, {
      type: 'yeaft_debug_history', requestId: 'detail-old', detailTurnId: 'turn-old', turns: [{ turnId: 'stale' }], loops: [],
    });
    expect(staleDebugDetailStore.yeaftDebugTurnOrder).toEqual(['current']);

    const chunkStore = {
      _lastPongAt: 0,
      yeaftDebugPanel: { agentId: 'agent-a' },
      _yeaftDebugHistoryLatestDetailRequestId: 'detail-current',
      _yeaftDebugHistoryLatestListRequestId: null,
      _fetchYeaftDebugHistoryTimer: null,
      yeaftDebugTurnsById: {}, yeaftDebugLoops: [], yeaftDebugTurnOrder: [],
    };
    const fullDetail = JSON.stringify({
      type: 'yeaft_debug_history', requestId: 'detail-current', detailTurnId: 'turn-current',
      turns: [{ turnId: 'turn-current' }],
      loops: [{ turnId: 'turn-current', rawResponse: { body: '完整😀数据' } }],
    });
    const splitAt = fullDetail.indexOf('😀') + 1;
    handleMessage(chunkStore, {
      type: 'yeaft_debug_history_chunk', agentId: 'agent-a', requestId: 'detail-current',
      chunkIndex: 1, chunkCount: 2, data: fullDetail.slice(splitAt),
    });
    expect(chunkStore.yeaftDebugTurnOrder).toEqual([]);
    handleMessage(chunkStore, {
      type: 'yeaft_debug_history_chunk', agentId: 'agent-a', requestId: 'detail-current',
      chunkIndex: 0, chunkCount: 2, data: fullDetail.slice(0, splitAt),
    });
    handleMessage(chunkStore, {
      type: 'yeaft_debug_history_chunk', agentId: 'agent-a', requestId: 'detail-current',
      chunkIndex: 1, chunkCount: 2, data: fullDetail.slice(splitAt),
    });
    expect(chunkStore.yeaftDebugLoops[0].rawResponse.body).toBe('完整😀数据');
    chunkStore._yeaftDebugHistoryLatestDetailRequestId = 'detail-new';
    handleMessage(chunkStore, {
      type: 'yeaft_debug_history_chunk', agentId: 'agent-a', requestId: 'detail-current',
      chunkIndex: 0, chunkCount: 2, data: fullDetail.slice(0, splitAt),
    });
    expect(chunkStore.yeaftDebugTurnOrder).toEqual(['turn-current']);

    const hydrateSessions = {
      live: [],
      applySnapshot: vi.fn(function applySnapshot(rows, agentId, options = {}) {
        this.live.push({ agentId, rows, options });
      }),
      resetInventory: vi.fn(function resetInventory() { this.live = []; }),
      beginInventoryCommit: vi.fn(function beginInventoryCommit(sessionId, agentId) {
        this.live = [];
        this.preferred = { sessionId, agentId };
      }),
    };
    const hydrateStore = {
      _lastPongAt: 0,
      currentAgent: 'agent-b',
      yeaftActiveSessionFilter: 'same',
      resolveYeaftSessionAgentId: vi.fn(() => 'agent-b'),
      yeaftSessionInventoryCompleteSupported: true,
      yeaftSessionHydrateRequestId: 'inventory-2',
      yeaftSessionHydrateSlices: [],
      _hasHandledYeaftSessionHydrate: false,
      yeaftSessionHydrateError: null,
    };
    const previousSessionsStore = globalThis.Pinia.useSessionsStore;
    globalThis.Pinia.useSessionsStore = () => hydrateSessions;
    vi.useFakeTimers();
    try {
      handleMessage(hydrateStore, {
        type: 'yeaft_session_hydrate', requestId: 'inventory-1', agentId: 'agent-a', sessions: [{ id: 'stale' }],
      });
      handleMessage(hydrateStore, {
        type: 'yeaft_session_hydrate', requestId: 'inventory-2', agentId: 'agent-a', sessions: [{ id: 'one' }],
      });
      handleMessage(hydrateStore, {
        type: 'yeaft_session_hydrate', requestId: 'inventory-2', agentId: 'agent-b', sessions: [{ id: 'two' }],
      });
      expect(hydrateSessions.applySnapshot).not.toHaveBeenCalled();
      handleMessage(hydrateStore, {
        type: 'yeaft_session_hydrate_complete', requestId: 'inventory-1', ok: true,
      });
      expect(hydrateStore._hasHandledYeaftSessionHydrate).toBe(false);
      handleMessage(hydrateStore, {
        type: 'yeaft_session_hydrate_complete', requestId: 'inventory-2', ok: true,
      });
      expect(hydrateSessions.beginInventoryCommit).toHaveBeenCalledWith('same', null);
      expect(hydrateStore.resolveYeaftSessionAgentId).not.toHaveBeenCalled();
      expect(hydrateSessions.live).toEqual([
        { agentId: 'agent-a', rows: [{ id: 'one' }], options: { deferActivation: true } },
        { agentId: 'agent-b', rows: [{ id: 'two' }], options: { deferActivation: false } },
      ]);
      expect(hydrateStore._hasHandledYeaftSessionHydrate).toBe(true);

      const duplicateSessions = useSessionsStore();
      duplicateSessions.resetInventory();
      globalThis.Pinia.useSessionsStore = () => duplicateSessions;
      localStorage.setItem('lastViewedYeaftSession', 'agent-b\u001fsame');
      const duplicateStore = {
        currentAgent: 'agent-a',
        yeaftActiveSessionFilter: 'same',
        resolveYeaftSessionAgentId: vi.fn(() => 'agent-a'),
        yeaftSessionInventoryCompleteSupported: true,
        yeaftSessionHydrateRequestId: 'inventory-duplicate',
        yeaftSessionHydrateSlices: [],
        _hasHandledYeaftSessionHydrate: false,
        yeaftSessionHydrateError: null,
      };
      handleMessage(duplicateStore, {
        type: 'yeaft_session_hydrate', requestId: 'inventory-duplicate', agentId: 'agent-a', sessions: [{ id: 'same' }],
      });
      handleMessage(duplicateStore, {
        type: 'yeaft_session_hydrate', requestId: 'inventory-duplicate', agentId: 'agent-b', sessions: [{ id: 'same' }],
      });
      handleMessage(duplicateStore, {
        type: 'yeaft_session_hydrate_complete', requestId: 'inventory-duplicate', ok: true,
      });
      expect(duplicateSessions.activeSessionKey).toBe('agent-b\u001fsame');
      expect(duplicateSessions.activeSession).toMatchObject({ id: 'same', agentId: 'agent-b' });
      expect(duplicateStore.resolveYeaftSessionAgentId).not.toHaveBeenCalled();

      // Restoring an exact Session while Chat is visible must remain non-invasive
      // until the user enters Yeaft. The ordinary, argument-free entry edge must
      // then adopt that exact owner before selecting a visible conversation or
      // sending either Session data-plane or Agent control-plane frames.
      duplicateSessions.resetInventory();
      const previousExactOwnerChatStore = globalThis.Pinia.useChatStore;
      globalThis.Pinia.useChatStore = () => store;
      const productionLoadOpenedSessions = store.loadOpenedYeaftSessionsForConnectedAgents;
      store.loadOpenedYeaftSessionsForConnectedAgents = vi.fn();
      localStorage.setItem('lastViewedYeaftSession', 'agent-b\u001fsame');
      store.currentView = 'chat';
      store._yeaftTransitionActive = false;
      store._savedActiveConversations = null;
      store.currentAgent = 'agent-a';
      store.currentAgentInfo = { id: 'agent-a', name: 'Agent A', workDir: '/repo-a' };
      store.agents = [
        { id: 'agent-a', name: 'Agent A', online: true, workDir: '/repo-a' },
        { id: 'agent-b', name: 'Agent B', online: true, workDir: '/repo-b' },
      ];
      store.conversations = [{
        id: 'chat-entry-a', agentId: 'agent-a', agentName: 'Agent A', workDir: '/repo-a',
      }];
      store.currentWorkDir = '/repo-a';
      store.yeaftActiveSessionFilter = 'same';
      store.yeaftSessionAgentById = { same: 'agent-a' };
      store.yeaftConversationIdsByAgent = { 'agent-a': 'conv-entry-a', 'agent-b': 'conv-entry-b' };
      store.yeaftConversationId = 'conv-entry-a';
      store.activeConversations = ['chat-entry-a'];
      store.messagesMap = {
        'chat-entry-a': [{ id: 'chat-a', type: 'user', content: 'chat A' }],
        'conv-entry-a': [],
        'conv-entry-b': [],
      };
      store.yeaftSessionHistoryState = {};
      store._yeaftHistoryLoad = null;
      store.yeaftSessionReady = false;
      store.yeaftModel = null;
      store.yeaftStatus = null;
      store.yeaftBootstrapMetaLoadingKey = null;
      store.pendingAgentSelection = null;
      store.agentSwitching = false;
      store.sendWsMessage = vi.fn(() => true);
      store.yeaftSessionInventoryCompleteSupported = true;
      store.yeaftSessionHydrateRequestId = 'inventory-exact-owner-off-view';
      store.yeaftSessionHydrateSlices = [];
      store._hasHandledYeaftSessionHydrate = false;
      store.yeaftSessionHydrateError = null;
      handleMessage(store, {
        type: 'yeaft_session_hydrate',
        requestId: 'inventory-exact-owner-off-view',
        agentId: 'agent-a',
        sessions: [{ id: 'same', name: 'Agent A same' }],
      });
      handleMessage(store, {
        type: 'yeaft_session_hydrate',
        requestId: 'inventory-exact-owner-off-view',
        agentId: 'agent-b',
        sessions: [{ id: 'same', name: 'Agent B same' }],
      });
      handleMessage(store, {
        type: 'yeaft_session_hydrate_complete',
        requestId: 'inventory-exact-owner-off-view',
        ok: true,
      });
      expect(duplicateSessions.activeSessionKey).toBe('agent-b\u001fsame');
      expect(store.currentView).toBe('chat');
      expect(store.currentAgent).toBe('agent-a');
      expect(store.currentAgentInfo).toMatchObject({ id: 'agent-a' });
      expect(store.yeaftConversationId).toBe('conv-entry-a');
      expect(store.activeConversations).toEqual(['chat-entry-a']);
      expect(store.sendWsMessage.mock.calls.map(call => call[0]).filter(msg => (
        msg.type === 'yeaft_load_history' || msg.type === 'select_agent'
      ))).toEqual([]);

      store.enterYeaft();
      expect(store.currentView).toBe('yeaft');
      expect(store.currentAgent).toBe('agent-b');
      expect(store.currentAgentInfo).toMatchObject({ id: 'agent-b' });
      expect(store.yeaftActiveSessionFilter).toBe('same');
      expect(store.yeaftSessionAgentById.same).toBe('agent-b');
      expect(store.yeaftConversationId).toBe('conv-entry-b');
      expect(store.activeConversations).toEqual(['conv-entry-b']);
      const ordinaryEntryHistoryFrames = store.sendWsMessage.mock.calls
        .map(call => call[0])
        .filter(msg => msg.type === 'yeaft_load_history');
      expect(ordinaryEntryHistoryFrames).toEqual(expect.arrayContaining([
        expect.objectContaining({ agentId: 'agent-b', sessionId: 'same', limit: 5 }),
      ]));
      expect(store.sendWsMessage.mock.calls.map(call => call[0]).filter(msg => msg.type === 'select_agent')).toEqual([
        expect.objectContaining({ agentId: 'agent-b' }),
      ]);

      store.handleMessage({
        type: 'yeaft_history_chunk',
        agentId: 'agent-b',
        sessionId: 'same',
        conversationId: 'conv-entry-b',
        requestId: ordinaryEntryHistoryFrames[0].requestId,
        mode: 'recent',
        messages: [{
          id: 'entry-history-b', role: 'assistant', content: 'from B', sessionId: 'same', ts: 2,
        }],
        latestSeq: 1,
        oldestSeq: 1,
        hasMore: false,
      });
      expect(store.yeaftConversationId).toBe('conv-entry-b');
      expect(store.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'entry-history-b', content: 'from B', sessionId: 'same' }),
      ]));

      store.handleYeaftOutput({
        agentId: 'agent-b',
        sessionId: 'same',
        event: {
          type: 'session_ready',
          conversationId: 'conv-entry-b',
          sessionId: 'same',
          model: 'agent-b/model',
          availableModels: ['agent-b/model'],
          tasks: [],
        },
      });
      expect(store.currentAgent).toBe('agent-b');
      expect(store.currentAgentInfo).toMatchObject({ id: 'agent-b' });
      expect(store.yeaftConversationId).toBe('conv-entry-b');
      expect(store.activeConversations).toEqual(['conv-entry-b']);
      expect(store.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'entry-history-b', content: 'from B' }),
      ]));

      store.sendWsMessage.mockClear();
      store.sendYeaftSessionMessage({ groupId: 'same', text: 'ordinary entry routes to B' });
      await store.switchYeaftModel('agent-b/next-model');
      expect(store.sendWsMessage.mock.calls.map(call => call[0]).filter(msg => msg.type === 'yeaft_session_send')).toEqual([
        expect.objectContaining({ agentId: 'agent-b', sessionId: 'same', text: 'ordinary entry routes to B' }),
      ]);
      expect(store.sendWsMessage.mock.calls.map(call => call[0]).filter(msg => msg.type === 'yeaft_model_switch')).toEqual([
        expect.objectContaining({ agentId: 'agent-b', model: 'agent-b/next-model' }),
      ]);
      expect(store.messagesMap['conv-entry-b']).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'user', content: 'ordinary entry routes to B' }),
      ]));
      expect(store.messagesMap['conv-entry-a']).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ content: 'ordinary entry routes to B' }),
      ]));
      clearTimeout(store._processingWatchdogs['conv-entry-b']);

      const assertChatIdentityRestored = (bAckBeforeLeave) => {
        const bSelection = store.pendingAgentSelection;
        expect(bSelection).toMatchObject({ agentId: 'agent-b' });
        store.sendWsMessage.mockClear();
        if (bAckBeforeLeave) {
          handleAgentSelected(store, {
            type: 'agent_selected',
            ok: true,
            requestId: bSelection.requestId,
            agentId: 'agent-b',
            agentName: 'Agent B',
            workDir: '/repo-b',
            conversations: [],
          });
          expect(store.sendWsMessage.mock.calls.map(call => call[0]).filter(msg => (
            msg.type === 'select_conversation' && msg.conversationId === 'conv-entry-b'
          ))).toEqual([]);
        }

        store.leaveYeaft();
        const aSelection = store.pendingAgentSelection;
        expect(aSelection).toMatchObject({ agentId: 'agent-a' });
        expect(aSelection.requestId).not.toBe(bSelection.requestId);
        expect(store.currentView).toBe('chat');
        expect(store.currentAgent).toBe('agent-a');
        expect(store.currentAgentInfo).toMatchObject({ id: 'agent-a', workDir: '/repo-a' });
        expect(store.currentConversation).toBe('chat-entry-a');
        expect(store.activeSessionRoute).toMatchObject({ agentId: 'agent-a', sessionId: 'chat-entry-a' });
        expect(store.effectiveWorkDir).toBe('/repo-a');

        if (!bAckBeforeLeave) {
          expect(handleAgentSelected(store, {
            type: 'agent_selected',
            ok: true,
            requestId: bSelection.requestId,
            agentId: 'agent-b',
            agentName: 'Agent B',
            workDir: '/repo-b',
            conversations: [],
          })).toBe(false);
          expect(store.currentAgent).toBe('agent-a');
          expect(store.pendingAgentSelection).toMatchObject({
            agentId: 'agent-a', requestId: aSelection.requestId,
          });
        }

        expect(handleAgentSelected(store, {
          type: 'agent_selected',
          ok: true,
          requestId: aSelection.requestId,
          agentId: 'agent-a',
          agentName: 'Agent A',
          workDir: '/repo-a',
          conversations: [{ id: 'chat-entry-a', workDir: '/repo-a' }],
        })).toBe(true);
        expect(store.pendingAgentSelection).toBeNull();
        expect(store.currentAgent).toBe('agent-a');
        expect(store.currentAgentInfo).toMatchObject({ id: 'agent-a', workDir: '/repo-a' });
        expect(store.currentConversation).toBe('chat-entry-a');
        expect(store.sendWsMessage.mock.calls.map(call => call[0]).filter(msg => (
          msg.type === 'select_conversation'
        ))).toEqual([{ type: 'select_conversation', conversationId: 'chat-entry-a' }]);

        globalThis.Vue = Vue;
        const refs = {
          getEffectiveWorkDir: () => store.effectiveWorkDir,
          treePath: Vue.ref(''),
        };
        const fileOperations = createFileOperations(store, refs);
        fileOperations.newFileType.value = 'file';
        fileOperations.newFileName.value = 'owner.txt';
        fileOperations.confirmNewFile();
        expect(store.sendWsMessage.mock.calls.map(call => call[0]).filter(msg => msg.type === 'create_file')).toEqual([
          expect.objectContaining({
            agentId: 'agent-a',
            conversationId: 'chat-entry-a',
            workDir: '/repo-a',
            filePath: '/repo-a/owner.txt',
          }),
        ]);
        fileOperations.cleanup();
        delete globalThis.Vue;
        store.pendingAgentSelection = null;
        store.agentSwitching = false;
      };

      assertChatIdentityRestored(true);

      // Repeat the same real entry, but let the B acknowledgement arrive only
      // after the user has already returned to Chat. The A restore request must
      // supersede it rather than allowing the old Yeaft selection to win.
      store.sendWsMessage.mockClear();
      store.currentView = 'chat';
      store.currentAgent = 'agent-a';
      store.currentAgentInfo = store.agents[0];
      store.currentWorkDir = '/repo-a';
      store.activeConversations = ['chat-entry-a'];
      store._yeaftTransitionActive = false;
      store._savedActiveConversations = null;
      store.enterYeaft();
      assertChatIdentityRestored(false);

      // A cold persisted Yeaft view has no live Chat snapshot yet. The first
      // online Agent may legitimately be B while the last Chat conversation is
      // owned by A. A B acknowledgement must stay inside the Yeaft control plane,
      // and leaving Yeaft must derive A's full identity from the Chat row before
      // any workbench action can use the restored conversation/workDir.
      const previousPreferredConversationView = localStorage.getItem('yeaft-preferred-conversation-view');
      const previousLastViewedConversation = localStorage.getItem('lastViewedConversation');
      const previousPanels = localStorage.getItem('panels');
      const previousStoreLastViewedConversation = store.lastViewedConversation;
      const productionRequestYeaftSessionBootstrap = store.requestYeaftSessionBootstrap;
      localStorage.setItem('yeaft-preferred-conversation-view', 'yeaft');
      localStorage.setItem('lastViewedConversation', 'chat-cold-a');
      Object.assign(store, createInitialConversationViewState(localStorage));
      store.lastViewedConversation = 'chat-cold-a';
      store.currentAgent = null;
      store.currentAgentInfo = null;
      store.currentWorkDir = null;
      store.agents = [];
      store.conversations = [];
      store.activeConversations = ['conv-cold-b'];
      store.yeaftConversationId = 'conv-cold-b';
      store.yeaftConversationIdsByAgent = { 'agent-b': 'conv-cold-b' };
      store.messagesMap = { 'chat-cold-a': [], 'conv-cold-b': [] };
      store.pendingAgentSelection = null;
      store.agentSwitching = false;
      store._hasHandledAgentList = false;
      store._yeaftAgentSeen = null;
      store.yeaftSessionReady = true;
      store.yeaftModel = 'agent-b/model';
      store.yeaftStatus = { skills: [], mcpServers: [], tools: [] };
      store.requestYeaftSessionBootstrap = vi.fn();
      store.sendWsMessage = vi.fn(() => true);
      handleMessage(store, {
        type: 'agent_list',
        agents: [
          {
            id: 'agent-b', name: 'Agent B', online: true, workDir: '/repo-b', conversations: [],
          },
          {
            id: 'agent-a',
            name: 'Agent A',
            online: true,
            workDir: '/repo-a',
            conversations: [
              { id: 'chat-cold-a', workDir: '/repo-a' },
              { id: 'chat-cold-a-2', workDir: '/repo-a' },
            ],
          },
        ],
      });
      expect(store.currentView).toBe('yeaft');
      expect(store.currentAgent).toBe('agent-b');
      expect(store.currentAgentInfo).toMatchObject({ id: 'agent-b', workDir: '/repo-b' });
      expect(store.conversations).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'chat-cold-a', agentId: 'agent-a', workDir: '/repo-a' }),
        expect.objectContaining({ id: 'chat-cold-a-2', agentId: 'agent-a', workDir: '/repo-a' }),
      ]));

      const persistedAgentAPanels = [
        { id: 'panel-a-1', conversationId: 'chat-cold-a' },
        { id: 'panel-a-2', conversationId: 'chat-cold-a-2' },
      ];
      localStorage.setItem('panels', JSON.stringify(persistedAgentAPanels));
      store.panels = [];
      store.activePanelId = null;
      store.pendingAgentSelection = { agentId: 'agent-b', requestId: 'cold-agent-b-selection' };
      store.agentSwitching = true;
      store.sendWsMessage.mockClear();
      expect(handleAgentSelected(store, {
        type: 'agent_selected',
        ok: true,
        requestId: 'cold-agent-b-selection',
        agentId: 'agent-b',
        agentName: 'Agent B',
        workDir: '/repo-b',
        conversations: [],
      })).toBe(true);
      expect(store.currentView).toBe('yeaft');
      expect(store.currentAgent).toBe('agent-b');
      expect(store.yeaftConversationId).toBe('conv-cold-b');
      expect(store.activeConversations).toEqual(['conv-cold-b']);
      expect(store.panels).toEqual([]);
      expect(store.activePanelId).toBeNull();
      expect(store.currentWorkDir).toBeNull();
      expect(store.sendWsMessage.mock.calls.map(call => call[0]).filter(msg => (
        msg.type === 'select_conversation'
        || msg.type === 'sync_messages'
        || msg.type === 'refresh_conversation'
      ))).toEqual([]);

      // The same ACK may arrive before session_ready has supplied a Yeaft bridge
      // conversation. Persisted A panels still belong to Chat and must not become
      // the compatibility currentConversation or seed Chat history on Agent B.
      store.panels = [];
      store.activePanelId = null;
      store.activeConversations = [];
      store.yeaftConversationId = null;
      store.yeaftSessionReady = false;
      store.currentWorkDir = null;
      store.messagesMap['chat-cold-a'] = [];
      store.messagesMap['chat-cold-a-2'] = [];
      store.pendingAgentSelection = { agentId: 'agent-b', requestId: 'pre-ready-agent-b-selection' };
      store.agentSwitching = true;
      store.sendWsMessage.mockClear();
      expect(handleAgentSelected(store, {
        type: 'agent_selected',
        ok: true,
        requestId: 'pre-ready-agent-b-selection',
        agentId: 'agent-b',
        agentName: 'Agent B',
        workDir: '/repo-b',
        conversations: [],
      })).toBe(true);
      expect(store.currentView).toBe('yeaft');
      expect(store.currentAgent).toBe('agent-b');
      expect(store.currentConversation).toBeNull();
      expect(store.activeConversations).toEqual([]);
      expect(store.panels).toEqual([]);
      expect(store.activePanelId).toBeNull();
      expect(store.currentWorkDir).toBeNull();
      expect(store.sendWsMessage.mock.calls.map(call => call[0]).filter(msg => (
        msg.type === 'select_conversation'
        || msg.type === 'sync_messages'
        || msg.type === 'refresh_conversation'
      ))).toEqual([]);

      // A real reconnect edge must not amplify an A panel into Agent B's server
      // conversation context. recoveryDismissed isolates this panel-derived path
      // from the older explicit last-viewed recovery state machine.
      store.sendWsMessage.mockClear();
      store._yeaftReconnectCatchUpPending = true;
      store.recoveryDismissed = true;
      handleMessage(store, {
        type: 'agent_list',
        agents: [
          { id: 'agent-b', name: 'Agent B', online: true, workDir: '/repo-b', conversations: [] },
          {
            id: 'agent-a', name: 'Agent A', online: true, workDir: '/repo-a',
            conversations: [
              { id: 'chat-cold-a', workDir: '/repo-a' },
              { id: 'chat-cold-a-2', workDir: '/repo-a' },
            ],
          },
        ],
      });
      expect(store.currentConversation).toBeNull();
      expect(store.panels).toEqual([]);
      expect(store.sendWsMessage.mock.calls.map(call => call[0]).filter(msg => (
        msg.type === 'select_conversation'
        || msg.type === 'sync_messages'
        || msg.type === 'refresh_conversation'
      ))).toEqual([]);

      // With no Yeaft bridge conversation yet, workbench actions must use the
      // explicit Agent-level explorer identity, never an A Chat conversation.
      store.sendWsMessage.mockClear();
      globalThis.Vue = Vue;
      const preReadyFileOperations = createFileOperations(store, {
        getEffectiveWorkDir: () => '/repo-b',
        treePath: Vue.ref(''),
      });
      preReadyFileOperations.newFileType.value = 'file';
      preReadyFileOperations.newFileName.value = 'ack-owner.txt';
      preReadyFileOperations.confirmNewFile();
      const gitOperating = Vue.ref(false);
      const preReadyGitOperations = createGitOperations(store, {
        effectiveGitWorkDir: Vue.ref('/repo-b'),
        gitOperating,
        gitOpFeedback: Vue.ref(null),
        commitMessage: Vue.ref(''),
      });
      preReadyGitOperations.loadGitStatus(Vue.ref(false), Vue.ref(''));
      expect(store.sendWsMessage.mock.calls.map(call => call[0]).filter(msg => (
        msg.type === 'create_file' || msg.type === 'git_status'
      ))).toEqual([
        expect.objectContaining({
          type: 'create_file', agentId: 'agent-b', conversationId: '_explorer', workDir: '/repo-b',
        }),
        expect.objectContaining({
          type: 'git_status', agentId: 'agent-b', conversationId: '_explorer', workDir: '/repo-b',
        }),
      ]);
      expect(store.currentConversation).toBeNull();
      preReadyFileOperations.cleanup();
      preReadyGitOperations.cleanup();
      delete globalThis.Vue;
      store.recoveryDismissed = false;

      // Restore the bridge-ready state before exercising the cold Chat return.
      store.yeaftConversationId = 'conv-cold-b';
      store.activeConversations = ['conv-cold-b'];
      store.yeaftSessionReady = true;
      store.sendWsMessage.mockClear();
      store.leaveYeaft();
      const coldAgentASelection = store.pendingAgentSelection;
      expect(coldAgentASelection).toMatchObject({ agentId: 'agent-a' });
      expect(store.currentView).toBe('chat');
      expect(store.currentAgent).toBe('agent-a');
      expect(store.currentAgentInfo).toMatchObject({ id: 'agent-a', workDir: '/repo-a' });
      expect(store.currentConversation).toBe('chat-cold-a');
      expect(store.activeSessionRoute).toMatchObject({ agentId: 'agent-a', sessionId: 'chat-cold-a' });
      expect(store.effectiveWorkDir).toBe('/repo-a');
      expect(handleAgentSelected(store, {
        type: 'agent_selected',
        ok: true,
        requestId: coldAgentASelection.requestId,
        agentId: 'agent-a',
        agentName: 'Agent A',
        workDir: '/repo-a',
        conversations: [{ id: 'chat-cold-a', workDir: '/repo-a' }],
      })).toBe(true);
      expect(store.pendingAgentSelection).toBeNull();
      expect(store.currentAgent).toBe('agent-a');
      expect(store.currentConversation).toBe('chat-cold-a');

      store.sendWsMessage.mockClear();
      globalThis.Vue = Vue;
      const coldFileOperations = createFileOperations(store, {
        getEffectiveWorkDir: () => store.effectiveWorkDir,
        treePath: Vue.ref(''),
      });
      coldFileOperations.newFileType.value = 'file';
      coldFileOperations.newFileName.value = 'cold-owner.txt';
      coldFileOperations.confirmNewFile();
      expect(store.sendWsMessage.mock.calls.map(call => call[0]).filter(msg => msg.type === 'create_file')).toEqual([
        expect.objectContaining({
          agentId: 'agent-a',
          conversationId: 'chat-cold-a',
          workDir: '/repo-a',
          filePath: '/repo-a/cold-owner.txt',
        }),
      ]);
      coldFileOperations.cleanup();
      delete globalThis.Vue;

      // A persisted Chat row is not enough by itself. If its owner is absent or
      // offline, fail closed instead of pairing that conversation/workDir with
      // the currently active Yeaft Agent.
      localStorage.setItem('yeaft-preferred-conversation-view', 'yeaft');
      localStorage.setItem('lastViewedConversation', 'chat-offline-a');
      Object.assign(store, createInitialConversationViewState(localStorage));
      store.lastViewedConversation = 'chat-offline-a';
      store.currentAgent = 'agent-b';
      store.currentAgentInfo = { id: 'agent-b', name: 'Agent B', workDir: '/repo-b' };
      store.currentWorkDir = null;
      store.agents = [
        { id: 'agent-b', name: 'Agent B', online: true, workDir: '/repo-b' },
        { id: 'agent-a', name: 'Agent A', online: false, workDir: '/repo-a' },
      ];
      store.conversations = [{
        id: 'chat-offline-a', agentId: 'agent-a', agentName: 'Agent A', workDir: '/repo-a',
      }];
      store.activeConversations = ['conv-cold-b'];
      store.yeaftConversationId = 'conv-cold-b';
      store.pendingAgentSelection = null;
      store.agentSwitching = false;
      store.sendWsMessage.mockClear();
      store.leaveYeaft();
      expect(store.currentView).toBe('chat');
      expect(store.currentAgent).toBe('agent-b');
      expect(store.currentConversation).toBeNull();
      expect(store.currentWorkDir).toBeNull();
      expect(store.pendingAgentSelection).toBeNull();
      expect(store.sendWsMessage.mock.calls.map(call => call[0]).filter(msg => (
        msg.type === 'select_agent'
        || msg.type === 'select_conversation'
        || msg.type === 'sync_messages'
        || msg.type === 'refresh_conversation'
      ))).toEqual([]);

      store.requestYeaftSessionBootstrap = productionRequestYeaftSessionBootstrap;
      store.lastViewedConversation = previousStoreLastViewedConversation;
      if (previousPreferredConversationView == null) {
        localStorage.removeItem('yeaft-preferred-conversation-view');
      } else {
        localStorage.setItem('yeaft-preferred-conversation-view', previousPreferredConversationView);
      }
      if (previousLastViewedConversation == null) {
        localStorage.removeItem('lastViewedConversation');
      } else {
        localStorage.setItem('lastViewedConversation', previousLastViewedConversation);
      }
      if (previousPanels == null) {
        localStorage.removeItem('panels');
      } else {
        localStorage.setItem('panels', previousPanels);
      }
      store.panels = [];
      store.activePanelId = null;
      store.yeaftConversationIdsByAgent = { 'agent-a': 'conv-entry-a', 'agent-b': 'conv-entry-b' };
      store.yeaftConversationId = 'conv-entry-a';
      store.conversations = [{
        id: 'chat-entry-a', agentId: 'agent-a', agentName: 'Agent A', workDir: '/repo-a',
      }];
      store.messagesMap = {
        'chat-entry-a': [{ id: 'chat-a', type: 'user', content: 'chat A' }],
        'conv-entry-a': [],
        'conv-entry-b': [],
      };
      store.pendingAgentSelection = null;
      store.agentSwitching = false;

      // A caller that explicitly selects an Agent remains authoritative. These
      // call sites defer bootstrap while they establish the target Session, so
      // the exact B identity must not override the requested Agent A or emit B
      // history during this intermediate entry step.
      store.sendWsMessage.mockClear();
      store.currentView = 'chat';
      store._yeaftTransitionActive = false;
      store._savedActiveConversations = null;
      store.activeConversations = ['chat-entry-a'];
      store.enterYeaft('agent-a', { deferBootstrap: true });
      expect(store.currentAgent).toBe('agent-a');
      expect(store.currentAgentInfo).toMatchObject({ id: 'agent-a' });
      expect(store.yeaftConversationId).toBe('conv-entry-a');
      expect(store.activeConversations).toEqual(['conv-entry-a']);
      expect(store.sendWsMessage.mock.calls.map(call => call[0]).filter(msg => (
        msg.type === 'select_agent' && msg.agentId !== 'agent-a'
      ))).toEqual([]);
      expect(store.sendWsMessage.mock.calls.map(call => call[0]).filter(msg => msg.type === 'yeaft_load_history')).toEqual([]);
      store.pendingAgentSelection = null;
      store.agentSwitching = false;
      store._yeaftTransitionActive = false;
      store._savedActiveConversations = null;
      store.loadOpenedYeaftSessionsForConnectedAgents = productionLoadOpenedSessions;

      // An exact persisted owner that still exists must be restored through the
      // same atomic Chat activation seam as a user click. Updating only the
      // Sessions pointer leaves Agent A visible while the next message routes to
      // Agent B and lands in B's hidden optimistic conversation.
      duplicateSessions.resetInventory();
      globalThis.Pinia.useChatStore = () => store;
      localStorage.setItem('lastViewedYeaftSession', 'agent-b\u001fsame');
      store.currentView = 'yeaft';
      store.currentAgent = 'agent-a';
      store.currentAgentInfo = { id: 'agent-a' };
      store.agents = [
        { id: 'agent-a', name: 'Agent A', online: true },
        { id: 'agent-b', name: 'Agent B', online: true },
      ];
      store.yeaftActiveSessionFilter = 'same';
      store.yeaftSessionAgentById = { same: 'agent-a' };
      store.yeaftConversationIdsByAgent = { 'agent-a': 'conv-exact-a', 'agent-b': 'conv-exact-b' };
      store.yeaftConversationId = 'conv-exact-a';
      store.activeConversations = ['conv-exact-a'];
      store.messagesMap = { 'conv-exact-a': [], 'conv-exact-b': [] };
      store.yeaftSessionHistoryState = {};
      store._yeaftHistoryLoad = null;
      store.sendWsMessage = vi.fn(() => true);
      store.yeaftSessionInventoryCompleteSupported = true;
      store.yeaftSessionHydrateRequestId = 'inventory-exact-owner-present';
      store.yeaftSessionHydrateSlices = [];
      store._hasHandledYeaftSessionHydrate = false;
      store.yeaftSessionHydrateError = null;
      handleMessage(store, {
        type: 'yeaft_session_hydrate',
        requestId: 'inventory-exact-owner-present',
        agentId: 'agent-a',
        sessions: [{ id: 'same', name: 'Agent A same' }],
      });
      handleMessage(store, {
        type: 'yeaft_session_hydrate',
        requestId: 'inventory-exact-owner-present',
        agentId: 'agent-b',
        sessions: [{ id: 'same', name: 'Agent B same' }],
      });
      handleMessage(store, {
        type: 'yeaft_session_hydrate_complete',
        requestId: 'inventory-exact-owner-present',
        ok: true,
      });
      expect(duplicateSessions.activeSessionKey).toBe('agent-b\u001fsame');
      expect(duplicateSessions.activeSession).toMatchObject({ id: 'same', agentId: 'agent-b' });
      expect(store.currentAgent).toBe('agent-b');
      expect(store.yeaftActiveSessionFilter).toBe('same');
      expect(store.yeaftSessionAgentById.same).toBe('agent-b');
      expect(store.yeaftConversationId).toBe('conv-exact-b');
      expect(store.activeConversations).toEqual(['conv-exact-b']);
      expect(localStorage.getItem('lastViewedYeaftSession')).toBe('agent-b\u001fsame');
      const restoredExactOwnerHistoryFrames = store.sendWsMessage.mock.calls
        .map(call => call[0])
        .filter(msg => msg.type === 'yeaft_load_history');
      expect(restoredExactOwnerHistoryFrames).toEqual([
        expect.objectContaining({ agentId: 'agent-b', sessionId: 'same', limit: 5 }),
      ]);
      const exactOwnerHistoryFrame = restoredExactOwnerHistoryFrames[0];
      expect(exactOwnerHistoryFrame).toEqual(
        expect.objectContaining({ agentId: 'agent-b', sessionId: 'same' }),
      );
      store.handleMessage({
        type: 'yeaft_history_chunk',
        agentId: 'agent-b',
        sessionId: 'same',
        conversationId: 'conv-exact-b',
        requestId: exactOwnerHistoryFrame.requestId,
        mode: 'recent',
        messages: [],
        latestSeq: 0,
        oldestSeq: null,
        hasMore: false,
      });
      store.sendWsMessage.mockClear();
      store.sendYeaftSessionMessage({ groupId: 'same', text: 'restore exact owner' });
      expect(store.sendWsMessage.mock.calls.map(call => call[0]).filter(msg => msg.type === 'yeaft_session_send')).toEqual([
        expect.objectContaining({ agentId: 'agent-b', sessionId: 'same', text: 'restore exact owner' }),
      ]);
      expect(store.messagesMap['conv-exact-b']).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'user', content: 'restore exact owner' }),
      ]));
      expect(store.messagesMap['conv-exact-a']).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ content: 'restore exact owner' }),
      ]));
      clearTimeout(store._processingWatchdogs['conv-exact-b']);

      // If the visible Chat store cannot perform that atomic activation, fail
      // closed instead of committing only the Sessions pointer.
      duplicateSessions.resetInventory();
      localStorage.setItem('lastViewedYeaftSession', 'agent-b\u001fsame');
      const noAtomicActivationStore = {
        currentView: 'yeaft',
        yeaftActiveSessionFilter: 'same',
        yeaftSessionAgentById: { same: 'agent-b' },
        pinnedSessions: [],
        applyServerPinSnapshot: vi.fn(),
      };
      globalThis.Pinia.useChatStore = () => noAtomicActivationStore;
      duplicateSessions.beginInventoryCommit('same', 'agent-b');
      duplicateSessions.applySnapshot([{ id: 'same', name: 'Agent B same' }], 'agent-b');
      expect(duplicateSessions.activeSessionKey).toBeNull();
      expect(duplicateSessions.activeSessionId).toBeNull();
      expect(noAtomicActivationStore.yeaftActiveSessionFilter).toBeNull();
      // The completed inventory may retain truthful routing metadata; it must
      // not turn that metadata into an active or persisted selection.
      expect(noAtomicActivationStore.yeaftSessionAgentById.same).toBe('agent-b');
      expect(localStorage.getItem('lastViewedYeaftSession')).toBeNull();
      globalThis.Pinia.useChatStore = () => store;

      // A persisted composite identity is authoritative. If its exact owner is
      // absent from the complete inventory, do not silently bind the same bare
      // id to another Agent. Clear selection and wait for an explicit click.
      duplicateSessions.resetInventory();
      localStorage.setItem('lastViewedYeaftSession', 'agent-b\u001fsame');
      store.currentView = 'yeaft';
      store.currentAgent = 'agent-b';
      store.currentAgentInfo = { id: 'agent-b' };
      store.agents = [
        { id: 'agent-a', name: 'Agent A', online: true },
        { id: 'agent-b', name: 'Agent B', online: true },
      ];
      store.yeaftActiveSessionFilter = 'same';
      store.yeaftSessionAgentById = { same: 'agent-b' };
      store.yeaftConversationIdsByAgent = { 'agent-a': 'conv-exact-a', 'agent-b': 'conv-exact-b' };
      store.yeaftConversationId = 'conv-exact-b';
      store.activeConversations = ['conv-exact-b'];
      store.messagesMap = { 'conv-exact-a': [], 'conv-exact-b': [] };
      store.yeaftSessionHistoryState = {};
      store._yeaftHistoryLoad = null;
      store.sendWsMessage = vi.fn(() => true);
      store.yeaftSessionInventoryCompleteSupported = true;
      store.yeaftSessionHydrateRequestId = 'inventory-exact-owner-absent';
      store.yeaftSessionHydrateSlices = [];
      store._hasHandledYeaftSessionHydrate = false;
      store.yeaftSessionHydrateError = null;
      handleMessage(store, {
        type: 'yeaft_session_hydrate',
        requestId: 'inventory-exact-owner-absent',
        agentId: 'agent-a',
        sessions: [{ id: 'same', name: 'Agent A same' }],
      });
      handleMessage(store, {
        type: 'yeaft_session_hydrate_complete',
        requestId: 'inventory-exact-owner-absent',
        ok: true,
      });
      expect(duplicateSessions.activeSessionKey).toBeNull();
      expect(duplicateSessions.activeSessionId).toBeNull();
      expect(store.yeaftActiveSessionFilter).toBeNull();
      expect(store.currentAgent).toBe('agent-b');
      expect(store.yeaftConversationId).toBe('conv-exact-b');
      expect(store.activeConversations).toEqual(['conv-exact-b']);
      expect(localStorage.getItem('lastViewedYeaftSession')).toBeNull();
      expect(store.sendWsMessage.mock.calls.map(call => call[0]).filter(msg => (
        msg.type === 'yeaft_load_history' || msg.type === 'yeaft_session_send'
      ))).toEqual([]);
      expect(store.messagesMap['conv-exact-a']).toEqual([]);
      expect(store.messagesMap['conv-exact-b']).toEqual([]);

      // Explicit user selection is the only legal cross-owner transition.
      store.setActiveSessionFilter('same', { agentId: 'agent-a', force: true });
      expect(duplicateSessions.activeSessionKey).toBe('agent-a\u001fsame');
      const exactOwnerHistoryFrames = store.sendWsMessage.mock.calls
        .map(call => call[0])
        .filter(msg => msg.type === 'yeaft_load_history');
      expect(exactOwnerHistoryFrames).toEqual([
        expect.objectContaining({ agentId: 'agent-a', sessionId: 'same', limit: 5 }),
      ]);
      const agentAHistoryFrame = exactOwnerHistoryFrames[0];
      expect(agentAHistoryFrame).toEqual(
        expect.objectContaining({ agentId: 'agent-a', sessionId: 'same' }),
      );
      store.handleMessage({
        type: 'yeaft_history_chunk',
        agentId: 'agent-a',
        sessionId: 'same',
        conversationId: 'conv-exact-a',
        requestId: agentAHistoryFrame.requestId,
        mode: 'recent',
        messages: [],
        latestSeq: 0,
        oldestSeq: null,
        hasMore: false,
      });
      store.sendWsMessage.mockClear();
      store.sendYeaftSessionMessage({ groupId: 'same', text: 'explicit owner transition' });
      expect(store.sendWsMessage.mock.calls.map(call => call[0]).filter(msg => msg.type === 'yeaft_session_send')).toEqual([
        expect.objectContaining({ agentId: 'agent-a', sessionId: 'same', text: 'explicit owner transition' }),
      ]);
      expect(store.messagesMap['conv-exact-a']).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'user', content: 'explicit owner transition' }),
      ]));
      expect(store.messagesMap['conv-exact-b']).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ content: 'explicit owner transition' }),
      ]));
      clearTimeout(store._processingWatchdogs['conv-exact-a']);
      if (previousExactOwnerChatStore) globalThis.Pinia.useChatStore = previousExactOwnerChatStore;
      else delete globalThis.Pinia.useChatStore;
      localStorage.removeItem('lastViewedYeaftSession');

      // A persisted bare id carries no owner authority. The complete inventory
      // may recover it only when exactly one stamped owner exists.
      duplicateSessions.resetInventory();
      localStorage.setItem('lastViewedYeaftSession', 'legacy-only');
      const legacyIdentityStore = {
        currentAgent: 'agent-a',
        yeaftActiveSessionFilter: null,
        resolveYeaftSessionAgentId: vi.fn(() => 'agent-b'),
        yeaftSessionInventoryCompleteSupported: true,
        yeaftSessionHydrateRequestId: 'inventory-legacy-id',
        yeaftSessionHydrateSlices: [],
        _hasHandledYeaftSessionHydrate: false,
        yeaftSessionHydrateError: null,
      };
      const previousInventoryChatStore = globalThis.Pinia.useChatStore;
      const inventoryChatStore = {
        currentView: 'yeaft',
        yeaftActiveSessionFilter: null,
        yeaftSessionAgentById: {},
        pinnedSessions: [],
        setActiveSessionFilter: vi.fn((sessionId, options = {}) => {
          inventoryChatStore.yeaftActiveSessionFilter = sessionId;
          duplicateSessions.setActive(sessionId, options.agentId || null);
        }),
        applyServerPinSnapshot: vi.fn(),
      };
      globalThis.Pinia.useChatStore = () => inventoryChatStore;
      handleMessage(legacyIdentityStore, {
        type: 'yeaft_session_hydrate', requestId: 'inventory-legacy-id', agentId: 'agent-b', sessions: [{ id: 'legacy-only' }],
      });
      handleMessage(legacyIdentityStore, {
        type: 'yeaft_session_hydrate_complete', requestId: 'inventory-legacy-id', ok: true,
      });
      expect(legacyIdentityStore.resolveYeaftSessionAgentId).not.toHaveBeenCalled();
      expect(duplicateSessions.activeSessionKey).toBe('agent-b\u001flegacy-only');
      expect(inventoryChatStore.setActiveSessionFilter).toHaveBeenLastCalledWith(
        'legacy-only',
        { agentId: 'agent-b', force: true },
      );

      duplicateSessions.resetInventory();
      inventoryChatStore.yeaftActiveSessionFilter = null;
      inventoryChatStore.setActiveSessionFilter.mockClear();
      legacyIdentityStore.yeaftSessionHydrateRequestId = 'inventory-legacy-ambiguous';
      legacyIdentityStore.yeaftSessionHydrateSlices = [];
      legacyIdentityStore._hasHandledYeaftSessionHydrate = false;
      handleMessage(legacyIdentityStore, {
        type: 'yeaft_session_hydrate', requestId: 'inventory-legacy-ambiguous', agentId: 'agent-a', sessions: [{ id: 'legacy-only' }],
      });
      handleMessage(legacyIdentityStore, {
        type: 'yeaft_session_hydrate', requestId: 'inventory-legacy-ambiguous', agentId: 'agent-b', sessions: [{ id: 'legacy-only' }],
      });
      handleMessage(legacyIdentityStore, {
        type: 'yeaft_session_hydrate_complete', requestId: 'inventory-legacy-ambiguous', ok: true,
      });
      expect(legacyIdentityStore.resolveYeaftSessionAgentId).not.toHaveBeenCalled();
      expect(duplicateSessions.activeSessionKey).toBeNull();
      expect(duplicateSessions.activeSessionId).toBeNull();
      expect(duplicateSessions.sessionList.filter(row => row.id === 'legacy-only')).toHaveLength(2);
      expect(inventoryChatStore.setActiveSessionFilter).not.toHaveBeenCalled();
      expect(inventoryChatStore.yeaftActiveSessionFilter).toBeNull();

      duplicateSessions.resetInventory();
      inventoryChatStore.setActiveSessionFilter.mockClear();
      inventoryChatStore.yeaftActiveSessionFilter = null;
      localStorage.setItem('lastViewedYeaftSession', 'legacy-only');
      legacyIdentityStore.yeaftSessionHydrateRequestId = 'inventory-legacy-wire';
      legacyIdentityStore.yeaftSessionHydrateSlices = [];
      legacyIdentityStore._hasHandledYeaftSessionHydrate = false;
      handleMessage(legacyIdentityStore, {
        type: 'yeaft_session_hydrate', requestId: 'inventory-legacy-wire', sessions: [{ id: 'legacy-only' }],
      });
      handleMessage(legacyIdentityStore, {
        type: 'yeaft_session_hydrate_complete', requestId: 'inventory-legacy-wire', ok: true,
      });
      expect(duplicateSessions.inventoryIdentityMode).toBe('legacy-bare');
      expect(duplicateSessions.activeSessionKey).toBe('legacy-only');
      expect(inventoryChatStore.setActiveSessionFilter.mock.calls).toEqual([
        ['legacy-only', { force: true }],
      ]);
      if (previousInventoryChatStore) globalThis.Pinia.useChatStore = previousInventoryChatStore;
      else delete globalThis.Pinia.useChatStore;
      localStorage.removeItem('lastViewedYeaftSession');

      const legacySessions = useSessionsStore();
      legacySessions.resetInventory();
      legacySessions.applySnapshot([{
        id: 'legacy-bare', name: 'Legacy bare', roster: ['omni'], defaultVpId: 'omni',
      }], null);
      expect(legacySessions.sessions['legacy-bare']).toMatchObject({
        id: 'legacy-bare', agentId: null, roster: ['omni'],
      });
      expect(legacySessions.sessionById('legacy-bare', 'agent-a')).toMatchObject({
        id: 'legacy-bare', agentId: null, roster: ['omni'],
      });
      expect(resolveTimelineSession(legacySessions, 'legacy-bare', 'agent-a')).toMatchObject({
        id: 'legacy-bare', roster: ['omni'],
      });
      legacySessions.applyRosterChange({
        sessionId: 'legacy-bare', roster: ['omni', 'reviewer'], defaultVpId: 'omni',
      });
      legacySessions.applySnapshotUpsert({ id: 'legacy-extra', name: 'Legacy extra' });
      expect(legacySessions.sessionById('legacy-bare', 'agent-a')).toMatchObject({
        roster: ['omni', 'reviewer'],
      });
      expect(legacySessions.sessionById('legacy-extra', 'agent-a')).toMatchObject({
        id: 'legacy-extra', agentId: null,
      });

      legacySessions.setActive('legacy-bare', 'agent-a');
      legacySessions.applySnapshotUpsert({ id: 'legacy-bare', name: 'Agent A same' }, 'agent-a');
      legacySessions.applySnapshotUpsert({ id: 'stamped', name: 'Stamped' }, 'agent-a');
      expect(legacySessions.inventoryIdentityMode).toBe('agent-scoped');
      expect(legacySessions.sessions['legacy-bare']).toMatchObject({
        id: 'legacy-bare', agentId: null,
      });
      expect(legacySessions.sessionOrder).not.toContain('legacy-bare');
      expect(legacySessions.sessionList).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'legacy-bare', agentId: null }),
      ]));
      expect(legacySessions.activeSessionKey).toBe('agent-a\u001flegacy-bare');
      expect(legacySessions.activeSession).toMatchObject({
        id: 'legacy-bare', agentId: 'agent-a', name: 'Agent A same',
      });
      const scopedSidebarRows = buildYeaftSidebarSessionList({
        sessions: legacySessions.sessionList,
        activeSessionId: legacySessions.activeSessionId,
        activeSessionKey: legacySessions.activeSessionKey,
        pinnedSessionIds: [],
      });
      expect(scopedSidebarRows.filter(row => row.id === 'legacy-bare')).toEqual([
        expect.objectContaining({ active: true, raw: expect.objectContaining({ agentId: 'agent-a' }) }),
      ]);
      expect(scopedSidebarRows[0].raw.agentId && scopedSidebarRows[0].id).toBeTruthy();
      expect(legacySessions.sessionById('legacy-bare', 'agent-a')).toMatchObject({
        id: 'legacy-bare', agentId: 'agent-a',
      });
      expect(legacySessions.sessionById('legacy-bare', 'agent-b')).toBeNull();
      expect(legacySessions.sessionById('stamped', 'agent-a')).toMatchObject({
        id: 'stamped', agentId: 'agent-a',
      });

      // Before any user selects the unique replacement, a second stamped owner
      // makes the retired bare identity ambiguous. Clear the automatic active
      // pointer and do not let a bare lookup choose either owner.
      localStorage.setItem('lastViewedYeaftSession', 'agent-a\u001flegacy-bare');
      legacySessions.applySnapshotUpsert({ id: 'legacy-bare', name: 'Agent B same' }, 'agent-b');
      expect(localStorage.getItem('lastViewedYeaftSession')).toBeNull();
      expect(legacySessions.sessionOrder.filter(key => legacySessions.sessions[key]?.id === 'legacy-bare')).toEqual([
        'agent-a\u001flegacy-bare',
        'agent-b\u001flegacy-bare',
      ]);
      expect(legacySessions.sessionList.filter(row => row.id === 'legacy-bare')).toHaveLength(2);
      expect(legacySessions.sessionList.some(row => !row.agentId)).toBe(false);
      const ambiguousSidebarRows = buildYeaftSidebarSessionList({
        sessions: legacySessions.sessionList,
        activeSessionId: legacySessions.activeSessionId,
        activeSessionKey: legacySessions.activeSessionKey,
        pinnedSessionIds: [],
      });
      expect(ambiguousSidebarRows.filter(row => row.active)).toHaveLength(0);
      expect(legacySessions.activeSessionKey).toBeNull();
      expect(legacySessions.activeSessionId).toBeNull();
      legacySessions.setActive('legacy-bare');
      expect(legacySessions.activeSessionKey).toBeNull();

      // Once the ambiguous B candidate is authoritatively removed, the sole A
      // candidate is again safe to recover as the retired bare active identity.
      legacySessions.applySnapshot([], 'agent-b');
      expect(legacySessions.activeSessionKey).toBe('agent-a\u001flegacy-bare');
      expect(legacySessions.activeSessionId).toBe('legacy-bare');
      const recoveredSidebarRows = buildYeaftSidebarSessionList({
        sessions: legacySessions.sessionList,
        activeSessionId: legacySessions.activeSessionId,
        activeSessionKey: legacySessions.activeSessionKey,
        pinnedSessionIds: [],
      });
      expect(recoveredSidebarRows.filter(row => row.active)).toEqual([
        expect.objectContaining({ raw: expect.objectContaining({ agentId: 'agent-a' }) }),
      ]);

      // The migrated exact identity must drive history and the next send. The
      // retired bare cache entry is not allowed to fall back to currentAgent.
      globalThis.Pinia.useSessionsStore = () => legacySessions;
      const previousChatStoreForRouting = globalThis.Pinia.useChatStore;
      globalThis.Pinia.useChatStore = () => store;
      store.currentView = 'yeaft';
      store.currentAgent = 'agent-b';
      store.currentAgentInfo = { id: 'agent-b' };
      store.agents = [
        { id: 'agent-a', name: 'Agent A', online: true },
        { id: 'agent-b', name: 'Agent B', online: true },
      ];
      store.yeaftActiveSessionFilter = null;
      store.yeaftSessionAgentById = {};
      store.yeaftConversationIdsByAgent = { 'agent-a': 'conv-agent-a', 'agent-b': 'conv-agent-b' };
      store.yeaftConversationId = 'conv-agent-b';
      store.activeConversations = ['conv-agent-b'];
      store.messagesMap = { 'conv-agent-a': [], 'conv-agent-b': [] };
      store.yeaftSessionHistoryState = {};
      store.sendWsMessage = vi.fn(() => true);
      store.setActiveSessionFilter('legacy-bare', { agentId: 'agent-a', force: true });
      expect(legacySessions.activeSessionKey).toBe('agent-a\u001flegacy-bare');
      const migratedHistoryFrames = store.sendWsMessage.mock.calls
        .map(call => call[0])
        .filter(msg => msg.type === 'yeaft_load_history');
      expect(migratedHistoryFrames).toEqual([
        expect.objectContaining({ agentId: 'agent-a', sessionId: 'legacy-bare', limit: 5 }),
      ]);
      const migratedHistoryFrame = migratedHistoryFrames[0];
      expect(migratedHistoryFrame).toEqual(
        expect.objectContaining({ agentId: 'agent-a', sessionId: 'legacy-bare' }),
      );
      store.handleMessage({
        type: 'yeaft_history_chunk',
        agentId: 'agent-a',
        sessionId: 'legacy-bare',
        conversationId: 'conv-agent-a',
        requestId: migratedHistoryFrame.requestId,
        mode: 'recent',
        messages: [],
        latestSeq: 0,
        oldestSeq: null,
        hasMore: false,
      });
      store.sendWsMessage.mockClear();
      store.sendYeaftSessionMessage({ groupId: 'legacy-bare', text: 'route migrated identity' });
      expect(store.sendWsMessage.mock.calls.map(call => call[0]).filter(msg => msg.type === 'yeaft_session_send')).toEqual([
        expect.objectContaining({ agentId: 'agent-a', sessionId: 'legacy-bare', text: 'route migrated identity' }),
      ]);
      expect(store.messagesMap['conv-agent-a']).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'user', content: 'route migrated identity' }),
      ]));
      expect(store.messagesMap['conv-agent-b']).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ content: 'route migrated identity' }),
      ]));
      clearTimeout(store._processingWatchdogs['conv-agent-a']);
      if (previousChatStoreForRouting) globalThis.Pinia.useChatStore = previousChatStoreForRouting;
      else delete globalThis.Pinia.useChatStore;

      // An explicit user selection is authoritative after automatic migration.
      // Adding another same-id owner must not erase that exact selection.
      legacySessions.applySnapshotUpsert({ id: 'legacy-bare', name: 'Agent B same' }, 'agent-b');
      expect(legacySessions.activeSessionKey).toBe('agent-a\u001flegacy-bare');
      legacySessions.setActive('legacy-bare', 'agent-b');
      expect(legacySessions.activeSessionKey).toBe('agent-b\u001flegacy-bare');
      const explicitlySelectedRows = buildYeaftSidebarSessionList({
        sessions: legacySessions.sessionList,
        activeSessionId: legacySessions.activeSessionId,
        activeSessionKey: legacySessions.activeSessionKey,
        pinnedSessionIds: [],
      });
      expect(explicitlySelectedRows.filter(row => row.active)).toEqual([
        expect.objectContaining({ raw: expect.objectContaining({ agentId: 'agent-b' }) }),
      ]);
      expect(YeaftSidebar.methods.sessionDragKey({ id: 'legacy-only', agentId: null }))
        .toBe('legacy\u001flegacy-only');
      legacySessions.applyRosterChange({ sessionId: 'rejected-legacy-delta', roster: ['omni'] });
      legacySessions.applySnapshotUpsert({ id: 'rejected-legacy-upsert', name: 'Rejected' });
      legacySessions.applyCrudResult({
        ok: true, op: 'create', session: { id: 'rejected-ownerless-create', name: 'Rejected create' },
      });
      legacySessions.applyCrudResult({
        ok: true, op: 'restore', session: { id: 'rejected-ownerless-restore', name: 'Rejected restore' },
      });
      legacySessions.applyCrudResult({
        ok: true, op: 'update_config', sessionId: 'stamped', config: { model: 'wrong' },
      });
      legacySessions.applyCrudResult({ ok: true, op: 'delete', sessionId: 'stamped' });
      legacySessions.applyPinState('stamped', true);
      expect(legacySessions.sessions['rejected-legacy-delta']).toBeUndefined();
      expect(legacySessions.sessions['rejected-legacy-upsert']).toBeUndefined();
      expect(legacySessions.sessions['rejected-ownerless-create']).toBeUndefined();
      expect(legacySessions.sessions['rejected-ownerless-restore']).toBeUndefined();
      expect(legacySessions.sessionById('stamped', 'agent-a')).toMatchObject({
        id: 'stamped', agentId: 'agent-a', config: {}, pinned: false,
      });

      legacySessions.applyPinState('stamped', true, 'agent-a');
      expect(legacySessions.sessionById('stamped', 'agent-a')).toMatchObject({ pinned: true });
      legacySessions.applyCrudResult({
        ok: true, op: 'update_config', sessionId: 'stamped', config: { model: 'agent-a/model' },
      }, 'agent-a');
      expect(legacySessions.sessionById('stamped', 'agent-a')).toMatchObject({
        config: { model: 'agent-a/model' },
      });
      legacySessions.applyCrudResult({
        ok: true, op: 'create', session: { id: 'owned-create', name: 'Owned create' },
      }, 'agent-a');
      expect(legacySessions.sessionById('owned-create', 'agent-a')).toMatchObject({
        id: 'owned-create', agentId: 'agent-a',
      });
      legacySessions.applyCrudResult({ ok: true, op: 'delete', sessionId: 'owned-create' }, 'agent-a');
      expect(legacySessions.sessionById('owned-create', 'agent-a')).toBeNull();

      legacySessions.resetInventory();
      legacySessions.applySnapshot([], 'agent-a');
      legacySessions.applySnapshot([{ id: 'rejected-after-empty-scoped' }], null);
      expect(legacySessions.sessions['rejected-after-empty-scoped']).toBeUndefined();
      expect(legacySessions.inventoryIdentityMode).toBe('agent-scoped');
      store.handleYeaftOutput({
        agentId: 'agent-a',
        event: {
          type: 'session_roster_changed',
          sessionId: 'stamped-from-envelope',
          roster: ['omni'],
          defaultVpId: 'omni',
        },
      });
      expect(legacySessions.sessions['agent-a\u001fstamped-from-envelope']).toMatchObject({
        id: 'stamped-from-envelope', agentId: 'agent-a', roster: ['omni'],
      });

      legacySessions.resetInventory();
      expect(legacySessions.inventoryIdentityMode).toBe('empty');
      legacySessions.applySnapshot([], null);
      expect(legacySessions.inventoryIdentityMode).toBe('legacy-bare');
      legacySessions.applyRosterChange({
        sessionId: 'legacy-after-empty-snapshot', roster: ['omni'], defaultVpId: 'omni',
      });
      expect(legacySessions.sessionById('legacy-after-empty-snapshot', 'agent-a')).toMatchObject({
        id: 'legacy-after-empty-snapshot', agentId: null, roster: ['omni'],
      });

      // Owner-scoped archive/delete results may remove only the exact row.
      // A later authoritative snapshot from Agent A must not turn the matching
      // bare id into permission to replace the still-live B/same selection.
      globalThis.Pinia.useSessionsStore = () => legacySessions;
      globalThis.Pinia.useChatStore = () => store;
      for (const op of ['archive', 'delete']) {
        legacySessions.resetInventory();
        legacySessions.applySnapshot([
          { id: 'same', name: 'Agent A same', workDir: '/repo-a/same' },
          { id: 'other', name: 'Agent A other', workDir: '/repo-a/other' },
        ], 'agent-a');
        legacySessions.applySnapshot([
          { id: 'same', name: 'Agent B same', workDir: '/repo-b/same' },
        ], 'agent-b');
        legacySessions.setActive('same', 'agent-b');
        store.currentView = 'yeaft';
        store.currentAgent = 'agent-b';
        store.currentAgentInfo = { id: 'agent-b', name: 'Agent B', workDir: '/repo-b' };
        store.agents = [
          { id: 'agent-a', name: 'Agent A', online: true, workDir: '/repo-a' },
          { id: 'agent-b', name: 'Agent B', online: true, workDir: '/repo-b' },
        ];
        store.yeaftActiveSessionFilter = 'same';
        store.yeaftSessionAgentById = { same: 'agent-b', other: 'agent-a' };
        store.yeaftConversationIdsByAgent = { 'agent-a': 'conv-crud-a', 'agent-b': 'conv-crud-b' };
        store.yeaftConversationId = 'conv-crud-b';
        store.activeConversations = ['conv-crud-b'];
        store.messagesMap = {
          'conv-crud-a': [
            { type: 'user', content: 'agent A private', sessionId: 'same', seq: 1 },
            { type: 'user', content: 'agent A other', sessionId: 'other', seq: 2 },
          ],
          'conv-crud-b': [
            { type: 'user', content: 'agent B private', sessionId: 'same', seq: 1 },
          ],
        };
        const deletedSessionKey = yeaftHistoryIdentityKey('agent-a', 'same');
        store.yeaftSessionHistoryState = { [deletedSessionKey]: { loaded: true } };
        store.yeaftHistoryCacheState = { [deletedSessionKey]: { ranges: [[1, 2]] } };
        store.yeaftMessageWindowState = { [deletedSessionKey]: { visibleTurns: 20 } };
        store._yeaftHistoryLoad = null;
        store.yeaftSessionHydrateRequestId = null;
        store.sendWsMessage = vi.fn(() => true);

        store.handleYeaftOutput({
          agentId: 'agent-a',
          event: {
            type: 'session_crud_result',
            requestId: `${op}-agent-a-same`,
            ok: true,
            op,
            sessionId: 'same',
          },
        });
        store.handleYeaftOutput({
          agentId: 'agent-a',
          event: {
            type: 'session_list_updated',
            sessions: [{ id: 'other', name: 'Agent A other', workDir: '/repo-a/other' }],
          },
        });

        expect(legacySessions.sessionById('same', 'agent-a')).toBeNull();
        expect(legacySessions.sessionById('same', 'agent-b')).toMatchObject({
          id: 'same', agentId: 'agent-b', workDir: '/repo-b/same',
        });
        expect(legacySessions.activeSessionKey).toBe('agent-b\u001fsame');
        expect(legacySessions.activeSession).toMatchObject({ id: 'same', agentId: 'agent-b' });
        expect(store.currentAgent).toBe('agent-b');
        expect(store.yeaftActiveSessionFilter).toBe('same');
        expect(store.yeaftConversationId).toBe('conv-crud-b');
        expect(store.activeConversations).toEqual(['conv-crud-b']);
        expect(store.sendWsMessage.mock.calls.map(call => call[0]).filter(msg => (
          (msg.type === 'select_agent' && msg.agentId === 'agent-a')
          || (msg.type === 'yeaft_load_history' && msg.agentId === 'agent-a')
        ))).toEqual([]);
        if (op === 'delete') {
          await vi.waitFor(() => {
            expect(store.messagesMap['conv-crud-a']).toEqual([
              expect.objectContaining({ content: 'agent A other', sessionId: 'other' }),
            ]);
          });
          expect(store.messagesMap['conv-crud-b']).toEqual([
            expect.objectContaining({ content: 'agent B private', sessionId: 'same' }),
          ]);
          expect(store.yeaftSessionHistoryState[deletedSessionKey]).toBeUndefined();
          expect(store.yeaftHistoryCacheState[deletedSessionKey]).toBeUndefined();
          expect(store.yeaftMessageWindowState[deletedSessionKey]).toBeUndefined();
        }
        store.pendingAgentSelection = null;
        store.agentSwitching = false;
      }
      store.yeaftConversationIdsByAgent = { 'agent-a': 'conv-agent-a', 'agent-b': 'conv-agent-b' };
      store.yeaftConversationId = 'conv-agent-b';
      store.activeConversations = ['conv-agent-b'];
      store.messagesMap = { 'conv-agent-a': [], 'conv-agent-b': [] };
      store.yeaftSessionHistoryState = {};
      store._yeaftHistoryLoad = null;

      legacySessions.resetInventory();
      legacySessions.applySnapshot([{ id: 'same', name: 'Agent A same' }], 'agent-a');
      expect(legacySessions.sessionById('same', 'agent-b')).toBeNull();
      legacySessions.setActive('same', 'agent-b');
      expect(legacySessions.activeSessionKey).toBeNull();

      legacySessions.resetInventory();
      legacySessions.applySnapshot([{ id: 'session-b', name: 'Session B' }], 'agent-b');
      legacySessions.setActive('session-b', 'agent-b');
      globalThis.Pinia.useSessionsStore = () => legacySessions;
      const previousChatStore = globalThis.Pinia.useChatStore;
      globalThis.Pinia.useChatStore = () => store;
      store.currentView = 'yeaft';
      store.currentAgent = 'agent-b';
      store.yeaftActiveSessionFilter = 'session-b';
      store.yeaftSessionAgentById = { 'session-b': 'agent-b' };
      store.yeaftSessionInventoryCompleteSupported = false;
      store.yeaftSessionHydrateRequestId = null;
      store.yeaftSessionHydrateSlices = [];
      store._hasHandledYeaftSessionHydrate = false;
      store.sendWsMessage.mockClear();
      const legacyRequest = store.requestYeaftSessionInventory();
      expect(store.requestYeaftSessionInventory()).toBe(legacyRequest);
      expect(store.sendWsMessage).toHaveBeenCalledTimes(1);
      const setFilterSpy = vi.spyOn(store, 'setActiveSessionFilter');
      try {
        // Old Servers broadcast agent_list before any Session slice. That frame
        // is not a completion boundary, even when the first slice is slow.
        handleMessage(store, { type: 'agent_list', agents: [] });
        vi.advanceTimersByTime(550);
        expect(store.yeaftSessionHydrateRequestId).toBe(legacyRequest);
        expect(store._hasHandledYeaftSessionHydrate).toBe(false);
        expect(legacySessions.activeSession).toMatchObject({ id: 'session-b', agentId: 'agent-b' });
        expect(store.yeaftActiveSessionFilter).toBe('session-b');
        expect(store.currentAgent).toBe('agent-b');
        expect(setFilterSpy).not.toHaveBeenCalled();

        handleMessage(store, {
          type: 'yeaft_session_hydrate', agentId: 'agent-a', sessions: [{ id: 'session-a', name: 'Session A' }],
        });
        expect(legacySessions.activeSessionId).toBe('session-b');
        vi.advanceTimersByTime(300);
        handleMessage(store, {
          type: 'yeaft_session_hydrate', agentId: 'agent-b', sessions: [{ id: 'session-b', name: 'Session B' }],
        });
        vi.advanceTimersByTime(499);
        expect(legacySessions.activeSessionId).toBe('session-b');
        expect(store.yeaftActiveSessionFilter).toBe('session-b');
        expect(store.currentAgent).toBe('agent-b');
        expect(setFilterSpy).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        expect(store.yeaftSessionHydrateRequestId).toBeNull();
        expect(store._hasHandledYeaftSessionHydrate).toBe(true);
        expect(store._yeaftSessionInventorySocketQuarantined).toBe(true);
        expect(legacySessions.sessionOrder.map((key) => {
          const row = legacySessions.sessions[key];
          return `${row.agentId}:${row.id}`;
        })).toEqual([
          'agent-b:session-b',
          'agent-a:session-a',
        ]);
        expect(legacySessions.activeSession).toMatchObject({ id: 'session-b', agentId: 'agent-b' });
        expect(store.yeaftActiveSessionFilter).toBe('session-b');
        expect(store.currentAgent).toBe('agent-b');
        expect(setFilterSpy).toHaveBeenCalledTimes(1);
        expect(setFilterSpy).toHaveBeenLastCalledWith(
          'session-b',
          { agentId: 'agent-b', force: true },
        );
        expect(store.yeaftConversationId).toBe('conv-agent-b');
        expect(store.activeConversations).toEqual(['conv-agent-b']);

        // Model the next authenticated legacy socket for the zero-slice unit
        // path. The production reconnect boundary after quiet completion is
        // exercised with real socket callbacks below.
        store._yeaftSessionInventorySocketQuarantined = false;

        // A zero-slice legacy response is indistinguishable from a delayed first
        // slice. Preserve the live cache until the bounded request timeout rather
        // than manufacturing an empty authoritative inventory after 500ms.
        store.sendWsMessage.mockClear();
        const emptyLegacyRequest = store.requestYeaftSessionInventory();
        expect(store.requestYeaftSessionInventory()).toBe(emptyLegacyRequest);
        expect(store.sendWsMessage).toHaveBeenCalledTimes(1);
        handleMessage(store, { type: 'agent_list', agents: [] });
        // The completed request's still-pending 15s timeout must not retire this
        // newer owner. Only the timeout created for emptyLegacyRequest may do so.
        vi.advanceTimersByTime(13_650);
        expect(store.yeaftSessionHydrateRequestId).toBe(emptyLegacyRequest);
        vi.advanceTimersByTime(1_350);
        expect(store.yeaftSessionHydrateRequestId).toBeNull();
        expect(store.yeaftSessionHydrateError).toBe('session_inventory_timeout');
        expect(store._yeaftSessionInventorySocketQuarantined).toBe(true);
        expect(legacySessions.activeSession).toMatchObject({ id: 'session-b', agentId: 'agent-b' });
        expect(store.yeaftActiveSessionFilter).toBe('session-b');
        expect(store.currentAgent).toBe('agent-b');

        handleMessage(store, {
          type: 'yeaft_session_hydrate', agentId: 'agent-a', sessions: [{ id: 'late', name: 'Late' }],
        });
        vi.advanceTimersByTime(500);
        expect(legacySessions.sessionById('late', 'agent-a')).toBeNull();
        expect(legacySessions.activeSession).toMatchObject({ id: 'session-b', agentId: 'agent-b' });

        // Drive the complete production attack sequence through real sockets:
        // request A quiet-commits, a normal refresh replaces its socket before
        // opening request B, then A's saved callback attempts a late slice.
        const previousWebSocket = globalThis.WebSocket;
        const previousStartHeartbeat = store.startHeartbeat;
        const previousStopHeartbeat = store.stopHeartbeat;
        const sockets = [];
        class InventorySocket {
          static CONNECTING = 0;
          static OPEN = 1;
          static CLOSED = 3;
          constructor(url) {
            this.url = url;
            this.readyState = InventorySocket.CONNECTING;
            this.sent = [];
            Vue.markRaw(this);
            sockets.push(this);
          }
          send(payload) { this.sent.push(JSON.parse(payload)); }
          close() { this.readyState = InventorySocket.CLOSED; }
        }
        try {
          globalThis.WebSocket = InventorySocket;
          store.sendWsMessage = productionSendWsMessage;
          store.startHeartbeat = vi.fn();
          store.stopHeartbeat = vi.fn();
          store.ws = null;
          store.sessionKey = null;
          store.reconnectAttempts = 0;
          store.reconnectTimer = null;

          store.connect();
          const socketA = sockets[0];
          socketA.readyState = InventorySocket.OPEN;
          socketA.onopen();
          socketA.onmessage({ data: JSON.stringify({
            type: 'auth_result', success: true, yeaftSessionInventoryComplete: false,
          }) });
          const requestA = store.yeaftSessionHydrateRequestId;
          expect(requestA).toMatch(/^session_inventory_/);
          const staleSocketMessage = socketA.onmessage;
          socketA.onmessage({ data: JSON.stringify({
            type: 'yeaft_session_hydrate',
            agentId: 'agent-b',
            sessions: [{ id: 'session-b', name: 'Session B from A' }],
          }) });
          vi.advanceTimersByTime(500);

          expect(store.yeaftSessionHydrateRequestId).toBeNull();
          expect(store._yeaftSessionInventorySocketQuarantined).toBe(true);
          expect(store.ws).toBe(socketA);
          expect(socketA.readyState).toBe(InventorySocket.OPEN);
          expect(socketA.onmessage).toBe(staleSocketMessage);
          expect(sockets).toHaveLength(1);

          expect(store.requestYeaftSessionInventory()).toBeNull();
          expect(sockets).toHaveLength(2);
          expect(socketA.readyState).toBe(InventorySocket.CLOSED);
          expect(socketA.onmessage).toBeNull();

          const socketB = sockets[1];
          socketB.readyState = InventorySocket.OPEN;
          socketB.onopen();
          socketB.onmessage({ data: JSON.stringify({
            type: 'auth_result', success: true, yeaftSessionInventoryComplete: false,
          }) });
          const requestB = store.yeaftSessionHydrateRequestId;
          expect(requestB).toMatch(/^session_inventory_/);
          expect(requestB).not.toBe(requestA);
          socketB.onmessage({ data: JSON.stringify({
            type: 'yeaft_session_hydrate',
            agentId: 'agent-b',
            sessions: [{ id: 'session-b', name: 'Session B from B' }],
          }) });

          staleSocketMessage({ data: JSON.stringify({
            type: 'yeaft_session_hydrate',
            agentId: 'agent-a',
            sessions: [{ id: 'stale-a', name: 'Stale A' }],
          }) });
          vi.advanceTimersByTime(500);

          expect(legacySessions.sessionById('stale-a', 'agent-a')).toBeNull();
          expect(legacySessions.sessionById('session-b', 'agent-b')).toMatchObject({ name: 'Session B from B' });
          expect(legacySessions.activeSession).toMatchObject({ id: 'session-b', agentId: 'agent-b' });
          expect(store.yeaftActiveSessionFilter).toBe('session-b');
          expect(store.currentAgent).toBe('agent-b');
          expect(store.yeaftSessionHydrateRequestId).toBeNull();
          expect(store._yeaftSessionInventorySocketQuarantined).toBe(true);
        } finally {
          store.ws = null;
          store.yeaftSessionHydrateRequestId = null;
          store.yeaftSessionHydrateSlices = [];
          store._yeaftSessionInventorySocketQuarantined = false;
          store.sendWsMessage = vi.fn(() => true);
          store.startHeartbeat = previousStartHeartbeat;
          store.stopHeartbeat = previousStopHeartbeat;
          globalThis.WebSocket = previousWebSocket;
        }
      } finally {
        setFilterSpy.mockRestore();
        if (previousChatStore) globalThis.Pinia.useChatStore = previousChatStore;
        else delete globalThis.Pinia.useChatStore;
      }
    } finally {
      vi.useRealTimers();
      globalThis.Pinia.useSessionsStore = previousSessionsStore;
    }

    store.sessionCatalog = [
      {
        catalogKey: 'yeaft:agent-a:shared',
        runtimeProvider: 'yeaft',
        routeRef: { runtimeProvider: 'yeaft', agentId: 'agent-a', sessionId: 'shared' },
        title: 'Agent A',
        availability: 'online',
      },
      {
        catalogKey: 'yeaft:agent-b:shared',
        runtimeProvider: 'yeaft',
        routeRef: { runtimeProvider: 'yeaft', agentId: 'agent-b', sessionId: 'shared' },
        title: 'Agent B',
        availability: 'online',
      },
    ];
    store.yeaftActiveSessionFilter = 'shared';
    store.currentAgent = 'agent-a';
    store.currentView = 'yeaft';
    expect(store.activeSessionRoute).toEqual({
      runtimeProvider: 'yeaft',
      agentId: 'agent-a',
      sessionId: 'shared',
    });
    store.currentView = 'chat';
    store.conversations = [{ id: 'created-chat', agentId: 'agent-b', provider: 'copilot', type: 'chat' }];
    store.activeConversations = ['created-chat'];
    expect(store.activeSessionRoute).toEqual({
      runtimeProvider: 'copilot',
      agentId: 'agent-b',
      sessionId: 'created-chat',
    });
    store.conversations = [];
    store.activeConversations = [];
    store.panels = [];
    store.sendWsMessage = vi.fn(() => true);
    store.addMessage = vi.fn();
    store.saveOpenSessions = vi.fn();
    store.formatDbMessage = vi.fn(row => row);
    handleConversationCreated(store, {
      conversationId: 'created-copilot',
      agentId: 'agent-a',
      workDir: '/repo',
      provider: 'copilot',
    });
    expect(store.activeSessionRoute?.runtimeProvider).toBe('copilot');
    handleConversationResumed(store, {
      conversationId: 'resumed-claude',
      claudeSessionId: 'runtime-1',
      agentId: 'agent-a',
      workDir: '/repo',
      provider: 'claude-code',
      dbMessages: [],
    });
    expect(store.activeSessionRoute).toEqual({
      runtimeProvider: 'claude-code',
      agentId: 'agent-a',
      sessionId: 'resumed-claude',
    });

    store.currentView = 'yeaft';
    store.activeVpTurns = {};
    store.stoppingVpTurnIds = {};
    store.vpStatuses = {};
    store.yeaftProcessingSessions = {};
    store.yeaftConversationId = 'conv-a';
    store.messagesMap = { 'conv-a': [] };

    bindWorkCenterBrowserOwner('owner-b');
    store.agents = [
      { id: 'stale-agent', online: false, capabilities: ['work_center'] },
      { id: 'agent-b', online: true, capabilities: ['work_center'] },
    ];
    store.workCenterAgentId = 'stale-agent';
    store.workCenterOpen = true;
    store.selectAgent = vi.fn();
    store.listWorkItems = vi.fn(() => Promise.resolve([]));
    expect(store.enterWorkCenter('stale-agent')).toBe(true);
    expect(store.workCenterAgentId).toBe('agent-b');
    store.agents = [];
    expect(store.enterWorkCenter('stale-agent')).toBe(false);
    expect(store.workCenterOpen).toBe(false);
    expect(store.workCenterAgentId).toBe(null);

    const wrapper = mount(UnifiedSessionList, {
      attachTo: document.body,
      props: {
        sessions: store.sessionCatalog,
        agents: [
          { id: 'agent-a', online: true },
          { id: 'agent-b', online: true },
        ],
        isYeaftSessionProcessing: store.isYeaftSessionProcessing,
      },
      global: { mocks: { $t: key => key } },
    });

    store.handleYeaftOutput({
      agentId: 'agent-a',
      conversationId: 'conv-a',
      event: { type: 'vp_turn_start', sessionId: 'shared', vpId: 'omni', turnId: 'turn-a' },
    });
    await Vue.nextTick();
    expect(store.yeaftProcessingSessions).toEqual({
      [yeaftSessionIdentityKey('agent-a', 'shared')]: true,
    });
    expect(wrapper.findAll('.processing-dot')).toHaveLength(1);
    expect(wrapper.findAll('.session-item')[0].classes()).toContain('processing');
    expect(wrapper.findAll('.session-item')[1].classes()).not.toContain('processing');

    store.handleYeaftOutput({
      agentId: 'agent-b',
      conversationId: 'conv-b',
      event: { type: 'vp_turn_start', sessionId: 'shared', vpId: 'omni', turnId: 'turn-a' },
    });
    store.handleYeaftOutput({
      agentId: 'agent-a',
      conversationId: 'conv-a',
      event: { type: 'vp_status_changed', sessionId: 'shared', vpId: 'omni', turnId: 'turn-a', state: 'streaming' },
    });
    expect(Object.values(store.activeVpTurns).filter(row => row.turnId === 'turn-a')).toHaveLength(2);
    expect(store.vpStatuses['agent-a::shared::omni']?.state).toBe('streaming');
    store.handleYeaftOutput({
      agentId: 'agent-a',
      conversationId: 'conv-a',
      event: { type: 'vp_turn_end', sessionId: 'shared', vpId: 'omni', turnId: 'turn-a', reason: 'end_turn' },
    });
    await Vue.nextTick();
    expect(store.vpStatuses['agent-a::shared::omni']).toEqual(expect.objectContaining({
      state: 'idle',
      turnId: null,
    }));
    expect(store.isYeaftSessionProcessing('shared', 'agent-a')).toBe(false);
    expect(store.isYeaftSessionProcessing('shared', 'agent-b')).toBe(true);
    expect(wrapper.findAll('.processing-dot')).toHaveLength(1);
    expect(wrapper.findAll('.session-item')[0].classes()).not.toContain('processing');
    expect(wrapper.findAll('.session-item')[1].classes()).toContain('processing');

    store.handleYeaftOutput({
      agentId: 'agent-a',
      conversationId: 'conv-a',
      event: { type: 'vp_turn_start', sessionId: 'shared', vpId: 'omni', turnId: 'turn-a-1' },
    });
    store.handleYeaftOutput({
      agentId: 'agent-a',
      conversationId: 'conv-a',
      event: { type: 'vp_turn_start', sessionId: 'shared', vpId: 'omni', turnId: 'turn-a-2' },
    });
    store.handleYeaftOutput({
      agentId: 'agent-a',
      conversationId: 'conv-a',
      event: { type: 'vp_status_changed', sessionId: 'shared', vpId: 'omni', turnId: 'turn-a-2', state: 'streaming' },
    });
    store.handleYeaftOutput({
      agentId: 'agent-a',
      conversationId: 'conv-a',
      event: { type: 'vp_turn_end', sessionId: 'shared', vpId: 'omni', turnId: 'turn-a-1', reason: 'end_turn' },
    });
    expect(store.vpStatuses['agent-a::shared::omni']?.state).toBe('streaming');
    expect(store.isYeaftSessionProcessing('shared', 'agent-a')).toBe(true);
    store.handleYeaftOutput({
      agentId: 'agent-a',
      conversationId: 'conv-a',
      event: { type: 'vp_turn_end', sessionId: 'shared', vpId: 'omni', turnId: 'turn-a-2', reason: 'end_turn' },
    });
    expect(store.vpStatuses['agent-a::shared::omni']?.state).toBe('idle');
    expect(store.isYeaftSessionProcessing('shared', 'agent-a')).toBe(false);

    store.activeVpTurns = {};
    store.yeaftProcessingSessions = {};
    store.vpStatuses = {};
    store.handleYeaftOutput({
      agentId: 'agent-a',
      event: {
        type: 'vp_status_snapshot',
        statuses: [{ sessionId: 'shared', vpId: 'omni', state: 'streaming', turnId: 'snapshot-a' }],
      },
    });
    store.handleYeaftOutput({
      agentId: 'agent-b',
      event: {
        type: 'vp_status_snapshot',
        statuses: [{ sessionId: 'shared', vpId: 'omni', state: 'streaming', turnId: 'snapshot-b' }],
      },
    });
    expect(store.isYeaftSessionProcessing('shared', 'agent-a')).toBe(true);
    expect(store.isYeaftSessionProcessing('shared', 'agent-b')).toBe(true);

    store.handleYeaftOutput({
      agentId: 'agent-a',
      event: {
        type: 'vp_status_snapshot',
        sessionId: 'shared',
        statuses: [{ sessionId: 'shared', vpId: 'omni', state: 'idle' }],
      },
    });
    await Vue.nextTick();
    expect(store.isYeaftSessionProcessing('shared', 'agent-a')).toBe(false);
    expect(store.isYeaftSessionProcessing('shared', 'agent-b')).toBe(true);
    expect(wrapper.findAll('.processing-dot')).toHaveLength(1);
    expect(wrapper.findAll('.session-item')[1].classes()).toContain('processing');

    store.handleYeaftOutput({
      agentId: 'agent-b',
      event: { type: 'yeaft_aborted', sessionId: 'shared' },
    });
    await Vue.nextTick();
    expect(store.isYeaftSessionProcessing('shared', 'agent-b')).toBe(false);
    expect(wrapper.findAll('.processing-dot')).toHaveLength(0);

    store.yeaftProcessingSessions = { shared: true };
    expect(store.isYeaftSessionProcessing('shared', 'agent-a')).toBe(false);
    expect(store.isYeaftSessionProcessing('shared', 'agent-b')).toBe(false);
    store.handleYeaftOutput({
      agentId: 'agent-a',
      event: { type: 'vp_status_snapshot', sessionId: 'shared', statuses: [] },
    });
    expect(store.yeaftProcessingSessions).toEqual({ shared: true });

    store.sessionCatalog = [store.sessionCatalog[0]];
    runtimeSessionsStore.sessionList = [{ id: 'shared', agentId: 'agent-a' }];
    expect(store.isYeaftSessionProcessing('shared', 'agent-a')).toBe(true);
    store.handleYeaftOutput({
      agentId: 'agent-a',
      event: { type: 'vp_status_snapshot', sessionId: 'shared', statuses: [] },
    });
    expect(store.yeaftProcessingSessions).toEqual({});
    expect(store.isYeaftSessionProcessing('shared', 'agent-a')).toBe(false);

    store.yeaftProcessingSessions = { shared: true };
    store.handleYeaftOutput({
      agentId: 'agent-a',
      event: { type: 'vp_status_snapshot', statuses: [] },
    });
    expect(store.yeaftProcessingSessions).toEqual({});

    store.sessionCatalog = [
      {
        catalogKey: 'yeaft:agent-a:shared',
        runtimeProvider: 'yeaft',
        routeRef: { runtimeProvider: 'yeaft', agentId: 'agent-a', sessionId: 'shared' },
        title: 'Agent A',
        availability: 'online',
      },
      {
        catalogKey: 'yeaft:agent-b:shared',
        runtimeProvider: 'yeaft',
        routeRef: { runtimeProvider: 'yeaft', agentId: 'agent-b', sessionId: 'shared' },
        title: 'Agent B',
        availability: 'online',
      },
    ];
    runtimeSessionsStore.sessionList = [
      { id: 'shared', agentId: 'agent-a' },
      { id: 'shared', agentId: 'agent-b' },
    ];
    store.yeaftProcessingSessions = { shared: true };
    store.handleYeaftOutput({
      agentId: 'agent-a',
      event: { type: 'vp_status_snapshot', statuses: [] },
    });
    expect(store.yeaftProcessingSessions).toEqual({ shared: true });

    store.yeaftProcessingSessions = {};
    store.vpStatuses = {};
    store.yeaftActiveSessionFilter = null;
    store.currentAgent = 'agent-a';
    runtimeSessionsStore.activeSessionId = null;
    runtimeSessionsStore.activeAgentId = null;
    runtimeSessionsStore.activeSessionKey = null;
    store.handleYeaftOutput({
      agentId: 'agent-b',
      event: {
        type: 'vp_status_snapshot',
        statuses: [{ sessionId: 'shared', vpId: 'omni', state: 'streaming', turnId: 'restore-b' }],
      },
    });
    expect(store.yeaftActiveSessionFilter).toBe('shared');
    expect(store.currentAgent).toBe('agent-b');
    expect(runtimeSessionsStore.activeSessionId).toBe('shared');
    expect(runtimeSessionsStore.activeAgentId).toBe('agent-b');

    store.yeaftActiveSessionFilter = null;
    store.currentAgent = 'agent-a';
    runtimeSessionsStore.activeSessionId = null;
    runtimeSessionsStore.activeAgentId = null;
    runtimeSessionsStore.activeSessionKey = null;
    store.handleYeaftOutput({
      event: {
        type: 'vp_status_snapshot',
        statuses: [{ sessionId: 'shared', vpId: 'omni', state: 'streaming', turnId: 'ambiguous' }],
      },
    });
    expect(store.yeaftActiveSessionFilter).toBeNull();
    expect(store.currentAgent).toBe('agent-a');
    expect(runtimeSessionsStore.activeSessionId).toBeNull();
    expect(runtimeSessionsStore.activeAgentId).toBeNull();

    // Session creation stays on the existing modal, with Agent before Provider
    // and VP selection exposed only for the Yeaft provider.
    const originalPinia = globalThis.Pinia;
    const originalWindowPinia = window.Pinia;
    const chat = Vue.reactive({
      agents: [{ id: 'agent-a', name: 'Agent A', online: true, workDir: '/repo' }],
      currentAgent: 'agent-a',
      folders: [],
      historySessions: [],
      sendWsMessage: vi.fn(),
      listFoldersForAgent: vi.fn(() => Promise.resolve()),
      listHistorySessionsForAgent: vi.fn(),
      selectAgent: vi.fn(),
      createConversation: vi.fn(),
    });
    const modalPinia = {
      ...originalPinia,
      useChatStore: () => chat,
      useVpStore: () => ({
        vpList: [{ vpId: 'omni' }],
        vpOrder: ['omni'],
        lastSnapshotAt: 1,
        lastVpSnapshotAgentId: 'agent-a',
        snapshotStatus: 'ready',
        snapshotAgentId: 'agent-a',
        vpLabel: id => id,
      }),
      useSessionsStore: () => runtimeSessionsStore,
    };
    globalThis.Pinia = modalPinia;
    window.Pinia = modalPinia;
    const modal = mount(SessionCreateModal, {
      attachTo: document.body,
      props: { initialProvider: 'copilot' },
      global: { mocks: { $t: key => key }, stubs: { Teleport: true, VpAvatar: true, ModernSelect: true } },
    });
    await Vue.nextTick();
    const selects = modal.findAllComponents({ name: 'ModernSelect' });
    expect(selects).toHaveLength(2);
    expect(selects[0].props('modelValue')).toBe('agent-a');
    expect(selects[1].props('modelValue')).toBe('copilot');
    expect(modal.get('.yeaft-session-create-heading h2').text()).toBe('yeaft.session.create.title');
    expect(modal.get('.yeaft-session-create-heading p').text()).toBe('yeaft.session.create.subtitle');
    const createFields = modal.get('.yeaft-session-create-fields');
    expect(createFields.findAll(':scope > .resume-control-row')).toHaveLength(4);
    expect(createFields.findAll(':scope > .resume-control-row > .resume-control-label').map(label => label.text())).toEqual([
      'yeaft.session.create.agentLabel',
      'modal.newConv.provider',
      'yeaft.session.create.nameLabel',
      'yeaft.session.create.workDirLabel',
    ]);
    expect(modal.get('.yeaft-create-submit').classes()).toContain('btn-primary');
    expect(modal.find('.resume-control-row-vp').exists()).toBe(false);
    modal.vm.form.provider = 'yeaft';
    await Vue.nextTick();
    const vpRow = modal.get('.resume-control-row-vp');
    expect(vpRow.element.parentElement).toBe(modal.get('.yeaft-session-create-fields').element);
    expect(modal.findAll('.yeaft-session-create-fields > .resume-control-row')).toHaveLength(5);
    expect(modal.findAll('.yeaft-session-create-fields > .resume-control-row > .resume-control-label').map(label => label.text())).toEqual([
      'yeaft.session.create.agentLabel',
      'modal.newConv.provider',
      'yeaft.session.create.nameLabel',
      'yeaft.session.create.workDirLabel',
      'yeaft.session.create.vpPicker',
    ]);
    const sessionCreateCss = readFileSync(resolve(import.meta.dirname, '../../web/styles/yeaft-session-create.css'), 'utf8');
    expect(sessionCreateCss).toMatch(/\.yeaft-session-create-fields\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/s);
    expect(sessionCreateCss).toMatch(/\.yeaft-session-create-fields \.resume-control-row\s*\{[^}]*align-items:\s*center;[^}]*flex-direction:\s*row;[^}]*gap:\s*12px;/s);
    expect(sessionCreateCss).toMatch(/\.yeaft-session-create-modal \.resume-control-label\s*\{[^}]*width:\s*96px;[^}]*flex:\s*0 0 96px;/s);
    expect(sessionCreateCss).toMatch(/\.yeaft-session-create-modal \.modern-select-trigger\s*\{[^}]*border-radius:\s*10px;/s);
    expect(sessionCreateCss).toMatch(/\.yeaft-folder-picker-dialog\s*\{[^}]*height:\s*min\(560px, calc\(100vh - 96px\)\);[^}]*overflow:\s*hidden;/s);
    expect(sessionCreateCss).toMatch(/\.yeaft-folder-picker-dialog \.folder-picker-list\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-height:\s*0;[^}]*max-height:\s*none;[^}]*overflow-y:\s*auto;/s);
    expect(sessionCreateCss).toMatch(/\.yeaft-folder-picker-dialog \.folder-picker-item\s*\{[^}]*font-family:\s*inherit;[^}]*font-size:\s*14px;/s);
    expect(sessionCreateCss).not.toMatch(/\.yeaft-folder-picker-dialog[^}]*#[0-9a-f]{3,6}/i);
    expect(sessionCreateCss).not.toMatch(/\.yeaft-folder-picker-dialog[^}]*rgba?\(/i);
    expect(sessionCreateCss).toMatch(/@media \(max-width:\s*640px\)[\s\S]*?\.yeaft-session-create-fields \.resume-control-row\s*\{[^}]*align-items:\s*center;[^}]*flex-direction:\s*row;[^}]*gap:\s*8px;/s);
    expect(sessionCreateCss).toMatch(/@media \(max-width:\s*640px\)[\s\S]*?\.yeaft-session-create-modal \.resume-control-label\s*\{[^}]*width:\s*76px;[^}]*flex:\s*0 0 76px;/s);
    expect(sessionCreateCss).toMatch(/@media \(max-width:\s*640px\)[\s\S]*?\.resume-control-row-vp\s*\{[^}]*align-items:\s*flex-start;[^}]*flex-direction:\s*row;/s);
    modal.vm.form.provider = 'claude-code';
    await Vue.nextTick();
    modal.vm.form.workDir = '/repo';
    await modal.vm.onSubmit();
    expect(chat.createConversation).toHaveBeenCalledWith('/repo', 'agent-a', null, { provider: 'claude-code' });
    modal.unmount();

    const coldVpStore = Vue.reactive({
      vpList: [],
      vpOrder: [],
      emptyLibrary: false,
      lastSnapshotAt: 0,
      lastVpSnapshotAgentId: null,
      snapshotStatus: 'idle',
      snapshotAgentId: null,
      snapshotRequestId: null,
      snapshotError: '',
      beginSnapshot(agentId, requestId) {
        this.snapshotStatus = 'loading';
        this.snapshotAgentId = agentId;
        this.snapshotRequestId = requestId;
      },
      failSnapshot(agentId, requestId, error) {
        if (requestId !== this.snapshotRequestId) return false;
        this.snapshotStatus = 'error';
        this.snapshotAgentId = agentId;
        this.snapshotError = error;
        return true;
      },
    });
    chat.sendWsMessage.mockReturnValue(true);
    const coldModalPinia = { ...modalPinia, useVpStore: () => coldVpStore };
    globalThis.Pinia = coldModalPinia;
    window.Pinia = coldModalPinia;
    const coldModal = mount(SessionCreateModal, {
      attachTo: document.body,
      global: { mocks: { $t: key => key }, stubs: { Teleport: true, VpAvatar: true, ModernSelect: true } },
    });
    await Vue.nextTick();
    expect(chat.sendWsMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'yeaft_vp_subscribe',
      agentId: 'agent-a',
      requestId: expect.stringMatching(/^vp_snapshot_/),
    }));
    expect(coldVpStore.snapshotStatus).toBe('loading');
    coldVpStore.failSnapshot('agent-a', coldVpStore.snapshotRequestId, 'offline');
    await Vue.nextTick();
    expect(coldModal.find('.yeaft-roster-error').exists()).toBe(true);
    expect(coldModal.find('.yeaft-roster-error').text()).toContain('yeaft.session.create.rosterError');
    await coldModal.get('.yeaft-roster-retry').trigger('click');
    expect(chat.sendWsMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'yeaft_vp_subscribe',
      agentId: 'agent-a',
      requestId: expect.stringMatching(/^vp_snapshot_/),
    }));
    coldModal.unmount();

    // The create roster is scoped to the selected Agent. A pending B request
    // must hide A rows and disable creation; switching back to A establishes a
    // fresh request scope, so a delayed B response cannot overwrite A again.
    storeFactories.delete('vp');
    const scopedVpStore = useVpStore();
    scopedVpStore.beginSnapshot('agent-a', 'req-a-1');
    expect(scopedVpStore.applySnapshot({
      vps: [{ vpId: 'a-only', displayName: 'A only' }],
      emptyLibrary: false,
    }, 'agent-a', 'req-a-1')).toBe(true);
    chat.agents = [
      { id: 'agent-a', name: 'Agent A', online: true, workDir: '/repo-a' },
      { id: 'agent-b', name: 'Agent B', online: true, workDir: '/repo-b' },
    ];
    chat.currentAgent = 'agent-a';
    chat.sendWsMessage.mockClear();
    const scopedModalPinia = { ...modalPinia, useVpStore: () => scopedVpStore };
    globalThis.Pinia = scopedModalPinia;
    window.Pinia = scopedModalPinia;
    const scopedModal = mount(SessionCreateModal, {
      attachTo: document.body,
      global: { mocks: { $t: key => key }, stubs: { Teleport: true, VpAvatar: true, ModernSelect: true } },
    });
    await Vue.nextTick();
    expect(scopedModal.vm.vpList.map(vp => vp.vpId)).toEqual(['a-only']);
    expect(scopedModal.vm.form.vpIds).toEqual(['a-only']);

    expect(scopedModal.findAllComponents({ name: 'ModernSelect' })).toHaveLength(2);
    scopedModal.vm.form.agentId = 'agent-b';
    await Vue.nextTick();
    const vpRequestB = scopedVpStore.snapshotRequestId;
    expect(scopedVpStore.snapshotAgentId).toBe('agent-b');
    expect(scopedVpStore.snapshotStatus).toBe('loading');
    expect(scopedVpStore.vpList).toEqual([]);
    expect(scopedModal.vm.vpList).toEqual([]);
    expect(scopedModal.vm.form.vpIds).toEqual([]);
    expect(scopedModal.get('.yeaft-create-submit').attributes('disabled')).toBeDefined();
    expect(scopedModal.find('.yeaft-roster-empty').text()).toContain('yeaft.session.create.rosterLoading');

    scopedModal.vm.form.agentId = 'agent-a';
    await Vue.nextTick();
    const vpRequestA2 = scopedVpStore.snapshotRequestId;
    expect(vpRequestA2).not.toBe(vpRequestB);
    expect(scopedVpStore.snapshotAgentId).toBe('agent-a');
    expect(scopedVpStore.applySnapshot({
      vps: [{ vpId: 'a-only', displayName: 'A only' }],
      emptyLibrary: false,
    }, 'agent-a', vpRequestA2)).toBe(true);
    await Vue.nextTick();
    expect(scopedModal.vm.vpList.map(vp => vp.vpId)).toEqual(['a-only']);
    expect(scopedModal.vm.form.vpIds).toEqual(['a-only']);
    expect(scopedModal.get('.yeaft-create-submit').attributes('disabled')).toBeUndefined();
    expect(scopedVpStore.applySnapshot({
      vps: [{ vpId: 'b-only', displayName: 'B only' }],
      emptyLibrary: false,
    }, 'agent-b', vpRequestB)).toBe(false);
    expect(scopedModal.vm.vpList.map(vp => vp.vpId)).toEqual(['a-only']);

    // Old Agents do not echo requestId. The server still stamps agentId, so a
    // response for the active Agent remains compatible without weakening the
    // cross-Agent fence above.
    scopedVpStore.beginSnapshot('agent-b', 'req-b-legacy');
    expect(scopedVpStore.applySnapshot({
      vps: [{ vpId: 'b-only', displayName: 'B only' }],
      emptyLibrary: false,
    }, 'agent-b')).toBe(true);
    expect(scopedVpStore.vpList.map(vp => vp.vpId)).toEqual(['b-only']);
    scopedModal.unmount();

    // The create/resume modal must preserve the full Agent + Session identity.
    // Duplicate ids are legal across Agents; selecting B must never reuse A's
    // active key or route history through A while select_agent is in flight.
    storeFactories.clear();
    const exactSessionsStore = useSessionsStore();
    const exactChatStore = useChatStore();
    const exactVpStore = Vue.reactive({
      vpList: [{ vpId: 'omni' }],
      vpOrder: ['omni'],
      emptyLibrary: false,
      lastSnapshotAt: 1,
      lastVpSnapshotAgentId: 'agent-b',
      snapshotStatus: 'ready',
      snapshotAgentId: 'agent-b',
      vpLabel: id => id,
    });
    const exactModalPinia = {
      ...originalPinia,
      useChatStore: () => exactChatStore,
      useSessionsStore: () => exactSessionsStore,
      useVpStore: () => exactVpStore,
    };
    globalThis.Pinia = exactModalPinia;
    window.Pinia = exactModalPinia;
    exactChatStore.sendWsMessage = vi.fn(() => true);
    exactChatStore.currentView = 'chat';
    exactChatStore.currentAgent = 'agent-a';
    exactChatStore.currentAgentInfo = { id: 'agent-a' };
    exactChatStore.agents = [
      { id: 'agent-a', name: 'Agent A', online: true, workDir: '/repo-a' },
      { id: 'agent-b', name: 'Agent B', online: true, workDir: '/repo-b' },
    ];
    exactSessionsStore.resetInventory();
    exactSessionsStore.applySnapshot([{ id: 'grp_default', name: 'A default', workDir: '/repo-a' }], 'agent-a');
    exactSessionsStore.applySnapshot([{ id: 'grp_default', name: 'B default', workDir: '/repo-b' }], 'agent-b');
    exactSessionsStore.setActive('grp_default', 'agent-a');
    exactChatStore.currentView = 'yeaft';
    exactChatStore.yeaftActiveSessionFilter = 'grp_default';
    exactChatStore.yeaftSessionAgentById = { grp_default: 'agent-a' };
    exactChatStore.yeaftConversationIdsByAgent = { 'agent-a': 'conv-a', 'agent-b': 'conv-b' };
    exactChatStore.yeaftConversationId = 'conv-a';
    exactChatStore.activeConversations = ['conv-a'];
    exactChatStore.messagesMap = { 'conv-a': [], 'conv-b': [] };
    exactChatStore.yeaftSessionHistoryState = {};
    localStorage.setItem('lastViewedYeaftSession', 'agent-a\u001fgrp_default');

    const exactModal = mount(SessionCreateModal, {
      attachTo: document.body,
      global: { mocks: { $t: key => key }, stubs: { Teleport: true, VpAvatar: true, ModernSelect: true } },
    });
    await Vue.nextTick();
    exactModal.vm.form.agentId = 'agent-b';
    await Vue.nextTick();
    exactModal.vm.scannedSessions = [{
      id: 'grp_default', name: 'B default', agentId: 'agent-b', workDir: '/repo-b',
    }];
    await Vue.nextTick();

    exactSessionsStore.applySnapshot([], 'agent-b');
    await Vue.nextTick();
    expect(exactModal.vm.sessionsInDir[0].inSidebar).toBeUndefined();
    exactSessionsStore.applySnapshot([{ id: 'grp_default', name: 'B default', workDir: '/repo-b' }], 'agent-b');
    exactSessionsStore.setActive('grp_default', 'agent-a');
    exactChatStore.currentAgent = 'agent-a';
    exactChatStore.currentAgentInfo = { id: 'agent-a' };
    exactChatStore.yeaftActiveSessionFilter = 'grp_default';
    exactChatStore.yeaftSessionAgentById = { grp_default: 'agent-a' };
    exactChatStore.yeaftConversationId = 'conv-a';
    exactChatStore.activeConversations = ['conv-a'];
    exactChatStore.sendWsMessage.mockClear();
    exactModal.vm.resumeExisting(exactModal.vm.sessionsInDir[0]);
    expect(exactSessionsStore.activeSessionKey).toBe('agent-b\u001fgrp_default');
    expect(exactChatStore.currentAgent).toBe('agent-b');
    expect(exactChatStore.yeaftConversationId).toBe('conv-b');
    expect(exactChatStore.activeConversations).toEqual(['conv-b']);
    expect(localStorage.getItem('lastViewedYeaftSession')).toBe('agent-b\u001fgrp_default');
    expect(exactChatStore.sendWsMessage.mock.calls.map(call => call[0]).filter(msg => msg.type === 'yeaft_load_history')).toEqual([
      expect.objectContaining({ agentId: 'agent-b', sessionId: 'grp_default' }),
    ]);

    // Restore starts from the real disk-only state: Agent B has no sidebar
    // row yet, while Agent A already owns the same bare Session id.
    exactSessionsStore.applySnapshot([], 'agent-b');
    exactSessionsStore.setActive('grp_default', 'agent-a');
    exactChatStore.currentAgent = 'agent-a';
    exactChatStore.currentAgentInfo = { id: 'agent-a' };
    exactChatStore.yeaftActiveSessionFilter = 'grp_default';
    exactChatStore.yeaftSessionAgentById = { grp_default: 'agent-a' };
    exactChatStore.yeaftConversationId = 'conv-a';
    exactChatStore.activeConversations = ['conv-a'];
    exactChatStore.messagesMap = { 'conv-a': [], 'conv-b': [] };
    exactChatStore.yeaftSessionHistoryState = {};
    exactChatStore._yeaftHistoryLoad = null;
    localStorage.setItem('lastViewedYeaftSession', 'agent-a\u001fgrp_default');
    exactChatStore.sendWsMessage.mockClear();
    expect(exactSessionsStore.sessions['agent-b\u001fgrp_default']).toBeUndefined();
    expect(exactSessionsStore.sessionById('grp_default', 'agent-b')).toBeNull();
    exactSessionsStore.setActive('grp_default', 'agent-b');
    expect(exactSessionsStore.activeSessionKey).toBeNull();
    exactSessionsStore.setActive('grp_default', 'agent-a');

    const setActiveSpy = vi.spyOn(exactSessionsStore, 'setActive');
    const setFilterSpy = vi.spyOn(exactChatStore, 'setActiveSessionFilter');
    exactChatStore.sessionCrudRequest = vi.fn(() => {
      const result = {
        ok: true,
        op: 'restore',
        session: { id: 'grp_default', name: 'Restored default', agentId: 'agent-b' },
      };
      exactSessionsStore.applyCrudResult(result, 'agent-b');
      return Promise.resolve(result);
    });
    await exactModal.vm.onRestoreClick({
      id: 'grp_default', name: 'Disk default', agentId: 'agent-b', workDir: '/repo-b',
    });
    expect(setActiveSpy).toHaveBeenLastCalledWith('grp_default', 'agent-b');
    expect(setFilterSpy).toHaveBeenLastCalledWith('grp_default', { agentId: 'agent-b', force: true });
    expect(exactSessionsStore.sessions['agent-b\u001fgrp_default']).toEqual(expect.objectContaining({
      id: 'grp_default', agentId: 'agent-b', name: 'Restored default',
    }));
    expect(exactSessionsStore.activeSessionKey).toBe('agent-b\u001fgrp_default');
    expect(exactChatStore.currentAgent).toBe('agent-b');
    expect(exactChatStore.yeaftConversationId).toBe('conv-b');
    expect(exactChatStore.activeConversations).toEqual(['conv-b']);
    expect(localStorage.getItem('lastViewedYeaftSession')).toBe('agent-b\u001fgrp_default');
    expect(exactChatStore.sendWsMessage.mock.calls.map(call => call[0]).filter(msg => msg.type === 'yeaft_load_history')).toEqual([
      expect.objectContaining({ agentId: 'agent-b', sessionId: 'grp_default' }),
    ]);

    // Sidebar removal is logical: it only hides the exact catalog row and
    // sends metadata, never the Agent archive/delete command. Re-adding from
    // the create modal reverses the same metadata and opens the preserved
    // Session identity.
    const hiddenRow = {
      catalogKey: 'yeaft:agent-b:grp_default',
      runtimeProvider: 'yeaft',
      routeRef: { runtimeProvider: 'yeaft', agentId: 'agent-b', sessionId: 'grp_default' },
      title: 'Restored default',
      workDir: '/repo-b',
      availability: 'online',
      pinned: false,
    };
    exactChatStore.sessionCatalog = [hiddenRow];
    exactChatStore.hiddenSessionCatalog = [];
    exactChatStore.sessionCatalogMutationRequests = {};
    exactChatStore.sendWsMessage = vi.fn(() => true);
    expect(exactChatStore.hideCatalogSession(hiddenRow)).toBe(true);
    expect(exactChatStore.sessionCatalog).toEqual([]);
    expect(exactChatStore.hiddenSessionCatalog).toEqual([
      expect.objectContaining({ catalogKey: hiddenRow.catalogKey, hidden: true }),
    ]);
    const hideRequest = exactChatStore.sendWsMessage.mock.calls.at(-1)[0];
    expect(hideRequest).toEqual(expect.objectContaining({
      type: 'set_session_ui_metadata',
      catalogKey: hiddenRow.catalogKey,
      routeRef: hiddenRow.routeRef,
      hidden: true,
    }));
    expect(exactChatStore.sendWsMessage.mock.calls.map(call => call[0].type)).not.toContain('yeaft_archive_session');
    exactChatStore.finishSessionCatalogMutation({
      type: 'session_ui_metadata_updated',
      requestId: hideRequest.requestId,
      ok: true,
      catalogKey: hiddenRow.catalogKey,
      hidden: true,
      pinned: false,
      sortRank: null,
    });
    await Vue.nextTick();
    expect(exactModal.vm.hiddenSessions).toBeUndefined();
    expect(exactModal.text()).not.toContain('sidebar.sessions.hidden');

    // Hiding only changes the sidebar catalog. Selecting that current Session
    // from the create/restore modal must reverse the hidden metadata before it
    // opens the preserved identity. The restored row keeps its renamed catalog
    // title and emits `created` so the "add Session to Project" entry point can
    // run its normal move_session callback.
    hiddenRow.title = 'Inv';
    exactChatStore.hiddenSessionCatalog = [{ ...hiddenRow, hidden: true }];
    exactModal.vm.scannedSessions = [{
      id: 'grp_default', name: 'Inv', agentId: 'agent-b', workDir: '/repo-b',
    }];
    exactSessionsStore.applySnapshot([], 'agent-b');
    exactChatStore.sendWsMessage.mockClear();
    exactModal.vm.selectSession(exactModal.vm.sessionsInDir[0]);
    expect(exactChatStore.sendWsMessage.mock.calls.map(call => call[0].type)).not.toContain('yeaft_restore_session');
    expect(exactChatStore.sendWsMessage.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'set_session_ui_metadata',
        catalogKey: hiddenRow.catalogKey,
        routeRef: hiddenRow.routeRef,
        hidden: false,
      }),
    ]));
    expect(exactChatStore.hiddenSessionCatalog).toEqual([]);
    expect(exactChatStore.sessionCatalog).toEqual([
      expect.objectContaining({ catalogKey: hiddenRow.catalogKey, title: 'Inv', hidden: false }),
    ]);
    expect(exactModal.emitted('created')?.at(-1)?.[0]).toEqual(expect.objectContaining({
      id: 'grp_default', name: 'Inv', agentId: 'agent-b',
    }));

    exactChatStore.sendWsMessage.mockClear();
    exactChatStore.sendYeaftSessionMessage({ groupId: 'grp_default', text: 'route only to B' });
    expect(exactChatStore.sendWsMessage.mock.calls.map(call => call[0]).filter(msg => msg.type === 'yeaft_session_send')).toEqual([
      expect.objectContaining({ agentId: 'agent-b', sessionId: 'grp_default', text: 'route only to B' }),
    ]);
    expect(exactChatStore.messagesMap['conv-b']).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'user', content: 'route only to B', sessionId: 'grp_default' }),
    ]));
    expect(exactChatStore.messagesMap['conv-a']).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ content: 'route only to B' }),
    ]));
    clearTimeout(exactChatStore._processingWatchdogs['conv-b']);

    exactModal.vm.form.vpIds = ['omni'];
    exactModal.vm.form.defaultVpId = 'omni';
    exactChatStore.createYeaftSession = vi.fn(() => Promise.resolve({
      ok: true, session: { id: 'grp_default', name: 'Created default', agentId: 'agent-b' },
    }));
    await exactModal.vm.onSubmit();
    expect(setActiveSpy).toHaveBeenLastCalledWith('grp_default', 'agent-b');
    expect(setFilterSpy).toHaveBeenLastCalledWith('grp_default', { agentId: 'agent-b', force: true });
    setActiveSpy.mockRestore();
    setFilterSpy.mockRestore();
    exactModal.unmount();

    globalThis.Pinia = originalPinia;
    window.Pinia = originalWindowPinia;

    wrapper.unmount();
  });

  it('refreshes repeated catalog clicks without clearing cached Session messages', () => {
    storeFactories.clear();
    runtimeSessionsStore.sessionList = [
      { id: 'session-a', agentId: 'agent-a' },
      { id: 'chat-a', agentId: 'agent-a' },
    ];
    runtimeSessionsStore.sessions = {
      'agent-a\u001fsession-a': { id: 'session-a', agentId: 'agent-a' },
    };
    runtimeSessionsStore.setActive('session-a', 'agent-a');

    const store = useChatStore();
    store.sendWsMessage = vi.fn(() => true);
    store.loadOpenedYeaftSessionsForConnectedAgents = vi.fn();
    store.currentView = 'yeaft';
    store.currentAgent = 'agent-a';
    store.currentAgentInfo = { id: 'agent-a' };
    store.agents = [{ id: 'agent-a', online: true }];
    store.yeaftActiveSessionFilter = 'session-a';
    store.yeaftSessionAgentById = { 'session-a': 'agent-a' };
    store.yeaftConversationIdsByAgent = { 'agent-a': 'conv-a' };
    store.yeaftConversationId = 'conv-a';
    store.activeConversations = ['conv-a'];
    const cachedYeaftRow = {
      id: 'cached-yeaft', type: 'assistant', content: 'cached answer', sessionId: 'session-a', timestamp: 1,
    };
    store.messagesMap = { 'conv-a': [cachedYeaftRow] };
    store.yeaftSessionHistoryState = {
      'agent-a\u001fsession-a': {
        loaded: true, loading: false, latestSeq: 7, hasMore: false, count: 1,
      },
    };

    const yeaftDescriptor = {
      catalogKey: 'yeaft:agent-a:session-a',
      routeRef: { runtimeProvider: 'yeaft', agentId: 'agent-a', sessionId: 'session-a' },
    };
    expect(store.openCatalogSession(yeaftDescriptor)).toBe(true);
    expect(store.messagesMap['conv-a']).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'cached-yeaft', content: 'cached answer' }),
    ]));
    const firstYeaftLoads = store.sendWsMessage.mock.calls
      .map(call => call[0])
      .filter(msg => msg.type === 'yeaft_load_history');
    expect(firstYeaftLoads).toHaveLength(1);
    expect(firstYeaftLoads[0]).toMatchObject({
      agentId: 'agent-a', sessionId: 'session-a', limit: 5,
    });
    expect(store.isSessionHistorySyncing(yeaftDescriptor.routeRef)).toBe(true);
    expect(store.openCatalogSession(yeaftDescriptor)).toBe(true);
    expect(store.sendWsMessage.mock.calls.map(call => call[0]).filter(msg => msg.type === 'yeaft_load_history')).toHaveLength(1);
    expect(store.messagesMap['conv-a']).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'cached-yeaft', content: 'cached answer' }),
    ]));

    store.handleMessage({
      type: 'yeaft_history_chunk',
      agentId: 'agent-a',
      conversationId: 'conv-a',
      sessionId: 'session-a',
      requestId: firstYeaftLoads[0].requestId,
      mode: 'delta',
      afterSeq: 7,
      messages: [{ id: 'fresh-yeaft', role: 'assistant', content: 'fresh answer', sessionId: 'session-a', ts: 2 }],
      latestSeq: 8,
      hasMore: false,
    });
    expect(store.isSessionHistorySyncing(yeaftDescriptor.routeRef)).toBe(false);
    expect(store.messagesMap['conv-a']).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'fresh-yeaft', content: 'fresh answer' }),
    ]));

    store.conversations = [{ id: 'chat-a', agentId: 'agent-a', type: 'chat', workDir: '/repo-a' }];
    store.currentView = 'chat';
    store._yeaftTransitionActive = false;
    store._savedActiveConversations = null;
    store._savedChatIdentity = null;
    store.panels = [];
    store.activePanelId = null;
    store.activeConversations = ['chat-a'];
    const cachedChatRow = {
      id: 'cached-chat', type: 'assistant', content: 'cached chat', dbMessageId: 12,
    };
    store.messagesMap['chat-a'] = [cachedChatRow];
    store.chatHistoryRequests = {};
    store.sendWsMessage.mockClear();
    const chatDescriptor = {
      catalogKey: 'chat:chat-a',
      routeRef: { runtimeProvider: 'copilot', agentId: 'agent-a', sessionId: 'chat-a' },
    };
    expect(store.openCatalogSession(chatDescriptor)).toBe(true);
    expect(store.messagesMap['chat-a']).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'cached-chat', content: 'cached chat', dbMessageId: 12 }),
    ]));
    expect(store.sendWsMessage.mock.calls.map(call => call[0]).filter(msg => msg.type === 'sync_messages')).toEqual([
      expect.objectContaining({ conversationId: 'chat-a', afterMessageId: 12 }),
    ]);
    expect(store.isSessionHistorySyncing(chatDescriptor.routeRef)).toBe(true);
    store.openCatalogSession(chatDescriptor);
    expect(store.sendWsMessage.mock.calls.map(call => call[0]).filter(msg => msg.type === 'sync_messages')).toHaveLength(1);

    store.sendWsMessage = vi.fn(() => false);
    store.chatHistoryRequests = {};
    expect(store.syncChatConversationHistory('chat-a')).toBeNull();
    expect(store.isSessionHistorySyncing(chatDescriptor.routeRef)).toBe(false);
  });

  it('keeps split-pane cached messages visible while repeated clicks synchronize once', () => {
    storeFactories.clear();
    const store = useChatStore();
    store.sendWsMessage = vi.fn(() => true);
    store.currentView = 'chat';
    store.currentAgent = 'agent-a';
    store.conversations = [{ id: 'chat-a', agentId: 'agent-a', type: 'chat', workDir: '/repo-a' }];
    store.panels = [
      { id: 'panel-a', conversationId: 'chat-a' },
      { id: 'panel-b', conversationId: null },
    ];
    store.activePanelId = 'panel-a';
    store.activeConversations = ['chat-a'];
    const cachedRow = { id: 'split-cache', type: 'assistant', content: 'cached split', dbMessageId: 21 };
    store.messagesMap = { 'chat-a': [cachedRow] };
    store.chatHistoryRequests = {};

    store.setPanelConversation('panel-a', 'chat-a', { refresh: true });
    store.setPanelConversation('panel-a', 'chat-a', { refresh: true });

    expect(store.messagesMap['chat-a']).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'split-cache', content: 'cached split', dbMessageId: 21 }),
    ]));
    expect(store.sendWsMessage.mock.calls.map(call => call[0]).filter(msg => msg.type === 'sync_messages')).toEqual([
      expect.objectContaining({ conversationId: 'chat-a', afterMessageId: 21 }),
    ]);
    expect(store.isSessionHistorySyncing({ runtimeProvider: 'copilot', sessionId: 'chat-a' })).toBe(true);
  });

  it('opens an exact cross-Agent Session without loading the previous Agent and migrates the full runtime state', () => {
    storeFactories.clear();
    runtimeSessionsStore.sessionList = [
      { id: 'session-a', agentId: 'agent-a' },
      { id: 'session-b', agentId: 'agent-b' },
    ];
    runtimeSessionsStore.sessions = {
      'agent-a\u001fsession-a': { id: 'session-a', agentId: 'agent-a' },
      'agent-b\u001fsession-b': { id: 'session-b', agentId: 'agent-b' },
    };
    runtimeSessionsStore.setActive('session-a', 'agent-a');

    const store = useChatStore();
    store.sendWsMessage = vi.fn(() => true);
    store.loadOpenedYeaftSessionsForConnectedAgents = vi.fn();
    store.currentView = 'yeaft';
    store.currentAgent = 'agent-a';
    store.currentAgentInfo = { id: 'agent-a' };
    store.agents = [{ id: 'agent-a', online: true }, { id: 'agent-b', online: true }];
    store.yeaftActiveSessionFilter = 'session-a';
    store.yeaftSessionAgentById = { 'session-a': 'agent-a', 'session-b': 'agent-b' };
    store.yeaftConversationIdsByAgent = {
      'agent-a': 'conv-a',
      'agent-b': 'yeaft-local-agent-b-cold',
    };
    store.yeaftConversationId = 'conv-a';
    store.activeConversations = ['conv-a'];
    store.messagesMap = { 'conv-a': [], 'yeaft-local-agent-b-cold': [] };

    store.openCatalogSession({
      catalogKey: 'yeaft:agent-b:session-b',
      routeRef: { runtimeProvider: 'yeaft', agentId: 'agent-b', sessionId: 'session-b' },
    });

    expect(store.sendWsMessage.mock.calls.map(call => call[0])).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'yeaft_load_history', agentId: 'agent-a', sessionId: 'session-a' }),
    ]));
    expect(store.sendWsMessage.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'yeaft_load_history', agentId: 'agent-b', sessionId: 'session-b' }),
    ]));
    expect(store.currentAgent).toBe('agent-b');
    expect(runtimeSessionsStore.activeSessionKey).toBe('agent-b\u001fsession-b');
    expect(localStorage.getItem('lastViewedYeaftSession')).toBe('agent-b\u001fsession-b');

    const localConversationId = 'yeaft-local-agent-b-cold';
    const bridgeConversationId = 'yeaft-agent-b-real';
    store.messagesMap[localConversationId] = [{
      id: 'pending-b', type: 'user', content: 'pending B', sessionId: 'session-b',
      timestamp: Date.now() + 60_000,
    }];
    store.processingConversations = { [localConversationId]: true };
    store.executionStatusMap = {
      [localConversationId]: { currentTool: { name: 'Bash' }, toolHistory: [], lastActivity: 1 },
    };
    store.sessionHealth = { [localConversationId]: { status: 'agent-offline' } };
    store.refreshingSessionMap = { [localConversationId]: true };
    store._closedAt = { [localConversationId]: 1 };
    store._turnCompletedConvs = new Set([localConversationId]);
    store._processingWatchdogs = { [localConversationId]: setTimeout(() => {}, 60_000) };
    store._yeaftWatchdogConvs = new Set([localConversationId]);
    store._yeaftWatchdogPauseReasons = { [localConversationId]: new Set(['tool:vp:thread:session']) };
    const request = store.beginYeaftHistoryLoad({
      agentId: 'agent-b', sessionId: 'session-b', mode: 'recent', preserveLoaded: false,
    });
    store.handleMessage({
      type: 'yeaft_history_chunk',
      agentId: 'agent-b',
      conversationId: bridgeConversationId,
      sessionId: 'session-b',
      requestId: request.requestId,
      mode: 'recent',
      messages: [{ id: 'persisted-b', role: 'assistant', content: 'persisted B', sessionId: 'session-b', ts: 2 }],
      latestSeq: 1,
      hasMore: false,
    });

    expect(store.yeaftConversationId).toBe(bridgeConversationId);
    expect(store.messagesMap[bridgeConversationId]).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'pending-b' }),
      expect.objectContaining({ id: 'persisted-b' }),
    ]));
    expect(store.processingConversations).toEqual({ [bridgeConversationId]: true });
    expect(store.executionStatusMap[bridgeConversationId].currentTool).toEqual({ name: 'Bash' });
    expect(store.sessionHealth[bridgeConversationId]).toEqual({ status: 'agent-offline' });
    expect(store.refreshingSessionMap[bridgeConversationId]).toBe(true);
    expect(store._closedAt[bridgeConversationId]).toBe(1);
    expect(store._turnCompletedConvs.has(bridgeConversationId)).toBe(true);
    expect(store._processingWatchdogs[localConversationId]).toBeUndefined();
    expect(store._processingWatchdogs[bridgeConversationId]).toBeUndefined();
    expect(store._yeaftWatchdogPauseReasons[localConversationId]).toBeUndefined();
    expect([...store._yeaftWatchdogPauseReasons[bridgeConversationId]])
      .toEqual(['tool:vp:thread:session']);
    store.handleYeaftOutput({
      agentId: 'agent-b',
      conversationId: bridgeConversationId,
      sessionId: 'session-b',
      vpId: 'vp',
      threadId: 'thread',
      turnId: 'session',
      data: {
        type: 'user',
        tool_use_result: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }],
      },
    });
    expect(store._yeaftWatchdogPauseReasons[bridgeConversationId]).toBeUndefined();
    expect(store._processingWatchdogs[bridgeConversationId]).toBeTruthy();
    clearTimeout(store._processingWatchdogs[bridgeConversationId]);

    store.yeaftActiveTasksBySession = {
      'agent-a\u001fsession-a': {
        'task-a': { id: 'task-a', sessionId: 'session-a', agentId: 'agent-a', status: 'running' },
      },
    };
    store.handleYeaftOutput({
      agentId: 'agent-b',
      sessionId: 'session-b',
      event: {
        type: 'session_ready',
        conversationId: bridgeConversationId,
        sessionId: 'session-b',
        tasks: [{ id: 'task-b', sessionId: 'session-b', status: 'running' }],
      },
    });
    expect(store.yeaftActiveTasksBySession['agent-a\u001fsession-a']['task-a']).toEqual(expect.objectContaining({
      agentId: 'agent-a', status: 'running',
    }));
    expect(store.yeaftActiveTasksBySession['agent-b\u001fsession-b']['task-b']).toEqual(expect.objectContaining({
      agentId: 'agent-b', status: 'running',
    }));
    store.handleYeaftOutput({
      agentId: 'agent-b',
      sessionId: 'session-b',
      event: {
        type: 'yeaft_task_event',
        event: 'completed',
        task: { id: 'task-b', sessionId: 'session-b', kind: 'sub_agent', status: 'succeeded' },
      },
    });
    expect(store.yeaftActiveTasksBySession['agent-b\u001fsession-b']).toBeUndefined();
  });

  it('keeps background Yeaft output routed while promoting the visible local conversation', () => {
    storeFactories.clear();
    runtimeSessionsStore.sessionList = [
      { id: 'visible-session', agentId: 'agent-a' },
      { id: 'background-session', agentId: 'agent-a' },
    ];
    runtimeSessionsStore.activeSessionId = 'visible-session';
    runtimeSessionsStore.activeAgentId = 'agent-a';

    const store = useChatStore();
    store.sendWsMessage = vi.fn(() => true);
    const localConversationId = 'yeaft-local-agent-a-cold';
    const bridgeConversationId = 'yeaft-agent-a-cold';
    const optimisticId = 'u_local_pending';
    store.currentView = 'yeaft';
    store.currentAgent = 'agent-a';
    store.yeaftActiveSessionFilter = 'visible-session';
    store.yeaftSessionAgentById = {
      'visible-session': 'agent-a',
      'background-session': 'agent-a',
    };
    store.yeaftConversationId = localConversationId;
    store.yeaftConversationIdsByAgent = { 'agent-a': localConversationId };
    store.activeConversations = [localConversationId];
    store.messagesMap = {
      [localConversationId]: [{
        id: optimisticId,
        messageId: optimisticId,
        clientMessageId: optimisticId,
        type: 'user',
        content: 'pending send',
        sessionId: 'visible-session',
        turnId: optimisticId,
        timestamp: 1,
      }],
    };
    store.processingConversations = { [localConversationId]: true };
    store.executionStatusMap = {
      [localConversationId]: {
        currentTool: { name: 'Bash' },
        toolHistory: [],
        lastActivity: 1,
      },
    };

    // A background Session can reveal the real bridge id first. This updates
    // the Agent transport cache but must leave the visible local source intact.
    store.handleYeaftOutput({
      agentId: 'agent-a',
      conversationId: bridgeConversationId,
      sessionId: 'background-session',
      data: {
        type: 'assistant',
        message: { id: 'background-row', content: 'background answer' },
      },
    });
    expect(store.yeaftConversationIdsByAgent['agent-a']).toBe(bridgeConversationId);
    expect(store.yeaftConversationId).toBe(localConversationId);
    expect(store._yeaftPendingConversationPromotions['agent-a']).toEqual({
      sourceConversationId: localConversationId,
      targetConversationId: bridgeConversationId,
    });

    // A visible live frame can be the next authoritative event; history is not
    // required to finalize the source cleanup and watchdog transfer.
    const liveSourceWatchdog = setTimeout(() => {}, 60_000);
    store._processingWatchdogs = { [localConversationId]: liveSourceWatchdog };
    store._yeaftWatchdogConvs = new Set([localConversationId]);
    store.handleYeaftOutput({
      agentId: 'agent-a',
      conversationId: bridgeConversationId,
      sessionId: 'visible-session',
      data: {
        type: 'text_delta',
        message: { id: 'visible-live-row' },
        text: 'visible live answer',
      },
    });
    expect(store.yeaftConversationId).toBe(bridgeConversationId);
    expect(store.messagesMap[localConversationId]).toBeUndefined();
    expect(store.processingConversations).toEqual({ [bridgeConversationId]: true });
    expect(store.executionStatusMap[localConversationId]).toBeUndefined();
    expect(store.executionStatusMap[bridgeConversationId].currentTool).toBeNull();
    expect(store._processingWatchdogs[localConversationId]).toBeUndefined();
    expect(store._processingWatchdogs[bridgeConversationId]).toBeTruthy();
    expect(store._yeaftWatchdogConvs.has(localConversationId)).toBe(false);
    expect(store._yeaftWatchdogConvs.has(bridgeConversationId)).toBe(true);
    expect(store._yeaftPendingConversationPromotions['agent-a']).toBeUndefined();
    clearTimeout(store._processingWatchdogs[bridgeConversationId]);

    // If the target already received live runtime before visible authority, that
    // newer target state wins; finalization only removes the retained source.
    const ownedSourceId = 'yeaft-local-agent-a-owned-source';
    const ownedTargetId = 'yeaft-agent-a-owned-target';
    store.yeaftConversationId = ownedSourceId;
    store.activeConversations = [ownedSourceId];
    store.yeaftConversationIdsByAgent = { 'agent-a': ownedSourceId };
    store.messagesMap[ownedSourceId] = [{
      id: 'owned-source-row', type: 'user', content: 'old source', sessionId: 'visible-session', timestamp: 2,
    }];
    store.processingConversations = { [ownedSourceId]: true };
    store.executionStatusMap = {
      [ownedSourceId]: { currentTool: { name: 'OldTool' }, toolHistory: [], lastActivity: 2 },
    };
    store._processingWatchdogs = { [ownedSourceId]: setTimeout(() => {}, 60_000) };
    store._yeaftWatchdogConvs = new Set([ownedSourceId]);
    store.handleYeaftOutput({
      agentId: 'agent-a',
      conversationId: ownedTargetId,
      sessionId: 'background-session',
      data: { type: 'text_delta', message: { id: 'owned-background-row' }, text: 'background live' },
    });
    store.processingConversations[ownedTargetId] = true;
    store.executionStatusMap[ownedTargetId] = {
      currentTool: { name: 'NewTool' }, toolHistory: [], lastActivity: 4,
    };
    store._processingWatchdogs[ownedTargetId] = setTimeout(() => {}, 60_000);
    store.handleYeaftOutput({
      agentId: 'agent-a',
      conversationId: ownedTargetId,
      sessionId: 'visible-session',
      data: { type: 'text_delta', message: { id: 'owned-visible-row' }, text: 'visible live' },
    });
    expect(store.processingConversations).toEqual({ [ownedTargetId]: true });
    expect(store.executionStatusMap[ownedSourceId]).toBeUndefined();
    expect(store.executionStatusMap[ownedTargetId].currentTool).toEqual({ name: 'NewTool' });
    expect(store._processingWatchdogs[ownedSourceId]).toBeUndefined();
    expect(store._processingWatchdogs[ownedTargetId]).toBeTruthy();
    expect(store._yeaftWatchdogConvs.has(ownedTargetId)).toBe(true);
    clearTimeout(store._processingWatchdogs[ownedTargetId]);

    // Runtime slots have independent target authority. A target execution frame
    // must not suppress source processing or its watchdog during finalization.
    const executionOwnedSourceId = 'yeaft-local-agent-a-execution-owned-source';
    const executionOwnedTargetId = 'yeaft-agent-a-execution-owned-target';
    const executionOwnedStore = {
      messagesMap: { [executionOwnedSourceId]: [], [executionOwnedTargetId]: [] },
      processingConversations: { [executionOwnedSourceId]: true },
      executionStatusMap: {
        [executionOwnedSourceId]: { currentTool: { name: 'OldTool' } },
        [executionOwnedTargetId]: { currentTool: { name: 'NewTool' } },
      },
      sessionHealth: {
        [executionOwnedSourceId]: { status: 'source-health' },
        [executionOwnedTargetId]: { status: 'target-health' },
      },
      refreshingSessionMap: {
        [executionOwnedSourceId]: true,
        [executionOwnedTargetId]: false,
      },
      _closedAt: { [executionOwnedSourceId]: 11 },
      _autoRefreshed: {
        [executionOwnedSourceId]: false,
        [executionOwnedTargetId]: true,
      },
      _turnCompletedConvs: new Set([executionOwnedSourceId]),
      _processingWatchdogs: { [executionOwnedSourceId]: setTimeout(() => {}, 60_000) },
      _pongTimeouts: { [executionOwnedSourceId]: setTimeout(() => {}, 60_000) },
      _yeaftWatchdogConvs: new Set([executionOwnedSourceId]),
    };
    migrateYeaftConversationState(executionOwnedStore, executionOwnedSourceId, executionOwnedTargetId);
    expect(executionOwnedStore.processingConversations).toEqual({ [executionOwnedTargetId]: true });
    expect(executionOwnedStore.executionStatusMap).toEqual({
      [executionOwnedTargetId]: { currentTool: { name: 'NewTool' } },
    });
    expect(executionOwnedStore.sessionHealth).toEqual({
      [executionOwnedTargetId]: { status: 'target-health' },
    });
    expect(executionOwnedStore.refreshingSessionMap).toEqual({ [executionOwnedTargetId]: false });
    expect(executionOwnedStore._closedAt).toEqual({ [executionOwnedTargetId]: 11 });
    expect(executionOwnedStore._autoRefreshed).toEqual({ [executionOwnedTargetId]: true });
    expect([...executionOwnedStore._turnCompletedConvs]).toEqual([executionOwnedTargetId]);
    expect(executionOwnedStore._processingWatchdogs[executionOwnedSourceId]).toBeUndefined();
    expect(executionOwnedStore._pongTimeouts[executionOwnedSourceId]).toBeUndefined();
    expect(executionOwnedStore._processingWatchdogs[executionOwnedTargetId]).toBeTruthy();
    expect(executionOwnedStore._yeaftWatchdogConvs.has(executionOwnedTargetId)).toBe(true);
    clearTimeout(executionOwnedStore._processingWatchdogs[executionOwnedTargetId]);

    // The inverse mix is equally important: target processing must not suppress
    // source execution or the other source-only lifecycle slots.
    const processingOwnedSourceId = 'yeaft-local-agent-a-processing-owned-source';
    const processingOwnedTargetId = 'yeaft-agent-a-processing-owned-target';
    const processingOwnedStore = {
      messagesMap: { [processingOwnedSourceId]: [], [processingOwnedTargetId]: [] },
      processingConversations: {
        [processingOwnedSourceId]: true,
        [processingOwnedTargetId]: true,
      },
      executionStatusMap: {
        [processingOwnedSourceId]: { currentTool: { name: 'SourceTool' } },
      },
      sessionHealth: {
        [processingOwnedSourceId]: { status: 'source-health' },
      },
      refreshingSessionMap: { [processingOwnedSourceId]: true },
      _closedAt: {
        [processingOwnedSourceId]: 21,
        [processingOwnedTargetId]: 22,
      },
      _autoRefreshed: { [processingOwnedSourceId]: true },
      _turnCompletedConvs: new Set([processingOwnedSourceId]),
      _processingWatchdogs: { [processingOwnedSourceId]: setTimeout(() => {}, 60_000) },
      _yeaftWatchdogConvs: new Set([processingOwnedSourceId]),
    };
    migrateYeaftConversationState(processingOwnedStore, processingOwnedSourceId, processingOwnedTargetId);
    expect(processingOwnedStore.processingConversations).toEqual({ [processingOwnedTargetId]: true });
    expect(processingOwnedStore.executionStatusMap).toEqual({
      [processingOwnedTargetId]: { currentTool: { name: 'SourceTool' } },
    });
    expect(processingOwnedStore.sessionHealth).toEqual({
      [processingOwnedTargetId]: { status: 'source-health' },
    });
    expect(processingOwnedStore.refreshingSessionMap).toEqual({ [processingOwnedTargetId]: true });
    expect(processingOwnedStore._closedAt).toEqual({ [processingOwnedTargetId]: 22 });
    expect(processingOwnedStore._autoRefreshed).toEqual({ [processingOwnedTargetId]: true });
    expect([...processingOwnedStore._turnCompletedConvs]).toEqual([processingOwnedTargetId]);
    expect(processingOwnedStore._processingWatchdogs[processingOwnedSourceId]).toBeUndefined();
    expect(processingOwnedStore._processingWatchdogs[processingOwnedTargetId]).toBeTruthy();
    expect(processingOwnedStore._yeaftWatchdogConvs.has(processingOwnedTargetId)).toBe(true);
    clearTimeout(processingOwnedStore._processingWatchdogs[processingOwnedTargetId]);

    // Recreate the same background-first ordering so session_ready, rather than
    // history or data output, proves it can also finalize the promotion.
    const readySourceId = 'yeaft-local-agent-a-ready';
    const readyTargetId = 'yeaft-agent-a-ready';
    store.yeaftConversationId = readySourceId;
    store.activeConversations = [readySourceId];
    store.yeaftConversationIdsByAgent = { 'agent-a': readySourceId };
    store.messagesMap[readySourceId] = [{
      id: 'ready-pending', type: 'user', content: 'pending before ready', sessionId: 'visible-session', timestamp: 3,
    }];
    store.processingConversations = { [readySourceId]: true };
    store.executionStatusMap = {
      [readySourceId]: { currentTool: { name: 'Grep' }, toolHistory: [], lastActivity: 3 },
    };
    store._processingWatchdogs = { [readySourceId]: setTimeout(() => {}, 60_000) };
    store._yeaftWatchdogConvs = new Set([readySourceId]);
    store.handleYeaftOutput({
      agentId: 'agent-a',
      conversationId: readyTargetId,
      sessionId: 'background-session',
      data: { type: 'assistant', message: { id: 'ready-background-row', content: 'background before ready' } },
    });
    expect(store.yeaftConversationId).toBe(readySourceId);
    expect(store._yeaftPendingConversationPromotions['agent-a']).toEqual({
      sourceConversationId: readySourceId,
      targetConversationId: readyTargetId,
    });
    store.handleYeaftOutput({
      agentId: 'agent-a',
      sessionId: 'visible-session',
      event: {
        type: 'session_ready', conversationId: readyTargetId, sessionId: 'visible-session', tasks: [],
      },
    });
    expect(store.yeaftConversationId).toBe(readyTargetId);
    expect(store.messagesMap[readySourceId]).toBeUndefined();
    expect(store.processingConversations).toEqual({ [readyTargetId]: true });
    expect(store.executionStatusMap[readySourceId]).toBeUndefined();
    expect(store.executionStatusMap[readyTargetId].currentTool).toBeNull();
    expect(store._processingWatchdogs[readySourceId]).toBeUndefined();
    expect(store._processingWatchdogs[readyTargetId]).toBeTruthy();
    expect(store._yeaftPendingConversationPromotions['agent-a']).toBeUndefined();
    clearTimeout(store._processingWatchdogs[readyTargetId]);

    // A newer bridge generation retargets the pending visible source and retires
    // the old target. Late data, session_ready, and history frames from that old
    // generation may not reclaim the Agent map or visible transcript.
    const generationSourceId = 'yeaft-local-agent-a-generation-source';
    const generationTargetOneId = 'yeaft-agent-a-generation-one';
    const generationTargetTwoId = 'yeaft-agent-a-generation-two';
    store.currentView = 'yeaft';
    store.currentAgent = 'agent-a';
    store.yeaftActiveSessionFilter = 'visible-session';
    runtimeSessionsStore.setActive('visible-session', 'agent-a');
    store.yeaftConversationId = generationSourceId;
    store.activeConversations = [generationSourceId];
    store.yeaftConversationIdsByAgent = { 'agent-a': generationSourceId };
    store.messagesMap = {
      ...store.messagesMap,
      [generationSourceId]: [{
        id: 'generation-source-row', type: 'user', content: 'pending generation', sessionId: 'visible-session', timestamp: 5,
      }],
    };
    store.processingConversations = { [generationSourceId]: true };
    store.executionStatusMap = {
      [generationSourceId]: { currentTool: { name: 'SourceTool' }, toolHistory: [], lastActivity: 5 },
    };
    store._processingWatchdogs = { [generationSourceId]: setTimeout(() => {}, 60_000) };
    store._yeaftWatchdogConvs = new Set([generationSourceId]);
    store._yeaftPendingConversationPromotions = {};
    store._yeaftRetiredConversationIdsByAgent = {};
    store.yeaftSessionHistoryState = {};

    store.handleYeaftOutput({
      agentId: 'agent-a',
      conversationId: generationTargetOneId,
      sessionId: 'background-session',
      data: { type: 'assistant', message: { id: 'generation-one-row', content: 'generation one' } },
    });
    expect(store._yeaftPendingConversationPromotions['agent-a']).toEqual({
      sourceConversationId: generationSourceId,
      targetConversationId: generationTargetOneId,
    });
    store.handleYeaftOutput({
      agentId: 'agent-a',
      sessionId: 'visible-session',
      event: {
        type: 'session_ready', conversationId: generationTargetTwoId, sessionId: 'visible-session', tasks: [],
      },
    });
    expect(store.yeaftConversationIdsByAgent['agent-a']).toBe(generationTargetTwoId);
    expect(store.yeaftConversationId).toBe(generationTargetTwoId);
    expect(store.activeConversations).toEqual([generationTargetTwoId]);
    expect(store._yeaftPendingConversationPromotions['agent-a']).toBeUndefined();
    expect(store.messagesMap[generationSourceId]).toBeUndefined();
    expect(store.messagesMap[generationTargetOneId]).toBeUndefined();
    expect(store.messagesMap[generationTargetTwoId]).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'generation-source-row' }),
      expect.objectContaining({ id: 'generation-one-row' }),
    ]));

    store.handleYeaftOutput({
      agentId: 'agent-a',
      conversationId: generationTargetOneId,
      sessionId: 'visible-session',
      data: { type: 'assistant', message: { id: 'late-generation-one-data', content: 'late old data' } },
    });
    expect(store.yeaftConversationIdsByAgent['agent-a']).toBe(generationTargetTwoId);
    expect(store.yeaftConversationId).toBe(generationTargetTwoId);
    expect(store.activeConversations).toEqual([generationTargetTwoId]);
    expect(store.messagesMap[generationTargetTwoId]).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'late-generation-one-data' }),
    ]));

    const generationTurnId = 'generation-turn';
    store.messagesMap[generationTargetTwoId].push({
      id: 'generation-pending-row',
      type: 'assistant',
      content: 'pending generation result',
      sessionId: 'visible-session',
      turnId: generationTurnId,
      isStreaming: true,
      status: 'pending',
      timestamp: 7,
    });
    store.processingConversations[generationTargetTwoId] = true;
    if (!store._processingWatchdogs[generationTargetTwoId]) {
      store._processingWatchdogs[generationTargetTwoId] = setTimeout(() => {}, 60_000);
    }
    store._yeaftWatchdogConvs.add(generationTargetTwoId);
    store.activeVpTurns = {
      'agent-a\u001fgeneration-turn': {
        agentId: 'agent-a', turnId: generationTurnId, vpId: 'omni', sessionId: 'visible-session', isStreaming: true,
      },
    };
    store.yeaftProcessingSessions = { 'agent-a\u001fvisible-session': true };
    store.handleYeaftOutput({
      agentId: 'agent-a',
      conversationId: generationTargetOneId,
      sessionId: 'visible-session',
      turnId: generationTurnId,
      vpId: 'omni',
      data: { type: 'result', subtype: 'success', result_text: '' },
    });
    const completedGenerationRow = store.messagesMap[generationTargetTwoId]
      .find(row => row.id === 'generation-pending-row');
    expect(completedGenerationRow).toEqual(expect.objectContaining({
      isStreaming: false,
      status: 'completed',
    }));
    expect(store.processingConversations[generationTargetTwoId]).toBeUndefined();
    expect(store._processingWatchdogs[generationTargetTwoId]).toBeUndefined();
    expect(store._yeaftWatchdogConvs.has(generationTargetTwoId)).toBe(false);
    expect(store.yeaftConversationIdsByAgent['agent-a']).toBe(generationTargetTwoId);
    expect(store.yeaftConversationId).toBe(generationTargetTwoId);
    expect(store.activeConversations).toEqual([generationTargetTwoId]);

    store.messagesMap[generationTargetTwoId].push({
      id: 'current-unrelated-row',
      type: 'assistant',
      content: 'still running current turn',
      sessionId: 'visible-session',
      turnId: 'current-unrelated-turn',
      isStreaming: true,
      status: 'pending',
      timestamp: 8,
    });
    store.processingConversations[generationTargetTwoId] = true;
    store.handleYeaftOutput({
      agentId: 'agent-a',
      conversationId: generationTargetOneId,
      sessionId: 'visible-session',
      turnId: 'retired-unrelated-turn',
      vpId: 'omni',
      data: { type: 'result', subtype: 'success', result_text: '' },
    });
    expect(store.messagesMap[generationTargetTwoId]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'current-unrelated-row', isStreaming: true, status: 'pending',
      }),
    ]));
    expect(store.processingConversations[generationTargetTwoId]).toBe(true);
    delete store.processingConversations[generationTargetTwoId];
    store.messagesMap[generationTargetTwoId] = store.messagesMap[generationTargetTwoId]
      .filter(row => row.id !== 'current-unrelated-row');

    store.handleYeaftOutput({
      agentId: 'agent-a',
      sessionId: 'visible-session',
      event: {
        type: 'session_ready', conversationId: generationTargetOneId, sessionId: 'visible-session', tasks: [],
      },
    });
    expect(store.yeaftConversationIdsByAgent['agent-a']).toBe(generationTargetTwoId);
    expect(store.yeaftConversationId).toBe(generationTargetTwoId);
    expect(store.activeConversations).toEqual([generationTargetTwoId]);

    store.handleYeaftOutput({
      agentId: 'agent-a',
      conversationId: generationTargetOneId,
      sessionId: 'visible-session',
      event: {
        type: 'vp_turn_end',
        turnId: 'generation-turn',
        vpId: 'omni',
        sessionId: 'visible-session',
        reason: 'end_turn',
      },
    });
    expect(store.activeVpTurns['agent-a\u001fgeneration-turn']).toBeUndefined();
    expect(store.yeaftProcessingSessions['agent-a\u001fvisible-session']).toBeUndefined();
    expect(store.yeaftConversationIdsByAgent['agent-a']).toBe(generationTargetTwoId);
    expect(store.yeaftConversationId).toBe(generationTargetTwoId);

    store.handleMessage({
      type: 'yeaft_history_chunk',
      agentId: 'agent-a',
      conversationId: generationTargetOneId,
      sessionId: 'visible-session',
      mode: 'delta',
      messages: [{
        id: 'late-generation-one-history', role: 'assistant', content: 'late old history', sessionId: 'visible-session', ts: 6,
      }],
      latestSeq: 6,
      hasMore: false,
    });
    expect(store.yeaftConversationIdsByAgent['agent-a']).toBe(generationTargetTwoId);
    expect(store.yeaftConversationId).toBe(generationTargetTwoId);
    expect(store.activeConversations).toEqual([generationTargetTwoId]);
    expect(store.messagesMap[generationTargetTwoId]).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'late-generation-one-history' }),
    ]));
    clearTimeout(store._processingWatchdogs[generationTargetTwoId]);

    // Continue the existing history-order matrix from its original bridge id.
    store.yeaftConversationId = bridgeConversationId;
    store.activeConversations = [bridgeConversationId];
    store.yeaftConversationIdsByAgent = { 'agent-a': bridgeConversationId };
    store.processingConversations = { [bridgeConversationId]: true };
    store.executionStatusMap = {
      [bridgeConversationId]: { currentTool: { name: 'Bash' }, toolHistory: [], lastActivity: 1 },
    };
    store._processingWatchdogs = {};
    store._yeaftWatchdogConvs = new Set();

    const request = store.beginYeaftHistoryLoad({
      agentId: 'agent-a',
      sessionId: 'visible-session',
      mode: 'recent',
      preserveLoaded: false,
    });
    // Encrypted relay work is asynchronous per frame, so the small completion
    // can legally arrive before the compressed history chunk. Completion may
    // publish metadata, but it must retain the request fence until data lands.
    store.handleYeaftOutput({
      type: 'yeaft_output',
      agentId: 'agent-a',
      conversationId: bridgeConversationId,
      sessionId: 'visible-session',
      requestId: request.requestId,
      event: {
        type: 'history_loaded',
        agentId: 'agent-a',
        sessionId: 'visible-session',
        requestId: request.requestId,
        mode: 'recent',
        count: 1,
        oldestSeq: 1,
        latestSeq: 1,
        hasMore: false,
      },
    });
    expect(store.yeaftSessionHistoryState['agent-a\u001fvisible-session']).toEqual(expect.objectContaining({
      loading: true,
      requestId: request.requestId,
      completionSeen: true,
    }));
    store.handleMessage({
      type: 'yeaft_history_chunk',
      agentId: 'agent-a',
      conversationId: bridgeConversationId,
      sessionId: 'visible-session',
      requestId: request.requestId,
      mode: 'recent',
      messages: [{
        id: 'persisted-row',
        role: 'assistant',
        content: 'persisted answer',
        sessionId: 'visible-session',
        ts: 2,
      }],
      oldestSeq: 1,
      latestSeq: 1,
      hasMore: false,
    });

    expect(store.yeaftSessionHistoryState['agent-a\u001fvisible-session']).toEqual(expect.objectContaining({
      loaded: true,
      loading: false,
      requestId: null,
      count: 1,
    }));
    expect(store.yeaftSessionHistoryState['agent-a\u001fvisible-session']).not.toHaveProperty('completionSeen');
    expect(store.yeaftConversationId).toBe(bridgeConversationId);
    expect(store.activeConversations).toEqual([bridgeConversationId]);
    expect(store.messagesMap[bridgeConversationId]).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: optimisticId, content: 'pending send' }),
      expect.objectContaining({ id: 'persisted-row', content: 'persisted answer' }),
    ]));
    expect(store.messagesMap[localConversationId]).toBeUndefined();
    expect(store.processingConversations).toEqual({ [bridgeConversationId]: true });
    expect(store.executionStatusMap[bridgeConversationId].currentTool).toEqual({ name: 'Bash' });
    expect(store.executionStatusMap[localConversationId]).toBeUndefined();

    // The normal chunk-first order is equally safe: the chunk is the data commit,
    // while a stale completion from an older request cannot mutate a new generation.
    const chunkFirstRequest = store.beginYeaftHistoryLoad({
      agentId: 'agent-a',
      sessionId: 'visible-session',
      mode: 'delta',
      preserveLoaded: true,
      latestSeq: 1,
    });
    store.handleMessage({
      type: 'yeaft_history_chunk',
      agentId: 'agent-a',
      conversationId: bridgeConversationId,
      sessionId: 'visible-session',
      requestId: chunkFirstRequest.requestId,
      mode: 'delta',
      messages: [{
        id: 'persisted-row-2',
        role: 'assistant',
        content: 'delta answer',
        sessionId: 'visible-session',
        ts: 3,
      }],
      latestSeq: 2,
      hasMore: false,
    });
    expect(store.yeaftSessionHistoryState['agent-a\u001fvisible-session']).toEqual(expect.objectContaining({
      loading: false,
      requestId: null,
      latestSeq: 2,
    }));
    store.handleYeaftOutput({
      type: 'yeaft_output',
      agentId: 'agent-a',
      conversationId: bridgeConversationId,
      sessionId: 'visible-session',
      requestId: request.requestId,
      event: {
        type: 'history_loaded',
        agentId: 'agent-a',
        sessionId: 'visible-session',
        requestId: request.requestId,
        mode: 'recent',
        count: 1,
        latestSeq: 1,
      },
    });
    expect(store.yeaftSessionHistoryState['agent-a\u001fvisible-session']).toEqual(expect.objectContaining({
      loading: false,
      requestId: null,
      latestSeq: 2,
    }));
    // A completion that follows a committed chunk is intentionally ignored;
    // chunk metadata already advanced the cursor and count exactly once.
    store.handleYeaftOutput({
      type: 'yeaft_output',
      agentId: 'agent-a',
      conversationId: bridgeConversationId,
      sessionId: 'visible-session',
      requestId: chunkFirstRequest.requestId,
      event: {
        type: 'history_loaded',
        agentId: 'agent-a',
        sessionId: 'visible-session',
        requestId: chunkFirstRequest.requestId,
        mode: 'delta',
        count: 1,
        latestSeq: 2,
      },
    });
    expect(store.yeaftSessionHistoryState['agent-a\u001fvisible-session']).toEqual(expect.objectContaining({
      loading: false,
      requestId: null,
      latestSeq: 2,
    }));
    expect(store.messagesMap[bridgeConversationId]).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'persisted-row-2', content: 'delta answer' }),
    ]));

    // A refresh can merge persisted rows from different storage generations.
    // Sequence is comparable only when both rows have it: a newly persisted row
    // must not jump above older legacy history merely because the legacy row has
    // no m#### id, and a live optimistic tail must remain last.
    store.messagesMap[bridgeConversationId] = [{
      id: optimisticId,
      messageId: optimisticId,
      clientMessageId: optimisticId,
      type: 'user',
      content: 'pending send',
      sessionId: 'visible-session',
      turnId: optimisticId,
      timestamp: 3_000,
    }];
    const mixedGenerationRequest = store.beginYeaftHistoryLoad({
      agentId: 'agent-a',
      sessionId: 'visible-session',
      mode: 'recent',
      preserveLoaded: false,
    });
    store.handleMessage({
      type: 'yeaft_history_chunk',
      agentId: 'agent-a',
      conversationId: bridgeConversationId,
      sessionId: 'visible-session',
      requestId: mixedGenerationRequest.requestId,
      mode: 'recent',
      messages: [{
        id: 'legacy-history-row',
        role: 'user',
        content: 'legacy history',
        sessionId: 'visible-session',
        ts: 1_000,
      }, {
        id: 'm0002',
        seq: 2,
        role: 'assistant',
        content: 'new persisted answer',
        sessionId: 'visible-session',
        ts: 2_000,
      }],
      oldestSeq: 2,
      latestSeq: 2,
      hasMore: false,
    });
    expect(store.messagesMap[bridgeConversationId]
      .filter(row => row.sessionId === 'visible-session')
      .map(row => row.content)).toEqual([
      'legacy history',
      'new persisted answer',
      'pending send',
    ]);

    // Sorting must be independent of the current array permutation. The three
    // storage generations previously formed a comparison cycle here.
    const legacyRow = {
      id: 'legacy-permutation-row',
      messageId: 'legacy-permutation-row',
      type: 'user',
      content: 'legacy permutation',
      sessionId: 'visible-session',
      timestamp: 200,
      isHistory: true,
    };
    const sequencedRow = {
      id: 'm0003',
      messageId: 'm0003',
      seq: 3,
      type: 'assistant',
      content: 'sequenced permutation',
      sessionId: 'visible-session',
      timestamp: 300,
      isHistory: true,
    };
    const liveRow = {
      id: 'live-permutation-row',
      messageId: 'live-permutation-row',
      clientMessageId: 'live-permutation-row',
      type: 'user',
      content: 'live permutation',
      sessionId: 'visible-session',
      timestamp: 100,
    };
    const permutations = [
      [legacyRow, sequencedRow, liveRow],
      [legacyRow, liveRow, sequencedRow],
      [sequencedRow, legacyRow, liveRow],
      [sequencedRow, liveRow, legacyRow],
      [liveRow, legacyRow, sequencedRow],
      [liveRow, sequencedRow, legacyRow],
    ];
    for (const rows of permutations) {
      const sorted = rows.map(row => ({ ...row }));
      __testSortYeaftRowsBySequence(sorted);
      expect(sorted.map(row => row.content)).toEqual([
        'legacy permutation',
        'sequenced permutation',
        'live permutation',
      ]);
    }

    // Empty history still has a real chunk frame. Completion-first must not
    // strand a first-ever empty Session in loading state or manufacture rows.
    const emptyRequest = store.beginYeaftHistoryLoad({
      agentId: 'agent-a',
      sessionId: 'empty-session',
      mode: 'recent',
      preserveLoaded: false,
    });
    store.handleYeaftOutput({
      type: 'yeaft_output',
      agentId: 'agent-a',
      conversationId: bridgeConversationId,
      sessionId: 'empty-session',
      requestId: emptyRequest.requestId,
      event: {
        type: 'history_loaded',
        sessionId: 'empty-session',
        requestId: emptyRequest.requestId,
        mode: 'recent',
        count: 0,
        oldestSeq: null,
        latestSeq: null,
        hasMore: false,
      },
    });
    expect(store.yeaftSessionHistoryState['agent-a\u001fempty-session']).toEqual(expect.objectContaining({
      loading: true,
      requestId: emptyRequest.requestId,
      completionSeen: true,
    }));
    store.handleMessage({
      type: 'yeaft_history_chunk',
      agentId: 'agent-a',
      conversationId: bridgeConversationId,
      sessionId: 'empty-session',
      requestId: emptyRequest.requestId,
      mode: 'recent',
      messages: [],
      oldestSeq: null,
      latestSeq: null,
      hasMore: false,
    });
    expect(store.yeaftSessionHistoryState['agent-a\u001fempty-session']).toEqual(expect.objectContaining({
      loaded: true,
      loading: false,
      requestId: null,
      count: 0,
      hasMore: false,
    }));
    expect(store.messagesMap[bridgeConversationId].filter(row => row.sessionId === 'empty-session')).toEqual([]);

    // Metadata arriving after the chunk is an idempotent refresh, not a second
    // migration that recreates the local key or loses processing state.
    store.handleYeaftOutput({
      agentId: 'agent-a',
      sessionId: 'visible-session',
      event: {
        type: 'session_ready',
        conversationId: bridgeConversationId,
        sessionId: 'visible-session',
        tasks: [],
      },
    });
    expect(store.yeaftConversationId).toBe(bridgeConversationId);
    expect(store.messagesMap[localConversationId]).toBeUndefined();
    expect(store.processingConversations).toEqual({ [bridgeConversationId]: true });
    expect(store.executionStatusMap[bridgeConversationId].currentTool).toEqual({ name: 'Bash' });

    // After an Agent restart, the browser can still own visible state under the
    // previous real bridge id while the new process emits history before
    // session_ready. The chunk must not overwrite the only migration source.
    const restartedConversationId = 'yeaft-agent-a-restarted';
    const restartPendingId = 'u_restart_pending';
    store.messagesMap[bridgeConversationId].push({
      id: restartPendingId,
      messageId: restartPendingId,
      clientMessageId: restartPendingId,
      type: 'user',
      content: 'pending across restart',
      sessionId: 'visible-session',
      turnId: restartPendingId,
      timestamp: 3,
    });
    store.processingConversations = { [bridgeConversationId]: true };
    store.executionStatusMap = {
      [bridgeConversationId]: {
        currentTool: { name: 'Grep' },
        toolHistory: [],
        lastActivity: 3,
      },
    };
    const restartWatchdog = setTimeout(() => {}, 60_000);
    store._processingWatchdogs = { [bridgeConversationId]: restartWatchdog };
    store._yeaftWatchdogConvs = new Set([bridgeConversationId]);
    const restartRequest = store.beginYeaftHistoryLoad({
      agentId: 'agent-a',
      sessionId: 'visible-session',
      mode: 'delta',
      preserveLoaded: true,
    });
    store.handleMessage({
      type: 'yeaft_history_chunk',
      agentId: 'agent-a',
      conversationId: restartedConversationId,
      sessionId: 'visible-session',
      requestId: restartRequest.requestId,
      mode: 'delta',
      messages: [{
        id: 'restart-persisted-row',
        role: 'assistant',
        content: 'persisted after restart',
        sessionId: 'visible-session',
        ts: 4,
      }],
      latestSeq: 2,
      hasMore: false,
    });
    expect(store.yeaftConversationId).toBe(bridgeConversationId);
    expect(store.yeaftConversationIdsByAgent['agent-a']).toBe(bridgeConversationId);
    expect(store.messagesMap[restartedConversationId]).toEqual([
      expect.objectContaining({ id: 'restart-persisted-row' }),
    ]);

    store.handleYeaftOutput({
      agentId: 'agent-a',
      sessionId: 'visible-session',
      event: {
        type: 'session_ready',
        conversationId: restartedConversationId,
        sessionId: 'visible-session',
        tasks: [],
      },
    });
    expect(store.yeaftConversationId).toBe(restartedConversationId);
    expect(store.yeaftConversationIdsByAgent['agent-a']).toBe(restartedConversationId);
    expect(store.messagesMap[restartedConversationId]).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: restartPendingId, content: 'pending across restart' }),
      expect.objectContaining({ id: 'restart-persisted-row', content: 'persisted after restart' }),
    ]));
    expect(store.processingConversations).toEqual({ [restartedConversationId]: true });
    expect(store.executionStatusMap[restartedConversationId].currentTool).toEqual({ name: 'Grep' });
    expect(store.executionStatusMap[bridgeConversationId]).toBeUndefined();
    expect(store._processingWatchdogs[bridgeConversationId]).toBeUndefined();
    expect(store._yeaftWatchdogConvs.has(bridgeConversationId)).toBe(false);
    expect(store._processingWatchdogs[restartedConversationId]).toBeTruthy();
    expect(store._yeaftWatchdogConvs.has(restartedConversationId)).toBe(true);

    // A delayed bootstrap can transiently report an empty recent window while
    // this Session already has visible cached history. Treat the reply as a
    // completed refresh, but never let it erase the pane the user is reading.
    const rowsBeforeEmptyRefresh = store.messagesMap[restartedConversationId]
      .filter(row => row.sessionId === 'visible-session')
      .map(row => ({ id: row.id, content: row.content }));
    const stateBeforeEmptyRefresh = store.yeaftSessionHistoryState['agent-a\u001fvisible-session'];
    const emptyRefreshRequest = store.beginYeaftHistoryLoad({
      agentId: 'agent-a',
      sessionId: 'visible-session',
      mode: 'recent',
      preserveLoaded: false,
    });
    expect(store.yeaftSessionHistoryState['agent-a\u001fvisible-session']).toEqual(expect.objectContaining({
      loaded: true,
      loading: true,
      hasMore: stateBeforeEmptyRefresh.hasMore,
      oldestSeq: stateBeforeEmptyRefresh.oldestSeq,
      latestSeq: stateBeforeEmptyRefresh.latestSeq,
      count: stateBeforeEmptyRefresh.count,
      syncingAfterSeq: null,
    }));
    store.handleMessage({
      type: 'yeaft_history_chunk',
      agentId: 'agent-a',
      conversationId: restartedConversationId,
      sessionId: 'visible-session',
      requestId: emptyRefreshRequest.requestId,
      mode: 'recent',
      messages: [],
      oldestSeq: null,
      latestSeq: null,
      hasMore: false,
    });
    expect(store.messagesMap[restartedConversationId]
      .filter(row => row.sessionId === 'visible-session')
      .map(row => ({ id: row.id, content: row.content }))).toEqual(rowsBeforeEmptyRefresh);
    expect(store.yeaftSessionHistoryState['agent-a\u001fvisible-session']).toEqual(expect.objectContaining({
      loaded: true,
      loading: false,
      requestId: null,
      hasMore: stateBeforeEmptyRefresh.hasMore,
      oldestSeq: stateBeforeEmptyRefresh.oldestSeq,
      latestSeq: stateBeforeEmptyRefresh.latestSeq,
      count: stateBeforeEmptyRefresh.count,
    }));

    const emptySessionRequest = store.beginYeaftHistoryLoad({
      agentId: 'agent-a',
      sessionId: 'never-had-messages',
      mode: 'recent',
      preserveLoaded: false,
    });
    store.handleMessage({
      type: 'yeaft_history_chunk',
      agentId: 'agent-a',
      conversationId: restartedConversationId,
      sessionId: 'never-had-messages',
      requestId: emptySessionRequest.requestId,
      mode: 'recent',
      messages: [],
      oldestSeq: null,
      latestSeq: null,
      hasMore: false,
    });
    expect(store.messagesMap[restartedConversationId]
      .filter(row => row.sessionId === 'never-had-messages')).toEqual([]);
    expect(store.yeaftSessionHistoryState['agent-a\u001fnever-had-messages']).toEqual(expect.objectContaining({
      loaded: true,
      loading: false,
      count: 0,
      hasMore: false,
      requestId: null,
    }));

    clearTimeout(store._processingWatchdogs[restartedConversationId]);
    storeFactories.clear();

    const routedStore = makeStore();
    routedStore.yeaftConversationIdsByAgent = {
      'agent-1': 'conv-1',
      'agent-2': 'conv-2',
    };
    routedStore.messagesMap['conv-2'] = [];
    routedStore._currentYeaftSessionId = 'session-2';
    routedStore._currentYeaftVpId = 'vp-2';
    routedStore._currentYeaftTurnId = 'turn-2';

    addMessageToConversation(routedStore, 'conv-2', {
      id: 'msg-2',
      type: 'assistant',
      content: 'background',
    });

    expect(routedStore.yeaftConversationId).toBe('conv-1');
    expect(routedStore.messagesMap['conv-2'][0]).toMatchObject({
      sessionId: 'session-2',
      vpId: 'vp-2',
      turnId: 'turn-2',
      speakerVpId: 'vp-2',
    });

    const firstSibling = { type: 'user', content: 'identical legacy sibling' };
    const secondSibling = { type: 'user', content: 'identical legacy sibling' };
    const firstRow = addMessageToConversation(routedStore, 'conv-2', firstSibling);
    const secondRow = addMessageToConversation(routedStore, 'conv-2', secondSibling);
    expect(firstRow.uiKey).toMatch(/^legacy:conv-2:/);
    expect(secondRow.uiKey).toMatch(/^legacy:conv-2:/);
    expect(firstRow.uiKey).not.toBe(secondRow.uiKey);
    const stableSiblingKeys = [firstRow.uiKey, secondRow.uiKey];
    routedStore.messagesMap['conv-2'].unshift({
      type: 'user', content: 'older legacy row', uiKey: 'legacy:conv-2:older',
    });
    expect(routedStore.messagesMap['conv-2'].slice(-2).map(row => row.uiKey))
      .toEqual(stableSiblingKeys);
    routedStore._messageUiKeySequence = 0;
    const restoredSibling = addMessageToConversation(routedStore, 'conv-2', {
      type: 'user', content: 'post-restore legacy sibling',
    });
    expect(stableSiblingKeys).not.toContain(restoredSibling.uiKey);
  });

  it('counts Yeaft assistant turns and keeps declared long phases alive', () => {
    const conversationId = 'yeaft-watchdog-long-phase';
    const watchdogStore = {
      processingConversations: { [conversationId]: true },
      executionStatusMap: { [conversationId]: { currentTool: { name: 'Bash' } } },
      sessionHealth: {},
      finishStreamingForConversation: vi.fn(),
    };
    vi.useFakeTimers();
    try {
      const phaseStore = useChatStore();
      phaseStore.yeaftConversationIdsByAgent = { 'agent-watchdog': conversationId };
      phaseStore.processingConversations = { [conversationId]: true };
      phaseStore.executionStatusMap = { [conversationId]: { currentTool: null, toolHistory: [] } };
      phaseStore._processingWatchdogs = {};
      phaseStore._yeaftWatchdogConvs = new Set();
      phaseStore._yeaftWatchdogPauseReasons = {};
      phaseStore.handleYeaftOutput({
        agentId: 'agent-watchdog',
        conversationId,
        sessionId: 'session-watchdog',
        event: { type: 'vp_status_changed', vpId: 'vp-watchdog', state: 'thinking' },
      });
      expect([...phaseStore._yeaftWatchdogPauseReasons[conversationId]])
        .toEqual(['thinking:vp-watchdog:thread:session']);
      vi.advanceTimersByTime(300_001);
      expect(phaseStore.processingConversations[conversationId]).toBe(true);
      phaseStore.handleYeaftOutput({
        agentId: 'agent-watchdog',
        conversationId,
        sessionId: 'session-watchdog',
        event: { type: 'vp_status_changed', vpId: 'vp-watchdog', state: 'streaming' },
      });
      expect(phaseStore._yeaftWatchdogPauseReasons[conversationId]).toBeUndefined();
      phaseStore.handleYeaftOutput({
        agentId: 'agent-watchdog',
        conversationId,
        sessionId: 'session-watchdog',
        event: { type: 'vp_status_changed', vpId: 'vp-a', turnId: 'turn-a', state: 'thinking' },
      });
      phaseStore.handleYeaftOutput({
        agentId: 'agent-watchdog',
        conversationId,
        sessionId: 'session-watchdog',
        event: { type: 'vp_status_changed', vpId: 'vp-b', turnId: 'turn-b', state: 'thinking' },
      });
      phaseStore.handleYeaftOutput({
        agentId: 'agent-watchdog',
        conversationId,
        sessionId: 'session-watchdog',
        event: { type: 'vp_status_changed', vpId: 'vp-a', turnId: 'turn-a', state: 'streaming' },
      });
      expect([...phaseStore._yeaftWatchdogPauseReasons[conversationId]])
        .toEqual(['thinking:vp-b:thread:turn-b']);
      expect(phaseStore._processingWatchdogs[conversationId]).toBeUndefined();
      stopProcessingWatchdog(phaseStore, conversationId);

      startYeaftWatchdog(watchdogStore, conversationId);
      pauseYeaftWatchdog(watchdogStore, conversationId);
      vi.advanceTimersByTime(600_001);
      expect(watchdogStore.processingConversations[conversationId]).toBe(true);
      expect(watchdogStore.executionStatusMap[conversationId].currentTool).toEqual({ name: 'Bash' });
      expect(watchdogStore.finishStreamingForConversation).not.toHaveBeenCalled();

      resumeYeaftWatchdog(watchdogStore, conversationId);
      vi.advanceTimersByTime(150_000);
      expect(watchdogStore.processingConversations[conversationId]).toBeUndefined();
      expect(watchdogStore.executionStatusMap[conversationId].currentTool).toBeNull();

      watchdogStore.processingConversations[conversationId] = true;
      startYeaftWatchdog(watchdogStore, conversationId);
      pauseYeaftWatchdog(watchdogStore, conversationId);
      vi.advanceTimersByTime(300_001);
      expect(watchdogStore.processingConversations[conversationId]).toBe(true);
      expect(watchdogStore.finishStreamingForConversation).toHaveBeenCalledTimes(1);
    } finally {
      stopProcessingWatchdog(watchdogStore, conversationId);
      vi.useRealTimers();
    }

    const messages = [
      { type: 'user', content: 'u1' },
      { type: 'tool-use', toolName: 'Bash', turnId: 'a', speakerVpId: 'vp-1' },
      { type: 'tool-result', toolUseId: 't1', turnId: 'a', speakerVpId: 'vp-1' },
      { type: 'assistant', content: 'a1', turnId: 'a', speakerVpId: 'vp-1' },
      { type: 'user', content: 'u2' },
      { type: 'assistant', content: 'a2', turnId: 'b', speakerVpId: 'vp-1' },
    ];

    expect(buildYeaftMessageTurnSpans(messages).map(s => s.kind)).toEqual([
      'user',
      'user',
    ]);
    expect(hasHiddenYeaftMessageTurns(messages, 1)).toBe(true);
    expect(sliceYeaftMessagesByRecentTurns(messages, 1)).toEqual(messages.slice(4));
  });
});
