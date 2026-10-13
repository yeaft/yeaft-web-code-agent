import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  agents,
  webClients,
  sendToAgent,
  sendToWebClient,
  broadcastAgentList,
} = vi.hoisted(() => ({
  agents: new Map(),
  webClients: new Map(),
  sendToAgent: vi.fn(async () => {}),
  sendToWebClient: vi.fn(async () => {}),
  broadcastAgentList: vi.fn(async () => {}),
}));

vi.mock('../../server/context.js', () => ({ agents, webClients }));
vi.mock('../../server/ws-utils.js', () => ({ sendToAgent, sendToWebClient, broadcastAgentList }));

const { CONFIG } = await import('../../server/config.js');
const { handleClientBrowser } = await import('../../server/handlers/client-browser.js');
const { handleAgentBrowser } = await import('../../server/handlers/agent-browser.js');
const { handleAgentSync } = await import('../../server/handlers/agent-sync.js');
const {
  __testResetBrowserRuntimeRoutes,
  browserPeers,
  getBrowserRoute,
} = await import('../../server/browser-runtime-routes.js');

const originalBrowserConfig = { ...CONFIG.browserRuntime };

function client(id, userId = 'user-a') {
  return {
    id,
    userId,
    role: 'pro',
    authenticated: true,
    browserRuntimeProtocol: 1,
    browserRuntimeSetupProtocol: 1,
    connectionId: `connection-${id}`,
    connectionGeneration: `generation-${id}`,
  };
}

function agent(ownerId = 'user-a') {
  return {
    ownerId,
    capabilities: ['browser_runtime', 'browser_webrtc', 'browser_capture_tab'],
  };
}

async function createBrowserSession({ clientRecord, agentId = 'agent-a', requestId = 'client-create' } = {}) {
  const currentClient = clientRecord || client('client-a');
  webClients.set(currentClient.id, currentClient);
  agents.set(agentId, agent(currentClient.userId));
  await handleClientBrowser(currentClient, {
    type: 'browser_session_create',
    agentId,
    requestId,
    serverIdentity: { ownerUserId: 'forged' },
    options: { initialUrl: 'about:blank' },
  }, async () => true);
  const outbound = sendToAgent.mock.calls.at(-1)[1];
  expect(outbound.requestId).not.toBe(requestId);
  await handleAgentBrowser(agentId, agents.get(agentId), {
    type: 'browser_session_created',
    requestId: outbound.requestId,
    browserSessionId: 'browser-session-a',
    revision: 2,
    state: 'ready',
    activeUrl: 'about:blank',
    pageRevision: 1,
    serverIdentity: { ownerUserId: 'must-not-leak' },
    credential: 'must-not-leak',
    arbitraryAgentField: 'must-not-leak',
  });
  return { currentClient, agentId, outbound };
}

beforeEach(() => {
  agents.clear();
  webClients.clear();
  sendToAgent.mockClear();
  sendToWebClient.mockClear();
  broadcastAgentList.mockClear();
  __testResetBrowserRuntimeRoutes();
  Object.assign(CONFIG.browserRuntime, {
    enabled: true,
    iceTransportPolicy: 'all',
    stunUrls: ['stun:stun.example.test:3478'],
    turnUrls: ['turns:turn.example.test:443?transport=tcp'],
    turnSecret: 'test-turn-secret',
    credentialTtlSeconds: 600,
    routeTtlMs: 15 * 60_000,
  });
});

afterEach(() => {
  Object.assign(CONFIG.browserRuntime, originalBrowserConfig);
});

describe('Browser Runtime Server ownership and signaling', () => {
  it('uses opaque Server correlation and returns create only to the exact requesting socket', async () => {
    const clientA = client('client-a');
    const clientB = client('client-b');
    webClients.set(clientB.id, clientB);
    const { outbound } = await createBrowserSession({ clientRecord: clientA });

    expect(outbound).toMatchObject({
      type: 'browser_session_create',
      requestId: expect.any(String),
      serverIdentity: {
        ownerUserId: 'user-a',
        clientId: 'client-a',
        webConnectionId: 'connection-client-a',
        webConnectionGeneration: 'generation-client-a',
      },
    });
    expect(outbound.serverIdentity.ownerUserId).not.toBe('forged');
    expect(sendToWebClient).toHaveBeenCalledTimes(1);
    expect(sendToWebClient).toHaveBeenCalledWith(clientA, expect.objectContaining({
      type: 'browser_session_created',
      requestId: 'client-create',
      browserSessionId: 'browser-session-a',
      agentId: 'agent-a',
    }));
    expect(sendToWebClient.mock.calls[0][0]).not.toBe(clientB);
    expect(sendToWebClient.mock.calls[0][1]).not.toHaveProperty('serverIdentity');
    expect(sendToWebClient.mock.calls[0][1]).not.toHaveProperty('credential');
    expect(sendToWebClient.mock.calls[0][1]).not.toHaveProperty('arbitraryAgentField');
    expect(getBrowserRoute('agent-a', 'browser-session-a')).toMatchObject({ ownerUserId: 'user-a' });

    sendToWebClient.mockClear();
    await handleClientBrowser(clientA, {
      type: 'browser_session_create', agentId: 'agent-a', requestId: 'client-create',
      options: { initialUrl: 'about:blank' },
    }, async () => true);
    expect(sendToWebClient).toHaveBeenCalledWith(clientA, expect.objectContaining({
      type: 'browser_session_created', requestId: 'client-create',
    }));
    expect(sendToWebClient.mock.calls[0][1]).not.toHaveProperty('arbitraryAgentField');
    expect(sendToWebClient.mock.calls[0][1]).not.toHaveProperty('credential');
  });

  it('rejects cross-owner attach and same-owner sibling-tab answer', async () => {
    const clientA = client('client-a');
    await createBrowserSession({ clientRecord: clientA });
    sendToAgent.mockClear();
    sendToWebClient.mockClear();

    const intruder = client('client-x', 'user-x');
    webClients.set(intruder.id, intruder);
    await handleClientBrowser(intruder, {
      type: 'browser_peer_attach', agentId: 'agent-a', browserSessionId: 'browser-session-a',
      requestId: 'attach-x', connectionGeneration: 1,
    }, async () => true);
    expect(sendToAgent).not.toHaveBeenCalled();
    expect(sendToWebClient).toHaveBeenCalledWith(intruder, expect.objectContaining({
      agentId: 'agent-a',
      code: 'browser_session_not_found',
    }));

    sendToWebClient.mockClear();
    await handleClientBrowser(clientA, {
      type: 'browser_peer_attach', agentId: 'agent-a', browserSessionId: 'browser-session-a',
      requestId: 'attach-a', connectionGeneration: 1, role: 'interactive',
    }, async () => true);
    const prepare = sendToAgent.mock.calls.at(-1)[1];
    expect(prepare).toMatchObject({
      type: 'browser_peer_prepare',
      peerId: expect.any(String),
      connectionGeneration: 1,
      role: 'interactive',
      serverIdentity: expect.objectContaining({ clientId: 'client-a' }),
    });
    expect(prepare.agentIceServers.at(-1).username).toBeTruthy();
    const peer = browserPeers.get(prepare.peerId);
    expect(peer.webIceServers.at(-1).username).not.toBe(prepare.agentIceServers.at(-1).username);

    const firstPeerCount = browserPeers.size;
    sendToAgent.mockClear();
    await handleClientBrowser(clientA, {
      type: 'browser_peer_attach', agentId: 'agent-a', browserSessionId: 'browser-session-a',
      requestId: 'attach-a', connectionGeneration: 1,
    }, async () => true);
    expect(browserPeers.size).toBe(firstPeerCount);
    expect(sendToAgent).not.toHaveBeenCalled();

    const sibling = client('client-b', 'user-a');
    webClients.set(sibling.id, sibling);
    sendToAgent.mockClear();
    await handleClientBrowser(sibling, {
      type: 'browser_peer_answer', agentId: 'agent-a', browserSessionId: 'browser-session-a',
      peerId: prepare.peerId, connectionGeneration: 1,
      description: { type: 'answer', sdp: 'v=0' },
    }, async () => true);
    expect(sendToAgent).not.toHaveBeenCalled();
    expect(sendToWebClient).toHaveBeenCalledWith(sibling, expect.objectContaining({
      agentId: 'agent-a',
      code: 'browser_peer_stale',
    }));
  });
});
