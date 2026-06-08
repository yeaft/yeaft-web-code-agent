/**
 * reconnect-restore.test.js — pins the three-layer fix for
 * "Chat session goes silent after a server restart" (user report
 * 2026-06-08).
 *
 * Bug: After the server restarts, the web WS reconnects in ~1s but the
 * agent (a separate process) takes a few seconds longer to come back.
 * In that window, agent_list arrives with the user's `currentAgent`
 * marked `online: false`, and the reconnect block in agentHandler.js
 * was bailing out early without restoring `client.currentConversation`
 * on the server. A chat sent then hit:
 *     server chat handler -> No conversation selected -> error
 * The error was classified as a transient system bubble (5s
 * auto-dismiss) AND the error handler didn't clear the
 * processingConversations flag, so the typing indicator spun forever
 * while the user had no idea the chat was dropped.
 *
 * Three-layer fix this file guards:
 *   A) agentHandler.js — even when the agent isn't back yet, send
 *      select_conversation so server-side client.currentConversation
 *      is restored (the select_conversation handler is agent-
 *      independent — just an ownership check + a field write).
 *   B) conversation.js sendMessage — always pin conversationId on the
 *      chat wsMsg, so the server's "search all agents for conv owner"
 *      fallback can fire even when client.currentConversation is stale.
 *   C) messageHandler.js — on chat-rejection system errors
 *      ('No conversation selected' / 'Agent is still syncing' /
 *      'No agent available'), clear processingConversations and stop
 *      the watchdog so the typing indicator dies and the user can
 *      retry. DELIBERATELY narrow — Permission denied etc. can come
 *      from auxiliary messages unrelated to the current turn.
 *
 * These are unit tests against the real helper modules; we mock
 * `sendWsMessage` to capture the wire packets and the bare minimum of
 * store surface the helpers read.
 */
import { describe, it, expect, beforeEach } from 'vitest';

// `conversation.js` and `messageHandler.js` transitively import
// `web/stores/auth.js` which does `const { defineStore } = Pinia;`
// against a global Pinia (CDN'd in the browser). Same shim as the
// sibling tests.
globalThis.Pinia = globalThis.Pinia || {
  defineStore: () => () => ({}),
};
if (typeof globalThis.localStorage === 'undefined') {
  const _store = new Map();
  globalThis.localStorage = {
    getItem(k) { return _store.has(k) ? _store.get(k) : null; },
    setItem(k, v) { _store.set(k, String(v)); },
    removeItem(k) { _store.delete(k); },
  };
}
if (typeof globalThis.window === 'undefined') {
  globalThis.window = { dispatchEvent() { /* no-op */ } };
}
if (typeof globalThis.CustomEvent === 'undefined') {
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
  };
}

const { handleAgentList } = await import(
  '../../../../web/stores/helpers/handlers/agentHandler.js'
);
const { sendMessage } = await import(
  '../../../../web/stores/helpers/conversation.js'
);
const { handleMessage } = await import(
  '../../../../web/stores/helpers/messageHandler.js'
);

function mkStore(overrides = {}) {
  const sent = [];
  const store = {
    // Connection / agents.
    currentAgent: null,
    currentAgentInfo: null,
    agents: [],

    // Conversation registry.
    conversations: [],
    currentConversation: null,
    currentWorkDir: null,

    // Multi-panel: not used here.
    panels: [],
    activePanelId: null,

    // Proxy ports map — handleAgentList writes into this for every
    // incoming agent before reaching the reconnect branch.
    proxyPorts: {},

    // Message stores.
    messagesMap: {},
    crewMessagesMap: {},
    chatSessionState: {},
    activeConversations: [],
    conversationTitles: {},

    // Processing state.
    processingConversations: {},
    _processingWatchdogs: {},
    _closedAt: {},
    _turnCompletedConvs: new Set(),
    executionStatusMap: {},
    getOrCreateExecutionStatus(convId) {
      if (!this.executionStatusMap[convId]) {
        this.executionStatusMap[convId] = { currentTool: null };
      }
      return this.executionStatusMap[convId];
    },
    finishStreamingForConversation() { /* no-op default; override in Fix C tests */ },

    // Recovery flags read by reconnect path.
    recoveryDismissed: false,
    lastViewedConversation: null,
    lastUsedAgent: null,

    // sendMessage path needs an addMessage stub (optimistic user bubble).
    addMessage(m) {
      if (!this.currentConversation) return;
      if (!this.messagesMap[this.currentConversation]) {
        this.messagesMap[this.currentConversation] = [];
      }
      this.messagesMap[this.currentConversation].push(m);
    },
    addMessageToConversation(convId, m) {
      if (!this.messagesMap[convId]) this.messagesMap[convId] = [];
      this.messagesMap[convId].push({ ...m, id: m.dbMessageId || ('m_' + Math.random()) });
    },

    // wsMessage capture.
    sendWsMessage(msg) { sent.push(msg); return true; },

    // i18n stub used by sendMessage's reconnect-failed branch.
    language: 'en',

    ...overrides,
  };
  store.__sentMessages = sent;
  return store;
}

describe('Fix A — reconnect restores conversation context even when agent is offline', () => {
  it('agent offline + currentConversation set → sends select_conversation only', () => {
    const store = mkStore({
      currentAgent: 'ag1',
      currentConversation: 'c1',
      conversations: [{ id: 'c1', agentId: 'ag1', type: 'chat' }],
      messagesMap: { c1: [] },
    });

    handleAgentList(store, {
      type: 'agent_list',
      agents: [{ id: 'ag1', online: false, conversations: [] }],
    });

    // Fix A: select_conversation should be the SINGLE wire packet sent —
    // it's the only call that's safe before the agent is back.
    const selectConv = store.__sentMessages.find(
      m => m.type === 'select_conversation'
    );
    expect(selectConv).toBeDefined();
    expect(selectConv.conversationId).toBe('c1');

    // Negative: none of the "agent-online" resume packets should fire.
    // sync_messages / refresh_conversation / select_agent all require
    // the agent to be up — sending them blindly is the regression
    // hazard this test guards against.
    expect(store.__sentMessages.find(m => m.type === 'select_agent')).toBeUndefined();
    expect(store.__sentMessages.find(m => m.type === 'sync_messages')).toBeUndefined();
    expect(store.__sentMessages.find(m => m.type === 'refresh_conversation')).toBeUndefined();
  });

  it('agent offline + currentConversation null → sends nothing', () => {
    // Without an active conversation, there's nothing to restore.
    // Firing select_conversation with a null id would trigger an
    // ownership-check failure on the server.
    const store = mkStore({
      currentAgent: 'ag1',
      currentConversation: null,
    });

    handleAgentList(store, {
      type: 'agent_list',
      agents: [{ id: 'ag1', online: false, conversations: [] }],
    });

    expect(store.__sentMessages.find(m => m.type === 'select_conversation')).toBeUndefined();
  });
});

describe('Fix B — sendMessage always pins conversationId on the chat wsMsg', () => {
  it('chat wsMsg carries conversationId === store.currentConversation', () => {
    const store = mkStore({
      currentAgent: 'ag1',
      currentConversation: 'c1',
      conversations: [{ id: 'c1', agentId: 'ag1', type: 'chat' }],
      messagesMap: { c1: [] },
    });

    sendMessage(store, 'hello world');

    const chat = store.__sentMessages.find(m => m.type === 'chat');
    expect(chat).toBeDefined();
    expect(chat.conversationId).toBe('c1');
    expect(chat.prompt).toBe('hello world');
  });
});

describe('Fix C — chat-rejection system errors clear processing state', () => {
  let store;
  let finishCalls;

  beforeEach(() => {
    finishCalls = [];
    store = mkStore({
      currentConversation: 'c1',
      processingConversations: { c1: true },
      _processingWatchdogs: { c1: setTimeout(() => {}, 9999) },
      messagesMap: { c1: [] },
      finishStreamingForConversation(convId) { finishCalls.push(convId); },
    });
  });

  it("'No conversation selected' → cleans processing + stops watchdog + still shows transient bubble", () => {
    handleMessage(store, {
      type: 'error',
      message: 'No conversation selected',
    });

    // Transient system bubble still gets pushed (we didn't break the
    // existing visibility behavior).
    expect(store.messagesMap.c1.some(m => m.type === 'error')).toBe(true);

    // Fix C: processing cleared.
    expect(store.processingConversations.c1).toBeUndefined();
    expect(store._processingWatchdogs.c1).toBeUndefined();
    expect(finishCalls).toContain('c1');
  });

  it("'Agent is still syncing' → cleans processing too", () => {
    // Server tags the chat handler reject with conversationId, so the
    // cleanup should hit the right conv even with multiple panels.
    handleMessage(store, {
      type: 'error',
      message: 'Agent is still syncing, please wait...',
      conversationId: 'c1',
    });

    expect(store.processingConversations.c1).toBeUndefined();
    expect(store._processingWatchdogs.c1).toBeUndefined();
    expect(finishCalls).toContain('c1');
  });

  it("'Permission denied' → does NOT clean processing (could come from select/sync, unrelated to current turn)", () => {
    // Negative case: 'Permission denied' isn't in the chat-rejection
    // whitelist on purpose — it could be triggered by an aux message
    // (select_conversation, sync_messages, pin_session etc.) totally
    // unrelated to the in-flight chat. Clearing processing here would
    // kill a legitimate in-flight turn.
    handleMessage(store, {
      type: 'error',
      message: 'Permission denied',
    });

    expect(store.processingConversations.c1).toBe(true);
    expect(store._processingWatchdogs.c1).toBeDefined();
    expect(finishCalls).not.toContain('c1');
  });
});
