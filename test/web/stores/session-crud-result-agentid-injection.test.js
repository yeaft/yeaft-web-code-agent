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
 * pending promise with `group: event.session || event.group || null`
 * — dropping the envelope's agentId. SessionCreateModal.onSubmit
 * then sees `created.agentId === undefined`, the cross-agent guard
 * short-circuits, `currentAgent` stays on A, and downstream behavior
 * (sidebar filter, history load, default-pointer logic) breaks.
 *
 * Fix: chat.js must inject `msg.agentId` into the resolved `group`
 * payload when the agent omitted it. These tests pin that contract.
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

  it('injects msg.agentId into the resolved group when the agent payload omits it', () => {
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
    expect(resolved.group).toBeDefined();
    expect(resolved.group.id).toBe('grp_test_abc12345');
    // The critical assertion — without this injection,
    // SessionCreateModal.onSubmit sees undefined and never calls
    // selectAgent('agent-B'), reverting currentAgent to A on the next
    // store touch and making the new session look like it "didn't open".
    expect(resolved.group.agentId).toBe('agent-B');
  });

  it('also injects for the legacy group_crud_result wire type', () => {
    const store = makeStore();
    let resolved = null;
    store._sessionCrudPending = new Map([
      ['req-2', { resolve: (value) => { resolved = value; } }],
    ]);

    store.handleYeaftOutput({
      agentId: 'agent-X',
      event: {
        type: 'group_crud_result',
        requestId: 'req-2',
        ok: true,
        op: 'create',
        group: { id: 'grp_old', name: 'Legacy' },
      },
    });

    // Locks in BOTH the dual-naming mapping (event.group → resolved.group)
    // AND the agentId injection on the legacy code path. The fall-through
    // case label gets it for free today, but pinning it here prevents a
    // future split-cases refactor from regressing only one branch.
    expect(resolved.group.id).toBe('grp_old');
    expect(resolved.group.agentId).toBe('agent-X');
  });

  it('does NOT overwrite an agentId already present on the agent payload', () => {
    const store = makeStore();
    let resolved = null;
    store._sessionCrudPending = new Map([
      ['req-3', { resolve: (value) => { resolved = value; } }],
    ]);

    // Belt-and-suspenders: if a future agent build starts stamping
    // agentId itself, the agent's value wins (it's the source of truth
    // for which agent owns the session, regardless of envelope routing).
    store.handleYeaftOutput({
      agentId: 'agent-envelope',
      event: {
        type: 'session_crud_result',
        requestId: 'req-3',
        ok: true,
        op: 'create',
        session: { id: 'grp_pre', agentId: 'agent-payload' },
      },
    });

    expect(resolved.group.agentId).toBe('agent-payload');
  });

  it('leaves group as null when neither the agent nor the envelope provide one', () => {
    const store = makeStore();
    let resolved = null;
    store._sessionCrudPending = new Map([
      ['req-4', { resolve: (value) => { resolved = value; } }],
    ]);

    store.handleYeaftOutput({
      agentId: 'agent-X',
      event: {
        type: 'session_crud_result',
        requestId: 'req-4',
        ok: false,
        op: 'create',
        error: { code: 'invalid_name', message: 'empty' },
      },
    });

    expect(resolved.ok).toBe(false);
    expect(resolved.group).toBeNull();
    expect(resolved.error).toEqual({ code: 'invalid_name', message: 'empty' });
  });

  it('does not inject when msg.agentId is absent (back-compat with un-stamped envelopes)', () => {
    const store = makeStore();
    let resolved = null;
    store._sessionCrudPending = new Map([
      ['req-5', { resolve: (value) => { resolved = value; } }],
    ]);

    store.handleYeaftOutput({
      // no agentId on the envelope
      event: {
        type: 'session_crud_result',
        requestId: 'req-5',
        ok: true,
        op: 'create',
        session: { id: 'grp_noenv', name: 'No envelope agent' },
      },
    });

    expect(resolved.group.id).toBe('grp_noenv');
    expect(resolved.group.agentId).toBeUndefined();
  });
});
