# 什么是 Yeaft？

Yeaft Web Code Agent 是运行在已连接机器上的代码 Agent 的浏览器控制面。它把 vendor CLI conversation 与 Yeaft 原生多 provider 引擎放在一起，而不是强迫所有任务使用同一个 provider 或 runtime。

![包含实现与审查 VP 的原生 Yeaft Session](/images/zh-CN/session.png)

## 用五个对象理解系统

| 对象 | 职责 |
| --- | --- |
| **Agent** | 运行在代码所在机器。执行工具、启动可选 CLI provider、调用原生 LLM provider，并保存 Agent-local Yeaft 数据。 |
| **Session** | 原生引擎的持久对话单元。包含 1..N 个 VP、一个 timeline、工作目录、模型设置、公告和 scoped memory。 |
| **VP** | 可复用 Virtual Person，包含 persona、双语角色元数据、traits 和 primary/fast model hint。 |
| **Project** | 对原生 Session 分组并提供共享 instruction；不会合并或自动注入兄弟 Session transcript。 |
| **WorkItem** | Work Center 的持久目标，由 Action 规划并通过有 fence 的 Run 执行。它属于 Agent，可以长于来源 Session 的一次 turn。 |

1 个 VP 的 Session 就是普通专注代码 Agent。增加 VP 不会切换到另一种 mode，只是让同一个 Session 可以并行点名更多角色。

## 选择执行路径

| 路径 | 适用情况 | Runtime 边界 |
| --- | --- | --- |
| **Claude Code** | 需要 Claude Code 精确的工具、skills、MCP、compact/clear 命令和 resume 行为 | 每个 conversation 一个本机 Claude Code CLI 进程 |
| **GitHub Copilot** | 需要 Copilot entitlement、ACP 权限确认和 Copilot model catalog | 每个 conversation 一个本机 `copilot --acp` 进程 |
| **Yeaft Code Agent** | 需要 provider-neutral 原生执行、1..N 个 VP、scoped memory、Project、33 个工具或 Work Center handoff | `yeaft-agent` 内的原生 engine，不启动 vendor CLI 子进程 |

三条路径在 event model 重叠处共用导航与渲染，但 provider-specific 命令和持久化语义仍明确分开。参见[选择代码 Agent 路径](./user/choose-backend.md)。

## 原生 Session 协作

Yeaft Session 可以：

- 把一个 user turn 交给 default VP，或交给多个被 `@mention` 的 VP；
- 在共享 timeline 中展示每个 VP 的流式回复和工具证据；
- 使用 `RouteForward` 在当前 Session 成员之间明确交接；
- 运行有持久状态记录的后台 shell job 和 sub-agent；
- 搜索与分页加载已持久化 history；
- 检查模型路由、token 用量、工具调用和 stop reason；
- 在工作需要跨越当前交互 turn 时创建持久 WorkItem。

Project 提供组织和受控的上下文共享。Project instruction 会注入每个成员 Session，但不会自动召回或注入兄弟 Session transcript 与旧 summary。

## 用 Work Center 承载持久工作

![包含持久 WorkItem 和规划 Action 的 Work Center](/images/zh-CN/work-center.png)

Work Center 是 Agent 级任务系统，不是第二种 conversation mode。WorkItem 保存目标、acceptance criteria、工作目录、attachments 和自己的 Coordinator conversation。AI triage 可以生成经过校验的 Action graph；scheduler 会分配合适的 VP，并在配置的并发上限内执行 ready Action。

当前 Work Center 包括：

- 有依赖校验且只有一个 final acceptance gate 的 Action graph；
- auto、pool、fixed VP assignment，以及 review 的可选角色隔离；
- per-Action model/effort policy 和明确的 workspace policy；
- shared、read-only、isolated-write 与 integration 执行路径；
- waiting、retryable、failed、cancelled 和 completed outcome；
- 发给 Coordinator 或指定 Action 的人工指导；
- 持久 Run identity、usage、messages、tool evidence 和重启恢复。

WorkItem 会关联来源 Session，但生命周期和 SQLite 数据属于 Agent 的 Work Center。

## Provider、工具与记忆

原生 LLM 层支持 Anthropic Messages 和 OpenAI Responses 协议。Provider 可以使用静态 API key，也可以使用已支持的 GitHub Copilot 动态凭据；每个 model 还可以 override protocol 和 limit。

原生 registry 当前包含 33 个内置工具，覆盖文件、patch、shell/background task、Git worktree、搜索、Web、图片、notebook、计划、WorkItem 创建，以及 agent/VP 编排。Skills 和 MCP server 还可以添加工具，因此最终工具表取决于 Agent 与 Session policy。

Dream/H2-AMS 已从当前 runtime 退役。原生 turn 使用当前 Session 持久历史的有界窗口，不召回或注入旧 memory 或兄弟 Session summary。Agent 上已有 memory 文件会保留；turn 后 compact 是独立的 history-window 能力。

## 浏览器工作区

除了原生引擎，Web application 还提供：

- Agent-aware 的统一 Session catalog，包含 Project 与 Recents；
- terminal、Git status/diff、file browser/editor 和 port proxy；
- 最多三个并排的 Claude Code/Copilot conversation pane；
- Claude Code conversation 的 Expert Panel；
- Work Center board、WorkItem conversation、Action 检查和保留的执行证据；
- 中英文切换和 light/dark theme；
- 登录认证、可选 TOTP/邮件验证、用户级 Agent secret 和管理页面。

## 所有权与安全边界

代码执行和原生 Yeaft runtime data 留在 Agent。中央 Server 认证用户、保存浏览器侧账号/catalog metadata，并中继经过 owner check 的 WebSocket traffic。Session 的 `workDir` 只选择 project execution context，不拥有 Session transcript、memory、tasks 或 Work Center data。

Raw tool output、debug trace、attachment、model credential 和本地 project file 都是敏感信息。在把部署暴露到受信任网络之外前，请阅读[安全](./security.md)。

## 下一步

- [本机快速开始或连接 Agent](./getting-started.md)
- [了解 Session 与 Project](./user/yeaft-session.md)
- [使用 Work Center](./user/work-center.md)
- [配置 provider 与 model](./yeaft-config.md)
- [理解整体架构](./tech/architecture.md)
