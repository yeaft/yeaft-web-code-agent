// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { mount } from '@vue/test-utils';
import UnifiedSessionList from '../../web/components/UnifiedSessionList.js';

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
  it('keeps progress ephemeral and Agent/Session/turn/generation scoped, terminal cannot resurrect it', () => {
    storeFactories.clear();
    const store = useChatStore();
    store.currentView = 'yeaft';
    store.currentAgent = 'a';
    store.yeaftAgentId = 'a';
    store.yeaftConversationId = 'conv';
    store.yeaftConversationIdsByAgent = { a: 'conv', b: 'conv-b' };
    store.messagesMap = { conv: [], 'conv-b': [] };
    store.connectionState = 'connected';
    const event = { type: 'query_progress', sessionId: 's', vpId: 'v', turnId: 't', threadId: 'main',
      revision: 1, modelRequests: 2, toolExecutions: 3, reusedCalls: 1, repeatedCalls: 1, failedCalls: 0,
      stage: 'warning', reason: 'repeated_results', lastEvidenceAt: 100, stagnantBatches: 2 };
    const frame = (e, agentId = 'a', conversationId = 'conv') => store.handleYeaftOutput({ agentId, conversationId, event: e });
    const start = { ...event, type: 'vp_turn_start' };
    frame(start);
    const active = () => Object.values(store.activeVpTurns).find(row => row.agentId === 'a');
    frame({ ...event, text: 'PRIVATE', input: { key: 'PRIVATE' } });
    expect(active().queryProgress).toEqual(event);
    expect(store.messagesMap.conv).toEqual([]);
    expect(JSON.stringify(active())).not.toContain('PRIVATE');
    frame({ ...event, revision: 2 }, 'b', 'conv-b');
    frame({ ...event, revision: 2, sessionId: 'other' });
    frame({ ...event, revision: 2, threadId: 'other' });
    frame({ ...event, revision: 2 }, 'a', 'old-conv');
    frame({ ...event, revision: 0 });
    expect(active().queryProgress.revision).toBe(1);
    store.chatHistoryConnectionGeneration++;
    frame({ ...event, revision: 2 });
    expect(active().queryProgress.revision).toBe(1);
    frame({ type: 'vp_status_snapshot', sessionId: 's', statuses: [{ sessionId: 's', vpId: 'v', turnId: 't', state: 'tool' }] });
    expect(active().queryProgress).toBeUndefined();
    frame(event);
    expect(active().queryProgress).toBeUndefined();
    frame({ ...event, revision: 2 });
    expect(active().queryProgress.revision).toBe(2);
    frame({ ...event, type: 'vp_turn_end', reason: 'aborted' });
    frame({ ...event, revision: 3 });
    expect(Object.values(store.activeVpTurns)).toEqual([]);
    frame(start);
    expect(active().queryProgress).toBeUndefined();
    frame({ ...event, revision: 4, stage: 'recovering', reason: 'repeated_failure' });
    expect(active().queryProgress.stage).toBe('recovering');
    frame({ ...event, type: 'vp_turn_end', reason: 'errored' });
    frame({ ...event, revision: 5 });
    expect(Object.values(store.activeVpTurns)).toEqual([]);
    expect(store.messagesMap.conv).toEqual([]);
  });
  it('opens an exact cross-Agent Session without loading the previous Agent and migrates the full runtime state', () => {
    storeFactories.clear();
    runtimeSessionsStore.sessionList = [
      { id: 'session-a', agentId: 'agent-a' },
      { id: 'session-b', agentId: 'agent-b' },
    ];
    runtimeSessionsStore.sessions = {
      'agent-a\u001fsession-a': { id: 'session-a', agentId: 'agent-a' },
      'agent-b\u001fsession-b': { id: 'session-b', agentId: 'agent-b' },
    };
    runtimeSessionsStore.setActive('session-a', 'agent-a');

    const store = useChatStore();
    store.sendWsMessage = vi.fn(() => true);
    store.loadOpenedYeaftSessionsForConnectedAgents = vi.fn();
    store.currentView = 'yeaft';
    store.currentAgent = 'agent-a';
    store.currentAgentInfo = { id: 'agent-a' };
    store.agents = [{ id: 'agent-a', online: true }, { id: 'agent-b', online: true }];
    store.yeaftActiveSessionFilter = 'session-a';
    store.yeaftSessionAgentById = { 'session-a': 'agent-a', 'session-b': 'agent-b' };
    store.yeaftConversationIdsByAgent = {
      'agent-a': 'conv-a',
      'agent-b': 'yeaft-local-agent-b-cold',
    };
    store.yeaftConversationId = 'conv-a';
    store.activeConversations = ['conv-a'];
    store.messagesMap = { 'conv-a': [], 'yeaft-local-agent-b-cold': [] };

    store.openCatalogSession({
      catalogKey: 'yeaft:agent-b:session-b',
      routeRef: { runtimeProvider: 'yeaft', agentId: 'agent-b', sessionId: 'session-b' },
    });

    expect(store.sendWsMessage.mock.calls.map(call => call[0])).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'yeaft_load_history', agentId: 'agent-a', sessionId: 'session-a' }),
    ]));
    expect(store.sendWsMessage.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'yeaft_load_history', agentId: 'agent-b', sessionId: 'session-b' }),
    ]));
    expect(store.currentAgent).toBe('agent-b');
    expect(runtimeSessionsStore.activeSessionKey).toBe('agent-b\u001fsession-b');
    expect(localStorage.getItem('lastViewedYeaftSession')).toBe('agent-b\u001fsession-b');

    const localConversationId = 'yeaft-local-agent-b-cold';
    const bridgeConversationId = 'yeaft-agent-b-real';
    store.messagesMap[localConversationId] = [{
      id: 'pending-b', type: 'user', content: 'pending B', sessionId: 'session-b',
      timestamp: Date.now() + 60_000,
    }];
    store.processingConversations = { [localConversationId]: true };
    store.executionStatusMap = {
      [localConversationId]: { currentTool: { name: 'Bash' }, toolHistory: [], lastActivity: 1 },
    };
    store.sessionHealth = { [localConversationId]: { status: 'agent-offline' } };
    store.refreshingSessionMap = { [localConversationId]: true };
    store._closedAt = { [localConversationId]: 1 };
    store._turnCompletedConvs = new Set([localConversationId]);
    store._processingWatchdogs = { [localConversationId]: setTimeout(() => {}, 60_000) };
    store._yeaftWatchdogConvs = new Set([localConversationId]);
    store._yeaftWatchdogPauseReasons = { [localConversationId]: new Set(['tool:vp:thread:session']) };
    const request = store.beginYeaftHistoryLoad({
      agentId: 'agent-b', sessionId: 'session-b', mode: 'recent', preserveLoaded: false,
    });
    store.handleMessage({
      type: 'yeaft_history_chunk',
      agentId: 'agent-b',
      conversationId: bridgeConversationId,
      sessionId: 'session-b',
      requestId: request.requestId,
      mode: 'recent',
      messages: [{ id: 'persisted-b', role: 'assistant', content: 'persisted B', sessionId: 'session-b', ts: 2 }],
      latestSeq: 1,
      hasMore: false,
    });

    expect(store.yeaftConversationId).toBe(bridgeConversationId);
    expect(store.messagesMap[bridgeConversationId]).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'pending-b' }),
      expect.objectContaining({ id: 'persisted-b' }),
    ]));
    expect(store.processingConversations).toEqual({ [bridgeConversationId]: true });
    expect(store.executionStatusMap[bridgeConversationId].currentTool).toEqual({ name: 'Bash' });
    expect(store.sessionHealth[bridgeConversationId]).toEqual({ status: 'agent-offline' });
    expect(store.refreshingSessionMap[bridgeConversationId]).toBe(true);
    expect(store._closedAt[bridgeConversationId]).toBe(1);
    expect(store._turnCompletedConvs.has(bridgeConversationId)).toBe(true);
    expect(store._processingWatchdogs[localConversationId]).toBeUndefined();
    expect(store._processingWatchdogs[bridgeConversationId]).toBeUndefined();
    expect(store._yeaftWatchdogPauseReasons[localConversationId]).toBeUndefined();
    expect([...store._yeaftWatchdogPauseReasons[bridgeConversationId]])
      .toEqual(['tool:vp:thread:session']);
    store.handleYeaftOutput({
      agentId: 'agent-b',
      conversationId: bridgeConversationId,
      sessionId: 'session-b',
      vpId: 'vp',
      threadId: 'thread',
      turnId: 'session',
      data: {
        type: 'user',
        tool_use_result: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }],
      },
    });
    expect(store._yeaftWatchdogPauseReasons[bridgeConversationId]).toBeUndefined();
    expect(store._processingWatchdogs[bridgeConversationId]).toBeTruthy();
    clearTimeout(store._processingWatchdogs[bridgeConversationId]);

    store.yeaftActiveTasksBySession = {
      'agent-a\u001fsession-a': {
        'task-a': { id: 'task-a', sessionId: 'session-a', agentId: 'agent-a', status: 'running' },
      },
    };
    store.handleYeaftOutput({
      agentId: 'agent-b',
      sessionId: 'session-b',
      event: {
        type: 'session_ready',
        conversationId: bridgeConversationId,
        sessionId: 'session-b',
        tasks: [{ id: 'task-b', sessionId: 'session-b', status: 'running' }],
      },
    });
    expect(store.yeaftActiveTasksBySession['agent-a\u001fsession-a']['task-a']).toEqual(expect.objectContaining({
      agentId: 'agent-a', status: 'running',
    }));
    expect(store.yeaftActiveTasksBySession['agent-b\u001fsession-b']['task-b']).toEqual(expect.objectContaining({
      agentId: 'agent-b', status: 'running',
    }));
    store.handleYeaftOutput({
      agentId: 'agent-b',
      sessionId: 'session-b',
      event: {
        type: 'yeaft_task_event',
        event: 'completed',
        task: { id: 'task-b', sessionId: 'session-b', kind: 'sub_agent', status: 'succeeded' },
      },
    });
    expect(store.yeaftActiveTasksBySession['agent-b\u001fsession-b']).toBeUndefined();
  });

  describe('correlated Session send rejections', () => {
    function setup() {
      storeFactories.clear();
      runtimeSessionsStore.sessionList = [
        { id: 'same', agentId: 'agent-a' },
        { id: 'other', agentId: 'agent-a' },
        { id: 'same', agentId: 'agent-b' },
      ];
      const store = useChatStore();
      store.sendWsMessage = vi.fn(() => true);
      store.currentView = 'yeaft';
      store.activeConversations = ['cli-current'];
      store.messagesMap = { 'cli-current': [] };
      store.processingConversations = { 'cli-current': true };
      store.yeaftConversationIdsByAgent = { 'agent-a': 'yeaft-a', 'agent-b': 'yeaft-b' };
      function send(agentId = 'agent-a', sessionId = 'same') {
        runtimeSessionsStore.setActive(sessionId, agentId);
        store.currentAgent = agentId;
        store.yeaftAgentId = agentId;
        store.yeaftActiveSessionFilter = sessionId;
        store.yeaftConversationId = store.yeaftConversationIdsByAgent[agentId];
        store.sendYeaftSessionMessage({
          groupId: sessionId, text: `Send to ${agentId}/${sessionId}`,
          attachments: [{ fileId: 'expired-upload', name: 'notes.txt' }],
        });
        return store.messagesMap[store.yeaftConversationId].at(-1);
      }
      const optimistic = send();
      const reject = (overrides = {}) => store.handleMessage({
        type: 'error', agentId: 'agent-a', sessionId: 'same', conversationId: null,
        clientMessageId: optimistic.clientMessageId,
        code: 'invalid_attachment', message: 'Session message was not sent: upload the files again.',
        ...overrides,
      });
      return { store, send, optimistic, reject };
    }

    function cleanup() {
      vi.clearAllTimers();
      vi.useRealTimers();
      storeFactories.clear();
      runtimeSessionsStore.sessionList = [];
      runtimeSessionsStore.setActive(null, null);
    }

    it.each([
      ['invalid_attachment', 'Session message was not sent: upload the files again.'],
      ['agent_access_denied', 'Agent access denied; Session message was not sent.'],
    ])('marks only the rejected optimistic send and clears its processing for %s', (code, message) => {
      vi.useFakeTimers();
      try {
        const { store, send, optimistic, reject } = setup();
        expect(store._processingWatchdogs['yeaft-a']).toBeTruthy();
        reject({ code, message });
        expect(optimistic).toMatchObject({ status: 'error', error: message });
        expect(optimistic.attachments).toEqual([expect.objectContaining({ fileId: 'expired-upload' })]);
        expect(store.yeaftProcessingSessions).toEqual({});
        expect(store.processingConversations).toEqual({ 'cli-current': true });
        expect(store._processingWatchdogs['yeaft-a']).toBeUndefined();
        expect(store.messagesMap['yeaft-a'].at(-1)).toMatchObject({
          type: 'error', content: message, agentId: 'agent-a', sessionId: 'same', turnId: optimistic.clientMessageId,
        });
        // Duplicate failures stay a single visible error after the old 5s
        // transient-error window, without changing the optimistic identity.
        reject({ code, message });
        vi.advanceTimersByTime(5001);
        expect(store.messagesMap['yeaft-a']).toHaveLength(2);
        expect(store.messagesMap['cli-current']).toEqual([]);
        const retry = send();
        reject({ code, message });
        expect(retry.status).toBeUndefined();
        expect(store.yeaftProcessingSessions['agent-a\u001fsame']).toBe(true);
        expect(store.processingConversations['yeaft-a']).toBe(true);
      } finally { cleanup(); }
    });

    it.each([['agent-a', 'other'], ['agent-b', 'same'], ['agent-a', 'same']])(
      'keeps %s/%s processing after switching or sending again', (agentId, sessionId) => {
        vi.useFakeTimers();
        try {
          const { store, send, optimistic, reject } = setup();
          const newer = send(agentId, sessionId);
          const visibleConversation = store.yeaftConversationId;
          const watchdog = store._processingWatchdogs[visibleConversation];
          const finish = vi.spyOn(store, 'finishStreamingForConversation');
          store.addMessageToConversation(visibleConversation, {
            type: 'assistant', sessionId, turnId: 'other-turn', content: 'Still running', isStreaming: true,
          });
          store._currentYeaftSessionId = sessionId;
          store._currentYeaftTurnId = 'other-turn';
          // Even a stale/foreign conversationId cannot override the owner tuple.
          reject({ conversationId: visibleConversation });
          expect(optimistic.status).toBe('error');
          expect(newer.status).toBeUndefined();
          expect(store.messagesMap['yeaft-a'].filter(row => row.type === 'error'))
            .toEqual([expect.objectContaining({ sessionId: 'same', turnId: optimistic.clientMessageId })]);
          expect(store.yeaftProcessingSessions[`${agentId}\u001f${sessionId}`]).toBe(true);
          if (agentId !== 'agent-a' || sessionId !== 'same') {
            expect(store.yeaftProcessingSessions['agent-a\u001fsame']).toBeUndefined();
          }
          expect(store.processingConversations[visibleConversation]).toBe(true);
          expect(store._processingWatchdogs[visibleConversation]).toBe(watchdog);
          expect(store.messagesMap[visibleConversation].find(row => row.type === 'assistant').isStreaming).toBe(true);
          expect(finish).not.toHaveBeenCalled();
          reject();
          expect(store.processingConversations[visibleConversation]).toBe(true);
          expect(store.messagesMap['cli-current']).toEqual([]);
        } finally { cleanup(); }
      },
    );

  });

  it('orders real optimistic sends before live replies and preserves order through history reconciliation', () => {
    storeFactories.clear();
    vi.useFakeTimers();
    const sentAt = Date.parse('2026-09-10T14:34:00Z');
    vi.setSystemTime(sentAt);
    runtimeSessionsStore.sessionList = [{ id: 'live-order', agentId: 'agent-a' }];
    runtimeSessionsStore.setActive('live-order', 'agent-a');
    const store = useChatStore();
    store.sendWsMessage = vi.fn(() => true);
    store.currentView = 'yeaft';
    store.currentAgent = 'agent-a';
    store.yeaftActiveSessionFilter = 'live-order';
    store.yeaftSessionAgentById = { 'live-order': 'agent-a' };
    store.yeaftConversationId = 'live-order-conversation';
    store.yeaftConversationIdsByAgent = { 'agent-a': 'live-order-conversation' };
    store.activeConversations = ['live-order-conversation'];
    const output = (id, text) => store.handleYeaftOutput({
      agentId: 'agent-a', conversationId: 'live-order-conversation', sessionId: 'live-order',
      vpId: 'omni', turnId: `turn-${id}`,
      data: { type: 'assistant', message: { id, content: text }, ts: Date.now() },
    });
    const rows = () => store.messagesMap['live-order-conversation'];
    try {
      // Do not seed timestamped fixtures: exercise the production send action.
      store.sendYeaftSessionMessage({ groupId: 'live-order', text: 'Please tag the merge' });
      const user = rows()[0];
      const uiKey = user.uiKey;
      vi.setSystemTime(sentAt + 1000);
      output('reply-one', 'I will verify main');
      output('reply-one', ' and push the tag');
      expect(rows().map(row => row.content)).toEqual([
        'Please tag the merge', 'I will verify main and push the tag',
      ]);
      expect(user.timestamp).toBe(sentAt);

      vi.setSystemTime(sentAt + 2000);
      store.sendYeaftSessionMessage({ groupId: 'live-order', text: 'Then check the workflow' });
      const secondUser = rows().at(-1);
      vi.setSystemTime(sentAt + 3000);
      output('reply-two', 'Checking the workflow');
      expect(rows().map(row => row.type)).toEqual(['user', 'assistant', 'user', 'assistant']);
      expect(secondUser.timestamp).toBe(sentAt + 2000);

      // A delayed persisted echo replaces the first optimistic identity/time,
      // keeps its UI key, and does not move either pending user row to the tail.
      const request = store.beginYeaftHistoryLoad({ agentId: 'agent-a', sessionId: 'live-order', mode: 'recent' });
      store.handleMessage({
        type: 'yeaft_history_chunk', agentId: 'agent-a', conversationId: 'live-order-conversation',
        sessionId: 'live-order', requestId: request.requestId, mode: 'recent',
        messages: [{
          id: 'm0001', seq: 1, role: 'user', content: user.content,
          clientMessageId: user.clientMessageId, sessionId: 'live-order', ts: sentAt + 100,
        }],
        oldestSeq: 1, latestSeq: 1, hasMore: false,
      });
      expect(rows()).toHaveLength(4);
      expect(rows()[0]).toMatchObject({ messageId: 'm0001', uiKey, timestamp: sentAt + 100 });
      expect(rows().map(row => row.type)).toEqual(['user', 'assistant', 'user', 'assistant']);
      expect(rows().at(-1).content).toBe('Checking the workflow');
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      storeFactories.clear();
      runtimeSessionsStore.sessionList = [];
      runtimeSessionsStore.setActive(null, null);
    }
  });

  it('keeps background Yeaft output routed while promoting the visible local conversation', () => {
    storeFactories.clear();
    runtimeSessionsStore.sessionList = [
      { id: 'visible-session', agentId: 'agent-a' },
      { id: 'background-session', agentId: 'agent-a' },
    ];
    runtimeSessionsStore.activeSessionId = 'visible-session';
    runtimeSessionsStore.activeAgentId = 'agent-a';

    const store = useChatStore();
    store.sendWsMessage = vi.fn(() => true);
    const localConversationId = 'yeaft-local-agent-a-cold';
    const bridgeConversationId = 'yeaft-agent-a-cold';
    const optimisticId = 'u_local_pending';
    store.currentView = 'yeaft';
    store.currentAgent = 'agent-a';
    store.yeaftActiveSessionFilter = 'visible-session';
    store.yeaftSessionAgentById = {
      'visible-session': 'agent-a',
      'background-session': 'agent-a',
    };
    store.yeaftConversationId = localConversationId;
    store.yeaftConversationIdsByAgent = { 'agent-a': localConversationId };
    store.activeConversations = [localConversationId];
    store.messagesMap = {
      [localConversationId]: [{
        id: optimisticId,
        messageId: optimisticId,
        clientMessageId: optimisticId,
        type: 'user',
        content: 'pending send',
        sessionId: 'visible-session',
        turnId: optimisticId,
        timestamp: 1,
      }],
    };
    store.processingConversations = { [localConversationId]: true };
    store.executionStatusMap = {
      [localConversationId]: {
        currentTool: { name: 'Bash' },
        toolHistory: [],
        lastActivity: 1,
      },
    };

    // A background Session can reveal the real bridge id first. This updates
    // the Agent transport cache but must leave the visible local source intact.
    store.handleYeaftOutput({
      agentId: 'agent-a',
      conversationId: bridgeConversationId,
      sessionId: 'background-session',
      data: {
        type: 'assistant',
        message: { id: 'background-row', content: 'background answer' },
      },
    });
    expect(store.yeaftConversationIdsByAgent['agent-a']).toBe(bridgeConversationId);
    expect(store.yeaftConversationId).toBe(localConversationId);
    expect(store._yeaftPendingConversationPromotions['agent-a']).toEqual({
      sourceConversationId: localConversationId,
      targetConversationId: bridgeConversationId,
    });

    // A visible live frame can be the next authoritative event; history is not
    // required to finalize the source cleanup and watchdog transfer.
    const liveSourceWatchdog = setTimeout(() => {}, 60_000);
    store._processingWatchdogs = { [localConversationId]: liveSourceWatchdog };
    store._yeaftWatchdogConvs = new Set([localConversationId]);
    store.handleYeaftOutput({
      agentId: 'agent-a',
      conversationId: bridgeConversationId,
      sessionId: 'visible-session',
      data: {
        type: 'text_delta',
        message: { id: 'visible-live-row' },
        text: 'visible live answer',
      },
    });
    expect(store.yeaftConversationId).toBe(bridgeConversationId);
    expect(store.messagesMap[localConversationId]).toBeUndefined();
    expect(store.processingConversations).toEqual({ [bridgeConversationId]: true });
    expect(store.executionStatusMap[localConversationId]).toBeUndefined();
    expect(store.executionStatusMap[bridgeConversationId].currentTool).toBeNull();
    expect(store._processingWatchdogs[localConversationId]).toBeUndefined();
    expect(store._processingWatchdogs[bridgeConversationId]).toBeTruthy();
    expect(store._yeaftWatchdogConvs.has(localConversationId)).toBe(false);
    expect(store._yeaftWatchdogConvs.has(bridgeConversationId)).toBe(true);
    expect(store._yeaftPendingConversationPromotions['agent-a']).toBeUndefined();
    clearTimeout(store._processingWatchdogs[bridgeConversationId]);

    storeFactories.clear();
  });

  it('fences retired conversation generations without losing terminal or persisted events', () => {
    storeFactories.clear();
    runtimeSessionsStore.sessionList = [
      { id: 'visible-session', agentId: 'agent-a' },
      { id: 'background-session', agentId: 'agent-a' },
    ];
    const store = useChatStore();
    store.sendWsMessage = vi.fn(() => true);
    // A newer bridge generation retargets the pending visible source and retires
    // the old target. Late data, session_ready, and history frames from that old
    // generation may not reclaim the Agent map or visible transcript.
    const generationSourceId = 'yeaft-local-agent-a-generation-source';
    const generationTargetOneId = 'yeaft-agent-a-generation-one';
    const generationTargetTwoId = 'yeaft-agent-a-generation-two';
    store.currentView = 'yeaft';
    store.currentAgent = 'agent-a';
    store.yeaftActiveSessionFilter = 'visible-session';
    runtimeSessionsStore.setActive('visible-session', 'agent-a');
    store.yeaftConversationId = generationSourceId;
    store.activeConversations = [generationSourceId];
    store.yeaftConversationIdsByAgent = { 'agent-a': generationSourceId };
    store.messagesMap = {
      ...store.messagesMap,
      [generationSourceId]: [{
        id: 'generation-source-row', type: 'user', content: 'pending generation', sessionId: 'visible-session', timestamp: 5,
      }],
    };
    store.processingConversations = { [generationSourceId]: true };
    store.executionStatusMap = {
      [generationSourceId]: { currentTool: { name: 'SourceTool' }, toolHistory: [], lastActivity: 5 },
    };
    store._processingWatchdogs = { [generationSourceId]: setTimeout(() => {}, 60_000) };
    store._yeaftWatchdogConvs = new Set([generationSourceId]);
    store._yeaftPendingConversationPromotions = {};
    store._yeaftRetiredConversationIdsByAgent = {};
    store.yeaftSessionHistoryState = {};

    store.handleYeaftOutput({
      agentId: 'agent-a',
      conversationId: generationTargetOneId,
      sessionId: 'background-session',
      data: { type: 'assistant', message: { id: 'generation-one-row', content: 'generation one' } },
    });
    expect(store._yeaftPendingConversationPromotions['agent-a']).toEqual({
      sourceConversationId: generationSourceId,
      targetConversationId: generationTargetOneId,
    });
    store.handleYeaftOutput({
      agentId: 'agent-a',
      sessionId: 'visible-session',
      event: {
        type: 'session_ready', conversationId: generationTargetTwoId, sessionId: 'visible-session', tasks: [],
      },
    });
    expect(store.yeaftConversationIdsByAgent['agent-a']).toBe(generationTargetTwoId);
    expect(store.yeaftConversationId).toBe(generationTargetTwoId);
    expect(store.activeConversations).toEqual([generationTargetTwoId]);
    expect(store._yeaftPendingConversationPromotions['agent-a']).toBeUndefined();
    expect(store.messagesMap[generationSourceId]).toBeUndefined();
    expect(store.messagesMap[generationTargetOneId]).toBeUndefined();
    expect(store.messagesMap[generationTargetTwoId]).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'generation-source-row' }),
      expect.objectContaining({ id: 'generation-one-row' }),
    ]));

    store.handleYeaftOutput({
      agentId: 'agent-a',
      conversationId: generationTargetOneId,
      sessionId: 'visible-session',
      data: { type: 'assistant', message: { id: 'late-generation-one-data', content: 'late old data' } },
    });
    expect(store.yeaftConversationIdsByAgent['agent-a']).toBe(generationTargetTwoId);
    expect(store.yeaftConversationId).toBe(generationTargetTwoId);
    expect(store.activeConversations).toEqual([generationTargetTwoId]);
    expect(store.messagesMap[generationTargetTwoId]).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'late-generation-one-data' }),
    ]));

    const generationTurnId = 'generation-turn';
    store.messagesMap[generationTargetTwoId].push({
      id: 'generation-pending-row',
      type: 'assistant',
      content: 'pending generation result',
      sessionId: 'visible-session',
      turnId: generationTurnId,
      isStreaming: true,
      status: 'pending',
      timestamp: 7,
    });
    store.processingConversations[generationTargetTwoId] = true;
    if (!store._processingWatchdogs[generationTargetTwoId]) {
      store._processingWatchdogs[generationTargetTwoId] = setTimeout(() => {}, 60_000);
    }
    store._yeaftWatchdogConvs.add(generationTargetTwoId);
    store.activeVpTurns = {
      'agent-a\u001fgeneration-turn': {
        agentId: 'agent-a', turnId: generationTurnId, vpId: 'omni', sessionId: 'visible-session', isStreaming: true,
      },
    };
    store.yeaftProcessingSessions = { 'agent-a\u001fvisible-session': true };
    store.handleYeaftOutput({
      agentId: 'agent-a',
      conversationId: generationTargetOneId,
      sessionId: 'visible-session',
      turnId: generationTurnId,
      vpId: 'omni',
      data: { type: 'result', subtype: 'success', result_text: '' },
    });
    const completedGenerationRow = store.messagesMap[generationTargetTwoId]
      .find(row => row.id === 'generation-pending-row');
    expect(completedGenerationRow).toEqual(expect.objectContaining({
      isStreaming: false,
      status: 'completed',
    }));
    expect(store.processingConversations[generationTargetTwoId]).toBeUndefined();
    expect(store._processingWatchdogs[generationTargetTwoId]).toBeUndefined();
    expect(store._yeaftWatchdogConvs.has(generationTargetTwoId)).toBe(false);
    expect(store.yeaftConversationIdsByAgent['agent-a']).toBe(generationTargetTwoId);
    expect(store.yeaftConversationId).toBe(generationTargetTwoId);
    expect(store.activeConversations).toEqual([generationTargetTwoId]);

    store.messagesMap[generationTargetTwoId].push({
      id: 'current-unrelated-row',
      type: 'assistant',
      content: 'still running current turn',
      sessionId: 'visible-session',
      turnId: 'current-unrelated-turn',
      isStreaming: true,
      status: 'pending',
      timestamp: 8,
    });
    store.processingConversations[generationTargetTwoId] = true;
    store.handleYeaftOutput({
      agentId: 'agent-a',
      conversationId: generationTargetOneId,
      sessionId: 'visible-session',
      turnId: 'retired-unrelated-turn',
      vpId: 'omni',
      data: { type: 'result', subtype: 'success', result_text: '' },
    });
    expect(store.messagesMap[generationTargetTwoId]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'current-unrelated-row', isStreaming: true, status: 'pending',
      }),
    ]));
    expect(store.processingConversations[generationTargetTwoId]).toBe(true);
    delete store.processingConversations[generationTargetTwoId];
    store.messagesMap[generationTargetTwoId] = store.messagesMap[generationTargetTwoId]
      .filter(row => row.id !== 'current-unrelated-row');

    store.handleYeaftOutput({
      agentId: 'agent-a',
      sessionId: 'visible-session',
      event: {
        type: 'session_ready', conversationId: generationTargetOneId, sessionId: 'visible-session', tasks: [],
      },
    });
    expect(store.yeaftConversationIdsByAgent['agent-a']).toBe(generationTargetTwoId);
    expect(store.yeaftConversationId).toBe(generationTargetTwoId);
    expect(store.activeConversations).toEqual([generationTargetTwoId]);

    store.handleYeaftOutput({
      agentId: 'agent-a',
      conversationId: generationTargetOneId,
      sessionId: 'visible-session',
      event: {
        type: 'vp_turn_end',
        turnId: 'generation-turn',
        vpId: 'omni',
        sessionId: 'visible-session',
        reason: 'end_turn',
      },
    });
    expect(store.activeVpTurns['agent-a\u001fgeneration-turn']).toBeUndefined();
    expect(store.yeaftProcessingSessions['agent-a\u001fvisible-session']).toBeUndefined();
    expect(store.yeaftConversationIdsByAgent['agent-a']).toBe(generationTargetTwoId);
    expect(store.yeaftConversationId).toBe(generationTargetTwoId);

    store.handleMessage({
      type: 'yeaft_history_chunk',
      agentId: 'agent-a',
      conversationId: generationTargetOneId,
      sessionId: 'visible-session',
      mode: 'delta',
      messages: [{
        id: 'late-generation-one-history', role: 'assistant', content: 'late old history', sessionId: 'visible-session', ts: 6,
      }],
      latestSeq: 6,
      hasMore: false,
    });
    expect(store.yeaftConversationIdsByAgent['agent-a']).toBe(generationTargetTwoId);
    expect(store.yeaftConversationId).toBe(generationTargetTwoId);
    expect(store.activeConversations).toEqual([generationTargetTwoId]);
    expect(store.messagesMap[generationTargetTwoId]).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'late-generation-one-history' }),
    ]));
    clearTimeout(store._processingWatchdogs[generationTargetTwoId]);

    storeFactories.clear();
  });
});

describe('stable Session sidebar layout', () => {
  it('mounts the final navigation while loading and fills it without remounting', async () => {
    vi.stubGlobal('Vue', Vue);
    localStorage.removeItem('yeaft-sidebar-section-collapse');
    const sidebar = mount(UnifiedSessionList, {
      attachTo: document.body,
      props: { loading: true },
      global: { mocks: { $t: key => key } },
    });
    try {
      const navigation = sidebar.get('.sidebar-navigation').element;
      const headings = sidebar.findAll('.sidebar-section-heading').map(node => node.element);
      expect(sidebar.get('.sidebar-navigation').attributes('aria-busy')).toBe('true');
      expect(sidebar.findAll('.sidebar-catalog-loading')).toHaveLength(2);
      expect(sidebar.get('.sidebar-primary-action').attributes('disabled')).toBeDefined();
      sidebar.vm.createSession();
      sidebar.vm.createProject();
      expect(sidebar.emitted('create')).toBeUndefined();
      expect(sidebar.vm.projectCreateOpen).toBe(false);
      const row = {
        catalogKey: 'yeaft:agent-a:ready', runtimeProvider: 'yeaft',
        routeRef: { runtimeProvider: 'yeaft', agentId: 'agent-a', sessionId: 'ready' },
        title: 'Ready session', availability: 'online',
      };
      await sidebar.setProps({ sessions: [row], agents: [{ id: 'agent-a', online: true }] });
      await sidebar.get('.session-item').trigger('click');
      sidebar.vm.toggleSessionMenu(row, false);
      expect(sidebar.emitted('select')).toBeUndefined();
      expect(sidebar.vm.floatingMenu).toBeNull();
      expect(sidebar.get('.session-item').attributes('tabindex')).toBe('-1');
      await sidebar.setProps({ loading: false });
      expect(sidebar.get('.sidebar-navigation').element).toBe(navigation);
      expect(sidebar.findAll('.sidebar-section-heading').map(node => node.element)).toEqual(headings);
      expect(sidebar.findAll('.sidebar-catalog-loading')).toHaveLength(0);
      await sidebar.get('.session-item').trigger('click');
      expect(sidebar.emitted('select')).toEqual([[row]]);
      await sidebar.get('.session-dots-btn').trigger('click');
      expect(sidebar.vm.floatingMenu).not.toBeNull();
      await sidebar.setProps({ loading: true });
      expect(sidebar.vm.floatingMenu).toBeNull();
    } finally {
      sidebar.unmount();
      vi.unstubAllGlobals();
    }
  });
});
