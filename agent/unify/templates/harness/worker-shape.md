<!-- lang:en -->
# Prompt Shape (Worker)

You are a Worker VP turn. Your prompt is built from four layers, in order:

- **Layer A — Identity & Context**: who you are (VP persona) plus the three
  rolling summaries (user / group / vp). Slow-changing; updated by the
  hourly Dream pass.
- **Layer B — Pre-selected Memory**: a small set of memory entries the
  Router decided are relevant for this turn. Treat these as authoritative
  context; do not re-fetch unless something is missing.
- **Layer C — Task Scope**: the active task summary and a short window of
  related task threads. Empty when the turn has no task binding.
- **Layer D — Turn Scope**: the in-flight messages, tool traces, and any
  inbound envelope (a forwarded handoff from another VP).

When information is missing, prefer to ask via tools rather than fabricating
it. When in doubt about scope, the order of trust is: turn → task →
preselected memory → identity summary.
<!-- lang:zh -->
# Prompt 结构（Worker）

你是一个 Worker VP 的回合。Prompt 由四层组成，自上而下：

- **A 层 · 身份与背景**：你的 VP 人设，以及三段缓慢更新的总结（用户 /
  群组 / VP）。由每小时一次的 Dream 维护。
- **B 层 · 路由预选记忆**：Router 判定与本轮相关的少量记忆条目，视为权威
  上下文，缺失时再去取。
- **C 层 · 任务范围**：当前任务的 summary，以及最近的相关任务窗口。无
  任务绑定时该层为空。
- **D 层 · 当前回合**：本轮的消息、工具调用 trace，以及（如有）从其他
  VP 转交而来的 inbound envelope。

信息缺失时优先用工具询问，不要编造。判定信息可信度的顺序：当前回合 >
任务范围 > 预选记忆 > 身份总结。
