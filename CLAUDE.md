# Claude Web Chat (Yeaft)

一个 Web 端的 AI 聊天应用，提供三种交互模式：**Chat**（基于 Claude CLI 的 1:1 对话）、**Crew**（多 Agent 团队协作）、**Unify**（自带引擎的单 session AI 伙伴）。

## 项目结构

```
agent/           — Node.js Agent（运行在用户机器上，通过 WebSocket 连接 server）
  claude.js      — Claude CLI 封装（Chat 模式）
  conversation.js — Chat 会话管理
  crew.js        — Crew 模式入口
  crew/          — Crew 多 Agent 子系统
  sdk/           — Claude SDK 封装（query / stream / utils）
  connection/    — WebSocket 连接、消息路由、心跳
  unify/         — Yeaft Unify 引擎（自包含 AI 引擎，不依赖 Claude CLI）
server/          — Express + WebSocket 服务（Agent 与 Web 客户端之间的中继）
  handlers/      — 消息处理器（agent-output、client-conversation 等）
web/             — 前端（Vue 3 Options API，无构建步骤，静态文件直出）
  components/    — Vue 组件（ChatPage、UnifyPage、MessageList 等）
  stores/        — Pinia store（chat.js 是主状态 store）
  styles/        — CSS 文件
test/            — Vitest 测试
```

## 三种模式

### Chat 模式（旧）
- 使用 Claude CLI（`agent/claude.js`）作为 AI 后端
- 每个会话 = 一个独立的 Claude CLI 进程
- 支持多 session：侧栏列出多个 chat session
- Agent 作为桥：web -> server -> agent -> Claude CLI -> agent -> server -> web

### Crew 模式
- 多 Agent 团队协作（PM、dev、reviewer、tester、designer、architect）
- 角色定义在 `.crew/roles/*/CLAUDE.md`
- 角色间通过 `---ROUTE---` 协议路由消息
- 通过 `.crew/context/features/` 和 `.crew/context/kanban.md` 跟踪 feature

### Unify 模式（新 - 主开发方向）
- **单 session** — 没有多 session 概念，一段连续对话
- **自有引擎** — 不依赖 Claude CLI，自己跑 query loop（`agent/unify/engine.js`）
- **记忆系统** — 持久化记忆，支持 recall、consolidation、dream 维护
- **多 provider LLM** — 通过 `AdapterRouter` 路由到不同 provider
- **工具系统** — 40+ 个内置工具，按 mode 过滤（chat vs work）
- **多 Agent 编排** — 可派生子 Agent 并行执行任务

## Unify 架构（agent/unify/）

### 核心组件

```
engine.js        — 主 query loop（turn-based：prompt -> LLM -> tool_calls -> execute -> 循环）
session.js       — Session orchestrator（loadSession 把所有子系统串起来）
web-bridge.js    — 把 Engine 事件翻译成 claude_output 格式，让前端复用
config.js        — 从 ~/.yeaft/config.json 读配置（providers、models、limits）
prompts.js       — 双语 system prompt builder（en/zh）
models.js        — Model 注册表（上下文窗口、output limit、provider 推断）
```

### Engine Query Loop（engine.js）
1. Pre-query：召回记忆 -> 注入到 system prompt
2. 构造 messages 数组（带 compact summary 时一并带上）
3. 调 adapter.stream() -> 收集 text + tool_calls
4. 如果有 tool_calls -> 执行工具 -> 追加结果 -> 回到第 3 步
5. end_turn -> 持久化 messages -> 检查是否需要 consolidation -> 完成
6. max_tokens -> 自动续写（最多 3 次）
7. 遇到 LLMContextError -> 强制 compact -> 重试
8. 可重试错误且配了 fallbackModel -> 换 model -> 重试

### LLM 层（agent/unify/llm/）
```
adapter.js           — Base LLMAdapter 类 + error 类型 + createLLMAdapter()
router.js            — AdapterRouter：按 model 路由到 provider，lazy 创建 adapter
anthropic.js         — Anthropic Messages API 适配器
openai-responses.js  — OpenAI Responses API 适配器
credentials/         — 动态凭证（github-copilot 等）
```
- 配置：`~/.yeaft/config.json` 里的 `providers[]` 数组
- 每个 provider：`{ name, baseUrl, apiKey?, credentialProvider?, protocol?, models[] }`
- Protocol：`"anthropic"` 或 `"openai-responses"`
- Models 项可以是字符串 `"gpt-5"`，也可以是对象 `{ id, protocol? }` 做 per-model 覆盖

### 记忆系统（agent/unify/memory/）— H2-AMS 架构

```
segment-store.js  — <scope>/segments/*.md 原子 markdown 段（存储原语）
segment-sync.js   — 段写/删时镜像到 FTS 索引
segment.js        — 段记录辅助函数
index-db.js       — SQLite FTS5 索引（每段一行，按 scope 分）
store-v2.js       — Layer-A summary 读写：<scope>/summary.md
ams.js            — Active Memory Set：三层缓存（Resident summary / Recent / OnDemand）
ams-registry.js   — Group 级 AMS 持久化（hydrate + persist with adjustRanThisSession）
preflow.js        — 每 turn 前对相关 scope 做 FTS 召回 -> 注入 system prompt
adjust.js         — Turn 后用 LLM 修正 AMS（每个 session 每个 group 最多一次）
dream-v2.js       — 后台记忆维护：per-group diff -> triage -> merge -> apply
budget.js         — AMS 各层的 token 预算计算
keywords.js       — FTS 关键词抽取
layout.js         — Scope -> 文件路径映射
summary-store.js  — summary.md 周边工具
types.js          — 记忆类型分类（type 字面量）
```

**Scope 是唯一维度。** 记忆存放在如下 scope 下：
- `user/<userId>` — 用户级 profile / preference（替代旧的 shard 系统）
- `vp/<vpId>` — 单个 VP 的人格记忆（VP 即 scope owner）
- `vp/<vpId>/sub/<subAgentId>` — VP 的子 Agent，嵌套 scope
- `group/<groupId>` — 组内共享
- `feature/<featureId>` — feature 级协作记忆
- `global` — 全局

**读路径（每 turn）：** `preflow.js` 对相关 scope 跑 FTS → 命中结果注入 system prompt。AMS 持有当前正在运行的三层缓存，按 groupId 索引。

**写路径：** `store-v2.js` 写 `<scope>/summary.md`（Layer A）；`adjust.js` 每个 session 每个 group 最多跑一次，借 LLM 修正 AMS；`dream-v2.js` 后台跑，把 diff 切分成原子段文件。

**VP / 多 Agent 语义：** VP 和用户一样是 scope owner。VP 的子 Agent 嵌套在 `vp/<vpId>/sub/<subAgentId>`。Group fan-out 时 VP 并行执行；VP 之间的跨视野通过 scope-aware pre-flow 召回实现，**不**走共享 shard、也**不**走共享 transcript。VP→VP 显式 handoff 用 `route_forward` 工具。

### 会话持久化（agent/unify/conversation/）
```
persist.js  — Message 存为 .md 文件，路径 ~/.yeaft/conversation/messages/
search.js   — 跨会话历史的全文搜索
```

### 工具系统（agent/unify/tools/）
```
registry.js  — ToolRegistry：按 mode 过滤 + 执行分发
types.js     — defineTool() + ToolDef/ToolContext 类型
index.js     — 40+ 个内置工具，createFullRegistry()
```
- 工具按 mode 过滤：`chat` 类（web-search、memory、ask-user）vs `work` 类（bash、file-edit、grep）
- 编排工具：agent、send-message、wait-agent、close-agent、list-agents
- 任务管理：task-create、task-update、task-list、task-get

### System Prompt 模板（agent/unify/templates/）
```
base.md              — 核心身份 + 原则（双语）
mode-chat.md         — Chat 模式：结对编程伙伴
mode-worker.md       — Worker 模式：被指派的子任务执行者
mode-coordinator.md  — Coordinator 模式：多 Agent 编排者
mode-dream.md        — Dream 模式：记忆维护
multi-agent.md       — 子 Agent 派生规则
tool-guidance.md     — 工具使用最佳实践
personality-*.md     — 性格变体（friendly、pragmatic）
```

### Web Bridge（agent/unify/web-bridge.js）
- 把 Engine 事件翻译成 `claude_output` 格式
- 前端复用标准 Chat 渲染管线（MessageList、AssistantTurn、ToolLine 等）
- 消息流：`unify_group_chat` -> agent message-router -> `handleUnifyGroupChat()` -> 按 VP 调 `runVpTurn()` -> Engine.query() -> 事件 -> `unify_output` -> server -> web

### Skills 和 MCP
```
skills.js  — SkillManager：从 ~/.yeaft/skills/ 加载并匹配 skill
mcp.js     — MCPManager：连接 MCP server，桥接其工具
```

## 前端架构

- **框架**：Vue 3（CDN，无构建步骤）+ Pinia
- **API 风格**：Vue Options API，`template` 用字符串字面量（不用 SFC / `.vue` 文件）
- **组件**：`web/components/*.js` — ChatPage、UnifyPage、MessageList、ChatInput 等
- **状态**：`web/stores/chat.js` 是唯一的 Pinia store
- **渲染**：Chat 和 Unify 复用同一套 MessageList / AssistantTurn 管线
- **侧栏**：tab bar 含 Chat / Crew / Unify（session-tab-bar）
- **样式**：纯 CSS 放在 `web/styles/`（sidebar.css、chat.css、unify.css 等）
- **i18n**：内置 i18n，用 `$t()` 调用（en/zh）

### Store 关键 state（Unify 相关）
```js
currentView: 'chat' | 'unify'        // 顶层页面切换
unifyConversationId: null            // Agent session_ready 给出的虚拟 conversationId
unifyModel: null                     // 当前 model
unifyMode: 'chat' | 'work'           // Unify 内部 mode 切换
unifySessionReady: false             // Session 初始化状态
unifyStatus: null                    // { skills, mcpServers, tools }
```

### Store 关键 action（Unify 相关）
```js
enterUnify(agentId?)     // 进入 Unify 页，创建虚拟 conversationId
leaveUnify()             // 回 Chat 页
sendUnifyGroupChat({groupId,text,mentions})  // Unify 唯一发送通道（type: 'unify_group_chat'）
handleUnifyOutput(msg)   // 把 Engine 事件丢给标准 claude_output 管线
setUnifyMode(mode)       // 切 chat/work 模式
clearUnifyMessages()     // 重置 session
```

## 服务端架构

- **Express + ws**：HTTP server + WebSocket 做实时通信
- **两类 WebSocket**：agent 连接（ws-agent.js）和 web 客户端连接
- **消息中继**：Server 在 agent 和它的 owner 的 web 端之间转发消息
- **鉴权**：JWT-based（可选，开发期可走 skipAuth）
- **Agent 输出处理**：`server/handlers/agent-output.js` — 分发 claude_output 和 unify_output

## 数据流

### Chat 模式
```
Web 客户端 -> ws "send_message" -> Server -> ws agent -> Claude CLI 进程
Claude CLI -> agent -> ws "claude_output" -> Server -> ws "claude_output" -> Web 客户端
```

### Unify 模式
```
Web 客户端 -> ws "unify_group_chat" -> Server -> ws agent
  -> message-router.js -> handleUnifyGroupChat()
  -> coordinator.ingest() -> Promise.all(按 VP runVpTurn -> Engine.query())
  -> Engine 事件 -> web-bridge.js -> ws "unify_output" -> Server
  -> ws "unify_output" -> Web 客户端 -> handleUnifyOutput() -> handleClaudeOutput()
```

## 配置

### Agent 配置（~/.yeaft/config.json）
```json
{
  "providers": [
    { "name": "my-proxy", "baseUrl": "http://localhost:6628/v1", "apiKey": "proxy",
      "protocol": "openai-responses", "models": ["claude-sonnet-4-20250514", "gpt-5"] }
  ],
  "primaryModel": "my-proxy/claude-sonnet-4-20250514",
  "fastModel": "my-proxy/claude-haiku-3-20250414",
  "language": "zh",
  "debug": false,
  "maxContextTokens": 200000,
  "messageTokenBudget": 32768
}
```

## 测试

- **框架**：Vitest
- **运行**：`npx vitest run`
- **测试文件**：`test/` 目录，命名 `*.test.js`
- **Unify 相关**：`test/agent/unify-phase5.test.js`、`unify-phase6.test.js`、`unify-eval.test.js`

## 开发规范

- **语言**：ES modules（import/export），Node.js 20+
- **不用 TypeScript**：纯 JS + JSDoc 类型注解
- **无构建步骤**：前端走静态文件，Vue/Pinia 直接 CDN 引入
- **Commit 风格**：Conventional commits（`feat:`、`fix:`、`perf:`、`revert:`）
- **Tag 格式**：`v0.1.X`（用 `git tag --sort=-creatordate | head -1` 查最新）
- **Release tag**：`release-v0.1.X` 触发生产部署（仅在用户明确要求时打）
- **文档语言**：项目内 CLAUDE.md / 文档说明一律用中文；代码注释允许英文以便国际协作

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

设置类弹窗（settings、LLM 配置、Crew 配置等）必须给 **外壳一个固定的宽高比例**，切 tab 时 tab 内容滚动，**外壳尺寸不变**。

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

### 5. Unify UI 特别规则（保留旧规则）

- **不要水平分割线 / 边框**：Unify 页面 sidebar 区段、sidebar header、topbar、detail panel header 上**不**用 `border-bottom` / `border-top`。用 padding / margin 制造视觉分组，而不是画线。和 Chat、Crew 的干净观感保持一致。
- **侧栏样式一致**：Unify 侧栏视觉上必须和 Chat / Crew 侧栏一致 — 不画 section 边框、不写带下边框的大写 label、就是干净的分组 + padding。

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
7. **从 `main` 打 tag**（合并之后）：切到 main checkout（`/home/azureuser/projects/claude-web-chat`），`git checkout main && git pull`，然后 `git tag v0.1.X && git push origin v0.1.X`。

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
6. **从 main 打 tag** — 切到 `/home/azureuser/projects/claude-web-chat`，`git checkout main && git pull --ff-only`，确认 `git branch --show-current` 输出 `main`，然后 `git tag v0.1.X && git push origin v0.1.X`。tag commit 必须能从 `origin/main` 到达。
7. **清理 worktree**（`ExitWorktree action: "remove"`；带 `discard_changes: true`，因为 commit 已经通过 PR 进了 main）。

**只在以下情况停下来问** review 出现了你不能放心自动修的 Critical / Important 问题，或者修的范围真的不确定。否则不问，直接做完。

上面的禁止捷径（`HEAD:main`、给 feature 分支打 tag、push 还没到 origin/main 的 tag）依然适用 — auto-flow 是步骤 1–7，不是绕过 PR 闸门的许可证。

## 运维安全规则

- **绝不重启 / kill / 改运行中的 agent / server 进程** — 只分析代码、提 fix。进程重启交给用户或部署流水线。
- **绝不跑 `npm install -g` 或 `npm pack` 去更新运行中的 agent** — Agent 升级走 release tag 触发的 CI/CD，不走手动 npm install。
- **绝不改 `~/.yeaft/config.json` 或其他运行时配置文件**，除非用户明确允许。
- **先改代码、后部署** — 调试线上问题：读 log/code → 找 root cause → commit fix → push → 让用户决定什么时候部署。
