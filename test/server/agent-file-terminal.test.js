import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Vue from 'vue';
import { createWsHandler } from '../../web/components/files/wsHandler.js';
import { createFileTabs } from '../../web/components/files/fileTabs.js';
import ctx from '../../agent/context.js';
import { CONFIG } from '../../server/config.js';
import { userDb, yeaftSessionDb } from '../../server/database.js';
import { handleWriteFile } from '../../agent/workbench/file-ops.js';

const {
  forwardToClients,
  forwardToAgent,
  sendToWebClient,
  sendToAgent,
  agents,
  previewFiles,
  userFileTabs,
  webClients,
} = vi.hoisted(() => ({
  forwardToClients: vi.fn(async () => {}),
  forwardToAgent: vi.fn(async () => {}),
  sendToWebClient: vi.fn(async () => {}),
  sendToAgent: vi.fn(async () => {}),
  agents: new Map(),
  previewFiles: new Map(),
  userFileTabs: new Map(),
  webClients: new Map(),
}));

vi.mock('../../server/context.js', () => ({
  agents,
  previewFiles,
  userFileTabs,
  webClients,
}));

vi.mock('../../server/ws-utils.js', () => ({
  sendToWebClient,
  sendToAgent,
  forwardToClients,
  forwardToAgent,
  verifyConversationOwnership: vi.fn(() => true),
  getCachedDir: vi.fn(() => null),
  setCachedDir: vi.fn(),
  invalidateParentDirCache: vi.fn(),
  clearAgentDirCache: vi.fn(),
}));

const { handleAgentFileTerminal } = await import('../../server/handlers/agent-file-terminal.js');
const { handleClientMisc } = await import('../../server/handlers/client-misc.js');
const { handleClientWorkbench } = await import('../../server/handlers/client-workbench.js');
const {
  __testExpireWorkbenchRequest,
  __testResetWorkbenchCorrelations,
  getWorkbenchTerminalOwner,
} = await import('../../server/workbench-correlation.js');
const {
  workbenchRouteKey,
  workbenchWorkspaceGeneration,
} = await import('../../server/workbench-route.js');

function routeClient(userId, overrides = {}) {
  return {
    authenticated: true,
    userId,
    role: 'pro',
    workbenchRouteProtocol: 1,
    ...overrides,
  };
}

function installRouteAgent(agentId, sessions = []) {
  agents.set(agentId, {
    ownerId: sessions[0]?.userId || null,
    capabilities: ['terminal', 'file_editor', 'workbench_session_routes'],
    conversations: new Map(),
    yeaftSessions: new Map(sessions.map(session => [session.id, { ...session }])),
  });
}

async function registerRouteRequest({
  type,
  agentId = 'agent-1',
  sessionId = 'session-1',
  clientId = 'client-1',
  userId = 'user-1',
  workDir = '/workspace/session-1',
  requestId = null,
  extra = {},
}) {
  const route = { runtimeProvider: 'yeaft', agentId, sessionId };
  const client = routeClient(userId, { currentAgent: agentId });
  webClients.set(clientId, client);
  installRouteAgent(agentId, [{ id: sessionId, workDir, userId }]);
  forwardToAgent.mockClear();
  const handled = await handleClientWorkbench(
    clientId,
    client,
    {
      type,
      agentId,
      workDir,
      workbenchRoute: route,
      ...(requestId ? { requestId } : {}),
      ...extra,
    },
    async () => true,
  );
  const outbound = forwardToAgent.mock.calls.at(-1)?.[1] || null;
  return { handled, route, client, outbound };
}

describe('Agent file terminal forwarding', () => {
  const createdUsers = [];
  const originalSkipAuth = CONFIG.skipAuth;

  beforeEach(() => {
    CONFIG.skipAuth = true;
    forwardToClients.mockClear();
    forwardToAgent.mockClear();
    sendToWebClient.mockClear();
    sendToAgent.mockClear();
    __testResetWorkbenchCorrelations();
    agents.clear();
    previewFiles.clear();
    userFileTabs.clear();
    webClients.clear();
  });

  afterEach(() => {
    CONFIG.skipAuth = originalSkipAuth;
    for (const userId of createdUsers.splice(0)) userDb.deleteUser(userId);
  });

  it('authorizes a Yeaft Workbench route and replaces browser cwd with canonical Session metadata', async () => {
    const suffix = `${process.pid}-${Date.now()}`;
    const user = userDb.getOrCreate(`workbench-user-${suffix}`);
    const userId = user.id;
    const agentId = `workbench-agent-${suffix}`;
    const sessionId = `workbench-session-${suffix}`;
    const route = { runtimeProvider: 'yeaft', agentId, sessionId };
    const canonicalWorkDir = `/canonical/${sessionId}`;
    const previousSkipAuth = CONFIG.skipAuth;
    CONFIG.skipAuth = false;
    yeaftSessionDb.upsertFromSnapshot(userId, agentId, {
      id: sessionId,
      name: 'Workbench route test',
      workDir: canonicalWorkDir,
    });
    try {
      agents.set(agentId, { capabilities: ['workbench_session_routes'] });
      const handled = await handleClientWorkbench(
        'client-route',
        {
          userId,
          role: 'pro',
          currentAgent: agentId,
          currentConversation: 'shared-yeaft-conversation',
          workbenchRouteProtocol: 1,
        },
        {
          type: 'terminal_create',
          agentId,
          conversationId: 'browser-forged-conversation',
          workDir: '/browser/forged',
          workbenchRoute: route,
          workbenchRouteKey: workbenchRouteKey(route),
          terminalId: 'term-route',
          cols: 80,
          rows: 24,
        },
        async requestedAgentId => requestedAgentId === agentId,
      );

      expect(handled).toBe(true);
      expect(forwardToAgent).toHaveBeenCalledWith(agentId, expect.objectContaining({
        type: 'terminal_create',
        agentId,
        workDir: canonicalWorkDir,
        workbenchRouteKey: workbenchRouteKey(route),
        conversationId: `_workbench:${workbenchRouteKey(route)}`,
        workbenchWorkspaceGeneration: workbenchWorkspaceGeneration(
          workbenchRouteKey(route),
          canonicalWorkDir,
        ),
        _workbenchRequestId: expect.any(String),
      }));
      expect(forwardToAgent.mock.calls[0][1]).not.toHaveProperty('_requestUserId');
      expect(forwardToAgent.mock.calls[0][1]).not.toHaveProperty('_requestClientId');
      expect(forwardToAgent.mock.calls[0][1].workDir).not.toBe('/browser/forged');

      forwardToAgent.mockClear();
      await handleClientWorkbench(
        'client-route',
        { userId, role: 'pro', currentAgent: agentId, workbenchRouteProtocol: 1 },
        {
          type: 'git_status',
          agentId,
          workDir: '/workspace/selected-repository',
          workbenchRoute: route,
          workbenchRouteKey: workbenchRouteKey(route),
        },
        async requestedAgentId => requestedAgentId === agentId,
      );
      expect(forwardToAgent).toHaveBeenCalledWith(agentId, expect.objectContaining({
        type: 'git_status',
        workDir: '/workspace/selected-repository',
        workbenchRouteKey: workbenchRouteKey(route),
      }));
    } finally {
      yeaftSessionDb.deleteForAgent(userId, agentId, sessionId);
      userDb.deleteUser(userId);
      CONFIG.skipAuth = previousSkipAuth;
    }
  });

  it('allows legacy only for an explicitly old-Web and old-Agent pairing', async () => {
    const combinations = [
      { clientProtocol: 0, agentRoutes: false, allowed: true },
      { clientProtocol: 1, agentRoutes: false, allowed: false },
      { clientProtocol: 0, agentRoutes: true, allowed: false },
      { clientProtocol: 1, agentRoutes: true, allowed: false },
    ];
    for (const combination of combinations) {
      forwardToAgent.mockClear();
      sendToWebClient.mockClear();
      const agentId = `matrix-agent-${combination.clientProtocol}-${combination.agentRoutes}`;
      agents.set(agentId, {
        capabilities: combination.agentRoutes
          ? ['terminal', 'workbench_session_routes']
          : ['terminal'],
        conversations: new Map([['legacy-conversation', { workDir: '/trusted/cwd', userId: 'matrix-user' }]]),
      });
      const handled = await handleClientWorkbench(
        'matrix-client',
        routeClient('matrix-user', {
          currentAgent: agentId,
          workbenchRouteProtocol: combination.clientProtocol,
        }),
        {
          type: 'terminal_create',
          agentId,
          conversationId: 'legacy-conversation',
          workDir: '/browser-controlled/cwd',
          terminalId: 'matrix-terminal',
        },
        async () => true,
      );
      if (combination.allowed) {
        expect(handled).toBe(true);
        expect(forwardToAgent).toHaveBeenCalledWith(agentId, expect.objectContaining({
          conversationId: 'legacy-conversation',
          workDir: '/browser-controlled/cwd',
        }));
      } else {
        expect(handled).toBeUndefined();
        expect(forwardToAgent).not.toHaveBeenCalled();
      }
    }
  });

  it('rejects route-scoped requests when the Agent lacks protocol support', async () => {
    const previousSkipAuth = CONFIG.skipAuth;
    CONFIG.skipAuth = true;
    const agentId = 'legacy-workbench-agent';
    const route = { runtimeProvider: 'yeaft', agentId, sessionId: 'session-1' };
    agents.set(agentId, {
      capabilities: ['terminal', 'file_editor'],
      yeaftSessions: new Map([['session-1', { id: 'session-1', workDir: '/legacy' }]]),
    });
    try {
      expect(await handleClientWorkbench(
        'legacy-client',
        routeClient('local-user', { currentAgent: agentId }),
        { type: 'terminal_create', agentId, workbenchRoute: route },
        async () => true,
      )).toBeUndefined();
      expect(forwardToAgent).not.toHaveBeenCalled();
      expect(sendToWebClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        type: 'error',
        message: 'Invalid Workbench Session route',
      }));
    } finally {
      CONFIG.skipAuth = previousSkipAuth;
      agents.clear();
    }
  });

  it('allows deleted-Session cleanup only for the Server-recorded PTY owner', async () => {
    const created = await registerRouteRequest({
      type: 'terminal_create',
      agentId: 'deleted-session-agent',
      sessionId: 'deleted-session',
      clientId: 'cleanup-client',
      userId: 'local-user',
      workDir: '/workspace/deleted',
      extra: { terminalId: 'term-1', cols: 80, rows: 24 },
    });
    await handleAgentFileTerminal('deleted-session-agent', {}, {
      type: 'terminal_created',
      conversationId: created.outbound.conversationId,
      terminalId: 'term-1',
      success: true,
      _workbenchRequestId: created.outbound._workbenchRequestId,
    });
    expect(getWorkbenchTerminalOwner('deleted-session-agent', 'term-1')).toMatchObject({
      clientId: 'cleanup-client',
      routeKey: workbenchRouteKey(created.route),
    });

    agents.get('deleted-session-agent').yeaftSessions.clear();
    forwardToAgent.mockClear();
    expect(await handleClientWorkbench(
      'cleanup-client',
      created.client,
      {
        type: 'terminal_close',
        agentId: 'deleted-session-agent',
        terminalId: 'term-1',
        workbenchRoute: created.route,
        workbenchWorkspaceGeneration: created.outbound.workbenchWorkspaceGeneration,
      },
      async () => true,
    )).toBe(true);
    expect(forwardToAgent).toHaveBeenCalledWith('deleted-session-agent', expect.objectContaining({
      type: 'terminal_close',
      terminalId: 'term-1',
      workbenchRouteKey: workbenchRouteKey(created.route),
      workbenchWorkspaceGeneration: created.outbound.workbenchWorkspaceGeneration,
    }));

    forwardToAgent.mockClear();
    expect(await handleClientWorkbench(
      'other-client',
      routeClient('other-user', { currentAgent: 'deleted-session-agent' }),
      {
        type: 'terminal_close',
        agentId: 'deleted-session-agent',
        terminalId: 'term-1',
        workbenchRoute: created.route,
        workbenchWorkspaceGeneration: created.outbound.workbenchWorkspaceGeneration,
      },
      async () => true,
    )).toBeUndefined();
    expect(forwardToAgent).not.toHaveBeenCalled();
  });

  it('rejects archived Sessions but allows owner-proven PTY cleanup', async () => {
    const suffix = `${process.pid}-${Date.now()}-archived`;
    const user = userDb.getOrCreate(`workbench-archived-${suffix}`);
    createdUsers.push(user.id);
    const agentId = `archived-agent-${suffix}`;
    const sessionId = `archived-session-${suffix}`;
    const route = { runtimeProvider: 'yeaft', agentId, sessionId };
    const client = routeClient(user.id, { currentAgent: agentId });
    agents.set(agentId, {
      ownerId: user.id,
      capabilities: ['terminal', 'file_editor', 'workbench_session_routes'],
      conversations: new Map(),
      yeaftSessions: new Map(),
    });
    yeaftSessionDb.upsertFromSnapshot(user.id, agentId, {
      id: sessionId,
      workDir: '/workspace/archived',
    });
    try {
      CONFIG.skipAuth = false;
      webClients.set('archived-client', client);
      await handleClientWorkbench(
        'archived-client',
        client,
        {
          type: 'terminal_create',
          agentId,
          terminalId: 'archived-terminal',
          cols: 80,
          rows: 24,
          workbenchRoute: route,
        },
        async () => true,
      );
      const create = forwardToAgent.mock.calls.at(-1)[1];
      await handleAgentFileTerminal(agentId, {}, {
        type: 'terminal_created',
        conversationId: create.conversationId,
        terminalId: 'archived-terminal',
        success: true,
        _workbenchRequestId: create._workbenchRequestId,
      });
      yeaftSessionDb.setArchivedForAgent(user.id, agentId, sessionId, true);

      forwardToAgent.mockClear();
      sendToWebClient.mockClear();
      expect(await handleClientWorkbench(
        'archived-client',
        client,
        {
          type: 'write_file',
          agentId,
          filePath: 'blocked.md',
          content: 'blocked',
          workbenchRoute: route,
        },
        async () => true,
      )).toBeUndefined();
      expect(forwardToAgent).not.toHaveBeenCalled();

      expect(await handleClientWorkbench(
        'archived-client',
        client,
        {
          type: 'terminal_close',
          agentId,
          terminalId: 'archived-terminal',
          workbenchRoute: route,
          workbenchWorkspaceGeneration: create.workbenchWorkspaceGeneration,
        },
        async () => true,
      )).toBe(true);
      expect(forwardToAgent).toHaveBeenCalledWith(agentId, expect.objectContaining({
        type: 'terminal_close',
        terminalId: 'archived-terminal',
        workbenchWorkspaceGeneration: create.workbenchWorkspaceGeneration,
      }));
    } finally {
      yeaftSessionDb.deleteForAgent(user.id, agentId, sessionId);
    }
  });

  it('allows ownerless global Agent snapshots only for an admin', async () => {
    CONFIG.skipAuth = false;
    const agentId = 'global-workbench-agent';
    const route = { runtimeProvider: 'yeaft', agentId, sessionId: 'global-session' };
    agents.set(agentId, {
      ownerId: null,
      capabilities: ['terminal', 'file_editor', 'workbench_session_routes'],
      conversations: new Map(),
      yeaftSessions: new Map([['global-session', {
        id: 'global-session',
        workDir: '/workspace/global',
      }]]),
    });
    const pro = routeClient('pro-user', { currentAgent: agentId, role: 'pro' });
    expect(await handleClientWorkbench(
      'pro-client',
      pro,
      { type: 'git_status', agentId, workbenchRoute: route },
      async () => true,
    )).toBeUndefined();
    expect(forwardToAgent).not.toHaveBeenCalled();

    const admin = routeClient('admin-user', { currentAgent: agentId, role: 'admin' });
    expect(await handleClientWorkbench(
      'admin-client',
      admin,
      { type: 'git_status', agentId, workbenchRoute: route },
      async () => true,
    )).toBe(true);
    expect(forwardToAgent).toHaveBeenCalledWith(agentId, expect.objectContaining({
      type: 'git_status',
      workDir: '/workspace/global',
    }));
  });

  it('isolates persisted file tabs by canonical workspace generation', async () => {
    const agentId = 'tabs-agent';
    const sessionId = 'tabs-session';
    const client = routeClient('tabs-user', { currentAgent: agentId });
    const route = { runtimeProvider: 'yeaft', agentId, sessionId };
    installRouteAgent(agentId, [{ id: sessionId, workDir: '/workspace/a', userId: 'tabs-user' }]);

    await handleClientMisc('tabs-client', client, {
      type: 'update_file_tabs',
      agentId,
      workbenchRoute: route,
      openFiles: [{ path: 'a.md' }],
      activeIndex: 0,
    }, async () => true);
    agents.get(agentId).yeaftSessions.set(sessionId, {
      id: sessionId,
      workDir: '/workspace/b',
      userId: 'tabs-user',
    });
    sendToWebClient.mockClear();
    await handleClientMisc('tabs-client', client, {
      type: 'restore_file_tabs',
      agentId,
      workbenchRoute: route,
    }, async () => true);
    expect(sendToWebClient).toHaveBeenCalledWith(client, expect.objectContaining({
      type: 'file_tabs_restored',
      workbenchWorkspaceGeneration: workbenchWorkspaceGeneration(
        workbenchRouteKey(route),
        '/workspace/b',
      ),
      openFiles: [],
    }));
  });

  it('uses the live Agent Session snapshot only in local no-auth mode', async () => {
    const previousSkipAuth = CONFIG.skipAuth;
    CONFIG.skipAuth = true;
    const agentId = 'local-workbench-agent';
    const sessionId = 'local-workbench-session';
    const route = { runtimeProvider: 'yeaft', agentId, sessionId };
    agents.set(agentId, {
      capabilities: ['workbench_session_routes'],
      yeaftSessions: new Map([[sessionId, { id: sessionId, workDir: '/local/session' }]]),
    });
    try {
      expect(await handleClientWorkbench(
        'local-client',
        routeClient('local-user', { currentAgent: agentId }),
        {
          type: 'git_status',
          agentId,
          workDir: '/forged',
          workbenchRoute: route,
          workbenchRouteKey: workbenchRouteKey(route),
        },
        async () => true,
      )).toBe(true);
      expect(forwardToAgent).toHaveBeenCalledWith(agentId, expect.objectContaining({
        type: 'git_status',
        workDir: '/forged',
        workbenchRoute: route,
        workbenchRouteKey: workbenchRouteKey(route),
      }));
    } finally {
      CONFIG.skipAuth = previousSkipAuth;
      agents.clear();
    }
  });

  it('routes an open event with its frozen Agent and conversation identity', () => {
    globalThis.Vue = Vue;
    const openFileInTab = vi.fn();
    const handler = createWsHandler({
      store: { currentConversation: 'new-conversation', currentAgent: 'agent-b' },
      normalizePath: value => value,
      getEffectiveWorkDir: () => '/workspace',
      openFiles: Vue.ref([]),
      activeFileIndex: Vue.ref(-1),
      activeFile: Vue.ref(null),
      fileLoading: Vue.ref(false),
      fileSaving: Vue.ref(false),
      saveTabsState: vi.fn(),
      createEditor: vi.fn(),
      openFileInTab,
      tree: { handleDirectoryListing: vi.fn() },
      setTreeVisible: vi.fn(),
      fp: { handleFolderPickerListing: vi.fn() },
      qo: {},
      ops: { getPendingDownload: () => null, clearPendingDownload: vi.fn() },
      mdPreviewMode: Vue.ref(false),
      renderOfficeLocal: vi.fn(),
      editorContainer: Vue.ref(null),
      debugStatus: Vue.ref(''),
    }).handleOpenFile;

    handler(new CustomEvent('workbench-open-file-in-active-view', { detail: {
      filePath: 'docs/design.md',
      agentId: 'agent-a',
      conversationId: 'yeaft-agent-a',
      workDir: '/agent-a/project',
    } }));

    expect(openFileInTab).toHaveBeenCalledWith('docs/design.md', 'design.md', {
      agentId: 'agent-a',
      conversationId: 'yeaft-agent-a',
      workDir: '/agent-a/project',
    });
  });

  it('keeps writes bound to the tab owner after the active route drifts', () => {
    globalThis.Vue = Vue;
    const sent = [];
    const store = {
      currentAgent: 'agent-a',
      currentConversation: 'conversation-a',
      clientId: 'client-1',
      sendWsMessage: msg => sent.push(msg),
    };
    const tabs = createFileTabs(store, {
      normalizePath: value => value,
      getEffectiveWorkDir: () => '/agent-a/project',
      editorContainer: Vue.ref(null),
      createEditor: vi.fn(),
      destroyEditor: vi.fn(),
      clearFindMarkers: vi.fn(),
      saveCurrentUndoHistory: vi.fn(),
      saveAllUndoHistory: vi.fn(),
      cleanupUndoHistory: vi.fn(),
      deleteConversationHistory: vi.fn(),
      debugStatus: Vue.ref(''),
      mdPreviewMode: Vue.ref(false),
      renderOfficeLocal: vi.fn(),
      performFind: vi.fn(),
      findBarVisible: Vue.ref(false),
      findQuery: Vue.ref(''),
      t: value => value,
    });

    tabs.openFileInTab('docs/design.md', 'design.md', {
      agentId: 'agent-a',
      conversationId: 'conversation-a',
      workDir: '/agent-a/project',
    });
    tabs.activeFile.value.content = 'updated';
    tabs.activeFile.value.isDirty = true;
    store.currentAgent = 'agent-b';
    store.currentConversation = 'conversation-b';
    tabs.saveFile();

    const writeRequest = sent.find(msg => msg.type === 'write_file');
    expect(writeRequest).toMatchObject({
      agentId: 'agent-a',
      conversationId: 'conversation-a',
      workDir: '/agent-a/project',
      filePath: 'docs/design.md',
      content: 'updated',
    });
    expect(writeRequest.requestId).toMatch(/^file-save-/);

    const ownerTab = tabs.activeFile.value;
    const wrongOwnerTab = {
      path: 'docs/design.md',
      name: 'design.md',
      agentId: 'agent-b',
      conversationId: 'conversation-b',
      content: 'other unsaved content',
      originalContent: 'other original',
      isDirty: true,
      pendingSaveRequestId: 'save-b',
    };
    tabs.openFiles.value.push(wrongOwnerTab);
    const saveTabsState = vi.fn();
    const handle = createWsHandler({
      store,
      normalizePath: value => value,
      getEffectiveWorkDir: () => '/agent-b/project',
      openFiles: tabs.openFiles,
      activeFileIndex: tabs.activeFileIndex,
      activeFile: tabs.activeFile,
      fileLoading: tabs.fileLoading,
      fileSaving: tabs.fileSaving,
      saveTabsState,
      createEditor: vi.fn(),
      openFileInTab: tabs.openFileInTab,
      tree: { handleDirectoryListing: vi.fn() },
      setTreeVisible: vi.fn(),
      fp: { handleFolderPickerListing: vi.fn() },
      qo: {},
      ops: { getPendingDownload: () => null, clearPendingDownload: vi.fn() },
      mdPreviewMode: Vue.ref(false),
      renderOfficeLocal: vi.fn(),
      editorContainer: Vue.ref(null),
      debugStatus: Vue.ref(''),
    }).handleWorkbenchMessage;

    const ack = detail => handle(new CustomEvent('workbench-message', {
      detail: { type: 'file_saved', requestedFilePath: 'docs/design.md', success: true, ...detail },
    }));
    const otherBrowserTab = {
      path: 'docs/design.md',
      agentId: 'agent-a',
      conversationId: 'conversation-a',
      content: 'unsaved in another browser',
      originalContent: 'other browser original',
      isDirty: true,
    };
    const otherBrowserFiles = Vue.ref([otherBrowserTab]);
    const otherBrowserSaveTabsState = vi.fn();
    const otherBrowserHandle = createWsHandler({
      store,
      normalizePath: value => value,
      getEffectiveWorkDir: () => '/agent-a/project',
      openFiles: otherBrowserFiles,
      activeFileIndex: Vue.ref(0),
      activeFile: Vue.computed(() => otherBrowserFiles.value[0]),
      fileLoading: Vue.ref(false),
      fileSaving: Vue.ref(false),
      saveTabsState: otherBrowserSaveTabsState,
      createEditor: vi.fn(),
      openFileInTab: vi.fn(),
      tree: { handleDirectoryListing: vi.fn() },
      setTreeVisible: vi.fn(),
      fp: { handleFolderPickerListing: vi.fn() },
      qo: {},
      ops: { getPendingDownload: () => null, clearPendingDownload: vi.fn() },
      mdPreviewMode: Vue.ref(false),
      renderOfficeLocal: vi.fn(),
      editorContainer: Vue.ref(null),
      debugStatus: Vue.ref(''),
    }).handleWorkbenchMessage;
    otherBrowserHandle(new CustomEvent('workbench-message', { detail: {
      type: 'file_saved',
      agentId: 'agent-a',
      conversationId: 'conversation-a',
      requestedFilePath: 'docs/design.md',
      success: true,
    } }));
    expect(otherBrowserTab).toMatchObject({
      originalContent: 'other browser original',
      isDirty: true,
    });
    expect(otherBrowserSaveTabsState).not.toHaveBeenCalled();

    ack({ agentId: 'agent-b', conversationId: 'conversation-a', requestId: writeRequest.requestId });
    ack({ agentId: 'agent-a', conversationId: 'conversation-a', requestId: 'stale-save' });
    expect(ownerTab.isDirty).toBe(true);
    expect(wrongOwnerTab.isDirty).toBe(true);

    // Ctrl/Cmd+S calls saveFile directly. A second save must not overwrite
    // the pending snapshot while an old Agent may return an ACK without id.
    ownerTab.content = 'edited while save was in flight';
    tabs.saveFile();
    expect(sent.filter(msg => msg.type === 'write_file')).toHaveLength(1);
    expect(ownerTab.pendingSaveRequestId).toBe(writeRequest.requestId);
    expect(ownerTab.pendingSaveContent).toBe('updated');

    ack({ agentId: 'agent-a', conversationId: 'conversation-a' });
    expect(ownerTab.originalContent).toBe('updated');
    expect(ownerTab.isDirty).toBe(true);
    expect(wrongOwnerTab.isDirty).toBe(true);
    expect(saveTabsState).toHaveBeenLastCalledWith('conversation-a');

    const savedStateCallCount = saveTabsState.mock.calls.length;
    ack({ agentId: 'agent-a', conversationId: 'conversation-a' });
    expect(ownerTab.originalContent).toBe('updated');
    expect(ownerTab.isDirty).toBe(true);
    expect(saveTabsState).toHaveBeenCalledTimes(savedStateCallCount);

    tabs.saveFile();
    const retryRequest = sent.filter(msg => msg.type === 'write_file').at(-1);
    expect(retryRequest.content).toBe('edited while save was in flight');
    ack({
      agentId: 'agent-a',
      conversationId: 'conversation-a',
      requestId: retryRequest.requestId,
      success: false,
      error: 'disk full',
    });
    expect(ownerTab.isDirty).toBe(true);
    expect(ownerTab.pendingSaveRequestId).toBeUndefined();

    tabs.saveFile();
    expect(sent.filter(msg => msg.type === 'write_file')).toHaveLength(3);
  });

  it('preserves save correlation metadata through the Agent write handler', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'yeaft-file-save-'));
    const sent = [];
    const previousConfig = ctx.CONFIG;
    const previousSend = ctx.sendToServer;
    ctx.CONFIG = { workDir };
    ctx.sendToServer = msg => sent.push(msg);
    try {
      await handleWriteFile({
        conversationId: '_explorer',
        requestId: 'save-1',
        _requestUserId: 'user-1',
        _requestClientId: 'client-1',
        workDir,
        filePath: 'design.md',
        content: 'saved content',
      });
      expect(readFileSync(join(workDir, 'design.md'), 'utf8')).toBe('saved content');
      expect(sent).toEqual([expect.objectContaining({
        type: 'file_saved',
        conversationId: '_explorer',
        requestId: 'save-1',
        _requestUserId: 'user-1',
        _requestClientId: 'client-1',
        requestedFilePath: 'design.md',
        success: true,
      })]);
    } finally {
      ctx.CONFIG = previousConfig;
      ctx.sendToServer = previousSend;
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('uses Server-owned correlation and ignores Agent-forged browser ownership', async () => {
    const { outbound, client } = await registerRouteRequest({
      type: 'list_directory',
      requestId: 'dir-1',
      extra: { dirPath: '/workspace/session-1' },
    });
    const otherClient = routeClient('user-2');
    webClients.set('client-2', otherClient);
    sendToWebClient.mockClear();

    await handleAgentFileTerminal('agent-1', {}, {
      type: 'directory_listing',
      conversationId: outbound.conversationId,
      _workbenchRequestId: outbound._workbenchRequestId,
      _requestUserId: 'user-2',
      _requestClientId: 'client-2',
      workbenchRouteKey: 'yeaft:agent-2:forged',
      workbenchWorkspaceGeneration: 'forged',
      dirPath: '/workspace/session-1',
      entries: [],
    });

    expect(sendToWebClient).toHaveBeenCalledTimes(1);
    expect(sendToWebClient).toHaveBeenCalledWith(client, expect.objectContaining({
      type: 'directory_listing',
      conversationId: outbound.conversationId,
      workbenchRouteKey: 'yeaft:agent-1:session-1',
      workbenchWorkspaceGeneration: outbound.workbenchWorkspaceGeneration,
      requestId: 'dir-1',
    }));
    expect(sendToWebClient).not.toHaveBeenCalledWith(otherClient, expect.anything());
    expect(sendToWebClient.mock.calls[0][1]).not.toHaveProperty('_requestClientId');
    expect(sendToWebClient.mock.calls[0][1]).not.toHaveProperty('_requestUserId');
  });

  it('does not consume a valid correlation on a same-Agent wrong-route response', async () => {
    const { outbound, client } = await registerRouteRequest({
      type: 'git_status',
      agentId: 'route-fence-agent',
      sessionId: 'route-fence-session',
      requestId: 'route-fence-request',
    });
    sendToWebClient.mockClear();

    await handleAgentFileTerminal('route-fence-agent', {}, {
      type: 'git_status_result',
      conversationId: '_workbench:yeaft:route-fence-agent:other-session',
      _workbenchRequestId: outbound._workbenchRequestId,
    });
    expect(sendToWebClient).not.toHaveBeenCalled();

    await handleAgentFileTerminal('route-fence-agent', {}, {
      type: 'git_status_result',
      conversationId: outbound.conversationId,
      _workbenchRequestId: outbound._workbenchRequestId,
    });
    expect(sendToWebClient).toHaveBeenCalledTimes(1);
    expect(sendToWebClient.mock.calls[0][0]).toBe(client);
  });

  it('actively closes a late terminal created after its Server correlation expired', async () => {
    const { outbound } = await registerRouteRequest({
      type: 'terminal_create',
      agentId: 'late-terminal-agent',
      sessionId: 'late-terminal-session',
      extra: { terminalId: 'late-terminal', cols: 80, rows: 24 },
    });
    expect(__testExpireWorkbenchRequest(
      'late-terminal-agent',
      outbound._workbenchRequestId,
    )).toBe(true);
    sendToAgent.mockClear();
    sendToWebClient.mockClear();

    await handleAgentFileTerminal('late-terminal-agent', {}, {
      type: 'terminal_created',
      conversationId: outbound.conversationId,
      terminalId: 'late-terminal',
      success: true,
      _workbenchRequestId: outbound._workbenchRequestId,
      workbenchWorkspaceGeneration: outbound.workbenchWorkspaceGeneration,
    });

    expect(sendToWebClient).not.toHaveBeenCalled();
    expect(sendToAgent).toHaveBeenCalledWith(
      agents.get('late-terminal-agent'),
      expect.objectContaining({
        type: 'terminal_close',
        conversationId: outbound.conversationId,
        terminalId: 'late-terminal',
        workbenchRouteKey: 'yeaft:late-terminal-agent:late-terminal-session',
        workbenchWorkspaceGeneration: outbound.workbenchWorkspaceGeneration,
      }),
    );
  });

  it('drops a delayed response after the canonical workspace generation changes', async () => {
    const { outbound } = await registerRouteRequest({
      type: 'git_status',
      agentId: 'generation-agent',
      sessionId: 'generation-session',
      workDir: '/workspace/a',
      requestId: 'generation-request',
    });
    agents.get('generation-agent').yeaftSessions.set('generation-session', {
      id: 'generation-session',
      workDir: '/workspace/b',
      userId: 'user-1',
    });
    sendToWebClient.mockClear();

    await handleAgentFileTerminal('generation-agent', {}, {
      type: 'git_status_result',
      conversationId: outbound.conversationId,
      _workbenchRequestId: outbound._workbenchRequestId,
    });
    expect(sendToWebClient).not.toHaveBeenCalled();
  });

  it('drops missing, stale, wrong-Agent, and replayed correlations', async () => {
    const { outbound } = await registerRouteRequest({
      type: 'git_status',
      requestId: 'git-1',
    });
    sendToWebClient.mockClear();

    const reply = overrides => handleAgentFileTerminal('agent-1', {}, {
      type: 'git_status_result',
      conversationId: outbound.conversationId,
      _workbenchRequestId: outbound._workbenchRequestId,
      ...overrides,
    });
    await reply({ _workbenchRequestId: null });
    await handleAgentFileTerminal('agent-2', {}, {
      type: 'git_status_result',
      conversationId: outbound.conversationId,
      _workbenchRequestId: outbound._workbenchRequestId,
    });
    expect(sendToWebClient).not.toHaveBeenCalled();

    expect(__testExpireWorkbenchRequest('agent-1', outbound._workbenchRequestId)).toBe(true);
    await reply({});
    expect(sendToWebClient).not.toHaveBeenCalled();

    const second = await registerRouteRequest({ type: 'git_status', requestId: 'git-2' });
    sendToWebClient.mockClear();
    await handleAgentFileTerminal('agent-1', {}, {
      type: 'git_status_result',
      conversationId: second.outbound.conversationId,
      _workbenchRequestId: second.outbound._workbenchRequestId,
    });
    await handleAgentFileTerminal('agent-1', {}, {
      type: 'git_status_result',
      conversationId: second.outbound.conversationId,
      _workbenchRequestId: second.outbound._workbenchRequestId,
    });
    expect(sendToWebClient).toHaveBeenCalledTimes(1);
  });

  it('reserves a route terminal id against another browser before Agent ack', async () => {
    const first = await registerRouteRequest({
      type: 'terminal_create',
      clientId: 'terminal-client-a',
      userId: 'user-1',
      extra: { terminalId: 'shared-terminal', cols: 80, rows: 24 },
    });
    const secondClient = routeClient('user-1', { currentAgent: 'agent-1' });
    webClients.set('terminal-client-b', secondClient);
    forwardToAgent.mockClear();
    sendToWebClient.mockClear();

    expect(await handleClientWorkbench(
      'terminal-client-b',
      secondClient,
      {
        type: 'terminal_create',
        agentId: 'agent-1',
        terminalId: 'shared-terminal',
        cols: 80,
        rows: 24,
        workbenchRoute: first.route,
      },
      async () => true,
    )).toBeUndefined();
    expect(forwardToAgent).not.toHaveBeenCalled();
    expect(sendToWebClient).toHaveBeenCalledWith(secondClient, expect.objectContaining({
      type: 'error',
      message: 'Invalid Workbench Session route',
    }));
  });

  it('routes same-owner concurrent browsers only to the requesting browser', async () => {
    const first = await registerRouteRequest({
      type: 'write_file',
      clientId: 'client-a',
      userId: 'user-1',
      requestId: 'save-a',
      extra: { filePath: 'a.md', content: 'a' },
    });
    const second = await registerRouteRequest({
      type: 'write_file',
      clientId: 'client-b',
      userId: 'user-1',
      requestId: 'save-b',
      extra: { filePath: 'b.md', content: 'b' },
    });
    sendToWebClient.mockClear();

    await handleAgentFileTerminal('agent-1', {}, {
      type: 'file_saved',
      conversationId: second.outbound.conversationId,
      _workbenchRequestId: second.outbound._workbenchRequestId,
      requestedFilePath: 'b.md',
      success: true,
    });

    expect(sendToWebClient).toHaveBeenCalledTimes(1);
    expect(sendToWebClient).toHaveBeenCalledWith(second.client, expect.objectContaining({
      requestId: 'save-b',
      requestedFilePath: 'b.md',
    }));
    expect(sendToWebClient.mock.calls[0][0]).toBe(second.client);
    expect(sendToWebClient.mock.calls[0][0]).not.toBe(first.client);
  });

  it('preserves the requested path when projecting a correlated binary file response', async () => {
    const { outbound, client } = await registerRouteRequest({
      type: 'read_file',
      requestId: 'file-request-1',
      extra: { filePath: 'docs/diagram.png' },
    });
    sendToWebClient.mockClear();
    await handleAgentFileTerminal('agent-1', {}, {
      type: 'file_content',
      conversationId: outbound.conversationId,
      _workbenchRequestId: outbound._workbenchRequestId,
      filePath: '/workspace/docs/diagram.png',
      requestedFilePath: 'docs/diagram.png',
      content: Buffer.from('image').toString('base64'),
      binary: true,
      mimeType: 'image/png',
    });

    expect(sendToWebClient).toHaveBeenCalledOnce();
    const [, forwarded] = sendToWebClient.mock.calls[0];
    expect(sendToWebClient.mock.calls[0][0]).toBe(client);
    expect(forwarded).toMatchObject({
      type: 'file_content',
      agentId: 'agent-1',
      requestId: 'file-request-1',
      filePath: '/workspace/docs/diagram.png',
      requestedFilePath: 'docs/diagram.png',
      binary: true,
      mimeType: 'image/png',
    });
    expect(forwarded).not.toHaveProperty('content');
    expect(previewFiles.has(forwarded.fileId)).toBe(true);

    globalThis.Vue = Vue;
    globalThis.location = { protocol: 'https:', host: 'yeaft.test' };
    const wrongOwnerTab = {
      path: 'docs/diagram.png',
      name: 'diagram.png',
      fileType: 'image',
      agentId: 'agent-2',
      conversationId: 'session-2',
      requestId: 'other-request',
      previewLoading: true,
      previewError: null,
      blobUrl: null,
    };
    const relativeTab = {
      path: 'docs/diagram.png',
      name: 'diagram.png',
      fileType: 'image',
      agentId: 'agent-1',
      conversationId: outbound.conversationId,
      requestId: 'file-request-1',
      previewLoading: true,
      previewError: null,
      blobUrl: null,
    };
    const openFiles = Vue.ref([wrongOwnerTab, relativeTab]);
    const handle = createWsHandler({
      store: { currentConversation: 'session-1', currentAgent: 'agent-1' },
      normalizePath: value => value,
      getEffectiveWorkDir: () => '/workspace',
      openFiles,
      activeFileIndex: Vue.ref(1),
      activeFile: Vue.computed(() => openFiles.value[1]),
      fileLoading: Vue.ref(true),
      fileSaving: Vue.ref(false),
      saveTabsState: vi.fn(),
      createEditor: vi.fn(),
      openFileInTab: vi.fn(),
      tree: { handleDirectoryListing: vi.fn() },
      setTreeVisible: vi.fn(),
      fp: { handleFolderPickerListing: vi.fn() },
      qo: {},
      ops: { getPendingDownload: () => null, clearPendingDownload: vi.fn() },
      mdPreviewMode: Vue.ref(false),
      renderOfficeLocal: vi.fn(),
      editorContainer: Vue.ref(null),
      debugStatus: Vue.ref(''),
    }).handleWorkbenchMessage;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ blob: async () => new Blob(['image']) });
    const createObjectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview');

    handle(new CustomEvent('workbench-message', { detail: { ...forwarded, agentId: 'agent-2' } }));
    handle(new CustomEvent('workbench-message', { detail: { ...forwarded, conversationId: 'session-2' } }));
    handle(new CustomEvent('workbench-message', { detail: { ...forwarded, requestId: 'stale-request' } }));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(relativeTab.previewLoading).toBe(true);

    handle(new CustomEvent('workbench-message', { detail: forwarded }));
    await vi.waitFor(() => expect(relativeTab.blobUrl).toBe('blob:preview'));
    expect(relativeTab.previewLoading).toBe(false);
    expect(wrongOwnerTab.blobUrl).toBeNull();
    expect(wrongOwnerTab.previewLoading).toBe(true);
    fetchSpy.mockRestore();
    createObjectUrl.mockRestore();
  });
});
