/**
 * fix-session-restore-modal-unify — pin the agent-aware vp_subscribe.
 *
 * Why this test exists (the BLOCKER bug):
 *   - Pre-fix, the modal sent bare `{ type: 'yeaft_vp_subscribe' }`.
 *   - The server routes yeaft_* on `msg.agentId || client.currentAgent`.
 *   - On a fresh page load (no chat session entered yet), currentAgent
 *     is null → the message is silently swallowed → the VP roster
 *     never hydrates → "VP 加载中..." forever → Create button disabled.
 *
 * What's pinned here:
 *   1. `subscribeVpsFor(agentId)` stamps the agentId on the wire.
 *   2. It falls back through `chat.yeaftAgentId` → `chat.currentAgent`
 *      with the documented precedence.
 *   3. It warns (no silent failure) when nothing resolves.
 *   4. It skips re-subscribing when the cached snapshot is already
 *      for the target agent.
 *   5. It DOES re-subscribe when the target agent differs from the
 *      cached snapshot's agentId — covers the dropdown-switch case.
 *
 * Pinia/Vue mounting trick mirrors the sibling chat-style test —
 * we exercise the method on a hand-built `this` context instead of
 * standing up a full Vue runtime.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = (_id, options) => () => options;
globalThis.window = globalThis.window || globalThis;
globalThis.window.Pinia = globalThis.Pinia;

let SessionCreateModal;
beforeAll(async () => {
  SessionCreateModal = (await import('../../web/components/SessionCreateModal.js')).default;
});

function makeCtx({ formAgentId = null, yeaftAgentId = null, currentAgent = null, vpStore = null } = {}) {
  const sent = [];
  return {
    sent,
    ctx: {
      chat: {
        yeaftAgentId,
        currentAgent,
        sendWsMessage: (msg) => { sent.push(msg); },
      },
      vpStore,
      form: { agentId: formAgentId },
    },
  };
}

describe('SessionCreateModal subscribeVpsFor — agentId is stamped on the wire', () => {
  it('uses form.agentId when present (top of the precedence chain)', () => {
    const { sent, ctx } = makeCtx({
      formAgentId: 'agt_alice',
      yeaftAgentId: 'agt_zeta',
      currentAgent: 'agt_zeta',
    });
    SessionCreateModal.methods.subscribeVpsFor.call(ctx, 'agt_alice');
    expect(sent).toEqual([{ type: 'yeaft_vp_subscribe', agentId: 'agt_alice' }]);
  });

  it('falls back to chat.yeaftAgentId when caller passes null', () => {
    const { sent, ctx } = makeCtx({
      yeaftAgentId: 'agt_zeta',
      currentAgent: 'agt_other',
    });
    SessionCreateModal.methods.subscribeVpsFor.call(ctx, null);
    expect(sent).toEqual([{ type: 'yeaft_vp_subscribe', agentId: 'agt_zeta' }]);
  });

  it('falls back to chat.currentAgent when both caller and yeaftAgentId are null', () => {
    const { sent, ctx } = makeCtx({ currentAgent: 'agt_chat' });
    SessionCreateModal.methods.subscribeVpsFor.call(ctx, null);
    expect(sent).toEqual([{ type: 'yeaft_vp_subscribe', agentId: 'agt_chat' }]);
  });

  it('warns instead of silently swallowing when nothing resolves', () => {
    const { sent, ctx } = makeCtx(); // all null
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    SessionCreateModal.methods.subscribeVpsFor.call(ctx, null);
    expect(sent).toEqual([]); // nothing sent — no agent to route to
    expect(warn).toHaveBeenCalledTimes(1);
    // The warn message should mention the symptom (cannot subscribe)
    // so a Future Me grepping `console.warn` lands on the right spot.
    expect(warn.mock.calls[0][0]).toMatch(/cannot subscribe/i);
    warn.mockRestore();
  });

  it('skips re-subscribing when the cached snapshot is already for the target agent', () => {
    const { sent, ctx } = makeCtx({
      formAgentId: 'agt_alice',
      vpStore: { lastSnapshotAt: 12345, lastVpSnapshotAgentId: 'agt_alice' },
    });
    SessionCreateModal.methods.subscribeVpsFor.call(ctx, 'agt_alice');
    expect(sent).toEqual([]); // already fresh — no wire traffic
  });

  it('DOES re-subscribe when the cached snapshot is for a DIFFERENT agent (dropdown switch)', () => {
    const { sent, ctx } = makeCtx({
      formAgentId: 'agt_bob',
      vpStore: { lastSnapshotAt: 12345, lastVpSnapshotAgentId: 'agt_alice' },
    });
    SessionCreateModal.methods.subscribeVpsFor.call(ctx, 'agt_bob');
    expect(sent).toEqual([{ type: 'yeaft_vp_subscribe', agentId: 'agt_bob' }]);
  });

  it('re-subscribes when no snapshot has been received yet (legacy single-agent path)', () => {
    const { sent, ctx } = makeCtx({
      formAgentId: 'agt_alice',
      vpStore: { lastSnapshotAt: 0, lastVpSnapshotAgentId: null },
    });
    SessionCreateModal.methods.subscribeVpsFor.call(ctx, 'agt_alice');
    expect(sent).toEqual([{ type: 'yeaft_vp_subscribe', agentId: 'agt_alice' }]);
  });
});
