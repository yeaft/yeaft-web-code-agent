import { afterEach, describe, expect, it, vi } from 'vitest';

const sendToWebClient = vi.fn(async (client, msg) => { client.sent.push(msg); });
const forwardToAgent = vi.fn(async () => true);
const broadcastAgentList = vi.fn(async () => {});
const forwardToClients = vi.fn();
const getByUser = vi.fn(() => []);

vi.mock('../../server/ws-utils.js', async (importOriginal) => ({
  resolveAgentAccessError: (await importOriginal()).resolveAgentAccessError,
  sendToWebClient,
  forwardToAgent,
  forwardToClients,
  sendToAgent: vi.fn(),
  broadcastAgentList,
  broadcastSessionCatalog: vi.fn(),
  buildSessionCatalog: vi.fn(() => []),
  buildHiddenSessionCatalog: vi.fn(() => []),
  verifyConversationOwnership: vi.fn(() => true),
  verifyAgentOwnership: vi.fn(() => true),
}));

vi.mock('../../server/database.js', () => ({
  sessionDb: { getActiveByUser: vi.fn(() => []), get: vi.fn(() => null) },
  messageDb: {},
  userDb: {},
  yeaftProjectDb: { contextForSession: vi.fn(() => null) },
  yeaftSessionDb: { getByUser },
  sessionUiMetadataDb: {},
}));

vi.mock('../../server/handlers/session-pin-router.js', () => ({
  routeSessionPin: vi.fn(() => false),
}));

const { CONFIG } = await import('../../server/config.js');
const { agents, pendingFiles, pendingYeaftDebugRequests, webClients } = await import('../../server/context.js');
const { handleAgentOutput } = await import('../../server/handlers/agent-output.js');
const { handleClientConversation } = await import('../../server/handlers/client-conversation.js');
const originalSkipAuth = CONFIG.skipAuth;
const allow = async () => true;

afterEach(() => {
  CONFIG.skipAuth = originalSkipAuth;
  agents.clear();
  pendingFiles.clear();
  webClients.clear();
  pendingYeaftDebugRequests.clear();
  getByUser.mockReset();
  getByUser.mockReturnValue([]);
  sendToWebClient.mockClear();
  forwardToAgent.mockClear();
  forwardToClients.mockClear();
  broadcastAgentList.mockClear();
});

describe('Yeaft Session online Agent filtering', () => {
  const sendIdentity = {
    id: 'user-message-original', requestId: 'send-request-original',
    sessionId: 'session-original', conversationId: 'conversation-original',
  };
  const uploadedImage = (overrides = {}) => ({
    name: 'screen.png', mimeType: 'image/png', buffer: Buffer.from('image-bytes'),
    uploadedAt: Date.now(), userId: 'user-1', ...overrides,
  });
  const expectSendFailure = (client, agentId, code) => {
    expect(client.sent).toEqual([{
      type: 'error', agentId, ...sendIdentity,
      clientMessageId: sendIdentity.id, code, message: expect.any(String),
    }]);
    expect(client.sent[0].message.length).toBeGreaterThan(0);
    expect(sendToWebClient).toHaveBeenLastCalledWith(client, client.sent[0]);
  };

  it('rejects a foreign Session attachment atomically without consuming valid uploads', async () => {
    CONFIG.skipAuth = false;
    agents.set('agent-online', { ws: { readyState: 1 }, ownerId: 'user-1' });
    const client = { userId: 'user-1', sent: [] };
    const valid = uploadedImage();
    const foreign = uploadedImage({ userId: 'other-owner' });
    pendingFiles.set('valid', valid);
    pendingFiles.set('foreign', foreign);
    await handleClientConversation('client-send', client, {
      type: 'yeaft_session_send', agentId: 'agent-online', ...sendIdentity,
      text: 'Inspect this image', attachments: [{ fileId: 'valid' }, { fileId: 'foreign' }],
    }, allow);
    expectSendFailure(client, 'agent-online', 'invalid_attachment');
    expect(forwardToAgent).not.toHaveBeenCalled();
    expect([...pendingFiles]).toEqual([['valid', valid], ['foreign', foreign]]);
  });

  it('keeps Session uploads retryable on relay failure and reports the original send identity', async () => {
    CONFIG.skipAuth = false;
    agents.set('agent-send', { ws: { readyState: 1 }, ownerId: 'user-1' });
    const image = uploadedImage();
    pendingFiles.set('image', image);
    const client = { userId: 'user-1', sent: [] };
    const msg = {
      type: 'yeaft_session_send', agentId: 'agent-send', ...sendIdentity,
      text: '(attached files)', attachments: [{ fileId: 'image', isImage: true }],
    };
    forwardToAgent.mockResolvedValueOnce(false);
    await handleClientConversation('client-send', client, msg, allow);
    expectSendFailure(client, 'agent-send', 'agent_unavailable');
    expect(pendingFiles.get('image')).toBe(image);
    client.sent = [];
    await handleClientConversation('client-send', client, msg, allow);
    expect(forwardToAgent).toHaveBeenLastCalledWith('agent-send', expect.objectContaining({
      ...sendIdentity, files: [{ name: image.name, mimeType: image.mimeType,
        data: image.buffer.toString('base64'), isImage: true }],
    }));
    expect(forwardToAgent).toHaveBeenCalledTimes(2);
    expect(pendingFiles.has('image')).toBe(false);
    expect(client.sent).toEqual([]);
  });

  it('registers a fork and inherits its Project atomically using real SQLite, without crossing owner/Agent scopes', async () => {
    const { yeaftProjectDb: projects, yeaftSessionDb: sessions, userDb } = await vi.importActual('../../server/database.js');
    const { transaction } = await import('../../server/db/connection.js');
    const owner = userDb.getOrCreate('fork-db-owner');
    const other = userDb.getOrCreate('fork-db-other');
    const register = (ownerId, agentId, sourceId, targetId, fail = false) => transaction(() => {
      sessions.upsertFromSnapshot(ownerId, agentId, { id: targetId, name: 'Fork' });
      projects.inheritSessionProject(ownerId, agentId, sourceId, targetId);
      if (fail) throw new Error('forced rollback');
    })();
    try {
      const project = projects.create(owner.id, 'Fork Project');
      projects.updateInstruction(owner.id, project.id, 'Keep instruction');
      projects.moveSession(owner.id, { agentId: 'agent-a', sessionId: 'source', projectId: project.id });
      register(owner.id, 'agent-a', 'source', 'target');
      expect(sessions.getForAgent(owner.id, 'agent-a', 'target')).toBeTruthy();
      expect(projects.contextForSession(owner.id, 'agent-a', 'target')).toMatchObject({
        projectId: project.id, projectInstruction: 'Keep instruction',
      });
      register(owner.id, 'agent-b', 'source', 'target');
      register(other.id, 'agent-a', 'source', 'target');
      register(owner.id, 'agent-a', 'standalone', 'standalone-target');
      expect(projects.contextForSession(owner.id, 'agent-b', 'target')).toBeNull();
      expect(projects.contextForSession(other.id, 'agent-a', 'target')).toBeNull();
      expect(projects.contextForSession(owner.id, 'agent-a', 'standalone-target')).toBeNull();
      expect(() => register(owner.id, 'agent-a', 'source', 'partial', true)).toThrow('forced rollback');
      expect(sessions.getForAgent(owner.id, 'agent-a', 'partial')).toBeUndefined();
      expect(projects.contextForSession(owner.id, 'agent-a', 'partial')).toBeNull();
    } finally {
      for (const user of [owner, other]) {
        for (const session of sessions.getByUser(user.id)) sessions.deleteForAgent(user.id, session.agentId, session.id);
        userDb.deleteUser(user.id);
      }
    }
  });
  it('hydrates owner inventory as separate Agent slices and excludes disconnected Agents', async () => {
    CONFIG.skipAuth = false;
    agents.set('agent-a', { ws: { readyState: 1 }, ownerId: 'user-1', conversations: new Map() });
    agents.set('agent-b', { ws: { readyState: 1 }, ownerId: 'user-1', conversations: new Map() });
    agents.set('agent-closed', { ws: { readyState: 3 }, ownerId: 'user-1' });
    agents.set('agent-foreign', { ws: { readyState: 1 }, ownerId: 'user-2' });
    const a = { id: 'same-id', agentId: 'agent-a', name: 'A' };
    const b = { id: 'same-id', agentId: 'agent-b', name: 'B' };
    getByUser.mockReturnValue([a, b, { id: 'closed', agentId: 'agent-closed' }]);
    const client = { userId: 'user-1', sent: [] };
    await handleClientConversation('inventory-client', client, { type: 'get_agents', requestId: 'inventory' }, allow);
    expect(getByUser).toHaveBeenCalledWith('user-1');
    expect(client.sent).toEqual([
      { type: 'yeaft_session_hydrate', requestId: 'inventory', agentId: 'agent-a', sessions: [a], fromDb: true },
      { type: 'yeaft_session_hydrate', requestId: 'inventory', agentId: 'agent-b', sessions: [b], fromDb: true },
      { type: 'yeaft_session_hydrate_complete', requestId: 'inventory', ok: true },
    ]);
    expect(sendToWebClient.mock.invocationCallOrder[1]).toBeLessThan(broadcastAgentList.mock.invocationCallOrder[0]);
    expect(broadcastAgentList.mock.invocationCallOrder[0]).toBeLessThan(sendToWebClient.mock.invocationCallOrder[2]);
  });

  it('drops private history for a disconnected requester instead of broadcasting to sibling tabs', async () => {
    CONFIG.skipAuth = false;
    const ownerTab = { authenticated: true, userId: 'user-1', sent: [], ws: { readyState: 1 } };
    const foreignTab = { authenticated: true, userId: 'user-2', sent: [], ws: { readyState: 1 } };
    webClients.set('owner-tab', ownerTab);
    webClients.set('foreign-tab', foreignTab);
    const agent = { ownerId: 'user-1', conversations: new Map(), ws: { readyState: 1, send() {} } };
    await handleAgentOutput('agent-a', agent, {
      type: 'yeaft_history_chunk', conversationId: 'yeaft-agent-a', sessionId: 'same-id',
      requestId: 'history-gone', _requestClientId: 'closed-tab', messages: [{ role: 'user', content: 'private history' }],
    });
    await handleAgentOutput('agent-a', agent, {
      type: 'yeaft_output', conversationId: 'yeaft-agent-a', sessionId: 'same-id',
      requestId: 'history-gone', _requestClientId: 'closed-tab',
      event: { type: 'history_loaded', sessionId: 'same-id', requestId: 'history-gone' },
    });
    expect(ownerTab.sent).toEqual([]);
    expect(foreignTab.sent).toEqual([]);
    expect(forwardToClients).not.toHaveBeenCalled();
  });
});
