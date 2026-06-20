# Provider System

Yeaft has two provider integration paths:

1. **ChatProvider** for 1:1 CLI-style chat backends such as Claude Code CLI and GitHub Copilot CLI.
2. **Yeaft LLM adapters** for the native **Yeaft Code Agent** engine, where each VP routes directly to an Anthropic or OpenAI Responses compatible provider.

This chapter focuses on ChatProvider because that is the extension point for adding a new 1:1 chat backend. If you want to connect another LLM to Yeaft Code Agent, start with [Yeaft Engine Config](../yeaft-config.md) and [Yeaft LLM Layer](./yeaft-llm.md); most providers only need `~/.yeaft/config.json`, not a new ChatProvider driver.

> Audience: **engineers who want to add a new provider** or **understand why the frontend doesn't branch on Claude vs Copilot rendering**. End-user view in [Choose a Code Agent Path](../user/choose-backend.md).

## Design Goals

1. **Zero frontend branching** — `MessageList` / `AssistantTurn` / `ToolLine` etc. **don't know** whether a message came from Claude or Copilot
2. **Protocol over brand** — `claude_output` is the **wire protocol name** (envelope shape), not a vendor name. Any provider can reuse the frontend by translating its event stream into this envelope
3. **Capability declaration over hard-coding** — UI decides which buttons to show (compact / model picker / Expert Panel) via `capabilities` flags, not by string-matching the provider name

## ChatProvider Interface

Defined in `agent/providers/base.js` (JSDoc types):

```js
/**
 * @typedef {Object} ChatProvider
 * @property {string} name                            // 'claude-code' | 'copilot'
 * @property {ProviderCapabilities} capabilities      // static capability flags
 * @property {(opts) => Promise<state>} start         // start session
 * @property {(state, prompt, opts) => Promise<void>} sendInput  // send message
 * @property {(state) => void} abort                  // abort current turn
 * @property {(state) => Promise<void>} [clear]       // optional — in-place /clear reset
 * @property {() => Promise<FolderInfo[]>} listFolders        // list working dirs
 * @property {(workDir) => Promise<SessionInfo[]>} listSessions  // list resumable sessions
 * @property {(workDir, sessionId, limit?) => Promise<HistoryMessage[]>} loadHistory
 * }
 */
```

Per-method contract:

| Method | Purpose | Failure Handling |
| --- | --- | --- |
| `start(opts)` | Launch a session; return `state` (provider-internal) | Throw Error to surface to user |
| `sendInput(state, text, opts)` | Send message async; events stream out via `ctx.sendToServer` | Throw Error to abort current turn |
| `abort(state)` | Cancel current turn synchronously (no throw) | — |
| `clear(state)` | Optional; in-place reset (no process restart) | If not implemented, frontend just wipes UI messages |
| `listFolders()` | List working dirs that have sessions for this provider | Return `[]` |
| `listSessions(workDir)` | List resumable sessions | Return `[]` |
| `loadHistory(workDir, sessionId)` | Translate historical transcript into `claude_output` envelope array | Throw on error |

## Capability Flags

```js
/**
 * @typedef {Object} ProviderCapabilities
 * @property {boolean} [compact]      supports /compact
 * @property {boolean} [clear]        supports in-place /clear
 * @property {boolean} [expert]       supports Expert Panel
 * @property {boolean} [mcp]          per-session MCP server toggle
 * @property {boolean} [subagents]    subagent watcher events
 * @property {boolean} [attachments]  accepts file / image attachments
 * @property {boolean} [askUser]      ask-user permission dialog
 * @property {boolean} [modelPicker]  UI model picker
 */
```

Frontend reads these flags to decide what buttons to render. Add a new provider: set the flags correctly and UI auto-adapts — no Vue component changes.

| Capability | Claude Code | Copilot |
| --- | :---: | :---: |
| compact | ✓ | — |
| clear | ✓ | ✓ |
| expert | ✓ | — |
| mcp | ✓ | ✓ |
| subagents | ✓ | — |
| attachments | ✓ | ✓ |
| askUser | ✓ | ✓ |
| modelPicker | ✓ | ✓ |

## Protocol: claude_output Envelope

**All** providers must push messages via `ctx.sendToServer({ type: 'claude_output', conversationId, data })`, where `data` is shaped like a Claude stream-json envelope:

```js
{ type: 'assistant', message: { role, content: [...] } }   // assistant message
{ type: 'user',      message: { role, content: [...] } }   // user message echo
{ type: 'result',    subtype, session_id, is_error, ... }  // turn end
{ type: 'system',    subtype, ... }                        // system event
```

Content blocks also follow the Claude standard: `{ type: 'text', text }`, `{ type: 'tool_use', id, name, input }`, `{ type: 'tool_result', tool_use_id, content }`, etc.

**Claude Code provider** is native — Claude CLI emits stream-json directly, forwarded as-is.

**Copilot provider** speaks ACP (Agent Client Protocol), which has its own event types (`session/update`, `session/agent_text`, `session/tool_call`, `session/request_permission`, etc.). The Copilot driver in `agent/providers/copilot.js` **translates** each ACP event into a claude_output envelope:

```
ACP session/agent_text  → { type: 'assistant', message: { content: [{ type: 'text', text }] } }
ACP session/tool_call   → { type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } }
ACP session/tool_result → { type: 'user',      message: { content: [{ type: 'tool_result', tool_use_id, content }] } }
ACP session/request_permission → askUser protocol (separate wire type)
```

That's why `claude_output` is a **protocol name**, not a **vendor name**.

## Registering a New Provider

Three steps:

### Step 1 — Driver File

`agent/providers/<your-driver>.js`, exporting the ChatProvider interface:

```js
export const name = 'your-driver';
export const capabilities = { compact: false, clear: true, /* ... */ };
export async function start(opts) { /* ... */ }
export async function sendInput(state, prompt, opts) { /* ... */ }
export function abort(state) { /* ... */ }
// optional clear / listFolders / listSessions / loadHistory
```

### Step 2 — Register in Registry

`agent/providers/index.js`:

```js
import * as yourDriver from './your-driver.js';

const REGISTRY = Object.freeze({
  'claude-code': claudeCode,
  'copilot': copilot,
  'your-driver': yourDriver,   // new
});
```

Also update `PROVIDER_NAMES` in `base.js`.

### Step 3 — Translate the Event Stream

The driver can use any SDK / CLI / API internally, but **output** must be translated into `claude_output` envelope. That translation layer lives in the driver and is transparent to the frontend.

### Step 4 — UI (optional)

If the new provider needs special config (like Copilot's model picker / Allow all tools), add fields to the session creation dialog in `web/components/ChatPage.js`. The frontend will pass them as `opts.providerOptions` to the driver.

## Existing Two Drivers

### claude-code.js (~600 lines)
- Spawn `claude --output-format stream-json --resume <sessionId>` subprocess
- Write user messages + attachments to stdin
- stdout is stream-json — forwarded as-is
- Listen to stderr, translate into system messages
- Session files in `~/.claude/projects/<hash>/sessions/<sid>.jsonl`

### copilot.js (~1000 lines)
- Spawn `copilot --acp` subprocess
- Use `acp-client.js` for ACP JSON-RPC (session/new, session/prompt, session/cancel, session/load, session/request_permission)
- Translate each ACP event into claude_output envelope
- Session metadata in `~/.copilot/session-store.db` (SQLite)
- Model selection / permission dialog → ACP methods

## Not in This Layer

- **Yeaft Code Agent engine** — not a ChatProvider. It uses the native Yeaft Session path (`yeaft_session_send` → `yeaft_output`) because its event model (parallel VP turns, Session fan-out, cross-session memory) differs from 1:1 chat. Legacy aliases such as `yeaft_session_chat`, `unify_group_chat`, and old `groupId` payload names remain accepted only as compatibility names.
- **WebSocket transport** — base.js doesn't care about WebSocket; the driver pushes messages via `ctx.sendToServer`, with transport provided by message-router
- **Auth** — driver doesn't verify tokens; server has already done the handshake when agent boots

## Tests

- Unit: `test/agent/providers/*.test.js`
- Copilot driver: `test/agent/providers/copilot.test.js`, `copilot-history.test.js`, `copilot-models.test.js`
- ACP client: `test/agent/providers/acp-client.test.js`

## Reference Implementations

- `agent/providers/base.js` — interface definition
- `agent/providers/claude-code.js` — Claude Code driver
- `agent/providers/copilot.js` — Copilot driver
- `agent/providers/acp-client.js` — ACP JSON-RPC client (used by copilot)
- `agent/providers/copilot-models.js` — Copilot model list + fallback
