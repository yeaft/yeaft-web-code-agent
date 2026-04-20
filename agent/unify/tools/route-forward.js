/**
 * route-forward.js — VP-facing `route_forward` tool (task-334d).
 *
 * VPs cannot trigger @-routing by writing @foo into chat text (that's the
 * user-only coordinator branch from §6). To hand a turn to another VP, the
 * VP must call this tool.
 *
 * Tool contract:
 *   route_forward({ to, text, reason? }) → status JSON
 *     - to:     target vpId, OR the literal 'all' for broadcast
 *     - text:   the message body to relay
 *     - reason: optional string — why we're forwarding; logged on meta
 *
 * Ctx expectations (supplied by RoleInstance Engine wiring):
 *   ctx.router         — createRouter() instance for the active group
 *   ctx.senderVpId     — the VP that owns the running turn
 *   ctx.inboundEnvelope — the envelope currently being processed (loop guard)
 *   ctx.taskId         — current task scope, if any
 *   ctx.taskMembers    — optional member allowlist for task-scoped groups
 *
 * Return is always a JSON string so the LLM can reason about ok/error. On
 * failure the tool does NOT throw (that would kill the turn); it returns
 * `{ ok: false, error }` so the VP can pivot (apologise, retry, ...).
 */

import { defineTool } from './types.js';

export default defineTool({
  name: 'RouteForward',
  description: `Hand this turn off to another VP in the same group.

Use this tool — NOT free-text @mentions — to route a question or task to
another VP. VP-authored @mentions in chat text are NOT automatically routed
(the group coordinator only text-routes for user messages); you must call
RouteForward for the hand-off to take effect.

Arguments:
  - to (string): target vpId, or the literal "all" to broadcast to every
    other member of the group (subject to the per-group fan-out cap).
  - text (string): the message body to send on your behalf.
  - reason (string, optional): short rationale for the forward, recorded on
    the message meta for audit / UI display.

Rules:
  - Forwarding to yourself is rejected (self_forward_rejected).
  - Forwarding to a non-member is rejected (target_not_in_roster).
  - Forwards carry a causedBy chain; chains deeper than 10 hops are blocked
    (chain_depth_exceeded).
  - A single target may be forwarded to at most 8 times per 5-second window
    per group (throttled).

Returns JSON: { ok, dispatched?, error?, detail? }.`,
  parameters: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description: 'Target vpId, or "all" for broadcast',
      },
      text: {
        type: 'string',
        description: 'The message body to forward',
      },
      reason: {
        type: 'string',
        description: 'Optional: short rationale for the forward',
      },
    },
    required: ['to', 'text'],
  },
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  async execute(input, ctx = {}) {
    const { to, text, reason } = input || {};
    if (!to || typeof to !== 'string') {
      return JSON.stringify({ ok: false, error: 'to_required' });
    }
    if (typeof text !== 'string' || text.length === 0) {
      return JSON.stringify({ ok: false, error: 'text_required' });
    }
    const router = ctx.router;
    const senderVpId = ctx.senderVpId;
    if (!router || typeof router.forward !== 'function') {
      return JSON.stringify({ ok: false, error: 'router_unavailable' });
    }
    if (!senderVpId) {
      return JSON.stringify({ ok: false, error: 'sender_unknown' });
    }

    const result = router.forward(
      {
        from: senderVpId,
        to,
        text,
        reason: reason || null,
        taskId: ctx.taskId ?? null,
        inboundEnvelope: ctx.inboundEnvelope ?? null,
      },
      { taskMembers: ctx.taskMembers },
    );

    if (!result.ok) {
      return JSON.stringify({
        ok: false,
        error: result.error,
        detail: result.detail || null,
      });
    }
    return JSON.stringify({
      ok: true,
      dispatched: result.dispatched,
      broadcast: Boolean(result.report?.broadcast),
      truncatedAtFanOutCap: Boolean(result.report?.truncatedAtFanOutCap),
      errors: result.report?.errors || [],
    });
  },
});
