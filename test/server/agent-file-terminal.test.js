import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Vue from 'vue';
import { createWsHandler } from '../../web/components/files/wsHandler.js';
import { createFileTabs } from '../../web/components/files/fileTabs.js';
import { createFilePreview } from '../../web/components/files/filePreview.js';
import { getFileType } from '../../web/components/files/fileEditor.js';
import { updateImagePreviewState, updateMediaPreviewState } from '../../web/components/FilesTab.js';
import { resolveDialog, useDialogState } from '../../web/utils/dialog.js';
import ctx from '../../agent/context.js';
import { CONFIG } from '../../server/config.js';
import { userDb, yeaftSessionDb } from '../../server/database.js';
import {
  handleReadFile,
  handleVideoMetadata,
  handleVideoChunk,
  handleWriteFile,
  MAX_WORKBENCH_PREVIEW_BYTES,
} from '../../agent/workbench/file-ops.js';
import { resolveFileReferences } from '../../agent/workbench/file-reference-resolver.js';

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
const { cleanupWorkbenchForDisconnectedClient } = await import('../../server/ws-client.js');
const {
  __testExpireWorkbenchRequest,
  __testResetWorkbenchCorrelations,
  getWorkbenchTerminalOwner,
} = await import('../../server/workbench-correlation.js');
const { __testResetFileContentAssemblies } = await import('../../server/file-content-assembly.js');
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
    capabilities: [
      'terminal',
      'file_editor',
      'workbench_session_routes',
      'workbench_request_correlation',
      'workbench_terminal_cleanup_fence',
    ],
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
  agentWorkDir = '',
  requestId = null,
  extra = {},
  agentCapabilities = null,
}) {
  const route = { runtimeProvider: 'yeaft', agentId, sessionId };
  const client = routeClient(userId, { currentAgent: agentId });
  webClients.set(clientId, client);
  installRouteAgent(agentId, [{ id: sessionId, workDir, userId }]);
  agents.get(agentId).workDir = agentWorkDir;
  if (Array.isArray(agentCapabilities)) agents.get(agentId).capabilities = [...agentCapabilities];
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

describe('Agent file reference resolution', () => {
  it('confirms exact files, repairs only unique basename matches, and rejects ambiguity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-file-references-'));
    try {
      const fs = await import('node:fs/promises');
      await fs.mkdir(join(root, 'src', 'nested'), { recursive: true });
      await fs.mkdir(join(root, 'other'), { recursive: true });
      await fs.writeFile(join(root, 'README.md'), 'readme');
      await fs.writeFile(join(root, 'src', 'nested', 'plugins.actions'), 'actions');
      await fs.writeFile(join(root, 'src', 'duplicate.json'), '{}');
      await fs.writeFile(join(root, 'other', 'duplicate.json'), '{}');

      await expect(resolveFileReferences([
        'README.md', 'plugins.actions', 'wrong/duplicate.json', 'missing.md',
      ], root)).resolves.toEqual([
        { requestedPath: 'README.md', resolvedPath: 'README.md' },
        { requestedPath: 'plugins.actions', resolvedPath: 'src/nested/plugins.actions' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('confines automatic response references to the canonical workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-file-references-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'yeaft-file-references-outside-'));
    try {
      const fs = await import('node:fs/promises');
      await fs.mkdir(join(root, 'images'), { recursive: true });
      await fs.writeFile(join(root, 'images', 'inside.png'), 'inside');
      await fs.writeFile(join(outside, 'outside.png'), 'outside');
      symlinkSync(join(outside, 'outside.png'), join(root, 'images', 'escaped.png'));

      await expect(resolveFileReferences([
        join(root, 'images', 'inside.png'),
        join(outside, 'outside.png'),
        'images/escaped.png',
        '../outside.png',
      ], root)).resolves.toEqual([
        { requestedPath: join(root, 'images', 'inside.png'), resolvedPath: 'images/inside.png' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('does not claim basename uniqueness when the entry budget truncates traversal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-file-references-budget-'));
    try {
      const fs = await import('node:fs/promises');
      await fs.mkdir(join(root, 'a'), { recursive: true });
      await fs.mkdir(join(root, 'z'), { recursive: true });
      await fs.writeFile(join(root, 'a', 'target.actions'), 'first');
      await fs.writeFile(join(root, 'z', 'target.actions'), 'second');
      await expect(resolveFileReferences(['wrong/target.actions'], root, {
        maxScannedEntries: 2,
      })).resolves.toEqual([]);
      await expect(resolveFileReferences(['a/target.actions'], root, {
        maxScannedEntries: 1,
      })).resolves.toEqual([
        { requestedPath: 'a/target.actions', resolvedPath: 'a/target.actions' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not claim basename uniqueness when a directory read fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-file-references-read-error-'));
    try {
      const fs = await import('node:fs/promises');
      const unreadableDir = join(root, 'z-unreadable');
      await fs.mkdir(join(root, 'a'), { recursive: true });
      await fs.mkdir(unreadableDir, { recursive: true });
      await fs.writeFile(join(root, 'a', 'target.actions'), 'first');
      await fs.writeFile(join(unreadableDir, 'target.actions'), 'second');
      const readDirectory = vi.fn(async (dir, options) => {
        if (dir === unreadableDir) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        return fs.readdir(dir, options);
      });

      await expect(resolveFileReferences(['wrong/target.actions'], root, {
        readDirectory,
      })).resolves.toEqual([]);
      await expect(resolveFileReferences(['a/target.actions'], root, {
        readDirectory,
      })).resolves.toEqual([
        { requestedPath: 'a/target.actions', resolvedPath: 'a/target.actions' },
      ]);
      expect(readDirectory).toHaveBeenCalledWith(unreadableDir, { withFileTypes: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not claim basename uniqueness when a matching subtree exceeds max depth', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-file-references-depth-'));
    try {
      const fs = await import('node:fs/promises');
      await fs.mkdir(join(root, 'a'), { recursive: true });
      await fs.mkdir(join(root, 'z', 'deep'), { recursive: true });
      await fs.writeFile(join(root, 'a', 'target.actions'), 'first');
      await fs.writeFile(join(root, 'z', 'deep', 'target.actions'), 'second');
      await expect(resolveFileReferences(['wrong/target.actions'], root, {
        maxDepth: 1,
      })).resolves.toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

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
    __testResetFileContentAssemblies();
    agents.clear();
    previewFiles.clear();
    userFileTabs.clear();
    webClients.clear();
  });

  afterEach(() => {
    CONFIG.skipAuth = originalSkipAuth;
    for (const userId of createdUsers.splice(0)) userDb.deleteUser(userId);
  });

  it('fails closed when a client requests automatic image preview from an old Agent', async () => {
    const { client } = await registerRouteRequest({
      type: 'read_file',
      requestId: 'old-agent-image',
      extra: { filePath: 'screens/result.png', responseImagePreview: true },
      agentCapabilities: ['workbench_session_routes', 'workbench_request_correlation'],
    });
    expect(forwardToAgent).not.toHaveBeenCalled();
    expect(sendToWebClient).toHaveBeenCalledWith(client, expect.objectContaining({
      type: 'file_content', requestId: 'old-agent-image', agentId: 'agent-1',
      conversationId: '_workbench:yeaft:agent-1:session-1',
      workbenchRouteKey: 'yeaft:agent-1:session-1',
      workbenchWorkspaceGeneration: workbenchWorkspaceGeneration(
        'yeaft:agent-1:session-1', '/workspace/session-1',
      ),
      error: 'Response image preview is not supported by this Agent',
    }));
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
      agents.set(agentId, {
        capabilities: ['workbench_session_routes', 'workbench_request_correlation', 'response_image_preview'],
      });
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
        {
          userId, role: 'pro', currentAgent: agentId,
          currentConversation: 'shared-yeaft-conversation', workbenchRouteProtocol: 1,
        },
        {
          type: 'read_file', responseImagePreview: true, filePath: 'screens/result.png',
          agentId, workDir: '/browser/forged', workbenchRoute: route,
        },
        async requestedAgentId => requestedAgentId === agentId,
      );
      expect(forwardToAgent).toHaveBeenCalledWith(agentId, expect.objectContaining({
        type: 'read_file', responseImagePreview: true,
        workDir: canonicalWorkDir, filePath: 'screens/result.png',
      }));

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

  it('requests video metadata instead of transferring a video through read_file', () => {
    globalThis.Vue = Vue;
    const sendWsMessage = vi.fn();
    const tabs = createFileTabs({
      currentAgent: 'agent-a', currentConversation: 'conversation-a', sendWsMessage,
    }, {
      normalizePath: value => value, getEffectiveWorkDir: () => '/workspace',
      editorContainer: Vue.ref({}), createEditor: vi.fn(), destroyEditor: vi.fn(),
      clearFindMarkers: vi.fn(), saveCurrentUndoHistory: vi.fn(), saveAllUndoHistory: vi.fn(),
      cleanupUndoHistory: vi.fn(), deleteConversationHistory: vi.fn(), mdPreviewMode: Vue.ref(false),
      renderOfficeLocal: vi.fn(), performFind: vi.fn(), findBarVisible: Vue.ref(false),
      findQuery: Vue.ref(''), t: key => key,
    });
    tabs.openFileInTab('media/demo.mp4', 'demo.mp4', {
      agentId: 'agent-a', conversationId: 'conversation-a', workDir: '/workspace',
    });
    expect(tabs.activeFile.value).toMatchObject({ fileType: 'video', previewLoading: true });
    expect(sendWsMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'video_metadata', filePath: 'media/demo.mp4', workDir: '/workspace',
    }));
  });

  it('closes file tabs in batches while preserving the nearest active tab', async () => {
    globalThis.Vue = Vue;
    const createEditor = vi.fn();
    const destroyEditor = vi.fn();
    const cleanupUndoHistory = vi.fn();
    const tabs = createFileTabs({
      currentAgent: 'agent-a',
      currentConversation: 'conversation-a',
      sendWsMessage: vi.fn(),
    }, {
      normalizePath: value => value,
      getEffectiveWorkDir: () => '/workspace',
      editorContainer: Vue.ref({}),
      createEditor,
      destroyEditor,
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
      t: (key, args) => `${key}:${args?.count || args?.name || ''}`,
    });
    for (const name of ['a.md', 'b.md', 'c.md', 'd.md']) {
      tabs.openFileInTab(name, name, { agentId: 'agent-a', conversationId: 'conversation-a', workDir: '/workspace' });
      tabs.activeFile.value.content = name;
    }
    tabs.switchToTab(2);
    destroyEditor.mockClear();
    createEditor.mockClear();

    expect(await tabs.closeTabsToLeft(2)).toBe(true);
    expect(tabs.openFiles.value.map(file => file.name)).toEqual(['c.md', 'd.md']);
    expect(tabs.activeFile.value.name).toBe('c.md');

    expect(await tabs.closeTabsToRight(0)).toBe(true);
    expect(tabs.openFiles.value.map(file => file.name)).toEqual(['c.md']);
    expect(tabs.activeFile.value.name).toBe('c.md');
    expect(destroyEditor).not.toHaveBeenCalled();
    expect(cleanupUndoHistory).toHaveBeenCalledTimes(3);
  });

  it('tracks file loading per tab when read responses arrive out of order', () => {
    globalThis.Vue = Vue;
    const sent = [];
    const store = {
      currentAgent: 'agent-a',
      currentConversation: 'conversation-a',
      clientId: 'client-a',
      sendWsMessage: msg => sent.push(msg),
    };
    const mdPreviewMode = Vue.ref(true);
    const tabs = createFileTabs(store, {
      normalizePath: value => value,
      getEffectiveWorkDir: () => '/workspace',
      editorContainer: Vue.ref(null),
      createEditor: vi.fn(),
      destroyEditor: vi.fn(),
      clearFindMarkers: vi.fn(),
      saveCurrentUndoHistory: vi.fn(),
      saveAllUndoHistory: vi.fn(),
      cleanupUndoHistory: vi.fn(),
      deleteConversationHistory: vi.fn(),
      mdPreviewMode,
      renderOfficeLocal: vi.fn(),
      performFind: vi.fn(),
      findBarVisible: Vue.ref(false),
      findQuery: Vue.ref(''),
      t: value => value,
    });
    const handle = createWsHandler({
      store,
      normalizePath: value => value,
      getEffectiveWorkDir: () => '/workspace',
      openFiles: tabs.openFiles,
      activeFileIndex: tabs.activeFileIndex,
      activeFile: tabs.activeFile,
      fileSaving: tabs.fileSaving,
      saveTabsState: vi.fn(),
      createEditor: vi.fn(),
      openFileInTab: tabs.openFileInTab,
      tree: { handleDirectoryListing: vi.fn() },
      setTreeVisible: vi.fn(),
      fp: { handleFolderPickerListing: vi.fn() },
      qo: {},
      ops: { takePendingDownload: () => null },
      mdPreviewMode,
      renderOfficeLocal: vi.fn(),
      editorContainer: Vue.ref(null),
    }).handleWorkbenchMessage;

    tabs.openFileInTab('first.md', 'first.md');
    tabs.openFileInTab('second.md', 'second.md');
    const [firstRequest, secondRequest] = sent.filter(msg => msg.type === 'read_file');
    expect(tabs.openFiles.value.map(file => file.loading)).toEqual([true, true]);
    expect(tabs.fileLoading.value).toBe(true);

    handle(new CustomEvent('workbench-message', { detail: {
      type: 'file_content',
      agentId: 'agent-a',
      conversationId: 'conversation-a',
      requestedFilePath: 'first.md',
      requestId: firstRequest.requestId,
      content: '# First',
    } }));
    expect(tabs.openFiles.value.map(file => file.loading)).toEqual([false, true]);
    expect(tabs.fileLoading.value).toBe(true);

    handle(new CustomEvent('workbench-message', { detail: {
      type: 'file_content',
      agentId: 'agent-a',
      conversationId: 'conversation-a',
      requestedFilePath: 'second.md',
      requestId: secondRequest.requestId,
      content: '# Second',
    } }));
    expect(tabs.openFiles.value.map(file => file.loading)).toEqual([false, false]);
    expect(tabs.fileLoading.value).toBe(false);
  });

  function createRestoreHarness({ routeKey = '', workspaceGeneration = '' } = {}) {
    globalThis.Vue = Vue;
    const sent = [];
    const store = {
      currentAgent: 'agent-a',
      currentConversation: 'conversation-a',
      clientId: 'client-a',
      sendWsMessage: msg => sent.push(msg),
    };
    const tabs = createFileTabs(store, {
      normalizePath: value => value,
      getEffectiveWorkDir: () => '/workspace',
      editorContainer: Vue.ref(null),
      createEditor: vi.fn(),
      destroyEditor: vi.fn(),
      clearFindMarkers: vi.fn(),
      saveCurrentUndoHistory: vi.fn(),
      saveAllUndoHistory: vi.fn(),
      cleanupUndoHistory: vi.fn(),
      deleteConversationHistory: vi.fn(),
      debugStatus: Vue.ref(''),
      mdPreviewMode: Vue.ref(true),
      renderOfficeLocal: vi.fn(),
      performFind: vi.fn(),
      findBarVisible: Vue.ref(false),
      findQuery: Vue.ref(''),
      t: value => value,
    });
    const handle = createWsHandler({
      store,
      normalizePath: value => value,
      getEffectiveWorkDir: () => '/workspace',
      openFiles: tabs.openFiles,
      activeFileIndex: tabs.activeFileIndex,
      activeFile: tabs.activeFile,
      fileSaving: tabs.fileSaving,
      saveTabsState: vi.fn(),
      createEditor: vi.fn(),
      openFileInTab: tabs.openFileInTab,
      bumpTabRevision: tabs.bumpTabRevision,
      acceptTabsRestoreRequest: tabs.acceptTabsRestoreRequest,
      tree: { handleDirectoryListing: vi.fn() },
      setTreeVisible: vi.fn(),
      fp: { handleFolderPickerListing: vi.fn() },
      qo: {},
      ops: { takePendingDownload: () => null },
      mdPreviewMode: Vue.ref(true),
      renderOfficeLocal: vi.fn(),
      editorContainer: Vue.ref(null),
      routeKey,
      workspaceGeneration,
    }).handleWorkbenchMessage;
    return { handle, sent, store, tabs };
  }

  it('correlates restored file tabs with the latest restore request', () => {
    const { handle, sent, tabs } = createRestoreHarness();
    const restoreRequestId = tabs.beginTabsRestoreRequest();

    handle(new CustomEvent('workbench-message', { detail: {
      type: 'file_tabs_restored',
      restoreRequestId,
      openFiles: [{ path: 'README.md' }],
      activeIndex: 0,
    } }));

    const request = sent.find(msg => msg.type === 'read_file');
    expect(request).toMatchObject({
      agentId: 'agent-a',
      conversationId: 'conversation-a',
      filePath: 'README.md',
      workDir: '/workspace',
      _clientId: 'client-a',
    });
    expect(tabs.openFiles.value[0]).toMatchObject({
      path: 'README.md',
      agentId: 'agent-a',
      conversationId: 'conversation-a',
      workDir: '/workspace',
      requestId: request.requestId,
      loading: true,
      loadError: null,
    });
  });

  it('does not revive restored tabs after a same-generation open and close', async () => {
    const { handle, sent, tabs } = createRestoreHarness();
    const restoreRequestId = tabs.beginTabsRestoreRequest();
    tabs.openFileInTab('temporary.md', 'temporary.md');
    await tabs.closeFileTab(0);
    expect(tabs.openFiles.value).toEqual([]);
    const readsBeforeRestore = sent.filter(msg => msg.type === 'read_file').length;

    handle(new CustomEvent('workbench-message', { detail: {
      type: 'file_tabs_restored',
      restoreRequestId,
      openFiles: [{ path: 'closed.md' }],
      activeIndex: 0,
    } }));

    expect(tabs.openFiles.value).toEqual([]);
    expect(sent.filter(msg => msg.type === 'read_file')).toHaveLength(readsBeforeRestore);
  });

  it('accepts only the latest file-tab restore response', () => {
    const { handle, tabs } = createRestoreHarness();
    const firstRequestId = tabs.beginTabsRestoreRequest();
    const secondRequestId = tabs.beginTabsRestoreRequest();

    handle(new CustomEvent('workbench-message', { detail: {
      type: 'file_tabs_restored',
      restoreRequestId: firstRequestId,
      openFiles: [{ path: 'stale.md' }],
      activeIndex: 0,
    } }));
    expect(tabs.openFiles.value).toEqual([]);

    handle(new CustomEvent('workbench-message', { detail: {
      type: 'file_tabs_restored',
      restoreRequestId: secondRequestId,
      openFiles: [{ path: 'latest.md' }],
      activeIndex: 0,
    } }));
    expect(tabs.openFiles.value.map(file => file.path)).toEqual(['latest.md']);
  });

  it('rejects a stale workspace restore without consuming the current request', () => {
    const routeKey = 'yeaft:agent-a:session-a';
    const workspaceGeneration = 'current-generation';
    const { handle, tabs } = createRestoreHarness({ routeKey, workspaceGeneration });
    const restoreRequestId = tabs.beginTabsRestoreRequest();

    handle(new CustomEvent('workbench-message', { detail: {
      type: 'file_tabs_restored',
      restoreRequestId,
      workbenchRouteKey: routeKey,
      workbenchWorkspaceGeneration: 'stale-generation',
      openFiles: [{ path: 'stale.md' }],
      activeIndex: 0,
    } }));
    expect(tabs.openFiles.value).toEqual([]);

    handle(new CustomEvent('workbench-message', { detail: {
      type: 'file_tabs_restored',
      restoreRequestId,
      workbenchRouteKey: routeKey,
      workbenchWorkspaceGeneration: workspaceGeneration,
      openFiles: [{ path: 'current.md' }],
      activeIndex: 0,
    } }));
    expect(tabs.openFiles.value.map(file => file.path)).toEqual(['current.md']);
  });

  it('aborts a confirmed dirty batch before mutation when its commit fence expires', async () => {
    globalThis.Vue = Vue;
    const sendWsMessage = vi.fn();
    const cleanupUndoHistory = vi.fn();
    const tabs = createFileTabs({
      currentAgent: 'agent-a',
      currentConversation: 'conversation-a',
      sendWsMessage,
    }, {
      normalizePath: value => value,
      getEffectiveWorkDir: () => '/workspace/a',
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
      t: value => value,
    });
    tabs.openFileInTab('dirty.md', 'dirty.md', {
      agentId: 'agent-a', conversationId: 'conversation-a', workDir: '/workspace/a',
    });
    tabs.activeFile.value.content = 'dirty';
    tabs.activeFile.value.isDirty = true;
    sendWsMessage.mockClear();
    let current = true;

    const closing = tabs.closeAllTabs({ canCommit: () => current });
    expect(useDialogState().open).toBe(true);
    current = false;
    resolveDialog(true);

    await expect(closing).resolves.toBe(false);
    expect(tabs.openFiles.value.map(file => file.name)).toEqual(['dirty.md']);
    expect(cleanupUndoHistory).not.toHaveBeenCalled();
    await new Promise(resolve => setTimeout(resolve, 550));
    expect(sendWsMessage).toHaveBeenCalledWith({
      type: 'update_file_tabs',
      openFiles: [{ path: 'dirty.md' }],
      activeIndex: 0,
    });
  });

  it('confirms dirty batch closes atomically', async () => {
    globalThis.Vue = Vue;
    const cleanupUndoHistory = vi.fn();
    const tabs = createFileTabs({
      currentAgent: 'agent-a',
      currentConversation: 'conversation-a',
      sendWsMessage: vi.fn(),
    }, {
      normalizePath: value => value,
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
      t: (key, args) => `${key}:${args?.count || args?.name || ''}`,
    });
    for (const name of ['dirty-a.md', 'clean.md', 'dirty-b.md']) {
      tabs.openFileInTab(name, name, { agentId: 'agent-a', conversationId: 'conversation-a', workDir: '/workspace' });
      tabs.activeFile.value.content = name;
    }
    tabs.openFiles.value[0].isDirty = true;
    tabs.openFiles.value[2].isDirty = true;

    const cancelled = tabs.closeAllTabs();
    expect(useDialogState()).toMatchObject({
      open: true,
      message: 'files.unsavedBatchConfirm:2',
    });
    resolveDialog(false);
    await expect(cancelled).resolves.toBe(false);
    expect(tabs.openFiles.value).toHaveLength(3);
    expect(cleanupUndoHistory).not.toHaveBeenCalled();

    const confirmed = tabs.closeAllTabs();
    resolveDialog(true);
    await expect(confirmed).resolves.toBe(true);
    expect(tabs.openFiles.value).toHaveLength(0);
    expect(tabs.activeFileIndex.value).toBe(-1);
  });

  it('projects file items into the Workbench tabs without duplicate Files tab controls', () => {
    const filesComponent = readFileSync(new URL('../../web/components/FilesTab.js', import.meta.url), 'utf8');
    const workbenchComponent = readFileSync(new URL('../../web/components/WorkbenchPanel.js', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../../web/styles/files.css', import.meta.url), 'utf8');

    expect(filesComponent).toContain("new CustomEvent('workbench-file-items-changed'");
    expect(filesComponent).toContain("window.addEventListener('workbench-select-file-item'");
    expect(filesComponent).toContain("window.addEventListener('workbench-close-file-item'");
    expect(workbenchComponent).toContain('class="workbench-tabs" role="tablist"');
    expect(workbenchComponent).toContain('role="tab"');
    expect(workbenchComponent).toContain(':aria-selected="item.id === activeWorkbenchItemId"');
    expect(workbenchComponent).toContain(':tabindex="item.id === activeWorkbenchItemId ? 0 : -1"');
    expect(workbenchComponent).toContain('@keydown="handleWorkbenchTabKeydown($event, item)"');
    expect(filesComponent).not.toContain('class="file-tabs-scroll"');
    expect(filesComponent).not.toContain('showFileTabContextMenu');
    expect(filesComponent).not.toContain('collapseAll');
    expect(css).not.toContain('.file-tabs-scroll');
    expect(css).not.toContain('.file-tab-context-menu');
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
      ops: { takePendingDownload: () => null },
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

  it('rejects open events from a stale workspace generation', () => {
    globalThis.Vue = Vue;
    const openFileInTab = vi.fn();
    const handler = createWsHandler({
      store: { currentConversation: 'conversation-a', currentAgent: 'agent-a' },
      normalizePath: value => value,
      getEffectiveWorkDir: () => '/workspace/current',
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
      ops: { takePendingDownload: () => null },
      mdPreviewMode: Vue.ref(false),
      renderOfficeLocal: vi.fn(),
      editorContainer: Vue.ref(null),
      debugStatus: Vue.ref(''),
      routeKey: 'yeaft:agent-a:session-a',
      workspaceGeneration: 'current-generation',
    }).handleOpenFile;

    handler(new CustomEvent('workbench-open-file-in-active-view', { detail: {
      filePath: 'docs/stale.md',
      agentId: 'agent-a',
      conversationId: 'conversation-a',
      workDir: '/workspace/stale',
      workbenchRouteKey: 'yeaft:agent-a:session-a',
      workspaceGeneration: 'stale-generation',
    } }));

    expect(openFileInTab).not.toHaveBeenCalled();
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
      ops: { takePendingDownload: () => null },
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
      ops: { takePendingDownload: () => null },
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

  it('revalidates automatic response image reads inside the canonical workspace', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'yeaft-response-image-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'yeaft-response-image-outside-'));
    const sent = [];
    const previousConfig = ctx.CONFIG;
    const previousSend = ctx.sendToServer;
    writeFileSync(join(workDir, 'inside.png'), Buffer.from('inside'));
    writeFileSync(join(workDir, 'note.txt'), 'text');
    writeFileSync(join(outside, 'outside.png'), Buffer.from('outside'));
    symlinkSync(join(outside, 'outside.png'), join(workDir, 'escaped.png'));
    ctx.CONFIG = { workDir };
    ctx.sendToServer = msg => sent.push(msg);
    try {
      for (const [requestId, filePath] of [
        ['inside', 'inside.png'], ['escaped', 'escaped.png'], ['text', 'note.txt'],
      ]) {
        await handleReadFile({
          conversationId: '_explorer', requestId, workDir, filePath,
          responseImagePreview: true,
        });
      }
      expect(sent[0]).toMatchObject({ requestId: 'inside', binary: true, mimeType: 'image/png' });
      expect(sent[1]).toMatchObject({ requestId: 'escaped', error: 'Response image is outside the active workspace.' });
      expect(sent[2]).toMatchObject({ requestId: 'text', error: 'Response preview only supports image files.' });
    } finally {
      ctx.CONFIG = previousConfig;
      ctx.sendToServer = previousSend;
      rmSync(workDir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('streams video metadata and bounded byte ranges without the 20 MB preview limit', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'yeaft-video-stream-'));
    const videoPath = join(workDir, 'large.mp4');
    const sent = [];
    const previousConfig = ctx.CONFIG;
    const previousSend = ctx.sendToServer;
    writeFileSync(videoPath, Buffer.from('0123456789'));
    const largeSize = MAX_WORKBENCH_PREVIEW_BYTES + 17;
    truncateSync(videoPath, largeSize);
    ctx.CONFIG = { workDir };
    ctx.sendToServer = msg => sent.push(msg);
    try {
      await handleReadFile({
        conversationId: '_explorer', requestId: 'legacy-video-read', workDir, filePath: 'large.mp4',
      });
      expect(sent[0]).toMatchObject({
        type: 'file_content', requestId: 'legacy-video-read', errorCode: 'VIDEO_STREAM_REQUIRED',
      });

      await handleVideoMetadata({
        conversationId: '_explorer', requestId: 'video-meta', workDir, filePath: 'large.mp4',
      });
      expect(sent[1]).toMatchObject({
        type: 'video_metadata', requestId: 'video-meta', filePath: videoPath,
        requestedFilePath: 'large.mp4', size: largeSize, mimeType: 'video/mp4',
      });
      expect(sent[1]).not.toHaveProperty('content');

      await handleVideoChunk({
        conversationId: '_explorer', requestId: 'video-range', workDir, filePath: 'large.mp4',
        start: 2, end: 6, expectedSize: largeSize, expectedMtimeMs: sent[1].mtimeMs,
      });
      expect(sent[2]).toMatchObject({
        type: 'video_chunk', requestId: 'video-range', start: 2, end: 6,
        size: largeSize, mimeType: 'video/mp4', content: Buffer.from('23456').toString('base64'),
      });

      await handleVideoChunk({
        conversationId: '_explorer', requestId: 'oversized-range', workDir, filePath: 'large.mp4',
        start: 0, end: (1024 * 1024), expectedSize: largeSize, expectedMtimeMs: sent[1].mtimeMs,
      });
      expect(sent[3]).toMatchObject({
        type: 'video_chunk', requestId: 'oversized-range', errorCode: 'VIDEO_RANGE_TOO_LARGE',
      });
    } finally {
      ctx.CONFIG = previousConfig;
      ctx.sendToServer = previousSend;
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('rejects binary previews over 20 MB before reading file content', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'yeaft-file-preview-'));
    const imagePath = join(workDir, 'large.png');
    const sent = [];
    const previousConfig = ctx.CONFIG;
    const previousSend = ctx.sendToServer;
    writeFileSync(imagePath, Buffer.alloc(1));
    truncateSync(imagePath, MAX_WORKBENCH_PREVIEW_BYTES + 1);
    ctx.CONFIG = { workDir };
    ctx.sendToServer = msg => sent.push(msg);
    try {
      await handleReadFile({
        conversationId: '_explorer',
        requestId: 'preview-large',
        workDir,
        filePath: 'large.png',
      });
      expect(sent).toEqual([expect.objectContaining({
        type: 'file_content',
        requestId: 'preview-large',
        requestedFilePath: 'large.png',
        errorCode: 'FILE_PREVIEW_TOO_LARGE',
        error: expect.stringContaining('file limit is 20 MB'),
        errorDetails: {
          sizeBytes: MAX_WORKBENCH_PREVIEW_BYTES + 1,
          limitBytes: MAX_WORKBENCH_PREVIEW_BYTES,
        },
      })]);
      expect(sent[0]).not.toHaveProperty('binary');
    } finally {
      ctx.CONFIG = previousConfig;
      ctx.sendToServer = previousSend;
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('accepts exactly 20 MB and sends it as twenty bounded chunks', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'yeaft-file-limit-'));
    const imagePath = join(workDir, 'limit.png');
    const chunks = [];
    const previousConfig = ctx.CONFIG;
    const previousSend = ctx.sendToServer;
    const previousAgentCapabilities = ctx.agentCapabilities;
    const previousServerCapabilities = ctx.serverCapabilities;
    writeFileSync(imagePath, Buffer.alloc(1));
    truncateSync(imagePath, MAX_WORKBENCH_PREVIEW_BYTES);
    ctx.CONFIG = { workDir };
    ctx.agentCapabilities = ['workbench_file_content_chunks'];
    ctx.serverCapabilities = new Set(['workbench_file_content_chunks']);
    ctx.sendToServer = async msg => {
      chunks.push({
        type: msg.type,
        chunkIndex: msg.chunkIndex,
        chunkCount: msg.chunkCount,
        totalBytes: msg.totalBytes,
        decodedBytes: Buffer.byteLength(msg.content, 'base64'),
      });
      return 'sent';
    };
    try {
      await handleReadFile({
        conversationId: '_explorer',
        requestId: 'preview-limit',
        _workbenchRequestId: 'internal-limit',
        workbenchRouteKey: 'route-key',
        workbenchWorkspaceGeneration: 'generation-1',
        workDir,
        filePath: 'limit.png',
      });
      expect(chunks).toHaveLength(20);
      expect(chunks.map(chunk => chunk.chunkIndex)).toEqual(Array.from({ length: 20 }, (_, index) => index));
      expect(chunks.every(chunk => chunk.type === 'file_content_chunk')).toBe(true);
      expect(chunks.every(chunk => chunk.chunkCount === 20)).toBe(true);
      expect(chunks.every(chunk => chunk.totalBytes === MAX_WORKBENCH_PREVIEW_BYTES)).toBe(true);
      expect(chunks.every(chunk => chunk.decodedBytes === 1024 * 1024)).toBe(true);
    } finally {
      ctx.CONFIG = previousConfig;
      ctx.sendToServer = previousSend;
      ctx.agentCapabilities = previousAgentCapabilities;
      ctx.serverCapabilities = previousServerCapabilities;
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('chunks correlated binary files after Agent and Server capability negotiation', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'yeaft-file-chunks-'));
    const imagePath = join(workDir, 'large.png');
    const image = Buffer.alloc(1024 * 1024 + 17, 0x5a);
    const sent = [];
    const previousConfig = ctx.CONFIG;
    const previousSend = ctx.sendToServer;
    const previousAgentCapabilities = ctx.agentCapabilities;
    const previousServerCapabilities = ctx.serverCapabilities;
    writeFileSync(imagePath, image);
    ctx.CONFIG = { workDir };
    ctx.agentCapabilities = ['workbench_file_content_chunks'];
    ctx.serverCapabilities = new Set(['workbench_file_content_chunks']);
    ctx.sendToServer = async msg => {
      sent.push(msg);
      return 'sent';
    };
    try {
      await handleReadFile({
        conversationId: '_explorer',
        requestId: 'preview-chunked',
        _workbenchRequestId: 'internal-chunked',
        workbenchRouteKey: 'route-key',
        workbenchWorkspaceGeneration: 'generation-1',
        workDir,
        filePath: 'large.png',
      });
      expect(sent).toHaveLength(2);
      expect(sent.map(message => message.type)).toEqual([
        'file_content_chunk',
        'file_content_chunk',
      ]);
      expect(sent.map(message => message.chunkIndex)).toEqual([0, 1]);
      expect(sent.every(message => message.chunkCount === 2)).toBe(true);
      expect(sent.every(message => message.totalBytes === image.length)).toBe(true);
      // Compare every byte without the per-element overhead of deep equality
      // on a MiB-sized typed array (which can exhaust the test's time budget).
      expect(Buffer.from(sent[0].content, 'base64').equals(image.subarray(0, 1024 * 1024))).toBe(true);
      expect(Buffer.from(sent[1].content, 'base64').equals(image.subarray(1024 * 1024))).toBe(true);
      expect(sent.every(message => message._workbenchRequestId === 'internal-chunked')).toBe(true);
      expect(sent.every(message => message.workbenchRouteKey === 'route-key')).toBe(true);
      expect(sent.every(message => message.workbenchWorkspaceGeneration === 'generation-1')).toBe(true);
    } finally {
      ctx.CONFIG = previousConfig;
      ctx.sendToServer = previousSend;
      ctx.agentCapabilities = previousAgentCapabilities;
      ctx.serverCapabilities = previousServerCapabilities;
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('reports an explicit transfer error when a legacy single-frame response is dropped', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'yeaft-file-legacy-drop-'));
    const imagePath = join(workDir, 'large.png');
    const sent = [];
    const previousConfig = ctx.CONFIG;
    const previousSend = ctx.sendToServer;
    const previousAgentCapabilities = ctx.agentCapabilities;
    const previousServerCapabilities = ctx.serverCapabilities;
    writeFileSync(imagePath, Buffer.alloc(1024 * 1024 + 1, 0x31));
    ctx.CONFIG = { workDir };
    ctx.agentCapabilities = ['workbench_file_content_chunks'];
    ctx.serverCapabilities = new Set();
    ctx.sendToServer = async msg => {
      sent.push(msg);
      return sent.length === 1 ? 'dropped' : 'sent';
    };
    try {
      await handleReadFile({
        conversationId: '_explorer',
        requestId: 'preview-legacy-drop',
        _workbenchRequestId: 'internal-legacy-drop',
        workDir,
        filePath: 'large.png',
      });
      expect(sent).toHaveLength(2);
      expect(sent[0]).toMatchObject({ type: 'file_content', binary: true });
      expect(sent[1]).toMatchObject({
        type: 'file_content',
        binary: false,
        errorCode: 'FILE_TRANSFER_DROPPED',
      });
      expect(sent[1].content).toBe('');
    } finally {
      ctx.CONFIG = previousConfig;
      ctx.sendToServer = previousSend;
      ctx.agentCapabilities = previousAgentCapabilities;
      ctx.serverCapabilities = previousServerCapabilities;
      rmSync(workDir, { recursive: true, force: true });
    }
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

  it('routes pre-Session directory picker requests by Agent without weakening Workbench routes', async () => {
    const agentId = 'directory-picker-agent';
    const client = routeClient('directory-picker-user', { currentAgent: agentId });
    const otherClient = routeClient('other-user', { currentAgent: agentId });
    webClients.set('directory-picker-client', client);
    webClients.set('other-client', otherClient);
    agents.set(agentId, {
      ownerId: 'directory-picker-user',
      workDir: '/agent/default-workdir',
      capabilities: ['workbench_session_routes'],
      conversations: new Map(),
      yeaftSessions: new Map(),
    });
    forwardToAgent.mockClear();
    sendToWebClient.mockClear();

    await handleClientWorkbench(
      'directory-picker-client',
      client,
      {
        type: 'list_directory',
        agentId,
        conversationId: '_workdir_picker',
        directoryPickerScope: 'agent',
        requestId: 'picker-request-1',
        dirPath: '/projects',
        workDir: '/browser/forged-workdir',
      },
      async () => true,
    );

    expect(forwardToAgent).toHaveBeenCalledTimes(1);
    const outbound = forwardToAgent.mock.calls[0][1];
    expect(outbound).toEqual(expect.objectContaining({
      type: 'list_directory',
      agentId,
      conversationId: '_workdir_picker',
      directoryPickerScope: 'agent',
      dirPath: '/projects',
      workDir: '/agent/default-workdir',
      _workbenchRequestId: expect.any(String),
    }));
    expect(outbound).not.toHaveProperty('_requestClientId');
    expect(outbound).not.toHaveProperty('_requestUserId');
    expect(outbound).not.toHaveProperty('requestId');

    await handleAgentFileTerminal(agentId, {}, {
      type: 'directory_listing',
      conversationId: '_workdir_picker',
      _workbenchRequestId: outbound._workbenchRequestId,
      _requestClientId: 'other-client',
      _requestUserId: 'other-user',
      dirPath: '/projects',
      entries: [{ name: 'yeaft', type: 'directory', size: 0 }],
    });

    expect(sendToWebClient).toHaveBeenCalledTimes(1);
    expect(sendToWebClient).toHaveBeenCalledWith(client, expect.objectContaining({
      type: 'directory_listing',
      agentId,
      conversationId: '_workdir_picker',
      requestId: 'picker-request-1',
      dirPath: '/projects',
    }));
    expect(sendToWebClient).not.toHaveBeenCalledWith(otherClient, expect.anything());
  });

  it('terminates a rejected directory listing without the pre-Session picker scope', async () => {
    const agentId = 'directory-picker-denied-agent';
    const client = routeClient('directory-picker-user', { currentAgent: agentId });
    agents.set(agentId, {
      ownerId: 'directory-picker-user',
      workDir: '/agent/default-workdir',
      capabilities: ['workbench_session_routes'],
      conversations: new Map(),
      yeaftSessions: new Map(),
    });
    forwardToAgent.mockClear();
    sendToWebClient.mockClear();

    await handleClientWorkbench(
      'directory-picker-client',
      client,
      {
        type: 'list_directory',
        agentId,
        conversationId: '_workdir_picker',
        requestId: 'picker-request-2',
        dirPath: '/projects',
        workbenchRouteKey: 'yeaft:other-agent:missing-session',
        workbenchWorkspaceGeneration: 'rejected-generation',
      },
      async () => true,
    );

    expect(forwardToAgent).not.toHaveBeenCalled();
    expect(sendToWebClient).toHaveBeenCalledWith(client, {
      type: 'directory_listing',
      agentId,
      conversationId: '_workdir_picker',
      requestId: 'picker-request-2',
      workbenchRouteKey: 'yeaft:other-agent:missing-session',
      workbenchWorkspaceGeneration: 'rejected-generation',
      dirPath: '/projects',
      entries: [],
      error: 'Invalid Workbench Session route',
    });
    expect(sendToWebClient).toHaveBeenCalledWith(client, {
      type: 'error',
      message: 'Invalid Workbench Session route',
    });
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

  it('does not downgrade an opaque correlation response to legacy broadcast on a non-route conversation', async () => {
    const { outbound, client } = await registerRouteRequest({
      type: 'git_status',
      requestId: 'opaque-no-downgrade',
    });
    const otherClient = routeClient('user-2', { currentAgent: 'agent-1' });
    webClients.set('client-2', otherClient);
    sendToWebClient.mockClear();

    await handleAgentFileTerminal('agent-1', agents.get('agent-1'), {
      type: 'git_status_result',
      conversationId: 'legacy-conversation',
      _workbenchRequestId: outbound._workbenchRequestId,
      files: [{ path: 'forged.txt' }],
    });

    expect(sendToWebClient).not.toHaveBeenCalled();

    await handleAgentFileTerminal('agent-1', agents.get('agent-1'), {
      type: 'git_status_result',
      conversationId: outbound.conversationId,
      _workbenchRequestId: outbound._workbenchRequestId,
      files: [],
    });
    expect(sendToWebClient).toHaveBeenCalledTimes(1);
    expect(sendToWebClient.mock.calls[0][0]).toBe(client);
    expect(sendToWebClient.mock.calls[0][0]).not.toBe(otherClient);
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

    expect(sendToWebClient).toHaveBeenCalledTimes(1);
    expect(sendToWebClient).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({
        type: 'terminal_error',
        terminalId: 'late-terminal',
        error: 'Workbench request timed out',
      }),
    );
    expect(sendToAgent).toHaveBeenCalledWith(
      agents.get('late-terminal-agent'),
      expect.objectContaining({
        type: 'terminal_close',
        conversationId: outbound.conversationId,
        terminalId: 'late-terminal',
        workbenchRouteKey: 'yeaft:late-terminal-agent:late-terminal-session',
        workbenchWorkspaceGeneration: outbound.workbenchWorkspaceGeneration,
        _workbenchRequestId: outbound._workbenchRequestId,
      }),
    );
  });

  it('delivers a response when a Yeaft Session has no canonical workDir', async () => {
    const routeKey = 'yeaft:fallback-agent:fallback-session';
    const fallbackGeneration = workbenchWorkspaceGeneration(routeKey, '/agent/yeaft-dir');
    const { outbound, client } = await registerRouteRequest({
      type: 'list_directory',
      agentId: 'fallback-agent',
      sessionId: 'fallback-session',
      workDir: '',
      requestId: 'fallback-directory-request',
      extra: {
        dirPath: '/agent/yeaft-dir',
        workbenchWorkspaceGeneration: fallbackGeneration,
      },
    });
    expect(outbound).toMatchObject({
      workbenchRouteKey: routeKey,
      workbenchWorkspaceGeneration: fallbackGeneration,
    });
    sendToWebClient.mockClear();

    await handleAgentFileTerminal('fallback-agent', agents.get('fallback-agent'), {
      type: 'directory_listing',
      conversationId: outbound.conversationId,
      _workbenchRequestId: outbound._workbenchRequestId,
      workbenchWorkspaceGeneration: fallbackGeneration,
      dirPath: '/agent/yeaft-dir',
      entries: [],
    });

    expect(sendToWebClient).toHaveBeenCalledWith(client, expect.objectContaining({
      type: 'directory_listing',
      requestId: 'fallback-directory-request',
      workbenchRouteKey: routeKey,
      workbenchWorkspaceGeneration: fallbackGeneration,
      dirPath: '/agent/yeaft-dir',
      entries: [],
    }));
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
    expect(sendToWebClient).toHaveBeenCalledTimes(1);
    expect(sendToWebClient.mock.calls[0][1]).toMatchObject({
      type: 'git_status_result',
      requestId: 'git-1',
      files: [],
      error: 'Workbench request timed out',
    });

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

  it('preserves the file search query in timeout recovery responses', async () => {
    const { outbound } = await registerRouteRequest({
      type: 'file_search',
      requestId: 'search-timeout-1',
      extra: { query: 'needle' },
    });
    sendToWebClient.mockClear();

    expect(__testExpireWorkbenchRequest('agent-1', outbound._workbenchRequestId)).toBe(true);
    await handleAgentFileTerminal('agent-1', agents.get('agent-1'), {
      type: 'file_search_result',
      conversationId: outbound.conversationId,
      _workbenchRequestId: outbound._workbenchRequestId,
      workbenchWorkspaceGeneration: outbound.workbenchWorkspaceGeneration,
      query: 'needle',
      results: [{ path: 'late-result.txt' }],
    });

    expect(sendToWebClient).toHaveBeenCalledTimes(1);
    expect(sendToWebClient.mock.calls[0][1]).toMatchObject({
      type: 'file_search_result',
      requestId: 'search-timeout-1',
      query: 'needle',
      results: [],
      error: 'Workbench request timed out',
    });
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

  it('sends token-fenced late-success cleanup to a capable Agent without consuming its retry owner', async () => {
    const first = await registerRouteRequest({
      type: 'terminal_create',
      requestId: 'fenced-success-expired',
      extra: { terminalId: 'fenced-success-retry-terminal', cols: 80, rows: 24 },
    });
    expect(__testExpireWorkbenchRequest(
      'agent-1',
      first.outbound._workbenchRequestId,
    )).toBe(true);

    const retry = await registerRouteRequest({
      type: 'terminal_create',
      requestId: 'fenced-success-retry',
      extra: { terminalId: 'fenced-success-retry-terminal', cols: 80, rows: 24 },
    });
    await vi.waitFor(() => expect(sendToWebClient).toHaveBeenCalledWith(
      first.client,
      expect.objectContaining({
        type: 'terminal_error',
        requestId: 'fenced-success-expired',
        error: 'Workbench request timed out',
      }),
    ));
    sendToAgent.mockClear();
    sendToWebClient.mockClear();

    await handleAgentFileTerminal('agent-1', agents.get('agent-1'), {
      type: 'terminal_created',
      conversationId: first.outbound.conversationId,
      workbenchRouteKey: first.outbound.workbenchRouteKey,
      workbenchWorkspaceGeneration: first.outbound.workbenchWorkspaceGeneration,
      _requestUserId: first.outbound._requestUserId,
      _requestClientId: first.outbound._requestClientId,
      requestId: first.outbound.requestId,
      terminalId: 'fenced-success-retry-terminal',
      success: true,
      _workbenchRequestId: first.outbound._workbenchRequestId,
    });

    expect(sendToWebClient).not.toHaveBeenCalled();
    expect(sendToAgent).toHaveBeenCalledWith(
      agents.get('agent-1'),
      expect.objectContaining({
        type: 'terminal_close',
        conversationId: first.outbound.conversationId,
        terminalId: 'fenced-success-retry-terminal',
        workbenchRouteKey: first.outbound.workbenchRouteKey,
        workbenchWorkspaceGeneration: first.outbound.workbenchWorkspaceGeneration,
        _workbenchRequestId: first.outbound._workbenchRequestId,
      }),
    );
    expect(getWorkbenchTerminalOwner('agent-1', 'fenced-success-retry-terminal')).toMatchObject({
      pendingRequestId: retry.outbound._workbenchRequestId,
    });
  });

  it('does not send a destructive late-success close to a legacy Agent without cleanup fencing', async () => {
    const legacyCapabilities = ['terminal', 'file_editor', 'workbench_session_routes'];
    const first = await registerRouteRequest({
      type: 'terminal_create',
      requestId: 'legacy-terminal-success-expired',
      extra: { terminalId: 'legacy-success-retry-terminal', cols: 80, rows: 24 },
      agentCapabilities: legacyCapabilities,
    });
    expect(__testExpireWorkbenchRequest(
      'agent-1',
      first.outbound._workbenchRequestId,
    )).toBe(true);

    const retry = await registerRouteRequest({
      type: 'terminal_create',
      requestId: 'legacy-terminal-success-retry',
      extra: { terminalId: 'legacy-success-retry-terminal', cols: 80, rows: 24 },
      agentCapabilities: legacyCapabilities,
    });
    await vi.waitFor(() => expect(sendToWebClient).toHaveBeenCalledWith(
      first.client,
      expect.objectContaining({
        type: 'terminal_error',
        requestId: 'legacy-terminal-success-expired',
        error: 'Workbench request timed out',
      }),
    ));
    sendToAgent.mockClear();
    sendToWebClient.mockClear();

    await handleAgentFileTerminal('agent-1', agents.get('agent-1'), {
      type: 'terminal_created',
      conversationId: first.outbound.conversationId,
      workbenchRouteKey: first.outbound.workbenchRouteKey,
      workbenchWorkspaceGeneration: first.outbound.workbenchWorkspaceGeneration,
      _requestUserId: first.outbound._requestUserId,
      _requestClientId: first.outbound._requestClientId,
      requestId: first.outbound.requestId,
      terminalId: 'legacy-success-retry-terminal',
      success: true,
    });

    expect(sendToWebClient).not.toHaveBeenCalled();
    expect(sendToAgent).not.toHaveBeenCalled();
    expect(getWorkbenchTerminalOwner('agent-1', 'legacy-success-retry-terminal')).toMatchObject({
      pendingRequestId: retry.outbound._workbenchRequestId,
    });
  });

  it('sends the exact established create token when the browser disconnects after Agent ack', async () => {
    const { outbound } = await registerRouteRequest({
      type: 'terminal_create',
      clientId: 'disconnect-established-client',
      extra: { terminalId: 'disconnect-established-terminal', cols: 80, rows: 24 },
    });
    await handleAgentFileTerminal('agent-1', agents.get('agent-1'), {
      type: 'terminal_created',
      conversationId: outbound.conversationId,
      terminalId: 'disconnect-established-terminal',
      success: true,
      _workbenchRequestId: outbound._workbenchRequestId,
      workbenchWorkspaceGeneration: outbound.workbenchWorkspaceGeneration,
    });
    sendToAgent.mockClear();

    cleanupWorkbenchForDisconnectedClient('disconnect-established-client');

    expect(sendToAgent).toHaveBeenCalledWith(
      agents.get('agent-1'),
      {
        type: 'terminal_close',
        terminalId: 'disconnect-established-terminal',
        conversationId: outbound.conversationId,
        workbenchRouteKey: outbound.workbenchRouteKey,
        workbenchWorkspaceGeneration: outbound.workbenchWorkspaceGeneration,
        _workbenchRequestId: outbound._workbenchRequestId,
      },
    );
    expect(getWorkbenchTerminalOwner('agent-1', 'disconnect-established-terminal')).toBeNull();
  });

  it('sends the exact pending create token when the browser disconnects before Agent ack', async () => {
    const { outbound } = await registerRouteRequest({
      type: 'terminal_create',
      clientId: 'disconnect-cleanup-client',
      extra: { terminalId: 'disconnect-retry-terminal', cols: 80, rows: 24 },
    });
    expect(getWorkbenchTerminalOwner('agent-1', 'disconnect-retry-terminal')).toMatchObject({
      pendingRequestId: outbound._workbenchRequestId,
    });
    sendToAgent.mockClear();

    cleanupWorkbenchForDisconnectedClient('disconnect-cleanup-client');

    expect(sendToAgent).toHaveBeenCalledWith(
      agents.get('agent-1'),
      {
        type: 'terminal_close',
        terminalId: 'disconnect-retry-terminal',
        conversationId: outbound.conversationId,
        workbenchRouteKey: outbound.workbenchRouteKey,
        workbenchWorkspaceGeneration: outbound.workbenchWorkspaceGeneration,
        _workbenchRequestId: outbound._workbenchRequestId,
      },
    );
    expect(getWorkbenchTerminalOwner('agent-1', 'disconnect-retry-terminal')).toBeNull();
  });

  it('quarantines a late legacy terminal error without falling through to a same-id retry owner', async () => {
    const legacyCapabilities = ['terminal', 'file_editor', 'workbench_session_routes'];
    const first = await registerRouteRequest({
      type: 'terminal_create',
      requestId: 'legacy-terminal-expired',
      extra: { terminalId: 'legacy-retry-terminal', cols: 80, rows: 24 },
      agentCapabilities: legacyCapabilities,
    });
    expect(__testExpireWorkbenchRequest(
      'agent-1',
      first.outbound._workbenchRequestId,
    )).toBe(true);

    const retry = await registerRouteRequest({
      type: 'terminal_create',
      requestId: 'legacy-terminal-retry',
      extra: { terminalId: 'legacy-retry-terminal', cols: 80, rows: 24 },
      agentCapabilities: legacyCapabilities,
    });
    await vi.waitFor(() => expect(sendToWebClient).toHaveBeenCalledWith(
      first.client,
      expect.objectContaining({
        type: 'terminal_error',
        requestId: 'legacy-terminal-expired',
        error: 'Workbench request timed out',
      }),
    ));
    sendToWebClient.mockClear();

    await handleAgentFileTerminal('agent-1', agents.get('agent-1'), {
      type: 'terminal_error',
      conversationId: first.outbound.conversationId,
      workbenchRouteKey: first.outbound.workbenchRouteKey,
      workbenchWorkspaceGeneration: first.outbound.workbenchWorkspaceGeneration,
      _requestUserId: first.outbound._requestUserId,
      _requestClientId: first.outbound._requestClientId,
      requestId: first.outbound.requestId,
      terminalId: 'legacy-retry-terminal',
      error: 'late create failure',
    });

    expect(sendToWebClient).not.toHaveBeenCalled();
    expect(getWorkbenchTerminalOwner('agent-1', 'legacy-retry-terminal')).toMatchObject({
      pendingRequestId: retry.outbound._workbenchRequestId,
    });

    await handleAgentFileTerminal('agent-1', agents.get('agent-1'), {
      type: 'terminal_created',
      conversationId: retry.outbound.conversationId,
      workbenchRouteKey: retry.outbound.workbenchRouteKey,
      workbenchWorkspaceGeneration: retry.outbound.workbenchWorkspaceGeneration,
      _requestUserId: retry.outbound._requestUserId,
      _requestClientId: retry.outbound._requestClientId,
      requestId: retry.outbound.requestId,
      terminalId: 'legacy-retry-terminal',
      success: true,
    });

    expect(sendToWebClient).toHaveBeenCalledTimes(1);
    expect(sendToWebClient).toHaveBeenCalledWith(retry.client, expect.objectContaining({
      type: 'terminal_created',
      requestId: 'legacy-terminal-retry',
      terminalId: 'legacy-retry-terminal',
      success: true,
    }));
  });

  it('routes a legacy route-capable Agent response without internal correlation to the requesting browser', async () => {
    const { outbound, client } = await registerRouteRequest({
      type: 'read_file',
      requestId: 'legacy-read-1',
      extra: { filePath: 'README.md' },
      agentCapabilities: ['terminal', 'file_editor', 'workbench_session_routes'],
    });
    const otherClient = routeClient('user-1', { currentAgent: 'agent-1' });
    webClients.set('client-2', otherClient);
    sendToWebClient.mockClear();

    expect(outbound).toMatchObject({
      _requestUserId: 'user-1',
      _requestClientId: 'client-1',
      requestId: 'legacy-read-1',
    });
    await handleAgentFileTerminal('agent-1', agents.get('agent-1'), {
      type: 'file_content',
      conversationId: outbound.conversationId,
      workbenchRouteKey: outbound.workbenchRouteKey,
      workbenchWorkspaceGeneration: outbound.workbenchWorkspaceGeneration,
      _requestUserId: outbound._requestUserId,
      _requestClientId: outbound._requestClientId,
      requestId: outbound.requestId,
      requestedFilePath: 'README.md',
      content: '# legacy response',
    });

    expect(sendToWebClient).toHaveBeenCalledTimes(1);
    expect(sendToWebClient).toHaveBeenCalledWith(client, expect.objectContaining({
      type: 'file_content',
      requestId: 'legacy-read-1',
      requestedFilePath: 'README.md',
      content: '# legacy response',
    }));
    expect(sendToWebClient.mock.calls[0][0]).not.toBe(otherClient);
  });

  it('does not let a late legacy response consume a newer retry correlation', async () => {
    const legacyCapabilities = ['terminal', 'file_editor', 'workbench_session_routes'];
    const first = await registerRouteRequest({
      type: 'read_file',
      requestId: 'legacy-read-expired',
      extra: { filePath: 'README.md' },
      agentCapabilities: legacyCapabilities,
    });
    expect(__testExpireWorkbenchRequest(
      'agent-1',
      first.outbound._workbenchRequestId,
    )).toBe(true);

    const retry = await registerRouteRequest({
      type: 'read_file',
      requestId: 'legacy-read-retry',
      extra: { filePath: 'README.md' },
      agentCapabilities: legacyCapabilities,
    });
    await vi.waitFor(() => expect(sendToWebClient).toHaveBeenCalledWith(
      first.client,
      expect.objectContaining({
        type: 'file_content',
        requestId: 'legacy-read-expired',
        error: 'Workbench request timed out',
      }),
    ));
    sendToWebClient.mockClear();

    const legacyReply = (outbound, content) => handleAgentFileTerminal(
      'agent-1',
      agents.get('agent-1'),
      {
        type: 'file_content',
        conversationId: outbound.conversationId,
        workbenchRouteKey: outbound.workbenchRouteKey,
        workbenchWorkspaceGeneration: outbound.workbenchWorkspaceGeneration,
        _requestUserId: outbound._requestUserId,
        _requestClientId: outbound._requestClientId,
        requestId: outbound.requestId,
        requestedFilePath: 'README.md',
        content,
      },
    );

    await legacyReply(first.outbound, 'late expired content');
    expect(sendToWebClient).not.toHaveBeenCalled();

    await legacyReply(retry.outbound, 'retry content');
    expect(sendToWebClient).toHaveBeenCalledTimes(1);
    expect(sendToWebClient).toHaveBeenCalledWith(retry.client, expect.objectContaining({
      type: 'file_content',
      requestId: 'legacy-read-retry',
      content: 'retry content',
    }));
  });

  it('projects read and save timeouts so Files UI can recover and retry', async () => {
    globalThis.Vue = Vue;
    const { outbound: readOutbound } = await registerRouteRequest({
      type: 'read_file',
      requestId: 'read-timeout-1',
      extra: { filePath: 'README.md' },
    });
    const sent = [];
    const store = {
      currentAgent: 'agent-1',
      currentConversation: readOutbound.conversationId,
      clientId: 'client-1',
      sendWsMessage: msg => sent.push(msg),
    };
    const tabs = createFileTabs(store, {
      normalizePath: value => value,
      getEffectiveWorkDir: () => '/workspace/session-1',
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
    tabs.openFileInTab('README.md', 'README.md', {
      agentId: 'agent-1',
      conversationId: readOutbound.conversationId,
      workDir: '/workspace/session-1',
      requestId: 'read-timeout-1',
    });
    const handle = createWsHandler({
      store,
      normalizePath: value => value,
      getEffectiveWorkDir: () => '/workspace/session-1',
      openFiles: tabs.openFiles,
      activeFileIndex: tabs.activeFileIndex,
      activeFile: tabs.activeFile,
      fileLoading: tabs.fileLoading,
      fileSaving: tabs.fileSaving,
      saveTabsState: vi.fn(),
      createEditor: vi.fn(),
      openFileInTab: tabs.openFileInTab,
      bumpTabRevision: tabs.bumpTabRevision,
      acceptTabsRestoreRequest: tabs.acceptTabsRestoreRequest,
      tree: { handleDirectoryListing: vi.fn() },
      setTreeVisible: vi.fn(),
      fp: { handleFolderPickerListing: vi.fn() },
      qo: {},
      ops: { takePendingDownload: () => null },
      mdPreviewMode: Vue.ref(false),
      renderOfficeLocal: vi.fn(),
      editorContainer: Vue.ref(null),
      routeKey: readOutbound.workbenchRouteKey,
      workspaceGeneration: readOutbound.workbenchWorkspaceGeneration,
    }).handleWorkbenchMessage;

    sendToWebClient.mockClear();
    expect(__testExpireWorkbenchRequest('agent-1', readOutbound._workbenchRequestId)).toBe(true);
    await handleAgentFileTerminal('agent-1', agents.get('agent-1'), {
      type: 'file_content',
      conversationId: readOutbound.conversationId,
      _workbenchRequestId: readOutbound._workbenchRequestId,
      workbenchWorkspaceGeneration: readOutbound.workbenchWorkspaceGeneration,
      requestedFilePath: 'README.md',
      content: 'late content',
    });
    await vi.waitFor(() => expect(sendToWebClient).toHaveBeenCalledTimes(1));
    const readTimeout = sendToWebClient.mock.calls.at(-1)[1];
    handle(new CustomEvent('workbench-message', { detail: readTimeout }));
    expect(tabs.fileLoading.value).toBe(false);
    expect(tabs.activeFile.value.loadError).toBe('Workbench request timed out');

    tabs.activeFile.value.content = 'updated';
    tabs.activeFile.value.isDirty = true;
    tabs.saveFile();
    const saveRequest = sent.find(msg => msg.type === 'write_file');
    const saveRegistration = await registerRouteRequest({
      type: 'write_file',
      requestId: saveRequest.requestId,
      extra: { filePath: 'README.md', content: 'updated' },
    });
    sendToWebClient.mockClear();
    expect(__testExpireWorkbenchRequest(
      'agent-1',
      saveRegistration.outbound._workbenchRequestId,
    )).toBe(true);
    await handleAgentFileTerminal('agent-1', agents.get('agent-1'), {
      type: 'file_saved',
      conversationId: saveRegistration.outbound.conversationId,
      _workbenchRequestId: saveRegistration.outbound._workbenchRequestId,
      workbenchWorkspaceGeneration: saveRegistration.outbound.workbenchWorkspaceGeneration,
      requestedFilePath: 'README.md',
      success: true,
    });
    await vi.waitFor(() => expect(sendToWebClient).toHaveBeenCalledTimes(1));
    const saveTimeout = sendToWebClient.mock.calls.at(-1)[1];
    handle(new CustomEvent('workbench-message', { detail: saveTimeout }));
    expect(tabs.fileSaving.value).toBe(false);
    expect(tabs.activeFile.value.isDirty).toBe(true);
    expect(tabs.activeFile.value.pendingSaveRequestId).toBeUndefined();

    const writesBeforeRetry = sent.filter(msg => msg.type === 'write_file').length;
    tabs.saveFile();
    expect(sent.filter(msg => msg.type === 'write_file')).toHaveLength(writesBeforeRetry + 1);
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

  it.each(['', '   ', '/session/explicit'])('resolves history file references with canonical cwd %j', async workDir => {
    const expectedWorkDir = workDir.trim() || '/agent/default';
    const { outbound, client } = await registerRouteRequest({
      type: 'resolve_file_references',
      workDir,
      agentWorkDir: '/agent/default',
      requestId: 'old-session-refs',
      extra: { workDir: '/browser/untrusted', references: ['README.md'] },
    });
    expect(outbound).toMatchObject({
      workDir: expectedWorkDir,
      workbenchWorkspaceGeneration: workbenchWorkspaceGeneration('yeaft:agent-1:session-1', expectedWorkDir),
    });
    sendToWebClient.mockClear();
    await handleAgentFileTerminal('agent-1', agents.get('agent-1'), {
      type: 'file_references_resolved',
      conversationId: outbound.conversationId,
      _workbenchRequestId: outbound._workbenchRequestId,
      references: [{ requestedPath: 'README.md', resolvedPath: 'README.md' }],
    });
    expect(sendToWebClient).toHaveBeenCalledExactlyOnceWith(client, expect.objectContaining({
      type: 'file_references_resolved', requestId: 'old-session-refs',
    }));
  });

  it('drops a delayed fallback response when the Agent default directory changes', async () => {
    const { outbound } = await registerRouteRequest({
      type: 'resolve_file_references', workDir: '', agentWorkDir: '/agent/before',
      requestId: 'default-change', extra: { references: ['README.md'] },
    });
    agents.get('agent-1').workDir = '/agent/after';
    sendToWebClient.mockClear();
    await handleAgentFileTerminal('agent-1', agents.get('agent-1'), {
      type: 'file_references_resolved', conversationId: outbound.conversationId,
      _workbenchRequestId: outbound._workbenchRequestId, references: [],
    });
    expect(sendToWebClient).not.toHaveBeenCalled();
  });

  it.each(['missing', 'archived', 'no-default'])('isolates rejected %s history file previews from chat', async kind => {
    const client = routeClient('user-1', { currentAgent: 'agent-1' });
    installRouteAgent('agent-1', kind === 'missing' ? [] : [{
      id: 'session-1', userId: 'user-1', workDir: '', isArchived: kind === 'archived',
    }]);
    agents.get('agent-1').workDir = kind === 'no-default' ? '' : '/agent/default';
    forwardToAgent.mockClear();
    sendToWebClient.mockClear();
    await handleClientWorkbench('client-1', client, {
      type: 'resolve_file_references', agentId: 'agent-1', requestId: 'denied-refs',
      workDir: '/browser/untrusted', references: ['README.md'],
      workbenchRoute: { runtimeProvider: 'yeaft', agentId: 'agent-1', sessionId: 'session-1' },
    }, async () => true);
    expect(forwardToAgent).not.toHaveBeenCalled();
    expect(sendToWebClient).toHaveBeenCalledExactlyOnceWith(client, expect.objectContaining({
      type: 'file_references_resolved', requestId: 'denied-refs', references: [],
      error: 'Invalid Workbench Session route',
    }));
  });

  it('keeps resolved file references correlated to the requesting browser and route', async () => {
    const { outbound, client } = await registerRouteRequest({
      type: 'resolve_file_references',
      requestId: 'file-refs-public',
      extra: { references: ['plugins.actions'] },
    });
    expect(outbound).toMatchObject({
      type: 'resolve_file_references',
      references: ['plugins.actions'],
      _workbenchRequestId: expect.any(String),
    });
    sendToWebClient.mockClear();
    await handleAgentFileTerminal('agent-1', {}, {
      type: 'file_references_resolved',
      conversationId: outbound.conversationId,
      _workbenchRequestId: outbound._workbenchRequestId,
      references: [{ requestedPath: 'plugins.actions', resolvedPath: 'src/plugins.actions' }],
    });
    expect(sendToWebClient).toHaveBeenCalledOnce();
    expect(sendToWebClient.mock.calls[0][0]).toBe(client);
    expect(sendToWebClient.mock.calls[0][1]).toMatchObject({
      type: 'file_references_resolved',
      agentId: 'agent-1',
      requestId: 'file-refs-public',
      conversationId: outbound.conversationId,
      references: [{ requestedPath: 'plugins.actions', resolvedPath: 'src/plugins.actions' }],
      workbenchRouteKey: workbenchRouteKey({
        runtimeProvider: 'yeaft', agentId: 'agent-1', sessionId: 'session-1',
      }),
    });

    sendToWebClient.mockClear();
    await handleAgentFileTerminal('agent-1', {}, {
      type: 'file_references_resolved',
      conversationId: outbound.conversationId,
      _workbenchRequestId: outbound._workbenchRequestId,
      references: [],
    });
    expect(sendToWebClient).not.toHaveBeenCalled();
  });

  it('reassembles correlated binary chunks into a token-protected HTTP preview', async () => {
    const { outbound, client } = await registerRouteRequest({
      type: 'read_file',
      requestId: 'chunked-file-request',
      extra: { filePath: 'docs/large.png' },
    });
    const first = Buffer.alloc(1024 * 1024, 0x61);
    const second = Buffer.from('tail');
    const common = {
      conversationId: outbound.conversationId,
      _workbenchRequestId: outbound._workbenchRequestId,
      workbenchRouteKey: outbound.workbenchRouteKey,
      workbenchWorkspaceGeneration: outbound.workbenchWorkspaceGeneration,
      filePath: '/workspace/docs/large.png',
      requestedFilePath: 'docs/large.png',
      binary: true,
      mimeType: 'image/png',
      chunkCount: 2,
      totalBytes: first.length + second.length,
    };
    sendToWebClient.mockClear();
    await handleAgentFileTerminal('agent-1', {}, {
      ...common,
      type: 'file_content_chunk',
      chunkIndex: 0,
      content: first.toString('base64'),
    });
    expect(sendToWebClient).not.toHaveBeenCalled();

    await handleAgentFileTerminal('agent-1', {}, {
      ...common,
      type: 'file_content_chunk',
      chunkIndex: 1,
      content: second.toString('base64'),
    });

    expect(sendToWebClient).toHaveBeenCalledOnce();
    expect(sendToWebClient.mock.calls[0][0]).toBe(client);
    const forwarded = sendToWebClient.mock.calls[0][1];
    expect(forwarded).toMatchObject({
      type: 'file_content',
      requestId: 'chunked-file-request',
      requestedFilePath: 'docs/large.png',
      binary: true,
      mimeType: 'image/png',
      previewUrl: expect.stringMatching(/^\/api\/preview\//),
    });
    expect(forwarded).not.toHaveProperty('content');
    expect(previewFiles.get(forwarded.fileId)?.buffer?.equals(Buffer.concat([first, second]))).toBe(true);
    expect(forwarded.previewUrl).toContain(`token=${forwarded.previewToken}`);
  });

  it('fails closed and consumes the correlation when binary chunks arrive out of order', async () => {
    const { outbound } = await registerRouteRequest({
      type: 'read_file',
      requestId: 'invalid-chunk-request',
      extra: { filePath: 'docs/broken.png' },
    });
    const common = {
      conversationId: outbound.conversationId,
      _workbenchRequestId: outbound._workbenchRequestId,
      workbenchRouteKey: outbound.workbenchRouteKey,
      workbenchWorkspaceGeneration: outbound.workbenchWorkspaceGeneration,
      filePath: '/workspace/docs/broken.png',
      requestedFilePath: 'docs/broken.png',
      binary: true,
      mimeType: 'image/png',
      chunkCount: 2,
      totalBytes: 1024 * 1024 + 1,
    };
    sendToWebClient.mockClear();
    await handleAgentFileTerminal('agent-1', {}, {
      ...common,
      type: 'file_content_chunk',
      chunkIndex: 1,
      content: Buffer.from('x').toString('base64'),
    });
    expect(sendToWebClient).toHaveBeenCalledOnce();
    expect(sendToWebClient.mock.calls[0][1]).toMatchObject({
      type: 'file_content',
      requestId: 'invalid-chunk-request',
      binary: false,
      errorCode: 'FILE_TRANSFER_INVALID',
    });
    expect(previewFiles.size).toBe(0);

    sendToWebClient.mockClear();
    await handleAgentFileTerminal('agent-1', {}, {
      ...common,
      type: 'file_content_chunk',
      chunkIndex: 0,
      content: Buffer.alloc(1024 * 1024).toString('base64'),
    });
    expect(sendToWebClient).not.toHaveBeenCalled();
  });

  it('classifies browser video containers separately from text and binary previews', () => {
    for (const name of ['clip.mp4', 'clip.m4v', 'clip.webm', 'clip.ogv', 'clip.ogg', 'clip.mov']) {
      expect(getFileType(name)).toBe('video');
    }
    expect(getFileType('clip.mp3')).toBe('text');
    expect(getFileType('clip.mp4.txt')).toBe('text');
  });

  it('projects video metadata as a route-bound stream URL and fails closed for old Agents', async () => {
    const supported = [
      'terminal', 'file_editor', 'workbench_session_routes',
      'workbench_request_correlation', 'workbench_video_stream',
    ];
    const { outbound, client } = await registerRouteRequest({
      type: 'video_metadata', requestId: 'video-request-1',
      extra: { filePath: 'media/demo.mp4' }, agentCapabilities: supported,
    });
    expect(outbound).toMatchObject({
      type: 'video_metadata', filePath: 'media/demo.mp4', workDir: '/workspace/session-1',
    });
    sendToWebClient.mockClear();
    await handleAgentFileTerminal('agent-1', {}, {
      type: 'video_metadata', conversationId: outbound.conversationId,
      _workbenchRequestId: outbound._workbenchRequestId,
      filePath: '/workspace/session-1/media/demo.mp4', requestedFilePath: 'media/demo.mp4',
      size: 100 * 1024 * 1024, mtimeMs: 1234, mimeType: 'video/mp4',
    });
    const [, projected] = sendToWebClient.mock.calls[0];
    expect(sendToWebClient.mock.calls[0][0]).toBe(client);
    expect(projected).toMatchObject({
      type: 'video_metadata', requestId: 'video-request-1', filePath: 'media/demo.mp4',
      size: 100 * 1024 * 1024, mimeType: 'video/mp4', videoStream: true,
    });
    expect(projected.previewUrl).toMatch(/^\/api\/preview\/.+token=wbv1\./);
    expect(projected).not.toHaveProperty('mtimeMs');

    sendToWebClient.mockClear();
    await registerRouteRequest({
      type: 'video_metadata', requestId: 'video-old-agent',
      extra: { filePath: 'media/demo.mp4' },
      agentCapabilities: ['file_editor', 'workbench_session_routes', 'workbench_request_correlation'],
    });
    expect(forwardToAgent).not.toHaveBeenCalled();
    expect(sendToWebClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      type: 'video_metadata', requestId: 'video-old-agent',
      error: 'Video streaming is not supported by this Agent',
    }));
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
      ops: { takePendingDownload: () => null },
      mdPreviewMode: Vue.ref(false),
      renderOfficeLocal: vi.fn(),
      editorContainer: Vue.ref(null),
      debugStatus: Vue.ref(''),
      t: (key, values) => key === 'files.previewTooLarge'
        ? `too large: ${values.size}/${values.limit}`
        : key,
    }).handleWorkbenchMessage;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, blob: async () => new Blob(['image']) });

    handle(new CustomEvent('workbench-message', { detail: { ...forwarded, agentId: 'agent-2' } }));
    handle(new CustomEvent('workbench-message', { detail: { ...forwarded, conversationId: 'session-2' } }));
    handle(new CustomEvent('workbench-message', { detail: { ...forwarded, requestId: 'stale-request' } }));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(relativeTab.previewLoading).toBe(true);

    handle(new CustomEvent('workbench-message', { detail: forwarded }));
    expect(relativeTab.blobUrl).toBe(`https://yeaft.test${forwarded.previewUrl}`);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(relativeTab.previewLoading).toBe(true);
    expect(wrongOwnerTab.blobUrl).toBeNull();
    expect(wrongOwnerTab.previewLoading).toBe(true);

    expect(updateImagePreviewState(relativeTab, {
      currentTarget: { src: relativeTab.blobUrl },
    })).toBe(true);
    expect(relativeTab.previewLoading).toBe(false);
    expect(relativeTab.previewError).toBeNull();

    relativeTab.blobUrl = 'https://yeaft.test/api/preview/new?token=new';
    relativeTab.previewLoading = true;
    expect(updateImagePreviewState(relativeTab, {
      currentTarget: { src: `https://yeaft.test${forwarded.previewUrl}` },
    }, 'stale failure')).toBe(false);
    expect(relativeTab.previewLoading).toBe(true);
    expect(relativeTab.previewError).toBeNull();
    expect(updateImagePreviewState(relativeTab, {
      currentTarget: { src: relativeTab.blobUrl },
    }, 'preview failed')).toBe(true);
    expect(relativeTab.previewLoading).toBe(false);
    expect(relativeTab.previewError).toBe('preview failed');
    fetchSpy.mockRestore();
  });

  it('maps video metadata to a streamed preview URL and fences stale media events', () => {
    globalThis.Vue = Vue;
    globalThis.location = { protocol: 'https:', host: 'yeaft.test' };
    const videoTab = {
      path: 'media/demo.mp4', name: 'demo.mp4', fileType: 'video', agentId: 'agent-1',
      conversationId: 'session-1', requestId: 'video-request', loading: true,
      previewLoading: true, previewError: null, blobUrl: null,
    };
    const openFiles = Vue.ref([videoTab]);
    const handle = createWsHandler({
      store: { currentConversation: 'session-1', currentAgent: 'agent-1' },
      normalizePath: value => value, getEffectiveWorkDir: () => '/workspace', openFiles,
      activeFileIndex: Vue.ref(0), activeFile: Vue.computed(() => videoTab), fileSaving: Vue.ref(false),
      saveTabsState: vi.fn(), createEditor: vi.fn(), openFileInTab: vi.fn(),
      tree: {}, setTreeVisible: vi.fn(), fp: {}, qo: {}, ops: { takePendingDownload: () => null },
      mdPreviewMode: Vue.ref(false), renderOfficeLocal: vi.fn(), editorContainer: Vue.ref(null),
      t: key => key,
    }).handleWorkbenchMessage;
    handle(new CustomEvent('workbench-message', { detail: {
      type: 'video_metadata', agentId: 'agent-1', conversationId: 'session-1',
      requestId: 'video-request', requestedFilePath: 'media/demo.mp4', videoStream: true,
      previewUrl: '/api/preview/video-1?token=wbv1.secret', size: 50 * 1024 * 1024,
    } }));
    expect(videoTab).toMatchObject({
      loading: false, fileType: 'video', previewLoading: true,
      blobUrl: 'https://yeaft.test/api/preview/video-1?token=wbv1.secret',
    });
    expect(updateMediaPreviewState(videoTab, {
      currentTarget: { src: videoTab.blobUrl },
    })).toBe(true);
    expect(videoTab.previewLoading).toBe(false);
    videoTab.blobUrl = 'https://yeaft.test/api/preview/video-2?token=wbv1.new';
    expect(updateMediaPreviewState(videoTab, {
      currentTarget: { src: 'https://yeaft.test/api/preview/video-1?token=wbv1.secret' },
    }, 'stale error')).toBe(false);
    expect(videoTab.previewError).toBeNull();
  });

  it('keeps a local Office preview loading until its fetch and render complete', async () => {
    globalThis.Vue = Vue;
    globalThis.location = { protocol: 'https:', host: 'yeaft.test' };
    const previousLocalStorage = globalThis.localStorage;
    globalThis.localStorage = { getItem: vi.fn(() => 'local') };
    let resolveBuffer;
    const buffer = new ArrayBuffer(8);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      arrayBuffer: () => new Promise(resolve => { resolveBuffer = resolve; }),
    });
    const officeTab = {
      path: 'docs/report.docx',
      name: 'report.docx',
      fileType: 'office',
      agentId: 'agent-1',
      conversationId: 'session-1',
      requestId: 'office-request',
      previewLoading: true,
      previewError: null,
      localPreviewReady: false,
    };
    const renderOfficeLocal = vi.fn(async file => { file.previewLoading = false; return true; });
    const openFiles = Vue.ref([officeTab]);
    const handle = createWsHandler({
      store: { currentConversation: 'session-1', currentAgent: 'agent-1' },
      normalizePath: value => value,
      getEffectiveWorkDir: () => '/workspace',
      openFiles,
      activeFileIndex: Vue.ref(0),
      activeFile: Vue.computed(() => officeTab),
      fileLoading: Vue.ref(true),
      fileSaving: Vue.ref(false),
      saveTabsState: vi.fn(),
      createEditor: vi.fn(),
      openFileInTab: vi.fn(),
      tree: { handleDirectoryListing: vi.fn() },
      setTreeVisible: vi.fn(),
      fp: { handleFolderPickerListing: vi.fn() },
      qo: {},
      ops: { takePendingDownload: () => null },
      mdPreviewMode: Vue.ref(false),
      renderOfficeLocal,
      editorContainer: Vue.ref(null),
      debugStatus: Vue.ref(''),
    }).handleWorkbenchMessage;

    handle(new CustomEvent('workbench-message', { detail: {
      type: 'file_content',
      agentId: 'agent-1',
      conversationId: 'session-1',
      requestId: 'office-request',
      requestedFilePath: 'docs/report.docx',
      binary: true,
      fileId: 'office-preview',
      previewToken: 'secret',
    } }));

    await vi.waitFor(() => expect(resolveBuffer).toBeTypeOf('function'));
    expect(officeTab.previewLoading).toBe(true);
    expect(renderOfficeLocal).not.toHaveBeenCalled();
    resolveBuffer(buffer);
    await vi.waitFor(() => expect(renderOfficeLocal).toHaveBeenCalledWith(officeTab));
    expect(officeTab.localPreviewReady).toBe(true);
    expect(officeTab.previewLoading).toBe(false);
    fetchSpy.mockRestore();
    globalThis.localStorage = previousLocalStorage;
  });

  it('ends Office preview loading and exposes renderer rejection', async () => {
    globalThis.Vue = Vue;
    const previousWindow = globalThis.window;
    globalThis.window = {
      docx: { renderAsync: vi.fn().mockRejectedValue(new Error('DOCX render failed')) },
    };
    const file = {
      name: 'report.docx',
      _arrayBuffer: new ArrayBuffer(8),
      localPreviewReady: true,
      previewLoading: true,
      previewError: null,
    };
    const container = { innerHTML: '' };
    const activeFile = Vue.ref(file);
    const preview = createFilePreview(activeFile, {
      editorContainer: Vue.ref(null),
      createEditor: vi.fn(),
      t: key => key,
    });
    preview.officePreviewContainer.value = container;

    await expect(preview.renderOfficeLocal(file)).resolves.toBe(false);
    expect(file.previewError).toBe('DOCX render failed');
    expect(file.previewLoading).toBe(false);
    globalThis.window = previousWindow;
  });

  it.each(['resolves', 'rejects'])('keeps the active Office preview authoritative when a stale render %s', async outcome => {
    globalThis.Vue = Vue;
    const previousWindow = globalThis.window;
    const pendingRenders = [];
    globalThis.window = {
      docx: {
        renderAsync: vi.fn((buffer, container) => new Promise((resolve, reject) => {
          pendingRenders.push({ buffer, container, resolve, reject });
        })),
      },
    };
    const fileA = {
      name: 'a.docx', _arrayBuffer: new ArrayBuffer(8),
      previewLoading: false, previewError: null,
    };
    const fileB = {
      name: 'b.docx', _arrayBuffer: new ArrayBuffer(16),
      previewLoading: false, previewError: null,
    };
    const activeFile = Vue.ref(fileA);
    const preview = createFilePreview(activeFile, {
      editorContainer: Vue.ref(null),
      createEditor: vi.fn(),
      t: key => key,
    });
    const liveContainer = {
      innerHTML: '',
      ownerDocument: { createElement: () => ({ innerHTML: '' }) },
    };
    preview.officePreviewContainer.value = liveContainer;

    const renderA = preview.renderOfficeLocal(fileA);
    activeFile.value = fileB;
    const renderB = preview.renderOfficeLocal(fileB);
    expect(pendingRenders).toHaveLength(2);

    pendingRenders[1].container.innerHTML = 'preview B';
    pendingRenders[1].resolve();
    await expect(renderB).resolves.toBe(true);
    expect(liveContainer.innerHTML).toBe('preview B');
    expect(fileB.previewLoading).toBe(false);
    expect(fileB.previewError).toBeNull();

    pendingRenders[0].container.innerHTML = 'preview A';
    if (outcome === 'rejects') pendingRenders[0].reject(new Error('stale A failed'));
    else pendingRenders[0].resolve();
    await expect(renderA).resolves.toBe(false);
    expect(liveContainer.innerHTML).toBe('preview B');
    expect(fileB.previewLoading).toBe(false);
    expect(fileB.previewError).toBeNull();
    globalThis.window = previousWindow;
  });

  it('consumes a correlated download response without requiring an open file tab', () => {
    globalThis.Vue = Vue;
    globalThis.location = { protocol: 'https:', host: 'yeaft.test' };
    const previousDocument = globalThis.document;
    const click = vi.fn();
    const appendChild = vi.fn();
    const removeChild = vi.fn();
    const anchor = { click };
    const createElement = vi.fn(tag => tag === 'a' ? anchor : {});
    globalThis.document = {
      createElement,
      body: { appendChild, removeChild },
    };
    const takePendingDownload = vi.fn(requestId => (
      requestId === 'download-1' ? 'docs/diagram.png' : null
    ));
    const handle = createWsHandler({
      store: { currentConversation: 'session-1', currentAgent: 'agent-1' },
      normalizePath: value => value,
      getEffectiveWorkDir: () => '/workspace',
      openFiles: Vue.ref([]),
      activeFileIndex: Vue.ref(-1),
      activeFile: Vue.ref(null),
      fileLoading: Vue.ref(false),
      fileSaving: Vue.ref(false),
      saveTabsState: vi.fn(),
      createEditor: vi.fn(),
      openFileInTab: vi.fn(),
      tree: { handleDirectoryListing: vi.fn() },
      setTreeVisible: vi.fn(),
      fp: { handleFolderPickerListing: vi.fn() },
      qo: {},
      ops: { takePendingDownload },
      mdPreviewMode: Vue.ref(false),
      renderOfficeLocal: vi.fn(),
      editorContainer: Vue.ref(null),
      debugStatus: Vue.ref(''),
    }).handleWorkbenchMessage;

    handle(new CustomEvent('workbench-message', { detail: {
      type: 'file_content',
      agentId: 'agent-1',
      conversationId: 'session-1',
      requestId: 'download-1',
      requestedFilePath: 'docs/diagram.png',
      binary: true,
      fileId: 'preview-download',
      previewToken: 'secret',
    } }));

    expect(takePendingDownload).toHaveBeenCalledWith('download-1');
    expect(click).toHaveBeenCalledOnce();
    expect(anchor.href).toBe('https://yeaft.test/api/preview/preview-download?token=secret&download=1');
    expect(anchor.download).toBe('diagram.png');
    expect(appendChild).toHaveBeenCalledWith(anchor);
    expect(removeChild).toHaveBeenCalledWith(anchor);
    globalThis.document = previousDocument;
  });
});
