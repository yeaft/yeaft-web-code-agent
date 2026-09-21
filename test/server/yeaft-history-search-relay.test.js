import { afterEach, describe, expect, it, vi } from 'vitest';

const forwardToAgent = vi.fn(async () => true);
const sendToWebClient = vi.fn(async (target, msg) => { target.sent ??= []; target.sent.push(msg); });
const getForAgent = vi.fn(() => ({ id: 'sess-1', agentId: 'agent-1', userId: 'owner-1' }));
const contextForSession = vi.fn(() => null);

vi.mock('../../server/ws-utils.js', () => ({
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
  yeaftProjectDb: {
    contextForSession,
    list: vi.fn(() => []),
    create: vi.fn(),
    rename: vi.fn(),
    delete: vi.fn(),
    moveSession: vi.fn(),
  },
  yeaftSessionDb: { getByUser: vi.fn(() => []), getForAgent },
  sessionUiMetadataDb: {},
}));

vi.mock('../../server/handlers/session-pin-router.js', () => ({
  routeSessionPin: vi.fn(() => false),
}));

const { pendingYeaftDebugRequests, webClients } = await import('../../server/context.js');
const { handleClientConversation } = await import('../../server/handlers/client-conversation.js');
const allow = async () => true;
const client = { authenticated: true, userId: 'owner-1', username: 'u', currentAgent: 'wrong-agent', sent: [] };

afterEach(() => {
  forwardToAgent.mockClear();
  getForAgent.mockClear();
  getForAgent.mockReturnValue({ id: 'sess-1', agentId: 'agent-1', userId: 'owner-1' });
  contextForSession.mockReset();
  contextForSession.mockReturnValue(null);
  sendToWebClient.mockClear();
  pendingYeaftDebugRequests.clear();
  webClients.clear();
  webClients.set('client-1', client);
  client.sent = [];
});

const consolidatedHistoryScenarios = [];
function historyScenario(name, run) { consolidatedHistoryScenarios.push({ name, run }); }
async function runConsolidatedHistoryScenarios() {
  for (const scenario of consolidatedHistoryScenarios) {
    try { await scenario.run(); }
    catch (error) { error.message = `[${scenario.name}] ${error.message}`; throw error; }
  }
}

describe('Yeaft Session history search relay', () => {


  it('rejects manual Dream commands from older clients without forwarding to an Agent', async () => {
    for (const type of ['yeaft_dream_trigger', 'unify_dream_trigger']) {
      await handleClientConversation('client-1', client, { type, agentId: 'agent-1', sessionId: 'sess-1' }, allow);
      expect(client.sent.at(-1)).toMatchObject({ type: 'yeaft_dream_result', sessionId: 'sess-1', skippedReason: 'disabled' });
    }
    expect(forwardToAgent).not.toHaveBeenCalled();
  });

  it('requires explicit compound identity and targets the requesting client', async () => {
    webClients.set('client-1', client);
    await runConsolidatedHistoryScenarios();
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

    contextForSession.mockReturnValue({
      projectId: 'project-1',
      projectName: 'Project 1',
      projectInstruction: 'Use the shared Project checks.',
      sessionIds: ['sess-2'],
    });
    forwardToAgent.mockClear();
    await handleClientConversation('client-1', client, {
      type: 'yeaft_session_send',
      agentId: 'agent-1',
      sessionId: 'sess-1',
      text: 'share only this Agent',
    }, allow);
    expect(contextForSession).toHaveBeenCalledWith('owner-1', 'agent-1', 'sess-1');
    expect(forwardToAgent).toHaveBeenCalledWith('agent-1', expect.objectContaining({
      type: 'yeaft_session_send',
      sessionId: 'sess-1',
      projectContext: {
        projectId: 'project-1',
        projectName: 'Project 1',
        projectInstruction: 'Use the shared Project checks.',
        sessionIds: ['sess-2'],
      },
    }));

    contextForSession.mockReturnValue(null);
    forwardToAgent.mockClear();
    await handleClientConversation('client-1', client, {
      type: 'yeaft_session_send',
      agentId: 'agent-1',
      sessionId: 'sess-1',
      text: 'no project',
    }, allow);
    expect(forwardToAgent).toHaveBeenCalledWith('agent-1', expect.objectContaining({
      projectContext: {
        projectId: null,
        projectName: null,
        projectInstruction: '',
        sessionIds: [],
      },
    }));
  });

  historyScenario('keeps outline total counting opt-in while forwarding its trace identity', async () => {
    await handleClientConversation('client-1', client, {
      type: 'yeaft_load_history_outline',
      agentId: 'agent-1',
      sessionId: 'sess-1',
      requestId: 'outline-default',
      perfTraceId: 'pt-outline-default',
    }, allow);
    expect(forwardToAgent).toHaveBeenLastCalledWith('agent-1', expect.objectContaining({
      includeTotal: false,
      perfTraceId: 'pt-outline-default',
    }));

    await handleClientConversation('client-1', client, {
      type: 'yeaft_load_history_outline',
      agentId: 'agent-1',
      sessionId: 'sess-1',
      requestId: 'outline-counted',
      includeTotal: true,
    }, allow);
    expect(forwardToAgent).toHaveBeenLastCalledWith('agent-1', expect.objectContaining({
      includeTotal: true,
    }));
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
