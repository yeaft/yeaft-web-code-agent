# VP status from agent — single authoritative source

> **Status**: in flight (worktree `feat-vp-status-from-agent`)
> **Scope**: VP timeline pane "status" column.

## Why

The left-pane VP list status (`idle | typing | streaming`) is derived in
the browser by reverse-inferring from the message log: `streamingSet = {
  vp | ∃ message m where m.speakerVpId === vp && m.isStreaming === true }`
(`web/stores/helpers/vp-timeline.js`). This is wrong in three ways:

1. **Authoritative state lives on the agent.** The browser is reading a
   side effect (an in-flight assistant bubble's `isStreaming` flag) and
   guessing at the underlying VP-level reality. Whenever the side effect
   doesn't get cleared (the `result` event lands without a matching
   bubble, the WS reconnects mid-turn, the agent crashes mid-stream),
   the inferred status is wrong and stays wrong.
2. **There's no "offline" state.** When the agent disconnects, every VP
   is silently still "idle" / "streaming" / "typing" — the timeline
   never tells the user the agent is gone. The `connectionState` store
   field exists but isn't wired into VP rows.
3. **No `tool` / `thinking` distinction.** Once a turn calls a tool,
   `isStreaming` on the assistant bubble flips false (cosmetic — gives
   the typing dots back). The VP row drops to `idle` even though the
   agent is actively running the tool. Users see a "done" VP for the
   entire tool-call window.

## What changes

Agent emits per-VP status transitions on a new wire event.
Frontend consumes them as the *only* source of VP-level status.

### Wire protocol

Two new events, both ride existing `unify_output` envelope (so the
server's relay is unchanged).

```js
// Snapshot — sent on session_ready and on reconnect. Lets a fresh
// frontend rebuild VP status without waiting for the next transition.
{ type: 'vp_status_snapshot',
  groupId,                    // null = all groups
  statuses: [
    { vpId, state, since, turnId? }, ...
  ]
}

// Transition — sent on every state change.
{ type: 'vp_status_changed',
  groupId, vpId,
  state,                      // see state machine below
  since,                      // server-side timestamp
  turnId?                     // when state is non-idle
}
```

### State machine

```
                        enqueueForVp
              idle ─────────────────────────▶ typing
                ▲                                │
                │                                │ vp_turn_start
                │                                ▼
                │                            thinking ◀──┐
                │                                │       │
                │                                │ text_delta
                │                                ▼       │
                │                            streaming   │
                │                                │       │ tool_end
                │                                │ tool_call
                │                                ▼       │
                │                              tool  ────┘
                │                                │
                │  result / abort / error /      │
                │  driver finally / watchdog     │
                └────────────────────────────────┘
```

* `idle` — VP exists, no in-flight work
* `typing` — envelope enqueued, driver hasn't started turn yet
* `thinking` — no text/tool delta yet (entered on `vp_turn_start`, re-entered after `tool_end` while waiting for the next chunk)
* `streaming` — receiving `text_delta` events from the LLM
* `tool` — a `tool_call` is in flight (between `tool_call` and `tool_end`)
* `error` — turn ended with an exception; emitted briefly from `runVpTurn`'s catch, then the outer `finally` settles to `idle`

Notes:
* `typing` and `thinking` collapse to the same UI label (`thinking…`)
  in v1 — the distinction is preserved on the wire so future UI can
  surface "queued vs running" separately.
* `tool_end` lands in `thinking` (not `streaming`) because no text has
  arrived yet — the LLM may emit another `tool_call` before the next
  `text_delta`. The next `text_delta` flips back to `streaming`.
* `streaming` ⇄ `tool` switching is unbounded inside a turn (a turn
  may interleave text and N tool calls).
* `error` is a transient state. The agent emits `error` once from
  `runVpTurn`'s catch, then the outer `finally` (which runs on every
  exit path, including this one) settles back to `idle`. The
  frontend's red status label shows briefly during that window —
  long-enough for a snapshot consumer (refresh / reconnect arriving
  mid-error) to see it, short-enough that the row doesn't stay stuck
  red forever.

### Browser-only `offline`

When the WS connection is not `connected`, every row renders as
`offline` regardless of cached agent state. The store's existing
`connectionState` field is the single source.

## Code map

| File | Change |
|---|---|
| `agent/unify/vp-status-broker.js` (new) | Holds last-known status per `(groupId, vpId)`; `transition()` checks dedup + emits `vp_status_changed`; `snapshot()` returns the full table for `vp_status_snapshot`. |
| `agent/unify/web-bridge.js` | Call `broker.transition()` from: `enqueueForVp` (→ typing), `runVpTurn` start (→ thinking), `runVpTurn` finally (→ idle), `runVpTurn` catch (→ error then idle). In `handleEngineEvent`, transition on `text_delta` (→ streaming on first delta), `tool_call` (→ tool), `tool_end` (→ streaming). On `ensureSessionLoaded` + `session_ready` replay paths, broadcast `vp_status_snapshot`. |
| `web/stores/chat.js` | New state `vpStatuses: { [vpId]: { state, since, turnId } }`; handle `vp_status_changed` + `vp_status_snapshot` cases. Clear on `unify_session_reset`. |
| `web/stores/helpers/vp-timeline.js` | `statusFor(vpId, ctx)` reads `ctx.vpStatuses[vpId]?.state` (single source). When `ctx.connectionState !== 'connected'`, returns `'offline'`. Drop the `streamingSet` reverse-inference from messages entirely. Drop the message-tail pass — the tail roster is rebuilt from `vpStatuses` keys + roster. |
| `web/components/UnifyPage.js` | Pass `vpStatuses` + `connectionState` into `buildTimelineRows`; drop the now-unused `messages` filter on the input. |
| `web/components/VpTimelinePane.js` | Render `offline / thinking / streaming / tool / error` labels. Add `is-status-offline` row class for muted styling. |
| `web/i18n/{en,zh-CN}.js` | Add `offline / thinking / tool / error` keys. |

## Test plan

* **Unit (agent)** — `test/agent/unify-vp-status-broker.test.js`:
  - dedup: same state twice = one emit
  - transition path: idle → typing → thinking → streaming → tool →
    streaming → idle
  - error path: streaming → error → idle (on next transition)
  - snapshot shape

* **Unit (web)** — `test/web/stores/helpers/vp-timeline.test.js`:
  - rewrite: status comes from `vpStatuses`
  - offline gate: `connectionState !== 'connected'` → all rows `offline`
  - missing entry: VP in roster, no `vpStatuses[vp]` → `idle`

* **Integration** — keep the existing `group-chat-tool-order` test as a
  smoke; verify no regressions.

## Out of scope

* Persisting status across agent restart (snapshot on reconnect is
  sufficient; the broker is in-memory).
* `error` taxonomy (which kind of error) — single bucket for now.
* Showing per-VP latency / token usage in the row — the `since`
  timestamp ships but the row v1 doesn't render it.
