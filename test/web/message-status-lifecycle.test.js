import { describe, it, expect } from 'vitest';

globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = (_id, options) => () => options;
globalThis.window = globalThis.window || globalThis;
globalThis.window.Pinia = globalThis.Pinia;
globalThis.localStorage = globalThis.localStorage || {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { useChatStore } = await import('../../web/stores/chat.js');

function makeStore() {
  const schema = useChatStore();
  const state = schema.state();
  const store = { ...state, sent: [] };
  for (const [name, fn] of Object.entries(schema.actions)) {
    store[name] = fn.bind(store);
  }
  store.sendWsMessage = function sendWsMessage(msg) { this.sent.push(msg); };
  return store;
}

describe('Per-message vp_turn_end reducer', () => {
  function seed(store, attrs = {}) {
    store.yeaftConversationId = 'conv1';
    store.messagesMap = {
      conv1: [
        {
          type: 'assistant',
          content: 'live reply',
          groupId: 'grp_fun',
          speakerVpId: 'vp_a',
          turnId: 'turn-1',
          status: 'pending',
          turnStartAt: 1000,
          ...attrs,
        },
      ],
    };
  }

  it('flips pending → completed on reason=end_turn', () => {
    const store = makeStore();
    seed(store);
    store.handleYeaftOutput({
      event: { type: 'vp_turn_end', sessionId: 'grp_fun', vpId: 'vp_a', turnId: 'turn-1', reason: 'end_turn', durationMs: 1234 },
    });
    const m = store.messagesMap.conv1[0];
    expect(m.status).toBe('completed');
    expect(m.turnEndReason).toBe('end_turn');
    expect(m.turnDurationMs).toBe(1234);
    expect(typeof m.turnEndAt).toBe('number');
  });

  it('flips pending → aborted on reason=aborted', () => {
    const store = makeStore();
    seed(store);
    store.handleYeaftOutput({
      event: { type: 'vp_turn_end', sessionId: 'grp_fun', vpId: 'vp_a', turnId: 'turn-1', reason: 'aborted' },
    });
    expect(store.messagesMap.conv1[0].status).toBe('aborted');
  });

  it('flips pending → errored on reason=errored and carries detail', () => {
    const store = makeStore();
    seed(store);
    store.handleYeaftOutput({
      event: { type: 'vp_turn_end', sessionId: 'grp_fun', vpId: 'vp_a', turnId: 'turn-1', reason: 'errored', detail: { message: 'boom' } },
    });
    const m = store.messagesMap.conv1[0];
    expect(m.status).toBe('errored');
    expect(m.turnEndDetail).toEqual({ message: 'boom' });
  });

  it('does not flip messages from a different VP turn', () => {
    const store = makeStore();
    seed(store);
    store.handleYeaftOutput({
      event: { type: 'vp_turn_end', sessionId: 'grp_fun', vpId: 'vp_other', turnId: 'turn-1', reason: 'end_turn' },
    });
    expect(store.messagesMap.conv1[0].status).toBe('pending');
  });

  it('does not flip already-terminal messages (idempotent)', () => {
    const store = makeStore();
    seed(store, { status: 'errored' });
    store.handleYeaftOutput({
      event: { type: 'vp_turn_end', sessionId: 'grp_fun', vpId: 'vp_a', turnId: 'turn-1', reason: 'end_turn' },
    });
    expect(store.messagesMap.conv1[0].status).toBe('errored');
  });

  it('flips EVERY pending assistant row in the same turn (multi-row case)', () => {
    // Turn produced 3 assistant rows (text → tool round → more text).
    // All three must flip; before the break removal only the last one did.
    const store = makeStore();
    store.yeaftConversationId = 'conv1';
    store.messagesMap = {
      conv1: [
        { type: 'user', content: 'go', groupId: 'grp_fun', speakerVpId: 'vp_a', turnId: 'turn-1' },
        { type: 'assistant', content: 'part 1', groupId: 'grp_fun', speakerVpId: 'vp_a', turnId: 'turn-1', status: 'pending' },
        { type: 'assistant', content: 'part 2', groupId: 'grp_fun', speakerVpId: 'vp_a', turnId: 'turn-1', status: 'pending' },
        { type: 'assistant', content: 'part 3', groupId: 'grp_fun', speakerVpId: 'vp_a', turnId: 'turn-1', status: 'pending' },
      ],
    };
    store.handleYeaftOutput({
      event: { type: 'vp_turn_end', sessionId: 'grp_fun', vpId: 'vp_a', turnId: 'turn-1', reason: 'end_turn' },
    });
    const statuses = store.messagesMap.conv1
      .filter((m) => m.type === 'assistant')
      .map((m) => m.status);
    expect(statuses).toEqual(['completed', 'completed', 'completed']);
  });
});
