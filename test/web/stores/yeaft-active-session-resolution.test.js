/**
 * Regression tests for Yeaft session isolation.
 *
 * The visible message pane is scoped by chatStore.yeaftActiveSessionFilter. A
 * separate sessionsStore.activeSessionId exists for sidebar/global session
 * state. During quick session switches those two pointers can temporarily
 * diverge; the visible filter must win for send/history routing or messages
 * are stamped with the wrong sessionId and then appear in the wrong session
 * after reload.
 *
 * Field rename note (msg.groupId → msg.sessionId, refactor sweep 2026-06-08):
 * the stamped field on every yeaft message is now `sessionId`. The wire
 * envelope `yeaft_output` carries `sessionId` from the agent; the legacy
 * `groupId` is accepted as a fallback on the read side for deploy-window
 * compat. Tests assert on the new name.
 */
import { describe, it, expect } from 'vitest';

function resolveActiveGroupForSend(store, sessionsStore) {
  return store.yeaftActiveSessionFilter || sessionsStore?.activeSessionId || 'grp_default';
}

function selectYeaftMessages(state) {
  const raw = state.messagesMap[state.yeaftConversationId] || [];
  if (state.currentView === 'yeaft' && state.yeaftActiveSessionFilter) {
    return raw.filter(m => m && m.sessionId === state.yeaftActiveSessionFilter);
  }
  return raw;
}

function routeYeaftOutput(state, msg) {
  const event = msg?.event || {};
  // Read side accepts both `sessionId` (new) and `groupId` (legacy) for
  // deploy-window safety. Write side stamps the canonical `sessionId`.
  const sessionId = msg.sessionId ?? event.sessionId ?? msg.groupId ?? event.groupId ?? null;
  const message = {
    id: msg.id || event.id,
    type: event.role || msg.role || 'assistant',
    content: event.content || msg.content || '',
    sessionId,
  };
  state.messagesMap[state.yeaftConversationId] = [
    ...(state.messagesMap[state.yeaftConversationId] || []),
    message,
  ];
}

describe('Yeaft active session resolution', () => {
  it('uses the visible session filter before sessionsStore.activeSessionId for send routing', () => {
    const store = { yeaftActiveSessionFilter: 'grp-visible' };
    const sessionsStore = { activeSessionId: 'grp-stale' };

    expect(resolveActiveGroupForSend(store, sessionsStore)).toBe('grp-visible');
  });

  it('falls back to sessionsStore.activeSessionId when no visible filter is set', () => {
    const store = { yeaftActiveSessionFilter: null };
    const sessionsStore = { activeSessionId: 'grp-active' };

    expect(resolveActiveGroupForSend(store, sessionsStore)).toBe('grp-active');
  });

  it('keeps websocket output in its stamped session after the user switches sessions', () => {
    const state = {
      currentView: 'yeaft',
      yeaftConversationId: 'yeaft-1',
      yeaftActiveSessionFilter: 'grp-A',
      messagesMap: { 'yeaft-1': [] },
    };

    routeYeaftOutput(state, {
      id: 'a-stream',
      sessionId: 'grp-A',
      content: 'late A stream chunk',
    });

    state.yeaftActiveSessionFilter = 'grp-B';
    routeYeaftOutput(state, {
      id: 'b-reply',
      sessionId: 'grp-B',
      content: 'B reply',
    });

    expect(selectYeaftMessages(state).map(m => m.id)).toEqual(['b-reply']);

    state.yeaftActiveSessionFilter = 'grp-A';
    expect(selectYeaftMessages(state).map(m => m.id)).toEqual(['a-stream']);
  });

  it('accepts legacy groupId field on a yeaft_output envelope for deploy-window compat', () => {
    // During the rename rollout, an older agent build may still send
    // `groupId`. Tag the message correctly so filter routing still works.
    const state = {
      currentView: 'yeaft',
      yeaftConversationId: 'yeaft-1',
      yeaftActiveSessionFilter: 'grp-A',
      messagesMap: { 'yeaft-1': [] },
    };
    routeYeaftOutput(state, {
      id: 'legacy',
      groupId: 'grp-A',
      content: 'from old agent',
    });
    expect(state.messagesMap['yeaft-1'][0].sessionId).toBe('grp-A');
    expect(selectYeaftMessages(state).map(m => m.id)).toEqual(['legacy']);
  });
});
