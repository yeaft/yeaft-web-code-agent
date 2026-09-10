# 原生 Yeaft Engine

原生 engine 位于 `agent/yeaft/`，不依赖 Claude Code 或 GitHub Copilot CLI。它拥有自己的 LLM adapter、Session/VP 编排、tool loop、memory、persistence、sub-agent、background job 和 Work Center runner integration。

> 本页面向开发者。产品行为请阅读 [Yeaft Session 与 Project](../user/yeaft-session.md) 和 [Work Center](../user/work-center.md)。

## 主要模块

```text
agent/yeaft/
  engine.js             query/tool loop、retry、folding、persistence
  session.js            加载一个 engine context 与配套子系统
  web-bridge.js         Web Session/VP 与 event bridge
  cli-session-runner.js transport-neutral multi-VP CLI Session runner
  sessions/             roster、store、coordinator、pre-flow、CRUD
  projects/             Agent-side Project context store
  vp/                   VP library、persona loader、default、registry
  llm/                  adapter router、Anthropic、OpenAI Responses、credential
  memory/               H2-AMS、FTS index、scope、summary、segment
  conversation/         持久 message 与搜索
  tools/                33 个内置工具定义和 registry
  sub-agent/            child-agent runner、log、liveness、notification
  tasks/                持久 background shell job
  work-center/          WorkItem/Action/Run planner、store、watcher、runner
  tool-folding/         turn reflection 与长 tool arc folding
  compact/              context compaction
  dream/                后台 memory maintenance
  archive/              大型/raw turn 与 tool-result archive helper
  templates/            双语 base、unified、dream、plan、persona prompt
```

## 一个原生 turn

普通 VP turn 按以下步骤运行：

1. **Pre-query** — 解析 Agent/Session/VP/Project identity、project instruction、runtime platform、pending child-agent notification、project docs 与 H2-AMS recall。
2. **构造 context** — 组合 system prompt、VP persona、确定性的有预算 history window、当前 user content 和支持的 attachment。Web Session 只保留有界的临时 runtime cache，完整 transcript 仍由 ConversationStore 持有；不再从磁盘加载 LLM 对话摘要。
3. **Stream LLM** — 选择配置的 provider/model，调用 Anthropic Messages 或 OpenAI Responses adapter。
4. **执行工具** — 通过 `ToolRegistry` 运行允许的 call，append result block 并继续 stream。
5. **Fold 长 arc** — 周期性 reflect tool batch，并 summary 长 turn，同时在 persistence/debug 路径保留 raw output。
6. **结束** — 持久化 message、usage、trace、task state 和 terminal result；确认已注入 notification；Dream 负责后台语义 Memory 维护。
7. **恢复** — 在配置上限内 auto-continue `max_tokens`；context error 直接暴露，不触发隐藏摘要调用；分类为 retryable 的 failure 可以切换 eligible fallback model。

Abort signal 会传入 adapter 和 tools。Engine 区分 user abort、auth error、rate limit、server failure、idle timeout 与 context failure，不把所有 stop 当成 generic error。

## Session 与 VP 编排

Session coordinator 根据 roster 解析接收者：

```js
const recipients = resolveVps(mentions, roster, defaultVpId);
await Promise.all(recipients.map(vp => runVpTurn(session, vp, input)));
```

真实 API 还有 identity、attachments、quoting、routing 和 persistence 字段；这个 pseudocode 只展示 fan-out。关键规则是：

- 每个 turn 只持久化一条 canonical user message；
- 没有 mention 时发送给 default VP；
- 显式 mention 发送给匹配的 roster member；
- 每个 selected VP 有独立 engine/persona/memory context；
- VP event 保留 `sessionId`、`vpId`、turn/thread identity 与 source order；
- Peer handoff 使用 `RouteForward` tool 与 loop guard，不依赖文本 mention。

Web path 使用 `web-bridge.js`。直接运行的 `yeaft` CLI 使用 transport-neutral Session runner，使 Session ID 和 multi-VP 语义一致。

## Prompt 构造

`prompts.js` 组合：

- `templates/base.md`、`identity-yeaft.md` 和 `common-rules.md`；
- 唯一的 interactive `mode-unified.md` contract；
- Dream 或 plan operation 的专用 instruction；
- selected persona 与 VP metadata；
- runtime platform metadata；
- project docs 与 Project instruction；
- 渲染后的 H2-AMS memory block；
- 可选 harness-level instruction。

历史 interactive mode 已收敛进 unified contract。Dream 仍是专用 memory-maintenance operation，不是面向用户的 Session mode。

## LLM adapter

`AdapterRouter` 按以下优先级解析 provider 与 protocol：

1. per-model protocol override；
2. provider protocol；
3. model-ID heuristic；
4. OpenAI Responses fallback。

支持的 protocol 是 `anthropic` 和 `openai-responses`。Provider entry 可以使用静态 `apiKey` 或已支持的 dynamic credential provider。Context/output limit 来自 model override、bundled catalog 或保守 default。Model effort 会在支持时转换成 Anthropic thinking/output effort 或 OpenAI reasoning effort。

参见[原生 LLM 层](./yeaft-llm.md)。

## 工具系统

`createFullRegistry()` 当前注册 33 个内置工具：

- files 与 patch；
- grep/glob/directory/disk/history search；
- foreground/background shell job 与 task log；
- Git worktree enter/exit；
- Web search/fetch、local image view 与 image generation；
- JavaScript REPL 与 notebook edit；
- planning、visible todo 与 user question；
- 持久 WorkItem 创建；
- sub-agent spawn/prompt/wait/list/close 与显式 VP routing；
- Skills。

MCP tool 在 runtime 添加。Registry policy 可以针对当前 execution context deny tool。Dream maintenance 不拥有与 interactive Session turn 相同的广泛 side-effect contract。

Tool event 与 raw result 会持久化用于 audit/debug。进入 context 的表示另有预算，并可能 fold 或变成 archive stub；UI truncation 不表示 raw record 已丢失。

## H2-AMS memory

每个 turn 前，pre-flow 将授权 scope 映射到当前 Agent memory store，提取 query keyword 并获取 FTS hit。Active Memory Set 组合：

- resident scope summary；
- recent item；
- on-demand full-text segment。

Dream maintenance 提取持久 segment 并重建 summary。Scope ownership 是显式的：user、VP、nested VP、Session、related Project-Session 和 compatibility scope 不会变成一份共享 transcript。

参见 [H2-AMS memory](./yeaft-memory.md)。

## Background task 与 sub-agent

- `Bash` 使用 `background=true` 会创建带 log 的持久 Session task。
- `ListTasks`、`ReadTaskLog` 和 `CancelTask` 操作这条 record。
- Agent restart 后，未解决的 process handle 会标为 orphaned，不会假装仍可控制。
- Sub-agent 有自己的 output log、liveness counter、可选 budget 和 terminal/idle notification。
- Terminal notification 是 parent re-entry control context，不是新的 user-authored semantic memory。

## Work Center integration

Work Center 通过 runner adapter 复用 `Engine.query()`，不实现第二套 LLM/tool loop。Run 会冻结 Action、VP、model/effort、tool-policy、workspace 与 attempt identity。Structured completion tool 提交 `completed`、`waiting`、`retryable` 或 `failed`；普通 model `turn_end` 不能推进 Action。

Coordinator 使用相同 model infrastructure，但其 decision contract 受限，没有 file/shell/external side-effect tool。

## Persistence 与兼容

Agent-local Session metadata、history、memory、tasks 和 Work Center data 位于解析出的 Yeaft directory。Session 的 `workDir` 只是 project context。

旧 wire alias、payload identifier 和 storage scope prefix 会在修改可能破坏已部署 client/data 的地方保留。新代码使用 Session/Yeaft 术语，canonical Session memory layout 是 `sessions/<id>`；迁移期间 reader 仍可能处理 legacy `session/<id>` 与 `group/<id>` alias。

## 验证映射

Test tree 按 subsystem 组织，不再使用历史 phase 文件：

- `test/agent/yeaft/` 覆盖 compact、conversation、memory、Sessions、sub-agent、tasks、tool folding、Work Center 等模块；
- `test/agent/yeaft-*.test.js` 覆盖 cross-module native-engine behavior；
- `test/server/yeaft-*.test.js` 与 `test/web/yeaft-*.test.js` 覆盖 relay/UI integration；
- `e2e/` 覆盖 browser-visible flow。

当前 repository-wide gate 使用 `npm test`、`npm run test:e2e` 和 `npm run release:guard`。
