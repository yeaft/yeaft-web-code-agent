import { describe, expect, it } from 'vitest';
import { applySessionTurns, applyUserMessageRoute, clearSessionTurns } from '../../web/stores/helpers/yeaft-session-turns.js';
import { pruneConversationMessageRetention } from '../../web/stores/helpers/yeaft-history-cache.js';

const frame = (agentId, sessionId, turns) => ({ agentId, conversationId: `conv-${agentId}`,
  event: { type: 'session_turns', sessionId, turns } });
const turn = (userTurnId, state = 'running') => ({ userTurnId, userMessageId: userTurnId, state,
  startedAt: 100, executions: [{ vpId: 'v', turnId: `engine-${userTurnId}`, threadId: 'main', state }] });

describe('Session user-turn projection', () => {
  it('scopes snapshots and route arrival-order by Agent and Session, clearing only the exact owner', () => {
    const store = { messagesMap: { 'conv-a': [{ id: 'm1', clientMessageId: 'client', type: 'user', sessionId: 's' }] },
      yeaftConversationIdsByAgent: { a: 'conv-a', b: 'conv-b' }, chatHistoryConnectionGeneration: 3 };
    expect(applySessionTurns(store, frame('a', 's', [{ ...turn('root-a'), activeSince: 150 },
      { ...turn('done', 'completed'), endedAt: 200 }, { ...turn('clock', 'completed'), endedAt: 'soon', activeSince: -1 }]))).toBe(true);
    expect(applySessionTurns(store, frame('b', 's', [turn('root-b')]))).toBe(true);
    expect(applySessionTurns(store, frame('a', 'other', [turn('other')]))).toBe(true);
    expect(applySessionTurns(store, { ...frame('a', 's', []), conversationId: 'old-conv' })).toBe(false);
    expect(store.yeaftSessionTurnsBySession['a\u001fs'].turns[0].userTurnId).toBe('root-a');
    // Only finite positive Agent times survive normalization.
    expect(store.yeaftSessionTurnsBySession['a\u001fs'].turns.map(row => [row.activeSince, row.endedAt]))
      .toEqual([[150, undefined], [undefined, 200], [undefined, undefined]]);
    const route = { ...frame('a', 's', []), event: { type: 'user_message_routed', sessionId: 's', messageId: 'client', userTurnId: 'root-a', relation: 'supplement' } };
    expect(applyUserMessageRoute(store, route)).toBe(true);
    expect(store.messagesMap['conv-a'][0]).toMatchObject({ userTurnId: 'root-a', turnRelation: 'supplement' });
    clearSessionTurns(store, 'a', 's');
    expect(Object.keys(store.yeaftSessionTurnsBySession)).toEqual(['b\u001fs', 'a\u001fother']);
    expect(store.yeaftUserMessageRoutes['a\u001fs']).toBeUndefined();
    clearSessionTurns(store, 'a');
    expect(Object.keys(store.yeaftSessionTurnsBySession)).toEqual(['b\u001fs']);
  });

  it('retains a complete interleaved user turn when any of its execution rows is still live', () => {
    const row = (id, type, userTurnId, extra = {}) => ({ id, messageId: id, type, userTurnId,
      sessionId: 's', timestamp: Number(id.slice(1)), isHistory: true, ...extra });
    const store = { messagesMap: { conv: [row('m1', 'user', 'a'), row('m2', 'assistant', 'a'),
      row('m3', 'user', 'b'), row('m4', 'assistant', 'b'), row('m5', 'assistant', 'a', { isStreaming: true, status: 'pending' })] } };
    pruneConversationMessageRetention(store, { conversationId: 'conv', agentId: 'agent', sessionId: 's', limits: { maxTurnsPerSession: 1 } });
    expect(store.messagesMap.conv.map(item => item.id)).toEqual(['m1', 'm2', 'm5']);
  });
});
