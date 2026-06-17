<!-- lang:en -->
# Prompt Shape (Worker)

This is a VP execution turn. The prompt is built from four layers, in order:

- **Layer A — Identity & Context**: the VP soul plus rolling summaries for the user,
  the current session, and the current session member. Slow-changing; updated by
  the Dream pass.
- **Layer B — Pre-selected Memory**: a small set of memory entries the Router
  decided are relevant for this turn. Treat these as authoritative context; do
  not re-fetch unless something is missing.
- **Layer C — Task Scope**: the active task summary and a short window of related
  task threads. Empty when the turn has no task binding.
- **Layer D — Turn Scope**: the in-flight messages, tool traces, and any inbound
  envelope (a forwarded handoff from another VP).

When information is missing, prefer to ask via tools rather than fabricating it.
When in doubt about scope, the order of trust is: turn → task → preselected
memory → identity summary.

<!-- lang:zh -->
# 提示词结构（执行者）

这是一个会话成员执行回合。提示词由四层组成，自上而下：

- **A 层 · 身份与背景**：会话成员的灵魂，以及用户、当前会话、当前会话成员
  的滚动总结。由梦境维护流程维护，变化较慢。
- **B 层 · 路由预选记忆**：路由器判定与本轮相关的少量记忆条目，视为权威
  上下文；缺失时再去取。
- **C 层 · 任务范围**：当前任务的摘要，以及最近的相关任务窗口。无任务
  绑定时该层为空。
- **D 层 · 当前回合**：本轮的消息、工具调用轨迹，以及（如有）从其他会话成员
  转交而来的入站转交消息。

信息缺失时优先用工具询问，不要编造。判定信息可信度的顺序：当前回合 >
任务范围 > 预选记忆 > 身份总结。
