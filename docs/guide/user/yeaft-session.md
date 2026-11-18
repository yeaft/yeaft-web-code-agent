# Yeaft Sessions and Projects

A **Session** is one durable conversation with a single timeline. Its scene guides how the assistant works without changing its identity or splitting the conversation.

## Session contents

A Session stores and exposes:

- an Agent owner and stable Session ID;
- a name, working directory, announcement, and creation/activity metadata;
- the current scene (legacy roles are retained for compatibility);
- an optional Session-level model and reasoning-effort override;
- durable messages and turns, tool results, background task state, and debug traces;
- historical data retained under the Session scope.

Session metadata and history live under the owning Agent's Yeaft directory. `workDir` is execution context and the root for project-tier instructions, Skills, and MCP discovery; it is not the Session data directory.

## Sidebar display preferences

Project folders and the Projects/Recents sections remember their expanded or collapsed state per user on the Server, alongside shortcut layout and section height ratio. Reloading, signing in again, focusing the window, or making the page visible reads the latest preferences; changes are not pushed live to other windows. Folders are saved separately by stable Project ID, so renaming a folder does not reset it and changes to different folders on separate clients do not overwrite each other. Failed saves show a message and restore confirmed state rather than appearing synchronized.

Legacy browser-local section state is not imported into user preferences. The initial default is expanded; subsequent visits use Server-saved state.

## Create a Session

1. Choose **New chat** in the unified sidebar and select **Yeaft** as the runtime.
2. Select the Agent that owns the working directory.
3. Set a Session name and working directory.
4. Choose **General**, **Software**, **Writing**, **Short video**, or **Investment**. The default is General.
5. Create the Session.
6. After creation, choose model/effort in the composer and edit the announcement in Session settings, then send a message.

模型与推理强度选择会立即预览，并等待 Agent 确认保存；保存失败会恢复已确认值并提示。连续切换按 Session 顺序应用，其他 Session 不受影响；若立即发送消息，会先等待所选模型确认，不会悄悄使用旧模型。切换模型时优先默认使用 `xhigh`，没有此档位时只从该模型支持的档位选择；已保存的 Session 强度不会被刷新覆盖。运行中的请求不被中断，新设置从下一次模型请求开始使用。

### Change the scene during a conversation

Use **Scene** next to **Attach**. It saves to this Session without sending a message. The scene applies to new turns; running turns continue unchanged. For example, switch from Software to Writing to turn an earlier design discussion into an announcement without starting over. A scene guides the work, not which questions you may ask. It does not change model, effort, permissions, or workspace.

The request determines the deliverable. For example, Software distinguishes a diagnosis from a request to change code; Writing distinguishes proofreading from a rewrite. Short video fits a script to the time and crew available. Investment compares results on a consistent basis and calls out missing data that could change the conclusion. General can recommend an option and say when a different one makes sense. In any scene you can ask for just the result, without a report.

### Compatibility with existing Sessions

Existing Sessions keep their complete messages, membership, and custom definitions. Until you choose a scene, they continue to use their existing routing; settings such as title or model do not convert the Session. Choose a scene explicitly to use the single-assistant workflow on future messages. Saved role IDs are not deleted, but they no longer route messages in that Session. Legacy role settings are under **Compatibility**; replies in scene Sessions do not display role names. Existing scheduled tasks retain their configured targeting. Scene switching requires an updated Agent.

## Fork the current Session

Choose **Copy session** from the active Session’s sidebar menu, or the copy icon at the top right of the conversation. No setup dialog is needed: the new Session opens automatically on the same Agent.

The fork copies the complete persisted conversation, announcement, working directory, and Session scene/model/effort settings (and legacy roster, if applicable). If the source belongs to a Project, the Server puts the fork in the same Project, so the shared instruction continues to apply. The source remains unchanged; later conversation and Session setting changes are independent.

A supporting Agent can fork while responding: the new Session contains the complete durable history before the active input, excluding that input and its response or tools, without stopping the source. The safe boundary is checkpointed in the Session’s instance data directory, so task-result replies resumed after an Agent restart can still fork earlier history. For legacy tasks without a checkpoint, recovery requires a verified original human input; otherwise the copy fails explicitly rather than cloning a partial turn. Overlapping inputs or parallel VPs use the safe prefix before the earliest active input. Older Agents still require the response to finish. Forking is unavailable while disconnected or another fork is pending. Background processes, running tasks, debug traces, and Session memory files are not cloned. Available uploaded attachments are copied into the new Session’s own storage; missing or inaccessible legacy files remain explicitly unavailable. Both Server and Agent must support Project inheritance for this behavior.

Choose **Fork from this turn** below a completed AI response to copy the chronological history prefix through that turn, inclusive, without later messages. The new Session inherits the same configuration and Project; the source is never truncated or changed. This requires a supporting Agent. Older responses without a reliable turn ID have no action; ambiguous boundaries or boundaries that split a tool call/result are rejected rather than falling back to a full copy. With parallel VPs, persisted message order is authoritative, so other VP messages before the boundary are included.

Legacy duplicate message IDs do not block a full fork. Every durable record receives a new unique ID and sequence in original append order, without changing the source or deduplicating equal text or timestamps. References are remapped only when their target is uniquely identifiable; ambiguous references are retained in the target row’s `unresolvedMessageReferences` metadata instead of guessing links or hiding the wrong messages. Quoted text and tool call/result pairs remain intact. A message-specific boundary identified only by a duplicated old ID is still rejected; full copies and reliable turn/snapshot boundaries remain supported.

## Merge two Sessions

Choose **Merge Sessions** from the Session's sidebar menu, then select another native Session on the same Agent. The conversation header keeps **Fork Session** but does not show Merge. Both Sessions must be idle and the Agent must support merging.

Merging opens a new Session and leaves both sources unchanged. The new Session inherits the initiating source's working directory, announcement, scene, model settings and Project. Legacy roster data is also retained. Shared history is retained once; remaining whole request turns are ordered by the user's sent time. Without shared history, all turns are time-ordered. Identical prompt text alone is never treated as shared history; ambiguous divergence is rejected rather than guessed. Tool calls and results stay together.

Attachments are verified and copied into the new Session's storage. Conflicting shared attachment bytes or entirely unavailable copies cause an explicit failure, not silent loss. This does not merge Git files or migrate running tasks. Project ownership remains Server-authoritative.

Forks and merged Sessions continue from canonical text and tool history, not provider-private signatures or reasoning continuation bound to a source Session. Source transcripts remain intact. Historical **Fork from this turn** also works while a later response is running, provided the selected endpoint precedes the active input; the current response has no fork action.

## Legacy routing

Only Sessions that have not opted into a scene use the following routing. A message without mentions goes to the default VP. Use `@VPName` to address a subset:

```text
@Linus Implement the smallest safe fix and add focused tests.
```

```text
@Martin Review the current diff for correctness, regression risk, and missing tests.
```

```text
@Linus @Martin Compare the implementation and review perspectives in parallel.
```

When several VPs are selected, Yeaft persists one canonical user message and fans the turn out to independent VP engines. Each VP has its own persona and memory view, streams its own response, and uses the current Session's allowed tools. Historical attribution remains in the underlying records.

## Parallel turns

原生 Session 正在执行时仍可使用同一个输入框发送消息。AI 根据正在执行的 turn 判断新输入是补充还是独立请求：补充在目标 turn 下一次 loop 读取，独立请求并行执行，同一会话也能同时处理多个 turn；切换场景后发出的消息不会追加到旧场景的 turn。没有 turn 执行时保持普通对话行为。

两个以上 turn 执行时，历史下方自动展开横向分裂区；根据聊天区域宽度显示一到三栏。通过顶部短摘录 tab 或横向滚动查看其他 turn。每个 turn 可独立停止，完成、停止或失败后回到按原始提问时间排列的单列历史；输入框始终只有一个。刷新或切换 Session 后，运行状态和消息归属由所属 Agent 恢复。旧版 Agent 缺少新字段时保持单列展示，需要同步更新 Agent、Server 和 Web 才能使用完整能力。

新执行可读取 Session 有界历史和其他未结束执行已公开的输入／正文，后续 loop 接收增量参考，不共享 thinking 或 provider 私有续接状态。并行仍使用同一个工作目录，不自动隔离文件写入；同时修改代码时应明确分工或使用独立 worktree。

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
- an optional debug panel for provider requests, tools, tokens, and stop reasons. Dream events and settings are not exposed.

Debug output can contain project text and tool results. It is for the current owner and should not be exported or shared casually.

### Images in responses

Tool images appear as compact thumbnails between response text segments. Click to enlarge and browse the other images in that response. Newly generated Yeaft images stay anchored to their source tool even when the upload finishes after later text or history is reloaded. Older images without source metadata retain their existing position rather than guessing which text they belong to.

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

A Project does not merge Session transcripts or storage. It supplies Project instructions to members, but the current runtime does not recall or inject sibling Session summaries.

## Memory boundaries

Dream/H2-AMS memory is retired from the active runtime:

- native turns use only the bounded history window selected from the current Session transcript;
- legacy memory files and indexes remain on disk but are not read, migrated, synchronized, recalled, or injected;
- historical messages and ordinary debug records are retained;
- post-turn compact remains a separate history-window feature.

Legacy enable/manual Dream commands report that the feature is disabled. There is no Dream debug tab or settings control.

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
- [Retired H2-AMS implementation](../tech/yeaft-memory.md)

## Images and model vision

Native Yeaft Sessions send supported image attachments directly to vision models with the user message; `ViewImage` is not required. Follow-up turns and restored Sessions reload selected historical images from this instance’s Session-scoped files. Missing files or budget-omitted images are marked explicitly; a visible thumbnail does not mean the model still has the image. `ViewImage` reads local files and returns native multimodal tool input, without requiring cropping or OCR first. New attachments live under the instance’s Session data root, independently of the Agent launch directory.
