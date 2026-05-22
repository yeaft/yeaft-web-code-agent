/**
 * Regression tests for Unify group isolation.
 *
 * The visible message pane is scoped by chatStore.unifyActiveGroupFilter. A
 * separate groupsStore.activeGroupId exists for sidebar/global group state.
 * During quick group switches those two pointers can temporarily diverge; the
 * visible filter must win for send/history routing or messages are stamped with
 * the wrong groupId and then appear in the wrong group after reload.
 */
import { describe, it, expect } from 'vitest';

function resolveActiveGroupForSend(store, groupsStore) {
  return store.unifyActiveGroupFilter || groupsStore?.activeGroupId || 'grp_default';
}

function selectUnifyMessages(state) {
  const raw = state.messagesMap[state.unifyConversationId] || [];
  if (state.currentView === 'unify' && state.unifyActiveGroupFilter) {
    return raw.filter(m => m && m.groupId === state.unifyActiveGroupFilter);
  }
  return raw;
}

function routeUnifyOutput(state, msg) {
  const event = msg?.event || {};
  const groupId = msg.groupId ?? event.groupId ?? null;
  const message = {
    id: msg.id || event.id,
    type: event.role || msg.role || 'assistant',
    content: event.content || msg.content || '',
    groupId,
  };
  state.messagesMap[state.unifyConversationId] = [
    ...(state.messagesMap[state.unifyConversationId] || []),
    message,
  ];
}

describe('Unify active group resolution', () => {
  it('uses the visible group filter before groupsStore.activeGroupId for send routing', () => {
    const store = { unifyActiveGroupFilter: 'grp-visible' };
    const groupsStore = { activeGroupId: 'grp-stale' };

    expect(resolveActiveGroupForSend(store, groupsStore)).toBe('grp-visible');
  });

  it('falls back to groupsStore.activeGroupId when no visible filter is set', () => {
    const store = { unifyActiveGroupFilter: null };
    const groupsStore = { activeGroupId: 'grp-active' };

    expect(resolveActiveGroupForSend(store, groupsStore)).toBe('grp-active');
  });

  it('keeps websocket output in its stamped group after the user switches groups', () => {
    const state = {
      currentView: 'unify',
      unifyConversationId: 'unify-1',
      unifyActiveGroupFilter: 'grp-A',
      messagesMap: { 'unify-1': [] },
    };

    routeUnifyOutput(state, {
      id: 'a-stream',
      groupId: 'grp-A',
      content: 'late A stream chunk',
    });

    state.unifyActiveGroupFilter = 'grp-B';
    routeUnifyOutput(state, {
      id: 'b-reply',
      groupId: 'grp-B',
      content: 'B reply',
    });

    expect(selectUnifyMessages(state).map(m => m.id)).toEqual(['b-reply']);

    state.unifyActiveGroupFilter = 'grp-A';
    expect(selectUnifyMessages(state).map(m => m.id)).toEqual(['a-stream']);
  });
});
