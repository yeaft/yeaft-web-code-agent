// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

const options = {};
const auth = { userId: 'owner', authGeneration: 1 };
globalThis.Pinia = {
  defineStore: (id, definition) => { options[id] = definition; return () => id === 'auth' ? auth : null; },
};

await import('../../../web/stores/chat.js');
const {
  YEAFT_RETRY_TURN_TIMEOUT_MS,
  invalidateOfflineYeaftTurnRetries,
  visibleYeaftRetryableTurns,
} = await import('../../../web/stores/helpers/yeaft-turn-retry.js');

function setup() {
  vi.useFakeTimers();
  const store = {
    ...options.chat.state(),
    ...options.chat.actions,
    currentView: 'yeaft',
    currentAgent: 'agent-a',
    yeaftActiveSessionFilter: 'sess-1',
    yeaftConversationId: 'conv-a',
    yeaftConversationIdsByAgent: { 'agent-a': 'conv-a', 'agent-b': 'conv-b' },
    agents: [
      { id: 'agent-a', online: true },
      { id: 'agent-b', online: true },
    ],
    connectionState: 'connected',
    chatHistoryConnectionGeneration: 1,
    messagesMap: { 'conv-a': [], 'conv-b': [] },
    sendWsMessage: vi.fn(() => true),
  };
  for (const [name, getter] of Object.entries(options.chat.getters)) {
    Object.defineProperty(store, name, { get: () => getter.call(store, store), configurable: true });
  }
  return store;
}

const yeaftRoute = (agentId = 'agent-a', sessionId = 'sess-1') => ({
  runtimeProvider: 'yeaft',
  agentId,
  sessionId,
});

function emitError(store, overrides = {}) {
  store.handleYeaftOutput({
    type: 'yeaft_output',
    agentId: 'agent-a',
    conversationId: 'conv-a',
    sessionId: 'sess-1',
    vpId: 'vp-1',
    turnId: 'turn-1',
    ...overrides,
    event: {
      type: 'error',
      message: 'Provider stream interrupted',
      retryTurnId: 'turn-1',
      retryToken: 'tok-1',
      ...(overrides.event || {}),
    },
  });
}

function emitSessionTurns(store, retryableTurns, overrides = {}) {
  const sessionId = overrides.sessionId || 'sess-1';
  store.handleYeaftOutput({
    type: 'yeaft_output',
    agentId: 'agent-a',
    conversationId: 'conv-a',
    sessionId,
    ...overrides,
    event: {
      type: 'session_turns',
      sessionId,
      turns: overrides.turns || [],
      retryableTurns,
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('yeaft failed turn retry store flow', () => {
  it('drives buttons from authoritative session_turns snapshot, merges error metadata by retryToken, and hides controls for other providers', () => {
    const store = setup();
    // Unknown failure without retryTurnId / retryToken never shows controls.
    emitError(store, { event: { retryTurnId: undefined, retryToken: undefined, message: 'Unknown failure' } });
    expect(visibleYeaftRetryableTurns(store, yeaftRoute())).toEqual([]);

    // Error event before final terminal/driver transition caches metadata but does NOT expose buttons yet.
    emitError(store, { event: { retryTurnId: 'turn-1', retryToken: 'tok-1', message: 'Upstream 503' } });
    expect(visibleYeaftRetryableTurns(store, yeaftRoute())).toEqual([]);

    // Authoritative session_turns snapshot confirms readiness and merges matching retryToken metadata.
    emitSessionTurns(store, [{ turnId: 'turn-1', vpId: 'vp-1', threadId: 'main', retryToken: 'tok-1' }]);
    const visible = visibleYeaftRetryableTurns(store, yeaftRoute());
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({
      agentId: 'agent-a',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      retryToken: 'tok-1',
      ready: true,
      vpId: 'vp-1',
      threadId: 'main',
      message: 'Upstream 503',
      pending: false,
    });

    // Other providers never expose retry controls.
    expect(visibleYeaftRetryableTurns(store, { runtimeProvider: 'claude-code', agentId: 'agent-a', sessionId: 'sess-1' })).toEqual([]);
    expect(visibleYeaftRetryableTurns(store, { runtimeProvider: 'copilot', agentId: 'agent-a', sessionId: 'sess-1' })).toEqual([]);
  });

  it('sends yeaft_session_retry echoing retryToken without chat send, history query, or fake bubbles and fences stale tokens', async () => {
    const store = setup();
    emitError(store, { event: { retryTurnId: 'turn-1', retryToken: 'tok-1' } });
    emitSessionTurns(store, [{ turnId: 'turn-1', vpId: 'vp-1', threadId: 'main', retryToken: 'tok-1' }]);

    // Delayed click with stale retryToken is fenced before sending.
    const stale = await store.retryYeaftFailedTurn({
      agentId: 'agent-a',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      retryToken: 'tok-old',
      mode: 'plain',
    });
    expect(stale).toEqual({ ok: false, error: 'stale_retry_token' });
    expect(store.sendWsMessage).not.toHaveBeenCalled();

    const promise = store.retryYeaftFailedTurn({
      agentId: 'agent-a',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      retryToken: 'tok-1',
      mode: 'compact',
    });

    expect(store.sendWsMessage).toHaveBeenCalledTimes(1);
    const frame = store.sendWsMessage.mock.calls[0][0];
    expect(frame).toMatchObject({
      type: 'yeaft_session_retry',
      agentId: 'agent-a',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      retryToken: 'tok-1',
      mode: 'compact',
    });
    expect(typeof frame.requestId).toBe('string');
    expect(frame.requestId.length).toBeGreaterThan(0);

    // No user message, no history load, no fake bubble.
    expect(store.sendWsMessage.mock.calls.some(([m]) => ['yeaft_session_send', 'chat', 'yeaft_load_history'].includes(m.type))).toBe(false);
    expect(store.messagesMap['conv-a']).toEqual([]);

    // Duplicate click while pending is ignored.
    const dup = await store.retryYeaftFailedTurn({
      agentId: 'agent-a',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      retryToken: 'tok-1',
      mode: 'plain',
    });
    expect(dup).toEqual({ ok: false, error: 'already_in_flight' });
    expect(store.sendWsMessage).toHaveBeenCalledTimes(1);

    // Standalone ack ok:true clears eligibility & initial error immediately.
    store.handleMessage({
      type: 'yeaft_session_retry_result',
      agentId: 'agent-a',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      requestId: frame.requestId,
      ok: true,
    });
    expect(await promise).toEqual({ ok: true });
    expect(visibleYeaftRetryableTurns(store, yeaftRoute())).toEqual([]);
  });

  it('restores controls on relay ok:false and issues distinct retryToken if new attempt fails', async () => {
    const store = setup();
    store.vpStatuses = {
      'agent-a::sess-1::vp-1': {
        agentId: 'agent-a',
        sessionId: 'sess-1',
        vpId: 'vp-1',
        conversationId: 'conv-a',
        connectionGeneration: 1,
        state: 'error',
        turnId: 'turn-1',
        errorDetail: { message: 'Timeout', turnId: 'turn-1', reason: 'stream_idle_timeout' },
      },
    };
    emitError(store, { event: { retryTurnId: 'turn-1', retryToken: 'tok-1', message: 'Timeout' } });
    emitSessionTurns(store, [{ turnId: 'turn-1', vpId: 'vp-1', threadId: 'main', retryToken: 'tok-1' }]);

    const first = store.retryYeaftFailedTurn({
      agentId: 'agent-a',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      retryToken: 'tok-1',
      mode: 'plain',
    });
    const req1 = store.sendWsMessage.mock.calls[0][0].requestId;
    store.handleMessage({
      type: 'yeaft_session_retry_result',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      requestId: req1,
      ok: false,
      error: 'agent_busy',
    });
    expect(await first).toEqual({ ok: false, error: 'agent_busy' });
    const afterFailure = visibleYeaftRetryableTurns(store, yeaftRoute());
    expect(afterFailure).toHaveLength(1);
    expect(afterFailure[0].pending).toBe(false);
    expect(afterFailure[0].retryError).toBe('agent_busy');

    // Second attempt launches cleanly and clears initial error + vpStatuses error.
    const second = store.retryYeaftFailedTurn({
      agentId: 'agent-a',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      retryToken: 'tok-1',
      mode: 'compact',
    });
    const req2 = store.sendWsMessage.mock.calls[1][0].requestId;
    store.handleMessage({
      type: 'yeaft_session_retry_result',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      requestId: req2,
      ok: true,
    });
    expect(await second).toEqual({ ok: true });
    expect(visibleYeaftRetryableTurns(store, yeaftRoute())).toEqual([]);
    expect(store.vpStatuses['agent-a::sess-1::vp-1'].state).toBe('idle');
    expect(store.vpStatuses['agent-a::sess-1::vp-1'].errorDetail).toBeNull();

    // New attempt fails again -> same logical turnId gets a distinct retryToken.
    emitError(store, { event: { retryTurnId: 'turn-1', retryToken: 'tok-2', message: 'Second attempt failed' } });
    expect(visibleYeaftRetryableTurns(store, yeaftRoute())).toEqual([]);
    emitSessionTurns(store, [{ turnId: 'turn-1', vpId: 'vp-1', threadId: 'main', retryToken: 'tok-2' }]);
    const restored = visibleYeaftRetryableTurns(store, yeaftRoute());
    expect(restored).toHaveLength(1);
    expect(restored[0].turnId).toBe('turn-1');
    expect(restored[0].retryToken).toBe('tok-2');
    expect(restored[0].message).toBe('Second attempt failed');
    expect(restored[0].retryError).toBeNull();
  });

  it('retains existing tools/text and clears failure-only UI on vp_turn_start with retry:true', () => {
    const store = setup();
    store.messagesMap['conv-a'] = [
      { id: 'u-1', type: 'user', sessionId: 'sess-1', turnId: 'turn-1', content: 'Check logs' },
      { id: 't-1', type: 'tool-use', sessionId: 'sess-1', speakerVpId: 'vp-1', turnId: 'turn-1', toolName: 'Bash', hasResult: true },
      { id: 'a-1', type: 'assistant', sessionId: 'sess-1', speakerVpId: 'vp-1', turnId: 'turn-1', content: 'Partial output', status: 'errored', turnEndReason: 'errored', turnEndDetail: { code: 'stream_idle_timeout' } },
      { id: 'e-1', type: 'error', sessionId: 'sess-1', speakerVpId: 'vp-1', turnId: 'turn-1', content: 'Stream failed' },
    ];
    emitSessionTurns(store, [{ turnId: 'turn-1', vpId: 'vp-1', threadId: 'main', retryToken: 'tok-1' }]);
    expect(visibleYeaftRetryableTurns(store, yeaftRoute())).toHaveLength(1);

    store.handleYeaftOutput({
      type: 'yeaft_output',
      agentId: 'agent-a',
      conversationId: 'conv-a',
      sessionId: 'sess-1',
      event: {
        type: 'vp_turn_start',
        sessionId: 'sess-1',
        vpId: 'vp-1',
        turnId: 'turn-1',
        threadId: 'main',
        retry: true,
      },
    });

    // Retry bar cleared, existing tool + assistant text retained, failure-only error row & errored status cleared.
    expect(visibleYeaftRetryableTurns(store, yeaftRoute())).toEqual([]);
    const rows = store.messagesMap['conv-a'];
    expect(rows.map(r => r.id)).toEqual(['u-1', 't-1', 'a-1']);
    expect(rows[1].toolName).toBe('Bash');
    expect(rows[2].content).toBe('Partial output');
    expect(rows[2].status).toBe('pending');
    expect(rows[2].turnEndReason).toBeUndefined();
    expect(rows[2].turnEndDetail).toBeUndefined();
  });

  it('scopes multi-turn, multi-session, and multi-agent retries independently', async () => {
    const store = setup();
    emitError(store, { sessionId: 'sess-1', turnId: 'turn-1', event: { retryTurnId: 'turn-1', retryToken: 'tok-a1', message: 'Err 1' } });
    emitError(store, { sessionId: 'sess-1', turnId: 'turn-2', event: { retryTurnId: 'turn-2', retryToken: 'tok-a2', message: 'Err 2' } });
    emitSessionTurns(store, [
      { turnId: 'turn-1', vpId: 'vp-1', threadId: 'main', retryToken: 'tok-a1' },
      { turnId: 'turn-2', vpId: 'vp-1', threadId: 't-2', retryToken: 'tok-a2' },
    ], { sessionId: 'sess-1' });

    emitError(store, { sessionId: 'sess-2', turnId: 'turn-3', event: { retryTurnId: 'turn-3', retryToken: 'tok-s2', message: 'Err 3' } });
    emitSessionTurns(store, [{ turnId: 'turn-3', vpId: 'vp-1', threadId: 'main', retryToken: 'tok-s2' }], { sessionId: 'sess-2' });

    emitError(store, { agentId: 'agent-b', conversationId: 'conv-b', sessionId: 'sess-1', turnId: 'turn-1', event: { retryTurnId: 'turn-1', retryToken: 'tok-b1', message: 'Err B' } });
    emitSessionTurns(store, [{ turnId: 'turn-1', vpId: 'vp-1', threadId: 'main', retryToken: 'tok-b1' }], { agentId: 'agent-b', conversationId: 'conv-b', sessionId: 'sess-1' });

    expect(visibleYeaftRetryableTurns(store, yeaftRoute('agent-a', 'sess-1')).map(r => r.turnId)).toEqual(['turn-1', 'turn-2']);
    expect(visibleYeaftRetryableTurns(store, yeaftRoute('agent-a', 'sess-2')).map(r => r.turnId)).toEqual(['turn-3']);
    expect(visibleYeaftRetryableTurns(store, yeaftRoute('agent-b', 'sess-1')).map(r => r.message)).toEqual(['Err B']);

    // Retrying turn-1 in agent-a/sess-1 leaves turn-2 and other sessions untouched.
    const p = store.retryYeaftFailedTurn({ agentId: 'agent-a', sessionId: 'sess-1', turnId: 'turn-1', retryToken: 'tok-a1', mode: 'plain' });
    const req = store.sendWsMessage.mock.calls[0][0].requestId;
    store.handleMessage({ type: 'yeaft_session_retry_result', agentId: 'agent-a', sessionId: 'sess-1', turnId: 'turn-1', requestId: req, ok: true });
    await p;
    expect(visibleYeaftRetryableTurns(store, yeaftRoute('agent-a', 'sess-1')).map(r => r.turnId)).toEqual(['turn-2']);
    expect(visibleYeaftRetryableTurns(store, yeaftRoute('agent-a', 'sess-2')).map(r => r.turnId)).toEqual(['turn-3']);
    expect(visibleYeaftRetryableTurns(store, yeaftRoute('agent-b', 'sess-1')).map(r => r.turnId)).toEqual(['turn-1']);
  });

  it('handles terminal events, reconnect session_turns snapshots without losing history, offline invalidation, and request timeout', async () => {
    const store = setup();
    store.messagesMap['conv-a'] = [
      { id: 'u-1', type: 'user', sessionId: 'sess-1', turnId: 'turn-1', content: 'Keep history' },
    ];
    emitError(store, { event: { retryTurnId: 'turn-1', retryToken: 'tok-1', message: 'Failed once' } });
    emitSessionTurns(store, [{ turnId: 'turn-1', vpId: 'vp-1', threadId: 'main', retryToken: 'tok-1' }]);

    // vp_turn_end with reason: 'errored' preserves retryability.
    store.handleYeaftOutput({
      type: 'yeaft_output',
      agentId: 'agent-a',
      conversationId: 'conv-a',
      sessionId: 'sess-1',
      event: { type: 'vp_turn_end', sessionId: 'sess-1', vpId: 'vp-1', turnId: 'turn-1', reason: 'errored' },
    });
    expect(visibleYeaftRetryableTurns(store, yeaftRoute())).toHaveLength(1);

    // Timeout recovers stuck pending request so user can retry again.
    const timedOut = store.retryYeaftFailedTurn({
      agentId: 'agent-a',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      retryToken: 'tok-1',
      mode: 'plain',
    });
    vi.advanceTimersByTime(YEAFT_RETRY_TURN_TIMEOUT_MS + 10);
    expect(await timedOut).toEqual({ ok: false, error: 'timeout' });
    expect(visibleYeaftRetryableTurns(store, yeaftRoute())[0].retryError).toBe('timeout');

    // Browser reconnect bumps connection generation -> old state hidden until authoritative session_turns arrives.
    store.chatHistoryConnectionGeneration += 1;
    expect(visibleYeaftRetryableTurns(store, yeaftRoute())).toEqual([]);

    // Authoritative session_turns snapshot restores retryableTurns without losing reconnect history.
    emitSessionTurns(store, [{ turnId: 'turn-1', vpId: 'vp-1', threadId: 'main', retryToken: 'tok-1' }]);
    const reconnected = visibleYeaftRetryableTurns(store, yeaftRoute());
    expect(reconnected).toHaveLength(1);
    expect(reconnected[0]).toMatchObject({ turnId: 'turn-1', retryToken: 'tok-1', vpId: 'vp-1', threadId: 'main' });
    expect(store.messagesMap['conv-a']).toHaveLength(1);

    // Authoritative session_turns with empty retryableTurns prunes it.
    emitSessionTurns(store, []);
    expect(visibleYeaftRetryableTurns(store, yeaftRoute())).toEqual([]);

    // Agent offline clears retryable turns.
    emitSessionTurns(store, [{ turnId: 'turn-2', vpId: 'vp-1', threadId: 'main', retryToken: 'tok-2' }]);
    expect(visibleYeaftRetryableTurns(store, yeaftRoute())).toHaveLength(1);
    store.agents = [{ id: 'agent-a', online: false }, { id: 'agent-b', online: true }];
    invalidateOfflineYeaftTurnRetries(store);
    expect(visibleYeaftRetryableTurns(store, yeaftRoute())).toEqual([]);
  });
});
