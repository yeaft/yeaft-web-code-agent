// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

const options = {};
const auth = { userId: 'owner', authGeneration: 1 };
globalThis.Pinia = {
  defineStore: (id, definition) => { options[id] = definition; return () => id === 'auth' ? auth : null; },
};
await import('../../../web/stores/chat.js');
const { yeaftHistoryIdentityKey: key } = await import('../../../web/stores/helpers/yeaft-history-identity.js');
const { YEAFT_DELETE_TURN_TIMEOUT_MS } = await import('../../../web/stores/helpers/yeaft-turn-deletion.js');
const userRow = (sessionId, messageId, meta = {}) => ({ type: 'user', sessionId, id: messageId, messageId, ...meta });

function setup() {
  vi.useFakeTimers();
  auth.authGeneration = 1;
  const selected = userRow('s', 'm0002', { userTurnId: 'root', turnRelation: 'supplement' });
  const otherSession = userRow('other', 'm0002');
  const sameIdOtherAgent = userRow('s', 'm0002');
  const store = {
    ...options.chat.state(), ...options.chat.actions,
    currentView: 'yeaft', currentAgent: 'a', yeaftActiveSessionFilter: 's', yeaftConversationId: 'a-conv',
    yeaftConversationIdsByAgent: { a: 'a-conv', b: 'b-conv' },
    agents: [{ id: 'a', online: true, capabilities: ['session_delete_turn'] }, { id: 'b', online: true }],
    connectionState: 'connected', yeaftSessionDeleteTurnSupported: true,
    messagesMap: { 'a-conv': [userRow('s', 'm0001'), selected, otherSession], 'b-conv': [sameIdOtherAgent] },
    sendWsMessage: vi.fn(() => true),
  };
  for (const [name, getter] of Object.entries(options.chat.getters)) {
    Object.defineProperty(store, name, { get: () => getter.call(store, store), configurable: true });
  }
  return { store, selected, otherSession, sameIdOtherAgent };
}
const result = (store, overrides = {}) => {
  const { agentId, sessionId, requestId } = store.sendWsMessage.mock.calls.find(([m]) => m.type === 'yeaft_session_delete_turn')[0];
  store.handleMessage({ type: 'yeaft_session_delete_turn_result', agentId, sessionId, requestId, ok: true, ...overrides });
};
const chunk = (store, requestId, messages, overrides = {}) => store.handleMessage({
  type: 'yeaft_history_chunk', agentId: 'a', sessionId: 's', conversationId: 'a-conv', mode: 'recent', requestId,
  messages, hasMore: false, ...overrides,
});

afterEach(() => vi.useRealTimers());

describe('native Session delete turn', () => {
  it('only targets persisted user rows and rechecks the active Session, activity and auth before sending', async () => {
    const { store, selected } = setup();
    const target = store.yeaftTurnDeleteTarget(selected);
    expect(store.yeaftTurnDeleteTarget(userRow('s', 'm0002', { clientMessageId: 'm0002' }))).toBeNull();
    expect(store.yeaftTurnDeleteTarget({ ...selected, type: 'assistant' })).toBeNull();
    expect(store.yeaftTurnDeleteTarget(userRow('s', 'optimistic'))).toBeNull();
    store.digitalPersonOpen = true;
    expect(store.yeaftTurnDeleteTarget(selected)).toBeNull();
    store.digitalPersonOpen = false;
    store.currentView = 'chat';
    expect(store.yeaftTurnDeleteTarget(selected)).toBeNull();
    store.currentView = 'yeaft';
    store.yeaftProcessingSessions[key('a', 's')] = true;
    expect(await store.deleteYeaftSessionTurn(target)).toEqual({ ok: false, errorCode: 'running' });
    delete store.yeaftProcessingSessions[key('a', 's')];
    store.yeaftActiveSessionFilter = 'other';
    expect(await store.deleteYeaftSessionTurn(target)).toEqual({ ok: false, errorCode: 'stale' });
    store.yeaftActiveSessionFilter = 's';
    auth.authGeneration++;
    expect(await store.deleteYeaftSessionTurn(target)).toEqual({ ok: false, errorCode: 'stale' });
    expect(store.sendWsMessage).not.toHaveBeenCalled();
  });

  it('correlates the result, does not delete optimistically, and authoritatively replaces even the last turn', async () => {
    const { store, selected, otherSession, sameIdOtherAgent } = setup();
    const target = store.yeaftTurnDeleteTarget(selected);
    const pending = store.deleteYeaftSessionTurn(target);
    const sent = store.sendWsMessage.mock.lastCall[0];
    expect(sent).toEqual({ type: 'yeaft_session_delete_turn', agentId: 'a', sessionId: 's',
      messageId: 'm0002', requestId: expect.any(String) });
    expect(await store.deleteYeaftSessionTurn(target)).toEqual({ ok: false, errorCode: 'pending' });
    result(store, { agentId: 'b' });
    result(store, { sessionId: 'other' });
    result(store, { requestId: 'old' });
    expect(store.sendWsMessage).toHaveBeenCalledTimes(1);
    expect(store.messagesMap['a-conv']).toContain(selected);
    result(store);
    expect(await pending).toEqual({ ok: true, errorCode: undefined });
    const refresh = store.sendWsMessage.mock.lastCall[0];
    expect(refresh).toMatchObject({ type: 'yeaft_load_history', agentId: 'a', sessionId: 's' });
    expect(store.messagesMap['a-conv']).toContain(selected);
    chunk(store, refresh.requestId, []);
    expect(store.messagesMap['a-conv']).toEqual([otherSession]);
    expect(store.messagesMap['b-conv']).toEqual([sameIdOtherAgent]);
    expect(store.yeaftTurnDeleteHistoryBySession[key('a', 's')].needsReplay).toBe(false);
  });

  it('fences old history, search and window replies after a broadcast and ignores repeated or wrong-owner broadcasts', () => {
    const { store, sameIdOtherAgent } = setup();
    const scope = key('a', 's');
    const old = store.beginYeaftHistoryLoad({ agentId: 'a', sessionId: 's', mode: 'older' });
    store.yeaftHistorySearchState = { agentId: 'a', sessionId: 's', requestId: 'old-search', results: [{ messageId: 'm0002' }] };
    const resolveWindow = vi.fn();
    store._yeaftHistoryWindowPendingByKey.window = { agentId: 'a', sessionId: 's', requestId: 'old-window', resolve: resolveWindow };
    store.yeaftHistoryOutlineBySession[scope] = { requestId: 'old-outline', results: [{ messageId: 'm0002' }] };
    const broadcast = { type: 'yeaft_session_turn_deleted', agentId: 'a', sessionId: 's', turnId: 'root' };
    store.handleMessage({ ...broadcast, _wsAuthGeneration: 0, _wsAuthOwnerId: 'owner' });
    expect(store.sendWsMessage).not.toHaveBeenCalled();
    store.handleMessage(broadcast);
    store.handleMessage(broadcast);
    expect(store.sendWsMessage).toHaveBeenCalledTimes(1);
    expect(resolveWindow).toHaveBeenCalledWith(false);
    const refresh = store.sendWsMessage.mock.lastCall[0];
    const stale = [{ id: 'm0002', role: 'user', content: 'deleted' }];
    chunk(store, old.requestId, stale, { mode: 'older' });
    store.handleMessage({ type: 'yeaft_history_search_result', agentId: 'a', sessionId: 's', requestId: 'old-search', results: stale });
    store.handleMessage({ type: 'yeaft_history_outline', agentId: 'a', sessionId: 's', requestId: 'old-outline', results: stale });
    store.handleMessage({ type: 'yeaft_history_window', agentId: 'a', sessionId: 's', requestId: 'old-window', messages: stale });
    chunk(store, refresh.requestId, [{ id: 'm0001', role: 'user', content: 'survives' }]);
    chunk(store, undefined, stale);
    store.handleYeaftOutput({ agentId: 'a', sessionId: 's', event: { type: 'history_loaded', requestId: old.requestId, sessionId: 's', latestSeq: 900 } });
    expect(store.messagesMap['a-conv'].filter(row => row.sessionId === 's').map(row => row.id)).toEqual(['m0001']);
    expect(store.messagesMap['b-conv']).toEqual([sameIdOtherAgent]);
    expect(store.yeaftHistorySearchState.results).toEqual([]);
    expect(store.yeaftHistoryOutlineBySession[scope]).toBeUndefined();
    expect(store.yeaftSessionHistoryState[scope].latestSeq).not.toBe(900);
  });

  it('invalidates an inactive Session without navigation and forces its next bootstrap to reload', () => {
    const { store, otherSession } = setup();
    store.yeaftActiveSessionFilter = 'other';
    store.handleMessage({ type: 'yeaft_session_turn_deleted', agentId: 'a', sessionId: 's', turnId: 'root' });
    expect(store.sendWsMessage).not.toHaveBeenCalled();
    expect(store.messagesMap['a-conv']).toEqual([otherSession]);
    expect(store.yeaftActiveSessionFilter).toBe('other');
    store.yeaftActiveSessionFilter = 's';
    expect(store.requestYeaftSessionBootstrap()).toBe(true);
    expect(store.sendWsMessage.mock.lastCall[0]).toMatchObject({ type: 'yeaft_load_history', sessionId: 's', requestId: expect.any(String) });
  });

  it('does not retry the mutation when a socket drops after its ack but before the replacement chunk', async () => {
    const { store, selected, otherSession } = setup();
    const pending = store.deleteYeaftSessionTurn(store.yeaftTurnDeleteTarget(selected));
    result(store);
    expect((await pending).ok).toBe(true);
    const old = store.sendWsMessage.mock.lastCall[0];
    store.interruptYeaftTurnDeletions();
    expect(store.messagesMap['a-conv']).toEqual([otherSession]);
    chunk(store, old.requestId, [{ id: 'm0002', role: 'user', content: 'old' }]);
    expect(store.requestYeaftSessionBootstrap({ catchUpHistory: true })).toBe(true);
    const fresh = store.sendWsMessage.mock.lastCall[0];
    expect(fresh).toMatchObject({ type: 'yeaft_load_history', sessionId: 's' });
    expect(fresh.requestId).not.toBe(old.requestId);
    expect(store.sendWsMessage.mock.calls.filter(([m]) => m.type === 'yeaft_session_delete_turn')).toHaveLength(1);
  });

  it('leaves explicit failures untouched, then reconciles an unconfirmed timeout without replaying the mutation', async () => {
    const { store, selected } = setup();
    const target = store.yeaftTurnDeleteTarget(selected);
    const rejected = store.deleteYeaftSessionTurn(target);
    result(store, { ok: false, errorCode: 'session_running' });
    expect(await rejected).toEqual({ ok: false, errorCode: 'session_running' });
    expect(store.messagesMap['a-conv']).toContain(selected);
    store.sendWsMessage.mockClear();
    const timedOut = store.deleteYeaftSessionTurn(target);
    await vi.advanceTimersByTimeAsync(YEAFT_DELETE_TURN_TIMEOUT_MS);
    expect(await timedOut).toEqual({ ok: false, errorCode: 'unconfirmed' });
    expect(store.sendWsMessage.mock.calls.map(([m]) => m.type)).toEqual(['yeaft_session_delete_turn', 'yeaft_load_history']);
  });
});
