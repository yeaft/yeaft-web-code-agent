import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../../server/config.js';

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

});
