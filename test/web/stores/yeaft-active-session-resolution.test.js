/**
 * Regression tests for Yeaft group isolation.
 *
 * The visible message pane is scoped by chatStore.yeaftActiveSessionFilter. A
 * separate sessionsStore.activeSessionId exists for sidebar/global group state.
 * During quick group switches those two pointers can temporarily diverge; the
 * visible filter must win for send/history routing or messages are stamped with
 * the wrong groupId and then appear in the wrong group after reload.
 */
import { describe, it, expect } from 'vitest';

function resolveActiveGroupForSend(store, sessionsStore) {
  return store.yeaftActiveSessionFilter || sessionsStore?.activeSessionId || 'grp_default';
}

function selectYeaftMessages(state) {
  const raw = state.messagesMap[state.yeaftConversationId] || [];
  if (state.currentView === 'yeaft' && state.yeaftActiveSessionFilter) {
    return raw.filter(m => m && m.groupId === state.yeaftActiveSessionFilter);
  }
  return raw;
}

function routeYeaftOutput(state, msg) {
  const event = msg?.event || {};
  const groupId = msg.groupId ?? event.groupId ?? null;
  const message = {
    id: msg.id || event.id,
    type: event.role || msg.role || 'assistant',
    content: event.content || msg.content || '',
    groupId,
  };
  state.messagesMap[state.yeaftConversationId] = [
    ...(state.messagesMap[state.yeaftConversationId] || []),
    message,
  ];
}

describe('Yeaft active group resolution', () => {
  it('uses the visible group filter before sessionsStore.activeSessionId for send routing', () => {
    const store = { yeaftActiveSessionFilter: 'grp-visible' };
    const sessionsStore = { activeSessionId: 'grp-stale' };

    expect(resolveActiveGroupForSend(store, sessionsStore)).toBe('grp-visible');
  });

  it('falls back to sessionsStore.activeSessionId when no visible filter is set', () => {
    const store = { yeaftActiveSessionFilter: null };
    const sessionsStore = { activeSessionId: 'grp-active' };

    expect(resolveActiveGroupForSend(store, sessionsStore)).toBe('grp-active');
  });

  it('keeps websocket output in its stamped group after the user switches groups', () => {
    const state = {
      currentView: 'yeaft',
      yeaftConversationId: 'yeaft-1',
      yeaftActiveSessionFilter: 'grp-A',
      messagesMap: { 'yeaft-1': [] },
    };

    routeYeaftOutput(state, {
      id: 'a-stream',
      groupId: 'grp-A',
      content: 'late A stream chunk',
    });

    state.yeaftActiveSessionFilter = 'grp-B';
    routeYeaftOutput(state, {
      id: 'b-reply',
      groupId: 'grp-B',
      content: 'B reply',
    });

    expect(selectYeaftMessages(state).map(m => m.id)).toEqual(['b-reply']);

    state.yeaftActiveSessionFilter = 'grp-A';
    expect(selectYeaftMessages(state).map(m => m.id)).toEqual(['a-stream']);
  });
});
