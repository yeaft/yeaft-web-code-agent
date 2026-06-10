# 选择会话后端

Yeaft 把三种 AI 后端摆在同一个 Web 界面里，你可以按任务选择。三者**不互斥** — 同一台 Agent 上可以同时跑 Claude Code 会话、Copilot 会话和 Yeaft 会话，互不干扰。

| 后端 | 适合场景 | 不适合场景 |
| --- | --- | --- |
| **Claude Code Chat** | 长项目协作、复杂代码理解、需要 `/skills` 和 MCP 工具 | 没装 Claude Code CLI、追求最低成本 |
| **Copilot 模式** | 已有 GitHub Copilot 订阅、想用 GPT-5 / Gemini / Claude 任选一个、ACP 标准化协议 | 需要 `/compact`、需要 Claude 专有的 skill 系统 |
| **Yeaft 会话** | 多 VP 并行讨论、跨会话持久记忆、自定义 VP（人格 + 模型 + 工具） | 单线程一对一对话（Yeaft 会话目前是多 VP） |

## 三个后端的本质区别

### Claude Code Chat（基于 Claude Code CLI 的 1:1 对话）

- 每个会话对应一个 Claude Code CLI 子进程
- 全套 Claude Code 能力：skills、MCP、subagents、`/compact`、`/clear`、`/btw`
- 工具调用走 Claude Code 自己的 stream-json 协议
- 会话历史存在 `~/.claude/projects/` 下，可以恢复

### Copilot 模式（基于 GitHub Copilot CLI 的 1:1 对话）

- 每个会话对应一个 `copilot --acp` 子进程，走 ACP（Agent Client Protocol）
- 多模型可选（Claude Sonnet 4.x / Claude Opus 4.x / GPT-5.x / Gemini 2.5 Pro 等），按 GitHub Copilot 订阅决定
- 工具权限通过 **ask-user 弹窗**实时确认（可选开启 "Allow all tools" 跳过）
- 会话历史存在 `~/.copilot/session-store.db`，可以恢复

### Yeaft 会话（自有引擎的多 VP 协作）

- 不依赖任何外部 CLI — Yeaft 自带 query loop、记忆、工具
- 一个 session 里可以放多个 **VP（Virtual Person）** — 每个 VP 有自己的人格、模型、工具集
- 一个用户消息可以**并行 fan-out** 到多个 VP，每个 VP 同时回复
- **H2-AMS 持久记忆** — 跨会话保留 vp / group / user / feature / global 级 scope
- 多 provider LLM：用 `~/.yeaft/config.json` 配 OpenAI / Anthropic / GitHub Copilot 任意组合

## 怎么在 UI 上选

### Chat / Crew 模式（Claude Code 或 Copilot）

侧边栏 `+` 新建会话，会弹出会话配置框：

1. 选 **Agent**（机器）
2. 选 **Provider**：`Claude Code` 或 `Copilot`
3. 选 **工作目录**
4. 若选了 Copilot，会出现 **模型选择器**和 **Allow all tools** 复选框

### Yeaft 会话

侧边栏顶部 tab bar 切到 **Yeaft**，再用 `+` 新建 session：

1. 输入 session 名称
2. 勾选这次想拉进来的 VP（VP 在 VP Library 里维护，可复用）
3. 把 user message 发到 session，VP 们会**并行**响应（用 `@VP名` 定向到子集）

## 我应该用哪个？

- **每天写代码 + 已经在用 Claude Code** → Claude Code Chat
- **更便宜 / 想用 GPT-5 / 公司有 Copilot Enterprise** → Copilot 模式
- **想让"PM + Dev + Reviewer"同时跟你讨论一个 feature** → Crew 模式（基于 Claude Code）
- **想让多个 VP 长期记住你 / 跨任务延续记忆 / 自由组合 OpenAI + Anthropic** → Yeaft 会话

下一步：

- [Claude Code Chat](./chat-mode.md)
- [Copilot 模式](./copilot-mode.md)
- [Yeaft 会话](./yeaft-group.md)
