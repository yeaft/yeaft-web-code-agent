# Yeaft Sessions and Projects

A **Session** is the native Yeaft engine's only conversation and collaboration unit. It always has the same shape: one durable timeline and a roster of 1..N VPs. One VP gives you a focused code agent; several VPs let you direct the same turn to independent roles.

![A multi-VP Session with an implementation and review handoff](/images/session.png)

## Session contents

A Session stores and exposes:

- an Agent owner and stable Session ID;
- a name, working directory, announcement, and creation/activity metadata;
- a VP roster and default VP;
- an optional Session-level model and reasoning-effort override;
- durable messages, per-VP turns, tool results, background task state, and debug traces;
- Session-scoped and nested VP/user memory.

Session metadata and history live under the owning Agent's Yeaft directory. `workDir` is execution context and the root for project-tier instructions, Skills, and MCP discovery; it is not the Session data directory.

## Create a Session

1. Choose **New chat** in the unified sidebar and select **Yeaft** as the runtime.
2. Select the Agent that owns the working directory.
3. Set a Session name and working directory.
4. Choose one or more VPs and a default VP.
5. Create the Session.
6. After creation, choose model/effort in the composer and edit the announcement in Session settings, then send a message.

When the roster is omitted and the Agent's VP library contains `omni`, the runtime can use **Omni**, the all-purpose assistant (Chinese name: **全能助手**), as the default generalist. Its internal ID remains `omni`, so existing references keep working. An explicitly non-empty roster is never silently replaced.

The assistant helps with questions, research, writing, translation, learning, planning, data analysis, and coding tasks—not just clarification or handoffs. It chooses direct answers, tools, or collaboration to suit the task while respecting project ownership and authorization. At Agent startup, exact historical stock souls and their matching old name, role, and description are upgraded; user-edited souls and custom metadata are preserved.

## Route a turn

A message without mentions goes to the default VP. Use `@VPName` to address a subset:

```text
@Linus Implement the smallest safe fix and add focused tests.
```

```text
@Martin Review the current diff for correctness, regression risk, and missing tests.
```

```text
@Linus @Martin Compare the implementation and review perspectives in parallel.
```

When several VPs are selected, Yeaft persists one canonical user message and fans the turn out to independent VP engines. Each VP has its own persona and memory view, streams its own response, and uses the current Session's allowed tools. The shared timeline keeps speaker identity visible.

## Planning and progress

The native engine no longer provides `TodoWrite` or `StartPlan`. It does not require repeated checklist updates or an extra planning-tool call just to display progress. Neither the tool registry nor `DiscoverTools` exposes these tools.

You can still ask a VP to “investigate and propose an approach without changing code,” using ordinary replies to discuss goals, constraints, risks, and validation. There is currently no dedicated Plan Mode switch; a conversational request is not a read-only filesystem sandbox.

Existing Session checklists remain replayable, and Claude Code / Copilot CLI tool behavior is unchanged. Use [Work Center](./work-center.md) for durable cross-turn execution state and acceptance checks. Custom Project instructions, VP souls, and `planInstruction` data are not rewritten automatically; update any custom instructions that still require the retired tools.

## Handoffs and sub-agents

Multi-VP collaboration is explicit:

- `RouteForward` sends a message to another VP in the same Session and records the route in the visible VP turn.
- Sub-agents are child workers created by a VP for bounded parallel research, implementation, review, or exploration.
- Background shell jobs and sub-agents have persistent Session-scoped task records; the parent can list, inspect, cancel, or consume their terminal result.

A text `@mention` written by a VP is not a runtime handoff. VP-to-VP transfer must use `RouteForward`.

## Session history and status

The Yeaft page provides:

- a paged, virtualized conversation timeline;
- history outline and text/speaker search;
- per-VP turn blocks and message quote/edit-as-new actions;
- Session status with announcement, roster, and active background tasks;
- model/effort selection in the composer;
- an optional debug panel for provider requests, memory recall, tools, tokens, and stop reasons.

Debug output can contain project text and tool results. It is for the current owner and should not be exported or shared casually.

### Answer AskUser questions

A VP's `AskUser` call appears as an interactive card. You can switch Sessions and return to answer while the request remains active on the Agent.

- Submitting shows “Waiting for Agent confirmation,” not success. The success summary appears only after an Agent acknowledgement or persisted answer history arrives.
- If confirmation has not arrived after 15 seconds, check the connection and use **Resend answer**. A resend retains the original question identity and does not complete the same question twice.
- An unavailable Agent produces a retryable notice. If the question expired, execution was cancelled, or an Agent restart lost the waiting request, ask the VP to pose the question again. Resending does not revive an ended turn.

## Organize Sessions with Projects

Projects are user-visible groups in the unified sidebar. You can:

- create, rename, and delete a Project;
- drag native Yeaft Sessions between a Project and **Recents**;
- reorder Sessions without losing cross-Agent identity;
- attach one Project instruction to the Project.

A Project does not merge Session transcripts or storage. For a Session running on an Agent, Yeaft can add same-Agent sibling Session IDs to its scoped recall set and inject read-only summaries with their source Session identity. Sessions on another Agent are still visible in the browser catalog but are not treated as local memory scopes by the current runtime.

## Memory boundaries

Native memory is scoped rather than globally shared:

- user scope for durable user preferences;
- VP scope and Session-nested VP scope for role-specific knowledge;
- Session scope for shared facts in the current collaboration;
- related Project-Session scopes for bounded sibling recall;
- topic and legacy compatibility scopes where current storage readers support them.

H2-AMS renders one budgeted memory block from resident summaries, recent context, and on-demand full-text hits. Dream maintenance updates segments and summaries in the background. Retrieved memory is context, not a higher-priority instruction.

## Move durable work to Work Center

Use **Create WorkItem** from the Session composer when the goal needs role handoffs, waiting, retry, review, or execution beyond the current turn. The runtime stamps the source Session identity and creates an Agent-level WorkItem; Work Center then owns its contract, Coordinator conversation, Action graph, Runs, and recovery.

See [Work Center](./work-center.md).

## Boundaries to remember

- Yeaft has Sessions, not separate native chat/group modes.
- A VP model setting is currently a `primary` or `fast` hint; the Session can override an exact provider/model and effort.
- The native tool registry is shared by the engine and filtered by policy; tool availability is not a separate mode switch.
- Projects organize and provide bounded context. They are not repositories, worktrees, or a second memory owner.
- Work Center is Agent-level durable execution, not another Session.

## Related pages

- [Choose a code agent path](./choose-backend.md)
- [Provider and model configuration](../yeaft-config.md)
- [Yeaft engine internals](../tech/yeaft-engine.md)
- [H2-AMS memory](../tech/yeaft-memory.md)
