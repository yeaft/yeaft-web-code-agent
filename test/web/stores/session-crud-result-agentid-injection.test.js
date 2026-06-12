/**
 * session-crud-result-agentid-injection.test.js
 *
 * Regression guard for fix-yeaft-create-not-opened.
 *
 * Symptom: User in agent A, opens SessionCreateModal, switches to
 * agent B, submits. The session is created on B but the right-pane
 * sidebar doesn't show it (or it appears briefly then snaps back) and
 * the new session isn't opened in the main pane.
 *
 * Root cause: The agent's session meta payload does NOT carry an
 * `agentId` field — the agent doesn't know its own server-assigned
 * id. The server stamps `msg.agentId` on the envelope only. The web
 * chat-store's `case 'session_crud_result':` was resolving the
 * pending promise with `session: event.session || null`
 * — dropping the envelope's agentId. SessionCreateModal.onSubmit
 * then sees `created.agentId === undefined`, the cross-agent guard
 * short-circuits, `currentAgent` stays on A, and downstream behavior
 * (sidebar filter, history load, default-pointer logic) breaks.
 *
 * Fix: chat.js must inject `msg.agentId` into the resolved `session`
 * payload when the agent omitted it. These tests pin that contract.
 * The resolver also surfaces a legacy `group` alias for one deploy
 * window in case any caller is still on the old name.
 */
import { describe, it, expect, beforeEach } from 'vitest';

globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = (_id, options) => () => options;
globalThis.window = globalThis.window || globalThis;
globalThis.window.Pinia = globalThis.Pinia;
globalThis.localStorage = globalThis.localStorage || {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { useChatStore } = await import('../../../web/stores/chat.js');

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

describe('session_crud_result agentId injection', () => {
  beforeEach(() => {
    globalThis.window.Pinia = {
      ...globalThis.Pinia,
      useSessionsStore: () => ({ applyCrudResult: () => {} }),
    };
  });

  it('injects msg.agentId into the resolved session when the agent payload omits it', () => {
    const store = makeStore();
    let resolved = null;
    store._sessionCrudPending = new Map([
      ['req-1', { resolve: (value) => { resolved = value; } }],
    ]);

    // Wire-realistic: the agent's `session` meta has no agentId, but the
    // server stamped agentId='agent-B' on the envelope (msg.agentId).
    store.handleYeaftOutput({
      agentId: 'agent-B',
      event: {
        type: 'session_crud_result',
        requestId: 'req-1',
        ok: true,
        op: 'create',
        session: { id: 'grp_test_abc12345', name: 'Test', roster: ['omni'] },
      },
    });

    expect(resolved).not.toBeNull();
    expect(resolved.session).toBeDefined();
    expect(resolved.session.id).toBe('grp_test_abc12345');
    // The critical assertion — without this injection,
    // SessionCreateModal.onSubmit sees undefined and never calls
    // selectAgent('agent-B'), reverting currentAgent to A on the next
    // store touch and making the new session look like it "didn't open".
    expect(resolved.session.agentId).toBe('agent-B');
  });

});
