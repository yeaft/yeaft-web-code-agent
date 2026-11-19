// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { mount } from '@vue/test-utils';
import { createVpStatusBroker } from '../../agent/yeaft/vp-status-broker.js';
import { sessionActivityRows } from '../../web/stores/helpers/session-activity.js';
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
      frame('engine-a', a, { type: 'user', tool_use_result: [{ type: 'tool_result', tool_use_id: 'tool-a', content: 'login evidence' }] });
      frame('engine-a', a, { type: 'assistant', message: { content: 'login reply' } });
      expect(rows().find(row => row.toolId === 'tool-a')).toMatchObject({ userTurnId: a, toolResult: 'login evidence' });
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
