# Yeaft Engine

Yeaft's own AI engine runs in `agent/yeaft/` and depends on **no external CLI** (neither Claude nor Copilot is required). It has its own query loop, memory system, tool registry, and LLM router. This chapter covers its **core architecture** and **turn lifecycle**.

> Audience: developers who want to **read or modify the Yeaft engine**. For the end-user view see [Yeaft Group Mode](../user/yeaft-group.md).

## Module Layout

```
agent/yeaft/
  engine.js        — main query loop (turn-based)
  session.js       — Session orchestrator (loadSession wires up all subsystems)
  config.js        — reads ~/.yeaft/config.json
  prompts.js       — bilingual system prompt builder
  models.js        — Model registry (context window, output limit, provider inference)

  groups/          — Group Mode orchestration (coordinator, roster, group-store, pre-flow)
  routing/         — turn-level routing + loop guard
  router/          — continuity / thinking routing strategies
  memory/          — H2-AMS memory subsystem (see yeaft-memory.md)
  llm/             — LLM adapter layer (see yeaft-llm.md)
  tools/           — built-in tool registry
  templates/       — system prompt templates
  conversation/    — message persistence + search
  dream-v2/        — background memory maintenance
  compact/         — context compaction strategy
  eval/            — evaluation scripts

  web-bridge.js    — Engine events → claude_output envelope translator
```

## Engine Query Loop (core turn cycle)

`engine.js` is the engine's main loop. For each user turn:

```
1. Pre-query
   - preflow.recall(scopes) — FTS recall over user/vp/group/feature scopes
   - inject into system prompt
   - AMS (Active Memory Set) three-layer cache (Resident summary / Recent / OnDemand) attached

2. Build messages array
   - system: template + memory + persona + tool-guidance + project doc
   - history: thread history (with compact summary if any)
   - current user message

3. adapter.stream({ model, system, messages, tools, signal })
   - Collect text_delta / thinking_delta / tool_call / usage / stop events
   - Push to frontend in real time via web-bridge

4. tool_call event received
   - ToolRegistry.execute(name, input, ctx) — run the tool
   - Append result to messages (role: 'tool')
   - Loop back to step 3

5. stop event received
   - stop_reason === 'end_turn' → persist messages → check if consolidation needed → finish turn
   - stop_reason === 'max_tokens' → auto-continue (max 3 times)
   - stop_reason === 'tool_use' → already handled in step 4

6. Error handling
   - LLMContextError → force compact → retry
   - retryable error + fallbackModel configured → switch model → retry
   - non-retryable error → terminate turn, propagate to user
```

## Turn Lifecycle Diagram

```
                  ┌─────────────────────────┐
   user message → │ runVpTurn(group, vp)    │
                  └────────────┬────────────┘
                               ↓
                  ┌─────────────────────────┐
                  │ preflow.recall(scopes)  │  ← FTS over user/vp/group/feature
                  │ → memory hits            │
                  └────────────┬────────────┘
                               ↓
                  ┌─────────────────────────┐
                  │ buildSystemPrompt()     │  ← templates + persona + memory + tool guidance
                  └────────────┬────────────┘
                               ↓
                  ┌─────────────────────────┐
                  │ Engine.query(messages)  │  ← the loop
                  └────────────┬────────────┘
              ┌────────────────┴────────────────┐
              ↓                                 ↓
      ┌──────────────┐                  ┌──────────────┐
      │ adapter.stream → events          │ tool_call event
      └──────┬───────┘                   └──────┬───────┘
             ↓                                  ↓
       text_delta / thinking_delta       ToolRegistry.execute
        → web-bridge → frontend           → append tool result
                                          → re-stream
             ↓
       stop event (end_turn)
             ↓
      ┌──────────────────────┐
      │ persist messages     │
      │ trigger consolidate? │  ← if yes, schedule dream maintenance
      │ adjust AMS (max 1×)  │
      └──────┬───────────────┘
             ↓
        turn complete → web-bridge emits 'result' envelope
```

## Session & Group Orchestration

### Session
`session.js`'s `loadSession()` wires up all subsystems:

```js
const session = await loadSession({ conversationId, userId, agentId });
// → { engine, memory, tools, llm, ... }
```

A session contains:
- one `Engine` instance
- a set of `groups[]` (Group Mode may have several; Chat Mode just one)
- shared `memory` / `tools` / `llm` subsystems

### Group Mode
`groups/coordinator.js` on receiving `yeaft_group_chat`:

```js
async ingest({ groupId, text, mentions, attachments }) {
  const vps = roster.resolveVps(mentions);  // @mention → VPs (no mentions → everyone)
  await Promise.all(vps.map(vp => runVpTurn(group, vp, text)));
}
```

VPs run `runVpTurn` in parallel, each with its own `Engine.query()`. Completion times differ; events fan out per-VP.

### Routing & Loop Guard
`routing/` handles turn-level routing (VP→VP `route_forward`) and a loop guard. `routing/loop-guard.js` detects rapid ping-pong between two VPs and forces termination.

## System Prompt Templates

`templates/` has the core templates:

| Template | Purpose |
| --- | --- |
| `base.md` | Core identity + principles (bilingual EN/zh) |
| `identity-yeaft.md` | Yeaft identity + brand instructions |
| `common-rules.md` | Common behavior rules (don't lie, don't fake lookups…) |
| `mode-unified.md` | The single current run mode (covers all group collab instructions) |
| `mode-dream.md` | Dream mode: prompt for memory maintenance |
| `plan-instruction.md` | Extra instructions for the plan phase |
| `tool-guidance.md` | Tool usage best practices |
| `personas/` | Jobs / Torvalds / Fowler / Rams / Beck preset personas |
| `harness/` | Harness-level instructions (env info, etc.) |

`prompts.js`'s `buildSystemPrompt()` composes the final prompt from current VP config + current mode + memory + project doc.

> Historical templates (`mode-chat.md` / `mode-worker.md` / `mode-coordinator.md`) have been folded into `mode-unified.md` + `personas/` — they no longer exist as standalone files.

## Web Bridge

`web-bridge.js` translates Engine events into `claude_output` envelopes pushed to the server:

```
Engine emits:                Web bridge emits:
─────────────────────────────────────────────────────────────
text_delta                   { type: 'assistant', message: { content: [{ type: 'text', text }] } }
thinking_delta               { type: 'assistant', ... thinking block }
tool_call                    { type: 'assistant', ... tool_use block }
tool_result                  { type: 'user',      ... tool_result block }
usage / stop                 { type: 'result',    subtype, ... }
```

This is why the Yeaft engine reuses the Claude rendering pipeline — the frontend `MessageList` / `AssistantTurn` doesn't know the upstream is Yeaft vs Claude CLI.

## Tool System

`tools/registry.js` is the tool registry:

```js
const registry = createFullRegistry({ scope, mode, allowedTools });
const result = await registry.execute(toolName, input, ctx);
```

Tools are filtered by mode: `unified` mode gets the full 40+ tool set; `dream` mode only gets memory-maintenance-related tools.

Tool implementations are split by category — see [Yeaft Group Mode](../user/yeaft-group.md) for the full list.

## Memory / LLM / Group Subsystems

Each has its own chapter:
- Memory → [Yeaft Memory System (H2-AMS)](./yeaft-memory.md)
- LLM → [Yeaft LLM Layer](./yeaft-llm.md)
- Wire protocol → [WebSocket Protocol](./wire-protocol.md)

## Tests

- `test/agent/yeaft-phase5.test.js` — engine core
- `test/agent/yeaft-phase6.test.js` — multi-VP / group orchestration
- `test/agent/yeaft-eval.test.js` — end-to-end eval

> Test files keep the historical "yeaft" prefix; they actually cover what's now called the Yeaft engine.

## Key Files

- `agent/yeaft/engine.js` — main query loop
- `agent/yeaft/session.js` — Session orchestrator
- `agent/yeaft/groups/coordinator.js` — Group fan-out
- `agent/yeaft/prompts.js` — System prompt builder
- `agent/yeaft/web-bridge.js` — Event → wire translator
- `agent/yeaft/tools/registry.js` — Tool registry
