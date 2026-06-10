# Yeaft Group Mode

Yeaft Group Mode 是 Yeaft 自有 AI 引擎的当前主要使用形态 — 一个 group 里放多个 VP（Virtual Person，可自定义人格 / 模型 / 工具的虚拟人），一条用户消息可以**并行 fan-out** 到多个 VP，每个 VP 独立回复，共享一套**跨会话持久记忆**。

> Yeaft 也规划了 **Chat Mode**（单 VP 1:1 对话），但目前**尚未实现**。本章只讲 Group Mode。

## 与 Claude Code Chat / Copilot 模式的本质区别

- **不依赖任何外部 CLI** — Yeaft 自己跑 query loop（agent/yeaft/engine.js），自带工具集
- **多 VP 并行** — 一句话同时让 PM、Dev、Reviewer 给意见，不用切会话
- **跨任务记忆** — Yeaft 的 H2-AMS 记忆系统按 scope 持久化（user / vp / group / feature / global），跨会话也记得你
- **多 provider** — 同一个 group 里的不同 VP 可以用不同的 model（一个用 Claude，一个用 GPT-5，一个用 Copilot）

## 进入 Yeaft 页

侧边栏顶部的 tab bar 切到 **Yeaft** 即可。第一次进入时，Yeaft 会跟它绑定的 Agent 握手，建立一个**虚拟 conversationId**（不占 Claude Chat / Copilot 的会话槽）。

> 同一台 Agent 可以同时跑 Claude Code 会话、Copilot 会话和 Yeaft — 互不干扰。

## 建一个 Group

1. Yeaft 页侧栏点 **+** 新建 group
2. **Group 名** — 比如 "周报评审"、"重构讨论"
3. **添加 VP** —
   - **VP 名** — 显示名，如 "PM"、"Dev"、"Reviewer"
   - **Persona**（可选）— 选预置人格（Jobs / Torvalds / Fowler / Rams / Beck 等）或留空走默认
   - **Model** — 从你 `~/.yeaft/config.json` 里配的所有 provider/model 组合里挑（如 `my-proxy/claude-sonnet-4.5`、`github-copilot/gpt-5`）
   - **工具** —（可选）勾选这个 VP 能用的工具子集；不勾就给完整 40+ 工具
4. **创建**

## 跟 Group 对话

进入 group 后，输入框跟 Chat 模式类似。差别在：

- **@mention 选择 VP**：`@PM @Reviewer 看看这版周报`
  - 不写 @ 默认 fan-out 到 group 里所有 VP
  - 写了 @，只发给被点名的 VP
- **VP 并行响应** — 每个被点名的 VP 在独立的 turn 里跑 query loop，完成时间不一致，UI 按 VP 分组渲染
- **附件**支持 — 跟 Chat 一样拖拽 / 粘贴上传

## 记忆系统能干什么

Yeaft 后台有一套 **H2-AMS（Active Memory Set）** 记忆系统，工作方式是：

1. **每 turn 前**：Yeaft 跑 FTS5 全文索引召回相关 scope 的记忆段，注入到 system prompt
2. **每 turn 后**（每个 session 每个 group 最多一次）：用 LLM 修正 AMS（Active Memory Set）
3. **后台 dream 维护**：把对话历史切成原子记忆段，存到对应 scope 的 markdown 文件

你看到的效果：
- VP 记得你上次告诉过它的事情（哪怕跨了好几个 session）
- group 里的 VP 共享 group scope 的记忆，但每个 VP 也有自己的 vp scope 私有记忆
- 你的 profile / preference 走 user scope，所有 group 的所有 VP 都能在 preflow 里读到

> 记忆都存在 Agent 机器的 `~/.yeaft/<scope>/segments/*.md` — 是普通 markdown 文件，可以直接看、备份、迁移。

## 调试面板

Yeaft 页有一个 **Debug 面板**（侧栏底部图标打开），显示：

- 当前 group 每个 VP 的 turn 历史
- 每个 turn 的：召回的记忆段、发给 LLM 的 messages、收到的 tool_calls、最终回复
- Token / cost 统计
- LLM provider / model 路由结果

适合：
- 想知道为什么 VP 给了这个回答 — 看它召回了什么记忆
- 想优化记忆系统 — 看哪些段被命中、哪些没命中
- 想调试新加的工具 — 看 tool_call 的入参 / 出参

## 工具

Yeaft 引擎内置 40+ 工具，按类别：

- **文件**：file_read / file_write / file_edit / apply_patch / notebook_edit
- **搜索**：grep / glob / list_dir / history_search
- **执行**：bash / js_repl / enter_worktree / exit_worktree
- **网络**：web_fetch / web_search / image_generation / view_image
- **编排**：agent（派生子 Agent）/ send_message / wait_agent / close_agent / list_agents / route_forward（VP→VP 显式 handoff）
- **任务**：todo_write / start_plan
- **对外**：ask_user / skill / mcp_tools

VP 是否能用某个工具，由 group 创建时的工具白名单 + tool registry 的 mode 过滤共同决定。

## 常见使用模式

### 模式 A：决策评审

建一个 group，放 3-4 个不同 persona 的 VP（如 PM-Jobs + Dev-Torvalds + Architect-Fowler + Designer-Rams），把你的方案丢进去，让它们**并行**给意见。比起一对一切换 persona 高效得多。

### 模式 B：长项目助手

建一个 group，放一个 default VP，把它当成你这个项目的"专属助手"。Yeaft 的记忆会让它逐渐记住你的代码库、风格偏好、决策历史。

### 模式 C：跨 VP handoff

用 `route_forward` 工具，让 VP 之间显式 handoff —— PM VP 拆完需求把任务丢给 Dev VP，Dev VP 写完代码把 PR 丢给 Reviewer VP。

## 跟 Crew 模式的区别

- **Crew** 跑在 Claude Code 之上（每个角色是一个 Claude CLI 进程），有完整的 Claude Code 能力但只有一种 model
- **Yeaft Group Mode** 跑在 Yeaft 引擎之上，每个 VP 可以选不同 provider/model，自带持久记忆，但工具集与 Claude Code 不完全等同

如果你的诉求是 "多 AI 角色协作做一个具体 feature"，两者都可以。如果你需要"跨 session 持久记忆 + 自由组合多 provider"，选 Yeaft Group Mode；如果你需要"Claude Code 的完整 skill / MCP 生态 + 标准开发流水线"，选 Crew。

## 进阶

- 配置自定义 provider / model：见 [Yeaft 引擎配置](../yeaft-config.md)
- 引擎工作原理：见 [Yeaft 引擎](../tech/yeaft-engine.md)
- 记忆系统设计：见 [Yeaft 记忆系统（H2-AMS）](../tech/yeaft-memory.md)
- LLM 路由 / 多 provider：见 [Yeaft LLM 层](../tech/yeaft-llm.md)
