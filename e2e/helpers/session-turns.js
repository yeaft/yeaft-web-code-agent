import { expect } from '@playwright/test';

export const SESSION = 'parallel-session';
export const OTHER_SESSION = 'parallel-other-session';
const VP = 'omni';
const CONVERSATION = 'yeaft-parallel-regression';

// Only the Agent wire is scripted. Catalog navigation, composer sends,
// message routing, streaming reduction and rendering use production Vue/Pinia.
export function sessionTurnWire(page, agent, { sessionId = SESSION, vpId = VP, conversationId = CONVERSATION } = {}) {
  const turns = [];
  const history = [];
  let lastEndedAt = 0;
  const event = data => agent.send({ type: 'yeaft_output', conversationId: conversationId,
    sessionId: data.sessionId || sessionId, event: data });
  const frame = (turn, data) => agent.send({ type: 'yeaft_output', conversationId: conversationId,
    sessionId, vpId, userTurnId: turn.userTurnId,
    turnId: turn.executions[0].turnId, threadId: turn.executions[0].threadId, data });
  const snapshot = () => {
    event({ type: 'session_turns', sessionId, turns });
    const live = turns.filter(turn => turn.state === 'running');
    event({ type: 'vp_status_snapshot', sessionId, statuses: live.length ? [{
      sessionId, vpId, state: 'streaming', since: live[0].startedAt,
      turnId: live.at(-1).executions[0].turnId, runningThreadCount: live.length,
      threads: live.map(turn => ({ ...turn.executions[0], since: turn.startedAt, updatedAt: turn.startedAt })),
    }] : [] });
  };
  const send = async (text, supplement = null) => {
    const count = agent.messages('yeaft_session_send').length;
    const composer = page.locator('[data-message-composer]');
    await composer.getByRole('textbox').fill(text);
    await composer.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => agent.messages('yeaft_session_send').length).toBe(count + 1);
    const request = agent.messages('yeaft_session_send').at(-1);
    expect(request.sessionId).toBe(sessionId);
    expect(request.text).toBe(text);
    const userTurnId = supplement?.userTurnId || request.id;
    const relation = supplement ? 'supplement' : 'new';
    event({ type: 'user_message_routed', sessionId, messageId: request.id, userTurnId, relation });
    // The Agent persists the send id as clientMessageId, which dedupes the optimistic row on replay.
    history.push({ id: request.id, clientMessageId: request.id, seq: history.length + 1, role: 'user', content: text,
      sessionId, userTurnId, turnRelation: relation, ts: Date.now() });
    if (supplement) return supplement;
    const turn = { userTurnId, userMessageId: request.id, startedAt: Date.now(), state: 'running',
      executions: [{ vpId, threadId: `thread-${count}`, turnId: `engine-${count}`, state: 'streaming' }] };
    turns.push(turn);
    event({ type: 'vp_turn_start', sessionId, userTurnId, ...turn.executions[0] });
    snapshot();
    return turn;
  };
  const delta = (turn, text, id = `reply-${turn.userTurnId}`) => {
    frame(turn, { type: 'assistant', message: { id, content: text } });
    const existing = history.find(row => row.id === id);
    if (existing) existing.content += text;
    else history.push({ id, seq: history.length + 1, role: 'assistant', content: text,
      sessionId, userTurnId: turn.userTurnId, speakerVpId: vpId,
      turnId: turn.executions[0].turnId, threadId: turn.executions[0].threadId, ts: Date.now() });
  };
  const tool = (turn, id, name) => {
    frame(turn, { type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: { path: `${id}.js` } }] } });
    frame(turn, { type: 'user', tool_use_result: [{ type: 'tool_result', tool_use_id: id, content: `${id} evidence` }] });
    history.push({ id: `tool-${id}`, seq: history.length + 1, role: 'assistant', content: '',
      sessionId, userTurnId: turn.userTurnId, speakerVpId: vpId,
      turnId: turn.executions[0].turnId, threadId: turn.executions[0].threadId, ts: Date.now(),
      toolCalls: [{ id, name, input: { path: `${id}.js` } }] });
  };
  const finish = (turn, reason = 'end_turn') => {
    turn.state = reason === 'aborted' ? 'aborted' : 'completed';
    turn.executions[0].state = turn.state;
    // Like the Agent, a finished root carries its end time; strictly ordered here.
    turn.endedAt = lastEndedAt = Math.max(Date.now(), lastEndedAt + 1);
    if (reason === 'end_turn') frame(turn, { type: 'result', result_text: '' });
    event({ type: 'vp_turn_end', sessionId, userTurnId: turn.userTurnId, ...turn.executions[0], reason });
    snapshot();
  };
  return { turns, history, send, delta, tool, finish, snapshot, event, frame };
}

export async function sessionTurnsFixture(page, agent) {
  const wire = sessionTurnWire(page, agent);
  const { event, history, snapshot } = wire;
  const sessions = [SESSION, OTHER_SESSION].map(id => ({
    id, name: id, roster: [VP], defaultVpId: VP, workDir: '/tmp/test',
  }));
  agent._messageHandlers.push(request => {
    if (request.type !== 'yeaft_load_history' || !sessions.some(row => row.id === request.sessionId)) return;
    event({ type: 'session_ready', conversationId: CONVERSATION, sessionId: request.sessionId, model: 'test-model' });
    const rows = request.sessionId === SESSION ? history : [];
    agent.send({ type: 'yeaft_history_chunk', conversationId: CONVERSATION, sessionId: request.sessionId,
      requestId: request.requestId, _requestClientId: request._requestClientId,
      mode: 'recent', messages: rows, hasMore: false,
      oldestSeq: rows[0]?.seq, latestSeq: rows.at(-1)?.seq });
    snapshot();
  });
  const catalog = () => event({ type: 'session_list_updated', sessions });
  const open = async (sessionId = SESSION) => {
    catalog();
    await expect.poll(() => page.evaluate(({ agentId, sessionId }) => window.Pinia.useChatStore().sessionCatalog
      .some(row => row.routeRef.agentId === agentId && row.routeRef.sessionId === sessionId),
    { agentId: agent.agentId, sessionId })).toBe(true);
    await page.evaluate(({ agentId, sessionId }) => {
      const chat = window.Pinia.useChatStore();
      chat.openCatalogSession(chat.sessionCatalog.find(row => row.routeRef.agentId === agentId && row.routeRef.sessionId === sessionId));
      chat.closeSessionSidebar();
    }, { agentId: agent.agentId, sessionId });
    await expect.poll(() => page.evaluate(({ agentId, sessionId }) => {
      const state = window.Pinia.useChatStore().yeaftSessionHistoryState[`${agentId}\u001f${sessionId}`];
      return state?.loaded === true && !state.loading;
    }, { agentId: agent.agentId, sessionId })).toBe(true);
  };
  await open();
  return { ...wire, open, catalog };
}

// Pane identity is on the pane itself (not an implementation-specific child).
export function pane(page, turn) {
  return page.locator(`.parallel-turn-pane[data-user-turn-id="${turn.userTurnId}"]`);
}
