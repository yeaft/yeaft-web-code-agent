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
  memory/               H2-AMS, FTS index, scopes, summaries, segments
  conversation/         durable message persistence and search
  tools/                33 built-in tool definitions and registry
  sub-agent/            child-agent runner, logs, liveness, notifications
  tasks/                persistent background shell jobs
  work-center/          WorkItem/Action/Run planner, store, watcher, runner
  tool-folding/         turn reflection and long tool-arc folding
  history-window.js     deterministic provider history window
  dream/                background memory maintenance
  archive/              large/raw tool-result archive helpers
  templates/            bilingual base, unified, dream, plan, persona prompts
```

## One native turn

A normal VP turn follows this shape. `history-window.js` is deterministic and never produces a persisted summary:

1. **Pre-query** — resolve Agent/Session/VP/Project identity, project instructions, runtime platform, pending child-agent notifications, project docs, and H2-AMS recall.
2. **Build context** — combine the system prompt, VP persona, deterministic budgeted history window, current user content, and supported attachments. The Web Session source is a bounded disposable runtime cache; the complete transcript stays in ConversationStore, and no LLM conversation summary is loaded from disk.
3. **Stream LLM** — select the configured provider/model and call either the Anthropic Messages or OpenAI Responses adapter.
4. **Execute tools** — run allowed calls through `ToolRegistry`, append result blocks, and continue streaming.
5. **Fold long arcs** — periodically reflect tool batches and summarize long turns while retaining raw output in persistence/debug paths.
6. **Finish** — persist messages, usage, traces, task state, and terminal result; acknowledge injected notifications; Dream remains responsible for background semantic-memory maintenance.
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
- Dream or plan instructions when those operations run;
- the selected persona and VP metadata;
- runtime platform metadata;
- project docs and Project instruction;
- the rendered H2-AMS memory block;
- optional harness-level instructions.

Historical interactive modes have been folded into the unified contract. Dream remains a specialized memory-maintenance operation, not a user-facing Session mode.

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

MCP tools are added at runtime. Registry policy can deny tools for the current execution context. Dream maintenance is not given the same broad side-effect contract as an interactive Session turn.

Tool events and raw results are persisted for audit/debug. The context-facing representation is separately budgeted and can be folded or replaced by archive stubs; UI truncation does not mean the raw record was discarded.

## H2-AMS memory

Before each turn, pre-flow maps authorized scopes to the current Agent's memory store, extracts query keywords, and retrieves FTS hits. The Active Memory Set combines:

- resident scope summaries;
- recent items;
- on-demand full-text segments.

Dream maintenance extracts durable segments and regenerates summaries. Scope ownership is explicit: user, VP, nested VP, Session, related Project-Session, and compatibility scopes do not become one shared transcript.

See [H2-AMS memory](./yeaft-memory.md).

## Background tasks and sub-agents

- `Bash` with `background=true` creates a persistent Session task with a log.
- `ListTasks`, `ReadTaskLog`, and `CancelTask` operate on that record.
- An Agent restart marks unresolved process handles orphaned instead of pretending they are still controllable.
- Sub-agents have their own output log, liveness counters, optional budgets, and terminal/idle notifications.
- Terminal notifications are parent re-entry control context, not new user-authored semantic memory.

## Work Center integration

Work Center reuses `Engine.query()` through a runner adapter. It does not implement a second LLM/tool loop. The Run freezes Action, VP, model/effort, tool-policy, workspace, and attempt identity. A structured completion tool submits `completed`, `waiting`, `retryable`, or `failed`; a normal model `turn_end` alone cannot advance the Action.

The Coordinator uses the same model infrastructure but a restricted decision contract without file/shell/external side-effect tools.

## Persistence and compatibility

Agent-local Session metadata, history, memory, tasks, and Work Center data live under the resolved Yeaft directory. A Session `workDir` is project context only.

Older wire aliases, payload identifiers, and storage scope prefixes remain where changing them would break deployed clients or data. New code uses Session/Yeaft terminology and the canonical Session memory layout is `sessions/<id>`. Readers may still handle legacy `session/<id>` and `group/<id>` aliases during migration.

## Verification map

The test tree is organized by subsystem rather than historical phase files:

- `test/agent/yeaft/` covers history-window, conversation, memory, Sessions, sub-agents, tasks, tool folding, Work Center, and related modules;
- `test/agent/yeaft-*.test.js` covers cross-module native-engine behavior;
- `test/server/yeaft-*.test.js` and `test/web/yeaft-*.test.js` cover relay and UI integration;
- `e2e/` covers browser-visible flows.

Use `npm test`, `npm run test:e2e`, and `npm run release:guard` for the current repository-wide gates.
