# Architecture Overview

Yeaft is a three-layer system. The browser is the control surface, the Server authenticates and relays, and each Agent owns code execution plus native Yeaft runtime data.

```text
Browser (Vue 3 + Pinia)
        │ HTTP + authenticated WebSocket relay (WSS in production)
        ▼
Server (Express + ws + SQLite)
        │ owner-checked relay and browser-facing catalog
        ▼
Agent (Node.js on the code machine)
        ├── Claude Code CLI provider
        ├── GitHub Copilot CLI provider (ACP)
        ├── Native Yeaft engine
        │   ├── Session + 1..N VP orchestration
        │   ├── Anthropic / OpenAI Responses adapters
        │   ├── 33 built-in tools + Skills + MCP
        │   ├── H2-AMS memory + Dream maintenance
        │   ├── Projects and scoped sibling-Session recall
        │   └── Work Center (WorkItem → Action → Run)
        └── Workbench launcher (Terminal, Git, Files, Browser availability)
```

## Ownership boundaries

| Layer | Owns | Does not own |
| --- | --- | --- |
| **Browser** | Current UI state, unified catalog projection, locale/theme, drafts | Code execution or authoritative Agent runtime data |
| **Server** | User/auth records, invitation/admin data, browser-facing conversation catalog metadata, WebSocket routing | Native Session transcripts, Agent memory, provider credentials, or Work Center execution |
| **Agent** | CLI subprocesses, native provider calls, tools, Session history, memory, background tasks, Projects' Agent-side context, Work Center SQLite, workbench access | Server user accounts or cross-owner data |

A Session `workDir` is an execution and project-asset context. Native Session data and Work Center state remain under the Agent's Yeaft data root.

## Runtime paths

### Claude Code

```text
Web send_message
  → Server relay
  → Agent ChatProvider
  → Claude Code CLI stream-json process
  → normalized claude_output events
  → shared Web message renderer
```

One provider process owns each CLI conversation. Claude Code remains authoritative for its commands and resume behavior.

### GitHub Copilot

```text
Web send_message / permission response
  → Server relay
  → Agent Copilot ChatProvider
  → copilot --acp JSON-RPC process
  → normalized claude_output events
  → shared Web message renderer
```

ACP permission prompts and the live Copilot model catalog remain provider-specific.

### Native Yeaft Session

```text
Web yeaft_session_send
  → Server owner-checked relay
  → Agent Session coordinator
  → resolve default/@mentioned VPs
  → run VP turns independently
  → Engine query/tool loop
  → yeaft_output events
  → shared Web message renderer
```

`yeaft_session_send` is the current send channel. Historical aliases and `claude_output`-shaped rendering payloads remain for wire/storage compatibility; they are not current domain terminology.

### Work Center

```text
Browser WorkItem request
  → Server relay
  → Agent Work Center store/controller
  → triage and validated Action graph
  → watcher claims ready Actions
  → runner reuses native Engine
  → fenced Run result + evidence
  → controller advances dependents/final gate
```

Work Center is Agent-level. A source Session is an origin/link, not its storage owner. The Coordinator conversation has no side-effect tools; Action Runs receive task-specific tools and workspace policies.

## Native engine query loop

For each VP turn the engine:

1. resolves Session, VP, Project, project-doc, memory, and pending sub-agent context;
2. builds a prompt and compacted history within token budgets;
3. streams from the selected Anthropic Messages or OpenAI Responses adapter;
4. executes allowed tools and folds long tool arcs;
5. persists raw events, messages, usage, and traces;
6. adjusts H2-AMS, triggers Dream/compact when required, and reports stop/result events.

Context errors can force compact/retry; configured fallback models handle eligible provider failures. Background jobs and child agents use persistent Session-scoped task records.

## Main source layout

```text
server/                     Express/ws relay, auth, catalog, SQLite, port proxy
agent/
  providers/                Claude Code and Copilot CLI ChatProvider adapters
  connection/               Agent WebSocket and message routing
  yeaft/
    engine.js               Native query/tool loop
    sessions/               Session roster, store, coordinator, pre-flow
    projects/               Agent-side Project context store
    llm/                    Anthropic/OpenAI Responses adapters and routing
    memory/                 H2-AMS, FTS index, summaries, segments
    tools/                  33 built-in tools
    work-center/            WorkItem/Action/Run store, planner, watcher, runner
    sub-agent/              Child-agent execution and notifications
    tasks/                  Background shell task persistence
  workbench/                Route-scoped Terminal, Git, files, and Browser runtime services
web/                        Vue 3 Options API + Pinia + static CSS/i18n
server/                     Express/ws control plane
test/                       Vitest unit and integration tests
e2e/                        Playwright browser tests
docs/                       Bilingual VitePress documentation
```

## Project and memory flow

The Server catalog gives the browser one Agent-aware view of native and CLI conversations. Project membership is synchronized to Agents. Before a native turn, the current Agent can resolve same-Agent sibling Sessions in the Project and include their source-labelled, read-only scopes in H2-AMS recall.

This is not transcript merging. User, VP, Session, Project-related Session, WorkItem, and legacy compatibility scopes keep explicit ownership and ACL rules.

## Security-relevant paths

- Browser/Server auth supports JWT, optional TOTP/email verification, and configurable SSO providers.
- Current Web and Agent peers negotiate plaintext JSON payloads after authentication; production confidentiality depends on HTTPS/WSS transport security.
- TweetNaCl payload encryption is retained only as a compatibility fallback when a legacy peer does not negotiate plaintext.
- The Server enforces owner routing for Agent and WebSocket traffic.
- Provider credentials, raw tool output, project files, debug traces, and native runtime storage stay on the Agent unless explicitly returned to the browser.
- `SKIP_AUTH` and local mode are development/trusted-workstation paths, not public deployment settings.

## Build and release

- `npm test` runs the core Vitest manifest.
- `npm run test:e2e` runs Playwright.
- `npm run release:guard` imports Server/Agent modules and performs a Server startup smoke test.
- `npm run build` creates production Web assets.
- `npm run docs:build` builds the bilingual VitePress site.
- A `v1.0.*` tag triggers the development release workflow; `release-v1.0.*` is the explicit production release tag. Release workflows validate that the tag points to current `main` before publishing npm/Docker artifacts.

## Related reference

- [CLI provider system](./providers.md)
- [Native Yeaft engine](./yeaft-engine.md)
- [H2-AMS memory](./yeaft-memory.md)
- [Native LLM layer](./yeaft-llm.md)
- [WebSocket protocol](./wire-protocol.md)
- [WebRTC Browser Runtime design](../../notes/2026-08-07-webrtc-browser-runtime-design.md)
- [Work Center user contract](../user/work-center.md)
