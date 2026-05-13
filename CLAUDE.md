# Claude Web Chat (Yeaft)

A web-based AI chat application with three interaction modes: **Chat** (1:1 conversations via Claude CLI), **Crew** (multi-agent team collaboration), and **Unify** (single-session AI companion with its own engine).

## Project Structure

```
agent/           — Node.js agent (runs on user's machine, connects to server via WebSocket)
  claude.js      — Claude CLI wrapper (Chat mode)
  conversation.js — Chat conversation management
  crew.js        — Crew mode entry
  crew/          — Crew multi-agent subsystem
  sdk/           — Claude SDK wrapper (query, stream, utils)
  connection/    — WebSocket connection, message routing, heartbeat
  unify/         — Yeaft Unify engine (self-contained AI engine, NOT Claude CLI)
server/          — Express + WebSocket server (relay between agents and web clients)
  handlers/      — Message handlers (agent-output, client-conversation, etc.)
web/             — Frontend (Vue 3 Options API, no build step, served as static files)
  components/    — Vue components (ChatPage, UnifyPage, MessageList, etc.)
  stores/        — Pinia stores (chat.js is the main state store)
  styles/        — CSS files
test/            — Vitest tests
```

## Three Modes

### Chat Mode (Legacy)
- Uses Claude CLI (`agent/claude.js`) as the AI backend
- Each conversation = separate Claude CLI process
- Multi-session: sidebar lists multiple chat sessions
- Agent acts as a bridge: web -> server -> agent -> Claude CLI -> agent -> server -> web

### Crew Mode
- Multi-agent team collaboration (PM, devs, reviewers, testers, designer, architect)
- Roles defined in `.crew/roles/*/CLAUDE.md`
- Uses `---ROUTE---` protocol for inter-role messaging
- Feature tracking via `.crew/context/features/` and kanban at `.crew/context/kanban.md`

### Unify Mode (New - Active Development)
- **Single session** — no multi-session concept; one continuous conversation
- **Own engine** — does NOT use Claude CLI; has its own query loop (`agent/unify/engine.js`)
- **Memory system** — persistent memory with recall, consolidation, and dream maintenance
- **Multi-provider LLM** — routes to different providers via `AdapterRouter`
- **Tool system** — 40+ built-in tools with mode-based filtering (chat vs work)
- **Multi-agent orchestration** — can spawn sub-agents for parallel task execution

## Unify Architecture (agent/unify/)

### Core Components

```
engine.js        — Main query loop (turn-based: prompt -> LLM -> tool_calls -> execute -> repeat)
session.js       — Session orchestrator (loadSession wires all subsystems together)
web-bridge.js    — Translates Engine events -> claude_output format for frontend reuse
config.js        — Config from ~/.yeaft/config.json (providers, models, limits)
prompts.js       — Bilingual system prompt builder (en/zh)
models.js        — Model registry (context windows, output limits, provider detection)
```

### Engine Query Loop (engine.js)
1. Pre-query: recall memories -> inject into system prompt
2. Build messages array (with compact summary if available)
3. Call adapter.stream() -> collect text + tool_calls
4. If tool_calls -> execute tools -> append results -> goto 3
5. If end_turn -> persist messages -> check consolidation -> done
6. If max_tokens -> auto-continue (up to 3 times)
7. On LLMContextError -> force compact -> retry
8. On retryable error with fallbackModel -> switch model -> retry

### LLM Layer (agent/unify/llm/)
```
adapter.js           — Base LLMAdapter class + error types + createLLMAdapter()
router.js            — AdapterRouter: routes model -> provider, lazy-creates adapters
anthropic.js         — Anthropic Messages API adapter
chat-completions.js  — OpenAI Chat Completions API adapter (covers proxy, DeepSeek, Gemini, etc.)
```
- Config: `~/.yeaft/config.json` with `providers[]` array
- Each provider: `{ name, baseUrl, apiKey, protocol?, models[] }`
- Protocol: `"anthropic"` or `"openai"` (default)

### Memory System (agent/unify/memory/) — H2-AMS architecture

```
segment-store.js  — Atomic markdown segments under <scope>/segments/*.md (storage primitive)
segment-sync.js   — Mirrors segment writes/deletes into the FTS index
segment.js        — Segment record helpers
index-db.js       — SQLite FTS5 index over all segments (one row per segment, per scope)
store-v2.js       — Layer-A summary read/write at <scope>/summary.md
ams.js            — Active Memory Set: three-layer cache (Resident summary / Recent / OnDemand)
ams-registry.js   — Group-keyed AMS persistence (hydrate + persist with adjustRanThisSession)
preflow.js        — Pre-turn FTS recall over relevant scopes -> system-prompt injection
adjust.js         — Post-turn LLM AMS correction (one-shot per session per group)
dream-v2.js       — Background memory maintenance: per-group diff -> triage -> merge -> apply
budget.js         — Token budget accounting for AMS layers
keywords.js       — FTS keyword extraction
layout.js         — Scope -> filesystem path resolution
summary-store.js  — Helpers around summary.md
types.js          — Memory taxonomy (kept for type literals)
```

**Scope is the only dimension.** Memory lives at scopes like:
- `user/<userId>` — per-user profile / preferences (replaces the old shard system)
- `vp/<vpId>` — per-VP persona memory (a VP is a scope owner)
- `vp/<vpId>/sub/<subAgentId>` — sub-agent of a VP, nested scope
- `group/<groupId>` — shared inside a group
- `feature/<featureId>` — feature-scoped collaboration memory
- `global` — universal

**Read path (per turn):** `preflow.js` runs FTS over relevant scopes → injects matches into the system prompt. AMS holds the in-flight three-layer cache keyed by groupId.

**Write path:** `store-v2.js` writes `<scope>/summary.md` (Layer A); `adjust.js` runs at most once per session per group to correct AMS via the LLM; `dream-v2.js` runs in the background and segments diffs into atomic segment files.

**VP / multi-agent semantics:** A VP is a scope owner just like a user. Sub-agents of a VP nest under `vp/<vpId>/sub/<subAgentId>`. Group fan-out runs VPs in parallel; cross-VP visibility happens via scope-aware pre-flow recall, not via shared shards or a shared transcript. VP→VP explicit handoff uses the `route_forward` tool.

### Conversation Persistence (agent/unify/conversation/)
```
persist.js  — Messages stored as .md files in ~/.yeaft/conversation/messages/
search.js   — Full-text search across conversation history
```

### Tool System (agent/unify/tools/)
```
registry.js  — ToolRegistry: mode-based filtering + execution dispatch
types.js     — defineTool() helper + ToolDef/ToolContext types
index.js     — All 40+ built-in tools, createFullRegistry()
```
- Tools filtered by mode: `chat` tools (web-search, memory, ask-user) vs `work` tools (bash, file-edit, grep)
- Orchestration tools: agent, send-message, wait-agent, close-agent, list-agents
- Task management: task-create, task-update, task-list, task-get

### System Prompt Templates (agent/unify/templates/)
```
base.md              — Core identity + principles (bilingual)
mode-chat.md         — Chat mode: pair programming partner
mode-worker.md       — Worker mode: assigned sub-task executor
mode-coordinator.md  — Coordinator mode: multi-agent orchestrator
mode-dream.md        — Dream mode: memory maintenance
multi-agent.md       — Sub-agent spawn rules
tool-guidance.md     — Tool usage best practices
personality-*.md     — Personality variants (friendly, pragmatic)
```

### Web Bridge (agent/unify/web-bridge.js)
- Translates Engine events into `claude_output` format
- Frontend reuses standard Chat rendering pipeline (MessageList, AssistantTurn, ToolLine, etc.)
- Message flow: `unify_group_chat` -> agent message-router -> `handleUnifyGroupChat()` -> per-VP `runVpTurn()` -> Engine.query() -> events -> `unify_output` -> server -> web client

### Skills & MCP
```
skills.js  — SkillManager: load and match skills from ~/.yeaft/skills/
mcp.js     — MCPManager: connect to MCP servers, bridge tools
```

## Frontend Architecture

- **Framework**: Vue 3 (CDN, no build step) + Pinia stores
- **API style**: Vue Options API with `template` string literals (no SFC/`.vue` files)
- **Components**: `web/components/*.js` — ChatPage, UnifyPage, MessageList, ChatInput, etc.
- **State**: `web/stores/chat.js` is the single Pinia store
- **Rendering**: Both Chat and Unify reuse the same MessageList/AssistantTurn pipeline
- **Sidebar**: Tab bar with Chat / Crew / Unify tabs (session-tab-bar)
- **Styles**: Plain CSS in `web/styles/` (sidebar.css, chat.css, unify.css, etc.)
- **i18n**: Built-in i18n with `$t()` helper (en/zh)

### Key Store State (Unify-related)
```js
currentView: 'chat' | 'unify'       // Top-level page switch
unifyConversationId: null            // Virtual conversationId from agent session_ready
unifyModel: null                     // Current model name
unifyMode: 'chat' | 'work'          // Unify internal mode toggle
unifySessionReady: false             // Session initialization status
unifyStatus: null                    // { skills, mcpServers, tools }
```

### Key Store Actions (Unify-related)
```js
enterUnify(agentId?)     // Switch to Unify page, create virtual conversationId
leaveUnify()             // Return to Chat page
sendUnifyGroupChat({groupId,text,mentions})  // SOLE Unify send path (type: 'unify_group_chat')
handleUnifyOutput(msg)   // Dispatch Engine events through standard claude_output pipeline
setUnifyMode(mode)       // Switch chat/work mode
clearUnifyMessages()     // Reset session
```

## Server Architecture

- **Express + ws**: HTTP server + WebSocket for real-time communication
- **Two WebSocket types**: agent connections (ws-agent.js) and web client connections
- **Message relay**: Server routes messages between agents and their owner's web clients
- **Auth**: JWT-based authentication (optional, skipAuth mode for dev)
- **Agent output handler**: `server/handlers/agent-output.js` — dispatches claude_output and unify_output

## Data Flow

### Chat Mode
```
Web Client -> ws "send_message" -> Server -> ws agent -> Claude CLI process
Claude CLI -> agent -> ws "claude_output" -> Server -> ws "claude_output" -> Web Client
```

### Unify Mode
```
Web Client -> ws "unify_group_chat" -> Server -> ws agent
  -> message-router.js -> handleUnifyGroupChat()
  -> coordinator.ingest() -> Promise.all(per-VP runVpTurn -> Engine.query())
  -> Engine events -> web-bridge.js -> ws "unify_output" -> Server
  -> ws "unify_output" -> Web Client -> handleUnifyOutput() -> handleClaudeOutput()
```

## Configuration

### Agent Config (~/.yeaft/config.json)
```json
{
  "providers": [
    { "name": "my-proxy", "baseUrl": "http://localhost:6628/v1", "apiKey": "proxy",
      "protocol": "openai", "models": ["claude-sonnet-4-20250514", "gpt-5"] }
  ],
  "primaryModel": "my-proxy/claude-sonnet-4-20250514",
  "fastModel": "my-proxy/claude-haiku-3-20250414",
  "language": "en",
  "debug": false,
  "maxContextTokens": 200000,
  "messageTokenBudget": 8192
}
```

## Testing

- **Framework**: Vitest
- **Run**: `npx vitest run`
- **Test files**: `test/` directory, named `*.test.js`
- **Unify tests**: `test/agent/unify-phase5.test.js`, `unify-phase6.test.js`, `unify-eval.test.js`

## Development Conventions

- **Language**: ES modules (import/export), Node.js 20+
- **No TypeScript**: Pure JavaScript with JSDoc type annotations
- **No build step**: Frontend served as static files, uses CDN for Vue/Pinia
- **Commit style**: Conventional commits (`feat:`, `fix:`, `perf:`, `revert:`)
- **Tag format**: `v0.1.X` (check latest with `git tag --sort=-creatordate | head -1`)
- **Release tags**: `release-v0.1.X` triggers production deployment (only when explicitly requested)

## Worktree + PR Workflow (MANDATORY for every change)

Every feature or fix — no matter how small — goes through this loop. **Never push directly to `main` from a worktree.**

1. **Create worktree** via `EnterWorktree` with a descriptive name (`fix-...`, `feat-...`).
2. **Develop + test** inside the worktree. `npx vitest run` must be green before pushing.
3. **Commit** with a conventional-commit message.
4. **Push the WORKTREE BRANCH** (not `main`): `git push -u origin <worktree-branch>`.
5. **Open a PR**: `gh pr create --base main --head <worktree-branch> --title "..." --body "..."`.
6. **Wait for the PR to merge** (CI green + user approval). Do NOT merge it yourself unless the user explicitly authorizes.
7. **Tag from `main`**, AFTER merge: switch to the main checkout (`/home/azureuser/projects/claude-web-chat`), `git checkout main && git pull`, then `git tag v0.1.X && git push origin v0.1.X`.

### Forbidden shortcuts (do not do these — ever)

- ❌ `git push origin HEAD:main` from a worktree.
- ❌ `git push origin <worktree-branch>:main`.
- ❌ Tagging a worktree branch.
- ❌ Merging your own PR without explicit user approval.
- ❌ Pushing a tag whose commit is not yet reachable from `origin/main`.

The PR is the review gate. Skipping it bypasses code review and breaks the audit trail. If a previous instruction (including older project memory) tells you to push directly to main, that instruction is wrong — follow this section.

## Auto Review-and-Ship Flow (DEFAULT — run without asking)

**This is the standard ship workflow for EVERY PR. Do not ask the user "should I review and merge?" — once tests are green and the PR is open, run this loop end-to-end automatically.** (Established 2026-05-13 by user directive: "以后记住不需要问我，做完了就自动触发这个流程".)

Earlier conversational triggers like *"review一下，没问题就 merge + tag"* / *"自己 merge"* are still valid, but they're no longer required — the flow is the default.

1. **Two-pass review (mandatory, both passes)** — invoke the `yeaft-skills:review-code` skill, which dispatches:
   - **Pass 1 — architecture (Fowler persona)**: module boundaries, abstraction levels, consistency, coupling, scope drift.
   - **Pass 2 — code quality (Torvalds persona)**: simplicity, naming, edge cases, dead code, debug leftovers.
   - Both passes run as independent subagents and write reports to `/tmp/review-{fowler,torvalds}-<pr>.md`.
2. **Fix every reported issue (Fix-first)** — Critical and Important findings MUST be fixed in the same PR before merge. Minor findings should also be fixed unless they're genuinely out of scope. Don't merge a PR with known unfixed issues from the review.
3. **Verify** — run `npx vitest run`. All tests must pass on the post-fix HEAD.
4. **Push fixes + post review summary as a PR comment** — the comment is the audit trail showing what each persona found and what was fixed.
5. **Merge** — `gh pr merge <num> --merge --delete-branch`. The local-branch delete may fail because the worktree still has the branch checked out; that's expected and harmless — the remote merge + remote-branch delete have succeeded.
6. **Tag from main** — switch to `/home/azureuser/projects/claude-web-chat`, `git checkout main && git pull --ff-only`, verify `git branch --show-current` outputs `main`, then `git tag v0.1.X && git push origin v0.1.X`. The tag commit must be reachable from `origin/main`.
7. **Clean up the worktree** when done (`ExitWorktree action: "remove"`; pass `discard_changes: true` since the commits are already on main via the PR).

**Stop and ask only if** review surfaces a Critical/Important issue you can't confidently auto-fix, or if the fix's scope is genuinely uncertain. Otherwise, proceed without asking.

The forbidden shortcuts above (`HEAD:main`, tagging a feature branch, pushing a tag whose commit isn't on origin/main) still apply — auto-flow is steps 1–7 only, not a license to bypass the PR gate.

## Operations Safety Rules

- **NEVER restart, kill, or modify running agent/server processes** — Only analyze code and commit fixes. The user or a deployment pipeline handles process restarts.
- **NEVER run `npm install -g` or `npm pack` to update the running agent** — Agent upgrades happen through the CI/CD pipeline triggered by release tags, not manual npm installs.
- **NEVER modify `~/.yeaft/config.json` or other runtime config files** without explicit user permission.
- **Code first, deploy later** — When debugging production issues: read logs/code → identify root cause → commit fix → push → let the user decide when to deploy.

## Unify UI Design Rules

- **No horizontal dividers/borders**: Unify page must NOT have any horizontal `border-bottom` or `border-top` on sidebar sections, sidebar headers, topbar, or detail panel headers. Use spacing (padding/margin) instead of lines to separate sections. This matches the clean look of Chat and Crew modes.
- **Consistent sidebar style**: Unify sidebar must visually match Chat/Crew sidebar — no section borders, no uppercase labels with bottom borders, just clean grouped content with padding.
