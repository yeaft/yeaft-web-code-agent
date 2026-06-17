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
  description: {
    en: `Hand this turn off to another VP in the same session.

Use this tool — NOT free-text @mentions — to route a question or task to
another VP. VP-authored @mentions in chat text are NOT automatically routed
(the coordinator only text-routes user messages); you must call RouteForward
for the hand-off to take effect.

In a multi-VP session, treat RouteForward as the required hand-off mechanism:
- If the user names another VP, call RouteForward to that vpId.
- If another VP clearly owns the domain or should continue the work, call RouteForward instead of only mentioning them.
- If the task needs parallel collaboration, call RouteForward to that vpId or "all".

Arguments:
  - to (string): target vpId, or the literal "all" to broadcast to every
    other member of the session (subject to the session fan-out cap).
  - text (string): the message body to send on your behalf.
  - reason (string, optional): short rationale for the forward, recorded on
    the message meta for audit / UI display.

Rules:
  - Forwarding to yourself is rejected (self_forward_rejected).
  - Forwarding to a non-member is rejected (target_not_in_roster).
  - Forwards carry a causedBy chain; chains deeper than 10 hops are blocked
    (chain_depth_exceeded).
  - A single target may be forwarded to at most 8 times per 5-second window
    per session (throttled).

Returns JSON: { ok, dispatched?, error?, detail? }.`,
    zh: `将当前 turn 转交给同一 session 中的另一个 VP。

使用此工具 — 而不是在聊天文本中 @提及 — 将问题或任务路由给其他 VP。
VP 在聊天文本中写的 @提及不会自动路由（协调器只对用户消息做文本路由）；
你必须调用 RouteForward 才能使转交生效。

在多 VP session 中，将 RouteForward 视为必需的转交机制：
- 如果用户点名另一个 VP，调用 RouteForward 到该 vpId
- 如果另一个 VP 明显负责该领域或应继续工作，调用 RouteForward 而不是仅仅提及他们
- 如果任务需要并行协作，调用 RouteForward 到目标 vpId 或 "all"

参数：
  - to (string)：目标 vpId，或字面量 "all" 广播给 session 中所有其他成员
  - text (string)：以你的名义发送的消息正文
  - reason (string, 可选)：转交的简短原因，记录在消息元数据中用于审计/UI 展示

规则：
  - 转交给自身会被拒绝（self_forward_rejected）
  - 转交给非成员会被拒绝（target_not_in_roster）
  - 转发带有 causedBy 链；超过 10 跳的链会被阻断（chain_depth_exceeded）
  - 同一 session 中每个目标在 5 秒窗口内最多被转发 8 次（throttled）

返回 JSON：{ ok, dispatched?, error?, detail? }。`,
  },   parameters: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description: { en: 'Target vpId, or "all" for broadcast', zh: '目标 vpId，或 "all" 广播给所有人' },
      },
      text: {
        type: 'string',
        description: { en: 'The message body to forward', zh: '要转发的消息正文' },
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
        sourceThreadId: ctx.threadId ?? null,
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
    // task-707: hand off control. Successful forward means the originating
    // turn should NOT continue generating — the target VPs are now in
    // charge. Signal the engine to break the tool-loop after this batch.
    // The structured payload lands on `turn_end.detail` as audit metadata
    // (kind, fromVpId, dispatched, broadcast, text, reason); the frontend
    // renders the hand-off as a Route tool chip from the tool_call
    // envelope already on the wire (see PR #793 — the previous
    // `group_handoff` UI event was removed when its single consumer was).
    if (typeof ctx.requestEndTurn === 'function') {
      try {
        ctx.requestEndTurn({
          kind: 'route_forward',
          fromVpId: senderVpId,
          dispatched: result.dispatched.slice(),
          broadcast: Boolean(result.report?.broadcast),
          text,
          reason: reason || null,
        });
      } catch { /* never block the tool path on a UX hint */ }
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
