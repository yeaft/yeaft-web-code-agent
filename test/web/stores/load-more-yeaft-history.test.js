import { describe, it, expect, vi } from 'vitest';

// `conversationHandler.js` transitively imports `web/stores/auth.js`,
// which does `const { defineStore } = Pinia;` against a global Pinia
// (loaded before the browser modules). Shim it for Node-side tests.
const storeOptions = {};
globalThis.Pinia = {
  defineStore: (id, options) => { storeOptions[id] = options; return () => ({}); },
};

const { handleYeaftHistoryChunk } = await import('../../../web/stores/helpers/handlers/conversationHandler.js');
const { yeaftHistoryIdentityKey } = await import('../../../web/stores/helpers/yeaft-history-identity.js');

const { beginYeaftHistoryLoad, finishYeaftHistoryLoad, isCurrentYeaftHistoryResponse, syncActiveYeaftHistoryLoad } = await import('../../../web/stores/helpers/yeaft-history-load.js');

const { conversationRepositoryFor } = await import('../../../web/stores/helpers/conversation-repository.js');

function mkStore(overrides = {}) {
  const sent = [];
  const store = {
    currentView: 'yeaft',
    yeaftConversationId: 'yeaft-1',
    currentAgent: 'agent-1',
    yeaftHasMoreHistory: true,
    yeaftLoadingMoreHistory: false,
    yeaftOldestLoadedSeq: 100,
    yeaftSessionHistoryState: {},
    yeaftMessageWindowState: {},
    messagesMap: {},
    continueYeaftHistoryDelta: vi.fn(() => true),
    clearYeaftHistoryMemory: vi.fn(),
    sendWsMessage(msg) { sent.push(msg); },
    _sent: sent,
    ...overrides,
  };
  store.conversationRepository = conversationRepositoryFor(store);
  return store;
}

describe('Conversation Repository', () => {
  it('reconciles optimistic and streaming overlays when persisted history arrives', () => {
    const store = mkStore({ messagesMap: { 'yeaft-1': [] } });
    const repository = store.conversationRepository;
    repository.upsertOverlay({
      conversationId: 'yeaft-1', agentId: 'agent-1', sessionId: 'session-a',
      row: { id: 'client-1', messageId: 'client-1', clientMessageId: 'client-1', stableKey: 'optimistic:client-1', type: 'user', content: 'hello', sessionId: 'session-a' },
    });
    repository.upsertOverlay({
      conversationId: 'yeaft-1', agentId: 'agent-1', sessionId: 'session-a',
      row: { id: 'live-a', messageId: 'live-a', type: 'assistant', content: 'partial', sessionId: 'session-a', turnId: 'turn-1', isStreaming: true, status: 'pending' },
    });

    repository.commitDurable({
      conversationId: 'yeaft-1', agentId: 'agent-1', sessionId: 'session-a', mode: 'delta',
      rows: [
        { id: 'm0010', messageId: 'm0010', clientMessageId: 'client-1', stableKey: 'durable:m0010', seq: 10, type: 'user', content: 'hello', sessionId: 'session-a', turnId: 'turn-1', isHistory: true },
        { id: 'm0011', messageId: 'm0011', stableKey: 'durable:m0011', seq: 11, type: 'assistant', content: 'partial complete', sessionId: 'session-a', turnId: 'turn-1', _hasPersistedTurnId: true, isHistory: true },
      ],
    });

    expect(store.messagesMap['yeaft-1']).toHaveLength(2);
    expect(store.messagesMap['yeaft-1']).toEqual([
      expect.objectContaining({ id: 'm0010', clientMessageId: 'client-1' }),
      expect.objectContaining({ id: 'm0011', content: 'partial complete', isStreaming: false }),
    ]);
    expect(repository.snapshot('yeaft-1', 'session-a').overlayRows).toEqual([]);

    // A later durable assistant response must not jump above its still-local
    // user prompt, nor above earlier streaming text or tools from this turn.
    repository.replaceProjection('yeaft-1', []);
    const liveRows = [
      { id: 'client-2', messageId: 'client-2', clientMessageId: 'client-2', type: 'user', content: 'question', timestamp: 100 },
      { id: 'live-2', type: 'assistant', content: 'working', turnId: 'turn-2', timestamp: 200, isStreaming: true },
      { id: 'tool-2', type: 'tool-use', toolName: 'Bash', timestamp: 200 },
    ].map(row => ({ ...row, sessionId: 'session-a' }));
    for (const row of liveRows) repository.upsertOverlay({ conversationId: 'yeaft-1', row });
    const projection = store.messagesMap['yeaft-1'];
    repository.commitDurable({
      conversationId: 'yeaft-1', sessionId: 'session-a', mode: 'delta',
      rows: [{ id: 'm0022', seq: 22, type: 'assistant', content: 'later response', timestamp: 300, sessionId: 'session-a', isHistory: true }],
    });
    expect(projection.map(row => row.id)).toEqual(['client-2', 'live-2', 'tool-2', 'm0022']);
    repository.appendOverlayText({ conversationId: 'yeaft-1', sessionId: 'session-a', turnId: 'turn-2', text: ' still' });
    expect(projection[1].content).toBe('working still');
    expect(projection[1].timestamp).toBe(200);
    repository.commitDurable({
      conversationId: 'yeaft-1', sessionId: 'session-a', mode: 'delta',
      rows: [{ id: 'm0020', messageId: 'm0020', seq: 20, clientMessageId: 'client-2', type: 'user', content: 'question', timestamp: 100, sessionId: 'session-a', isHistory: true }],
    });
    expect(store.messagesMap['yeaft-1']).toBe(projection);
    expect(projection.map(row => row.id)).toEqual(['m0020', 'live-2', 'tool-2', 'm0022']);

    // Out-of-order live arrivals also sort by time; equal-time sibling rows
    // remain stable instead of changing position on each projection rebuild.
    repository.upsertOverlay({ conversationId: 'yeaft-1', row: { id: 'late-arrival', type: 'assistant', timestamp: 150, isStreaming: true } });
    repository.replaceProjection('yeaft-1', [...projection]);
    expect(projection.map(row => row.id)).toEqual(['m0020', 'late-arrival', 'live-2', 'tool-2', 'm0022']);
    repository.upsertOverlay({ conversationId: 'yeaft-1', row: { id: '999-local', type: 'user', timestamp: 400 } });
    repository.upsertOverlay({ conversationId: 'yeaft-1', row: { id: '100-local', type: 'user', timestamp: 400 } });
    expect(projection.slice(-2).map(row => row.id)).toEqual(['999-local', '100-local']);
    repository.commitDurable({
      conversationId: 'yeaft-1', sessionId: 'session-a', mode: 'delta',
      rows: [{ id: 'live-2', seq: 21, type: 'assistant', content: 'working still', timestamp: 200, sessionId: 'session-a', isHistory: true, isStreaming: false }],
    });
    expect(projection.filter(row => row.timestamp === 200).map(row => row.id)).toEqual(['live-2', 'tool-2']);

    // Same-millisecond page boundaries and out-of-order deltas still follow
    // transcript seq. Tools follow their preceding text, not a durable slot.
    for (const mode of ['older', 'delta']) {
      repository.replaceProjection('yeaft-1', []);
      const durable = (seq, type = 'assistant', sessionId = 'session-a') => ({
        id: `${sessionId}-m${seq}`, seq, type, content: `row ${seq}`,
        timestamp: 500, sessionId, isHistory: true,
      });
      repository.upsertOverlay({ conversationId: 'yeaft-1', row: {
        id: 'optimistic', type: 'user', timestamp: 500, sessionId: 'session-a',
      } });
      repository.commitDurable({ conversationId: 'yeaft-1', mode: 'recent', rows: [durable(21)] });
      repository.commitDurable({ conversationId: 'yeaft-1', rows: [durable(1, 'user', 'session-b')] });
      repository.upsertOverlay({ conversationId: 'yeaft-1', row: {
        id: 'tool', type: 'tool-use', timestamp: 500, sessionId: 'session-a',
      } });
      repository.commitDurable({ conversationId: 'yeaft-1', mode, rows: [durable(20, 'user')] });
      const sessionRows = () => projection.filter(row => row.sessionId === 'session-a');
      expect(sessionRows().map(row => row.id)).toEqual(['optimistic', 'session-a-m20', 'session-a-m21', 'tool']);
      repository.commitDurable({ conversationId: 'yeaft-1', mode, rows: [durable(23), durable(22)] });
      expect(sessionRows().map(row => row.id)).toEqual([
        'optimistic', 'session-a-m20', 'session-a-m21', 'tool', 'session-a-m22', 'session-a-m23',
      ]);
      // Another Session must not sever the text/tool association. Rebuilding
      // the projection preserves object references as well as ordering.
      const expected = projection.map(row => row.id);
      const references = [...projection];
      for (let repeat = 0; repeat < 3; repeat += 1) {
        repository.replaceProjection('yeaft-1', [...projection]);
        expect(projection.map(row => row.id)).toEqual(expected);
        projection.forEach((row, index) => expect(row).toBe(references[index]));
      }
    }
  });
});

describe('Yeaft conversation loading state', () => {
  it('keeps older durable pages when a bounded recent replay refreshes the tail', () => {
    const store = mkStore({
      yeaftActiveSessionFilter: 'g1',
      messagesMap: {
        'yeaft-1': [
          { id: 'm0001', messageId: 'm0001', seq: 1, type: 'user', content: 'older q', sessionId: 'g1', isHistory: true, timestamp: 1 },
          { id: 'm0002', messageId: 'm0002', seq: 2, type: 'assistant', content: 'older a', sessionId: 'g1', isHistory: true, timestamp: 2 },
          { id: 'm0100', messageId: 'm0100', seq: 100, type: 'user', content: 'cached recent q', sessionId: 'g1', isHistory: true, timestamp: 100 },
        ],
      },
    });

    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'g1',
      mode: 'recent',
      messages: [
        { id: 'm0100', role: 'user', content: 'fresh recent q', sessionId: 'g1', ts: 100 },
        { id: 'm0101', role: 'assistant', content: 'fresh recent a', sessionId: 'g1', ts: 101 },
      ],
      oldestSeq: 100,
      latestSeq: 101,
      hasMore: true,
    });

    expect(store.messagesMap['yeaft-1'].map(row => row.id)).toEqual([
      'm0001', 'm0002', 'm0100', 'm0101',
    ]);
    expect(store.messagesMap['yeaft-1'].find(row => row.id === 'm0100')?.content).toBe('fresh recent q');
  });

  it.each(['stream', 'revision'])('commits a correlated %s replacement and still rejects stale replies', async (change) => {
    await import('../../../web/stores/chat.js');
    const { clearYeaftHistoryMemory } = storeOptions.chat.actions;
    const sessionKey = yeaftHistoryIdentityKey('agent-1', 'g1');
    const store = mkStore({
      yeaftActiveSessionFilter: 'g1',
      yeaftConversationIdsByAgent: { 'agent-1': 'yeaft-1' },
      yeaftSessionAgentById: { g1: 'agent-1' },
      yeaftSessionHistoryState: {
        [sessionKey]: { loaded: true, latestSeq: 90, streamId: 'old', revision: 4 },
      },
      messagesMap: { 'yeaft-1': [
        { id: 'm0090', type: 'assistant', content: 'stale', sessionId: 'g1', isHistory: true },
        { id: 'live', type: 'assistant', content: 'live', sessionId: 'g1', isStreaming: true },
      ] },
      clearYeaftHistoryMemory,
      syncActiveYeaftHistoryLoad() { return syncActiveYeaftHistoryLoad(this); },
      isCurrentYeaftHistoryResponse(msg) { return isCurrentYeaftHistoryResponse(this, msg); },
      finishYeaftHistoryLoad(msg, patch, frame) { return finishYeaftHistoryLoad(this, msg, patch, frame); },
    });
    const stale = beginYeaftHistoryLoad(store, { agentId: 'agent-1', sessionId: 'g1', mode: 'delta' });
    const request = beginYeaftHistoryLoad(store, { agentId: 'agent-1', sessionId: 'g1', mode: 'delta' });
    const reply = {
      agentId: 'agent-1', conversationId: 'yeaft-1', sessionId: 'g1',
      requestId: request.requestId, mode: 'delta',
      streamId: change === 'stream' ? 'new' : 'old', revision: change === 'stream' ? 0 : 5,
      oldestSeq: 1, nextBeforeSeq: 1, latestSeq: 2, hasMore: true,
      messages: [{ id: 'm0002', role: 'assistant', content: 'replacement', sessionId: 'g1' }],
    };
    // A completion arriving first must not retire the correlated chunk fence.
    store.finishYeaftHistoryLoad(reply, { latestSeq: 999 }, 'completion');
    handleYeaftHistoryChunk(store, { ...reply, requestId: stale.requestId });
    expect(store.messagesMap['yeaft-1'].map(row => row.content)).toEqual(['stale', 'live']);
    handleYeaftHistoryChunk(store, reply);
    expect(store.yeaftSessionHistoryState[sessionKey]).toMatchObject({
      loaded: true, loading: false, requestId: null, generation: request.generation,
      streamId: reply.streamId, revision: reply.revision, latestSeq: 2,
      serverOldestFetchedSeq: 1, serverHasMore: true, hasMore: true,
    });
    expect(store.yeaftLoadingMoreHistory).toBe(false);
    expect(store.yeaftOldestLoadedSeq).toBe(1);
    expect(store.messagesMap['yeaft-1'].map(row => row.content)).toEqual(['replacement', 'live']);
    expect(store.yeaftSessionAgentById.g1).toBe('agent-1');
    expect(store.finishYeaftHistoryLoad(reply, { latestSeq: 999 }, 'completion')).toBeNull();
    handleYeaftHistoryChunk(store, { ...reply, requestId: stale.requestId, messages: [] });
    expect(store.yeaftSessionHistoryState[sessionKey].latestSeq).toBe(2);
  });

  it('keeps optimistic sends visible when a recent history reply races them', () => {
    const store = mkStore({
      yeaftActiveSessionFilter: 'g1',
      messagesMap: {
        'yeaft-1': [
          {
            id: 'u_local_race',
            messageId: 'u_local_race',
            clientMessageId: 'u_local_race',
            type: 'user',
            content: 'send while history is loading',
            sessionId: 'g1',
            turnId: 'u_local_race',
            timestamp: new Date('2026-05-01T09:59:59.000Z').getTime(),
          },
        ],
      },
    });

    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'g1',
      mode: 'recent',
      messages: [
        { id: 'm0200', role: 'user', content: 'persisted q', sessionId: 'g1', ts: '2026-05-01T10:00:00.000Z' },
        { id: 'm0201', role: 'assistant', content: 'persisted a', sessionId: 'g1', ts: '2026-05-01T10:00:01.000Z' },
      ],
      oldestSeq: 200,
      latestSeq: 201,
      hasMore: false,
    });

    const rows = store.messagesMap['yeaft-1'].filter(m => m.sessionId === 'g1');
    expect(rows.map(m => m.id)).toEqual(['u_local_race', 'm0200', 'm0201']);
    expect(rows.find(m => m.id === 'u_local_race')).toEqual(expect.objectContaining({
      clientMessageId: 'u_local_race',
      content: 'send while history is loading',
    }));
    expect(store.yeaftLoadingMoreHistory).toBe(false);
  });

  it('restores a persisted AskUser answer as a read-only card', () => {
    const store = mkStore({
      yeaftActiveSessionFilter: 'g1',
      messagesMap: { 'yeaft-1': [] },
    });

    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'g1',
      mode: 'recent',
      messages: [{
        id: 'm0210',
        role: 'assistant',
        content: '',
        sessionId: 'g1',
        threadId: 'thread-a',
        turnId: 'turn-a',
        speakerVpId: 'vp-a',
        askUserResults: [{
          toolCallId: 'ask_1',
          status: 'answered',
          question: 'Continue?',
          options: ['Yes', 'No'],
          answers: { 'Continue?': 'Yes' },
        }],
        ts: '2026-05-01T10:00:00.000Z',
      }],
      oldestSeq: 210,
      latestSeq: 211,
      hasMore: false,
    });

    expect(store.messagesMap['yeaft-1']).toEqual([
      expect.objectContaining({
        id: 'm0210:ask:ask_1',
        type: 'tool-use',
        toolId: 'ask_1',
        toolName: 'AskUserQuestion',
        askRequestId: null,
        askAnswered: true,
        selectedAnswers: { 'Continue?': 'Yes' },
        isHistory: true,
        hasResult: true,
        sessionId: 'g1',
        vpId: 'vp-a',
        turnId: 'turn-a',
        threadId: 'thread-a',
      }),
    ]);
  });

  it('appends delta chunks without clobbering older-history cursors', () => {
    const store = mkStore({
      yeaftActiveSessionFilter: 'g1',
      yeaftHasMoreHistory: true,
      yeaftOldestLoadedSeq: 50,
      yeaftSessionHistoryState: {
        g1: { loaded: true, loading: false, hasMore: true, oldestSeq: 50, latestSeq: 100, count: 2 },
      },
      messagesMap: { 'yeaft-1': [{ id: 'm0100', type: 'user', content: 'cached', sessionId: 'g1', timestamp: 100 }] },
    });

    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'g1',
      mode: 'delta',
      messages: [{ id: 'm0101', role: 'assistant', content: 'new', sessionId: 'g1', ts: 101 }],
      latestSeq: 101,
      hasMore: false,
      oldestSeq: null,
    });

    expect(store.messagesMap['yeaft-1'].map(m => m.id)).toEqual(['m0100', 'm0101']);
    expect(store.yeaftSessionHistoryState.g1).toEqual(expect.objectContaining({
      hasMore: true,
      oldestSeq: 50,
      latestSeq: 101,
      count: 3,
    }));
    expect(store.yeaftHasMoreHistory).toBe(true);
    expect(store.yeaftOldestLoadedSeq).toBe(50);
    expect(store.yeaftLoadingMoreHistory).toBe(false);
  });

  it('requests scoped older pages and retries a failed send with a fresh generation', async () => {
    await import('../../../web/stores/chat.js');
    const sessionKey = yeaftHistoryIdentityKey('agent-b', 'shared-session');
    const sent = [];
    let connected = true;
    const store = mkStore({
      currentAgent: 'agent-a',
      yeaftActiveSessionFilter: 'shared-session',
      yeaftSessionHistoryState: {
        [sessionKey]: { loaded: true, hasMore: true, oldestSeq: 50, latestSeq: 100 },
      },
      yeaftHistoryCacheState: { [sessionKey]: { ranges: [{ startSeq: 50, endSeq: 100 }], rangeEpoch: 2 } },
      beginYeaftHistoryLoad(options) { return beginYeaftHistoryLoad(this, options); },
      syncActiveYeaftHistoryLoad() { return syncActiveYeaftHistoryLoad(this); },
      sendWsMessage(message) { sent.push(message); return connected; },
    });
    const load = (turns) => storeOptions.chat.actions.loadMoreYeaftHistory.call(store, turns, {
      agentId: 'agent-b', sessionId: 'shared-session',
    });
    expect(load(500)).toBe(true);
    expect(sent[0]).toMatchObject({
      type: 'yeaft_load_more_history', agentId: 'agent-b', sessionId: 'shared-session',
      beforeSeq: 50, pageKind: 'server', cacheEpoch: 2, turns: 50,
    });
    expect(load(10)).toBe(false);
    expect(sent).toHaveLength(1);
    finishYeaftHistoryLoad(store, sent[0], { oldestSeq: 30, hasMore: true });
    store.yeaftSessionHistoryState[sessionKey].serverOldestFetchedSeq = 30;
    connected = false;
    expect(load(10)).toBe(false);
    expect(store.yeaftSessionHistoryState[sessionKey]).toMatchObject({
      loading: false, error: 'history_load_send_failed', hasMore: true,
    });
    connected = true;
    expect(load(10)).toBe(true);
    expect(sent[2]).toMatchObject({ beforeSeq: 30, turns: 10, agentId: 'agent-b' });
    expect(sent[2].requestId).not.toBe(sent[1].requestId);
    expect(isCurrentYeaftHistoryResponse(store, sent[1])).toBe(false);
    expect(isCurrentYeaftHistoryResponse(store, sent[2])).toBe(true);
    expect(store.yeaftSessionHistoryState[yeaftHistoryIdentityKey('agent-a', 'shared-session')]).toBeUndefined();
  });

  it('keeps chronological order and dedupes rows when older session history overlaps cached rows', async () => {
    const store = mkStore({
      yeaftActiveSessionFilter: 'session-A',
      messagesMap: {
        'yeaft-1': [
          { id: 'm0003', messageId: 'm0003', type: 'user', content: 'newer-q', sessionId: 'session-A' },
          { id: 'm0004', messageId: 'm0004', type: 'assistant', content: 'newer-a', sessionId: 'session-A', speakerVpId: 'vp-ada' },
        ],
      },
    });

    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'session-A',
      messages: [
        { id: 'm0001', role: 'user', content: 'oldest-q', sessionId: 'session-A' },
        { id: 'm0002', role: 'assistant', content: 'oldest-a', sessionId: 'session-A', speakerVpId: 'vp-linus' },
        { id: 'm0003', role: 'user', content: 'newer-q', sessionId: 'session-A' },
      ],
      oldestSeq: 1,
      hasMore: false,
    });

    expect(store.messagesMap['yeaft-1'].map(m => m.id)).toEqual(['m0001', 'm0002', 'm0003', 'm0004']);
    expect(store.messagesMap['yeaft-1'].map(m => m.content)).toEqual(['oldest-q', 'oldest-a', 'newer-q', 'newer-a']);

    // A later delta re-sorts the complete cache. It must not undo the older
    // prepend or move the optimistic tail into persisted history.
    store.messagesMap['yeaft-1'].push({
      id: 'optimistic-tail',
      messageId: 'optimistic-tail',
      clientMessageId: 'optimistic-tail',
      type: 'user',
      content: 'optimistic-tail',
      sessionId: 'session-A',
      timestamp: 1,
    });
    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'session-A',
      mode: 'delta',
      messages: [
        { id: 'm0005', role: 'assistant', content: 'delta-a', sessionId: 'session-A', speakerVpId: 'vp-ada' },
      ],
      latestSeq: 5,
      hasMore: false,
    });
    expect(store.messagesMap['yeaft-1'].map(m => m.id)).toEqual([
      'm0001',
      'm0002',
      'm0003',
      'm0004',
      'm0005',
      'optimistic-tail',
    ]);
  });

  it('drops reflected/system-like rows even if they arrive with role=user', () => {
    const store = mkStore({ messagesMap: { 'yeaft-1': [] } });
    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'g1',
      messages: [
        { id: 'm0001', role: 'user', content: 'visible user', sessionId: 'g1' },
        { id: 'm0002', role: 'user', content: 'reflection text', sessionId: 'g1', _reflection: true },
        { id: 'm0003', role: 'assistant', content: 'system-only note', sessionId: 'g1', systemOnly: true },
        { id: 'm0004', role: 'assistant', content: 'visible assistant', sessionId: 'g1', speakerVpId: 'vp-linus' },
      ],
      oldestSeq: 1,
      hasMore: false,
    });

    expect(store.messagesMap['yeaft-1'].map(m => m.content)).toEqual(['visible user', 'visible assistant']);
    expect(store.messagesMap['yeaft-1'][1]).toEqual(expect.objectContaining({ type: 'assistant', speakerVpId: 'vp-linus' }));
  });

  it('keeps the active Agent cursor intact when a same-id Session chunk arrives late from another Agent', () => {
    const sessionId = 'session_default';
    const agentAKey = yeaftHistoryIdentityKey('agent-a', sessionId);
    const agentBKey = yeaftHistoryIdentityKey('agent-b', sessionId);
    const store = mkStore({
      currentAgent: 'agent-b',
      yeaftActiveSessionFilter: sessionId,
      yeaftConversationId: 'conv-b',
      yeaftConversationIdsByAgent: { 'agent-a': 'conv-a', 'agent-b': 'conv-b' },
      yeaftLoadingMoreHistory: true,
      yeaftHasMoreHistory: true,
      yeaftOldestLoadedSeq: 10,
      yeaftSessionHistoryState: {
        [agentAKey]: { loaded: true, loading: true, latestSeq: 7, hasMore: true, oldestSeq: 3 },
        [agentBKey]: { loaded: true, loading: true, latestSeq: 20, hasMore: true, oldestSeq: 10 },
      },
      messagesMap: { 'conv-a': [], 'conv-b': [{ type: 'user', content: 'B', sessionId }] },
    });

    handleYeaftHistoryChunk(store, {
      type: 'yeaft_history_chunk',
      agentId: 'agent-a',
      conversationId: 'conv-a',
      sessionId,
      mode: 'recent',
      messages: [{ id: '000001-a', role: 'user', content: 'A', sessionId }],
      latestSeq: 1,
      oldestSeq: 1,
      hasMore: false,
    });

    expect(store.messagesMap['conv-a']).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: 'A', sessionId }),
    ]));
    expect(store.messagesMap['conv-b']).toEqual([expect.objectContaining({ content: 'B' })]);
    expect(store.yeaftConversationId).toBe('conv-b');
    expect(store.yeaftConversationIdsByAgent).toEqual({ 'agent-a': 'conv-a', 'agent-b': 'conv-b' });

    expect(store.yeaftSessionHistoryState[agentAKey]).toEqual(expect.objectContaining({
      loading: false, latestSeq: 1, hasMore: false, oldestSeq: 1,
    }));
    expect(store.yeaftSessionHistoryState[agentBKey]).toEqual({
      loaded: true, loading: true, latestSeq: 20, hasMore: true, oldestSeq: 10,
    });
    expect(store.yeaftHasMoreHistory).toBe(true);
    expect(store.yeaftOldestLoadedSeq).toBe(10);
    expect(store.yeaftLoadingMoreHistory).toBe(true);

    handleYeaftHistoryChunk(store, {
      type: 'yeaft_history_chunk',
      agentId: 'agent-b',
      conversationId: 'conv-b-replacement',
      sessionId,
      mode: 'delta',
      messages: [{ id: '000021-b', role: 'assistant', content: 'replacement', sessionId }],
      latestSeq: 21,
      hasMore: false,
    });
    expect(store.yeaftConversationId).toBe('conv-b');
    expect(store.activeConversations || []).not.toContain('conv-b-replacement');
    expect(store.messagesMap['conv-b']).toEqual([expect.objectContaining({ content: 'B' })]);
    expect(store.messagesMap['conv-b-replacement']).toEqual([
      expect.objectContaining({ content: 'replacement', sessionId }),
    ]);
  });
});
