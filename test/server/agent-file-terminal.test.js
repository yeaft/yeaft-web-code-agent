import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG } from '../../server/config.js';
import { userDb, yeaftSessionDb } from '../../server/database.js';
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
  pendingFiles: new Map(),
  previewFiles,
  userFileTabs,
  webClients,
}));

vi.mock('../../server/ws-utils.js', () => ({
  sendToWebClient,
  sendToAgent,
  forwardToClients,
  forwardToAgent,
  resolveAgentAccessError: vi.fn(() => null),
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
const { readWorkbenchPreview } = await import('../../server/workbench-preview.js');
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
});

describe('Agent file terminal forwarding', () => {
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
});
