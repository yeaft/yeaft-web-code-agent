/**
 * list-history-sessions-provider.test.js — regression for the Copilot
 * session-isolation bug.
 *
 * What broke:
 *   `ChatPage` calls `store.listHistorySessionsForAgent(agentId, workDir,
 *   provider)` (3 args) and the session helper accepts a 4th `provider`
 *   param, but the store ACTION WRAPPER in chat.js only declared two
 *   params:
 *
 *     listHistorySessionsForAgent(agentId, workDir) {
 *       sessionHelpers.listHistorySessionsForAgent(this, agentId, workDir);
 *     }
 *
 *   …so the `provider` arg was silently dropped on the floor and the
 *   helper defaulted it to 'claude-code'. Result: after picking Copilot
 *   and a folder, the history list still showed Claude Code's sessions
 *   (read from ~/.claude/projects/ instead of ~/.copilot/session-store.db).
 *
 * What this pins:
 *   The action wrapper forwards the `provider` arg through to the WS
 *   `list_history_sessions` frame. `listFoldersForAgent` (which was
 *   already correct) is pinned alongside to guard against a future
 *   regression that re-introduces the asymmetry.
 *
 * Unit-only — no Vue render, no real WS. We capture chat.js's actions
 * object via a Pinia.defineStore shim and invoke the methods against a
 * hand-rolled `this`.
 */
import { describe, it, expect, beforeAll } from 'vitest';

let capturedOptions = null;
globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = (_id, options) => {
  if (options && options.actions && options.actions.listHistorySessionsForAgent) {
    capturedOptions = options;
  }
  return () => ({});
};

let actions;
beforeAll(async () => {
  await import('../../../web/stores/chat.js');
  if (!capturedOptions) {
    throw new Error('chat.js defineStore was not captured — Pinia shim mis-wired');
  }
  actions = capturedOptions.actions;
});

/** Minimal store-like `this` that records the WS frames sent. */
function mkStore() {
  const sent = [];
  return {
    sent,
    sendWsMessage(msg) { sent.push(msg); },
  };
}

describe('listHistorySessionsForAgent — provider passthrough', () => {
  it('forwards provider=copilot onto the list_history_sessions WS frame', () => {
    const store = mkStore();
    actions.listHistorySessionsForAgent.call(store, 'agent-x', '/home/u/proj', 'copilot');
    expect(store.sent).toHaveLength(1);
    const frame = store.sent[0];
    expect(frame.type).toBe('list_history_sessions');
    expect(frame.agentId).toBe('agent-x');
    expect(frame.workDir).toBe('/home/u/proj');
    expect(frame.provider).toBe('copilot');
  });

  it('defaults provider to claude-code when omitted', () => {
    const store = mkStore();
    actions.listHistorySessionsForAgent.call(store, 'agent-x', '/home/u/proj');
    expect(store.sent[0].provider).toBe('claude-code');
  });

  it('no-op (no frame) when workDir is empty', () => {
    const store = mkStore();
    actions.listHistorySessionsForAgent.call(store, 'agent-x', '', 'copilot');
    expect(store.sent).toHaveLength(0);
  });
});

describe('listFoldersForAgent — provider passthrough (guards the asymmetry)', () => {
  it('forwards provider=copilot onto the list_folders WS frame', () => {
    const store = mkStore();
    actions.listFoldersForAgent.call(store, 'agent-x', 'copilot');
    const frame = store.sent.find(m => m.type === 'list_folders');
    expect(frame).toBeTruthy();
    expect(frame.agentId).toBe('agent-x');
    expect(frame.provider).toBe('copilot');
  });
});
