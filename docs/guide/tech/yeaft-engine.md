# Native Yeaft Engine

The native engine lives in `agent/yeaft/`. It does not require Claude Code or GitHub Copilot CLI. It owns its LLM adapters, Session/VP orchestration, tool loop, memory, persistence, sub-agents, background jobs, and Work Center runner integration.

> This page is for developers. For the product behavior, read [Yeaft Sessions and Projects](../user/yeaft-session.md) and [Work Center](../user/work-center.md).

## Main modules

```text
agent/yeaft/
  engine.js             query/tool loop, retries, folding, persistence
  session.js            loads one engine context and supporting subsystems
  web-bridge.js         Web Session/VP and event bridge
  cli-session-runner.js transport-neutral multi-VP CLI Session runner
  sessions/             roster, store, coordinator, pre-flow, CRUD
  projects/             Agent-side Project context store
  vp/                   VP library, persona loader, defaults, registry
  llm/                  adapter router, Anthropic, OpenAI Responses, credentials
  memory/               retained, disabled H2-AMS implementation
  conversation/         durable message persistence and search
  tools/                33 built-in tool definitions and registry
  sub-agent/            child-agent runner, logs, liveness, notifications
  tasks/                persistent background shell jobs
  work-center/          WorkItem/Action/Run planner, store, watcher, runner
  tool-folding/         execution log, duplicate hints, legacy reflection helpers
  history-window.js     deterministic provider history window
  dream/                retained, disabled maintenance implementation
  archive/              large/raw tool-result archive helpers
  templates/            bilingual base, unified, retained dream, plan, persona prompts
```

## One native turn

A normal VP turn follows this shape. `history-window.js` is deterministic and never produces a persisted summary:

1. **Pre-query** — resolve Agent/Session/VP/Project identity, project instructions, runtime platform, pending child-agent notifications, project docs, and bounded current-Session history.
2. **Build context** — combine the system prompt, VP persona, deterministic budgeted history window, current user content, and supported attachments. The Web Session source is a bounded disposable runtime cache; the complete transcript stays in ConversationStore, and no LLM conversation summary is loaded from disk.
3. **Stream LLM** — select the configured provider/model and call either the Anthropic Messages or OpenAI Responses adapter.
4. **Execute tools** — run allowed calls through `ToolRegistry`, append result blocks, and continue streaming.
5. **Compact under pressure** — when current-turn results exceed the actual model-window budget (including system, schemas, and output reserve), compact older tool-result text in the provider copy first. Preserve tool pairing and raw persistence/debug output; no periodic reflection or extra in-turn summary call runs. If still oversized, use deterministic protocol-unit eviction and bounded overflow recovery.
6. **Finish** — persist messages, usage, traces, task state, and terminal result; acknowledge injected notifications; optionally produce the separate post-turn compact for a future history window.
7. **Recover** — auto-continue `max_tokens` responses within the configured limit; surface context errors without a hidden summary call; use an eligible fallback model for classified retryable failures.

An abort signal is threaded through the adapter and tools. The engine distinguishes user aborts, auth errors, rate limits, server failures, idle timeouts, and context failures instead of treating every stop as a generic error.

## Session and VP orchestration

The Session coordinator resolves recipients from the roster:

```js
const recipients = resolveVps(mentions, roster, defaultVpId);
await Promise.all(recipients.map(vp => runVpTurn(session, vp, input)));
```

The actual API has additional identity, attachments, quoting, routing, and persistence fields; this pseudocode only shows fan-out. The important rules are:

- one canonical user message is persisted for the turn;
- no mention targets the default VP;
- explicit mentions target the matching roster members;
- each selected VP has independent engine/persona/memory context;
- VP events retain `sessionId`, `vpId`, turn/thread identity, and source order;
- peer handoff uses the `RouteForward` tool and loop guards, not text mentions.

The Web path uses `web-bridge.js`. The direct `yeaft` CLI uses the transport-neutral Session runner so Session ID and multi-VP semantics stay aligned.

## Prompt construction

`prompts.js` combines:

- `templates/base.md`, `identity-yeaft.md`, and `common-rules.md`;
- the single interactive `mode-unified.md` contract;
- plan instructions, plus retained Dream templates that are no longer dispatched;
- the selected persona and VP metadata;
- runtime platform metadata;
- project docs and Project instruction;
- optional harness-level instructions.

Historical interactive modes have been folded into the unified contract. Dream is disabled; legacy dispatch commands return `disabled`.

## LLM adapters

`AdapterRouter` resolves provider and protocol from config:

1. per-model protocol override;
2. provider protocol;
3. model-ID heuristic;
4. OpenAI Responses fallback.

Supported protocols are `anthropic` and `openai-responses`. Provider entries may use static `apiKey` values or supported dynamic credential providers. Context/output limits come from model overrides, the bundled catalog, or conservative defaults. Model effort is translated to Anthropic thinking/output effort or OpenAI reasoning effort where supported.

See [Native LLM layer](./yeaft-llm.md).

## Tool system

`createFullRegistry()` currently registers 33 built-in tools:

- files and patches;
- grep/glob/directory/disk/history search;
- foreground/background shell jobs and task logs;
- Git worktree entry/exit;
- Web search/fetch, local image viewing, and image generation;
- JavaScript REPL and notebook editing;
- planning, visible todos, and user questions;
- persistent WorkItem creation;
- sub-agent spawn/prompt/wait/list/close and explicit VP routing;
- Skills.

MCP tools are added at runtime. Registry policy can deny tools for the current execution context.

Tool events and raw results are persisted for audit/debug. The context-facing representation is separately budgeted and can be folded or replaced by archive stubs; UI truncation does not mean the raw record was discarded.

## Retired H2-AMS memory

Dream/H2-AMS modules and legacy data remain for compatibility and technical reference, but the current runtime does not migrate, synchronize, read, recall, or inject them. Interactive turns and Work Center use their own current sources instead. Legacy enable/manual commands return `disabled`; the Web debug surface has no Dream tab or settings. Historical messages and ordinary debug records remain intact. Post-turn compact is a separate active history-window feature.

See [Retired H2-AMS implementation](./yeaft-memory.md).

## Background tasks and sub-agents

- `Bash` with `background=true` creates a persistent Session task with a log.
- `ListTasks`, `ReadTaskLog`, and `CancelTask` operate on that record.
- An Agent restart marks unresolved process handles orphaned instead of pretending they are still controllable.
- Sub-agents have their own output log, liveness counters, optional budgets, and terminal/idle notifications.
- Terminal notifications are parent re-entry control context, not new user-authored semantic memory.

## 活跃签名上下文的预算与压缩

模型窗口和输出上限来自显式模型配置、已缓存的模型目录及默认值，不按 Claude 家族统一硬编码。能力查询先保留目录中的完整模型 ID；未命中时，逐层移除斜杠前缀，按从长到短的后缀查询（例如 `loki/sandbox/claude-fable-5-2` → `sandbox/claude-fable-5-2` → `claude-fable-5-2`），首先命中的目录条目生效，因此真实命名空间条目优先于裸模型名。不做模糊版本匹配；显式 `contextWindow` / `maxOutput` 仍优先。所有候选均未命中目录时，仅对已知的准确版本 `claude-fable-5-2` 使用 1M 上下文能力兜底，优先于实例的旧全局窗口；不推断其输出上限，也不扩大其他 Claude 型号。这里仅影响能力查询，不改变发送给 provider 的模型 ID。未知模型无元数据或显式限制时默认使用 1M；目录和模型配置中较小的已知窗口仍优先。新初始化配置同样使用 1M；已有实例配置不自动重写。

Anthropic 保留 thinking 的工具循环会冻结已经发送的 system、工具定义和消息前缀。后续请求不能通过删旧消息、修改签名 assistant 或重新采样已发送结果来腾空间，否则续传校验会失败。

- 完整报告的 input usage（含明确的 cache 计数或 cache 已计入 input 的标记）可校正前缀估算，包括向下修正。缺失／部分 usage 不能把未知 cache 当作零，继续保留上次请求的校准预算下界。
- 只估算冻结前缀之后新增加的响应和工具结果；先缩小输出预留。如果连最低输出空间都不足，只在 provider 请求副本中采样最新签名 assistant **之后、尚未发送**的工具结果文本。保留首尾与省略标记、错误字段、工具关联、图片／文档和消息顺序；原始 transcript 与调试记录不变。
- 请求成功后，实际发送的采样副本成为新的冻结前缀，后续不能重写。输入预算达到模型窗口 85%、不可变前缀放不下，或已成功执行过的循环收到 provider 上下文超限时，自动进入 context rollover。
- rollover 在完整本地工具批次结束后，将可见对话、用户追加、工具参数与结果分块摘要，再分层合并为有界交接。不发送旧 providerState、私有 thinking 或签名，也不调用原工具；使用相同模型和捕获的渠道配置。每次摘要请求都计算输入、输出及 framing 预算，计入子 Agent 请求额度并即时交付 usage，支持预算取消。
- 摘要必须正常完成并符合大小预算；拒绝、不完整或超长摘要不会通过静默截断冒充成功。成功后仅替换 provider 请求上下文；保留当前用户 query、执行／防重复账本、任务身份、最新 system／工具权限及完整原始 transcript。原始用户要求和之后的用户修正单独原文保留，不只依赖有损摘要。
- 多次 rollover 压缩上一份摘要与增量，不反复发送整个原始历史；原始会话与签名记录不删除、不覆盖。派生摘要使用现有 revision-fenced compact 缓存，供后续轮使用；不伪造新的用户指令或授权。
- 子 Agent 只剩最后一次汇报机会时，不额外调用摘要模型：给唯一的无工具汇报请求提供带省略标记的原始证据摘录，明确缺失及不确定性，不消耗或绕过保留的汇报额度。
- 摘要失败保留源上下文并报告 `CONTEXT_COMPACTION_FAILED`，取消仍是 aborted；签名／归属／投影错误不自动绕过，尚在 pause_turn 的服务端操作也不通过换轮重发。基础 system／schemas 和原始用户要求本身放不下等情况仍有明确错误，不放宽真实模型窗口。
- 原有响应结束后的异步 post compact 保留；rollover 是执行中容量恢复，不等于任务完成。

## 响应时间与证据复用

这些优化不更换用户选择的模型／推理强度，也不减少验证：

- **稳定入口优先**：各 VP 共用的核心规则要求先使用当前权威 skill／命令，检查权限、版本和实时状态。出现缺失、矛盾或过期证据再深入实现；独立检查可以同批提出，有依赖的操作仍有序执行。
- **已返回正文的无损引用**：同一 query 内，QueryProgress 已确认的成功只读重复结果，只有在最终请求仍保留完整且逐字节相同的原正文时，才可把较旧副本替换为明确引用。最新整个工具批次、错误、混合图片／文档结果保持原样。不改变工具执行、参数、原始 transcript、UI 或 trace；原正文被窗口采样／移除时不生成引用。`tool_result_compact` 性能事件分别记录采样与引用节省的估算 token，不包含正文。
- **等待与读取合并**：`WaitTask({ taskId, include_log: true, offset, maxBytes })` 等待后通过现有所有权检查读取日志，最多 4096 字节；省略 `offset` 取末尾，传上次 `nextOffset` 读取增量。`log.omittedBefore` 表示前段省略，`log.truncated` 表示仍有后段，`log.endOffset` 不是已读游标。`resultConsumed` 仍为 false，不把片段当作完整结果；更多证据使用 `ReadTaskLog`。默认不带日志的旧行为不变，取消等待不取消任务，子 Agent 结果仍用 `WaitAgent` 收集。
- **后续回复等待**：未指定 `timeout_ms` 时，`WaitAgent` 对待收集的 `PromptAgent` 回复默认等待 120 秒，正常返回即提前结束，减少 5 秒后纯粹为再次等待的模型往返。普通 SpawnAgent 仍默认 5 秒，显式超时（含零）优先，不改变生命周期、取消和证据 revision。
- **可核验交接与连续复审**：子 Agent 交付版本、产物与实际验证；父级核验必要证据而非重走完整调查。修复 Findings 后优先继续已有 idle reviewer，确认旧／新 head 后审增量及受影响行为；基线、设计或风险变化或原覆盖不足时扩大审查。独立判断和必要回归不因此省略。

`npm test` 使用一次真实 Vitest 执行的公开 collection 统计预算（含 skip／todo／each），不再全量导入一次后重新执行。测试文件仍串行，browser 清单每次重新收集；缺失／未审核文件、过滤、收集错误、断言失败与超预算均失败。`npm run test:budget` 保留独立的仅收集检查，定向执行仍用 `npm run test:focus -- <files>`。

这些是可验证的机制收益，不代表已证明所有真实任务的端到端加速比例。需要同时比较首次有用结果、完整完成时间、请求／工具数量、正确性、用户纠偏和实际验证；模型输出、外部 API、真实计算和授权等待应分别归因。

## Work Center integration

Work Center reuses `Engine.query()` through a runner adapter. It does not implement a second LLM/tool loop. The Run freezes Action, VP, model/effort, tool-policy, workspace, and attempt identity. A structured completion tool submits `completed`, `waiting`, `retryable`, or `failed`; a normal model `turn_end` alone cannot advance the Action.

The Coordinator uses the same model infrastructure but a restricted decision contract without file/shell/external side-effect tools.

## Persistence and compatibility

Agent-local Session metadata, history, memory, tasks, and Work Center data live under the resolved Yeaft directory. A Session `workDir` is project context only.

Web Session 上传附件保存在 `<yeaftDir>/sessions/<sessionId>/attachments/`，transcript 仅保存轻量引用，不写入图片 base64。当前消息直接携带图片，无须 `ViewImage`。`attachments.js` 的 `hydratePersistedUserAttachmentContent(row, { yeaftDir, sessionId, legacyRoot })` 将原始用户行还原为标准图片 content parts；批量入口为 `hydratePersistedAttachmentHistory(rows, opts)`。Engine 在 canonical history 和 `relatedHistoryTurns[].messages` 进入历史预算前各调用一次，不能依赖 Web bridge 装饰 store，也不能把还原结果写回 transcript。历史预览与模型历史共用受控读取，拒绝跨 Session、跨实例、任意路径与符号链接；缺失或不可访问的图片会在返回的模型上下文中明确提示重新上传。`legacyRoot` 指旧上传时的 Agent CWD（默认当前进程 CWD），仅兼容其下 `.claude-tmp-attachments/<sessionId>/` 的相对引用，不搜索项目 `workDir`。Session copy/fork 在历史前缀筛选后安全读取并复制可用附件至目标 Session，重映射引用；目标 Session 不能借原路径读取源 Session 图片。显式开启 DebugTrace 的全量诊断记录仍可能包含图片数据，不属于轻量 transcript 保证范围。

Older wire aliases, payload identifiers, and storage scope prefixes remain where changing them would break deployed clients or data. New code uses Session/Yeaft terminology and the canonical Session memory layout is `sessions/<id>`. Readers may still handle legacy `session/<id>` and `group/<id>` aliases during migration.

## Verification map

The test tree is organized by subsystem rather than historical phase files:

- `test/agent/yeaft/` covers history-window, conversation, memory, Sessions, sub-agents, tasks, tool folding, Work Center, and related modules;
- `test/agent/yeaft-*.test.js` covers cross-module native-engine behavior;
- `test/server/yeaft-*.test.js` and `test/web/yeaft-*.test.js` cover relay and UI integration;
- `e2e/` covers browser-visible flows.

Use `npm test`, `npm run test:e2e`, and `npm run release:guard` for the current repository-wide gates.
