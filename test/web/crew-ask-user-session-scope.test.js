import { describe, it, expect } from 'vitest';

/**
 * Regression: Crew AskUserQuestion session leak
 *
 * Bug: When crew A's role calls AskUserQuestion, the frontend fallback
 * linking loop iterated `Object.values(store.crewMessagesMap)` and
 * attached the `askRequestId` to the FIRST unlinked AskUserQuestion tool
 * message it found — which could be in crew B. Consequence:
 *   - Crew B's sidebar/indicator lit up "has question"
 *   - Crew B's card became answerable (wrong session)
 *   - Crew A's card stayed unlinked forever → buttons disabled → stuck
 *
 * Fix: `msg.conversationId` on the `ask_user_question` event IS the crew
 * session id (agent/crew/role-query.js:178 → session.id), so look up
 * crewMessagesMap[conversationId] directly. Never iterate.
 *
 * These tests exercise the exact handler body (copied from
 * messageHandler.js) — keeping them hermetic and fast.
 */

function makeTryLink(store, msg) {
  return function tryLink() {
    const msgs = store.messagesMap[msg.conversationId] || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].type === 'tool-use' && msgs[i].toolName === 'AskUserQuestion' && !msgs[i].askRequestId) {
        msgs[i].askRequestId = msg.requestId;
        msgs[i].askQuestions = msg.questions;
        return true;
      }
    }
    if (store.crewMessagesMap) {
      const crewMsgs = store.crewMessagesMap[msg.conversationId];
      if (Array.isArray(crewMsgs)) {
        for (let i = crewMsgs.length - 1; i >= 0; i--) {
          if (crewMsgs[i].type === 'tool' && crewMsgs[i].toolName === 'AskUserQuestion' && !crewMsgs[i].askRequestId) {
            crewMsgs[i].askRequestId = msg.requestId;
            crewMsgs[i].askQuestions = msg.questions;
            return true;
          }
        }
      }
    }
    return false;
  };
}

describe('crew AskUserQuestion: session-scoped linking', () => {
  it('links the question to the crew named in msg.conversationId', () => {
    const store = {
      messagesMap: {},
      crewMessagesMap: {
        crew_A: [
          { type: 'tool', toolName: 'AskUserQuestion' },
        ],
        crew_B: [
          { type: 'tool', toolName: 'AskUserQuestion' },
        ],
      },
    };
    const msg = {
      conversationId: 'crew_B',
      requestId: 'R_B',
      questions: [{ q: '?' }],
    };
    const linked = makeTryLink(store, msg)();
    expect(linked).toBe(true);
    expect(store.crewMessagesMap.crew_A[0].askRequestId).toBeUndefined();
    expect(store.crewMessagesMap.crew_B[0].askRequestId).toBe('R_B');
  });

  it('does NOT fall through to other crews when target crew has no unlinked question', () => {
    const store = {
      messagesMap: {},
      crewMessagesMap: {
        crew_A: [
          { type: 'tool', toolName: 'AskUserQuestion' }, // unlinked, WOULD be stolen under the old bug
        ],
        crew_B: [], // the real target has nothing yet
      },
    };
    const msg = { conversationId: 'crew_B', requestId: 'R_B', questions: [] };
    const linked = makeTryLink(store, msg)();
    // The old bug: linked=true against crew_A. Correct behavior: false,
    // so the retry loop has a chance to pick it up once crew_B appends.
    expect(linked).toBe(false);
    expect(store.crewMessagesMap.crew_A[0].askRequestId).toBeUndefined();
  });

  it('retry succeeds once target crew appends its AskUserQuestion', () => {
    const store = {
      messagesMap: {},
      crewMessagesMap: {
        crew_A: [
          { type: 'tool', toolName: 'AskUserQuestion' },
        ],
        crew_B: [],
      },
    };
    const msg = { conversationId: 'crew_B', requestId: 'R_B', questions: [] };
    const tryLink = makeTryLink(store, msg);
    expect(tryLink()).toBe(false);
    // Simulate ui-messages.js appending the tool-use later.
    store.crewMessagesMap.crew_B.push({ type: 'tool', toolName: 'AskUserQuestion' });
    expect(tryLink()).toBe(true);
    expect(store.crewMessagesMap.crew_A[0].askRequestId).toBeUndefined();
    expect(store.crewMessagesMap.crew_B[0].askRequestId).toBe('R_B');
  });

  it('ignores already-linked question in target crew and matches a later unlinked one', () => {
    const store = {
      messagesMap: {},
      crewMessagesMap: {
        crew_A: [
          { type: 'tool', toolName: 'AskUserQuestion', askRequestId: 'R_OLD' },
          { type: 'tool', toolName: 'AskUserQuestion' }, // the fresh one
        ],
      },
    };
    const msg = { conversationId: 'crew_A', requestId: 'R_NEW', questions: [] };
    expect(makeTryLink(store, msg)()).toBe(true);
    expect(store.crewMessagesMap.crew_A[0].askRequestId).toBe('R_OLD');
    expect(store.crewMessagesMap.crew_A[1].askRequestId).toBe('R_NEW');
  });

  it('Chat-mode path (messagesMap) still wins over crew fallback when present', () => {
    const store = {
      messagesMap: {
        chat_conv_1: [
          { type: 'tool-use', toolName: 'AskUserQuestion' },
        ],
      },
      crewMessagesMap: {
        crew_A: [{ type: 'tool', toolName: 'AskUserQuestion' }],
      },
    };
    const msg = { conversationId: 'chat_conv_1', requestId: 'R_C', questions: [] };
    expect(makeTryLink(store, msg)()).toBe(true);
    expect(store.messagesMap.chat_conv_1[0].askRequestId).toBe('R_C');
    expect(store.crewMessagesMap.crew_A[0].askRequestId).toBeUndefined();
  });
});
