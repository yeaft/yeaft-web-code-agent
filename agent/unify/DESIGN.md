# Unify Memory & Prompt Architecture — Design Doc

**Status**: draft v4 (autoplan-reviewed) · 2026-04-27
**Owner**: Yeaft Unify
**Scope**: rewrite of memory layout, system-prompt assembly, compact policy, and tool-result lifecycle. Replaces the implicit design currently spread across `prompts.js`, `engine.js`, `memory/*`, and `pipeline/dispatcher.js`.

> **Autoplan v4 changes** (Jobs / Rams / Fowler review):
> - **Cut**: `forwardQuery.rewritten`, `/lock-summary`, `/think` slash, `summary.history.md`, memory `confidence`+demotion, `allowRouterEscalate` config, `granted_view` ACL escalation, K=200 tuning prose.
> - **Defer**: `priorPlan` router-skip optimisation (carry metadata only), parallel multi-plan fan-out (sequential first), `chat-completions.js` deletion (deprecate + migrate first), `harness/router-handoff` (Phase 3 not Phase 1).
> - **Add**: streaming-UX spec for multi-VP, mobile spec, in-place edit semantics, `_meta`-leak test, adapter-contract tests.
> - **Phase 0 split** into 0a/0b/0c; **Phase 3 split** into 3a/3b; new Phase 3.5 (parallel fan-out); new Phase 7 (delete chat-completions).

---

## 0. Guiding principles (from product)

1. **群 = 会话**. The "session" concept is weakened. One group is one continuous conversation; opening Unify drops you into a group. Single-VP "chat" is just a degenerate group with one VP.
2. **Memory is dynamically loadable**. The system prompt is not a static blob — sections are pulled in only when the current turn needs them.
3. **Memory > messages**. Memory is the curated key-information layer; messages are the source-of-truth fallback. When memory is incomplete, the model can drill back into messages via tools.
4. **Cut repeated payload**. Each API call today re-sends the full message history (user + tool results). We replace that bulk with denser memory + on-demand archive lookups.
5. **群成员** is the canonical Chinese term for "roster" / VP list inside a group. Do not say "roster" in UI or memory.
6. **No Yeaft fallback identity**. Every turn lands on a specific VP; identity is locked through the VP persona block. There is no "You are Yeaft" generic fallback in the worker prompt.
7. **user_profile / memory_index do change** — slowly, via auto-dream. They are semi-dynamic, not static.
8. **Two prompt families**: a *router/intent* prompt (cheap fastModel) and a *worker* prompt (primaryModel, per-VP).
9. **Router-driven, per-VP context**. The router emits a *separate decision per target VP*: which memories, which tasks, which forward-query (rewrite of the user's intent for that specific VP). The worker assembles around its own slice.

---

## 1. The two system prompts

### 1.1 Worker prompt (primaryModel, per-VP)

Built fresh per turn from four layers (A–D). A response-refinement layer was considered (draft v2 §1.1.E) and **deferred** — different tool-result shapes call for different refinement strategies, and we don't have a clean enough abstraction yet. Will revisit when we have real production traces.

```
┌─ A. VP IDENTITY + STABLE SUMMARIES ────────────────────────┐
│  Identity gate + the most stable, hand-curated context.    │
│  - displayName, role, persona body                         │
│  - response tone / voice (from role.md "voice:" block)     │
│  - capabilities & explicit refusals                        │
│  - user/summary.md            (about the human)            │
│  - groups/<g>/summary.md      (this group, in one para)    │
│  - vp/<v>/summary.md          (this VP, in one para)       │
├─ B. ROUTER-PRESELECTED MEMORY ─────────────────────────────┤
│  Bodies of memory entries the router thought relevant for  │
│  this VP this turn. Drawn from user/, groups/<g>/, vp/<v>/.│
│  - core_memory               (preselected entry bodies)    │
│  - memory_index_excerpt      (rows the worker may expand)  │
├─ C. TASK SCOPE ────────────────── populated by router ─────┤
│  Task-specific. Only when a task is open / preselected.    │
│  - in_progress task: id, title, goal, summary, members     │
│  - task_memory excerpt (router-picked task-scope ids)      │
│  - related open tasks (id + 1-line goal) for hand-off      │
├─ D. TURN SCOPE ────────────────── conversation-shaped ─────┤
│  Built per turn from the live messages window.             │
│  - inbound envelope: original user query + router's        │
│    forward_query (rewrite tailored for this VP)            │
│  - recent message window (last N turns, full)              │
│  - compact_summary (when older turns were archived)        │
│  - tool guidance + harness (see §5)                        │
└────────────────────────────────────────────────────────────┘
```

Why move the three `summary.md` files into A:

- They are **hand-curated or dream-maintained, paragraph-sized, and stable across many turns**. They belong with identity, not with the per-turn router output.
- A is the cache anchor — putting summaries here keeps the cached prefix richer.
- Operationally: the VP has the same understanding of "who the user is, what the group is, who I am" on every turn, regardless of whether the router preselected interesting memory rows that turn.

A is **mandatory and uncacheable on first build**, but very stable thereafter (good cache citizen). B and C change with router preselect. D is the diff layer.

> **B and C are router-derived.** The router decides which memory paths and which task ids belong in this turn's context for *this specific VP*. The worker prompt builder receives `preselect.{memoryPaths, taskIds}` and only includes those bodies / summaries — it does *not* dump the full visible memory tree.

### 1.2 Router prompt (fastModel)

Used to decide *who handles this turn*, *with what context*, and *with what restated intent*. The router does not write the user-facing reply — it produces a JSON decision.

The router needs **enough world-state to make a real decision, not just a guess**. Concretely it sees:

- the user's new message (verbatim)
- the current group's 群成员 (id + role + 1-line capability)
- **memory index** for every scope visible to this group (titles + paths + tags) — the merged `index.md` rows
- **memory high-level summary** — `summary.md` per visible scope, so the router can judge *topical relevance* without loading individual entries
- **all open tasks** in this group, each with `{id, title, goal, status, assignedVpIds, lastUpdate}`
- the **in-progress task** (if any) with its full task_summary and members
- the last 5 turns of this group (text only, no tool blobs)

Why both index *and* summary? Index rows are short titles — easy to scan, but two memories titled "deployment notes" might be about totally different deploys. The per-scope summary paragraph (≈200 tokens per scope) lets the router judge "is there *probably* something relevant in this scope at all" before it commits paths to `preselect`.

#### 1.2.1 Output schema — *per-VP decisions*

A user query can mean different things to different VPs. "Should we redo the deploy?" means *kernel-side risk* to Linus and *release-comms timing* to Grace. The router therefore emits an array of per-VP plans, each with its own preselect and its own forward-query rewrite:

```jsonc
{
  "action": "continue" | "switch_vp" | "fork_task" | "join_task" | "broadcast" | "noop",
  "targetTaskId": "t_42" | null,                  // shared across plans (one task per turn)
  "plans": [
    {
      "vpId": "linus",
      "forwardQuery": {
        "userOriginal": "should we redo the deploy?",
        "rewritten":    "Linus: assess deploy-rollback risk to the kernel scheduler patch in t_42; user is asking whether to redo it.",
        "intent":       "risk_assessment"
      },
      "preselect": {
        "memoryPaths": [
          "groups/eng-team/entries/2026-04-18-release-tag-trigger.md",
          "vp/linus/entries/2026-04-25-disagrees-router-design.md"
        ],
        "taskIds": ["t_18"]
      },
      "thinking": "max",
      "thinkingReason": "rollback risk needs cross-system reasoning"
    },
    {
      "vpId": "grace",
      "forwardQuery": {
        "userOriginal": "should we redo the deploy?",
        "rewritten":    "Grace: explain the user-facing implications of redoing the deploy; communication timing matters.",
        "intent":       "user_facing_explanation"
      },
      "preselect": {
        "memoryPaths": [
          "user/entries/2026-04-21-prefers-concise-replies.md"
        ],
        "taskIds": []
      },
      "thinking": "high",
      "thinkingReason": "straightforward comms framing"
    }
  ],
  "reason": "user @-mentioned both implicitly via 'we'; topic splits cleanly into risk (linus) and comms (grace)"
}
```

Notes:
- `plans` is always an array; single-VP turns are `plans.length === 1`.
- `forwardQuery.userOriginal` is **always preserved verbatim** — the worker sees it. `rewritten` is the router's prompt-optimisation pass: cleaner intent, the VP's name, a one-line framing. `intent` is a coarse tag for telemetry.
- `preselect.memoryPaths` are filesystem-relative paths from `~/.yeaft/memory/`, NOT abstract ids. The worker can `memory_load(path)` directly; the path is also human-readable in logs.
- `preselect.taskIds` may differ per plan (rare, but allowed — Linus might care about t_18, Grace about t_22).
- `targetTaskId` is shared because a turn happens *in* one task (or none); only one task gets summary refresh from this turn's outcome.
- The dispatcher fans out one worker call per plan, in parallel, each with its own `forwardQuery` rendered into layer D.

Three router scenarios:

- **A. Explicit `@vp` (single or multiple) + active task** — skip the LLM router; build the per-VP plans directly in the dispatcher, with `forwardQuery.rewritten = userOriginal` (no rewrite). Extends today's override path.
- **B. No `@`, no active task** — full router call, fastModel.
- **C. Group fan-out / broadcast** — router infers fan-out (`action: "broadcast"`, multiple `plans`).

---

## 2. Memory layout

### 2.1 Scope tree

Markdown all the way down. No JSON in the hot path — model-friendly, grep-friendly, diff-friendly.

```
~/.yeaft/memory/
  user/                                # the human
    profile.md                         # user_profile, slow-changing
    summary.md                         # paragraph synopsis (lives in worker A)
    index.md                           # path/title/tags table — see §2.3
    entries/
      <yyyy-mm-dd>-<slug>.md           # one fact / lesson / preference per file

  groups/<groupId>/
    meta.md                            # group goal, conventions, 群成员
    summary.md                         # paragraph synopsis (worker A)
    index.md
    entries/<yyyy-mm-dd>-<slug>.md

  vp/<vpId>/
    role.md                            # persona, voice, capabilities, refusals
    summary.md                         # what this VP "is" in one paragraph (worker A)
    index.md
    entries/<yyyy-mm-dd>-<slug>.md     # VP-private notes

  tasks/<taskId>/
    summary.md                         # rolling summary, regenerated on compact
    index.md
    entries/<yyyy-mm-dd>-<slug>.md
    archive/                           # see §4 (cold storage for messages + tools)
```

> **`vp-in-group/` removed.** Earlier draft had this scope; in practice a VP's learnings *inside* a group are interesting to that group, not just to the VP — they belong in `groups/<g>/entries/` (visible to the whole group) or in `vp/<v>/entries/` (private to the VP). The cross-product scope adds bookkeeping without a clear use case.

> **One entry = one piece of content**, not one-per-day or one-per-session. A single fact, lesson, decision, or preference is one file. Filenames are `<created-date>-<slug>.md` purely for human ordering and *for use as the canonical path*.

> **Each scope has a `summary.md`** that is *generated and refreshed by dream*. The three `summary.md` for `user/`, `groups/<active>/`, `vp/<active>/` go straight into worker layer A. The router consumes summaries from *all visible scopes* to judge relevance.

### 2.2 ACL — what each VP can see

Default is **broadly visible**; the model decides what to load via tool. Hard-blocked scopes are short.

| Scope                | Visible to v? | Notes                                                |
|----------------------|---------------|------------------------------------------------------|
| `user/`              | yes           | every VP knows the human                             |
| `groups/<any>/`      | yes           | groups are not private to one VP                     |
| `vp/v/`              | yes           | own private memory                                   |
| `vp/<other>/`        | **no**        | only hard ACL — VPs do not read each other's private notes |
| `tasks/<any>/`       | yes           | task entries are visible; mutation rules separate    |

Visibility rule: index merge includes everything except `vp/<other>/`. The model retrieves bodies on demand via `memory_load(path)`; that tool re-checks ACL on access. There is no "task members vs. non-members" split — visibility is open, *write* permission is the thing tasks gate.

### 2.3 Index format — `index.md`, paths not ids

The first column is the **filesystem path** of the entry, not an opaque id. This is the only thing that lets an LLM actually load the content (tool: `memory_load(path)` or even direct `read(path)`); an id requires an extra resolution step the model has to be primed for.

```markdown
# index — groups/eng-team

| path                                                          | title                                          | tags                  | kind       | updated    |
|---------------------------------------------------------------|------------------------------------------------|-----------------------|------------|------------|
| groups/eng-team/entries/2026-04-21-prefers-concise.md         | user prefers concise replies                   | preference,tone       | preference | 2026-04-21 |
| groups/eng-team/entries/2026-04-18-release-tag-trigger.md     | deployment uses release-v0.1.X tag trigger     | ops,release           | fact       | 2026-04-18 |
| vp/linus/entries/2026-04-25-disagrees-router-design.md        | linus disagrees with current router design     | opinion,architecture  | lesson     | 2026-04-25 |
```

Why markdown table not JSON, and why path not id:
- LLMs read markdown tables natively without schema priming.
- `grep -i 'router' index.md` works, no jq.
- Diffs are line-based, so dream's incremental updates show up cleanly.
- **Paths self-document**: a model that sees `vp/linus/entries/2026-04-25-disagrees-router-design.md` already knows whose memory it is, when it was written, and roughly what about — *before* loading the body. Opaque ids (`m_abc`) carry zero of that.
- Path-based lookup also degrades gracefully: even if the index is stale or missing, the model can `glob 'memory/**/*router*.md'` to find candidates.

The path also doubles as the canonical id within the system — a single string, no separate id field needed in frontmatter.

---

## 3. Prompt assembly — worker

```
buildWorkerPrompt({
  vp,                  // {id, displayName, role, persona, voice, summary}
  group,               // {id, name, goal, members[], summary}
  user,                // {profile, summary}
  task,                // optional — current in-progress task
  preselect,           // { memoryPaths, taskIds } from this VP's router plan
  forwardQuery,        // { userOriginal, rewritten, intent }
  recentTurns,         // last N full turns
  compactSummary,      // present iff older turns were archived
  inboundEnvelope,     // optional inter-VP route envelope
  turnFlags,           // {language, mode, harnessProfile}
})
  →  string
```

Layer order (top to bottom of the system prompt):

1. **A. VP IDENTITY + STABLE SUMMARIES**
   - "You are **{displayName}**, {role}." (no Yeaft fallback)
   - Persona body verbatim
   - **Response tone / voice** — from `vp/<id>/role.md` `voice:` frontmatter (e.g. *Linus*: "blunt, technical, no marketing language; refuses fluff"; *Grace*: "patient, pedagogical, defines acronyms once"). Hard constraint, not a hint.
   - Allowed/disallowed actions (refusal rules) for this VP.
   - `## about_user` — `user/summary.md`
   - `## about_group` — `groups/<g>/summary.md`
   - `## about_self` — `vp/<v>/summary.md` (yes, the VP reads its own summary — useful for keeping voice consistent across long sessions)

2. **B. ROUTER-PRESELECTED MEMORY**
   - `## core_memory` — bodies of router-preselected memory paths
   - `## memory_index_excerpt` — table rows from `index.md` for paths the worker may want to expand via `memory_load`

3. **C. TASK SCOPE** *(omitted if no active task)*
   - `## task` — id, title, goal, status, members
   - `## task_summary` — rolling summary (regenerated on compact)
   - `## task_memory` — bodies of router-preselected task-scope paths
   - `## related_tasks` — id + 1-line goal of router-supplied related open tasks

4. **D. TURN SCOPE**
   - `## inbound`
     - `user_original`: the user's verbatim words (always present)
     - `forward_query`: router's rewritten version tailored for this VP (when router ran)
     - `inter_vp_envelope`: if another VP routed this turn, the sender + reason
   - `## compact_summary` *(if archive happened)* — what was rolled up
   - `## recent` — last N turns rendered as a chat transcript
   - `## tools` — tool guidance for this mode
   - `## harness` — see §5

The `inbound` block always shows the user's original words in addition to the forward query. The model trusts the original; the rewrite is a hint.

---

## 4. Compact, archive, and tool-result lifecycle

### 4.1 Compact triggers (any of)

1. `tokens(messages) > 0.9 × model.contextLimit`
2. `messages.length > 50`
3. group idle > 2 minutes (background pass; soft trigger)
4. explicit `/compact`

### 4.2 What compact does (atomic, one pass)

Compact runs **three tracks together** so the resulting state is consistent.

**Track 1 — message compaction (always runs):**
1. Pick the cut point: keep the most recent N turns "hot" (default N = 10). Older turns are "cooling".
2. **Generate a `compact_summary`** of the cooling turns — placed at the top of the live messages window.
3. **Archive the cooling turns** to `groups/<gid>/archive/<turnId>.md` (or `tasks/<tid>/archive/...` if the turn was task-scoped), then drop them from the live messages array.

**Track 2 — task summary refresh (when a task is open):**
4. Refresh `tasks/<tid>/summary.md` from the cooling turns + the prior summary.

**Track 3 — memory extraction (always runs):**
5. Extract durable facts/lessons/preferences from the cooling turns into the appropriate scopes (`user/`, `groups/<g>/`, `vp/<v>/`, `tasks/<t>/`), creating `entries/*.md` and updating `index.md` and `summary.md` for each touched scope.

Compact is the only place these run together. There's no "compact at turn-end vs extract-on-idle vs summarise-on-recall" zoo; one trigger, one pass, three tracks.

### 4.3 Tool-result archive (independent of compact)

Tool results balloon context (file dumps, web pages, grep output). Rule:

- A `role:'tool'` message with `turn_age > 5` **and** `length > 2000 chars` is archived to `…/archive/tool-results/<toolCallId>.md` and replaced in-place with a stub:
  ```jsonc
  { "role": "tool", "toolCallId": "tc_42",
    "content": "[archived: 14.2KB; preview: \"<first 200 chars>\"; retrieve via tool_trace(\"tc_42\")]",
    "isError": false }
  ```
- The `[user, assistant(toolCalls), tool…]` pairing invariant (`engine-instance.js#flushAssistantTurn`) is preserved — the stub still satisfies the OpenAI/Anthropic schema.

### 4.4 Retrieval tools

- **`tool_trace({toolCallId})`** — returns the original tool result body. Worker calls this when the stub preview isn't enough.
- **`message_trace({turnId})`** — returns the full original turn (user + assistant + tools) from the archive. Worker calls this when `compact_summary` is too lossy.
- **`memory_load({path})`** — returns the body of an indexed memory by its filesystem path. (`memory_query` / `memory_search` already exist for fuzzy lookup.)

All three respect ACL (only `vp/<other>/` is hard-blocked).

---

## 5. Harness prompts (quality-assurance fragments)

A library of small reusable fragments composed into the `## harness` block at the bottom of layer D. Selected by `turnFlags.harnessProfile`. Same fragments are usable across VPs — the *voice* layer (A) decides tone, harness decides quality bars.

Fragment catalogue (initial set, ship together):

- `harness/output-format` — output must be valid Markdown; code in fenced blocks; never invent file paths.
- `harness/tool-use` — prefer one tool call per intent; never call `bash` for things `read`/`grep`/`glob` covers; quote paths with spaces.
- `harness/code-quality` — match existing style; no commented-out code; no `console.log` debug residue; no emojis unless asked.
- `harness/refusal` — never fabricate file contents you have not read; if an ACL prevents access, say so explicitly rather than guess.
- `harness/turn-discipline` — finish the user's *current* request before proposing next steps; do not silently change scope.
- `harness/memory-discipline` — prefer `memory_load` over re-asking the user; if memory is missing, say "I don't have that yet" rather than hallucinate.
- `harness/router-handoff` — when handing off via `route_forward`, include a `reason` that the receiving VP can act on with no other context.

`turnFlags.harnessProfile` defaults to `["output-format", "tool-use", "refusal", "memory-discipline"]`. Work-mode adds `code-quality` + `turn-discipline`. Coordinator adds `router-handoff`.

These live in `agent/unify/templates/harness/*.md` and are concatenated by `buildWorkerPrompt`. **Ship in Phase 1**, not as a follow-up.

---

## 6. Forward / router correctness — verification

Bug 4 already proved that `RouteForwardTool` and the per-VP `Router` injection can silently break (`router_unavailable`). The new architecture leans much harder on routing, so we treat router/forward as **must-verify infrastructure**, not best-effort.

Required guardrails (must ship before Phase 3):

1. **Pinning tests** (already started in `test/agent/unify/vp-prompt-and-routing.test.js`). Extend to cover:
   - multi-plan fan-out (one router output → N parallel worker calls, each with its own preselect + forwardQuery)
   - `preselect.memoryPaths` plumbing from router → dispatcher → `EngineInstance.query` → worker prompt body inclusion
   - `forwardQuery` rendering in worker layer D `inbound`
   - `route_forward` with missing senderVpId / missing router (already covered)
2. **End-to-end smoke** — for every group session start, the dispatcher asserts that *every* VP in the group resolves a non-null `Router` from `web-bridge#buildVpQueryOpts`. Failure logs a loud warning instead of a silent fallback.
3. **Routing decision logging** — every `routing_decision` event includes `source: 'override'|'llm'|'fallback'`, the chosen `plans[].vpId` list, and an input fingerprint (group id, last turn id, router input token count). Trace replays exist for any "wrong VP got the turn" report.
4. **Forward dead-letter** — if `route_forward` runs with a `targetVpId` that does not exist in this group's 群成员, the tool returns `{ ok: false, error: 'unknown_target', candidates: [...] }` instead of silently dropping. Worker can re-pick.

---

## 7. Cache friendliness (informational, not a hack)

Layer order is chosen so the **A** prefix is stable for many turns:

- A changes only when the user `@`s a different VP, or when dream rewrites one of the three `summary.md`s (slow).
- B changes when router preselect changes (per turn — accept the cache miss in exchange for skipping a worker tool round-trip).
- C changes when the active task changes or its task preselect changes.
- D is the diff layer.

Providers that natively cache common prefixes (Anthropic prompt caching) get the win for free on layer A. We do not insert explicit cache-breakpoint markers — too hacky, agreed.

---

## 8. Migration plan

1. **Phase 0a — adapter audit.** Verify `anthropic.js` matches current Messages API; smoke-test against a configured provider. Land any spec drift fixes.
2. **Phase 0b — Responses adapter.** Add `openai-responses.js` for the OpenAI Responses API. Both adapters accept the turn-level `thinking` field (§9.16) and translate to wire format. Add adapter-contract tests (identical `queryOpts` → equivalent observable behaviour across both).
3. **Phase 0c — deprecate chat-completions.** Mark `chat-completions.js` deprecated (warning on load); migrate every provider in `~/.yeaft/config.json` to either Messages or Responses. Don't delete yet — see Phase 7.
4. **Phase 1 — split the prompt builder + harness library + UX specs.** Replace `buildSystemPrompt` with `buildWorkerPrompt(layers)` + `buildRouterPrompt(layers)`. Land harness fragments (excluding `router-handoff` — that ships in Phase 3). Move the three summary blocks into layer A. Write multi-VP streaming, mobile, and in-place edit specs into the doc.
5. **Phase 2 — scope the memory store** *(parallelisable with Phase 5)*. Introduce the directory tree in §2.1 with markdown `index.md` (path-keyed) + `summary.md`. Migrate existing flat entries into `user/` + `groups/default/` + `vp/<id>/`. Drop the old `index.json`.
6. **Phase 3a — router per-VP plans.** Feed router the merged index + per-scope summaries + open tasks; emit per-VP `plans[]` with `forwardQuery: {userOriginal, intent}` (no rewrite — see §1.2.1) + `preselect.memoryPaths`; sequential fan-out only. Land §6 verification gates first.
7. **Phase 3b — priorPlan continuity + thinking.** Add `_meta.routerPlan` carry-back and `thinking` field in the plan + queryOpts. Ship metadata + UI selector; **do NOT** ship the skip-router heuristic yet. Add `harness/router-handoff` fragment.
8. **Phase 3.5 — parallel multi-plan fan-out.** After §9.1 concurrency test harness lands. Allow `dispatch()` to issue multiple `EngineInstance.query()` in parallel.
9. **Phase 4 — compact rewrite.** One trigger, three tracks (messages, task summary, memory extraction). Define the append-only task decisions log schema concretely.
10. **Phase 5 — tool-result archive + `tool_trace` / `message_trace`** *(parallelisable with Phase 2)*.
11. **Phase 6 — dream maintenance** of `summary.md` + `index.md` per scope on hourly tick with diff-gate (§9.14). Thin: skip pruning/demotion; refresh-only in v1.
12. **Phase 7 — delete `chat-completions.js`.** After all configs migrated.

Each phase is independently shippable in the order listed.

---

## 9. Corner cases & cross-cutting concerns

A pass through situations the layered architecture above doesn't obviously handle.

### 9.1 Concurrency

- **Two plans for the same task**: router emits plans for Linus + Grace, both with `targetTaskId = t_42`. Both worker calls run in parallel; both may try to write `tasks/t_42/entries/...md`. Use **atomic file create** (`O_EXCL` open) and a per-task append-only "decisions log" so two writes don't clobber. Compact (track 2) reads the log and produces one canonical `summary.md`.
- **Compact running while a worker is mid-stream**: compact mutates `tasks/<t>/summary.md` and live messages. Take a snapshot of the messages array at worker `query()` start (already what `engine-instance.js` does); compact's mutation only affects the *next* turn. For `summary.md`, compact writes to a `.tmp` then renames — workers reading `summary.md` see either the old or the new file, never a torn one.
- **Dream running while a turn runs**: dream rewrites `summary.md` and `index.md`. Same atomic-rename rule. Workers tolerate index rows that vanish between assembly and `memory_load(path)` — `memory_load` returns `{ ok: false, error: 'gone', hint: 'index may have been refreshed' }` and the model retries `memory_search`.

### 9.2 Tool-call invariants under archiving

- Archiving a tool result while leaving its assistant `toolCalls` block in history is *fine* (we already have a stub message). But archiving the **assistant message itself** (because it falls outside the hot window) breaks the OpenAI invariant that `tool_call_id`s be paired. Rule: when message-track compact archives an assistant turn that contained `toolCalls`, it must archive *the entire turn-group* (assistant + all its tool results) as one atomic unit. The `compact_summary` placeholder represents the whole group.
- The `flushAssistantTurn` placeholder synthesis (`engine-instance.js`) handles the abort path. Compact's archive path uses the same placeholder format for any turn it removes mid-tool-call.

### 9.3 Router input ballooning

- 1000 memories × ~30 tok/row + 5 scopes × ~200 tok summary ≈ 31k tokens of router input. Cheap on a fastModel with a 200k window; expensive at 10k memories. Mitigations:
  - **`index.md` is reverse-chronological, append-on-top.** No score, no ranking — new entries go at the top, old entries fall off the bottom of the router's view as the file grows. The router LLM reads the index and decides for itself which paths look relevant given the user's message and the conversation context. Scoring would just second-guess what the LLM already does well.
  - **Hard cap on rows surfaced to router**: take the top K rows of each scope's `index.md` (default K = 200). If a memory is older than that and still relevant, the user's message + conversation will usually contain enough cues for the router to ask `memory_search` instead.
  - **No keyword pre-filter.** Same reason — the LLM is the right thing to decide what's relevant. If router input becomes genuinely too large for the fastModel, the response is to lower K, not to add a hand-rolled retrieval heuristic.

### 9.4 New-user / cold-start

- First turn ever: no `summary.md` exists for `user/` or `groups/<new>/`. Layer A renders empty `## about_user` / `## about_group` blocks (or omits them) — the worker is told the human is new and to ask discovery questions naturally. After the first compact pass, summaries exist.
- First VP turn: `vp/<v>/summary.md` likely missing. Use the persona body itself as the seed; dream backfills after a few turns.

### 9.5 Identity drift over a long session

- `summary.md` is dream-maintained. Without an upper bound it may drift far from reality. Dream pass keeps a *changelog* (`summary.history.md`) of past summaries; on weekly maintenance, dream reads the live entries + the last few summaries to decide whether to keep or rewrite.
- The user can pin a summary via `/lock-summary user` to prevent dream from touching it.

### 9.6 ACL escalation paths

- Hard rule: a VP cannot read another VP's `vp/<other>/`. But sometimes a user routes Linus to Grace's prior conversation explicitly ("look at what Grace said yesterday"). Resolution: the user's instruction is a **temporary allow-grant** carried in the `forwardQuery` of *that turn only* — Linus's worker prompt gets a one-off `## granted_view` block with the specific paths. No persistent ACL relaxation.

### 9.7 Multi-turn forward conversations

- Linus replies to user, then forwards to Grace. Grace's worker layer D `inbound` shows: `user_original` (what the human said) + `inter_vp_envelope` (Linus's forward + reason) + `forwardQuery.rewritten` (router's rewrite for Grace). Three views of one intent. Order matters — `inter_vp_envelope` goes *between* `user_original` and `forward_query` so Grace reads the human first, then the routing chain.

### 9.8 User correction / re-routing

- User says "no, ask Grace, not Linus" right after a Linus reply. Treat as `action: switch_vp` with explicit override (router scenario A). Don't re-extract memory yet — wait for next compact; otherwise we accumulate "Linus was wrong" churn.

### 9.9 Memory poisoning

- Tool-extracted memories from cooling turns are produced by an LLM and may be wrong. Mitigation:
  - Every entry frontmatter carries `source: <turnId>` + `confidence: low|med|high`.
  - Dream demotes (deletes) low-confidence entries that were never accessed in 30 days.
  - User can `/forget <path>` and dream blacklists the source turn from further extraction.

### 9.10 Multi-language groups

- A group may have an English VP (Linus) and a Chinese VP (in zh role.md). Worker prompts are built in the VP's language — `turnFlags.language` is **per-VP**, not per-group. The user's original message is always preserved verbatim regardless of language; the rewrite is in the VP's language.

### 9.11 Task hand-off without memory loss

- When a task closes and a new one opens for follow-up work, copy the closing task's `summary.md` into the new task's `entries/` as a "predecessor:" entry, with `parent_task_id` in frontmatter. Avoids re-deriving context from cold archives.

### 9.12 Live user append while a VP is in its tool loop

A user can drop a new message into the group at any time, including while one or more VPs are mid-loop (`assistant → tool → assistant → tool → …`). Treat it case-by-case:

- **The new message targets an already-active VP** (explicit `@VP` or, with no `@`, any VP currently running a query for this group):
  - **Skip the router for that VP.** Router output would only race the in-flight loop and produce a redundant plan.
  - **Append the user message into that VP's live conversation as the next `role:'user'` message after the most recently completed tool-result block.** This matches how Claude Code (and the Anthropic Messages API in general) handles interactive interjection — the next assistant turn sees the original user prompt, the tool exchanges so far, and then the new user message as additional context. The model self-pivots without a fresh system prompt build.
  - Implementation hook: `EngineInstance` exposes `appendUserMessage(text)` that is safe to call mid-`query()`. The async generator's tool-loop driver checks a small inbox between iterations (after `turn_end`, before the next assistant call) and splices any pending user messages into `messages` before issuing the next request. We **do not** interrupt mid-streaming-token; the splice happens on iteration boundaries only. This gives a worst-case latency of "one tool round-trip" before the new message lands — the natural beat of the loop.
  - The new message bypasses A/B/C rebuild — we keep the cached system-prompt prefix exactly as it was on the original turn. Only D evolves naturally as the messages array grows.

- **The new message targets a VP that is not currently active** (no in-flight query for that VP, or `@VP` for an idle VP):
  - **Run the full pipeline in parallel**: queue → router (if needed) → per-VP plan → new `EngineInstance.query()`. This worker call runs alongside any already-active VP loops; the dispatcher already supports concurrent `dispatch()` (each yields its own tagged event stream — see `engine-instance.js` re-tagging by `threadId`).

- **The new message has no `@` and no VP is currently active**: standard cold path — full router call.

- **Multiple active VPs and the new message is ambiguous (no `@`, several VPs in-flight)**: route through the LLM router. The router sees `active_vp_ids: [...]` in its input and decides whether to feed the message to one active VP (append path), spawn a new VP plan, or both. Default bias: prefer appending to one already-active VP over spawning, since spawning duplicates work.

Edge constraints:
- Append is FIFO. If two user messages land back-to-back during one tool round-trip, both splice in, in order, before the next assistant call.
- Abort is unchanged. If the user types `/stop` it cancels the in-flight `query()` via the existing `AbortController` path; pending appends are dropped.
- Tool-call invariants (§9.2) are preserved: appends only happen at iteration boundaries (after a paired `assistant(toolCalls) + tool*` block), never mid-pair.
- Tracing: every appended message is logged with `source: 'live_append'` and the original turn id it joined, so replays can reconstruct who-said-what-when.

### 9.13 Router mis-routes

- Router picks Linus; Linus realises he's wrong. Layer D harness rule (`harness/router-handoff`): Linus calls `route_forward(targetVpId='grace', reason='this is comms not kernel')`. The forward becomes the next turn's `inter_vp_envelope` for Grace. No retry of the router for the same user message — once user input is consumed, only VP-initiated forwards continue.

### 9.14 Dream cadence

- **Hourly tick.** Dream wakes once an hour while the agent is up.
- **Diff gate.** On wake, dream checks whether any group has new messages since its last successful pass. No new messages anywhere → no-op, log "skipped, no diff." This is the cheap default.
- **What dream actually does on a non-skip pass:**
  1. For each scope touched by new messages (user, the active groups, the VPs that spoke, the tasks that progressed): refresh `summary.md`, append/rewrite `index.md` rows, prune low-confidence/never-accessed entries (§9.9).
  2. Maintain `summary.history.md` per scope (§9.5).
- **Manual trigger**: `/dream` forces a pass regardless of diff.
- **Compact-driven extraction is independent of dream.** Compact (§4.2 track 3) writes new entries inline; dream is the periodic *consolidation* pass that merges duplicates, prunes stale, and rewrites `summary.md`. The two cooperate but do not replace each other.

### 9.15 Per-message preselect carry-back (router continuity)

The router's job is "pick the right context for this turn", but the *previous* turn's choice is itself a strong signal. If we just rebuild from scratch every turn, the router has no memory of "we already decided this thread is about t_18 with these 4 memories" and may oscillate between equivalent context bundles, churning the cache for no reason.

**Rule**: every assistant message in the live conversation carries the router's preselect in its metadata (not in the model-visible content):

```
{
  role: 'assistant',
  content: '…',
  toolCalls: [...],
  _meta: {
    routerPlan: {
      vpId: 'linus',
      forwardQuery: {...},
      preselect: { memoryPaths: [...], taskIds: [...] }
    }
  }
}
```

The `_meta` field is dropped before sending to the LLM (it's bookkeeping), but the dispatcher reads it on the *next* turn for the same VP and feeds it to the router as `prior_plan` input:

```
buildRouterPrompt({
  ...,
  priorPlan: <last assistant message's _meta.routerPlan, if any>,
})
```

The router prompt then says: *"the previous plan was X. Decide whether to (a) extend it — keep the same task and most of the memory paths, possibly add new ones, or (b) start fresh — declare a new task or switch contexts. Justify briefly."*

Why this matters:
- **Continuity detection.** "Should we redo the deploy?" → "yes, do it now" is clearly the same thread; the router should keep `t_42` and the same memory paths. Without `priorPlan` it might pick a different but plausible bundle.
- **Cheap heuristic for `action`.** If `priorPlan.taskId` is still the active task and the user's new message is short and on-topic, the router can confidently emit `action: continue` with `preselect = priorPlan.preselect ∪ small delta`. Token-cheap.
- **Cache locality.** Worker layers B/C are stable across turns when preselect is stable. `priorPlan` reuse → cache hits.
- **Audit trail.** Every assistant message records the plan that produced it. When something goes wrong ("why did Linus see those memories?") the trace is in-place, no separate log to cross-reference.

Implementation:
- `EngineInstance.query()` already builds the assistant message in `flushAssistantTurn`. Add `_meta.routerPlan` from the `queryOpts` the dispatcher passed in.
- `EngineInstance#messages` keeps `_meta`; serialisers (chat-completions, anthropic) strip it. `tool` messages don't get `_meta` (no plan attached to a tool result).
- Persistence (`conversation/persist.js`) writes `_meta` to disk so reloads keep continuity across agent restarts.
- Compact archive carries `_meta` into the archived turn — useful for `message_trace` replays.

Optimisation knock-ons to the rest of the flow:

1. **Skip the router entirely when continuity is obvious.** If `priorPlan` exists, the user message is < 200 tokens, contains no `@`, and the active task is unchanged, the dispatcher emits `plans = [priorPlan]` directly without an LLM call. Router LLM is only invoked when the heuristic doesn't fire. Saves ~1 fastModel call per simple follow-up.
2. **Live-append (§9.12) inherits the prior plan automatically** — the in-flight VP keeps its layer B/C; no extra wiring needed.
3. **Multi-VP turns**: each VP carries its own `priorPlan`. Linus's continuity is independent of Grace's.
4. **First turn**: no `priorPlan`; full router call as today.

This single change turns the router from "stateless every turn" into "stateful with cheap escape hatch", which is what every long-running conversation actually needs.

### 9.16 Thinking-mode budget

Both supported APIs expose extended-thinking. Surface to user is a single 2-level enum, `high | max`, default `high`.

**API mapping (handled in adapter, nothing else):**

| API | Wire field | `high` | `max` |
|---|---|---|---|
| Anthropic Messages | `thinking: { type: 'enabled', budget_tokens: N }` | budget = `config.thinking.budget.high` (default 16k) | budget = `config.thinking.budget.max` (default 64k or model cap, whichever is smaller) |
| OpenAI Responses | `reasoning: { effort: ... }` | `effort: 'medium'` | `effort: 'high'` |

The router emits one provider-agnostic value (`'high'` or `'max'`) per plan; the adapter chosen by the model's provider is the only place this gets translated. So a single router output is correct for both APIs — no provider-aware logic upstream of the adapter.

**Decision precedence (high → low):**

1. **UI setting.** A `Think: high ▾ / max` selector lives in the Unify topbar next to the model picker. Two modes:
   - *Per-turn* (default): the picker affects only the next turn the user sends; auto-resets to the group default after that turn.
   - *Lock for group*: a small lock icon next to the picker pins the choice into `groups/<g>/meta.md` (`thinking: max`) so it sticks across turns until unlocked.
   The UI value is sent on the `unify_chat` WebSocket frame as `thinking: 'high' | 'max'` and reaches the dispatcher in `submitOptions`.
2. **Router recommendation.** When no UI override is in force, the router's per-plan `thinking` decides. Router defaults to `high`; recommends `max` only when the criteria block fires:
   > Recommend `max` only when: (a) the user is asking for an architectural/design decision with non-obvious tradeoffs, (b) a multi-step debugging task across files the VP has not yet seen, (c) the user's message contains "think hard" / "deeply" / "carefully" or zh equivalents (深入思考/仔细想/认真分析), (d) a task is being forked or a plan is being written. Otherwise `high`.
3. **VP default.** `vp/<id>/role.md` frontmatter `defaultThinking: max` for personas that should always think hard (e.g. an `architect-fowler` VP). Used only when both UI and router are silent.
4. **Global default**: `config.thinking.default` (factory: `high`).

The dispatcher resolves this chain into the final `queryOpts.thinking` and passes it through `EngineInstance.query()` → adapter, alongside `vpPersona`, `forwardQuery`, `preselect`. Worker prompt does not change as a function of thinking level — it's an adapter concern.

**Router output extension (per plan):**

```jsonc
"plans": [{
  "vpId": "linus",
  "forwardQuery": {...},
  "preselect": {...},
  "thinking": "max",                                  // ← provider-agnostic
  "thinkingReason": "design-tradeoff with cross-system implications"
}]
```

`thinkingReason` is logged for telemetry and helps tune the criteria block over time.

**Continuity (avoid cache thrash):** the router defaults its recommendation to `priorPlan.thinking` when the prior plan exists and the current message doesn't clearly trigger an escalation criterion. This prevents flip-flopping between `high` and `max` on borderline cases — the Anthropic prompt cache keys include the thinking field, so unstable values cause prefix re-encoding every turn. Same continuity story as `preselect`.

**Config block** (`~/.yeaft/config.json`):

```jsonc
{
  "thinking": {
    "default": "high",                                // 'high' | 'max'
    "allowRouterEscalate": true,                      // false → router can never bump high→max
    "budget": {                                       // anthropic only
      "high": 16000,
      "max": 64000
    }
  }
}
```

`allowRouterEscalate: false` is the escape hatch for cost-conscious users who never want max unless they click the UI themselves.

**UI plumbing:**
- Pinia store: `unifyThinking: 'high' | 'max'` (transient) + `unifyThinkingLocked: boolean`.
- The selector emits an `unify_chat` frame with `thinking` set; the agent's `web-bridge.handleUnifyChat` puts it into `submitOptions.queryOpts.thinking`; the dispatcher records it in the route-decision precedence as the highest-priority signal.
- Lock toggle calls a new `unify_group_set_thinking` WS message that writes `groups/<g>/meta.md`. Reads on group load.
- Frontend never reads `config.thinking.budget` — those numbers live only in the agent's adapter.

---

## 10. Open questions

- Group-level **harness override** (e.g. a "this group does Chinese only" rule baked into `groups/<id>/meta.md`) — left for follow-up.
- Per-plan `forwardQuery.rewritten` is generated by the router LLM. Router quality matters a lot here. We should sample and review rewrites in the first two weeks after Phase 3 lands.
- Index hard-cap K (default 200 rows / scope, §9.3) is a guess. Tune based on real router input sizes.
- Continuity heuristic (§9.15) "skip router when message < 200 tokens and no @" is a guess. Tune based on how often the heuristic-skipped turn would have been re-routed.
- Thinking budget numbers `high=16k, max=64k` (§9.16) are starting guesses for Anthropic. Tune per model and per real workload.
