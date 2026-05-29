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

Decision: keep provider/runtime family and surface/session type as separate dimensions.

Provider/runtime family answers what runs the model and tools:

- Claude Code: Claude CLI/runtime-backed execution.
- Yeaft: Yeaft engine/runtime-backed execution.

Surface/session type answers what user-facing session shape is active:

- Chat: one user-facing conversation.
- Crew: coordinated role/team collaboration.
- Group: multi-VP group conversation.

These dimensions must not collapse into one enum. For example, `Yeaft + Chat` is not the same kind of value as `Claude Code + Chat`; the first dimension chooses the runtime family and the second chooses the session surface.

Open question for PR0 review: should the code eventually use two explicit fields such as `runtimeFamily` and `surfaceType`, or different names? The names are less important than preventing a single overloaded mode enum.

## Yeaft Chat semantics

Decision: Yeaft Chat initially means the single-user successor/alias of old Unify. It is not a behavior rewrite.

Allowed semantic behavior in PR1:

- Existing old-Unify behavior remains the baseline.
- Yeaft Chat can present clearer naming and routing as an alias/successor.
- Any semantic delta must be documented before implementation.

Not allowed in PR1:

- Silent changes to memory behavior.
- Silent changes to tool availability.
- Silent changes to conversation persistence.
- Silent changes to UI/session semantics beyond aliasing and feature-gated shell wiring.

Open question for PR0 review: list the exact old-Unify behaviors that become contractual compatibility requirements for Yeaft Chat PR1. At minimum this should cover `Engine.query()` reuse, memory recall/write behavior, tool filtering, message rendering expectations, and session lifecycle.

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

Blocking RFC item: no persistence implementation until root selection is specified.

The project `.yeaft` root rule must answer:

- How the active project root is selected.
- Whether root selection follows the git worktree root, process cwd, explicit config, or a user-selected workspace.
- How workspace switching changes active storage.
- What happens when there is no git root.
- Whether multiple browser tabs can point at different workspaces.
- How the runtime prevents writes outside the selected root.

Recommended default for review: storage for project-scoped Yeaft Chat/Group data should live under the selected project root `.yeaft/`, not under an ambiguous cwd. User-global configuration can remain under `~/.yeaft/`, but project conversation/session data needs a deterministic project root.

Open question for PR0 review: whether project root selection should be explicit in the session creation message, derived by the agent, or both with validation.

## Path safety, scope isolation, and workspace switching

Blocking RFC item: path and scope behavior must be specified before persistence implementation.

Minimum safety rules:

- Resolve storage paths against the selected project `.yeaft` root.
- Reject path traversal outside the selected root.
- Do not use user-provided ids directly as path segments without normalization.
- Isolate scopes such as user, VP, group, feature, and session.
- Keep Group session storage separate from single-user Chat storage.
- Define behavior when the workspace switches during an active session.

Open question for PR0 review: whether active sessions should be pinned to the workspace selected at session creation. My default answer is yes. Changing workspaces mid-session should create or switch to a different session rather than moving the storage root underneath a running engine turn.

## Feature flag granularity

Decision: the feature flag must span agent, server, and web. A UI-only flag is not sufficient.

PR1 should define feature-gated behavior at each layer:

- Agent: whether Yeaft Chat wrapper/session entrypoints are registered.
- Server: whether Yeaft Chat messages are accepted and relayed.
- Web: whether Yeaft Chat UI affordances are visible and usable.

Feature flags must fail closed. If server or agent support is disabled, the web UI should not pretend the feature is available. If web enables a control but server rejects the message, the error path must be explicit.

Open question for PR0 review: whether this is one shared flag name across all layers or layer-specific flags with a negotiated capability response. My preference is one top-level feature plus explicit capability reporting from agent/server to web.

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

- Runtime family and surface/session type remain separate concepts.
- Yeaft Chat is an alias/successor shell for old Unify behavior.
- No physical `agent/unify` rename occurs.
- `Engine.query()` is reused through a wrapper.
- Engine does not gain WS/UI/project-root concerns.
- Feature flagging exists across agent, server, and web.
- No canonical persistence implementation starts before JSONL/root/path-safety questions are resolved.
- Group history, pagination, and auto-load are not included.

## Blocking questions before PR1 starts

1. What exact field names represent runtime family and surface/session type?
2. What old-Unify behaviors are contractual for Yeaft Chat alias compatibility?
3. Is JSONL append-only log accepted as canonical persistence?
4. What is the selected project `.yeaft` root algorithm?
5. Are sessions pinned to a workspace root at creation time?
6. What id normalization and path traversal rules are required for scope isolation?
7. Is feature gating one shared flag with capabilities, or separate layer flags?
8. What exact PR1 review checklist will Martin enforce?

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
