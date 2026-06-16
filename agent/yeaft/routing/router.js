/**
 * router.js — VP-side @-forward dispatch (task-334d).
 *
 * Wraps GroupCoordinator with the extra rules that apply when the sender is
 * a VP (not a user). Architecture §6:
 *
 *   - VPs do NOT trigger text-@-routing. Free-text @foo from a VP is purely
 *     surface noise. To hand off a turn, a VP must call the `route_forward`
 *     tool — which lands here.
 *   - route_forward(to, text, reason?) MUST go through Coordinator.dispatch
 *     so @all fan-out caps, task.members filtering, and persistence stay
 *     consistent with user-initiated routing.
 *   - Self-forward (to === senderVpId) is a hard tool-level error; VPs
 *     should "speak" via normal turn output, not route_forward.
 *   - Loop guard: chain depth + rate throttle (see loop-guard.js).
 *
 * Router stamps `meta.causedBy` with the full chain so downstream Coordinator
 * events carry provenance, and so the guard can refuse runaway chains even
 * after the sending VP finishes its own turn.
 *
 * Hard constraints (inherited from PM directive):
 *   (a) Does NOT touch RoleInstance state machine internals (that's 334c).
 *   (b) Does NOT touch live-diff (334h).
 *   (c) Persistence routes through group.appendMessage via Coordinator.
 *   (d) Tool schema uses defineTool (agent/yeaft/tools/types.js).
 */

import { resolveMemberId } from '../sessions/roster.js';
import { createLoopGuard, extendCausedBy } from './loop-guard.js';

/**
 * Build a router bound to a single GroupCoordinator + loop guard.
 *
 * @param {{
 *   coordinator: import('../sessions/coordinator.js').GroupCoordinator,
 *   guard?: ReturnType<typeof createLoopGuard>,
 *   now?: () => number,
 * }} deps
 */
export function createRouter(deps = {}) {
  const { coordinator } = deps;
  if (!coordinator || typeof coordinator.ingest !== 'function') {
    throw new Error('createRouter: coordinator (with ingest()) is required');
  }
  const guard = deps.guard || createLoopGuard({ now: deps.now });

  /**
   * Forward a message from a VP to another VP (or @all). Routes through
   * Coordinator so all MVP rules hold (fanout cap, task.members, persist).
   *
   * @param {{
   *   from: string,           // sender vpId (required; never 'user')
   *   to: string,              // target vpId OR 'all'
   *   text: string,
   *   reason?: string,         // optional human-readable rationale, stamped on meta
   *   taskId?: string|null,
   *   inboundEnvelope?: any,   // the envelope the sender is currently handling
   *                             // (drives causedBy chain & loop guard)
   *   sourceThreadId?: string|null, // sender-side thread that should own the visible forward row
   * }} args
   * @param {{ taskMembers?: string[] }} [opts]  — forwarded to coordinator.ingest
   * @returns {{
   *   ok: boolean,
   *   error?: string,
   *   dispatched?: string[],
   *   report?: import('../sessions/coordinator.js').DispatchReport,
   * }}
   */
  function forward(args, opts = {}) {
    if (!args || typeof args !== 'object') {
      return { ok: false, error: 'args_required' };
    }
    const from = args.from;
    const to = args.to;
    const text = args.text;

    if (!from || typeof from !== 'string') {
      return { ok: false, error: 'from_required' };
    }
    if (from === 'user') {
      // Users don't use route_forward — they type @ in chat. Policy guard.
      return { ok: false, error: 'route_forward_is_vp_only' };
    }
    if (!to || typeof to !== 'string') {
      return { ok: false, error: 'to_required' };
    }
    if (typeof text !== 'string' || text.length === 0) {
      return { ok: false, error: 'text_required' };
    }
    const meta = coordinator.group.getMeta();
    if (!meta) return { ok: false, error: 'group_not_initialised' };

    // Roster membership — `all` is reserved broadcast sentinel handled by
    // coordinator; anything else must resolve to a real member so we fail fast
    // with a VP-friendly error before hitting Coordinator. `vp-<id>` is a
    // tolerated UI/tool alias for canonical roster ids such as `linus`.
    const targetVpId = to === 'all' ? 'all' : resolveMemberId(meta, to);
    if (targetVpId !== 'all' && !targetVpId) {
      return { ok: false, error: 'target_not_in_roster' };
    }
    if (targetVpId === from) {
      return { ok: false, error: 'self_forward_rejected' };
    }

    // Build the causedBy chain BEFORE constructing the synthetic user-like
    // message. We don't know the new msgId yet (coordinator mints it on
    // appendMessage), so we only include the inbound chain + inbound msgId.
    // The guard runs against the *pre-dispatch* chain; that matches the
    // spec's intent ("depth of forwards already taken").
    const chain = extendCausedBy(args.inboundEnvelope || null, null);

    // Loop guard: for broadcast, use 'all' as the target key so one VP
    // spamming @all still gets throttled even if each cycle hits different
    // member inboxes.
    const guardKey = targetVpId;
    const verdict = guard.check({
      sessionId: meta.id,
      targetVpId: guardKey,
      chain,
    });
    if (!verdict.ok) {
      return {
        ok: false,
        error: verdict.reason,          // 'chain_depth_exceeded' | 'throttled'
        detail: verdict.detail || null,
      };
    }

    // Synthesize an injection message — coordinator's `ingest` expects the
    // {from, role, text} shape. The forwarded message is semantically the
    // SENDER VP speaking (just delivered to a different VP's inbox), so it
    // persists as role='assistant' attributed to `from`. The `meta.injectedBy`
    // stamp + `synthetic` marker let Coordinator's `selectRespondingVps`
    // still treat this like a routed turn (target VPs need to respond) even
    // though role is now 'assistant'.
    const injectText = targetVpId === 'all'
      ? `@all ${text}`
      : `@${targetVpId} ${text}`;

    const report = coordinator.ingest(
      {
        from,                  // real VP id — preserved for provenance
        role: 'assistant',     // VP-authored — persists as assistant turn
        text: injectText,
        taskId: args.taskId ?? null,
        // route_forward is already visible as the source VP's tool action.
        // Persist the synthetic handoff for audit/dispatch, but keep it out
        // of UI replay and future visible history so it doesn't render as a
        // second assistant/user block after the target VP answers.
        internal: true,
        meta: {
          synthetic: true,
          injectedBy: 'route_forward',
          senderVpId: from,
          reason: args.reason || null,
          causedBy: chain,
          sourceThreadId: typeof args.sourceThreadId === 'string' && args.sourceThreadId.trim()
            ? args.sourceThreadId.trim()
            : null,
        },
      },
      opts,
    );

    // Record AFTER Coordinator accepts. If Coordinator produced zero
    // dispatches (e.g. task.members gate) we still count it as a hit —
    // the forwarder still tried, and the guard's job is to throttle the
    // sender's ability to keep trying.
    guard.record({ sessionId: meta.id, targetVpId: guardKey });

    return {
      ok: true,
      dispatched: report.dispatched.slice(),
      report,
    };
  }

  return { forward, guard, coordinator };
}
