// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { mount } from '@vue/test-utils';
import { createVpStatusBroker } from '../../agent/yeaft/vp-status-broker.js';
import { liveSessionToolsByExecution } from '../../web/stores/helpers/session-tool-details.js';
import { sessionActivityRows } from '../../web/stores/helpers/session-activity.js';
import { sessionExecutionKey } from '../../web/stores/helpers/yeaft-session-identity.js';
import VpTimelinePane from '../../web/components/VpTimelinePane.js';
import en from '../../web/i18n/en.js';
import { normalizeQueryProgress } from '../../web/stores/helpers/query-progress.js';

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
const { useSessionsStore } = await import('../../web/stores/sessions.js');
const { handleAgentList } = await import('../../web/stores/helpers/handlers/agentHandler.js');

describe('message flow regressions', () => {
  it('keeps concurrent user-turn identities, tools and terminal state isolated through live routing and replay', async () => {
    storeFactories.clear();
    runtimeSessionsStore.sessionList = [{ id: 'parallel', agentId: 'agent-a' }];
    runtimeSessionsStore.setActive('parallel', 'agent-a');
    const store = useChatStore();
    store.currentView = 'yeaft';
    store.currentAgent = 'agent-a';
    store.yeaftAgentId = 'agent-a';
    store.yeaftActiveSessionFilter = 'parallel';
    store.yeaftSessionAgentById = { parallel: 'agent-a' };
    store.yeaftConversationId = 'parallel-conversation';
    store.yeaftConversationIdsByAgent = { 'agent-a': 'parallel-conversation' };
    store.activeConversations = ['parallel-conversation'];
    store.connectionState = 'connected';
    store.agents = [{ id: 'agent-a', online: true }];
    store.sendWsMessage = vi.fn(() => true);
    const envelope = { agentId: 'agent-a', conversationId: 'parallel-conversation', sessionId: 'parallel' };
    const event = data => store.handleYeaftOutput({ ...envelope, event: { sessionId: 'parallel', ...data } });
    const frame = (turnId, userTurnId, data) => store.handleYeaftOutput({ ...envelope, vpId: 'omni',
      turnId, threadId: turnId, userTurnId, data });
    const rows = () => store.messagesMap['parallel-conversation'] || [];
    try {
      store.sendYeaftSessionMessage({ groupId: 'parallel', text: 'fix login' });
      const a = rows()[0].clientMessageId;
      event({ type: 'user_message_routed', messageId: a, userTurnId: a, relation: 'new' });
      event({ type: 'vp_turn_start', vpId: 'omni', turnId: 'engine-a', userTurnId: a, threadId: 'engine-a' });
      frame('engine-a', a, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-a', name: 'Bash', input: { command: 'sleep 1' } }] } });
      store.sendYeaftSessionMessage({ groupId: 'parallel', text: 'explain SQL' });
      const b = rows().find(row => row.content === 'explain SQL').clientMessageId;
      event({ type: 'user_message_routed', messageId: b, userTurnId: b, relation: 'new' });
      event({ type: 'vp_turn_start', vpId: 'omni', turnId: 'engine-b', userTurnId: b, threadId: 'engine-b' });
      frame('engine-b', b, { type: 'assistant', message: { content: 'SQL reply' } });
      expect(rows().find(row => row.toolId === 'tool-a').hasResult).not.toBe(true);
      const aTools = () => liveSessionToolsByExecution(store, envelope, new Set([sessionExecutionKey({
        turnId: 'engine-a', threadId: 'engine-a', vpId: 'omni',
      })])).values().next().value || [];
      frame('engine-a', a, { type: 'user', tool_use_result: [{ type: 'tool_result', tool_use_id: 'late-call', content: 'belongs to late call', is_error: true }] });
      expect(rows().find(row => row.toolId === 'tool-a').hasResult).not.toBe(true);
      expect(aTools().map(row => row.toolId)).toEqual(['tool-a']);
      expect(aTools()[0].hasResult).not.toBe(true);
      frame('engine-a', a, { type: 'user', tool_use_result: [{ type: 'tool_result', tool_use_id: 'tool-a', content: 'login evidence', is_error: true }] });
      frame('engine-a', a, { type: 'assistant', ts: 1, message: { content: [{ type: 'tool_use', id: 'late-call', name: 'FileRead', input: { path: 'late.txt' } }] } });
      expect(aTools().map(row => row.toolId)).toEqual(['tool-a', 'late-call']);
      expect(aTools().at(-1)).toMatchObject({ hasResult: true, isError: true, toolResult: 'belongs to late call' });
      expect(rows().find(row => row.toolId === 'late-call')).toMatchObject({ hasResult: true, isError: true });
      frame('engine-a', a, { type: 'assistant', message: { content: 'login reply' } });
      expect(rows().find(row => row.toolId === 'tool-a')).toMatchObject({ userTurnId: a, toolResult: 'login evidence', isError: true });
      expect(aTools()[0]).toMatchObject({ toolResult: 'login evidence', isError: true });
      expect(rows().filter(row => row.type === 'assistant').map(row => [row.userTurnId, row.content])).toEqual([[b, 'SQL reply'], [a, 'login reply']]);
      store.sendYeaftSessionMessage({ groupId: 'parallel', text: 'frontend only' });
      const supplement = rows().find(row => row.content === 'frontend only').clientMessageId;
      event({ type: 'user_message_routed', messageId: supplement, userTurnId: a, relation: 'supplement' });
      expect(rows().find(row => row.clientMessageId === supplement)).toMatchObject({ userTurnId: a, turnRelation: 'supplement' });
      const turns = [a, b].map((root, index) => ({ userTurnId: root, userMessageId: root, startedAt: index + 1,
        state: 'running', executions: [{ vpId: 'omni', threadId: `engine-${index ? 'b' : 'a'}`, turnId: `engine-${index ? 'b' : 'a'}`, state: 'running' }] }));
      event({ type: 'session_turns', turns });
      expect(store.yeaftSessionTurns.map(row => row.userTurnId)).toEqual([a, b]);
      store.handleYeaftOutput({ ...envelope, agentId: 'agent-b', conversationId: 'other', event: { type: 'session_turns', sessionId: 'parallel', turns: [] } });
      expect(store.yeaftSessionTurns).toHaveLength(2);
      event({ type: 'yeaft_turn_aborted', turnId: 'engine-a', turnIds: ['engine-a'], vpId: 'omni', success: true });
      expect(aTools()).toEqual([]);
      expect(Object.values(store.activeVpTurns).map(row => row.turnId)).toEqual(['engine-b']);
      // Restore A to continue exercising terminal frame isolation independently.
      event({ type: 'vp_turn_start', vpId: 'omni', turnId: 'engine-a', userTurnId: a, threadId: 'engine-a' });
      frame('engine-b', b, { type: 'result', result_text: '' });
      expect(store.processingConversations['parallel-conversation']).toBe(true);
      expect(rows().find(row => row.content === 'login reply').isStreaming).toBe(true);
      expect(rows().find(row => row.content === 'SQL reply').isStreaming).toBe(false);
      expect(store._turnCompletedConvs?.has('parallel-conversation')).not.toBe(true);
      frame('engine-a', a, { type: 'result', result_text: '' });
      expect(rows().find(row => row.content === 'login reply').isStreaming).toBe(false);
      event({ type: 'session_turns', turns: [] });
      expect(store.yeaftSessionTurns).toEqual([]);
      // A reconnect history projection retains identity for body and folded tools.
      const request = store.beginYeaftHistoryLoad({ agentId: 'agent-a', sessionId: 'parallel', mode: 'recent' });
      store.handleMessage({ type: 'yeaft_history_chunk', ...envelope, requestId: request.requestId, mode: 'recent', messages: [
        { id: 'm0100', role: 'user', content: 'persisted input', sessionId: 'parallel', userTurnId: 'persisted-root', turnRelation: 'new', ts: 100 },
        { id: 'm0101', role: 'assistant', content: 'persisted reply', sessionId: 'parallel', userTurnId: 'persisted-root', turnId: 'persisted-engine', vpId: 'omni', ts: 200,
          toolCalls: [{ id: 'history-tool', name: 'Read', input: {} }] },
      ], oldestSeq: 100, latestSeq: 101, hasMore: false });
      expect(rows().filter(row => row.userTurnId === 'persisted-root')).toHaveLength(3);
    } finally {
      store.clearYeaftSessionProcessingIfIdle('parallel', { agentId: 'agent-a', ignoreStatuses: true });
      storeFactories.clear();
      runtimeSessionsStore.sessionList = [];
      runtimeSessionsStore.setActive(null, null);
    }
  });

  it('requires fresh Session and broker evidence for stopping after browser or Agent reconnect', () => {
    storeFactories.clear();
    const store = useChatStore();
    const agent = { id: 'a', online: true, capabilities: ['session_scenes'] };
    store.agents = [agent];
    store._hasHandledAgentList = true;
    store.connectionState = 'connected';
    store.yeaftConversationIdsByAgent = { a: 'conv' };
    store.sendWsMessage = vi.fn(() => true);
    const scope = { agentId: 'a', sessionId: 's' };
    const frame = event => store.handleYeaftOutput({ ...scope, conversationId: 'conv', event });
    const execution = { vpId: 'omni', turnId: 'engine', threadId: 'thread', state: 'streaming' };
    const status = () => frame({ ...execution, type: 'vp_status_changed', sessionId: 's', threads: [execution] });
    const snapshot = () => frame({ type: 'session_turns', sessionId: 's', turns: [{
      userTurnId: 'root', startedAt: 1234, state: 'running', executions: [execution],
    }] });
    const read = () => sessionActivityRows(store, scope);
    snapshot();
    status();
    expect(read()).toMatchObject([{ userTurnId: 'root', status: 'streaming', canStop: true, startedAt: 1234 }]);
    for (const reconnect of [
      () => { store.chatHistoryConnectionGeneration++; },
      () => {
        const generation = store.chatHistoryConnectionGeneration;
        store.handleMessage({ type: 'agent_list', agents: [] });
        store.handleMessage({ type: 'agent_list', agents: [agent] });
        expect(store.chatHistoryConnectionGeneration).toBe(generation);
      },
    ]) {
      reconnect();
      expect(read()).toEqual([]);
      status();
      expect(read()).toMatchObject([{ turnId: 'engine', canStop: false }]);
      snapshot();
      expect(read()).toMatchObject([{ userTurnId: 'root', status: 'streaming', canStop: true, startedAt: 1234 }]);
    }
  });

  it('filters only superseded Session errors, including late parallel failures and legacy history replay', () => {
    storeFactories.clear();
    const store = useChatStore();
    store.agents = [{ id: 'a', online: true, capabilities: ['session_scenes'] }];
    store.connectionState = 'connected';
    store.yeaftConversationIdsByAgent = { a: 'conv' };
    store.sendWsMessage = vi.fn(() => true);
    const scope = { agentId: 'a', sessionId: 's' };
    const frame = event => store.handleYeaftOutput({ ...scope, conversationId: 'conv', event });
    const execution = (id, state = 'running') => ({ vpId: 'omni', turnId: `engine-${id}`, threadId: id, state });
    const root = (id, startedAt, state, executions = [execution(id, state)]) => ({ userTurnId: id, startedAt, state, executions });
    const snapshot = (...turns) => frame({ type: 'session_turns', turns });
    const rows = () => sessionActivityRows(store, scope);
    const errors = () => rows().flatMap(row => row.errors.map(error => error.turnId));
    let now = 150;
    const broker = createVpStatusBroker({ send: frame, now: () => now });
    const fail = id => broker.transition({ ...execution(id, 'error'), sessionId: 's', errorDetail: { message: id } });
    const a = root('a', 100, 'errored');
    const b = root('b', 200, 'running');
    snapshot(a);
    fail('a');
    frame({ ...execution('a'), type: 'vp_turn_end', reason: 'errored' });
    expect(errors()).toEqual(['engine-a']);
    store.messagesMap = { conv: [
      { type: 'user', sessionId: 's', timestamp: 180, turnRelation: 'supplement', userTurnId: 'a', isHistory: true },
      { type: 'user', sessionId: 's', timestamp: 185, clientMessageId: 'unconfirmed' },
      { type: 'user', sessionId: 'other', timestamp: 900, isHistory: true },
      { type: 'user', sessionId: 's', agentId: 'other', timestamp: 900, isHistory: true },
    ] };
    expect(errors()).toEqual(['engine-a']);
    snapshot(a, b);
    expect(rows()).toMatchObject([{ userTurnId: 'b', canStop: true, errors: [] }]);

    // An execution from an older root can fail after B is running; live
    // siblings of that root keep its diagnostics without affecting B's row.
    const older = root('older', 180, 'running', [execution('late', 'errored'), execution('still-live')]);
    snapshot(a, older, b);
    now = 220;
    fail('late');
    expect(rows()).toMatchObject([{ userTurnId: 'older', canStop: true, errors: [{ turnId: 'engine-late' }] },
      { userTurnId: 'b', canStop: true, errors: [] }]);
    const lateFailure = { ...older, state: 'errored', executions: [execution('late', 'errored')] };
    snapshot(a, lateFailure, b);
    expect(errors()).toEqual([]);
    // The global broker can replay before this Session's Turn inventory.
    // The failed parallel root must not flash back; B cannot be stopped yet.
    broker.transition({ sessionId: 's', ...execution('b', 'tool') });
    store.chatHistoryConnectionGeneration++;
    broker.broadcastSnapshot();
    expect(rows()).toMatchObject([{ turnId: 'engine-b', canStop: false, errors: [] }]);
    snapshot(a, lateFailure, b);
    expect(rows()).toMatchObject([{ userTurnId: 'b', canStop: true, errors: [] }]);
    // B becomes the latest failure; missing provider details don't erase its identity.
    now = 240;
    broker.transition({ sessionId: 's', ...execution('b', 'error') });
    frame({ ...execution('b'), type: 'vp_turn_end', reason: 'errored' });
    const failed = { ...b, state: 'errored', executions: [execution('b', 'errored')] };
    snapshot(a, lateFailure, failed);
    expect(errors()).toEqual(['engine-b']);
    const completed = root('c', 250, 'completed');
    store.chatHistoryConnectionGeneration++;
    snapshot(a, lateFailure, failed, completed);
    broker.broadcastSnapshot({ sessionId: 's' });
    expect(rows()).toEqual([]);
    expect(Object.values(store.vpStatuses)[0].threads.filter(thread => thread.state === 'error')).toHaveLength(3);

    // Older Agents can replay a later prompt but have no user-turn inventory.
    store.agents = [{ id: 'a', online: true, capabilities: [] }];
    store.yeaftSessionTurnsBySession = {};
    expect(errors()).toContain('engine-b');
    store.messagesMap.conv.push({ type: 'user', sessionId: 's', isHistory: true, timestamp: 250 });
    expect(rows()).toEqual([]);
  });

  it('keeps current Session choices and configuration when receipts or inventory arrive out of order', async () => {
    vi.useFakeTimers();
    const mockedSessions = Pinia.useSessionsStore;
    const mockedChat = Pinia.useChatStore;
    Pinia.useSessionsStore = useSessionsStore;
    const lastViewedKey = 'lastViewedYeaftSession';
    const saved = localStorage.getItem(lastViewedKey);
    localStorage.removeItem(lastViewedKey);
    try {
      storeFactories.clear();
      const store = useChatStore();
      const sessions = useSessionsStore();
      sessions.applySnapshot([{ id: 's', config: { sceneId: 'software' } }], 'a');
      sessions.applySnapshot([{ id: 's', config: { sceneId: 'investment' } }], 'b');
      sessions.setActive('s', 'a');
      store.currentAgent = 'b';
      store.agents = ['a', 'b'].map(id => ({ id, online: true, capabilities: ['session_scenes'] }));
      store._hasHandledAgentList = true;
      store.connectionState = 'connected';
      store.sendWsMessage = vi.fn(() => true);
      const sent = () => store.sendWsMessage.mock.calls.map(([msg]) => msg)
        .filter(msg => msg.type !== 'perf_trace_events');
      const last = () => sent().at(-1);
      const ack = (request, agentId = 'a') => store.handleYeaftOutput({ agentId, event: {
        type: 'session_crud_result', op: 'update_config', ok: true,
        requestId: request.requestId, sessionId: 's', config: request.config,
      } });
      const scene = () => sessions.sessionById('s', 'a').sceneId;
      const choose = sceneId => store.updateYeaftSessionScene('s', sceneId, 'a');
      const send = text => store.sendYeaftSessionMessage({ groupId: 's', text });

      const slow = choose('frontend');
      const first = last();
      const queued = send('Send after confirmation');
      await vi.advanceTimersByTimeAsync(12_000);
      expect(first).toMatchObject({ type: 'yeaft_update_session_config', agentId: 'a', sessionId: 's', config: { sceneId: 'frontend' } });
      expect(sent()).toEqual([first]);
      expect(store.pendingSessionSceneSelectionFor('s', 'a')).toBe('frontend');
      ack(first, 'b');
      expect(sessions.sessionById('s', 'b').sceneId).toBe('investment');
      expect(scene()).toBe('software');
      ack(first);
      expect(await slow).toMatchObject({ ok: true });
      await queued;
      expect(scene()).toBe('frontend');
      expect(sent()).toEqual([first, expect.objectContaining({ type: 'yeaft_session_send', agentId: 'a', text: 'Send after confirmation' })]);

      const missing = choose('writing');
      const expired = last();
      const retained = send('Keep my draft');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await missing).toMatchObject({ ok: false, error: { code: 'scene_unconfirmed' } });
      expect(await retained).toBe(false);
      expect(sent()).toHaveLength(3);
      expect(scene()).toBe('frontend');

      const newest = choose('general');
      ack(last());
      expect(await newest).toMatchObject({ ok: true });
      ack(expired);
      expect(scene()).toBe('general');
      expect(sent()).toHaveLength(4);

      const disconnected = choose('frontend');
      const interruptedSend = send('Do not send on disconnect');
      handleAgentList(store, { agents: store.agents.map(agent => ({ ...agent, online: agent.id !== 'a' })) });
      expect(await disconnected).toMatchObject({ ok: false, error: { code: 'scene_unconfirmed' } });
      expect(await interruptedSend).toBe(false);
      expect(sent()).toHaveLength(5);
      expect(store._sessionCrudPending.size).toBe(0);

      Pinia.useChatStore = useChatStore;
      // A catalog route can open before its live row. Holding a snapshot must
      // not hide that view or start the old Session's history when it commits.
      store.agents[0].online = true;
      store.yeaftSessionInventoryCompleteSupported = true;
      const scope = (agentId, sessionId) => ({ runtimeProvider: 'yeaft', agentId, sessionId });
      const open = (agentId, sessionId) => store.openCatalogSession({
        catalogKey: `yeaft:${agentId}:${sessionId}`, routeRef: scope(agentId, sessionId),
      });
      const requestInventory = (id, rows = []) => {
        store.yeaftSessionHydrateRequestId = id;
        store.handleMessage({ type: 'yeaft_session_hydrate', requestId: id, agentId: 'b', sessions: rows });
      };
      const commit = id => store.handleMessage({ type: 'yeaft_session_hydrate_complete', requestId: id });
      const record = (op, payload) => store.handleYeaftOutput({ agentId: 'b',
        event: { type: 'session_crud_result', ok: true, op, ...payload } });
      requestInventory('stale-catalog', [{ id: 's' }]);
      open('b', 'catalog-only');
      commit('stale-catalog');
      expect(store.activeSessionRoute).toEqual(scope('b', 'catalog-only'));
      expect(sessions.waitingForLastViewedSession).toBe(false);
      expect(localStorage.getItem(lastViewedKey)).toBe('b\u001fcatalog-only');

      // A newer create is not a selection until the user opens it. An older
      // buffered list can't drop the new row or reintroduce a deleted row.
      requestInventory('stale-crud', [{ id: 's' }]);
      record('create', { session: { id: 'new', name: 'New' } });
      expect(store.activeSessionRoute).toEqual(scope('b', 'catalog-only'));
      open('b', 'new');
      record('delete', { sessionId: 's' });
      record('update_config', { sessionId: 'new', config: { sceneId: 'software' } });
      commit('stale-crud');
      expect(store.activeSessionRoute).toEqual(scope('b', 'new'));
      expect(sessions.sessionById('new', 'b')).toMatchObject({ name: 'New', sceneId: 'software' });
      expect(sessions.sessionById('s', 'b')).toBeNull();

      // Conversely, a full live snapshot arriving after a receipt wins.
      // A delayed Server replay cannot overwrite that live snapshot either.
      requestInventory('newer-live', [{ id: 's' }]);
      record('create', { session: { id: 'rename-me', name: 'Old name' } });
      open('b', 'rename-me');
      record('list', { sessions: [{ id: 'rename-me', name: 'New name' }] });
      requestInventory('newer-live', [{ id: 'rename-me', name: 'From stale server replay' }]);
      commit('newer-live');
      expect(store.activeSessionRoute).toEqual(scope('b', 'rename-me'));
      expect(sessions.sessionById('rename-me', 'b').name).toBe('New name');

      requestInventory('server-failure', [{ id: 'rename-me', name: 'Stale name' }]);
      record('list', { sessions: [{ id: 'rename-me', name: 'From the Agent' }] });
      store.handleMessage({ type: 'yeaft_session_hydrate_complete', requestId: 'server-failure', ok: false });
      expect(store.activeSessionRoute).toEqual(scope('b', 'rename-me'));
      expect(store.yeaftSessionHydrateError).toBe('session_inventory_failed');
      expect(sessions.sessionById('rename-me', 'b').name).toBe('From the Agent');

      // A legacy bare identity may resolve only while it has a single owner;
      // the browser must not rewrite a guessed owner as a durable preference.
      localStorage.setItem(lastViewedKey, 'legacy');
      sessions.resetInventory();
      sessions.applySnapshot([{ id: 'legacy' }], 'a');
      expect(store.activeSessionRoute).toEqual(scope('a', 'legacy'));
      sessions.applySnapshot([{ id: 'legacy' }], 'b');
      expect(store.activeSessionRoute).toBeNull();
      expect(localStorage.getItem(lastViewedKey)).toBe('legacy');
      sessions.resetInventory();
      sessions.applySnapshot([{ id: 'fallback' }]);
      expect(store.yeaftActiveSessionFilter).toBe('fallback');
      expect(localStorage.getItem(lastViewedKey)).toBeNull();

      localStorage.setItem(lastViewedKey, 'confirmed-deleted');
      sessions.resetInventory();
      sessions.applySnapshot([]);
      expect(sessions.waitingForLastViewedSession).toBe(true);
      sessions.applyCrudResult({ ok: true, op: 'delete', groupId: 'confirmed-deleted' });
      expect(sessions.waitingForLastViewedSession).toBe(false);
      expect(localStorage.getItem(lastViewedKey)).toBeNull();
    } finally {
      if (saved === null) localStorage.removeItem(lastViewedKey);
      else localStorage.setItem(lastViewedKey, saved);
      Pinia.useSessionsStore = mockedSessions;
      if (mockedChat) Pinia.useChatStore = mockedChat;
      else delete Pinia.useChatStore;
      vi.useRealTimers();
    }
  });

  it('submits stale Carbon selections at High only on its Chat Completions provider', async () => {
    storeFactories.clear();
    const store = useChatStore();
    Object.assign(store, { currentAgent: 'a', connectionState: 'connected', yeaftSessionAgentById: { s: 'a' },
      agents: [{ id: 'a', online: true }], sendWsMessage: vi.fn(() => true) });
    const id = 'gemini-4-carbon';
    store.llmConfig.a = { agentConfig: { availableModels: [
      { id, provider: 'resp', protocol: 'openai-responses', effortOptions: ['medium', 'xhigh'] },
      { id, provider: 'chat', protocol: 'openai-chat-completions', effortOptions: ['medium', 'high'] },
    ] } };
    store.yeaftAvailableModels = store.llmConfig.a.agentConfig.availableModels;
    for (const [provider, effort] of [['chat', 'high'], ['resp', 'xhigh']]) {
      const model = `${provider}/${id}`;
      await store.switchYeaftModel(model, null, 'xhigh');
      expect(store.sendWsMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'yeaft_model_switch', model, modelEffort: effort }));
      store.sendYeaftSessionMessage({ groupId: 's', text: 'test', quickSend: { model, effort: 'xhigh' } });
      expect(store.sendWsMessage).toHaveBeenLastCalledWith(expect.objectContaining({ quickSend: { model, effort, maxOutputTokens: null } }));
    }
  });

  it('previews model/effort immediately, serializes rapid changes, rolls back failures and fences owners', async () => {
    storeFactories.clear();
    const store = useChatStore();
    store.currentAgent = 'a';
    store.yeaftSessionAgentById = { s: 'a' };
    store.agents = [{ id: 'a', online: true }];
    store._hasHandledAgentList = true;
    store.yeaftModel = 'default/model';
    store.yeaftModelEffort = 'max';
    const pending = [];
    store.sessionCrudRequest = vi.fn((op, data, opts) => new Promise(resolve => pending.push({ op, data, opts, resolve })));
    const first = store.switchYeaftModel('proxy/first', 's', 'xhigh');
    expect(store.sessionModelSelectionFor('s')).toEqual({ model: 'proxy/first', modelEffort: 'xhigh' });
    expect(store.sessionModelSelectionFor('s', 'b')).toBeNull();
    const second = store.switchYeaftModel('proxy/second', 's', 'medium');
    expect(store.sessionModelSelectionFor('s')).toEqual({ model: 'proxy/second', modelEffort: 'medium' });
    expect(pending).toHaveLength(1);
    pending[0].resolve({ ok: true });
    expect(await first).toMatchObject({ ok: true, superseded: true });
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[1]).toMatchObject({ op: 'update_config', data: { sessionId: 's', config: { model: 'proxy/second', modelEffort: 'medium' } }, opts: { agentId: 'a' } });
    expect(store.sessionModelSelectionFor('s')?.model).toBe('proxy/second');
    pending[1].resolve({ ok: false, error: { code: 'permission_denied' } });
    expect(await second).toMatchObject({ ok: false, superseded: false });
    expect(store.sessionModelSelectionFor('s')).toBeNull();
    expect(store.yeaftModel).toBe('default/model');
    expect(store.yeaftModelEffort).toBe('max');
    const third = store.switchYeaftModel('proxy/third', 's', 'xhigh');
    store.chatHistoryConnectionGeneration++;
    expect(store.sessionModelSelectionFor('s')).toBeNull();
    const stale = store.switchYeaftModel('proxy/stale', 's', 'xhigh');
    store.chatHistoryConnectionGeneration++;
    pending[2].resolve({ ok: false });
    await third;
    expect(await stale).toMatchObject({ ok: false, error: { code: 'stale_request' } });
    expect(pending).toHaveLength(3);
    expect(store.sessionModelSelectionFor('s')).toBeNull();

    const beforeSend = store.switchYeaftModel('proxy/last', 's', 'xhigh');
    store.sendWsMessage = vi.fn(() => true);
    const send = store.sendYeaftSessionMessage({ groupId: 's', text: 'wait for selection' });
    expect(store.sendWsMessage).not.toHaveBeenCalled();
    pending[3].resolve({ ok: false });
    await beforeSend;
    expect(await send).toBe(false);
    expect(store.sendWsMessage).not.toHaveBeenCalled();
    const confirmed = store.switchYeaftModel('proxy/confirmed', 's', 'xhigh');
    const sendAfterAck = store.sendYeaftSessionMessage({ groupId: 's', text: 'send after confirmation' });
    expect(store.sendWsMessage).not.toHaveBeenCalled();
    pending[4].resolve({ ok: true });
    await confirmed;
    await sendAfterAck;
    expect(store.sendWsMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'yeaft_session_send', sessionId: 's', agentId: 'a' }));

    const disconnecting = store.switchYeaftModel('proxy/disconnecting', 's', 'xhigh');
    const queuedOffline = store.switchYeaftModel('proxy/queued-offline', 's', 'medium');
    const sentCount = pending.length;
    store.agents = [{ id: 'a', online: false }];
    pending.at(-1).resolve({ ok: false, error: { code: 'agent_offline' } });
    // Even an immediate reconnect cannot resurrect the old queued selection.
    store.agents = [{ id: 'a', online: true }];
    await disconnecting;
    expect(await queuedOffline).toMatchObject({ ok: false, error: { code: 'agent_offline' } });
    expect(pending).toHaveLength(sentCount);
    expect(store.sessionModelSelectionFor('s')).toBeNull();
    store.agents = [{ id: 'a', online: false }];
    expect(await store.switchYeaftModel('proxy/offline', 's', 'xhigh')).toMatchObject({ ok: false, error: { code: 'agent_offline' } });
    expect(pending).toHaveLength(sentCount);
  });
  it('shows native sub-agent route details from live events and refreshed snapshots only', async () => {
    storeFactories.clear();
    const store = useChatStore();
    store.sendWsMessage = vi.fn(() => true);
    const scope = { agentId: 'a', sessionId: 's', conversationId: 'conv' };
    const frame = event => store.handleYeaftOutput({ ...scope, event });
    const tasks = () => Object.values(store.yeaftActiveTasksBySession['a\u001fs'] || {});
    const base = { sessionId: 's', kind: 'sub_agent', status: 'running', source: { sceneId: 'software' } };
    const task = { ...base, id: 'new', title: 'Review model routing across two upstream endpoints with a long objective', subAgentRoute: { model: 'proxy/reviewer', sceneId: 'frontend' } };
    const legacy = { ...base, id: 'old', title: 'Older review' };
    const shell = { ...base, id: 'shell', kind: 'shell', runtime: { command: 'echo ok' } };
    frame({ type: 'session_ready', ...scope, tasks: [task, legacy, shell] });
    expect(tasks()).toHaveLength(3);
    vi.stubGlobal('Vue', Vue);
    const pane = mount(VpTimelinePane, { props: { rows: [], tasks: tasks() },
      global: { config: { globalProperties: { $t: (key, args = {}) => (en[key] || key).replace(/\{(\w+)\}/g, (_, name) => args[name] ?? '') } } } });
    try {
      const [row, legacyRow, shellRow] = pane.findAll('.yeaft-vp-task-item');
      const toggle = row.get('.yeaft-vp-task-toggle');
      const preview = row.get('.yeaft-vp-task-route-preview');
      expect(toggle.attributes('aria-expanded')).toBe('false');
      expect(toggle.attributes('aria-describedby')).toBe(preview.attributes('id'));
      expect(preview.text()).toContain('Effective effort: Not reported');
      expect(preview.text()).toContain('Professional scene: Frontend');
      expect(legacyRow.find('.yeaft-vp-task-route-preview').exists()).toBe(false);
      expect(shellRow.find('.yeaft-vp-task-route-preview').exists()).toBe(false);
      expect(shellRow.get('.yeaft-vp-task-toggle').attributes('title')).toContain('Command: echo ok');

      const updated = { ...task, subAgentRoute: { model: 'proxy/fallback', effort: 'medium', sceneId: 'frontend' } };
      frame({ type: 'yeaft_task_event', event: 'updated', task: updated });
      await pane.setProps({ tasks: tasks() });
      expect(preview.text()).toContain('Model: proxy/fallback');
      await toggle.trigger('click');
      expect(toggle.attributes('aria-expanded')).toBe('true');
      expect(row.find('.yeaft-vp-task-route-preview').exists()).toBe(false);
      expect(row.get('.yeaft-vp-task-detail-line').text()).toBe(task.title);
      expect(row.get('.yeaft-vp-task-route').text()).toContain('Effective effort: medium');

      frame({ type: 'session_ready', ...scope, tasks: [updated, legacy, shell] });
      await pane.setProps({ tasks: tasks() });
      expect(row.get('.yeaft-vp-task-route').text()).toContain('Model: proxy/fallback');
      await legacyRow.get('.yeaft-vp-task-toggle').trigger('click');
      expect(legacyRow.find('.yeaft-vp-task-route').exists()).toBe(false);
      frame({ type: 'yeaft_task_event', event: 'completed', task: { ...updated, status: 'succeeded' } });
      expect(tasks().map(entry => entry.id)).toEqual(['old', 'shell']);
    } finally {
      pane.unmount();
      vi.unstubAllGlobals();
      storeFactories.clear();
    }
  });

  it('shows exact scoped turn tokens, inline warnings and a failure-only drilldown', async () => {
    const base = { type: 'query_progress', sessionId: 's', vpId: 'v', turnId: 't', threadId: 'main',
      revision: 1, modelRequests: 187, toolExecutions: 363, reusedCalls: 0, repeatedCalls: 0, failedCalls: 5,
      stage: 'running', reason: null, lastEvidenceAt: 100, stagnantBatches: 0 };
    const stats = [{ name: 'Bash', executions: 12, failedCalls: 4, blockedCalls: 1, output: 'PRIVATE' },
      { name: 'FileRead', executions: 8, failedCalls: 1, blockedCalls: 0 },
      { name: 'FileEdit', executions: 5, failedCalls: 0, blockedCalls: 0 }];
    const progress = normalizeQueryProgress({ ...base, inputTokens: 1234567, outputTokens: 98765,
      toolStats: stats, toolStatsTruncated: false, text: 'PRIVATE' });
    expect(progress).toMatchObject({ inputTokens: 1234567, outputTokens: 98765 });
    expect(JSON.stringify(progress)).not.toContain('PRIVATE');
    for (const toolStats of [[...stats, stats[0]], [{ name: 'x', executions: -1, failedCalls: 0, blockedCalls: 0 }],
      [{ name: 'x', executions: 0, failedCalls: 0, blockedCalls: 1 }], [{ name: 'x'.repeat(129), executions: 0, failedCalls: 0, blockedCalls: 0 }],
      Array(129).fill(stats[0])]) {
      expect(normalizeQueryProgress({ ...base, inputTokens: -1, outputTokens: Infinity, toolStats })).toEqual(base);
    }
    vi.stubGlobal('Vue', Vue);
    const row = { key: 't', vpId: 'v', turnId: 't', status: 'tool', canStop: true, observations: [progress] };
    const pane = mount(VpTimelinePane, { props: { rows: [row] },
      global: { config: { globalProperties: { $t: (key, args = {}) => (en[key] || key).replace(/\{(\w+)\}/g, (_, name) => args[name] ?? '') } } } });
    try {
      expect(pane.get('.yeaft-query-progress-tokens').text()).toContain((1234567).toLocaleString());
      expect(pane.get('.yeaft-query-progress-usage').attributes('aria-label')).toBe('This turn · current thread');
      expect(pane.get('.yeaft-query-progress-usage').attributes('title')).toContain('not context size');
      expect(pane.find('.yeaft-query-progress-details-toggle').exists()).toBe(false);
      const liveStatus = pane.get('.yeaft-query-progress-state');
      expect(liveStatus.attributes('role')).toBe('status');
      expect(liveStatus.text()).toBe('');
      expect(pane.find('.yeaft-query-progress-failures').exists()).toBe(false);
      expect(pane.find('button button, [role="button"] button').exists()).toBe(false);
      await pane.get('.yeaft-query-progress-failures-toggle').trigger('click');
      expect(pane.get('.yeaft-query-progress-failures-toggle').attributes('aria-expanded')).toBe('true');
      expect(pane.findAll('.yeaft-query-progress-tool-row')).toHaveLength(3);
      expect(pane.get('.yeaft-query-progress-failures').text()).toContain('Bash');
      expect(pane.get('.yeaft-query-progress-failures').text()).not.toContain('FileEdit');
      expect(pane.emitted('mention-vp')).toBeUndefined();
      await pane.get('.yeaft-vp-timeline-abort').trigger('click');
      expect(pane.emitted('stop-turn')).toEqual([[row]]);
      expect(pane.emitted('mention-vp')).toBeUndefined();
      const recovering = { ...row, observations: [{ ...progress, stage: 'recovering', reason: 'repeated_failure' }] };
      await pane.setProps({ rows: [recovering] });
      expect(pane.get('.yeaft-query-progress-state').element).toBe(liveStatus.element);
      expect(liveStatus.text()).toBe('Recovering · Repeated tool failures');
      expect(pane.get('.yeaft-query-progress-failures-toggle').attributes('aria-expanded')).toBe('true');
      expect(pane.get('.yeaft-query-progress').text()).not.toContain('Last new evidence');
      await pane.setProps({ rows: [{ ...row, isStopping: true }] });
      expect(pane.get('.yeaft-vp-timeline-abort').attributes()).toHaveProperty('disabled');
      const next = { ...base, turnId: 'new' };
      await pane.setProps({ rows: [{ ...row, observations: [{ ...next, failedCalls: 0 }] }] });
      expect(pane.get('.yeaft-query-progress-tokens').text()).toContain('Not provided');
      expect(pane.find('.yeaft-query-progress-failures-toggle').exists()).toBe(false);
      expect(pane.find('.yeaft-query-progress-failures').exists()).toBe(false);
      await pane.setProps({ rows: [{ ...row, observations: [next] }] });
      expect(pane.get('.yeaft-query-progress-failures-toggle').attributes('aria-expanded')).toBe('false');
      await pane.get('.yeaft-query-progress-failures-toggle').trigger('click');
      expect(pane.get('.yeaft-query-progress-failures').text()).toContain('has not provided');
      await pane.setProps({ rows: [{ ...row, observations: [{ ...progress, toolStats: [], toolStatsTruncated: true }] }] });
      await pane.get('.yeaft-query-progress-failures-toggle').trigger('click');
      expect(pane.get('.yeaft-query-progress-failures').text()).toContain('not listed in the available breakdown');
      expect(pane.get('.yeaft-query-progress-failures').text()).toContain('first 128');
    } finally {
      pane.unmount();
      vi.unstubAllGlobals();
    }
  });

});
