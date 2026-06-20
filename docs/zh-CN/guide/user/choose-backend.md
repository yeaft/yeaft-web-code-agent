# 选择代码 Agent 路径

Yeaft Web Code Agent 把三条执行路径放在同一个 Web UI 里。它们**不互斥**：同一台已连接 Agent 可以同时运行 Claude Code 会话、Copilot 会话和 Yeaft 原生 Code Agent Session。

| 路径 | 适合场景 | 不适合场景 |
| --- | --- | --- |
| **Claude Code Chat** | 长项目协作、复杂代码理解、Claude Code `/skills` 和 MCP 工具 | 没装 Claude Code CLI；必须避免 vendor CLI 依赖的工作流 |
| **Copilot 模式** | 已有 GitHub Copilot 订阅、通过 ACP 切 GPT/Claude/Gemini、需要 per-call 权限弹窗 | 需要 `/compact`；依赖 Claude-only skill 行为 |
| **Yeaft Code Agent** | 原生多 provider 编码、1..N 个 VP、持久记忆、自定义工具策略、混用 provider | 必须完全复刻 Claude Code CLI 行为的场景 |

## 本质区别

### Claude Code Chat

- 每个 chat session 对应一个 Claude Code CLI 子进程。
- 全套 Claude Code 能力：skills、MCP、subagents、`/compact`、`/clear`、`/btw`。
- 工具调用走 Claude Code stream-json 协议。
- 会话历史存在 `~/.claude/projects/` 下，可以恢复。

### Copilot 模式

- 每个 chat session 对应一个 `copilot --acp` 子进程。
- 可用模型由你的 GitHub Copilot 权益决定。
- 工具权限通过 ask-user 弹窗逐次确认；UI 也可开启 "Allow all tools"。
- 会话历史存在 `~/.copilot/session-store.db`，可以恢复。

### Yeaft Code Agent

- 不依赖任何外部 CLI。原生引擎、记忆、工具和 LLM router 都随 `yeaft-agent` 打包。
- 一个 Session 可以放一个或多个 **VP（Virtual Person）**。每个 VP 都有自己的人格、模型、记忆和工具 allowlist。
- 一条用户消息可以并行 fan-out 给多个 VP。
- **H2-AMS 持久记忆**跨任务保留 user / VP / Session / feature scope。
- 多 provider LLM 路由通过 `~/.yeaft/config.json` 支持 Anthropic、OpenAI Responses、GitHub Copilot 动态凭证、Azure/OpenAI-compatible gateway 和本地 proxy。

## UI 上怎么选

### Claude Code Chat 或 Copilot 模式

侧边栏 `+` 会打开 session config modal：

1. 选 **Agent**（机器）。
2. 选 **Provider**：`Claude Code` 或 `Copilot`。
3. 选 **工作目录**。
4. 如果选 Copilot，会出现模型和权限选项。

### Yeaft Code Agent

侧边栏顶部切到 **Yeaft**，再用 `+` 创建 Session：

1. 输入 Session 名称。
2. 从 roster 里选择可复用 VP。
3. 选择默认 VP。
4. 发送消息；用 `@VPName` 定向给部分 VP。

## 我应该用哪个？

- **每天用 Claude Code，需要精确 Claude 行为** → Claude Code Chat。
- **有 Copilot Enterprise，或想要 ACP 权限弹窗 / Copilot 模型目录** → Copilot 模式。
- **想让 PM + Dev + Reviewer 带长期记忆并行思考** → Yeaft Code Agent。
- **想在同一个任务上比较 Anthropic、OpenAI、Copilot 或 proxy** → 多 VP 的 Yeaft Code Agent。
- **想要基于 Claude Code 的结构化 feature team** → Crew 模式。

下一步：

- [Claude Code Chat](./chat-mode.md)
- [Copilot 模式](./copilot-mode.md)
- [Yeaft Code Agent](./yeaft-group.md)
