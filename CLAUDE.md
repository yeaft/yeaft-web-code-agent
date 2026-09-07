# Yeaft Web Code Agent

Yeaft 是运行在自有机器上的代码 Agent 的 Web 控制面。用户在浏览器中连接一台或多台 Agent，进行代码对话、管理持久任务，并使用文件、终端和 Git 工作台。执行环境、凭据和原生引擎数据留在 Agent 机器；Server 提供认证、归属管理和消息中继。

这份文档介绍项目的产品模型、架构和开发习惯。它提供做设计判断所需的背景，不规定模型的思考步骤、工具调用顺序或对话格式。安装与使用说明见 `README.md`、`README.zh-CN.md` 和 `docs/`；具体实现以当前源码和测试为准。

## 产品模型与术语

同一套 Web UI 承载三条执行路径：

- **Claude Code**（`claude-code`）：本地 Claude Code CLI 的 1:1 Chat provider。
- **GitHub Copilot**（`copilot`）：本地 Copilot CLI 的 1:1 Chat provider。
- **Yeaft 原生引擎**：自有 query loop、API provider、工具、记忆和协作能力，不模拟两个 CLI 的全部行为。

| 概念 | 在项目中的含义 |
| --- | --- |
| Agent instance | 拥有本机执行环境、配置和数据的运行实例；不是一个模型角色。 |
| VP（Virtual Person） | 可复用的角色，拥有独立 soul、角色元数据和模型偏好。角色差异是产品能力，不只是显示名称。 |
| Session | 原生引擎唯一的持久对话编排单元，包含 1..N 个 VP。单人对话与多人协作是同一种 Session，不另设 chat/group mode。 |
| Project | 用户级 Session 归属与共享 instruction；同一 Agent 上的成员 Session 可共享有来源标记的只读记忆摘要。 |
| Work Center | 跨越单次对话 turn 的持久任务系统。WorkItem 表示目标与验收条件，Action 表示工作单元，Run 表示一次执行尝试；它不是另一种 Session。 |

### 兼容术语

新代码沿用 `yeaft`、`session`、`sessionId`、`project`、`workItem`、`action` 等现行领域名称。历史名称仍是兼容契约的一部分：

| 历史名称 | 当前语义与保留原因 |
| --- | --- |
| `unify` / `unified`、`unify_*` | Yeaft 引擎的旧标识与 wire alias。 |
| `group` / `groupId` | Session 的旧 wire、磁盘字段和局部 JS 签名。 |
| `group/<id>` | 旧 memory scope，仅用于读取与迁移；新写入使用 `sessions/<id>`。 |
| `claude_output` | CLI Chat provider 共用的事件协议名，并非 Claude vendor 专属。 |

这些名称的变更涉及前端、Server、Agent、测试及磁盘迁移的完整链路，不属于局部命名清理。Reader 可兼容旧格式，writer 使用现行格式。

## 核心开发风格

- **简单、直接、边界清晰。** 实现贴近现有模块职责；能复用的组件、数据流和配置不另建平行体系。抽象服务于实际共性，而不是预设未来模式。
- **重视产品语义。** UI 状态、模型 turn、持久任务状态是不同层次；一次输出结束不自动等于任务完成，一次展示截断也不等于原始记录被丢弃。
- **可恢复、可观察。** 异步执行、重连、重试和历史回放属于正常使用场景。身份、状态与证据应能解释系统实际发生了什么。
- **兼容有归属的数据。** Session、Project、Agent instance 和 workspace 各有所有权。持久字段的设计包含数据根、原子性、升级路径和旧 reader 行为。
- **局部一致性优先。** JavaScript、模块组织、错误处理和测试写法沿用所在模块的风格；公共边界用 JSDoc 表达输入、输出与 ownership。
- **代码与文档同步表达现状。** 文档使用中文；面向用户的 README 和界面文案保持中英双语。设计方向与已实现行为分开描述。

项目使用 JavaScript，不使用 TypeScript。Agent / Server 为 ES modules；前端是浏览器 ES modules，组件采用 `.js` 中的字符串 `template`，不是 `.vue` SFC。Options API 与 Composition API 均有现存实现。`web/build.js` 是 CommonJS 构建脚本。

文件名描述职责，不采用 `*-v2.js`、`*-new.js`、`*-old.js`、`*-tmp.js` 或 `*-copy.js` 维护平行实现；一次性 schema migration 的版本名称除外，代码历史由 Git 保存。

## 运行时拓扑与所有权

```text
Browser（Vue + Pinia）
  <-> WebSocket / HTTP
Server（Express + ws + SQLite）
  <-> owner-scoped WebSocket relay
Agent instance（Workbench + CLI providers + Yeaft engine）
  <-> Provider API / 本地 CLI / 文件系统 / Shell
```

- **Browser** 负责交互、状态投影和工作台展示。
- **Server** 负责鉴权、连接、Session catalog、Project 归属、附件和中继，不执行 Yeaft 推理。
- **Agent** 负责本机代码执行、工具、provider 和原生运行数据。

跨 Agent 的 Session 身份是 **`(agentId, sessionId)`**。前端入口为 `sessionById(sessionId, agentId)`；同名 Session 不能互相覆盖。消息中继携带 owner / Agent access、Session identity 和 request correlation；乱序历史、snapshot 与 reconnect 由 conversation generation 等 fence 隔离。

Project 的权威归属在 Server SQLite 的 `yeaft_projects` / `yeaft_project_sessions`，成员包含 `agentId + sessionId`。Agent-local `projects.json` 是 legacy/fallback cache，不反向覆盖 Server 归属。Project 共享召回仅覆盖同一 Agent 上的 sibling Sessions，保留来源，不共享可写 transcript。

### 数据根与持久化所有权

`workDir` 是执行代码和加载项目文档、skills、MCP 的目录；`yeaftDir` 才拥有实例配置、Session、记忆、后台任务和 Work Center 数据。

- 默认实例：`~/.yeaft`；命名实例：`~/.yeaft/instances/<instanceId>`。
- `YEAFT_DIR` 或 service config 可覆盖数据根；命名实例的配置、manifest 与数据始终属于该实例。
- `<yeaftDir>/sessions-manifest.json` 是实例的 Session 发现索引。
- `<yeaftDir>/sessions/<sessionId>/` 包含 `session.json`、`config.json`、`conversation/index.json` 和 `conversation/segments/*.jsonl`。
- `<yeaftDir>/memory/<scope>/` 中的 `memory.md` 与 `summary.md` 是记忆真源；SQLite FTS 是可重建索引。
- `<yeaftDir>/work-center/` 包含 `work-center.db`、`settings.json` 和 `attachments/`；其 conversation / Action transcript 不写入普通 Session。

`<workDir>/.yeaft/sessions`、`group-workdirs.json`、旧 `groups/` 和旧消息格式属于 bootstrap / migration 兼容路径，不是新数据的稳态归属。

## 仓库结构

| 路径 | 主要职责 |
| --- | --- |
| `agent/providers/` | Claude Code / Copilot CLI 的 ChatProvider 驱动。 |
| `agent/connection/`、`agent/service/` | Agent 连接、中继、buffer，以及多实例配置和服务管理。 |
| `agent/workbench/` | 文件、终端、Git 等工作台后端。 |
| `agent/yeaft/` | 原生引擎、API providers、Session、记忆、工具与 Work Center。 |
| `server/handlers/`、`server/db/` | Web / Agent 请求处理、鉴权中继与 SQLite 存储。 |
| `web/components/`、`web/stores/` | Vue 组件与 Pinia 状态。 |
| `web/styles/`、`web/i18n/` | Design tokens、样式与 `en.js` / `zh-CN.js`。 |
| `test/`、`e2e/`、`scripts/` | Vitest、Playwright、测试预算和构建 / 发布门禁。 |
| `docs/` | VitePress 用户文档。 |

## Yeaft 原生引擎

`session.js#loadSession()` 组装运行环境；`engine.js` 管理单个 VP / Action 的 query lifecycle；`web-bridge.js` 将 Session 执行投影为 `yeaft_output`。`sessions/` 管理 Session 生命周期和上下文，`conversation/` 管理持久历史、搜索与可见投影。本地 CLI 入口为 `cli.js`、`cli-session-runner.js` 和 `stdio-protocol.js`；自动化的 `stream-json` stdout 是严格 JSONL。

引擎上下文包含 VP soul、Project instruction、工作目录中的 `CLAUDE.md` / `AGENTS.md`、运行环境、记忆、skills 和历史。Project instruction 来自 Server metadata，项目文档来自 `workDir`，历史内容不取代这两层。

Query 的重要契约：

- Provider 的部分输出失败按 continuation 处理，避免可见文本重放；silence watchdog 只计 provider 阶段，工具、AskUser 与异步任务有独立生命周期。
- `Engine.query()` 是 terminal boundary，正常、abort、handoff 和异常最终都产生 `turn_end { terminal: true }`。内部 loop 事件不表示 VP 已结束。
- `history-window.js` 做确定性、非 LLM 的临时历史裁剪，不改写 transcript；窗口处理后仍溢出会终止，不调用隐藏摘要 LLM。
- Raw tool output / provider trace 与进入 UI、模型上下文的有预算副本是不同数据层。可见历史过滤 internal、reflection 与敏感工具内容，首屏可轻量回放，无须等待完整引擎启动。

### LLM provider 与配置

原生模型配置由 `config.js`、`config-api.js` 与 `llm/` 读取，位于当前实例的 `<yeaftDir>/config.json`。原生 API provider 与 `agent/providers/` 的 CLI ChatProvider 是两条扩展路径。

- 支持 `anthropic` 与 `openai-responses`，不含旧 Chat Completions 协议。
- 协议解析顺序：model override → provider override → model-id inference → `openai-responses` 默认。
- 静态凭据为 `apiKey`，动态凭据为 `credentialProvider`（包括 GitHub Copilot）。
- 模型能力来自显式配置、`models.dev` cache 和 `models.js`；模型级 `maxOutput` 与 runtime 顶层 `maxOutputTokens` 是不同字段，窗口大小不在 UI / prompt 中另行硬编码。
- Session 的 `model` / `modelEffort` override 写入自己的 `config.json`，不改变 Agent 默认模型。

### 记忆、Skills 与工具

Dream 异步更新 scope 的 `memory.md` / `summary.md` 并同步 FTS；它与临时 history window 分工不同。Session scope 使用 `sessions/<sessionId>` 及其 `/user`、`/vp/<vpId>`、`/topic/...` 子域，另有 `user` scope。1:1 Yeaft / CLI chat 的 `chat/<chatId>` 与 `/vp/<vpId>` 仍是有效 scope；单数 `session/...`、`group/...`、顶层 `feature/...` 是旧格式兼容。

Skills 有 bundled、user、project tiers；`skills.js` 定义 precedence。MCP 合并 global、external user 和 project 配置。`sessions/project-doc.js` 按任务和路径选择项目文档章节，`projectDocMaxBytes: 0` 可禁用项目文档。

`tools/index.js#createFullRegistry()` 是内置工具入口。后台 shell task 属于 Session 的 TaskManager，默认 `status_only`；`model_reentry` 结果任务可唤回模型，重启后失去控制确认的任务标为 `orphaned`。子 Agent 有独立日志、预算和 terminal state；其 terminal notification 是控制上下文，不是用户原话。VP 间交接使用 `route_forward`，普通输出中的 `@vp` 不触发执行。

工具超时不代表外部副作用已停止。`managed-cli.js` 可复用或安装用户级辅助 CLI，同时保留 Node fallback，不要求系统包管理器或 `sudo`。

## Work Center

Work Center 是 Agent instance 级的持久目标执行系统，代码位于 `agent/yeaft/work-center/`。WorkItem 保存目标、验收条件、workspace、对话与附件；Action / Run 保存实际工作及其结果证据。

当前代码包含 Coordinator 驱动的动态协调（`coordinator.js`、`dynamic-coordination.js`）与旧 workflow 的兼容路径。动态路径根据已有事实创建当前必要的 Action，不预建 stages、依赖或后继；`sourceActionIds` 表达结果来源。旧 `workflow_snapshot` 等存储名称不代表新产品必须沿用 Action graph 模型。

持久化、恢复、workspace 冲突和完成契约是这一层的关键边界：

- 相同 workspace 的冲突写入串行，`isolated-write` 使用 Git worktree 并经集成汇总。`read` 分类不是工具 sandbox，也不等于运行时禁止写入。
- Action 的完成有结构化 outcome、evidence 和 acceptance checks；terminal Run 的结果证据有数据库 immutability fence。
- WorkItem 可保存有界来源 Session context。记忆复用受 owner、scope 与 canonical workspace 限制，属于不可信参考而非当前指令；不同 execution schema 的实际注入行为由 Runner 决定。

## Web、Server 与 UI 风格

前端采用 Vue 3 + Pinia。`chat.js` 管连接、conversation 投影和工作台状态，`sessions.js` 管 Agent-scoped Session inventory，`vp.js` 管角色库，`auth.js` 管身份。CLI Chat 与 Yeaft Session 复用 `MessageList` / `AssistantTurn` / `ToolLine`，但历史协议和 conversation identity 不同。

主要 wire：CLI Chat 为 `send_message` → `claude_output`；原生 Session 为 `yeaft_session_send` → `yeaft_output`。原生发送 payload 使用 `sessionId`，既有 store 签名 `sendYeaftSessionMessage({ groupId, ... })` 是局部 legacy alias。Work Center 经 Server owner check 中继到 Agent service。

开发页面使用本地 vendor 和浏览器模块；生产由 `web/build.js` / esbuild 生成 `web/dist`，无 CDN 运行时依赖。

界面风格是**现代极简、内容优先、留白清晰**。主任务容易发现，状态直接可读，避免装饰性分割线、重复卡片外壳和依赖说明书的交互。

- 颜色、背景、边框、状态、阴影、圆角与常用间距复用 `web/styles/variables.css`。新增 token 同时定义 light `:root` 和 `[data-theme="dark"]`，组件不另设硬编码颜色。
- 按钮使用 `.btn-primary` / `.btn-secondary` / `.btn-ghost`；侧栏使用 `session-tab-bar` / `session-tab`；输入控件沿用全局 focus、border、radius。
- 弹窗沿用所属模块的 overlay / shell。通用路径是 `.modal-overlay` + `.modal`，`.modal-card` 不是全局基础类。配置弹窗 header / footer 固定，中间 body 滚动。
- 图标复用现有图标或 Symbols Nerd Font；含义不只靠 hover tooltip。用户文案通过 `$t()`，中英翻译同步。
- UI 验证覆盖 light / dark、320px 窄屏、桌面、长内容滚动，以及键盘 focus、disabled、loading、error、empty 和 stale / reconnect 状态。

## 开发与验证

运行环境为 Node.js `>=22.5.0`，CI / 发布使用 Node 24；项目依赖 `node:sqlite`，Node 20 不在验证范围内。

| 命令 | 用途 |
| --- | --- |
| `npm test` | 测试预算检查 + 核心 Vitest manifest。 |
| `npm run test:focus -- path/to/file.test.js` | 指定 focused tests，包括未进入核心 manifest 的文件。 |
| `npm run test:e2e` | Playwright 浏览器验证。 |
| `npm run check:server-agent-syntax` | Agent / Server 语法检查。 |
| `npm run release:guard` | 语法、Agent package bin 与 Server startup smoke。 |
| `npm run build` | 生产前端 bundle。 |
| `npm run docs:build` | VitePress 文档构建。 |

`vitest.config.js` 的核心文件由 `scripts/test-suite-manifest.mjs` 管理；任意 `test/**/*` 使用 `vitest.focus.config.js`。裸 `npx vitest run` 不代替项目门禁。

代码改动的基线是相关 focused tests + `npm test`；Agent / Server 增加 syntax / release guard，前端增加 build，真实浏览器路径增加对应 E2E。提交前包含 `git diff --check`，验证记录对应实际执行命令与结果。

## Worktree、Review 与发布约定

Feature / fix / docs 使用从最新 `origin/main`（`git fetch origin main --tags`）建立的独立 worktree 和 PR，不直接推送 `main`。Commit 使用 Conventional Commits（如 `feat:`、`fix:`、`docs:`）。提交包含与改动面匹配的验证结果；现有 PR 自动 CI 触发关闭，没有 checks 不表示通过。

实现与独立审查的角色分工为 Linus / Martin。交接通过 `route_forward` 携带 PR number、精确 head SHA、验证与风险；Martin 的结论绑定 exact head 和 GitHub merge snapshot，检查 base、mergeability、完整 diff 与相关回归。只有明确允许 merge 后才能合并；head 或 base 漂移后原结论失效。作者账号无法正式 approve 自己的 PR 时，独立结论保留在 PR comment 和交接记录中。

合并使用 head-match 保护，不使用 `HEAD:main` / `branch:main`。发布与代码修改是分开的操作；tag 仅来自合并后重新 fetch 的 `origin/main`，版本从远端实际 tag 单一递增为 `v1.0.X`，PR merge commit、main、本地 / 远端 tag 指向一致。`v*` workflow 发布 npm Agent 与 `:dev` Docker image；`release-*` 为需要用户明确授权的生产发布。发布闭环后清理本任务 worktree，不清理其他人的分支和文件。

## 运维与安全边界

- 在线 Agent / Server 的重启、kill、升级或替换需要用户明确授权。在线 Agent 不通过 `npm install -g`、`npm pack` 或手工覆盖升级；发布使用 tag workflow。
- 实例配置、Work Center DB、Session 等运行数据不属于普通代码修改范围；变更需要明确任务授权及备份、验证方案。
- Transcript、debug trace、工具原始输出、附件和项目文档可能含敏感信息。展示、导出、搜索和召回保留 user / Agent / Session / Project ownership，只投影必要字段。
- 共享工作区保留其他人的未提交改动。不以 `git reset --hard`、`git clean -f` 或覆盖他人文件处理脏工作区。
