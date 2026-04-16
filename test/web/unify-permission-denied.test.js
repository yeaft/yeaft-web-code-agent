/**
 * Tests for task-282 — Unify "Permission denied" bubble storm fix.
 *
 * Two layers of protection:
 *   A. sendWsMessage short-circuits server-sync messages while in Unify view
 *      (those messages carry a virtual unify-<ts> id that has no server-side
 *      state, so they trigger Permission denied replies).
 *   B. messageHandler dedups consecutive identical system error bubbles
 *      within a 3s window.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Stub browser globals that the store helpers expect when imported.
if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = { OPEN: 1 };
}
if (typeof globalThis.Pinia === 'undefined') {
  globalThis.Pinia = {
    defineStore: () => () => ({}),
    useChatStore: () => ({}),
  };
}
if (typeof globalThis.window === 'undefined') {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, localStorage: { getItem: () => null, setItem: () => {} } };
}
if (typeof globalThis.localStorage === 'undefined') {
  globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
}

const { sendWsMessage } = await import('../../web/stores/helpers/websocket.js');
const { handleMessage: handleWebSocketMessage } = await import('../../web/stores/helpers/messageHandler.js');

const root = join(import.meta.dirname, '../..');
const websocketSrc = readFileSync(join(root, 'web/stores/helpers/websocket.js'), 'utf8');
const messageHandlerSrc = readFileSync(join(root, 'web/stores/helpers/messageHandler.js'), 'utf8');

// ─────────────────────────────────────────────────────────────
// Static source checks
// ─────────────────────────────────────────────────────────────
describe('Static — A. unify-incompatible guard', () => {
  it('websocket.js defines UNIFY_INCOMPATIBLE_TYPES set', () => {
    expect(websocketSrc).toContain('UNIFY_INCOMPATIBLE_TYPES');
  });

  it('guard list includes the server-sync message types', () => {
    for (const t of ['sync_messages', 'refresh_conversation', 'select_conversation', 'cancel_execution']) {
      expect(websocketSrc).toContain(`'${t}'`);
    }
  });

  it('guard checks currentView === unify', () => {
    expect(websocketSrc).toMatch(/currentView\s*===\s*'unify'/);
  });
});

describe('Static — B. system error dedup', () => {
  it('messageHandler tracks _sysErrBaseContent / _sysErrCount / _sysErrFirstAt', () => {
    expect(messageHandlerSrc).toContain('_sysErrBaseContent');
    expect(messageHandlerSrc).toContain('_sysErrCount');
    expect(messageHandlerSrc).toContain('_sysErrFirstAt');
  });

  it('dedup uses a 3s window', () => {
    expect(messageHandlerSrc).toMatch(/3000/);
  });

  it('appended counter format uses " (×N)"', () => {
    expect(messageHandlerSrc).toMatch(/×\$\{last\._sysErrCount\}/);
  });
});

// ─────────────────────────────────────────────────────────────
// Functional — A. sendWsMessage guard
// ─────────────────────────────────────────────────────────────
function makeStore(overrides = {}) {
  return {
    ws: { readyState: 1, send: vi.fn() }, // 1 === WebSocket.OPEN
    currentView: 'chat',
    unifyConversationId: null,
    sessionKey: null,
    ...overrides,
  };
}

// Ensure WebSocket.OPEN is defined in the node test env
if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = { OPEN: 1 };
}

describe('Functional — A. sendWsMessage guard', () => {
  it('blocks sync_messages in Unify view when convId is a unify virtual id', () => {
    const store = makeStore({ currentView: 'unify', unifyConversationId: 'unify-12345' });
    const ok = sendWsMessage(store, { type: 'sync_messages', conversationId: 'unify-12345', turns: 5 });
    expect(ok).toBe(false);
    expect(store.ws.send).not.toHaveBeenCalled();
  });

  it('blocks refresh_conversation in Unify view for virtual id', () => {
    const store = makeStore({ currentView: 'unify', unifyConversationId: 'unify-1' });
    const ok = sendWsMessage(store, { type: 'refresh_conversation', conversationId: 'unify-1' });
    expect(ok).toBe(false);
    expect(store.ws.send).not.toHaveBeenCalled();
  });

  it('blocks when conversationId is missing too (still unify view)', () => {
    const store = makeStore({ currentView: 'unify', unifyConversationId: 'unify-9' });
    const ok = sendWsMessage(store, { type: 'sync_messages', turns: 5 });
    expect(ok).toBe(false);
  });

  it('does NOT block sync_messages in Chat view (regression guard)', () => {
    const store = makeStore({ currentView: 'chat' });
    const ok = sendWsMessage(store, { type: 'sync_messages', conversationId: 'normal-conv-id', turns: 5 });
    expect(ok).toBe(true);
    expect(store.ws.send).toHaveBeenCalledTimes(1);
  });

  it('allows unify_chat / unify_reset / update_llm_config in Unify view', () => {
    const store = makeStore({ currentView: 'unify', unifyConversationId: 'unify-2' });
    for (const type of ['unify_chat', 'unify_reset', 'update_llm_config', 'get_llm_config']) {
      store.ws.send.mockClear();
      const ok = sendWsMessage(store, { type });
      expect(ok, `should allow ${type}`).toBe(true);
      expect(store.ws.send).toHaveBeenCalledTimes(1);
    }
  });

  it('does NOT block non-sync messages in Unify view', () => {
    const store = makeStore({ currentView: 'unify', unifyConversationId: 'unify-3' });
    const ok = sendWsMessage(store, { type: 'get_agent_list' });
    expect(ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// Functional — B. system error dedup
// ─────────────────────────────────────────────────────────────
function makeHandlerStore() {
  const store = {
    messagesMap: { 'c1': [] },
    currentConversation: 'c1',
    processingConversations: {},
    executionStatusMap: {},
    _processingWatchdogs: {},
  };
  store.addMessageToConversation = (convId, m) => {
    if (!store.messagesMap[convId]) store.messagesMap[convId] = [];
    store.messagesMap[convId].push({
      id: m.dbMessageId || Math.random().toString(36).slice(2),
      ...m,
    });
  };
  store.finishStreamingForConversation = () => {};
  return store;
}

describe('Functional — B. system error dedup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('collapses 6 identical "Permission denied" errors into one bubble with (×6)', () => {
    const store = makeHandlerStore();
    for (let i = 0; i < 6; i++) {
      handleWebSocketMessage(store, { type: 'error', message: 'Permission denied', conversationId: 'c1' });
    }
    const msgs = store.messagesMap['c1'];
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('Permission denied (×6)');
    expect(msgs[0]._sysErrCount).toBe(6);
  });

  it('creates a new bubble after the 3s window elapses', () => {
    const store = makeHandlerStore();
    handleWebSocketMessage(store, { type: 'error', message: 'Permission denied', conversationId: 'c1' });
    vi.advanceTimersByTime(3500);
    handleWebSocketMessage(store, { type: 'error', message: 'Permission denied', conversationId: 'c1' });
    // The 5s auto-remove has not fired (we're at 3.5s), so the first bubble still exists.
    expect(store.messagesMap['c1'].length).toBe(2);
  });

  it('does not dedup errors with different messages', () => {
    const store = makeHandlerStore();
    handleWebSocketMessage(store, { type: 'error', message: 'Permission denied', conversationId: 'c1' });
    handleWebSocketMessage(store, { type: 'error', message: 'Agent not found', conversationId: 'c1' });
    expect(store.messagesMap['c1'].length).toBe(2);
  });

  it('does not dedup non-system errors', () => {
    const store = makeHandlerStore();
    handleWebSocketMessage(store, { type: 'error', message: 'Random runtime error', conversationId: 'c1' });
    handleWebSocketMessage(store, { type: 'error', message: 'Random runtime error', conversationId: 'c1' });
    expect(store.messagesMap['c1'].length).toBe(2);
  });

  it('auto-removes the deduped bubble 5s after the latest hit', () => {
    const store = makeHandlerStore();
    handleWebSocketMessage(store, { type: 'error', message: 'Permission denied', conversationId: 'c1' });
    expect(store.messagesMap['c1'].length).toBe(1);
    vi.advanceTimersByTime(1000);
    handleWebSocketMessage(store, { type: 'error', message: 'Permission denied', conversationId: 'c1' });
    expect(store.messagesMap['c1'][0]._sysErrCount).toBe(2);
    // The remove timer was reset on the second hit, so at t=4s the bubble still exists
    vi.advanceTimersByTime(4000);
    expect(store.messagesMap['c1'].length).toBe(1);
    // At t=6s total (1 + 4 + 2), the 5s timer from the second hit has fired
    vi.advanceTimersByTime(2000);
    expect(store.messagesMap['c1'].length).toBe(0);
  });
});
