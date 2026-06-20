import { describe, it, expect } from 'vitest';

import { selectActiveConversationId } from '../../../web/stores/helpers/active-conv.js';

function visibleMessages(state) {
  const convId = selectActiveConversationId(state);
  const raw = convId ? (state.messagesMap[convId] || []) : [];
  if (state.currentView !== 'yeaft') return raw;
  return state.yeaftActiveSessionFilter
    ? raw.filter(m => m && (m.sessionId ?? m.groupId) === state.yeaftActiveSessionFilter)
    : raw;
}

describe('Yeaft cross-agent conversation selection', () => {
  it('uses the active session owner agent conversation when returning from another agent', () => {
    const state = {
      currentView: 'yeaft',
      currentAgent: 'agent-a',
      yeaftConversationId: 'conv-b',
      yeaftConversationIdsByAgent: {
        'agent-a': 'conv-a',
        'agent-b': 'conv-b',
      },
      yeaftActiveSessionFilter: 'session-a',
      yeaftSessionAgentById: {
        'session-a': 'agent-a',
        'session-b': 'agent-b',
      },
      activeConversations: ['conv-b'],
      messagesMap: {
        'conv-a': [
          { id: 'a-1', messageId: 'a-1', type: 'assistant', content: 'A once', sessionId: 'session-a' },
        ],
        'conv-b': [
          { id: 'b-1', messageId: 'b-1', type: 'assistant', content: 'B only', sessionId: 'session-b' },
          { id: 'a-1-copy', messageId: 'a-1-copy', type: 'assistant', content: 'A duplicate in wrong cache', sessionId: 'session-a' },
        ],
      },
    };

    expect(selectActiveConversationId(state)).toBe('conv-a');
    expect(visibleMessages(state).map(m => m.content)).toEqual(['A once']);
  });

  it('falls back to the current agent conversation when the session owner is unknown', () => {
    const state = {
      currentView: 'yeaft',
      currentAgent: 'agent-b',
      yeaftConversationId: 'conv-b',
      yeaftConversationIdsByAgent: {
        'agent-a': 'conv-a',
        'agent-b': 'conv-b',
      },
      yeaftActiveSessionFilter: 'session-new',
      yeaftSessionAgentById: {},
      activeConversations: ['conv-b'],
    };

    expect(selectActiveConversationId(state)).toBe('conv-b');
  });
});
