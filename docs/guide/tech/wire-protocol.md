# WebSocket Protocol

Yeaft's server / agent / web client talk over **WebSocket**. Every message is a JSON envelope, with **`type`** identifying the message kind. This chapter lists the **core wire types**, **envelope shapes**, and **bidirectional flows**.

> Audience: developers writing **server handlers / agent drivers / frontend stores**.

## Design Principles

1. **Type is a protocol name, not a brand name** — `claude_output` is the Claude stream-json envelope shape; **all** providers (including Copilot and the Yeaft engine) translate into it. The frontend doesn't need to know what's downstream
2. **Flat envelope** — top-level `type` + routing fields (`conversationId` / `sessionId` / `agentId`); the rest of the payload lives in `data` or named fields
3. **Server is a dumb relay** — Server doesn't parse message content, only routes by `agentId` / `userId`
4. **Wire-level backward compat** — old field names (`yeaft_*`, `unify_*`) are kept as aliases; no batch-renaming for cosmetic reasons

## Generic Envelope

```js
{
  type: 'claude_output' | 'yeaft_output' | 'send_message' | ...,
  conversationId?: string,       // which chat session
  agentId?: string,              // which agent (for server routing)
  sessionId?: string,            // provider-specific session id
  // ... type-specific fields
}
```

## Three Directions

```
┌─────────┐                  ┌──────────┐                  ┌──────────┐
│  Web    │  ◄── server ──►  │  Server  │  ◄── agent ──►   │  Agent   │
│ Client  │     forward      │  (relay) │     forward      │ (driver) │
└─────────┘                  └──────────┘                  └──────────┘
   ▲                                                            ▲
   │                                                            │
   └──── user input / render output ─────────────── provider impl ─┘
```

## Core Wire Types

### Client → Agent (user input)

| Type | Fields | Meaning |
| --- | --- | --- |
| `send_message` | `conversationId, text, attachments?` | User sends a message in Chat mode |
| `yeaft_session_send` | `sessionId, text, mentions?, attachments?` | Send to Yeaft Code Agent Session (with @mention) |
| `cancel_execution` | `conversationId` | Abort current turn |
| `ask_user_answer` | `requestId, answer` | User responds to an ask-user prompt |
| `create_conversation` | `provider, workDir, options?` | Start a new session |
| `resume_conversation` | `conversationId, sessionId` | Resume historical session |
| `delete_conversation` | `conversationId` | Delete session |
| `list_history_sessions` | `provider, workDir` | List resumable historical sessions |
| `list_folders` | `provider` | List working dirs that have sessions |

### Agent → Client (output)

| Type | Fields | Meaning |
| --- | --- | --- |
| `claude_output` | `conversationId, data` | **Shared output envelope** for all providers (see below) |
| `yeaft_output` | `conversationId, data` | Yeaft engine output (same shape as `claude_output`, separate type for per-VP routing) |
| `session_ready` | `conversationId, sessionId, ...` | Session started |
| `agent_status` | `state, ...` | Agent heartbeat |
| `ask_user_question` | `requestId, prompt, choices?` | Tool requests user input |
| `crew_output` | `sessionId, role, data` | Crew subsystem output |
| `llm_config` / `mcp_servers_list` / `yeaft_settings` | ... | Various settings query responses |

### claude_output `data` field (core)

`data` is shaped like a Claude **stream-json** envelope, regardless of whether upstream is Claude / Copilot / Yeaft:

```js
// Assistant message (with text / thinking / tool_use blocks)
{
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      { type: 'text', text: '...' },
      { type: 'thinking', thinking: '...', signature: '...' },
      { type: 'tool_use', id: 'tool_xxx', name: 'bash', input: {...} },
    ],
  },
}

// User message (with tool_result echo)
{
  type: 'user',
  message: {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'tool_xxx', content: '...' },
    ],
  },
}

// Turn end
{
  type: 'result',
  subtype: 'success' | 'error_max_turns' | 'error_during_execution',
  session_id: '...',
  is_error: false,
  duration_ms: 1234,
  total_cost_usd: 0.012,
  usage: { input_tokens, output_tokens, ... },
}

// System event
{
  type: 'system',
  subtype: 'init' | 'compact' | 'error' | ...,
  ...
}
```

**Key**: because the envelope shape is unified, the frontend `MessageList` / `AssistantTurn` / `ToolLine` pipeline **needs no branching**.

## Provider Translation Examples

### Claude Code → claude_output
Claude CLI emits stream-json natively; the driver forwards almost verbatim:
```js
// Each JSON line on stdout
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}
// Wrap in envelope
sendToServer({ type: 'claude_output', conversationId, data: parsedLine });
```

### Copilot → claude_output (ACP translation)
Copilot speaks ACP JSON-RPC; the driver translates:

| ACP event | claude_output `data` |
| --- | --- |
| `session/agent_text { text }` | `{ type: 'assistant', message: { content: [{ type: 'text', text }] } }` |
| `session/agent_thought { text }` | `{ type: 'assistant', message: { content: [{ type: 'thinking', thinking: text }] } }` |
| `session/tool_call { id, name, input }` | `{ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } }` |
| `session/tool_result { id, content }` | `{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } }` |
| `session/turn_complete` | `{ type: 'result', subtype: 'success', ... }` |
| `session/request_permission` | dedicated wire type `ask_user_question` (not via claude_output) |

### Yeaft → claude_output (web-bridge translation)
The Yeaft engine emits its own events (`text_delta` / `thinking_delta` / `tool_call` / `usage` / `stop`); `web-bridge.js` translates into stream-json:

| Engine event | claude_output `data` |
| --- | --- |
| `text_delta { text }` | `{ type: 'assistant', message: { content: [{ type: 'text', text }] } }` |
| `thinking_delta { text }` | `{ type: 'assistant', message: { content: [{ type: 'thinking', thinking: text }] } }` |
| `tool_call { id, name, input }` | `{ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } }` |
| tool result (after registry executes) | `{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id, content }] } }` |
| `stop { stopReason }` + `usage` | `{ type: 'result', subtype, usage, total_cost_usd }` |

Yeaft uses the `yeaft_output` type (payload same as claude_output `data`); frontend store handles it with `handleYeaftOutput()` → internally routes to `handleClaudeOutput()`. The extra type layer is purely for per-VP / per-Session fan-out.

## yeaft_session_send (Yeaft Code Agent Session send channel)

```js
{
  type: 'yeaft_session_send',
  conversationId: 'yeaft-virtual-xxx',
  sessionId: 'session-abc',
  text: '@alice take a look at this bug',
  mentions: ['alice'],            // parsed @mention VP names
  attachments: [{ name, mime, base64 }],
}
```

Agent flow on receipt:
1. `message-router.js` dispatches to `handleYeaftSessionSend()`
2. `coordinator.ingest({ sessionId, text, mentions, attachments })`
3. Resolve VP set from mentions (no mentions → default VP)
4. `Promise.all(vps.map(runVpTurn))` in parallel
5. Each VP's Engine events translated to `yeaft_output` via `web-bridge` and pushed back
6. Frontend fans out per VP id into per-thread views

Legacy aliases: `yeaft_session_chat` and `unify_group_chat` are accepted for compatibility, and some old payloads still contain `groupId`. New code should send `yeaft_session_send` with `sessionId`. **Do not use `unify_*` or introduce new `group*` names in new code.**

## ask-user Round-Trip

A tool can prompt the user via a dedicated wire:

```
Agent → Web:                                Web → Agent:
{                                           {
  type: 'ask_user_question',                  type: 'ask_user_answer',
  conversationId,                              conversationId,
  requestId: 'q-xxx',                          requestId: 'q-xxx',
  prompt: '...',                               answer: '...',
  choices: ['A', 'B'],         (optional)    }
  multiSelect: false,
}
```

UI pops a modal → user selects → answer sent back → tool resolves → turn continues.

## Conversation Lifecycle

```
1. create_conversation        Web → Agent
   { provider, workDir, options }
                              ↓
2. session_ready              Agent → Web
   { conversationId, sessionId, capabilities, modelInfo }
                              ↓
3. send_message               Web → Agent
   { conversationId, text, attachments? }
                              ↓
4. claude_output × N          Agent → Web
   { conversationId, data: { type: 'assistant'/'user'/'result'/'system', ... } }
                              ↓
5. (turn complete; send_message again)
                              ↓
   delete_conversation        Web → Agent
   { conversationId }
```

## Server's Role

The server is a dumb relay:
- **Doesn't** parse `data` content
- Receives `claude_output` / `yeaft_output` → finds the web client owning that `conversationId` → forwards
- Receives `send_message` etc. → finds the agent pinned to that conversation (`session-pin-router.js`) → forwards
- Only server-side logic: auth (JWT), message buffering (when agent temporarily offline), heartbeat

`server/handlers/agent-output.js` handles agent → web; `server/handlers/client-conversation.js` handles web → agent.

## Session Pin (agent routing)

A user may have multiple agents online. Server uses `session-pin-router.js` to bind each conversation to **the agent that first created it**:
- On `create_conversation` server picks an agent → records `conversationId → agentId` mapping
- All subsequent `send_message`s route to that agent
- If the agent is offline, the conversation is temporarily unusable (user can view history, can't send)

## Heartbeat / Buffering

- **Heartbeat**: agent sends `agent_status { state: 'idle' | 'busy' }` every N seconds; server uses this to detect liveness
- **Buffering**: when agent briefly disconnects, server caches pending outbound (`message-buffer`) and flushes on reconnect. Web client also has uplink buffer (`web/stores/chat.js`)

## Debugging

### Inspect raw wire
Browser DevTools → Network → WS → select WebSocket connection → Messages tab to see every envelope.

Agent side: set `"debug": true` in `~/.yeaft/config.json` to verbose-log Yeaft engine events to the Agent stdout. Connection-level WebSocket traffic is logged by the Agent's connection layer regardless.

### Inspect envelope translation
The Web Debug panel for each turn has a "raw envelope log" — including provider's original events before translation + translated envelopes.

## Key Files

- `agent/connection/message-router.js` — agent inbound dispatcher
- `agent/connection/buffer.js` — `sendToServer()` outbound buffer
- `server/handlers/agent-output.js` — server-side agent → web dispatcher
- `server/handlers/client-conversation.js` — server-side web → agent dispatcher
- `agent/yeaft/web-bridge.js` — Yeaft engine events → claude_output translator
- `agent/providers/copilot.js` — Copilot ACP events → claude_output translator

> Wire compatibility: every type name above is in widespread production use — renaming one = breaking all old agents / old web clients. New types are fine, but **deletion / renaming requires a deprecation cycle** (dual-emit, grace migration, then sunset).
