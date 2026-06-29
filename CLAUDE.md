# Yeaft Web Code Agent

一个 Web 端多 provider 代码 Agent 平台。对外产品名是 **Yeaft Web Code Agent**（简称 **Yeaft**）：同一套 Web UI 可以运行 Claude Code CLI、GitHub Copilot CLI，也可以运行 Yeaft 原生 Code Agent 引擎。当前重点是 Yeaft 原生引擎下的 **Session**：1..N 个 VP（Virtual Person）协作，支持持久记忆、工具调用和多 provider LLM 路由。

**Yeaft 只有 Session 一种编排单元** — 不再有 "chat mode" / "group mode" 的划分。一个 Session 默认 1 个 VP（就是 1:1 对话），可以加更多 VP 实现多人协作；区别只是 VP 数量，不是 mode。

> 名词与代码兼容：旧版本里这个东西叫 "Group"，引擎本身叫过 "Unify"。现在统一是 **Session** + **Yeaft**。代码里有一批 `unify_*` wire alias（如 `unify_group_chat` / `unify_load_history`）、`group/<id>` scope 前缀、个别 `groupId` payload / 函数参数名仍保留旧名做 wire 与磁盘兼容 — **新代码必须用 session / yeaft 术语，但不要为了去旧名做批量重命名**，会炸协议和持久化数据。详见下面的 "命名约束" 段。

## 项目结构

```
agent/           — Node.js Agent（运行在用户机器上，通过 WebSocket 连接 server）
  claude.js      — Claude CLI 封装（Claude Chat 旧模式）
  conversation.js — Claude Chat 会话管理
  sdk/           — Claude SDK 封装（query / stream / utils）
  connection/    — WebSocket 连接、消息路由、心跳
  yeaft/         — Yeaft 引擎（自包含 AI 引擎，不依赖 Claude CLI）
  workbench/     — 文件 / 终端 / git 等工作台后端
server/          — Express + WebSocket 服务（Agent 与 Web 客户端之间的中继）
  handlers/      — 消息处理器（agent-output、client-conversation 等）
web/             — 前端（Vue 3 Options API，无构建步骤，静态文件直出）
  components/    — Vue 组件（ChatPage、YeaftPage、MessageList 等）
  stores/        — Pinia store（chat.js 是主状态 store）
  styles/        — CSS 文件
test/            — Vitest 测试
```

## 模式总览

### Claude Chat 模式（旧）
- 用 Claude CLI（`agent/claude.js`）作为 AI 后端
- 每个会话 = 一个独立的 Claude CLI 进程
- 支持多 session：侧栏列出多个 chat session
- Agent 作为桥：web -> server -> agent -> Claude CLI -> agent -> server -> web

- 多 Agent 团队协作（PM、dev、reviewer、tester、designer、architect）
- 角色间通过 `---ROUTE---` 协议路由消息

### Yeaft Code Agent / Session
- **唯一编排单元** — Yeaft 原生 Code Agent 里所有对话都是 Session；没有 "chat mode" / "group mode" 之分
- **1..N 个 VP** — 一个 Session 包含 1 到 N 个 VP（Virtual Person，可配置人格 / 模型 / 工具 / 记忆）。默认 1 个 VP（专注代码 Agent），加更多 VP 就变成多人协作；同一个 user turn 可以并行 fan-out 到选中的 VP
- **自有引擎** — 不依赖 Claude CLI，自己跑 query loop（`agent/yeaft/engine.js`）
- **记忆系统** — H2-AMS 持久化记忆，支持 scope 级 recall、consolidation、dream 维护
- **多 provider LLM** — 通过 `AdapterRouter` 路由到 Anthropic、OpenAI Responses、GitHub Copilot 动态凭证、Azure/OpenAI-compatible gateway 或本地 proxy，支持 per-model protocol
- **代码 Agent 工具系统** — 30+ 个内置工具，覆盖文件/patch、shell、git worktree、Web、notebook、计划和子 Agent 编排，按 mode 与 VP 配置过滤
- **多 Agent 编排** — VP 可派生子 Agent 并行执行任务，也可用 `route_forward` 做 VP→VP 显式 handoff

## Yeaft 引擎架构（agent/yeaft/）

### 核心组件

```
engine.js        — 主 query loop（prompt -> LLM -> tool_calls -> execute -> tool folding / persist）
session.js       — Session orchestrator（loadSession 把 roster、memory、dream、tasks、VP loader 等串起来）
config.js        — 从 ~/.yeaft/config.json 读配置（providers、models、limits、runtime defaults）
config-api.js    — Web 设置页 / CLI 共用的 agent-local 配置读写 API
debug-trace.js   — Yeaft loop / tool / adapter 调试 trace 存储与查询
prompts.js       — 双语 system prompt builder（en/zh）
models.js        — Model 注册表（protocol、context/output limit、effort / thinking capability）
runtime-platform.js — 运行平台探测（shell、路径、OS 提示，供工具和 prompt 注入）
sessions/        — Session 编排（coordinator、roster、session-store、session-crud、pre-flow、config 等）
routing/         — Turn 内路由 + loop guard
router/          — Continuity / thinking 相关路由策略
memory/          — H2-AMS 记忆子系统
llm/             — LLM 适配器层（router、anthropic、openai-responses、dynamic credentials、models.dev）
tools/           — 内置工具表
tasks/           — Session-scoped 后台任务（shell background、日志、状态事件）
sub-agent/       — 子 Agent runner、liveness、output log、terminal notification 队列
tool-folding/    — V7 tool-call reflection / folding（T1 turn 内折叠、T2 end-turn 折叠、重复工具提醒）
archive/         — 冷存储辅助（tool result / turn archive 与 trace 读取）
templates/       — System prompt 模板（base.md、mode-unified.md、mode-dream.md 等）
conversation/    — Message 持久化 + 搜索
vp/              — VP store / loader / seed defaults / top-up / registry / thread classifier
stats/           — 工具用量等统计格式化
storage/         — atomic write、JSONL log、compact storage 基础设施
dream/           — 后台记忆维护
compact/         — 上下文 compact 策略
eval/            — 评估脚本
```

### Engine Query Loop（engine.js）
> 这里描述的是当前实现路径，目的是帮助维护者定位代码，不是对外稳定 API 契约。改 query loop、tool folding、debug trace、sub-agent notification 时必须同步更新本段。

1. Pre-query：召回记忆 + project docs + runtime platform + pending sub-agent notification -> 注入 system prompt / 当前 user turn
2. 构造 messages 数组（带 compact summary、reflection message、attachment payload 时一并带上）
3. 调 adapter.stream() -> 收集 text、thinking blocks / reasoning、tool_calls、usage、debug trace
4. 如果有 tool_calls -> ToolRegistry 执行；普通结果进入当前 loop，后台任务 / 子 Agent 返回 task envelope 并继续异步
5. Tool folding：T1 在 turn 内按 `TOOL_BATCH_SIZE = 30` 折叠长工具弧；T2 在 end_turn 对超过 `TURN_SUMMARY_THRESHOLD = 8` 的长 turn 做 reflection；重复同参工具调用第 3 次会插入提醒
6. end_turn -> 持久化 messages / raw tool output / debug trace -> acknowledge sub-agent notifications -> 检查 Dream / AMS adjust / compact 触发
7. max_tokens -> 自动续写（最多 3 次）
8. 遇到 LLMContextError -> 强制 compact -> 重试
9. 可重试错误且配了 fallbackModel -> 换 model -> 重试；adapter 层会对 rate limit / 5xx / idle timeout 做分类

### LLM 层（agent/yeaft/llm/）— Yeaft Code Agent provider 集成
```
adapter.js           — Base LLMAdapter 类 + error 类型 + createLLMAdapter()
router.js            — AdapterRouter：按 model 路由到 provider，lazy 创建 adapter
anthropic.js         — Anthropic Messages API 适配器
openai-responses.js  — OpenAI Responses API 适配器（/v1/responses）
models-dev.js        — models.dev 注册表（UI 自动补全用）
credentials/         — 动态凭证（github-copilot 等）
```
- 配置：`~/.yeaft/config.json` 里的 `providers[]` 数组；Web 设置页和 `yeaft-agent llm` CLI 写的是同一份 agent-local config
- 每个 provider：`{ name, baseUrl, apiKey?, credentialProvider?, protocol?, models[] }`；`apiKey` 适合静态密钥，`credentialProvider` 适合 GitHub Copilot 这类动态凭证
- 支持的 Protocol：`"anthropic"` 或 `"openai-responses"`（旧的 chat-completions 已在 Phase 7 移除）
- Models 项可以是字符串 `"gpt-5"`，也可以是对象 `{ id, protocol?, contextWindow?, maxOutputTokens?, effortOptions? }` 做 per-model 覆盖
- Protocol 解析顺序：per-model > provider-level > 按 model id 启发式（claude-* → anthropic / gpt-* / o1-4 / chatgpt-* / codex-* / omni-* → openai-responses） > 默认 openai-responses；同一 provider 可同时暴露 Claude 系和 GPT 系 model
- Token limit 解析顺序：provider model override > `models.dev` catalog（`llm/models-dev.js`）> 内置保守默认；不要把 context window 写死在 UI 或 prompt 里
- Effort / thinking：`models.js` 记录模型是否支持 Anthropic thinking、Anthropic adaptive thinking 或 OpenAI reasoning；前端模型菜单可选择 `modelEffort`，Session override 存在该 Session 自己的 `config.json`（位于 agent-local sessions 目录；`workDir` 只作为项目资产 / 运行上下文，不承载 Session 数据），adapter 在请求时翻译成 `thinking` / `output_config.effort` / `reasoning.effort`
- Anthropic adapter 现在会过滤空文本 user / assistant content，但保留 image/document/tool_result 等非文本 block；不要为了兼容空字符串重新构造无意义文本

### 记忆系统（agent/yeaft/memory/）— H2-AMS 架构

```
segment-store.js  — <scope>/segments/*.md 原子 markdown 段（存储原语）
segment-sync.js   — 段写/删时镜像到 FTS 索引
segment.js        — 段记录辅助函数
index-db.js       — SQLite FTS5 索引（每段一行，按 scope 分）
store.js          — Scope 路径 + ACL 解析（scope 标识 → 磁盘 path 的 single source of truth）
summary-store.js  — Layer-A summary 读写：<scope>/summary.md
ams.js            — Active Memory Set：三层缓存（Resident summary / Recent / OnDemand）
ams-registry.js   — Session 级 AMS 持久化（hydrate + persist with adjustRanThisSession）
budget.js         — AMS 各层的 token 预算计算
keywords.js       — FTS 关键词抽取
preflow.js        — 每 turn 前对相关 scope 做 FTS 召回 -> 注入 system prompt
adjust.js         — Turn 后用 LLM 修正 AMS（每个 session 最多一次）
seed-backfill.js  — 历史数据迁移 / 回填
```

> Dream 维护本身在 `agent/yeaft/dream/`，不在 memory 目录里。

**Scope 是唯一维度。** 记忆存放在如下 scope 下：
- `user/<userId>` — 用户级 profile / preference（替代旧的 shard 系统）
- `vp/<vpId>` — 单个 VP 的人格记忆（VP 即 scope owner）
- `vp/<vpId>/sub/<subAgentId>` — VP 的子 Agent，嵌套 scope
- `session/<sessionId>` / `group/<sessionId>` — Session 内共享。Writer 当前还在写 `group/` 前缀；Reader（`sessions/pre-flow.js`）同时查 `session/` 和 `group/` 两条路径，迁移脚本（`agent/yeaft/migrate/sessions.js`）把磁盘上的 `group/` 改写到 `session/`。两条路径会**并存一段时间**，不要凭空只删其中一条
- `feature/<featureId>` — feature 级协作记忆
- `global` — 全局

**读路径（每 turn）：** `preflow.js` 对相关 scope 跑 FTS → 命中结果注入 system prompt。AMS 持有当前正在运行的三层缓存，按 sessionId 索引。

**写路径：** `summary-store.js` 写 `<scope>/summary.md`（Layer A，由 Dream 在 segment 变化后再生成）；`adjust.js` 每个 session 最多跑一次，借 LLM 修正 AMS；`dream/` 后台跑，把 diff 切分成原子段文件。

**VP / 多 Agent 语义：** VP 和用户一样是 scope owner。VP 的子 Agent 嵌套在 `vp/<vpId>/sub/<subAgentId>`。Session fan-out 时 VP 并行执行；VP 之间的跨视野通过 scope-aware pre-flow 召回实现，**不**走共享 shard、也**不**走共享 transcript。VP→VP 显式 handoff 用 `route_forward` 工具。

### 会话持久化（agent/yeaft/conversation/）
```
persist.js  — Message 存为 .md 文件，路径 ~/.yeaft/conversation/messages/
search.js   — 跨会话历史的全文搜索
```

### 工具系统（agent/yeaft/tools/）
```
registry.js  — ToolRegistry：按 mode 过滤 + 执行分发
types.js     — defineTool() + ToolDef/ToolContext 类型
index.js     — 入口，把所有内置工具聚合成 createFullRegistry()
```
按类别分文件（节选）：
- 文件 / 编辑：`file-read.js` / `file-write.js` / `file-edit.js` / `apply-patch.js` / `notebook-edit.js`
- 搜索 / 探索：`grep.js` / `glob.js` / `list-dir.js` / `history-search.js`
- 执行：`bash.js` / `js-repl.js` / `enter-worktree.js` / `exit-worktree.js`
- 后台任务：`list-tasks.js` / `read-task-log.js` / `cancel-task.js`（配合 `Bash background=true` 和 `tasks/` 子系统）
- 网络 / 媒体：`web-fetch.js` / `web-search.js` / `image-generation.js` / `view-image.js`
- 编排：`agent.js` / `send-message.js` / `wait-agent.js` / `close-agent.js` / `list-agents.js` / `route-forward.js`
- 任务 / 计划：`todo-write.js` / `start-plan.js`
- 对外集成：`ask-user.js` / `skill.js` / `mcp-tools.js`

**Tool result 生命周期：** 工具执行事件、debug trace、持久化历史保留 raw output；进入模型上下文的 tool result 有单独预算与 tool folding 保护，长工具弧会被 reflection 压缩，历史窗口里的大结果可走 archive / stub 路径。不要把 UI 展示截断误认为磁盘只保存截断内容。Raw output / debug trace 可能包含敏感项目内容，新增展示、导出或跨 session 读取能力时必须遵守 session storage / owner 边界。

### 后台任务 / 子 Agent 编排
- `Bash background=true` 进入 `tasks/` 子系统：返回 `taskId` 和日志路径；`ListTasks` / `ReadTaskLog` / `CancelTask` 读取或控制同一套任务记录
- `TaskManager` 按 Session 持久化任务状态和日志；agent 重启后仍标记未完成任务为 `orphaned`，不会假装进程还可控
- `SpawnAgent` 走 `sub-agent/runner.js`，每个子 Agent 有独立 output log、liveness 计数器、预算上限和 terminal 状态
- 子 Agent 终止 / idle 通知会进入 `sub-agent/notifications.js` 队列；`WaitAgent` 可按 agentId drain，Engine 在 parent 下一次 user-driven turn 前也会把 pending notification 注入上下文并在 turn 成功后 acknowledge
- sub-agent terminal notification 语义上是 parent re-entry control context，不是用户原始输入；改这条链路时要避免把它当作用户手写文本做长期语义记忆或展示

### System Prompt 模板（agent/yeaft/templates/）
```
base.md             — 核心身份 + 原则（双语）
identity-yeaft.md   — Yeaft 身份指令
common-rules.md     — 公共行为规则
mode-unified.md     — 当前唯一的运行 mode（覆盖 session 协作所需的全部指令）
mode-dream.md       — Dream 模式：记忆维护
plan-instruction.md — 计划阶段的额外指令
tool-guidance.md    — 工具使用最佳实践
personas/           — 人格变体
harness/            — Harness 级指令（环境信息等）
```

> 历史文档里出现过的 `mode-chat.md` / `mode-worker.md` / `mode-coordinator.md` / `multi-agent.md` / `personality-*.md` 已被收敛进 `mode-unified.md` + `personas/`，**不再单独存在**。

### Web Bridge（agent/yeaft/web-bridge.js）
- 把 Engine 事件翻译成 `claude_output` 格式（保留这个 wire type 名是为了让前端复用 Claude Chat 渲染管线）
- 前端复用标准渲染管线（MessageList、AssistantTurn、ToolLine 等）
- 消息流：`yeaft_session_send` -> agent message-router -> `handleYeaftSessionSend()` -> 按 VP 调 `runVpTurn()` -> Engine.query() -> 事件 -> `yeaft_output` -> server -> web
- 历史 wire alias（`yeaft_session_chat` / `unify_group_chat` 等）经 router fan-in 到同一个 handler，保兼容

### Skills 和 MCP
```
skills.js  — SkillManager：从 ~/.yeaft/skills/ 加载并匹配 skill
mcp.js     — MCPManager：连接 MCP server，桥接其工具
```

## 前端架构

- **框架**：Vue 3（CDN，无构建步骤）+ Pinia
- **API 风格**：Vue Options API，`template` 用字符串字面量（不用 SFC / `.vue` 文件）
- **组件**：`web/components/*.js` — `ChatPage`、`YeaftPage`（Yeaft 主页）、`YeaftSidebar`、`SettingsPanel`、`MessageList`、`ChatInput`、`SessionCreateModal`、`SessionSettingsModal`、`SessionInviteModal`、`VpDetailView`、`VpTurnBlock` 等
- **状态**：`web/stores/chat.js` 是唯一的 Pinia store
- **渲染**：Claude Chat 和 Yeaft 复用同一套 MessageList / AssistantTurn 管线
- **样式**：纯 CSS 放在 `web/styles/`，token 都集中在 `variables.css`
- **i18n**：内置 i18n，用 `$t()` 调用（en / zh-CN）

### Store 关键 state（Yeaft 相关）
> 字段名沿用 `yeaft` 前缀作为子系统命名空间（不是 legacy alias — `yeaft` 是现行术语）。

```js
currentView: 'chat' | 'yeaft'        // 顶层页面切换（'yeaft' 即 Yeaft 页）
yeaftConversationId: null            // Agent session_ready 给出的虚拟 conversationId
yeaftModel: null                     // 当前 model
yeaftModelEffort: null               // 当前 model effort；Session override 在 session.config.modelEffort
yeaftSessionReady: false             // Session 初始化状态
yeaftStatus: null                    // { skills, mcpServers, tools }
yeaftActiveSessionFilter: null       // 当前选中的 session
```

### Store 关键 action（Yeaft 相关）
```js
enterYeaft(agentId?)     // 进入 Yeaft 页，创建虚拟 conversationId
leaveYeaft()             // 回 Claude Chat 页
sendYeaftSessionMessage({groupId, text, mentions, attachments})
                         // 唯一发送通道（wire type: 'yeaft_session_send'）
                         // 入参对象内的 `groupId` 是 legacy JS arg name；store
                         // 内部把它 read 成 sessionId 后再写到 wire payload 的
                         // `sessionId` 字段。Wire 层本身不带 `groupId`。
handleYeaftOutput(msg)   // 把 Engine 事件丢给标准 claude_output 管线
switchYeaftModel(modelId, sessionId?, modelEffort?)
                         // 切模型；带 sessionId 时只写该 Session 的 config（model / modelEffort），不泄漏到 agent 默认模型；不带 sessionId 时才发 yeaft_model_switch 更新 agent/default 状态
clearYeaftMessages()     // 重置 session
```

> 注：上面的 `groupId` 参数名是 store-内部的 JS arg 残留，不是 wire 字段 — 重命名只是 in-process 调用方的扫描工作，不是 wire-compat 问题。新代码要调这个 action 时按现有签名传参就行，不要为了改 arg 名展开重构。

## 服务端架构

- **Express + ws**：HTTP server + WebSocket 做实时通信
- **两类 WebSocket**：agent 连接（ws-agent.js）和 web 客户端连接
- **消息中继**：Server 在 agent 和它的 owner 的 web 端之间转发消息
- **鉴权**：JWT-based（可选，开发期可走 skipAuth）
- **Agent 输出处理**：`server/handlers/agent-output.js` — 分发 claude_output 和 yeaft_output

## 数据流

### Claude Chat 模式
```
Web 客户端 -> ws "send_message" -> Server -> ws agent -> Claude CLI 进程
Claude CLI -> agent -> ws "claude_output" -> Server -> ws "claude_output" -> Web 客户端
```

### Yeaft Session
```
Web 客户端 -> ws "yeaft_session_send" -> Server -> ws agent
  -> message-router.js -> handleYeaftSessionSend()
  -> coordinator.ingest() -> Promise.all(按 VP runVpTurn -> Engine.query())
  -> Engine 事件 -> web-bridge.js -> ws "yeaft_output" -> Server
  -> ws "yeaft_output" -> Web 客户端 -> handleYeaftOutput() -> handleClaudeOutput()
```

### Session 创建 / 恢复 / workDir
- Web 创建入口：`SessionCreateModal` -> `chat.createYeaftSession()` -> `sessionCrudRequest('create')` -> wire `yeaft_create_session`
- 后端创建入口：`agent/yeaft/sessions/session-crud.js#createSessionFromSpec()`，写 `session.json`，同时初始化 per-session `config.json` 和 memory seed summary
- VP 默认值边界：前端 roster hydrate 后会优先预选 `omni`；后端也做兜底，但只在调用方 roster 为空或未传时生效。若 VP library 存在 `omni`，创建 `roster: ['omni']` / `defaultVpId: 'omni'`；显式非空 roster 永不被覆盖；VP library 为空时允许空 roster / `defaultVpId: null`
- `workDir` Session：带 `workDir` 创建时，真实 Session 数据仍写到 agent-local `~/.yeaft/sessions/<sessionId>/`；`workDir` 只用于项目级 assets（skills / MCP 等）和运行上下文。agent-local `~/.yeaft/group-workdirs.json` 是兼容 registry，记录 `sessionId -> workDir`，也用于把旧版 `<workDir>/.yeaft/sessions/<sessionId>/` 数据一次性迁移回 user-level root。
- 恢复入口边界：`yeaft_scan_workdir_sessions` / `yeaft_restore_session` 只保留 wire 兼容；新运行时不再把项目 `.yeaft/sessions` 作为 Session 数据源。

## 配置

### Agent 配置（~/.yeaft/config.json）
```json
{
  "providers": [
    { "name": "my-proxy", "baseUrl": "http://localhost:6628/v1", "apiKey": "proxy",
      "protocol": "openai-responses", "models": ["claude-sonnet-4-20250514", "gpt-5"] },
    { "name": "github-copilot", "baseUrl": "https://api.githubcopilot.com",
      "credentialProvider": "github-copilot", "protocol": "openai-responses",
      "models": [{ "id": "claude-sonnet-4.5", "protocol": "anthropic" }, "gpt-5"] }
  ],
  "primaryModel": "my-proxy/claude-sonnet-4-20250514",
  "fastModel": "my-proxy/claude-haiku-3-20250414",
  "language": "zh",
  "debug": false,
  "maxContextTokens": 200000,
  "messageTokenBudget": 32768
}
```

- `apiKey` 和 `credentialProvider` 二选一：填了 `credentialProvider` 就由 agent 在 request 时动态拿 token（目前支持 `github-copilot`），静态 `apiKey` 路径完全不变。
- per-model `protocol` 用于同一个 provider 同时跑两种 wire 协议（典型场景：GitHub Copilot 既要 Claude 系也要 GPT 系）。新增 provider 时优先接入 Yeaft LLM adapter 层；只有要新增 1:1 CLI 后端时才实现 `agent/providers/*` 的 ChatProvider。
- provider model 对象还可以带 `contextWindow` / `maxOutputTokens` / `effortOptions` 覆盖；Web 模型菜单会按 `effortOptions` 显示推理强度 chip。Session 级 override 写在该 Session 自己的 `config.json`，目前只允许 `model` 和 `modelEffort`。

## 测试

- **框架**：Vitest
- **运行**：`npx vitest run`
- **测试文件**：`test/` 目录，命名 `*.test.js`
- **Yeaft 相关**：单元 / 子模块测试集中在 `test/agent/yeaft/`（按子系统分目录：`compact/`、`conversation/`、`dream/`、`memory/`、`sessions/`、`sub-agent/`、`tasks/`、`tool-folding/` 等）；跨模块场景在 `test/agent/yeaft-*.test.js`、`test/server/yeaft-*.test.js`、`test/web/yeaft-*.test.js`。前缀名沿用历史 "yeaft" 别名，实际覆盖 Yeaft 引擎

## 开发规范

- **语言**：ES modules（import/export），Node.js 20+
- **不用 TypeScript**：纯 JS + JSDoc 类型注解
- **无构建步骤**：前端走静态文件，Vue/Pinia 直接 CDN 引入
- **Commit 风格**：Conventional commits（`feat:`、`fix:`、`perf:`、`revert:`）
- **Tag 格式**：`v1.0.X`（从 `v1.0.0` 起，后续按 patch 小版本递增；用 `git tag --sort=-v:refname | head -1` 查最新）
- **Release tag**：`release-v1.0.X` 触发生产部署（仅在用户明确要求时打）
- **文档语言**：项目内 CLAUDE.md / 文档说明一律用中文；代码注释允许英文以便国际协作

## 命名约束（每次起新名字必读）

代码里的名字是和未来读这段代码的人签的合同。下面这几条是**硬约束** — 新代码违反就在 review 里打回去。

### 1. 禁止 version-suffix 文件名

- ❌ `file-read-v1.js`、`file-read-v2.js`、`store-v2.js`、`recall-v2.js`、`engine-new.js`、`auth-old.js`、`session-tmp.js`
- ✅ 新版本就**取代**旧版本：删旧文件、写新文件、走 PR、留好 git history。`git log` 是版本，文件名不是。
- 禁止的后缀（明文）：`-v\d+` / `-new` / `-old` / `-tmp` / `-copy`。其他语义后缀（`-flag`、`-store`、`-bridge` 等）是 feature name，不是版本号，**不在禁列**。
- 例外：**一次性的数据迁移脚本**可以带 `vX-to-vY` 之类的版本号，因为它本身就是 "把数据从 vX 形态搬到 vY 形态" 的一次性产物，不是功能模块的并行版本（参考 `agent/yeaft/memory/migrate-r5-to-r6.js`、`agent/yeaft/conversation/migrate-messages-threadid.js`）。

### 2. 禁止旧术语进入新代码

旧术语 → 现行术语：

| 旧（禁止用于新代码） | 现行 |
| --- | --- |
| `unify` / `Unify` / `unified` | `yeaft` / `Yeaft`（引擎名） |
| `group` / `Group` / `groupId` | `session` / `Session` / `sessionId`（Session 是唯一编排单元） |
| `chat mode` / `group mode` | 没有 mode 划分了；只有 Session（默认 1 VP，可加更多 VP） |

- **新代码**：写函数名、变量名、类名、目录名、新文件、新 wire 类型 — **只用现行术语**。`unifyXxx` / `groupXxx` 在新代码里 = code smell，必须改名。
- **现有代码**：现存的 `unify_*` wire alias 系列（如 `unify_group_chat` / `unify_load_history`，message-router.js 还在路由它们）、`group/<id>` scope 前缀、个别 `groupId` JS 参数名、`yeaft` 引擎别名等**保留**为 wire / 存储兼容 — **不**主动批量重命名，否则会炸 agent↔server↔web 协议、磁盘上的旧数据路径、以及任何已经持久化的 scope key。
- **碰到旧名字时**：JSDoc 里说明 "legacy alias for X"，给读代码的人解释清楚；不要默默改、也不要默默接受。

> **scope-kind enum 怎么算？** memory 子系统里 `kind: 'group'` 是写入磁盘 path 的 schema 字段（`memory/store.js` 解析成 `group/<id>` 目录），属于 "存储兼容" 这一档 — 现有调用点保留即可。但**新写的 scope-kind 不能再起 `'group'`**，要起就用 `'session'`（reader 已经能双读 `group/` 和 `session/` 两种前缀）。

### 3. 怎么判断 "新代码还是旧代码"

- **新文件**：只能用现行术语。
- **新加到旧文件里的函数 / 变量**：只能用现行术语。
- **改旧代码里已存在的 identifier**：默认不动。要改就**整条链一起改**（agent / server / web / 测试 / 存储 schema 全改），不要只改一半留下半残的名字。

---

## UI 开发理念（每次改 UI 必读）

整套 UI 走 **现代极简（Modern Minimalism）** 路线 — 内容优先、留白驱动节奏、没必要的视觉元素一律不画。**禁止单独发明新的颜色、圆角、间距、字号** —— 一切走 `web/styles/variables.css` 里的 CSS 变量；同时支持 light / dark 两套 theme，新写的所有样式都必须在两套主题下都被检验。

### 1. Design Token 是唯一颜色来源

颜色、边框、背景、圆角、间距 — **永远引用 token**，不要硬编码。`web/styles/variables.css` 是 single source of truth，分别为 `:root`（light，默认）和 `[data-theme="dark"]` 定义同一组 token：

| 用途 | Token | 备注 |
| --- | --- | --- |
| 主背景 | `--bg-main` | 内容区底色 |
| 侧栏 / 次背景 | `--bg-sidebar` | 略深于主背景 |
| 输入框 | `--bg-input` / `--bg-input-wrapper` | wrapper 比 input 略深，做分层 |
| 主文字 | `--text-primary` | 正文 |
| 次文字 | `--text-secondary` | 说明、label |
| 弱化文字 | `--text-muted` | placeholder、hint、时间戳 |
| 边框（标准） | `--border-color` | 输入框、卡片边 |
| 边框（淡） | `--border-light` | 分组、表格 row |
| 主 Accent | `--accent` / `--accent-hover` / `--accent-fg` | 主按钮、CTA |
| 蓝色 Accent | `--accent-blue` / `--accent-blue-hover` | 链接、focus ring、selected |
| 状态色 | `--error` / `--success` | 错误、成功 |
| Hover | `--sidebar-hover` | 列表 hover 态 |
| 选中态 | `--session-active` | 列表选中 |

**判断标准**：写一行新 CSS 时，颜色处只出现 `var(--xxx)`。看到 `#rrggbb`、`rgb(...)`、`rgba(0,0,0,...)` 在新代码里 = code smell，必须替换成 token 或新增 token。新增 token 时 light 和 dark 都要给值。

### 2. 组件复用优先于"写一遍样式"

写新页面 / 新弹窗前，**先去 `web/components/` 看有没有现成的**。重复样式 = 一致性灾难 + 改一处漏一处。

**已经统一的全局元素**（写新 UI 时直接复用，不要再造）：

- **按钮**：标准类是 `.btn-primary` / `.btn-secondary` / `.btn-ghost`（参考 `settings.css` / `chat-modals.css`）。主按钮统一用 `--accent` 填充 + `--accent-fg` 文字；次按钮 transparent + `--border-color`；ghost 只在 hover 时显示背景。**禁止单独 inline 写按钮颜色**。
- **下拉 `<select>`**：`variables.css` 顶部已经统一过，不要再写局部 select 样式，会导致圆角/边框漂移。
- **输入框**：`input[type=text]` / `textarea` 一律 `border-radius: 10px` + `1px solid var(--border-color)` + `focus` 时换 `--accent-blue` + 2px 0.12 透明度光晕。和 `select` 保持完全一致。
- **Tab bar**：`session-tab-bar` 是侧栏顶部 tab 的统一实现；新模式接入也走它，不要自己写 tab。
- **图标**：用 Symbols Nerd Font Mono，已在 `variables.css` 通过 `@font-face` 注册。
- **Modal / 弹窗外壳**：所有模态使用统一的 overlay + container（参考 `chat-modals.css` 的 `.modal-overlay` / `.modal-card`）。**严禁**为每个新弹窗自己写一遍 overlay。

**复用流程**：新 UI 草稿 → 找现有组件 → 找现有 class → 都没有再考虑新增组件 / 新增 token。新增组件时同步在本文件 "已经统一的全局元素" 段落里登记，避免下个人又造一遍。

### 3. 配置 / 设置弹窗：**固定外壳尺寸**（CRITICAL）


- ❌ 错的做法：每个 tab 是 `height: auto`，切换时弹窗整体跳动，按钮位置漂移。
- ✅ 对的做法：
  - 外壳固定：`width: min(960px, 92vw); height: min(720px, 86vh);`
  - 顶部 tab bar + 底部 footer（保存 / 取消）固定不滚
  - 中间内容区 `flex: 1; overflow-y: auto;` —— 任何 tab 内容超出，**滚条出现在内容区，不影响外壳**
  - 字段密度不一致的 tab 用 padding-bottom 顶住，**不要**让弹窗自适应

`settings.css` 里的 `.settings-overlay` / `.settings-card` / `.settings-body` 是这个模式的参考实现 — 新弹窗照搬，不要自己重新设计。

### 4. 一致性 checklist（每次提交 UI 改动前自查）

- [ ] 没有新增的硬编码颜色（grep 自己的 diff：`#[0-9a-f]{3,6}`、`rgb(`、`rgba(`，新加的必须能解释为什么）
- [ ] light 和 dark 主题都打开看过一遍（切换器：右上角主题按钮）
- [ ] 按钮、输入框、select、tab 的圆角和颜色和站点其他位置一致
- [ ] 新弹窗：外壳尺寸固定，tab 切换不跳动
- [ ] 没有重复造已有组件 / class
- [ ] 没有水平分割线滥用（见下条）
- [ ] 文案在 `web/i18n/en.js` 和 `web/i18n/zh-CN.js` 都已添加，组件里用 `$t()` 调用，不要写死中文/英文

### 5. Yeaft UI 特别规则（保留旧规则）


### 6. "如果需要说明书才能用，就是设计失败"

参考 Rams 原则：图标含义、按钮去哪、tab 在哪 — 用户**不应该**需要 hover 看 tooltip 才能猜到。新 UI 评审时自问一句：第一次见到这个界面的人，30 秒内能完成主任务吗？不能的话，**先简化界面，不要加文档**。

---

## Worktree + PR 工作流（每次改动都必须走）

每一个 feature / 修复 — 无论多小 — 都走这套流程。**绝不允许从 worktree 直接 push 到 `main`。**

1. **建 worktree**：用 `EnterWorktree`，名字带语义前缀（`fix-...`、`feat-...`）。
2. **开发 + 测试**：在 worktree 里改完，push 之前 `npx vitest run` 必须绿。
3. **Commit**：用 conventional commit 信息。
4. **push worktree 分支**（不是 `main`）：`git push -u origin <worktree-branch>`。
5. **开 PR**：`gh pr create --base main --head <worktree-branch> --title "..." --body "..."`。
6. **等 PR 合并**（CI 绿 + 用户批准）。**不要**自己合并 PR，除非用户明确授权。
7. **从 `main` 打 tag**（合并之后）：切到 main checkout（`/home/azureuser/projects/claude-web-chat`），`git checkout main && git pull`，然后 `git tag v1.0.X && git push origin v1.0.X`。

### 禁止的捷径（永远不能做）

- ❌ 从 worktree 跑 `git push origin HEAD:main`
- ❌ `git push origin <worktree-branch>:main`
- ❌ 给 worktree 分支打 tag
- ❌ 没有用户明确授权就合并自己的 PR
- ❌ push 一个 commit 还没在 `origin/main` 上的 tag

PR 是 review 闸门。跳过它就跳过了 code review，破坏了审计链。如果之前某条指令（包括旧的 project memory）说可以直接 push 到 main，那条指令是**错的** —— 以本节为准。

## 自动 Review-and-Ship 流程（DEFAULT — 不用问直接跑）

**这是每个 PR 的标准发布流程。不要问用户 "要 review 和 merge 吗" —— 测试绿 + PR 开好以后，端到端自动跑这个 loop。**（2026-05-13 用户指令："以后记住不需要问我，做完了就自动触发这个流程"。）

历史上的人话触发（"review一下，没问题就 merge + tag"、"自己 merge"）依然有效，但已经**不需要**专门触发 — 这是默认流程。

1. **两轮 review（强制，两轮都要）** — 调用 `yeaft-skills:review-code` skill，会派发：
   - **Pass 1 — 架构（Fowler persona）**：模块边界、抽象层级、一致性、耦合、scope 漂移
   - **Pass 2 — 代码质量（Torvalds persona）**：简洁性、命名、边界 case、死代码、debug 残留
   - 两轮独立 subagent 运行，报告写到 `/tmp/review-{fowler,torvalds}-<pr>.md`
2. **修每一条 reported issue（Fix-first）** — Critical 和 Important 的 finding 在同一个 PR 合并前**必须**修。Minor 也要修，除非真的超出范围。**不要**带着已知未修问题 merge。
3. **验证** — 跑 `npx vitest run`。修完之后的 HEAD 必须全绿。
4. **push 修复 + 把 review summary 作为 PR comment 贴上** — 这条 comment 是审计链，记录每个 persona 发现了什么、修了什么。
5. **合并** — `gh pr merge <num> --merge --delete-branch`。本地分支删除可能失败（worktree 还 check out 着），这是预期，没事 — 远端 merge + 远端分支删除已成功。
6. **从 main 打 tag** — 切到 `/home/azureuser/projects/claude-web-chat`，`git checkout main && git pull --ff-only`，确认 `git branch --show-current` 输出 `main`，然后 `git tag v1.0.X && git push origin v1.0.X`。tag commit 必须能从 `origin/main` 到达。
7. **清理 worktree**（`ExitWorktree action: "remove"`；带 `discard_changes: true`，因为 commit 已经通过 PR 进了 main）。

**只在以下情况停下来问** review 出现了你不能放心自动修的 Critical / Important 问题，或者修的范围真的不确定。否则不问，直接做完。

上面的禁止捷径（`HEAD:main`、给 feature 分支打 tag、push 还没到 origin/main 的 tag）依然适用 — auto-flow 是步骤 1–7，不是绕过 PR 闸门的许可证。

## 运维安全规则

- **绝不重启 / kill / 改运行中的 agent / server 进程** — 只分析代码、提 fix。进程重启交给用户或部署流水线。
- **绝不跑 `npm install -g` 或 `npm pack` 去更新运行中的 agent** — Agent 升级走 release tag 触发的 CI/CD，不走手动 npm install。
- **绝不改 `~/.yeaft/config.json` 或其他运行时配置文件**，除非用户明确允许。
- **先改代码、后部署** — 调试线上问题：读 log/code → 找 root cause → commit fix → push → 让用户决定什么时候部署。
