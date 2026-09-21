# 选择代码 Agent 路径

Yeaft 在同一个浏览器中提供三条执行路径。一台已连接 Agent 可以同时运行三者，但每条路径保留自己的 runtime 与兼容边界。

| 路径 | 最适合 | Runtime / 边界 |
| --- | --- | --- |
| **Claude Code** | 精确的 Claude Code 工具、skills、MCP、compact/clear 命令、sub-agent event 和 resume 行为 | 每个 conversation 一个本机已安装并登录的 Claude Code CLI 进程 |
| **GitHub Copilot** | Copilot entitlement、ACP 工具权限确认和 Copilot model catalog | 每个 conversation 一个本机已安装并登录的 `copilot --acp` 进程 |
| **Yeaft Code Agent** | 原生 provider routing、1..N 个 VP、33 个内置工具、scoped memory、Project、sub-agent 和 Work Center | `yeaft-agent` 内的原生 engine；不模拟所有 vendor CLI command |

## Claude Code

当 Claude Code CLI 兼容性比 provider neutrality 更重要时选择 Claude Code。

- Agent 启动 CLI conversation，并把 stream-json event 归一化给 Web UI。
- Claude Code 拥有自己的 CLI session 与 command semantics。
- Yeaft Web UI 可以显示 provider 暴露的 streaming text、tools、files、sub-agent、context action 和 resume history。
- Expert Panel 是 Claude Code conversation helper，不是原生多 VP Session system。

## GitHub Copilot

当 Agent 机器已有可用 Copilot 环境，并且需要 ACP 行为时选择 Copilot。

- Agent 启动 `copilot --acp`，并将 ACP event 转换到共享 browser renderer。
- 可用 model 取决于 live Copilot catalog 和本机账号 entitlement。
- Tool call 可以要求 allow once、allow always 或 deny。
- Copilot persistence 与不支持的命令遵循已安装 CLI，不等同于 Claude Code 行为。

## Yeaft Code Agent

当你需要产品级编排，而不是精确 CLI 兼容时选择原生引擎。

- Session 包含 1..N 个可复用 VP 和一条持久 timeline。
- `@mention` 可以把一个 turn fan-out 给多个 VP；`RouteForward` 记录明确 peer handoff。
- 原生 turn 使用自身 Session history 的有界窗口；旧 Dream/H2-AMS memory 和兄弟 Session summary 不会注入。
- 原生 provider 通过 Anthropic Messages 或 OpenAI Responses adapter 路由，也支持已实现的 GitHub Copilot dynamic credential 与 compatible gateway。
- 当前 built-in registry 有 33 个工具；Skills 与 MCP 可以继续增加。
- Session 可以创建 Agent-level WorkItem，用于持久、可规划、可恢复的工作。

## 如何创建

在统一侧栏使用 **新建聊天**：

1. 选择拥有目标目录的 Agent。
2. 选择 **Claude Code**、**Copilot** 或 **Yeaft**。
3. 输入工作目录和 runtime-specific options。
4. 对 Yeaft，选择 Session roster/default VP；创建后在 composer 选择 model/effort，在 Session settings 编辑公告。

侧栏 catalog 可以展示多台 Agent 的 conversation。Runtime identity 始终包含 Agent；两台 Agent 上相同 Session ID 并不是同一个 Session。

## 常见选择

- 精确 Claude Code workflow 或 Claude-specific skills → **Claude Code**。
- 已有 Copilot subscription，需要 ACP permission flow → **GitHub Copilot**。
- 一个带记忆、provider-neutral 的代码 Agent → **只有 1 个 VP 的 Yeaft Session**。
- 并行 developer/reviewer/research 角色 → **多个 VP 的 Yeaft Session**。
- 需要 Action planning、等待、重试或恢复的持久目标 → **Work Center**，通常可以从 Yeaft Session 创建。

## 相关页面

- [Claude Code conversation](./chat-mode.md)
- [GitHub Copilot conversation](./copilot-mode.md)
- [Yeaft Session 与 Project](./yeaft-session.md)
- [Work Center](./work-center.md)
