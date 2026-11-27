# What is Yeaft?

Yeaft Web Code Agent is a browser control plane for code agents that execute on your connected machines. It combines vendor CLI conversations with Yeaft's native multi-provider engine instead of forcing every workflow through one provider or one runtime.

![A native Yeaft Session with implementation and review VPs](/images/session.png)

## The system in four objects

| Object | Responsibility |
| --- | --- |
| **Agent** | Runs on the machine that owns the code. It executes tools, starts optional CLI providers, calls native LLM providers, and stores Agent-local Yeaft data. |
| **Session** | The native engine's durable conversation unit. A Session has 1..N VPs, one timeline, a working directory, model settings, announcement, and scoped memory. |
| **VP** | A reusable Virtual Person with a persona, localized role metadata, traits, and a primary/fast model hint. |
| **Project** | Groups native Sessions and supplies a shared instruction. Related Sessions on the same Agent can recall scoped summaries without merging their transcripts. |

A one-VP Session is the normal focused coding-assistant shape. Adding VPs does not switch to a different mode; it only gives the same Session more roles to address in parallel.

## Choose an execution path

| Path | Use it when | Runtime boundary |
| --- | --- | --- |
| **Claude Code** | You want Claude Code's exact tools, skills, MCP behavior, compact/clear commands, and resume model | A locally installed Claude Code CLI process per conversation |
| **GitHub Copilot** | You want Copilot entitlement, ACP permission prompts, and Copilot's model catalog | A locally installed `copilot --acp` process per conversation |
| **Yeaft Code Agent** | You want provider-neutral native execution, 1..N VPs, scoped memory, Projects, and built-in tools | The native engine inside `yeaft-agent`; no vendor CLI subprocess |

The three paths share navigation and rendering where their event models overlap, but their provider-specific commands and persistence semantics remain explicit. See [Choose a code agent path](./user/choose-backend.md).

## Native Session collaboration

A Yeaft Session can:

- route one user turn to a default VP or to several `@mentioned` VPs;
- show each VP's streamed response and tool evidence in the shared timeline;
- use explicit `RouteForward` handoffs between current Session members;
- run background shell jobs and sub-agents with durable status records;
- search and page persisted history;
- inspect model routing, token usage, tool calls, and stop reasons.

Projects add organization and controlled context sharing. A Project instruction is injected into each member Session, but sibling Session transcripts and legacy summaries are not automatically recalled or injected.

## Providers, tools, and memory

The native LLM layer supports Anthropic Messages and OpenAI Responses protocols. Providers may use static API keys or supported dynamic credentials such as GitHub Copilot, and each model can override protocol and limits.

The built-in native registry contains built-in tools covering files, patches, shell/background tasks, Git worktrees, search, Web access, images, notebooks, planning, and agent/VP orchestration. Skills and MCP servers may add more tools, so the effective list depends on the Agent and Session policy.

Dream/H2-AMS is retired from the active runtime. Native turns use a bounded window of the current Session’s persisted history; they do not recall or inject legacy memory or sibling Session summaries. Existing memory files are retained on the Agent, and post-turn compact remains a separate history-window feature.

## Browser workspace

Beyond the native engine, the Web application provides:

- a unified, Agent-aware Session catalog organized as a folder tree (nestable Project folders, then top-level Sessions);
- terminal, Git status/diff, file browser/editor, and port proxy;
- up to three side-by-side Claude Code/Copilot conversation panes;
- an Expert Panel for Claude Code conversations;
- English/Chinese localization and light/dark themes;
- authentication, optional TOTP/email verification, per-user Agent secrets, and administration views.

## Ownership and security boundary

Code execution and native Yeaft runtime data stay on the Agent. The central server authenticates users, stores browser-facing account/catalog metadata, and relays owner-checked WebSocket traffic. A Session `workDir` selects the project execution context; it does not own Session transcripts, memory, or task data.

Raw tool output, debug traces, attachments, model credentials, and local project files are sensitive. See [Security](./security.md) before exposing a deployment beyond a trusted network.

## Next steps

- [Get started locally or connect an Agent](./getting-started.md)
- [Learn Sessions and Projects](./user/yeaft-session.md)
- [Configure providers and models](./yeaft-config.md)
- [Understand the architecture](./tech/architecture.md)
