# Yeaft Session 与 Project

**Session** 是一段持久对话，使用同一个消息时间线。场景只改变 AI 做事的准则，不切换身份，也不分割历史。

## Session 包含什么

一个 Session 保存并展示：

- Agent owner 与稳定 Session ID；
- 名称、工作目录、公告，以及创建/活动 metadata；
- 当前场景（旧角色资料仅为兼容保留）；
- 可选的 Session-level model 与 reasoning effort override；
- 持久消息和对话轮次、tool results、后台任务状态和 debug traces；
- 保存在 Session 作用域中的历史数据。

Session metadata 和 history 位于所属 Agent 的 Yeaft 目录。`workDir` 是 execution context，也是 project-tier instructions、Skills 与 MCP discovery 的根；它不是 Session 数据目录。

## 侧栏显示偏好

文件夹（包括子文件夹）的展开、收起状态按用户保存在 Server，与快捷入口布局一起跨客户端复用。刷新、重新登录、窗口重新获得焦点或页面恢复可见时读取最新偏好；不会实时推送到其他窗口。不同文件夹分别保存，重命名不会重置状态，其他客户端修改不同文件夹不会互相覆盖。保存失败会显示提示并恢复已确认的状态，不会假装已经同步。打开页面时，列表会先显示“加载中”，等保存的状态到了再画出文件夹，不会先全部展开再收起；5 秒内仍未取到时，文件夹按默认展开显示，并提示可以「重试」。

旧浏览器本地保存的分区状态不作为用户级偏好的来源；首次使用默认展开，之后以 Server 中保存的状态为准。

## 创建 Session

1. 在统一侧栏选择 **新建聊天**，runtime 选择 **Yeaft**。
2. 选择拥有目标工作目录的 Agent。
3. 设置 Session name 和 working directory。
4. 选择场景：「通用」「软件开发」「前端开发」「写作」「内容创作」「视频剪辑」「小学教育」或「投资」，默认通用。
5. 创建 Session。
6. 创建后在 composer 选择 model/effort，在 Session settings 编辑公告，然后发送消息。

### 从宇宙快捷输入补充正在执行的回复

自动路由选中会话后，使用与会话内普通发送相同的规则。相关的补充消息会进入已有 Turn，在下一次模型调用时一起处理，不会打断正在进行的模型调用或工具。无关消息用独立 Turn；明确选择一次性的模型或推理强度也会另开 Turn。只显示默认模型不算手动选择。

Agent 在接收补充或排入独立 Turn 后才确认发送。仅选中会话并不代表消息已送达。

### 在同一段对话中切换场景

如果页面提示「场景切换暂未确认」，先刷新核对实际保存的场景，再决定是否重试。页面不会重复提交，也不会发送正在等待切换确认的消息。

点击附件右侧的「场景」，选择会保存到当前 Session，不会自动发送消息。新消息使用新场景，已经运行的轮次保持原样。例如先用「软件开发」讨论设计，再切到「写作」整理成公告，不需要重复提供上下文。场景不限制可提的问题，也不改变模型、推理强度、权限或工作目录。

每个场景带来的是这一行的专业标准。「软件开发」像首席工程师那样，覆盖产品、设计、安全、测试、数据迁移和线上运行；「前端开发」像美术指导、交互设计师和前端工程师那样做界面：让人第一眼就喜欢、用起来顺手；做新产品先定清楚的视觉方向、不像套模板，在已有产品或品牌里沿用它的设计系统并提高完成度；在真实浏览器里按手机和桌面宽度截图检查；「写作」像编辑、事实核查员和校对那样做事，遵循 GB/T 15834、Chicago 等规范；「内容创作」覆盖账号定位、选题、小红书图文、短视频脚本与拍摄、运营、数据、带货和平台规则；「视频剪辑」像剪辑师、混音师和调色师那样，从故事、剪接到响度、调色和按平台规格交付，文件在 Agent 所在机器上、且装有 ffmpeg 时，可以直接检查和处理；「小学教育」像经验丰富的小学老师那样教语文、数学和英语：对孩子一步步引导而不是直接给答案，对家长和老师给出答案、孩子可能的误解和教法；「投资」按买方分析师和风控的方式工作，遵循 CFA 协会的职业准则；「通用」遇到健康、法律、安全等专业问题，按相应行业的注意标准来答。

助手会把整个领域过一遍，但只说和你的请求有关的部分。你问该怎么做、哪个更好，它会直接推荐一个并说明理由，而不是罗列一堆条件。问「软件开发」草稿怎样换台设备接着写，它会想到两台设备同时开着、一边有没保存的修改；只想换一个词，也只改那一个词。换的是看事情的角度和做事的标准，不是你要读的汇报格式。

### 兼容已有 Session

旧会话保留完整历史、成员和自定义定义。未选场景时继续使用原有路由，改名或改模型不转换会话。明确选择场景后，后续消息按单助手处理：旧角色数据仍保存，但不再参与该会话的消息路由。未转换的旧角色设置位于「兼容设置」；普通会话的 AI 回复不展示角色名称，旧会话也不需要先选场景。现有定时任务继续使用原有目标设置。切换场景需要支持该功能的 Agent。

选过「短视频」的会话现在显示为「内容创作」：原有的短视频准则保留，Agent 升级后还会增加小红书等图文平台。「前端开发」「视频剪辑」「小学教育」只在支持它们的 Agent 上出现；旧版 Agent 的菜单仍是原来的场景。如果把 Agent 降回旧版，用这三个场景的会话会按原来的路由回答（新建的会话由通用助手回答），Agent 再升级后场景自动恢复。

## 选择工作目录

创建 Session、修改 Session 设置和创建 WorkItem 使用同一个工作目录选择器，浏览的是所选 Agent 机器上的目录，不是浏览器本机。

- 路径按正常目录格式紧凑显示，每一段都可点击：点击开头的 `/` 或盘符可直达根目录，点击其他层级可直接返回对应目录，无需逐层后退。
- 保留 **上级目录** 按钮；Windows 下在盘符根目录再点上级，即可切换盘符。不再重复显示独立的根目录按钮。
- 在路径输入框输入或粘贴路径，按 **Enter** 或点击跳转按钮，读取成功后再确认。相对路径由 Agent 按其默认工作目录解析。
- 单击文件夹即可进入，触屏不需要双击。确认按钮始终使用当前浏览目录，不混用“选中”和“进入”两套行为。
- 加载中、路径读取失败或输入路径尚未跳转时不能确认；错误会在弹窗内显示，可修改路径后重试。

目录选择本身不会移动文件或 Session 历史。修改 Session 工作目录后，后续执行使用新的项目上下文。

Agent 重启后，如果最近的原生 Session 消息已保存、但没有对应的执行或回复记录，消息会保留并标记为「已中断」。确认可以安全重试后，可用消息的「编辑」操作手动重发；Agent 不会自动重发。

## Fork 当前 Session

在当前 Session 的侧栏菜单选择 **复制会话**，或点击 conversation 右上角的复制图标。无需填写创建弹窗，完成后自动打开同一 Agent 上的新 Session。

Fork 保留完整持久对话、公告、工作目录和场景／模型／强度配置（包括已有的兼容成员数据）。原 Session 属于 Project 时，Server 会将新 Session 放入同一 Project，继续使用统一 instruction。原 Session 不变，之后两边的对话和 Session 配置修改彼此独立。

新版 Agent 支持在生成回复期间 Fork：只复制当前活动输入之前的完整持久历史，不包含进行中 turn 的用户输入、回复或工具执行，也不会停止原 Session。安全边界会保存在该 Session 的实例数据目录，Agent 重启后后台任务恢复回复时仍可复制先前历史；旧任务没有边界记录时，只在能确认其原始用户输入的情况下恢复，否则明确拒绝，不复制半截 turn。重叠输入或并行 VP 使用最早活动输入之前的安全边界；旧版 Agent 仍需等待回复结束。断线或 Fork 进行中时入口禁用。Fork 不复制后台进程、运行任务、debug trace 或 Session memory 文件；可读取的上传附件复制到新 Session 自己的数据目录；缺失或无法安全读取的旧附件仍明确标为不可用。Project 继承要求 Server 和 Agent 均支持此能力。

在已完成 AI 回复下方选择 **从此轮分叉**，只复制持久历史开头到这轮回复结束（包含该轮），不包含后续消息；另一轮正在生成时也可使用，但所选边界必须在活动输入之前，当前回复不提供此入口。新会话仍继承相同配置和 Project，原会话不会截断或改变。需要新版 Agent 支持；旧记录缺少可靠轮次标识时不显示入口，边界不明确或会拆开工具调用/结果时会报错，不会退化为复制全部历史。多 VP 并行时以持久消息顺序为准，边界之前其他 VP 的消息也会保留。

旧历史存在重复消息 ID 时，复制仍逐条保留全部持久记录，按原始追加顺序分配新的唯一 ID 和序号，不修改源 Session，也不按文本或时间戳去重。能唯一确认的消息引用会重写；无法确认的引用保存在目标记录的 `unresolvedMessageReferences` 中，不随意关联或误折叠消息。原始引用及候选目标仍可检查，引用正文与工具调用/结果保留。仅含歧义旧 ID 的单条消息边界仍拒绝使用；完整复制或可靠的轮次/快照边界不受重复 ID 阻断。

## 合并两个 Session

在 Session 侧栏菜单选择 **合并会话**，再选择同一 Agent 上的另一个原生 Session。对话 Header 保留 **复制会话（Fork）**，不再显示合并图标。两边都必须停止生成回复，且 Agent 支持合并能力；断线或旧版 Agent 不会静默派发。

合并会创建并打开一个全新的 Session，不覆盖、归档或删除两条来源。新 Session 沿用发起侧的工作目录、公告、场景、模型配置和 Project instruction，并保留兼容成员数据。持久历史中的共同轮次只保留一次，之后按用户发送时间合并完整 turn，文字、工具调用与结果不会拆开；没有共同历史时，全部 turn 按发送时间排序。仅提问文本相同不算共同历史，来源或分歧存在歧义时明确报错，不猜测去重。附件验证字节后复制到新 Session 的数据目录；共同附件内容冲突或所有副本均不可用时拒绝合并，不静默丢弃。运行任务和后台进程不会迁移。

Fork 和合并后的 Session 使用可重建的文本及工具历史继续对话，不沿用绑定原 Session 的 provider 私有签名或推理 continuation；源 transcript 保持完整。

合并不是 Git 合并，也不修改工作目录里的文件。Project 归属由 Server 保存，不会采用另一条来源或浏览器传入的 Project；要使用另一条来源的配置与 Project，应从那条 Session 发起。

## 旧会话路由

仅未启用场景的旧会话沿用以下路由。没有 mention 的消息发送给 default VP。用 `@VPName` 指定子集：

```text
@Linus 实现最小安全修复，并补充定向测试。
```

```text
@Martin 审查当前 diff 的正确性、回归风险和缺失测试。
```

```text
@Linus @Martin 并行给出实现与审查视角。
```

选择多个 VP 时，Yeaft 只持久化一条 canonical user message，然后 fan-out 到独立 VP engine。每个 VP 有自己的 persona 和 memory view，流式输出自己的回复，并使用当前 Session 允许的工具；历史发言归属仍保存于底层记录。

## 规划与进度

原生引擎已禁用 `TodoWrite` 和 `StartPlan`，不再为展示清单而要求模型反复更新步骤或额外调用规划工具。工具注册表和 `DiscoverTools` 都不提供这两项能力。

你仍可要求 VP“先调查并给出方案，不要修改代码”，通过普通回复讨论目标、约束、风险和验证方法。当前没有单独的 Plan Mode 开关；这类对话要求不等于文件系统只读沙箱。

旧 Session 中的 checklist 仍可回放；Claude Code / Copilot CLI 自身的工具行为不受影响。需要跨 turn 的持久任务状态与验收时，使用 [Work Center](./work-center.md)。用户自定义的 Project 指令、VP soul 和 `planInstruction` 数据不会被自动改写；如果自定义指令仍强制要求调用旧工具，应自行更新。

## Handoff 与 sub-agent

多 VP 协作是显式的：

- `RouteForward` 把消息发送给同一 Session 的另一个 VP，并在可见 VP turn 中记录 route。
- Sub-agent 是 VP 创建的子 worker，用于有边界的并行调研、实现、审查或探索。
- 后台 shell job 和 sub-agent 有持久的 Session-scoped task record；parent 可以 list、inspect、cancel 或消费 terminal result。

VP 文本里的 `@mention` 不会触发 runtime handoff。VP-to-VP 转交必须调用 `RouteForward`。

## Session history 与状态

刷新或重连时，「执行状态」会从新版 Agent 恢复仍在运行的线程的请求和工具执行次数，不需要等下一次工具调用。这里显示的是 Agent 上报的实际执行次数，不是对话历史里的工具记录条数。

在正在运行的轮次里，点击「请求」「工具」计数旁的 **详情**，可以看这个页面实时收到的最近 128 条工具调用，最新的排在最上面。并行执行各有自己的列表。展开不会加载历史，执行结束后入口消失。提问卡、待办和转交提示仍留在对话里。

点击「执行状态」里的「出错详情」可查看错误消息、错误码和对应的轮次／线程。开始新一轮后，状态栏不再显示已结束轮次的旧错误；最新一轮的错误和仍在运行的并行轮次自己的错误会保留。这个规则不改动对话历史。

错误详情来自 Agent 当前的状态快照，不是长期错误日志。切换会话或浏览器重连后，符合当前显示条件的错误仍可查看；Agent 重启前的错误不保证恢复。旧版 Agent 未提供详情时会明确提示。错误文本按纯文本显示，长内容可滚动、选择复制。

Yeaft 页面提供：

- 分页、virtualized conversation timeline；
- history outline，以及按文本/speaker 搜索；
- per-VP turn block 和 quote/edit-as-new message action；
- 包含公告、roster 和 active background task 的 Session status；
- composer 内的 model/effort selector；
- 可选 debug panel，用于检查 provider request、tools、tokens 和 stop reason；不再显示 Dream event 或设置。

Session status 中，VP 名称、运行状态与停止操作位于同一标题行。执行期间显示当前线程本轮累计的输入/输出 token（完整数字，输入含缓存、不含子 Agent），以及模型请求、实际工具执行和失败调用次数；这些是 Provider 上报的使用量，不是当前上下文大小，也不是整个 Session 的历史总量。未上报的 token 显示“未提供”，不会当作零。

有失败时，点击“失败”可按工具展开执行、失败及拦截次数。失败包括未实际执行即被拦截的调用，执行次数同时包含成功与失败；参数、输出和错误原文不复制到失败计数事件。工具明细最多保留 128 种，总计仍覆盖全部。旧 Agent 未提供明细时会明确提示。连续失败、重复结果等异常原因直接显示在执行摘要中。断线或 turn 结束后，实时统计不保留为历史进度。

在「会话状态 → 后台任务」中，将鼠标悬停在运行中的子 Agent 上，或按 Tab 聚焦任务标题，可预览模型、实际推理强度和专业场景。点击、轻触或按 Enter 可展开并保留详情。模型和强度跟随最近一次发出的请求（包括重试）；适配器尚未报告实际强度时显示「未报告」。缺少这些元数据的旧任务不显示这组详情。

Debug output 可能包含 project 文本与 tool result，只应由当前 owner 使用，不要随意导出或共享。

### 回复中的图片

工具返回的图片以紧凑缩略图穿插在回复文字之间，点击可放大并浏览同一回复的其他图片。新生成的 Yeaft 图片按来源工具定位，即使图片上传晚于后续文字，或重新加载历史，也会回到对应位置。旧图片缺少来源标记时保留原有位置，不猜测其与某段文字的关系。

### 回答 AskUser 提问

VP 调用 `AskUser` 时会出现交互卡片。切换 Session 后返回，只要 Agent 中的提问仍有效，就可以继续回答。

- 点击提交后显示“等待 Agent 确认”，不代表回答已被接受；收到 Agent 确认或已持久化的回答历史后才显示成功摘要。
- 15 秒仍未收到确认时，可以检查连接并使用“重发回答”；重发沿用原问题身份，不会重复完成同一个提问。
- Agent 暂不可用时显示可重试提示；问题已过期、执行已取消或 Agent 重启后等待请求已丢失时，需要让 VP 重新提问。重发不会复活已经结束的 turn。

## 用文件夹组织 Session

文件夹（Project）像文件树一样在统一侧栏中组织 Session。你可以：

- 用「新建文件夹」创建文件夹，或在文件夹菜单里新建子文件夹，最多嵌套五层；
- 重命名、移动（拖拽，或文件夹菜单里的「移动到」）与删除文件夹；文件夹不能移进自己或自己的子文件夹；
- 把原生 Yeaft Session 拖进文件夹，或拖到列表最下方移回顶层；
- 在不丢失 cross-Agent identity 的前提下重排 Session；
- 为每个文件夹设置一条指令。

文件夹指令作用于这个文件夹及其所有子文件夹中的 Session。路径上有多个文件夹设置了指令时，Session 会按从外到内的顺序收到全部指令，并标出各自的文件夹路径；Agent 看到的 Project 名称就是文件夹路径（例如 `Sydney / Parental Control`）。删除文件夹会一并删除其子文件夹，但不会删除 Session：其中的 Session 都移到被删文件夹的上一级，没有上一级时回到顶层。

文件夹不会合并 Session transcript 或 storage。对于运行在某个 Agent 上的 Session，Yeaft 可以把同一 Agent 的兄弟 Session ID 加入 scoped recall，并注入保留来源 Session identity 的只读 summary；同一顶层文件夹下（含所有子文件夹）的 Session 都算兄弟，因此把 Session 移进子文件夹不会缩小这个范围。其他 Agent 上的 Session 仍会显示在 browser catalog，但当前 runtime 不会把它们当成本机 memory scope。

## Memory 边界

原生 memory 按 scope 管理，不是全局共享：

- user scope 保存持久用户偏好；
- VP scope 与 Session-nested VP scope 保存角色知识；
- Session scope 保存当前协作的共享事实；
- Project instruction 可用于成员 Session，但不会自动召回兄弟 Session；
- 当前 storage reader 支持的 topic 与 legacy compatibility scope。

Dream/H2-AMS 已从当前 runtime 退役。原生 turn 只使用当前 Session transcript 的有界 history window；旧 memory 文件和 index 留在磁盘，但不会读取、迁移、同步、召回或注入。历史真实消息与常规 debug 记录保留，turn 后 compact 作为独立 history-window 能力继续存在。旧 enable/manual Dream 命令只返回 disabled，UI 不再提供 Dream debug tab 或设置控件。

## 将持久工作移到 Work Center

当目标需要角色接力、等待、重试、审查或跨越当前 turn 的执行时，在 Session composer 使用 **Create WorkItem**。Runtime 会写入来源 Session identity，并创建 Agent-level WorkItem；之后由 Work Center 拥有其合同、Coordinator conversation、Action graph、Runs 和 recovery。

参见 [Work Center](./work-center.md)。

## 需要记住的边界

- Yeaft 只有 Session，不存在原生 chat/group 两种 mode。
- VP 的 model 设置当前是 `primary` 或 `fast` hint；Session 可以 override 精确 provider/model 与 effort。
- 原生工具 registry 由 engine 共享并按 policy 过滤；工具可用性不是另一种 mode switch。
- Project 负责组织和有边界的 context，不是 repository、worktree 或第二个 memory owner。
- Work Center 是 Agent-level durable execution，不是另一个 Session。

## 相关页面

- [选择代码 Agent 路径](./choose-backend.md)
- [Provider 与 model 配置](../yeaft-config.md)
- [Yeaft engine 内部实现](../tech/yeaft-engine.md)
- [已退役的 H2-AMS 实现](../tech/yeaft-memory.md)

## 图片与模型视觉输入

原生 Yeaft Session 的受支持图片附件会随用户消息直接输入视觉模型，不需要调用 `ViewImage`。后续追问或恢复会话时，进入上下文窗口的历史图片从本实例、同 Session 的附件文件恢复；文件缺失或被上下文预算省略时，会明确标记，界面缩略图不代表模型仍能看到图片。`ViewImage` 用于读取本地文件，其结果直接作为多模态工具输入，不要求先裁剪或 OCR。新附件随 Session 存在实例数据根，不依赖 Agent 启动目录。
