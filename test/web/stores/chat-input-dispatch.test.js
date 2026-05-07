/**
 * chat-input-dispatch.test.js — PR #721 regression: ChatInput's unify
 * dispatch must forward `attachments` end-to-end.
 *
 * What broke before #721:
 *   - In `web/components/ChatInput.js#send()`, the unify-group and
 *     unify-feature branches `return`ed early without ever consulting
 *     the local `attachments[]` ref. Files the user had paperclipped
 *     vanished into the void.
 *   - The store helper `sendUnifyGroupChat` also short-circuited on
 *     empty text, so an image-only send produced zero WS frames.
 *
 * What this file pins:
 *   1. `sendUnifyGroupChat` forwards `attachments[].fileId` onto the
 *      outbound `unify_group_chat` WS frame.
 *   2. The same call accepts an image-only send (empty text) — it
 *      synthesizes a placeholder text and still ships the frame.
 *   3. `sendUnifyFeatureMessage` forwards attachments onto the
 *      outbound `unify_feature_message` WS frame. (The server-side
 *      stop-gap then strips them; that's tested separately. Here we
 *      pin only the store-side passthrough so a future "let's also
 *      drop them client-side" doesn't quietly happen.)
 *
 * Unit-only — no Vue render, no real WS. We capture chat.js's actions
 * object via a Pinia.defineStore shim and invoke the methods against
 * a hand-rolled `this`.
 */
import { describe, it, expect, beforeAll } from 'vitest';

// chat.js does `const { defineStore } = Pinia;` against a global Pinia.
// Shim it so we capture the options object — that gives us direct
// access to the `actions` map without instantiating a real store.
let capturedOptions = null;
globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = (_id, options) => {
  // The chat store is by far the largest defineStore call in the
  // codebase — capture it. Other (smaller) stores imported transitively
  // get a no-op stub.
  if (options && options.actions && options.actions.sendUnifyGroupChat) {
    capturedOptions = options;
  }
  return () => ({});
};

let actions;
beforeAll(async () => {
  // Import the chat store. The defineStore shim above captures the
  // actions object as a side-effect.
  await import('../../../web/stores/chat.js');
  if (!capturedOptions) {
    throw new Error('chat.js defineStore was not captured — Pinia shim mis-wired');
  }
  actions = capturedOptions.actions;
});

/** Build a minimal store-like `this` that records the WS frames sent. */
function mkStore() {
  const sent = [];
  return {
    sent,
    unifyAgentId: 'agent-x',
    unifyConversationId: null, // skip the local-render branch in this test
    sendWsMessage(msg) { sent.push(msg); },
    addMessageToConversation() {}, // unused when unifyConversationId is null
    processingConversations: {},
    _turnCompletedConvs: new Set(),
    _closedAt: {},
    getOrCreateExecutionStatus() {},
  };
}

describe('sendUnifyGroupChat — attachment passthrough', () => {
  it('forwards attachments[].fileId onto the unify_group_chat WS frame', () => {
    const store = mkStore();
    actions.sendUnifyGroupChat.call(store, {
      groupId: 'grp_1',
      text: 'hi',
      mentions: [],
      attachments: [
        { fileId: 'f-aaa', name: 'a.png', isImage: true,  mimeType: 'image/png' },
        { fileId: 'f-bbb', name: 'b.txt', isImage: false, mimeType: 'text/plain' },
      ],
    });
    expect(store.sent).toHaveLength(1);
    const frame = store.sent[0];
    expect(frame.type).toBe('unify_group_chat');
    expect(frame.attachments).toEqual([
      { fileId: 'f-aaa', isImage: true },
      { fileId: 'f-bbb', isImage: false },
    ]);
    // Wire payload must NEVER carry the preview data-URL (would balloon
    // the frame; the server already has the bytes via fileId).
    expect(frame.attachments.every(a => !('preview' in a))).toBe(true);
  });

  it('image-only send (empty text) is allowed — synthesizes placeholder text', () => {
    const store = mkStore();
    actions.sendUnifyGroupChat.call(store, {
      groupId: 'grp_1',
      text: '',
      attachments: [{ fileId: 'f-img', isImage: true, mimeType: 'image/png' }],
    });
    expect(store.sent).toHaveLength(1);
    expect(store.sent[0].text.trim().length).toBeGreaterThan(0);
    expect(store.sent[0].attachments).toEqual([{ fileId: 'f-img', isImage: true }]);
  });

  it('drops entries without a fileId before forwarding', () => {
    const store = mkStore();
    actions.sendUnifyGroupChat.call(store, {
      groupId: 'grp_1',
      text: 'hi',
      attachments: [
        { fileId: 'f-good' },
        null,
        { name: 'no-id.png' }, // missing fileId
      ],
    });
    expect(store.sent[0].attachments).toEqual([{ fileId: 'f-good', isImage: false }]);
  });

  it('no-op when both text and attachments are empty', () => {
    const store = mkStore();
    actions.sendUnifyGroupChat.call(store, { groupId: 'grp_1', text: '' });
    expect(store.sent).toHaveLength(0);
  });
});

describe('sendUnifyFeatureMessage — attachment passthrough', () => {
  it('forwards attachments[].fileId onto the unify_feature_message WS frame', () => {
    // The server will strip these (PR #721 stop-gap) — but the store
    // helper itself MUST keep forwarding so when the consume-by-handler
    // refactor lands, no client-side change is needed.
    const store = mkStore();
    actions.sendUnifyFeatureMessage.call(store, {
      groupId: 'grp_1',
      featureId: 'feat_1',
      vpId: 'user',
      text: 'hi',
      attachments: [{ fileId: 'f-aaa', isImage: true }],
    });
    expect(store.sent).toHaveLength(1);
    const frame = store.sent[0];
    expect(frame.type).toBe('unify_feature_message');
    expect(frame.attachments).toEqual([{ fileId: 'f-aaa', isImage: true }]);
  });
});
