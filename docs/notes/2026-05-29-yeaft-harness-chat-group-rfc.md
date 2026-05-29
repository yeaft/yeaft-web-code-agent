# RFC PR0: Yeaft Harness Chat + Group Refactor

Status: Draft for architecture review  
Owner: Linus  
Date: 2026-05-29  
Scope: Documentation only

## Goal

Define the model boundaries and storage contract before any implementation work starts. PR0 exists to make the terminology, persistence source of truth, project `.yeaft` root rule, path safety, scope isolation, workspace switching, and feature flag granularity explicit enough for PR1 to be only a provider shell and alias layer.

PR0 does not implement runtime behavior.

## Non-goals for PR0

- No code changes.
- No physical `agent/unify` rename.
- No PR1 provider shell implementation.
- No persistence implementation.
- No Group history, pagination, or auto-load implementation.
- No behavior rewrite of old Unify.

## Staged plan

### PR0: RFC only

This PR documents decisions, open questions, and architecture gates. It must settle enough vocabulary and contracts for reviewers to reject later work that mixes model dimensions or hides persistence assumptions.

### PR1: provider shell + alias only

Allowed after PR0 review resolves the blocking questions:

- Add Yeaft Chat as an alias/successor surface for old Unify.
- Reuse the existing engine via a new session wrapper.
- Add feature flags across agent, server, and web.
- Do not physically rename `agent/unify`.
- Do not fork `Engine.query()`.
- Do not implement Group history, pagination, or auto-load.

### Phase 2+

Blocked until PR0 and PR1 settle model boundaries and the storage contract. This includes persistence implementation, project `.yeaft` workspace behavior, Group session acceptance, and late cleanup/rename work.

## Terminology and model boundaries

Decision: keep provider/runtime family and surface/session type as separate dimensions with concrete PR1 field names.

PR1 contract:

- `runtimeFamily` is the provider/runtime dimension. It is owned by agent/server routing and answers what runs the model and tools.
- `surfaceType` is the user-facing session-shape dimension. It is owned by session creation, web routing, and UI state.
- These fields must be carried separately anywhere PR1 needs to describe a Yeaft Chat session. A single overloaded `mode` enum is not acceptable.

Allowed initial `runtimeFamily` values:

- `claude-code`: Claude CLI/runtime-backed execution.
- `yeaft`: Yeaft engine/runtime-backed execution.

Allowed initial `surfaceType` values:

- `chat`: one user-facing conversation.
- `crew`: coordinated role/team collaboration.
- `group`: multi-VP group conversation.

The values are lowercase wire contracts. UI labels may render them as `Claude Code`, `Yeaft`, `Chat`, `Crew`, and `Group`, but persisted records and message payloads should use the lowercase values above unless a later migration RFC changes them.

These dimensions must not collapse into one enum. For example, `runtimeFamily: "yeaft"` with `surfaceType: "chat"` is not the same kind of value as `runtimeFamily: "claude-code"` with `surfaceType: "chat"`; the first field chooses the runtime family and the second chooses the session surface.

## Yeaft Chat semantics

Decision: Yeaft Chat initially means the single-user successor/alias of old Unify. It is not a behavior rewrite.

Allowed semantic behavior in PR1:

- Existing old-Unify behavior remains the baseline.
- Yeaft Chat can present clearer naming and routing as an alias/successor.
- Any semantic delta must be documented before implementation.

Minimum compatibility checklist for PR1:

- Reuse `Engine.query()` through the wrapper; do not fork the engine loop.
- Preserve memory recall and write behavior, including pre-turn recall, post-turn memory adjustment, and background maintenance triggers.
- Preserve tool filtering semantics and chat/work capability boundaries unless a delta is explicitly documented and feature-gated.
- Preserve message rendering compatibility with the existing web bridge and `claude_output`/`unify_output` rendering pipeline.
- Preserve session lifecycle behavior for session creation, readiness, turn execution, cancellation/error reporting, and clearing/resetting the Yeaft Chat session.
- Preserve conversation persistence semantics; PR1 must not silently change what is written, skipped, summarized, or replayed.

Not allowed in PR1:

- Silent changes to memory behavior.
- Silent changes to tool availability.
- Silent changes to conversation persistence.
- Silent changes to UI/session semantics beyond aliasing and feature-gated shell wiring.

## Alias-first rule

Decision: PR0 and PR1 must not physically rename `agent/unify`.

PR1 may add alias/export/wrapper modules that make the Yeaft Chat name visible at the edges, but the old `agent/unify` directory remains in place. A physical rename is only allowed in a late cleanup/rename PR after compatibility, storage, and rollout concerns are settled.

Reason: a physical rename creates churn and makes it harder to review real behavior changes. The first step should prove the model boundary, not move files around.

## Engine boundary

Decision: Yeaft Chat must reuse `Engine.query()` through a new session wrapper.

`Engine.query()` stays the engine loop. It must not learn about:

- WebSocket message names.
- UI component state.
- Project root selection.
- Browser routing.
- Group history pagination.

The wrapper owns session concerns and translates surface-specific input into engine calls. The engine remains reusable by Chat, Group, worker, coordinator, and maintenance contexts.

PR1 acceptance gate: no forked engine loop and no WS/UI/project-root concerns inside `Engine`.

## Persistence source of truth

Decision: prefer a JSONL append-only event/message log as canonical persistence.

Markdown may remain as export, debug, or human-readable projection. Markdown should not be canonical unless the RFC explicitly specifies all of the following:

- Stable ids.
- Metadata schema.
- Cursor semantics.
- Atomic write strategy.
- Migration plan.
- Corruption detection and recovery.

### Preferred JSONL contract

The canonical log should be append-only and machine-readable. A future persistence PR should define the exact schema, but PR0 sets these minimum requirements:

- Every record has a stable id.
- Every record has a session id and scope identity.
- Every record has an ordered cursor or monotonic sequence.
- Every record has a timestamp.
- Every record has a type, for example `message`, `tool_call`, `tool_result`, `summary`, or `checkpoint`.
- Writes are append-only and recoverable after partial failure.
- Readers can page by cursor without reparsing a lossy projection.

Open question for PR0 review: whether the canonical log is one file per session, one file per scope, or another layout. This is blocked on the project `.yeaft` root rule and workspace switching semantics.

## Project `.yeaft` root rule

Architecture rule: no persistence implementation may start until it follows this root-selection contract.

Project-scoped Yeaft Chat/Group data must live under the selected project root `.yeaft/`, not under an ambiguous cwd. User-global configuration can remain under `~/.yeaft/`, but project conversation/session data needs a deterministic project root.

Root-selection contract for PR1+:

- Session creation may include an explicit `projectRoot` selected by the web client/workspace UI.
- The agent must canonicalize `projectRoot` with realpath/path resolution and validate it against an allowed workspace root or the detected git worktree root.
- If no explicit `projectRoot` is provided, the agent may derive the root from the active workspace/git worktree root. It must not use raw process cwd as persistent storage authority.
- If there is no git root and no explicit valid workspace root, project-scoped persistence must fail closed: run without project persistence or return an explicit error, but do not write to an inferred arbitrary directory.
- Each session is pinned to the validated root at creation time. Workspace switching creates or selects another session; it must not move the storage root under an active session.
- Multiple browser tabs may point at different workspaces only if each tab/session carries its own validated root and the agent keeps their storage isolated.
- Every write under project `.yeaft/` must re-check that the resolved target path remains inside the pinned root.

## Path safety, scope isolation, and workspace switching

Blocking RFC item: path and scope behavior must be specified before persistence implementation.

Minimum safety rules:

- Resolve storage paths against the pinned project `.yeaft` root selected at session creation.
- Reject path traversal outside the selected root.
- Do not use user-provided ids directly as path segments without normalization.
- Normalize ids to a restricted safe alphabet before using them in paths; reject empty, reserved, absolute, `.`/`..`, or separator-containing ids.
- Isolate scopes such as user, VP, group, feature, and session.
- Keep Group session storage separate from single-user Chat storage.
- Treat workspace switching as session switching. It must not mutate the root of an active session.

## Feature flag granularity

Decision: use one shared top-level feature flag plus negotiated capabilities. A UI-only flag is not sufficient.

PR1 feature contract:

- Shared flag name: `yeaftChat`.
- Agent: when `yeaftChat` is disabled, Yeaft Chat wrapper/session entrypoints are not registered and incoming Yeaft Chat requests are rejected with an explicit disabled-feature error.
- Server: when `yeaftChat` is disabled, Yeaft Chat messages are not accepted or relayed; the server returns an explicit disabled-feature error.
- Web: the UI may show Yeaft Chat affordances only when the server/agent capability response reports `yeaftChat: true`.
- Capability negotiation is authoritative at runtime. Static config may request the feature, but the web must fail closed unless both server and agent report support.
- If capabilities change or negotiation fails, the feature is treated as disabled and the error path must be visible to the user.

## Group history, pagination, and auto-load

Decision: Group history, pagination, and auto-load are not PR1 scope.

They belong to Group session acceptance after the Yeaft Chat wrapper stabilizes. Bundling them into PR1 would mix three separate problems: naming, persistence, and Group UX/session loading.

PR1 may leave existing Group behavior unchanged except for feature-gated wiring that is necessary for the alias shell. Any Group history work must wait for the canonical persistence contract and project root rule.

## Ada review points captured

The RFC must preserve the concerns raised by Ada as explicit review items:

- Separate runtime/provider family from surface/session type.
- Avoid physical renames before compatibility and rollout boundaries are stable.
- Keep `Engine.query()` as the shared engine loop and put surface-specific behavior in wrappers.
- Treat storage contract as an architecture boundary, not as an incidental file format choice.
- Block project persistence until project root selection, path safety, and workspace switching are specified.
- Require feature flags through the full path from web to server to agent.

Open question for Ada/Martin review: whether the wrapper boundary should be documented as an interface contract in PR0, or deferred to PR1 where code can make it concrete.

## Linus review points captured

My review bar for this refactor:

- Do not make one giant `mode` enum that means runtime, UI surface, storage scope, and behavior all at once. That is how bugs breed.
- Do not fork the engine loop. If `Engine.query()` is wrong, fix it once; if a surface needs adaptation, write a wrapper.
- Do not rename directories as a substitute for architecture. Aliases first, cleanup later.
- Do not use markdown as a database unless the RFC owns the hard parts: ids, metadata, cursors, atomicity, migrations, and corruption.
- Do not let cwd decide persistent storage by accident. Pick a root, validate it, and pin sessions to it.
- Do not ship a UI flag that sends messages to a server/agent path that is not also gated.

Open question for Martin review: which of these should become hard PR1 acceptance checks versus later Phase 2 checks?

## PR1 acceptance checklist proposed by PR0

PR1 should not merge unless:

- Runtime family and surface/session type remain separate fields: `runtimeFamily` and `surfaceType`.
- Yeaft Chat is an alias/successor shell for old Unify behavior and satisfies the minimum compatibility checklist.
- No physical `agent/unify` rename occurs.
- `Engine.query()` is reused through a wrapper.
- Engine does not gain WS/UI/project-root concerns.
- `yeaftChat` feature flagging and capability negotiation exist across agent, server, and web.
- No canonical persistence implementation starts before JSONL/root/path-safety rules are implemented.
- Group history, pagination, and auto-load are not included.

## Resolved PR1 contracts from architecture review

1. Runtime family and surface/session type are represented by separate fields: `runtimeFamily` and `surfaceType`.
2. Yeaft Chat PR1 must satisfy the minimum old-Unify compatibility checklist in this RFC.
3. JSONL append-only log is the preferred canonical persistence direction for future persistence work; markdown may only be a projection/export/debug format unless it explicitly owns ids, metadata, cursors, atomicity, migrations, and corruption recovery.
4. Project `.yeaft` storage is rooted at the validated explicit `projectRoot` or agent-derived workspace/git root, never raw cwd.
5. Sessions are pinned to a workspace root at creation time; workspace switching means session switching.
6. Ids used in paths must be normalized to a safe alphabet and path traversal must fail closed.
7. Feature gating uses one shared `yeaftChat` flag plus runtime capability negotiation across web, server, and agent.
8. The PR1 review checklist is the acceptance checklist above; any deviation must be explicitly documented before implementation.

## Review request

Martin should review PR0 against these gates:

1. Provider/runtime family and surface/session type remain separate dimensions: Claude Code vs Yeaft; Chat/Crew/Group.
2. Yeaft Chat starts as the single-user successor/alias of old Unify, not a behavior rewrite.
3. Alias-first is mandatory; no physical `agent/unify` rename in PR0/PR1.
4. `Engine.query()` is reused through a session wrapper; Engine does not learn WS/UI/project-root concerns.
5. JSONL append-only log is the preferred canonical persistence contract; Markdown is export/debug unless fully specified as canonical.
6. Project `.yeaft` root selection, path safety, scope isolation, and workspace switching are blocking RFC items.
7. Feature flag spans agent/server/web.
8. Group history/pagination/auto-load is not PR1 scope.
