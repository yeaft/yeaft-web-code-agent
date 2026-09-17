# Work Center

Work Center 是 Yeaft 的 Agent-level durable task system。当目标必须跨越一次交互 turn、需要角色隔离或审查、可能等待人工输入，或者需要在浏览器断开/Agent 重启后恢复时，应使用 Work Center。

![展示 WorkItem conversation 与 Actions 的 Work Center](/images/zh-CN/work-center.png)

## 心智模型

```text
WorkItem
  ├── contract：goal、acceptance criteria、workDir、attachments、memory policy
  ├── Coordinator conversation
  └── 按需创建的 Actions
        └── Run attempts：VP/model/tool snapshot、messages、usage、evidence
```

- **WorkItem** 是持久目标，也是面向用户的 conversation owner。
- **Action** 是有实际依据的工作单元，包含 objective、approach、expected result、执行者/model 选择和 workspace policy。Action 服务于目标，其数量不代表任务完成度。
- **Run** 是执行 Action 的一次有 fence 的尝试。它的 identity 会阻止迟到或陈旧输出修改更新后的 attempt。
- **Event** 是 append-only 审计证据。当前状态来自 canonical WorkItem/Action/Run row，而不是通过 replay UI event 推导。

Work Center 不是 Session。它可以从 Session 创建并保留 origin link，但数据和生命周期属于所选 Agent。

## 创建 WorkItem

侧栏顶部、折叠按钮左侧的工作中心图标会打开全屏 Work Center；侧栏折叠后也可从图标栏进入。也可以从 Yeaft Session 的 composer 发起。Work Center 有独立侧栏：顶部的「返回 Session」图标回到原对话，不会停止持久任务；下方选择 Agent，再查看该 Agent 正在运行或等待中的工作项、子 Action、状态及执行者。点击工作项或子 Action 可直接进入对应详情。侧栏运行摘要独立于看板搜索、筛选和分页，断线时保留摘要并标记状态可能过时，重连后刷新。桌面可折叠为图标栏；窄屏使用可关闭的导航抽屉。

「正在推进」分组和每个工作项的子 Action 均可独立展开、收起。子列表只显示 ready、running、waiting 的 Action，按创建时间倒序显示，并附时间和执行者；旧 Agent 未提供时间时按 Action 序号倒序，不编造时间。已完成或取消的工作项退出活动区。失败、已完成、关闭及被替代的 Action 不再占据活动列表，但仍保留在完整 Actions 历史中供追溯，历史列表同样按时间倒序。这些显示规则不改变实际执行状态，也不会取消后台任务。

看板保留「进行中 / 需要处理 / 已关闭」三栏，用轻量竖线分区，不给整列增加卡片外框。列标题、数量、卡片和空状态统一对齐，卡片使用紧凑字号；空间不足时切换为单阶段标签。顶栏右侧提供搜索和筛选，更多菜单中提供设置与刷新；窄屏搜索收纳到筛选面板，新建工作项收纳到更多菜单。

Item 的「工作项 / 标题」面包屑与快捷图标放在唯一顶栏，起点与正文阅读列对齐；点击「工作项」返回看板。宽屏打开 Item 时默认并排展示 Actions，右侧顶栏的关闭图标只关闭 Actions，不退出 Work Center。Action 详情沿用同一顶栏和等高、独立滚动的内容区。窄屏以单面板钻取，关闭 Actions 后保留对话草稿。主动关闭 Actions 的状态也保存在当前页面 URL 中。

桌面端可拖动对话与 Actions 之间的细分隔线调整两栏宽度，悬停、拖拽或键盘聚焦时强调线条，浏览器会记住宽度偏好；双击分隔线恢复默认宽度。也可用 Tab 聚焦分隔线，左右方向键调整宽度，Shift + 方向键加大步长，Home 恢复默认。Actions 开关始终位于对话顶栏右端，紧邻 Actions 栏；标题和正文采用紧凑阅读排版。窄屏不显示拖拽柄。

「设置 → 通用 → 工作中心入口」通过开关和「已开启 / 已关闭」显示当前状态。这个偏好只控制浏览器中的入口显示，不会启动或停止 Agent 后台任务。没有兼容在线 Agent 时仍可进入查看提示并返回。

新 WorkItem 需要：

1. requirement 或 goal；
2. working directory；
3. 可选文件（已支持的图片、PDF 或文本类 attachment）；
4. 是否复用符合条件的历史 memory；
5. 交付目标（或选择交付前询问）；
6. 是否立即开始执行。

标题是简短的展示标签，与用户原始 requirement 或 goal 分开保存。显式提供的标题会原样保留；省略标题时，由已有的首次 Coordinator 决策一并生成，不增加独立 model 调用。重试不会改写原始 goal，旧 WorkItem 也继续保留已有标题。 新 Item 独立保留创建时的需求，用户后续确认的目标调整不会覆盖它。旧 Item 以升级时保留的目标作为需求，早期版本没有单独保存原文。Coordinator 执行前显示紧凑的临时标题；模型未返回标题时使用确定性回退，不因此让任务失败。

从 Session 创建时，runtime 会强制写入来源 Session；model input 不能替换这个 identity。

## 规划与执行

新 WorkItem 使用动态协调。创建时未单列验收条件，就直接以用户目标作为最低验收条件。Coordinator 根据当前事实，只创建下一步真正必要的 Action；自动推进不能修改目标或验收标准，只有用户明确补充时才能调整契约。不强制走 triage → implement → test → review → deliver 固定流水线。简单研究可能只需一个 Action；代码修改则可能根据证据与风险，需要独立实现、验证或集成。

每个 Run 复用现有 Yeaft engine，并提交结构化 outcome。Coordinator 据此判断需要继续工作、请求人工回答，还是完成任务。`sourceActionIds` 记录输入结果的来源，不是预建的依赖图。

### 看目标进度，而不是活动数量

Agent 提供 `goalProgress` 时，WorkItem 详情展示 **已验证验收条件数 / 总数**、剩余数量、每项条件的已验证/未通过/待验证状态、阻塞原因，以及独立的交付状态。未通过和待验证的条目就是剩余工作；「目标」标签展示验收条目和交付证据；「进度」汇总已验证条件数、Action 与阻塞项。展开**证据 Run**可查看来源 Action 的序号和目标描述，点击后在右侧打开 Action 详情（窄屏进入详情面板）。资源预算中的尝试记录、阻塞项和 Action 的来源引用也使用同一跳转。旧 Agent 或缺失记录无法提供可靠关联时显示「来源 Action 不可用」，不猜测来源；原始标识保留在悬停提示中。浏览器展示 Agent 的证据投影，不按已完成 Action 数量、耗时或模型估计推算完成度。

所有验收条件已验证不等于已经交付。当前有效的 canonical Run 证据必须同时支持验收条件和所选交付目标。陈旧或矛盾证据会使条件保持待验证或未通过。旧 Agent 没有此投影时保留普通验收列表，不凭空显示百分比。

Item 详情分为两个独立区域：**上方 Info，下方 Conversation**。Info 默认打开「需求」，展示原始需求、附件与基本信息；「进度 / 产出 / 目标 / 用量」是并列标签。产出采用紧凑的标题 / 引用行，用量收纳资源预算与操作。长内容在 Info 面板内滚动，不把下方对话输入框挤出视野。切换标签保留对话和预算编辑草稿，打开另一个 Item 时回到「需求」。标签支持方向键、Home 与 End。失败、等待提示及资源停止详情入口保持在标签外可见。**Actions** 在宽屏默认并排展示执行细节，也可关闭；其执行数量不作为主要的任务进度指标。

Work Center 消息不显示未接入的逐消息 debug 按钮；已完成或取消的工作项也隐藏引用、编辑为新消息等不可用操作，仍保留复制和导出。普通 Session 的 debug 与引用操作不受影响。

### 选择完成边界

| 交付目标 | 交付内容 |
| --- | --- |
| **回复**（`response`） | 有 canonical Run 证据和验收检查支持的实质答复，例如解释、调查结论或建议；不要求文件、PR 或 commit。 |
| **工作目录中的文件**（`workspace_files`） | 工作目录中有 canonical 记录的文件产物。 |
| **创建拉取请求**（`pull_request`） | 有 canonical 记录的 PR 产物，仍须遵守仓库评审策略。 |
| **合并已批准的拉取请求**（`merge`） | 有 canonical 记录的 commit 产物，仍须遵守批准与合并策略。 |
| **交付前询问我** | 完成前必须先确认交付边界。 |

Agent 提供 `finalResult.responses` 时，**交付回复**显示保留的答复，可展开查看 Run 来源与证据。普通对话回复或执行者说“做完了”不等于交付回复。选择代码目标不授予绕过评审、发布、部署或更改权限的许可。

### 旧数据与设计方向

旧 WorkItem 仍可沿用 workflow snapshot、依赖和 final gate 规则；这些记录继续可读，但不定义新的任务优先交互。证据进度与回复交付依赖相应 Agent 投影。设计文档中的更深层证据跳转和更广泛自主能力，不应被视为这些字段已经实现的功能。

## 资源预算与显式恢复

提供资源控制的 WorkItem 会在「用量」标签显示**资源预算**：全生命周期请求与 token 预算占用的已用 / 上限、本地化停止原因，以及可展开的**消耗明细与限额**，分别列出 Coordinator 与 Actions。已报告 token 是已知用量；预留包含在途和未知用量，已经计入预算占用，不要再次相加。未知用量不等于免费。

默认限额为：**累计 200 次请求**、**累计 2,000,000 token**、**每个 Run 40 次请求**、**每个 Action 全生命周期 3 次尝试**、**Coordinator 累计 3 次失败**。Action 尝试还受原始上限与显式追加额度约束，详情列出已用 / 有效上限。请求数包含重试和辅助调用。取消、重启、某次成功或新 generation 都不清零累计消耗。

Token 准入在派发前按输入与最大输出估算，收到完整 reported usage 后用真实报告结算；未知或部分结果继续保守占用。这是**估算准入，不是硬性费用上限或账单保证**：真实用量可能超过估算，已经派发的请求无法撤回。历史用量缺失时无法重建完整账单。

资源停止后的继续方式：

1. 检查停止原因与限额。需要更多资源时选择**追加预算**。
2. 填写正安全整数的**增量**，未修改字段留空，检查后选择**确认追加预算**。追加 Action 尝试次数会应用于此 WorkItem 的**所有当前及未来 Action**。
3. 追加**不会**恢复执行、清除停止原因或清零用量。准备好后单独选择**恢复工作项**。Run 请求限额停止可以在不增加每 Run 上限的情况下恢复为新的 Run。

操作使用最新执行管理版本，与目标合约版本分离。遇到错误或版本冲突时，界面刷新状态并要求用户重新明确确认，不会自动重试修改。刷新失败或重新连接后，在刷新确认前禁用修改。模型指令、retry、watcher 开关及目标编辑均不能增加预算或解除资源停止。未提供该投影的旧 Agent 保留原有用量展示。

## 并发与 workspace policy

Work Center 最多按 `maxConcurrentActions` 并发执行彼此独立的 ready Action（默认 3，可配置 1..12）。Workspace 冲突、repository state 和旧 workflow dependency 仍会约束实际并发。

| Workspace mode | 含义 |
| --- | --- |
| `read` | Planner/reviewer 的合同，表示 Action 不修改 files、Git state、services 或 external systems；它不是通用 OS sandbox。 |
| `shared` | 在 canonical working directory 执行；需要时串行化共享写操作。 |
| `isolated-write` | 在独立 Git worktree 执行彼此独立的代码修改。 |
| `integrate` | 合并声明来源中的 isolated-write 结果；发生冲突时停止并交由明确处理。 |

隔离修改必须先集成，才能支持 canonical workspace 中的交付。动态协调按需创建此工作；旧 AI-planned graph 仍保留单一集成门禁规则。

## VP 与 model assignment

Action 可以使用：

- `auto`：根据 Action capability 选择 VP；
- `pool`：从明确候选中选择；
- `fixed`：使用一个固定 VP。

Review 可以要求与 implement/test 角色隔离。如果没有符合条件的 VP 或配置 model，WorkItem 会进入 attention，不会静默 fallback 到无关 VP 或 model。

Model policy 可以继承 runtime、选择 primary/fast，或者指定已配置 model。Effort 按 Action 解析，并冻结进 Run snapshot。

## Coordinator 与 Action conversation

WorkItem 主对话默认面向 **Coordinator**，用于：

- 查询当前状态或要求解释；
- 指导一个或多个未完成 Action；
- 修改 goal / acceptance criteria 并请求 replan；
- 恢复 Coordinator 可见的问题。

Coordinator 没有 file、shell 或 external side-effect tool。它通过 structured decision 协调 Action、更新合同、请求人工输入，或在证据满足合同时完成 WorkItem。

等待提示提供「回复协调者」或「回复这个 Action」入口；点击后会选择对应接收者并聚焦下方输入框，不会自动发送或代表批准。Action 详情中的人工问题也有直接回复入口，打开详情本身不会改变草稿接收者。也可以在 composer 手动选择目标。

Waiting/failed Action recovery 受 Action ID、revision、generation 和当前 Run state fence 保护；动态模式下可回复任何符合条件的 Action，不依赖唯一的 current Action。服务端明确拒绝过期目标时，会保留文字和附件、解除请求锁定并刷新详情，供用户核对后重发；超时或断线等送达未知情况仍保留原请求身份以防重复应用。Action detail 展示连续 conversation；保留的执行数据按需加载，不混入主要目标视图。

## Outcome 与 recovery

Run 以以下状态之一结束：

- `completed`：包含具体 evidence 与要求的 acceptance check；
- `waiting`：包含人工问题/reason；
- `retryable`：允许且安全时再尝试；
- `failed`：自动继续不安全或 attempt 已耗尽。

Stop/cancel 会关闭 active execution fence；迟到 tool/model output 不能推进 WorkItem。Agent 重启时，陈旧 running Run 会变成 interrupted。安全 Action 可以在 attempt policy 内重新 ready；外部副作用不确定时必须进入 attention，不能盲目 retry。

## Memory reuse

`reuseMemory=true` 时，Work Center 可以计算三类有边界的候选来源：

- 当前 Agent memory index 的 scope-bounded full-text recall；
- 相同 canonical workspace key 下 completed WorkItem 的 structured summary/evidence；
- persisted workspace 解析到同一 canonical path 的普通 Session user-visible transcript excerpt。

Browser-created 和 legacy item 读取 Agent user scope。Trusted Session producer 还可以授权 source Session 与 current VP scope。Workspace transcript recall 只在 owner 本地运行，会验证 canonical path、排除当前 source Session，并且不读取 raw tool output。

这些只是候选来源，不代表每类都会进入每个 prompt。Execution schema v1 会在非空时附加 Runner 计算的 memory 与 workspace-Session block；schema v2 渲染 immutable Mainline context 与 fixed suffix，当前不会附加这两个预计算 block。所有 recall 都有 token budget，只是 reference context，不能覆盖 WorkItem contract、Action instruction、tool policy 或 completion protocol。`reuseMemory=false` 会关闭三条候选路径。

## Attachment 与 evidence

Attachment 随 WorkItem 持久化，并作为不受信任的 reference data。Runtime 会在注入或下载前检查 type、size、path stability 和 owner boundary。

Execution evidence 可以包含 summary、acceptance check、file/test reference、request usage、loop timing，以及保留的 tool input/output。Browser 按需加载详细 execution record；大型记录可能被限制或 summary。

## Work Center 不承诺什么

- 它不是无限制的 autonomous deployment service。
- `read` workspace policy 不是 kernel-level sandbox。
- 一个 Action completed 不足以让 WorkItem done；当前证据必须支持目标验收条件和交付边界，旧 workflow 还保留 final gate。
- `turn_end` 不是 Action completion；executor 必须提交 structured outcome contract。
- Work Center memory 永远不能获得高于当前合同与 safety rule 的权限。
- Session 与 WorkItem 不共享一份 transcript，也不是同一个 memory owner。

## 相关页面

- [Yeaft Session 与 Project](./yeaft-session.md)
- [原生 engine 架构](../tech/yeaft-engine.md)
- [Provider 与 model 配置](../yeaft-config.md)
- [内部 Work Center domain contract](../../../work-center/domain-contract.md)


### 工作目录与产出文件

打开工作项后，通过右上角工作台图标查看它的工作目录。文件产出可直接在共享的 Files 预览器／编辑器中打开；Git 和终端复用聊天中的 Workbench 组件。路由属于所选 Agent 和工作项，不借用进入前的 Session。关闭工作中心不会改变原 Session 的工作目录和面板状态。

需要新版 Server、Agent 及有工作目录的工作项。此路由不提供切换目录：Files、Git 和终端初始目录使用工作项目录。Git 仅在工作目录为仓库根目录时可用，防止仓库级操作静默包含工作项之外的文件；子目录工作项仍可使用文件和终端。目录外的本地文件引用保留为纯文本，HTTP(S) 链接单独打开。工作项暂不支持 Browser Runtime。文件操作和终端沿用既有 Workbench 权限，不是执行沙箱。
