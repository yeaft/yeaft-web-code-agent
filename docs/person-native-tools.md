# Digital Person 原生基础工具

Digital Person 已实现连续的 native tool 对话，不再要求每个执行 loop 都生成认知 proposal JSON。工具直接复用 `agent/yeaft/tools/` 的定义、JSON Schema、执行函数和 `ToolRegistry` dispatch；执行中的每次模型请求都提供当前可用的完整 tools schemas，模型直接调用，无需先 `catalog.view` 或通过 `next.capability` 请求。

执行与最终认知整理始终属于同一个 Person、Soul 和 episode，不增加选择器模型，不创建普通 Session 或 WorkItem。模型的无工具 `end_turn` 只是边界，不直接结束目标。必须先使用 `Execution.goal` 报告有效终态；未完成则继续原生执行，等待则由宿主等结果接续。只有有效收束后禁用 tools，请求一次最终认知 JSON（`next:null`）；通过校验才原子提交。子 Agent 是独立的原生 Engine 执行者，不替换 Person 的身份或 Soul。

## 当前支持

| 能力 | 执行约束 |
| --- | --- |
| `FileRead` / `FileWrite` / `FileEdit` | 使用现有文件读写编辑实现，包括原有分页、版本提示和错误结果。读写不是事务；取消不能撤销已发生的修改。 |
| `Glob` / `Grep` / `ListDir` / `DiskUsage` | 使用原生查找、目录和磁盘占用工具。未提供 managed CLI 安装生命周期，已有 CLI 可用时使用，其他情况按原生工具回退 Node 实现。 |
| `ApplyPatch` / `NotebookEdit` | 使用原生补丁校验和 notebook 编辑；运行时写入失败可能留下部分修改。 |
| `GitRead` | 使用原生只读 Git 证据契约，不 fetch、不创建 worktree；执行目录来自部署工作目录。 |
| `Bash` | 支持前台和 `background:true` 后台 Shell。原生超时、进程树清理和输出捕获约定保持不变；Linux 需要原生工具所要求的 systemd 或 unshare 支持。后台任务由 Person 私有 TaskManager 管理。 |
| `WebSearch` / `WebFetch` | 使用原生网络实现和 AbortSignal；搜索配置来自实例配置。搜索源不可用时返回真实错误，不伪造搜索结果。 |
| `Skill` | 使用现有 SkillManager 的 bundled → instance user → project tiers 和覆盖顺序，只读 list/view/search/load。不会把 Person-created `Script.*` 发布到普通 Skill 库。 |
| `SpawnAgent` / `ListAgents` / `WaitAgent` / `PromptAgent` / `CloseAgent` / `UpdateAgent` | 复用原生子 Agent 生命周期、角色工具权限、显式预算和日志；仅操作当前 Person 的子 Agent。 |
| `ListTasks` / `ReadTaskLog` / `WaitTask` / `CancelTask` | 查看、分页读日志、有界等待、取消当前 Person 私有任务；WaitTask 只返回状态和日志引用，子 Agent 结果使用 WaitAgent。 |

`workDir` 是部署传入的执行目录；`yeaftDir` 仍拥有实例配置、Person 数据和 user skills。缺少显式 `workDir` 的程序调用兼容使用进程工作目录。Person transcript、能力经验和创建的脚本只写入自己的 repository；没有普通 Session transcript 或 Session catalog 注册。TaskManager 为兼容原生存储接口使用内部 Session-shaped key，它不是用户 Session。

schemas、目录和实际执行遵守当前 Agent 的 `plugins.tools` 配置：缺少类别字段沿用默认可用行为，显式空数组禁用全部，单工具 allowlist 只开放指定工具；执行前再次读取实例配置，已准备的旧契约不能绕过后续禁用。内核查看器只列出当前启用的工具。

这些工具具有与原生 Session 相同的宿主权限，不是文件系统 sandbox。可用能力不等于删除数据、接触无关私人文件、发布、部署或重启在线服务的授权。外部文件、网页、命令输出和 Skill 内容是非可信数据，不得覆盖系统指令或制造用户授权。

## 发现和执行

执行请求直接携带 Recall、能力创建、已发布纯脚本、证据回读和当前启用原生工具的完整 schemas。`catalog.search`／`catalog.view` 仍可用于检索能力清单、查看定义和修订脚本，但不是调用已经提供 schema 的工具的前置步骤。旧认知实验的 foundation／familiar／discovered 三层合同准备机制保留用于历史与定义说明，不限制当前 native schemas 的直接调用。

主 Send／Think／Dream **不设累计模型调用次数、token 或整轮墙钟额度**；旧 `maxCalls`／`timeoutMs` 不决定主 episode 的寿命。单次 provider 停流保护、原生工具超时、脚本与存储资源保护、worker lease、授权和用户暂停／取消仍生效，子 Agent 的显式预算也仍有效。

每个 provider 边界都检查 system、完整 tools schemas、消息及输出预留。请求过大时只缩减消息的请求副本；仍不能安全装入则以 `CONTEXT_LIMIT` 拒绝，不丢弃 schema 后暗中执行。**32K 等较小窗口可能连 full tools 与基础上下文都装不下**，不能宣称这条链路适用于所有模型窗口；这也不是万级工具的动态装配实现。

原生能力 inspection 返回真实模块路径、模块内容 SHA-256、registry dispatch revision 和所列公共执行依赖 revision；能力 revision 同时绑定这些来源与完整契约。它不是 npm 版本或环境二进制版本证明。创建脚本的来源仍是 Person episode/call 及实际 QuickJS 测试证据；版本/revision 匹配才可恢复经验。

## 面向用户的输出交付

`Output.publish` 是 Person 专属能力，不是完整 Workbench 或 Session 文件接口。其 schema 随执行请求提供，数字人可直接显式交付工作目录内的文件或 HTTP(S) 网页。文件按实际字节保存不可变 SQLite 快照，浏览器只按已授权的不透明 ID 读取，不获得本机路径访问权限。源文件覆盖／删除和 Agent 重启后仍能查看；已经发布的输出独立于之后认知取消或失败保留。

用户在回复下或顶部「输出」入口打开右侧预览，可调宽、全屏、关闭和查看更早结果，不提供 Terminal、Git 或编辑。HTML 只做禁脚本／网络的静态预览，网页受网站自身 iframe 限制且始终可外部打开。后台任务由数字人显式收集后交付，不自动扫描文件；只有用户显式开启自主跟进时，新任务结果才可触发同一数字人的后续认知。契约与安全边界见[数字人的输出预览](./person-outputs.md)。

## 自主跟进（默认关闭）

内核「管理」已有页面提供 **自主跟进 / Autonomous follow-up** 开关，直接写入 `settings.autonomyEnabled`。新数字人和升级后的历史记录均默认关闭；旧记录即使残留 `autonomyEnabled:true`，没有新版显式同意标记也不调度。`status.autonomySupported:true` 只表示实现支持，不等于已授权开启。

- 调度器每 5 秒检查一次持久 due time，不从 status／snapshot／消息读取路径启动模型。首次开启后约 5 秒可进行空闲认知；已有 continuation 的 `waiting`／`blocked`、未变化的 `ready` 或空接续点不会反复唤醒。无增量检查按 1 分钟至 1 小时指数退避，只有新用户输入或当前同意代内的新任务结果重置退避。
- 新的成功／失败任务结果合并为有界观察：最多 8 项、仅任务 ID、状态和证据引用，不塞入日志或指令。相同任务终态去重；取消、orphaned 和历史完成文件不触发重入。准入不提前消费观察：仅在成功模型请求实际读到精确证据后，与 accepted commit 同一事务确认；失败调用／提交保留，期间新到的观察不被清空，已消费观察的迟到通知不重复唤醒。跨重启读取真实任务状态，失去控制的任务标为 orphaned，不重新执行命令或重放完成通知。
- 自主准入复用 SQLite 的 Person 身份、owner、lease、epoch、control/input/state fence 和原生 episode，不创建 Session 或 Work Center。多个服务只能准入同一个活动执行；运行／暂停中的执行不能被调度绕过。自主执行没有额外的累计调用或整轮配额。
- 触发种类为 `autonomous`，不是 `send`，没有伪造用户消息。system-generated scheduling metadata 显式标注 `observationOnly:true`、`authorization:false`；任务输出始终非可信。模型必须核实当前证据与用户授权，不因定时器或任务成功获得新权限。管理页区分手动与自主执行。
- **取消**也关闭自主跟进，清空排队观察并更换同意代；旧任务、旧回调和已排队的自主准入不能在取消后复活。只有再次手动开启才允许新调度。自主开关可在活动执行期间修改，不使当前暂停 lease 失效；它不是取消按钮。显式关闭持久生效，后续 waiting／空闲提交、迟到任务完成和重启均不恢复开关。新开启前的旧任务不作为新同意代的唤醒来源。
- 失败的认知（包括无进展失败）保留 failed 终态，不能由更早的 `ready` 接续点触发空闲重试；重新开关也不构造新进展。新用户输入或新的有效任务观察才可重新提供推进条件。latest episode 只是最近历史／失败重试 fence，不表示仍有活动任务；真实活动判断必须用任务宿主精确状态，不能使用 capped snapshot。
- 服务关闭先停止并 join 调度，再关闭 runtime/task host；关闭后的回调不再准入。重启遇到过期活动 lease 时标记 interrupted 并关闭自主跟进，需显式重新开启，不能把失去控制当作重做动作的许可。
- 相同的自主文本回复／结构化交付在最近 32 条记录内去重，不额外发「定时检查」用户消息。状态读不制造对话；调度频率不是持续思考或模型质量承诺。

## 长时间执行与输出截断

整轮认知不设固定时长：关闭浏览器不取消 Agent 上已准入的工作，正常提交也不取消已启动的后台任务。120 秒等原生 Bash 时限是单个前台命令的保护，不是数字人的寿命；长命令使用 `background:true`，再显式读取日志／等待。单次 provider 停流保护、工具清理、资源边界、lease 和用户取消不能被“后台执行”绕过。默认任务完成不唤回模型；显式开启自主跟进后才允许结果触发后续 episode。

模型每次输出使用与 Session Engine 相同的原生额度解析：模型显式配置 → models.dev 输出能力 → 实例配置 → 原生默认值；不再统一截到 4096。上下文窗口与输出上限是两个字段，1M context 不代表可输出 1M token。请求、上下文预留及 `budget.maxOutputTokens` 使用同一实际额度；支持的 effort 也必须适配该额度。

完整公开输出、回复和原生工具参数不再受旧 64 KiB／8 KiB／24 KiB 限制。收集与存储仍有独立的 2 MiB 资源保护，页面按完整记录字节预算分页，不把过大的记录偷偷裁成成功；这不是 token 上限，也不承诺字节与 token 的固定换算。认知摘要、概念结构与可复用脚本保留各自语义／沙箱合同；大型产物仍适合文件发布或委派，长命令使用后台执行。

供应商返回 `max_tokens` 时记为 `OUTPUT_TRUNCATED`，不混报为整轮超时。收集器先完整接收并归档响应，再派发工具；截断或未知工具等被拒绝的响应不执行其中任何工具。已捕获片段和 usage 保留，可在有限修正机会内要求更小、完整的输入／输出，不拼接半截 JSON、不扩大输出额度、不回放此前已执行的副作用。最终 JSON 修正与执行输入修正是不同的诊断路径，不是无限 provider 重试。

## 连续执行、最终认知与证据

当前链路是显式 `send / think / dream` 准入 → 读取 Soul、已接受状态与有界记忆 → 连续 native tool 对话 → 经目标终态校验的无工具 `end_turn` → 禁用 tools 的最终认知 JSON（`next:null`）→ 原子提交。执行时返回真实 `assistant` 工具调用和 `tool` role 结果，延续同一对话；不在工具之间插入 proposal／activity／认知提交，不另请一个模型充当“人”。`Think` 是主体认知方法，不是另一个模型；一次提交也不等于所有目标已经完成。

- **目标独立于模型 turn**：`Execution.goal` 仅在接受承诺／关键里程碑／结束边界使用，不是每步认知表单。未完成目标的 objective／acceptance／kind 保持稳定，换路线更新 nextStep；真实观察支撑 acceptanceChecks，引用存在不等于语义验收。宿主精确核对待处理任务／子线程及未确认副作用，不能用 capped snapshot 关闭。等待由宿主无模型轮询地接续；暂停、取消仍生效。连续空答且无实际动作记为 `GOAL_NO_PROGRESS` 失败，不冒充完成或外部阻塞，也不增加工具调用总额度。
- **入口即生效的行为语义**：Send 优先当前请求，Think 推进未决问题或实际结果，Dream 从用户真实利益出发开放探索替代手段、挑战前提与跨领域联系，不默认期货等于赚钱。假设不是用户报告，兴趣不是授权；有价值且可逆的授权内验证应实际执行，无承诺探索可安静休息。详见 [用户理解与多样上下文](./design/person-user-understanding.md)。
- **每个工具有独立证据身份**：一次模型输出可包含多个工具，各自生成独立 trace `callId`，并绑定父 `modelCallId`、供应商 `toolUseId` 和从 0 开始的 `toolIndex`。模型调用与工具调用不共用一个结果槽；多工具不重复累计父模型 usage。
- **最终整理与有限修正**：正常只请求一次最终 JSON；格式、schema 或实际已读取的 `sourceRefs` 不合法时，最多再请求 **2 次额外修正**。修正仍禁用 tools，只纠正最终认知产物；不得回放已执行副作用、补造来源或把外部观察降格为用户报告。仍无效则失败，既有工具结果与公开进展保留，候选认识不提交。
- **请求副本与原始证据分开**：原始工具结果持久存入 capability trace。模型只接收有界结果副本；较早结果可替换为 evidence receipts，完整旧 assistant/tool 组可从本次请求省略。receipt 保留工具／调用身份、成功失败、来源、原始字节数、SHA-256 和 `Execution.read` 回读入口，不是合成认知总结。不能把预览当作完整证据，也不能为取回省略输出重做副作用。
- **推进以真实增量为准**：思考可从未解决问题、接续点或真实结果出发验证、执行、整合交付或提炼判断。遐想保留探索性，不把想象当证据或授权；没有值得推进的方向可以休息（`reply:null`），不强制工具调用或制造概念。
- **跨轮接续点**：最终提交可保存 `state.continuation`，包含 `goal / nextStep / status / condition`，状态为 `ready / waiting / blocked`，文本字段各最多 1000 UTF-8 字节。省略保留、`null` 清除；失败和取消不提交候选。它只保存一个主要方向，不是任务数据库、授权或调度指令，新指令和取消优先。
- **暂停与取消不重放**：暂停在当前模型／工具收尾后到达安全边界，继续同一 episode，不重新准入或回放操作。取消保留已归档结果、阶段回复和已成功发布的产物，等待实际执行清理；外部副作用不保证回滚。活跃 transcript 只在当前进程内，重启标记中断，不声称能无损续跑。

默认不是自动常驻思考：后台结果需当前 episode 显式等待／读取，或下一次 `send / think / dream` 收集。可在内核「管理」中显式开启自主跟进；仅在同一 Person 下准入后续 episode，不创建 Session 或 WorkItem。状态接续和证据提供推进条件，不能保证模型每次形成高质量认识或解决所有问题；脚本化 provider 回归验证执行链与持久化，不替代真实模型质量评估。

## 30～60 秒阶段反馈

数字人约 30 秒后可在自然请求边界发布有依据的进展。当前 native 进展直接绑定已完整收集、持久归档的模型 `complete text` 与精确 `callId`，无需每个执行 loop 生成／校验 `activity` proposal。不投影流式碎片、工具原始内容或隐式思考；不为了汇报增加模型请求。没有新结论可不发，重复文本去重。

约 60 秒仍无实质回复时，现有心跳在 episode snapshot 更新同一条真实等待状态，区分模型、工具和准备阶段，不制造消息或百分比。阶段回复到达后清除等待并重新计时；这是近似反馈节奏，不是整轮超时，断网等不能保证准点送达。

阶段消息带 `replyKind: progress`、`episodeId` 与父模型 `callId`，发布时核对当前执行权和完整文本证据，并进入自己的 message journal；不提交 Concept 或 state version。最终校验通过的 `next:null` 才走原子提交，回复标为 `final`。取消、失败和重启保留已经发布的进展，旧 worker 不可继续发布。界面在同一轮区分阶段与最终回复，不重复置顶。

## 持久执行证据回读

`Execution.read` 的 schema 在每次执行请求中直接提供（wire 名为 `Execution__read`），无需 `catalog.view`。以 `{callId,offset:0,maxBytes:4096}` 回读已持久化的原始 capability trace；`callId` 是独立工具 trace ID，不是父模型 ID。结果预览和 evidence receipt 的 `recovery` 提供直接回读参数。它不调用模型、不重跑工具、不发布新的权威副本。后台任务／子线程日志仍使用 `ReadTaskLog`／任务工具，不冒充 capability call trace。

`offset`／`nextOffset` 是原始 output 的 UTF-8 字节位置；`maxBytes` 为 4..4096，分页边界不会切断字符，非字符边界的 offset 明确拒绝。JSON 转义也计入总计 8192 字节响应预算，因此实际页可能更短；按返回的 `nextOffset` 继续直到 `eof:true`。没有 output 的内部能力以 `JSON.stringify(result)` 回读。返回真实 `ok / code / errorEffect / sourceRef / rawBytes / sha256` 及原调用参数；过大的参数只提供有截断标记的有界预览。

默认读取当前 live episode。可选 `episodeId` 必须是同 namespace、owner、Person 的已存在 episode；scope 始终由运行时决定，不接受 owner 或数据库路径参数。读取受当前 episode lease/epoch/worker/control 等 fence 约束，取消或失权后不可继续。历史或 after-terminal 结果明确标记为 evidence-only，不恢复执行权限，也不证明外部副作用已经撤销。

## 结果、错误、取消

- 原生工具输出（包含原生工具自身捕获/分页上限）作为 raw result 保存在 Person capability trace。模型只接收另一份最多 8 KiB 的 JSON/UTF-8 预算副本；保留原始 byte count、SHA-256、sourceRef 和可调用的 `Execution.read` 恢复信息。截断为头尾预览，`hiddenRange` 精确标记省略的原始 UTF-8 字节区间；它不是完整返回。需要被省略内容时分页回读原始 trace，不重跑副作用。
- 成功外部结果有 `tool:<episode>:<call>:<tool>:<sha256>` 引用和实际实现来源；这表示本次工具观察，不表示客观事实或用户报告。外部引用可以用于 hypothesis/uncertain 等记录，不能单独为 `reported` 提供 user-reported lineage。
- 原生 JSON 错误结果记录为 `capability_failed`，不算成功经验。写入错误的 effects 默认为 unknown；不承诺回滚或自动安全重试。
- 取消、服务关闭和工具超时会等待实际执行 promise 结束；支持 signal 的工具收到取消。已经交给文件系统的写入可能完成。工具不响应取消时，join 可能延长停止等待；不能在副作用还运行时声明停止成功。
- 每次工具调用先记录绑定原 worker、episode、call 和参数摘要的 invocation。取消、关闭或工具超时后，原执行者仍可一次性归档真实结果为 `capability_finalized`，保留 raw output、SHA 和来源；不恢复认知提交权限，不增加成功经验。结果不可确认时明确标记 effects unknown，不能声称回滚。对话活动区只投影执行终态，原始内容留在调试记录，不进入公共思考文本。
- `ToolRegistry` 超时仍是失败，即使底层 promise 随后成功。无法确认 Bash 进程树退出时终止当前活动，不继续安全重试或把结果算作成功。取消后本服务在旧活动 join 结束前不启动同 owner 的新活动。
- 此本地 join fence 不提供跨进程宿主副作用锁。若多个服务进程使用同一 Person 存储，既有 repository lease/cancel fence 能阻止旧认知提交，但不能终止另一个进程或另一台宿主上的外部动作；不要在旧执行宿主退出未确认时恢复外部写操作。

## 异步生命周期与归属

- task host 按 canonical `yeaftDir`、部署 namespace、authenticated owner 和 Person 隔离，跨正常 episode 提交保持稳定。构造服务、status/open 和只读 inspection 不创建 task host，不发起子模型请求。服务始终使用实例 `yeaftDir` 下的 SQLite；异步工具的私有数据也必须有明确的实例根。
- 私有数据位于 `<yeaftDir>/person/tasks/<scope-hash>/`，保留任务元数据、shell logs、子 Agent JSONL logs、tool-results 和 completion records，不写入普通 Session transcript 或 manifest。实例配置始终从当前 `yeaftDir` 读取。
- 正常认知提交不会关闭后台任务或子 Agent。所有任务的原生投递仍为 `status_only`；只有 Person 另行显式开启自主跟进后，新完成事件才可通过同一个持久准入 fence 创建 Person episode。完成/运行证据在下一次手动或自主 episode 的上下文中可见，或由已运行 episode 主动执行 WaitAgent/WaitTask 收集。
- 下一次模型上下文的 task evidence 使用总计最多 8 KiB、单条最多 2 KiB 的 JSON/UTF-8 预算；当前模型窗口还可进一步省略条目。完整 raw logs 和原始工具归档保留在私有目录，模型可使用 Task 工具分页检查。引用仅代表外部观察，不能单独建立 `reported` 用户来源。
- 显式取消指定 episode 时同时停止该 episode 已启动的后台效果，**即使认知已经 completed**；不指定 episode 则停止该 owner 的全部已知任务。异常或未确认的工具效果导致主执行终止时，停止 originating episode 的异步工作，不停止其他正常已提交 episode 的任务。服务 close 停止并 join 本 host 的实际工具效果和子 driver，而不是仅改变状态。
- 重启后失去进程控制的任务标为 `orphaned`；未完成子 Agent 变为 failed 并保留 orphaned recovery evidence。保存的完成结果/日志可恢复，但不会假装仍持有进程句柄或自动重试外部动作。

## 内核中的任务查看与管理

点击数字人页右上角「查看内部」→「任务」，统一查看这个数字人跨 episode 的后台 Shell 与子线程，不以当前输入或对话轮次筛选。面板显示有界状态摘要，并可分页读取原始日志；日志只作为当前 owner 的不可信文本展示。页面首屏取创建时间最新的一页，并合并独立的活跃控制快照；活跃工作优先显示、组内按创建时间最新优先，避免旧任务的停止入口被历史埋没。向下滚动按游标续读旧任务，后台 Shell 与子线程统一排列；已加载列表虚拟渲染，不一次创建全部 DOM。原生模型 `ListTasks` 的有界快照仍保留未结束任务优先策略，不与页面分页合同混用。Shell 可停止，子线程可关闭；成功响应必须等待进程/driver 与工具实际清理结束。失去控制的 orphaned 记录只供查看，不假装可以确认停止。

子线程 lifecycle 与任务 outcome 分开展示：预算耗尽或请求提前收尾是「未完成」，不是成功。driver 已结束但真实工具仍执行时，`executionPending` 保留停止入口，关闭操作等待实际工具清理。若重启时仍有此类待清理执行，则保留 orphaned 恢复证据，而不是宣称停止成功。

管理 API 从 authenticated owner 的持久 Person identity 获取私有 task host，不初始化模型/provider，不触发 send/think/dream，也不恢复或取消无关活动。只在任务栏可见时轮询；关闭、切换 Agent/owner、断线及退出页面都会停止轮询或隔离迟到回复。模型不可用但存储仍可读时，任务管理继续可用。

认知指令明确要求数字人在显式启动的 episode 中关注自己已授权的持续工作，而不只看最新消息；默认不会因任务完成启动下一次认知。显式开启后遵守下面的自主跟进边界；这不是宿主动作的自动重试。当前产品仍并列提供 Session、Work Center 和数字人，不增加另一套任务或对话系统。

## 内核中的运行与用量

点击「查看内部」→「运行与用量」，按持久 turn（send/think/dream episode）查看调用次数、状态、模型选择与 token 明细。展开后按父模型请求显示模型、有效 effort、选择来源、输入/输出/推理/缓存用量、上下文字节预算与输出预留，并通过 `modelCallId` 关联其多个独立工具结果；工具步骤不是新的模型调用。摘要分页以完整 turn 为单位，不依赖原始 trace 页是否已加载；仅在面板可见时轮询，不发起模型请求。重新加载页面后仍可查看历史。

用量来源是 provider 实际返回的 usage，不从字符数估算计费 token；流式增量累加一次，OpenAI 输入已包含的缓存不再相加，Anthropic 独立报告的缓存计入输入总量。推理 token 是输出的子集，不重复计入总量。失败或取消仍保留已捕获用量；缺失 usage、尚未结束的调用或旧记录不能证明使用完整累加规则或缓存口径不明时明确标记未完整确认，已知值只能视为下限，不能以 0 代替未知。

此页展示 **Person 主线程** 的用量，不包含独立子 Engine 的额外消耗，也不计算费用或执行用户可设的 token 硬限额。调用模型表示分派到配置的模型引用，不保证供应商内部 alias 对应的底层版本。主 episode 没有累计调用次数额度，实际模型窗口与单次输出预留继续生效，单次 provider/工具保留自身超时保护；查看页不能代替完整的跨线程费用预算。原始调试日志入口仍在思考记录内，不把 prompt、工具参数或隐式思考复制进用量摘要。执行步骤也归于此页，`call_*` 明确称为“模型调用”，`capability_*` 称为“能力／工具调用”；它们不等于数字人的主动思考。

## 思考记录与执行详情的边界

Composer 的“思考”是 `think` 触发，一次触发形成一个 episode / turn；对话和遐想分别是 `send` / `dream`。内部模型请求、工具调用及真实结果回传是这一活动的执行 loop，结束后才生成最终认知候选。`Think` 能力本身只提供认知方法，不创建另一条模型请求；也不能把每次模型请求都称为一次主动思考。

“思考记录”按 episode 汇总数字人的公开认识：触发主题、完整公开进展、最终认知 JSON 中的变化／判断、疑问、概念和接续点。不要求每个执行 loop 都存在 proposal 或 activity；缺失这类旧记录不表示漏掉一次“思考”。默认不逐条展示模型请求携带的旧状态、历史消息或回忆，也不放“模型调用／能力调用”交替列表。只用精确 `(episodeId, callId)` 的 commit 证据标记采纳；失败、取消或只加载 commit 页时，不能将较早候选冒充采纳结论。最终候选、修正拒绝／不完整记录与实际能力发布结果保留在折叠的“过程与执行结果”，能力副作用不因认知失败被当作回滚。所有文字仍使用白名单和文本插值，不表示供应商的隐藏推理。

“查看执行详情”进入“运行与用量”并展开对应 turn；不发起认知调用。较早 turn 尚未加载时给出明确提示，继续加载旧页后定位该记录，不能误开另一条 turn。此版本复用原始 trace 分页：一张认知卡片可能只有已加载片段，刷新／继续加载才可补齐。省略的 continuation 不用当前状态回填到历史记录，也不增加总结模型请求。完整事件、请求和原始证据仍在调试日志，模型／工具顺序与消耗在运行与用量。

## 对话与内核的历史浏览

数字人对话保留从旧到新的阅读顺序，但首次进入、刷新和重连直接定位最新消息。与 Session 共用虚拟 transcript，仅挂载可见窗口附近的消息；向上滚动到历史边界按页续读，前插历史保持当前阅读锚点。首次进入不会自动耗尽历史。用户正在阅读旧消息时不强行追随新回复；本地发送仍沿用回复起点定位，手动滚动即可解除定位。

「查看内部」的思考记录、调试、运行与用量、任务、记忆和技能以最新优先展示，滚动到底部继续读取旧页，同时保留可键盘操作的加载按钮。思考/调试以持久序号排序，turn 按输入序号排序，记忆按最近更新时间排序，自建技能按版本发布时间排序；无时间语义的内置能力保留稳定目录顺序。内核列表虚拟化长列表并保留展开状态，不因打开面板发起认知调用。游标是 live keyset，不是数据库快照：浏览期间被更新到较新位置的记忆需刷新后查看。

记忆和技能使用紧凑列表：记忆优先显示两行完整行高的正文摘要、分类靠右；技能先显示名称和分类，再显示最多两行用途说明。展开箭头与内容同排，不占独立一行；收起时仅摘要省略，展开可读完整正文、来源或能力合同，不裁掉原始记录。

页面上的历史页仍会保存在浏览器内存中；虚拟化控制 DOM/Markdown 渲染量，不是无限历史的内存淘汰。任务原始日志仍采用有界、向前续读的独立日志合同。

## 子 Agent 限制

子 Engine 只继承 Person 已支持的真实 native 工具和当前插件 allowlist；原生 `DiscoverTools` 仅供子 Engine 使用；Person 主执行直接获得完整可用 schemas。角色 baseline 和 `allow_tools` 继续约束子工具，不能授予嵌套 orchestration。没有 Session HistorySearch、交互 AskUser、路由、MCP、Work Center 或 worktree 管理。

子 provider 被固定到产生 `SpawnAgent` native 调用的实际父模型，而不是由工具参数另选模型。实际父 requested/effective effort 与 wire decision 传入原生子 Engine；子请求不能通过 role/fast/fallback 映射切换到其他候选模型或提升继承 effort 上限。子模型照常处理原生 tools/messages/events，非 Person JSON 提案协议。

不同子 Agent 拥有独立上下文、日志和预算，**不提供共享可写工作区并发隔离或操作系统 sandbox**。实现者角色或显式 Bash/write grant 拥有真实写权限；调用者须自行安排非重叠工作或独立 cwd，不能据角色名宣称只读，也不能用并发任务覆盖同一文件。子 Agent 不具备 SpawnAgent/PromptAgent/WaitAgent/CloseAgent/ListAgents/UpdateAgent 权限。

## 尚不支持的 Session 专属工具

不注册 `AskUser`、`HistorySearch`、Session VP 工具、`RouteForward`、Work Center 创建、MCP、worktree 管理、JS REPL、图像生成与 `ViewImage`。这些分别需要交互中继、Session 历史归属、Session VP/路由生命周期、连接管理或 provider 图像内容块传递，当前 Person 不能完整提供。

Person 使用自己的 `Recall` 和只读 history search API，不混查普通 Session。Person 执行直接使用请求中的 schemas，自己的 catalog 用于清单检索和定义查看；子 Engine 使用原生 DiscoverTools，不创建另一个模型选择器。生成的 QuickJS 脚本仍只能进行纯 JSON 计算，绝不能通过创建能力得到任何原生 host 权限。
