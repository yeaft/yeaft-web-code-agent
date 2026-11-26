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

Folders, including subfolders, remember their expanded or collapsed state per user on the Server, alongside the shortcut layout. Reloading, signing in again, focusing the window, or making the page visible reads the latest preferences; changes are not pushed live to other windows. Folders are saved separately by stable Project ID, so renaming a folder does not reset it and changes to different folders on separate clients do not overwrite each other. Failed saves show a message and restore confirmed state rather than appearing synchronized. When a page opens, the list shows its loading row until the saved state arrives, so folders appear open or closed as saved instead of opening and then closing. If that state has not arrived within 5 seconds, folders show expanded with a **Retry** message.

Legacy browser-local section state is not imported into user preferences. The initial default is expanded; subsequent visits use Server-saved state.

刷新 Yeaft 对话页时，浏览器优先恢复上次查看的会话，按 Agent 和 Session ID 精确匹配。后台任务的运行状态只更新侧栏，不会切换打开的对话。原会话暂时不可用时，页面会保留恢复记录；可以等它恢复、重试加载，或从侧栏主动打开另一条会话。

## 搜索会话与分享

- **搜索会话**：点数字人前面的放大镜，在快捷操作下方的搜索框输入关键词。支持搜索的在线 Agent 会一起查，结果直接列在原会话列表的位置；清空恢复目录树，按 Esc 收起。Agent 首次上线后在后台建索引，此后每天最多刷新一次，不调用模型。只索引过去 5 天有可见对话、且可见消息超过 3 条的原生 Yeaft Session；支持中英文关键词，结果可直接打开会话。新消息不必然立即可搜到，隐藏会话不在侧栏搜索结果中。5 天以前的历史不会因离开索引而删除。
- **跨会话历史**：可以说“查一下这台 Agent 上我其他会话里关于版本发布的讨论”。`HistorySearch` 默认仍只查当前 Session；跨会话查询按需读取同账号、同 Agent 的历史，不受 5 天限制，返回带来源的片段，受扫描和输出上限约束。不会自动把其他会话的内容放进新对话。
- **内置 Share**：不占侧栏，也不用手动发布。每日索引从最近对话中保存用户明确写下的长期约定，例如“长期约定：客户通知优先写结论”，不会把助手提议或项目文件改动当作共识，也不会为此调用模型。想用时直接问“查一下关于客户通知的长期约定”或“找一下分享区的调研报告”。`HistorySearch` 按需查询本账号在这台 Agent 上的自动共识和已保存的分享成果，不自动加入每轮上下文。自动共识不会因来源会话超过 5 天而过期，但来源被删除或清空后不再返回。以前保存的 Share 条目保持原样，可在「设置 → 通用 → 已保存的分享」移除；项目文件仍留在自己的工作目录。

以上功能需要更新后的 Web、Server 和 Agent；经典侧栏及其他 Chat 提供方的使用方式不变。

## Create a Session

1. Choose **New chat** in the unified sidebar and select **Yeaft** as the runtime.
2. Select the Agent that owns the working directory.
3. Set a Session name and working directory.
4. Choose a scene: **General**, **Software**, **Frontend**, **Writing**, **Content creation**, **Video editing**, **Primary education**, or **Investment**. The default is General.
5. Create the Session.
6. After creation, choose model/effort in the composer and edit the announcement in Session settings, then send a message.

模型与推理强度选择会立即预览，并等待 Agent 确认保存；保存失败会恢复已确认值并提示。连续切换按 Session 顺序应用，其他 Session 不受影响；若立即发送消息，会先等待所选模型确认，不会悄悄使用旧模型。切换模型时优先默认使用 `xhigh`，没有此档位时只从该模型支持的档位选择；已保存的 Session 强度不会被刷新覆盖。运行中的请求不被中断，新设置从下一次模型请求开始使用。

### Supplement a running turn from the Cosmos quick composer

After Auto Router chooses a Session, it uses the same rules as sending from inside that Session. A related follow-up enters the current turn at the next model call, without interrupting an in-flight call or tool. Unrelated requests and explicit one-message model or effort overrides use a separate turn. Simply displaying the default model does not count as an override.

The Agent confirms the send after accepting it into a running turn or queuing a separate turn. Choosing a Session alone does not confirm delivery.

### Change the scene during a conversation

If the page cannot confirm a scene change, refresh to check what the Agent saved before trying again. The page does not repeat the change or send a message waiting on it.

Open the scene menu next to **Attach** in the bottom-left of the composer. On phones, if the toolbar cannot fit on one row, use **+ → Choose scene** (or **+ → Add attachment** for a file). The current scene is checked. Changing it saves to this Session without sending a message. The scene applies to new turns; running turns continue unchanged. For example, switch from Software to Writing to turn an earlier design discussion into an announcement without starting over. A scene guides the work, not which questions you may ask. It does not change model, effort, permissions, or workspace.

Each scene brings the working standards of its field. Software thinks like a principal engineer across product, design, security, testing, data migrations and operations. Frontend works like an art director, interaction designer and frontend engineer: interfaces people like at first sight and find easy to use. For a new product it first sets a clear visual direction so the result doesn't look like a template; in an existing product or brand it stays within the design system and raises the finish; it checks the result with screenshots in a real browser at phone and desktop widths. Writing works like an editor, fact-checker and copy chief, following style guides such as Chicago or GB/T 15834. Content creation covers positioning, topics, Xiaohongshu-style image posts, short-video scripts and shooting, operations, data, commerce and platform rules. Video editing works like a film editor, sound mixer and colorist, from story and cutting to loudness, color and delivery to each platform's spec; when the files are on the Agent's machine and ffmpeg is installed, it can inspect and process them directly. Primary education works like an experienced primary teacher of Chinese, math and English: it guides a child step by step instead of handing over answers, and gives parents and teachers the answer, the likely misconception and how to teach it. Investment works like a buy-side analyst and risk manager under the CFA Institute’s standards. General holds specialist questions, such as health, law or safety, to that profession’s standard of care.

The assistant checks the whole field but raises only what matters to your request. When you ask what to do or which option is better, it recommends one and says why instead of listing conditions. Ask Software how drafts should reopen on another device, and it considers an unsaved edit open on both devices; ask it to change one word, and you still get a one-word edit. The scene changes what the assistant notices and the standard it works to, not the format you have to read.

### Compatibility with existing Sessions

Existing Sessions keep their complete messages, membership, and custom definitions. Until you choose a scene, they continue to use their existing routing; settings such as title or model do not convert the Session. Choose a scene explicitly to use the single-assistant workflow on future messages. Saved role IDs are not deleted, but they no longer route messages in that Session. Legacy role settings are under **Compatibility**; replies in scene Sessions do not display role names. Existing scheduled tasks retain their configured targeting. Scene switching requires an updated Agent.

Sessions that chose Short video now show Content creation: the short-video practices remain, and once the Agent is updated, image-and-text platforms such as Xiaohongshu are added. Frontend, Video editing and Primary education appear only when the Agent supports them; with an older Agent, the menu keeps the original scenes. If the Agent is rolled back, Sessions using these three scenes answer through their previous routing (new ones through the general assistant), and the scene returns when the Agent is updated again.

## 删除对话轮次

新版 Agent 默认支持轮次删除，无须启动参数或设置。不支持删除的旧 Agent 可以继续连接同一个 Server，其会话不显示删除图标。如果多个进程共用同一份会话数据，请在首次删除前升级或停用不识别删除标记的旧 Agent 或 CLI，避免旧进程仍读取已删除的内容。

在原生 Yeaft Session 空闲时，会话所有者可以在自己发送的消息下选择 **删除轮次** 并确认。选择原始提问或任意一条补充消息，删除的都是整个 Turn：所有用户输入、VP 回复、模型 Loop 及工具调用和返回结果。无法安全确定归属的旧记录不会删除。

删除后，历史、搜索、调试面板和新的模型请求不再读取该轮次，独立的 Loop 与工具调试记录也会清理。为避免旧版进程正在写入时丢失其他消息，在线删除不会重写会话的追加日志：历史和模型已无法访问这些记录，但原始字节可能仍在本机。管理员需要进一步清理时，先备份并停止这个数据目录的所有 Agent、CLI 和维护进程，再针对准确的 Session ID 运行 `node agent/yeaft/cli.js --prune-deleted-session-turns-offline <sessionId>`。这不是安全擦除备份或后来请求中已经复制的内容。

此操作不可撤销，不回滚工具已经执行的操作或工作区文件，也不修改已分叉的 Session 或其他回复里的转述。删除入口要求 Agent 和 Server 都支持轮次删除，且 Web 已更新。不适用于定时任务 Session、数字人或 CLI 对话。

## Fork the current Session

Choose **Copy session** from the active Session’s sidebar menu, or the copy icon at the top right of the conversation. No setup dialog is needed: the new Session opens automatically on the same Agent.

The fork copies the complete persisted conversation, announcement, working directory, and Session scene/model/effort settings (and legacy roster, if applicable). If the source belongs to a Project, the Server puts the fork in the same Project, so the shared instruction continues to apply. The source remains unchanged; later conversation and Session setting changes are independent.

A supporting Agent can fork while responding: the new Session contains the complete durable history before the active input, excluding that input and its response or tools, without stopping the source. Sending a message records a small boundary without re-reading sealed history. When you actually fork, the Agent verifies that the saved prefix is still valid. The boundary is checkpointed for model-reentry tasks in the Session’s instance data directory, so task-result replies resumed after an Agent restart can still fork earlier history. For legacy tasks without a checkpoint, recovery requires a verified original human input; otherwise the copy fails explicitly rather than cloning a partial turn. Overlapping inputs or parallel VPs use the safe prefix before the earliest active input. Older Agents still require the response to finish. Forking is unavailable while disconnected or another fork is pending. Background processes, running tasks, debug traces, and Session memory files are not cloned. Available uploaded attachments are copied into the new Session’s own storage; missing or inaccessible legacy files remain explicitly unavailable. Both Server and Agent must support Project inheritance for this behavior.

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

## Tool calls and execution status

Ordinary Session replies do not list internal tool calls. In **Session status → Execution status**, open **Details** next to a running turn's request and tool counts. It lists up to 128 calls received live in this tab, newest first. Parallel executions have separate lists. Opening Details does not load history, and the control disappears when the execution ends. Interactive questions, checklists, and hand-offs stay in the conversation.

While waiting for the next chunk, the selected waiting animation appears (three dots when animations are off). The activity panel shows whether the turn is still running.

## Parallel turns

原生 Session 正在执行时仍可使用同一个输入框发送消息。AI 根据正在执行的 turn 判断新输入是补充还是独立请求：补充在目标 turn 下一次 loop 读取，独立请求并行执行，同一会话也能同时处理多个 turn；切换场景后发出的消息不会追加到旧场景的 turn。没有 turn 执行时保持普通对话行为。

两个及以上 turn 正在执行或排队时，历史下方自动展开横向分裂区；根据聊天区域宽度显示一到三栏，栏间用竖线分隔，栏头显示运行状态和提问摘要。栏数超出可见宽度时，通过顶部短摘录 tab 或横向滚动查看其他 turn。每个 turn 可独立停止；完成、停止或失败后按结束先后接到单列历史末尾，仍在执行的 turn 始终在已结束的下方，已结束的回复不会因为别的 turn 结束而移位。已结束的 turn 被后台任务结果等重新唤起时，会作为执行中的回复移到最下方。只剩一个 turn 时立即恢复普通单列：消息回到原来的阅读宽度，分栏状态和停止按钮消失，仍可在输入框或执行状态面板停止剩余 turn。输入框始终只有一个。Agent 重启后，较早曾经并行的 turn 会回到按提问时间排列。刷新或切换 Session 后，运行状态、分栏和消息归属由所属 Agent 恢复。不发送 turn 快照的旧版 Agent 保持普通单列；不提供结束时间的 Agent，其已结束回复仍按提问时间排列。需要同步更新 Agent、Server 和 Web 才能使用完整能力。

After an Agent restart, a recent native Session message with no recorded execution or reply stays visible and is marked **Interrupted**. The Agent does not resend it automatically. Check whether retrying is safe, then use the message’s **Edit** action to send it again.

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
- Session status with announcement, execution state, per-turn Stop, live elapsed time, reported tokens, and active background tasks. Legacy members are still managed in Session settings; the status panel does not list them;
- model/effort selection in the composer;
- an optional debug panel for provider requests, tools, tokens, and stop reasons. Dream events and settings are not exposed.

**Execution status** shows the model requests and actual tool executions for each running thread. Refreshing or reconnecting restores the latest counts from a supporting Agent, even if the page missed the start of the turn. These are live counts, not a count of tool entries in the conversation history.

In **Session status → Background tasks**, hover over a running sub-agent or tab to its title to preview its model, effective reasoning effort, and professional scene. Click, tap, or press Enter on the title to keep the details open. The model and effort follow the latest dispatched request, including retries; effort is shown as not reported until the provider adapter resolves it. Older tasks without this metadata do not show these details.

The execution panel shows errors for the latest turn and any turns that are still running. Once a new turn starts, older finished turns stop showing their errors in the panel. This does not change the conversation history.

Debug output can contain project text and tool results. It is for the current owner and should not be exported or shared casually.

### Images in responses

Tool images appear as compact thumbnails between response text segments. Click to enlarge and browse the other images in that response. Newly generated Yeaft images stay anchored to their source tool even when the upload finishes after later text or history is reloaded. Older images without source metadata retain their existing position rather than guessing which text they belong to.

### Answer AskUser questions

A VP's `AskUser` call appears as an interactive card. You can switch Sessions and return to answer while the request remains active on the Agent.

- Submitting shows “Waiting for Agent confirmation,” not success. The success summary appears only after an Agent acknowledgement or persisted answer history arrives.
- If confirmation has not arrived after 15 seconds, check the connection and use **Resend answer**. A resend retains the original question identity and does not complete the same question twice.
- An unavailable Agent produces a retryable notice. If the question expired, execution was cancelled, or an Agent restart lost the waiting request, ask the VP to pose the question again. Resending does not revive an ended turn.

## Organize Sessions with folders

Folders (Projects) organize Sessions in the unified sidebar like a file tree. You can:

- create a folder with **New folder**, or a subfolder from a folder's menu, up to five levels deep;
- rename, move (drag, or **Move to** in the folder menu) and delete folders; a folder cannot move into itself or one of its subfolders;
- drag native Yeaft Sessions into a folder, or below the last row back to the top level;
- reorder Sessions without losing cross-Agent identity;
- attach an instruction to each folder.

A folder's instruction applies to the Sessions in that folder and in all of its subfolders. When several folders on the path have instructions, the Session receives all of them, outermost first, each labeled with its folder path; the Agent sees the folder path (for example `Sydney / Parental Control`) as the Project name. Wherever Project siblings are used, such as Project-scoped history search, same-Agent Sessions anywhere under the same top-level folder count as siblings, so moving a Session into a subfolder never narrows that scope. Deleting a folder also deletes its subfolders but never Sessions: every Session inside moves to the deleted folder's parent, or to the top level.

A folder does not merge Session transcripts or storage. It supplies Project instructions to members, but the current runtime does not recall or inject sibling Session summaries.

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
