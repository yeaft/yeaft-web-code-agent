import { afterEach, describe, expect, it, vi } from 'vitest';

const forwardToAgent = vi.fn(async () => true);
const sendToWebClient = vi.fn(async (target, msg) => { target.sent ??= []; target.sent.push(msg); });
const getForAgent = vi.fn(() => ({ id: 'sess-1', agentId: 'agent-1', userId: 'owner-1' }));

vi.mock('../../server/ws-utils.js', async (importOriginal) => ({
  resolveAgentAccessError: (await importOriginal()).resolveAgentAccessError,
  sendToWebClient,
  forwardToAgent,
  broadcastAgentList: vi.fn(),
  buildSessionCatalog: vi.fn(() => []),
  verifyConversationOwnership: vi.fn(() => true),
  verifyAgentOwnership: vi.fn(() => true),
}));

vi.mock('../../server/database.js', () => ({
  sessionDb: { get: vi.fn(() => null) },
  messageDb: {},
  userDb: {},
  yeaftProjectDb: {},
  yeaftSessionDb: { getByUser: vi.fn(() => []), getForAgent },
  sessionUiMetadataDb: {},
}));

vi.mock('../../server/handlers/session-pin-router.js', () => ({
  routeSessionPin: vi.fn(() => false),
}));

const { agents, pendingYeaftDebugRequests, webClients } = await import('../../server/context.js');
const { handleClientConversation } = await import('../../server/handlers/client-conversation.js');
const allow = async () => true;
const client = { authenticated: true, userId: 'owner-1', username: 'u', currentAgent: 'wrong-agent', sent: [] };

afterEach(() => {
  forwardToAgent.mockClear();
  getForAgent.mockClear();
  getForAgent.mockReturnValue({ id: 'sess-1', agentId: 'agent-1', userId: 'owner-1' });
  sendToWebClient.mockClear();
  pendingYeaftDebugRequests.clear();
  agents.clear();
  webClients.clear();
  webClients.set('client-1', client);
  client.sent = [];
});

describe('Yeaft Session history search relay', () => {
  it('requires explicit compound identity and targets the requesting client', async () => {
    webClients.set('client-1', client);

    await handleClientConversation('client-1', client, {
      type: 'yeaft_search_history',
      agentId: 'agent-1',
      sessionId: 'sess-1',
      requestId: 'req-1',
      query: 'needle',
      senderKey: 'vp:linus',
      beforeSeq: 42,
      perfTraceId: 'pt-search',
    }, allow);

    expect(getForAgent).toHaveBeenCalledWith('owner-1', 'agent-1', 'sess-1');
    expect(forwardToAgent).toHaveBeenCalledWith('agent-1', expect.objectContaining({
      type: 'yeaft_search_history',
      sessionId: 'sess-1',
      requestId: 'req-1',
      query: 'needle',
      senderKey: 'vp:linus',
      beforeSeq: 42,
      perfTraceId: 'pt-search',
      _requestClientId: 'client-1',
    }));

    forwardToAgent.mockClear();
    await handleClientConversation('client-1', client, {
      type: 'yeaft_load_history',
      agentId: 'agent-1',
      sessionId: 'sess-1',
      requestId: 'history-1',
      limit: 5,
    }, allow);
    expect(forwardToAgent).toHaveBeenCalledWith('agent-1', expect.objectContaining({
      type: 'yeaft_load_history',
      sessionId: 'sess-1',
      requestId: 'history-1',
      _requestClientId: 'client-1',
    }));

    forwardToAgent.mockClear();
    await handleClientConversation('client-1', client, {
      type: 'yeaft_load_more_history',
      agentId: 'agent-1',
      sessionId: 'sess-1',
      requestId: 'gap-1',
      beforeSeq: 901,
      pageKind: 'gap',
      gapStopAtSeq: 501,
      cacheEpoch: 7,
      turns: 20,
    }, allow);
    expect(forwardToAgent).toHaveBeenCalledWith('agent-1', expect.objectContaining({
      type: 'yeaft_load_more_history',
      sessionId: 'sess-1',
      requestId: 'gap-1',
      beforeSeq: 901,
      pageKind: 'gap',
      gapStopAtSeq: 501,
      cacheEpoch: 7,
      _requestClientId: 'client-1',
    }));

    forwardToAgent.mockClear();
    await handleClientConversation('client-1', client, {
      type: 'yeaft_fetch_debug_history',
      agentId: 'agent-1',
      sessionId: 'sess-1',
      requestId: 'debug-1',
      requestKind: 'detail',
      detailTurnId: 'turn-1',
      limit: 1,
      dreamLimit: 5,
    }, allow);
    expect(getForAgent).toHaveBeenCalledWith('owner-1', 'agent-1', 'sess-1');
    expect(forwardToAgent).toHaveBeenCalledWith('agent-1', expect.objectContaining({
      type: 'yeaft_fetch_debug_history',
      sessionId: 'sess-1',
      requestId: 'debug-1',
      requestKind: 'detail',
      detailTurnId: 'turn-1',
      limit: 1,
      dreamLimit: 0,
      _requestClientId: 'client-1',
    }));
    forwardToAgent.mockClear();
    await handleClientConversation('client-1', client, {
      type: 'yeaft_fetch_debug_history',
      agentId: 'agent-1',
      sessionId: 'sess-1',
      requestId: 'debug-1',
      detailTurnId: 'turn-collision',
    }, allow);
    expect(forwardToAgent).not.toHaveBeenCalled();

  });

  it('does not fall back to currentAgent or forward an unowned Session', async () => {
    await handleClientConversation('client-1', client, {
      type: 'yeaft_search_history',
      sessionId: 'sess-1',
      query: 'needle',
    }, allow);
    expect(forwardToAgent).not.toHaveBeenCalled();

    getForAgent.mockReturnValue(null);
    await handleClientConversation('client-1', client, {
      type: 'yeaft_load_history_window',
      agentId: 'agent-1',
      sessionId: 'sess-1',
      anchorMessageId: 'm000001',
      anchorSeq: 1,
    }, allow);
    await handleClientConversation('client-1', client, {
      type: 'yeaft_fetch_debug_history',
      agentId: 'agent-1',
      sessionId: 'sess-1',
      requestId: 'debug-unowned',
      detailTurnId: 'turn-1',
    }, allow);
    expect(forwardToAgent).not.toHaveBeenCalled();
  });
});
