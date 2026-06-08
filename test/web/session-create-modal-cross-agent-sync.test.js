/**
 * session-create-modal-cross-agent-sync.test.js
 *
 * Regression guard for the fix-yeaft-delete-and-agent-revert bug 2.
 *
 * Symptom: user is in Yeaft view with currentAgent=A. They open the
 * SessionCreateModal, switch the agent picker to B, submit. The new
 * session shows up briefly, then the very next click jumps the UI
 * back to A and B's rows disappear.
 *
 * Root cause: `onSubmit` only emitted `created` + `close`. It didn't
 * update `chat.currentAgent` to B, didn't set the chat-store filter,
 * and didn't update the sessions-store active pointer. The next
 * click on a B-owned row then triggered a `selectAgent(B)` round-trip
 * whose side effects + the stale lastViewed sanitization in
 * `web/stores/sessions.js applySnapshot` reverted the UI to A.
 *
 * Fix: `onSubmit` after `res.ok` mirrors the working `resumeExisting`
 * path — selectAgent(B), sessionsStore.setActive(created.id),
 * chat.setActiveSessionFilter(created.id, {force:true}).
 *
 * These tests pin exactly that sync so the regression can't sneak
 * back in.
 */
import { beforeAll, describe, expect, it } from 'vitest';

globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = (_id, options) => () => options;
globalThis.window = globalThis.window || globalThis;
globalThis.window.Pinia = globalThis.Pinia;

let SessionCreateModal;
beforeAll(async () => {
  SessionCreateModal = (await import('../../web/components/SessionCreateModal.js')).default;
});

function makeCtx(overrides = {}) {
  const calls = {
    selectAgent: [],
    setActive: [],
    setActiveSessionFilter: [],
    emit: [],
    createCalls: [],
  };
  const ctx = {
    busy: false,
    canSubmit: true,
    submitError: '',
    form: {
      name: 'My Session',
      vpIds: ['omni'],
      defaultVpId: 'omni',
      workDir: '/tmp/x',
      agentId: 'agent-B',
    },
    vpList: [{ vpId: 'omni' }],
    sessionsStore: {
      setActive(id) { calls.setActive.push(id); },
    },
    chat: {
      currentAgent: 'agent-A',
      selectAgent(id) { calls.selectAgent.push(id); this.currentAgent = id; },
      setActiveSessionFilter(id, opts) { calls.setActiveSessionFilter.push([id, opts]); },
      createYeaftSession(args) {
        calls.createCalls.push(args);
        return { ok: true, group: { id: 'grp_new_xxx', agentId: 'agent-B', name: args.displayName } };
      },
    },
    $emit(name, payload) { calls.emit.push([name, payload]); },
    $t(k) { return k; },
    ...overrides,
  };
  return { ctx, calls };
}

describe('SessionCreateModal onSubmit cross-agent sync (bug 2 regression)', () => {
  it('switches currentAgent to the created session\'s owning agent', async () => {
    const { ctx, calls } = makeCtx();
    await SessionCreateModal.methods.onSubmit.call(ctx);
    // Without this call, `currentAgent` stays at A and the next click
    // triggers a `selectAgent(B)` round-trip whose side effects revert
    // the UI back to A — exactly what the user reported.
    expect(calls.selectAgent).toEqual(['agent-B']);
  });

  it('sets the sessions-store active pointer to the new session id', async () => {
    const { ctx, calls } = makeCtx();
    await SessionCreateModal.methods.onSubmit.call(ctx);
    expect(calls.setActive).toEqual(['grp_new_xxx']);
  });

  it('fires chat.setActiveSessionFilter with force:true so yeaft_load_history triggers', async () => {
    const { ctx, calls } = makeCtx();
    await SessionCreateModal.methods.onSubmit.call(ctx);
    // force:true is non-negotiable — without it `setActiveSessionFilter`
    // would skip the WS send when the id appears to match the current
    // filter, leaving the pane empty.
    expect(calls.setActiveSessionFilter).toEqual([['grp_new_xxx', { force: true }]]);
  });

  it('emits created then close', async () => {
    const { ctx, calls } = makeCtx();
    await SessionCreateModal.methods.onSubmit.call(ctx);
    const names = calls.emit.map(([n]) => n);
    expect(names).toEqual(['created', 'close']);
  });

  it('does NOT call selectAgent when the created session is already on currentAgent', async () => {
    const { ctx, calls } = makeCtx({
      chat: {
        currentAgent: 'agent-B',
        selectAgent(id) { calls?.selectAgent.push(id); },
        setActiveSessionFilter() {},
        createYeaftSession() { return { ok: true, group: { id: 'g1', agentId: 'agent-B' } }; },
      },
    });
    await SessionCreateModal.methods.onSubmit.call(ctx);
    expect(calls.selectAgent).toEqual([]);
  });

  it('does NOT do any sync when the create fails (res.ok=false)', async () => {
    const { ctx, calls } = makeCtx({
      chat: {
        currentAgent: 'agent-A',
        selectAgent(id) { calls.selectAgent.push(id); },
        setActiveSessionFilter(id, opts) { calls.setActiveSessionFilter.push([id, opts]); },
        createYeaftSession() {
          return { ok: false, error: { code: 'duplicate', message: 'taken' } };
        },
      },
    });
    await SessionCreateModal.methods.onSubmit.call(ctx);
    expect(calls.selectAgent).toEqual([]);
    expect(calls.setActive).toEqual([]);
    expect(calls.setActiveSessionFilter).toEqual([]);
  });

  it('survives a null res.group (defensive guard)', async () => {
    const { ctx, calls } = makeCtx({
      chat: {
        currentAgent: 'agent-A',
        selectAgent(id) { calls.selectAgent.push(id); },
        setActiveSessionFilter(id, opts) { calls.setActiveSessionFilter.push([id, opts]); },
        createYeaftSession() { return { ok: true, group: null }; },
      },
    });
    await expect(SessionCreateModal.methods.onSubmit.call(ctx)).resolves.toBeUndefined();
    // No agent switch + no setActive + no filter call, but `created`+`close`
    // still fire so the modal closes.
    expect(calls.selectAgent).toEqual([]);
    expect(calls.setActive).toEqual([]);
    expect(calls.setActiveSessionFilter).toEqual([]);
    const names = calls.emit.map(([n]) => n);
    expect(names).toEqual(['created', 'close']);
  });
});
