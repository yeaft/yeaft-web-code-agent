# Unify Conversation-State Ownership — Design Doc

Status: **DRAFT** — for review, no code changes proposed in this document.
Author: Claude (with @yeaft).
Date: 2026-05-09.
Companion to: `agent/unify/DESIGN-PROMPT.md` (existing architecture map).

## 1. Problem statement

Two compression mechanisms exist in the Unify agent today, owned by different
modules and operating on different state:

| Mechanism | Owner | State it touches | Trigger |
|---|---|---|---|
| **Reflect** (T1 / T2, in-turn tool-arc compression) | `agent/unify/engine.js` | engine-local `conversationMessages` (per-query) | Every 13 tool calls (T1 sync) / end-of-turn ≥6 tools (T2 async) |
| **Compact** (history-prefix summarisation) | `agent/unify/web-bridge.js` (NOT engine) | bridge-module-level `conversationMessages` (cross-query) | Post-fan-out, when tokens > 12K AND (>40% ctx OR >200K OR >30 turns) |
| **Orchestrator compact** (3-track) | `agent/unify/engine.js` | `conversationStore` (disk hot/cold) | `LLMContextError` recovery only |

Because **the engine and the bridge each maintain their own `conversationMessages`**,
work the engine does (e.g. T1 collapse) is invisible to the bridge: the next
query rebuilds from the bridge's pre-collapse snapshot. And because the bridge
owns the production-path compact orchestration but uses the engine to produce
the summary, the boundary leaks: `web-bridge.js` calls
`session.engine.summarizeForCompact()` (engine.js:2336) while orchestrating
single-flight, race guards, and trigger thresholds locally. The bridge — which
should be a thin transport translator from Engine events to web frames —
contains ~200 lines of conversation-history orchestration.

User-stated invariant: *"reflect 是在一个 turn 内对 tool 的一种压缩, compact 是在
用户 message history 这种 level 去压缩。"* Both mechanisms must keep working.
Architectural goal: **Engine owns the live conversation state and both
compression layers; Bridge translates events.**

## 2. Current wiring (ground-truth audit)

### 2.1 Where `conversationMessages` lives

There are **two** `conversationMessages` arrays in the running agent process:

**Bridge-owned (durable, cross-query, agent-process-global)**:
- Declared `web-bridge.js:243` — `let conversationMessages = []`.
- Restored from disk on session boot via `restoreHistoryFromRecent` (web-bridge.js:253).
- Snapshot taken at turn-start: `const baseSnapshot = [...conversationMessages]` (web-bridge.js:415).
- Snapshot trimmed via `trimSnapshotForBudget` and passed into `engine.query({ messages })` (web-bridge.js:1882-1888).
- Rebuilt at turn end via `appendTurnToHistory(prompt, assistantTextParts, toolCallsAccum, toolResultsAccum)` (web-bridge.js:1905, 1966) — accumulated from streamed events, NOT read back from the engine.
- Reassigned (full swap) by `compactHistory` in `runCompactNow` (web-bridge.js:2204) and on session reset (web-bridge.js:1085, 2756).

**Engine-owned (ephemeral, per-query)**:
- Built fresh inside `engine.query()`: `const conversationMessages = [...compactMessages, ...messages, { role: 'user', content: finalUserContent }]` (engine.js:1265).
- Mutated heavily during the turn: T1 reflection collapse (engine.js:2115-2116), tool-result push (engine.js:2002), reminder injection (engine.js:2031), assistant push (engine.js:1728), continue token (engine.js:1735).
- **Discarded when `query()` returns**. Never written back to the bridge's array. Never read by the bridge.

### 2.2 Why this matters

T1 collapses **do not persist across queries**. If query #1 fires T1 once and
collapses 13 tool pairs to one synthetic reflection, query #2 starts with the
bridge's snapshot which still has all 13 pairs in raw form. The next query's
`messages` parameter rebuilds from `restoreHistoryFromRecent(loadRecent())` or
from `baseSnapshot = [...conversationMessages]` — neither sees the engine's
collapse. Reflect is an **in-turn** compression and was designed that way, but
the line between "in-turn" and "across-turn" is exactly where the
state-ownership split lives.

### 2.3 Compact paths

**Production-path compact (the one that actually runs)** — `web-bridge.js`:
- Trigger check: `shouldCompactHistory(conversationMessages, { maxContextTokens })` (web-bridge.js:2127).
- Single-flight: `_compactInFlight` promise + `_compactPending` re-trigger flag (web-bridge.js:2086, 2096).
- Entry gate: every new turn awaits in-flight compact before reading `conversationMessages` (web-bridge.js:1262).
- Race guard: reads array reference into `snapshot`, bails if `conversationMessages !== snapshot` after the await (web-bridge.js:2200).
- LLM call: `session.engine.summarizeForCompact({ system, prompt, maxTokens: 1024 })` (web-bridge.js:2170, engine.js:2336).
- Result swap: `conversationMessages = result.messages` (web-bridge.js:2204).
- Emits `unify_history_compacted` event for dev tools (web-bridge.js:2212).

**Engine orchestrator compact** — `engine.js`:
- `#maybeConsolidate` (engine.js:928) → `#runOrchestratorCompact` (engine.js:949).
- Operates on `conversationStore.loadAll()` (engine.js:956), i.e. the on-disk record — NOT on the in-memory `conversationMessages`.
- Only triggered from two sites:
  1. `LLMContextError` recovery (engine.js:1619).
  2. Legacy no-yeaftDir branch (engine.js:1776) — effectively dead in production.
- Yields a `consolidate` event the bridge does not act on (the `consolidated` field on `stop-hooks.js` result is never read).

### 2.4 Reflect paths

T1 (synchronous in-turn) — engine.js:2078-2167:
- Fires inside the adapter loop after every TOOL_BATCH_SIZE (13) tool calls
  since the last firing.
- Operates on engine-local `conversationMessages`. Calls `runT1Reflection`
  (`tool-folding/t1-reflector.js`) → `adapter.call({ system: prompt, messages: [...] })`
  to produce a markdown reflection, then `collapseRangeToReflection` rewrites
  the arc to a single synthetic user message.

T2 (asynchronous end-of-turn) — engine.js:1805-1840 + carry-forward at engine.js:1277:
- Fires at end_turn when `queryToolCount > TURN_SUMMARY_THRESHOLD (5) && t1CollapsesDone === 0`.
- Kicks off `runT2Reflection` without await; promise stored on the engine instance.
- Next `query()`'s `#applyPendingT2Reflections` checks the promise (non-blocking) and
  rewrites the just-completed turn in the **NEW** `conversationMessages` array — i.e.
  it carries forward across queries via engine instance state, NOT via the bridge's array.

### 2.5 Group fan-out

`runVpTurn` (web-bridge.js:1802) is called per VP within `Promise.all(...)`.
Every VP's engine receives the **same** `baseSnapshot` (the bridge's
`[...conversationMessages]` at turn-start). Each VP's engine builds its own
fresh local `conversationMessages` from that snapshot. After all VPs return,
`appendTurnToHistory` (web-bridge.js:1905) appends each VP's accumulated
output to the shared array. **There is one `conversationMessages` array per
agent process across all groups** — group identity rides on the
`groupId`/`threadId` stamped onto persisted records, not on a separate
in-memory history per group.

## 3. Design — proposed end state

**Single source of truth**: the Engine instance owns the conversation history.
The Bridge translates Engine events to web frames and back.

### 3.1 Move `conversationMessages` ownership to Engine

- Engine becomes stateful across queries (it already is for T2 carry-forward
  and `#reflectedTurns`). Add `#conversationMessages` private field.
- `engine.query({ prompt, ... })` no longer takes a `messages` param. The
  engine reads its own `#conversationMessages`, appends the new user prompt,
  yields events. After turn end, the engine's array IS the durable record;
  any reflect collapse persists.
- Per-group isolation: Engine instances are already group-keyed in
  `getOrCreateVpEngine(groupId, vpId)` (web-bridge.js:1867). Each engine
  instance gets its own `#conversationMessages`. The bridge no longer needs a
  shared array.
- Boot path: `restoreHistoryFromRecent` → `engine.hydrateHistory(messages)`
  on the engine instance for the relevant group/VP.
- Reset: `engine.clearHistory()` replaces `conversationMessages = []` resets
  scattered through the bridge.

### 3.2 Move history-compact orchestration to Engine

- `compactHistory`, `shouldCompactHistory`, `wrapSummaryAsUserMessage`,
  `findCutIndex`, etc. stay in `agent/unify/history-compact.js` as pure
  functions. They already are.
- `runCompactNow` and `scheduleCompactAfterTurn` move into Engine as private
  methods (or into a small `agent/unify/compact/history.js` module that the
  Engine owns and the Bridge does not touch). Single-flight + entry-gate
  semantics live with whoever owns the array.
- Engine emits a `history_compacted` event in the standard event stream.
  Bridge translates it to `unify_history_compacted` for the frontend exactly
  like it does for `consolidate` today.
- `engine.summarizeForCompact` becomes private (`#summarizeForCompact`) since
  the bridge no longer calls it.

### 3.3 Reflect persistence

Once the engine owns `conversationMessages` across queries, T1 collapses
naturally persist — no extra work. T2 carry-forward (already on engine
instance) becomes more orthogonal because the array it rewrites is now the
same one the next query starts from.

### 3.4 Bridge becomes a translator

Post-migration, `web-bridge.js` responsibilities:
- WebSocket message dispatch (`handleUnifyGroupChat`, etc.) — unchanged.
- Translate Engine events → `unify_output` frames — unchanged.
- Group/VP coordinator (`runVpTurn`, `appendTurnToHistory`) shrinks: `appendTurnToHistory`
  goes away (engine appends in-place). Per-VP fan-out still owns "which VPs
  run for this turn" but does not own the history they share.
- Removes: `let conversationMessages`, `restoreHistoryFromRecent`,
  `appendTurnToHistory`, `scheduleCompactAfterTurn`, `runCompactNow`,
  `_compactInFlight`, `_compactPending`, the entry-gate await, the race guard.

Net diff: web-bridge.js loses ~250 lines.

### 3.5 Orchestrator compact stays where it is

`#runOrchestratorCompact` operates on `conversationStore` (disk), not on
in-memory messages. It's correctly engine-owned today and stays that way.
The two compact systems remain (memory-level + disk-level) but both live
in the engine, which makes "which one fires when" testable in isolation.

## 4. Migration plan

Five PRs, each independently revertable. Each one is preceded by tests
asserting the **observable behaviour** (compact triggers, T1 fires, history
restored after restart) so the refactor is mechanical.

### Phase A — characterisation tests (no behaviour change)

PR-A1: end-to-end tests for the bridge's compact path (single-flight,
race-on-reset, entry-gate). Most live as unit tests against
`history-compact.js` already; the missing layer is the
`scheduleCompactAfterTurn` + `_compactInFlight` semantics. Pin them.

PR-A2: end-to-end tests for cross-query T1 persistence. Today the assertion
would be "collapse does NOT persist" — pin the current behaviour explicitly,
so PR-C below shows up as an intentional behaviour change.

### Phase B — engine takes ownership of `conversationMessages`

PR-B: Engine adds `#conversationMessages` + `hydrateHistory` /
`appendUserMessage` / `appendAssistantTurn` / `clearHistory` API. Bridge
keeps its own array but **mirrors** every mutation into the engine via the
new API. Both arrays are kept in sync; tests run against either should be
equivalent. This is the trust-but-verify step before deletion.

### Phase C — bridge stops mirroring; engine is the source

PR-C: Bridge deletes its `conversationMessages`. Reads come from
`engine.getHistorySnapshot()` (read-only view) for any place that still
needs to inspect history (debug events, etc.). All writes already go
through the engine API from PR-B.

Behaviour change observable here: T1 collapses persist across queries.
PR-A2's pinned assertion flips. Compute the token savings empirically; gate
the change behind a flag if it materially shifts compact-trigger frequency
(it should — fewer raw tool pairs in history → compact fires later).

### Phase D — compact orchestration moves into engine

PR-D: Move `runCompactNow` + `scheduleCompactAfterTurn` + `_compactInFlight`
into engine (or `agent/unify/compact/history.js` adjacent module). Bridge
calls `engine.requestPostTurnCompact()` and listens for `history_compacted`
events. Single-flight + race guard semantics travel with the array owner.

### Phase E — cleanup

PR-E: `engine.summarizeForCompact` becomes private. `restoreHistoryFromRecent`
moves to a session-init helper that hands history to the engine. Group
fan-out stops re-broadcasting baseSnapshot — each VP engine reads its own
history. Bridge's `appendTurnToHistory` deleted.

## 5. Risks

**R1 — Per-VP history vs shared history.** Today every VP in a group sees
the same `conversationMessages` because there's one array. Post-migration,
each VP engine has its own. This may be the **right** behaviour (each VP's
context is its own conversation with the user from its perspective) or it
may break group cross-talk. Spike test required in Phase B against a real
multi-VP group: do the VPs still see each other's contributions, or did we
just isolate them? If isolated, the engine's history mutation API needs a
"broadcast to siblings" hook, OR the shared history stays at a higher level
(GroupContext) that the engines reference. Decision deferred to spike result.

**R2 — Compact threshold drift.** If T1 collapses persist (Phase C),
fewer tokens accumulate in history → compact fires less often → the
40%-of-ctx threshold may need re-tuning. Acceptable; the threshold is
already user-configurable via `maxContextTokens`. Add metrics (already
emitted as `unify_history_compacted`) and review post-deploy.

**R3 — Replay correctness.** `restoreHistoryFromRecent` projects from
disk records into the in-memory shape. Engine's `hydrateHistory` must
match this projection exactly or post-restart history shape changes. Test
with real recorded sessions in Phase B.

**R4 — `_compactInFlight` entry-gate timing.** Today the entry gate is in
`handleUnifyGroupChat` (web-bridge.js:1262) and awaits before fan-out
starts. Post-migration, each engine has its own in-flight promise — but the
bridge starts fan-out before any single engine knows whether it should
wait. Resolution: engine's `query()` itself awaits its own pending compact
at entry. Bridge's gate goes away.

## 6. Out of scope

- Conversation message DB unification (separate effort, see existing
  `DESIGN-PROMPT.md` notes on hot/cold tier).
- VP→VP cross-talk visibility model (separate Memory/scope decision).
- Frontend changes — events stay the same shape, just emitted from a
  different source.
- Renaming `conversationMessages` (consider after migration; risks
  unrelated diff churn).

## 7. Decision needed before Phase A

1. **Per-VP history isolation OK?** (R1) — does each VP keep its own
   conversation tape, or do they share via a GroupContext? Author leans
   "isolated" because that's the current Memory model (per-VP scope), but
   wants explicit user signoff.
2. **Single PR or 5 PRs?** Author strongly recommends 5; one for each
   migration phase, each independently revertable. Open to one big PR if
   the user wants to bookmark a single review window.
3. **When does the user want to run this?** This doc is a placeholder.
   No code changes proposed today.
