/**
 * Regression tests for Yeaft group isolation.
 *
 * The visible message pane is scoped by chatStore.yeaftActiveGroupFilter. A
 * separate groupsStore.activeGroupId exists for sidebar/global group state.
 * During quick group switches those two pointers can temporarily diverge; the
 * visible filter must win for send/history routing or messages are stamped with
 * the wrong groupId and then appear in the wrong group after reload.
 */
import { describe, it, expect } from 'vitest';

function resolveActiveGroupForSend(store, groupsStore) {
  return store.yeaftActiveGroupFilter || groupsStore?.activeGroupId || 'grp_default';
}

function selectYeaftMessages(state) {
  const raw = state.messagesMap[state.yeaftConversationId] || [];
  if (state.currentView === 'yeaft' && state.yeaftActiveGroupFilter) {
    return raw.filter(m => m && m.groupId === state.yeaftActiveGroupFilter);
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
  it('uses the visible group filter before groupsStore.activeGroupId for send routing', () => {
    const store = { yeaftActiveGroupFilter: 'grp-visible' };
    const groupsStore = { activeGroupId: 'grp-stale' };

    expect(resolveActiveGroupForSend(store, groupsStore)).toBe('grp-visible');
  });

  it('falls back to groupsStore.activeGroupId when no visible filter is set', () => {
    const store = { yeaftActiveGroupFilter: null };
    const groupsStore = { activeGroupId: 'grp-active' };

    expect(resolveActiveGroupForSend(store, groupsStore)).toBe('grp-active');
  });

  it('keeps websocket output in its stamped group after the user switches groups', () => {
    const state = {
      currentView: 'yeaft',
      yeaftConversationId: 'yeaft-1',
      yeaftActiveGroupFilter: 'grp-A',
      messagesMap: { 'yeaft-1': [] },
    };

    routeYeaftOutput(state, {
      id: 'a-stream',
      groupId: 'grp-A',
      content: 'late A stream chunk',
    });

    state.yeaftActiveGroupFilter = 'grp-B';
    routeYeaftOutput(state, {
      id: 'b-reply',
      groupId: 'grp-B',
      content: 'B reply',
    });

    expect(selectYeaftMessages(state).map(m => m.id)).toEqual(['b-reply']);

    state.yeaftActiveGroupFilter = 'grp-A';
    expect(selectYeaftMessages(state).map(m => m.id)).toEqual(['a-stream']);
  });
});
