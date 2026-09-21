# Yeaft Session 与 Project

**Session** 是 Yeaft 原生引擎唯一的 conversation 与协作单元。它始终是同一种结构：一个持久 timeline 和 1..N 个 VP。1 个 VP 就是专注代码 Agent；多个 VP 让你把同一个 turn 交给彼此独立的角色。

![包含实现与审查交接的多 VP Session](/images/zh-CN/session.png)

## Session 包含什么

一个 Session 保存并展示：

- Agent owner 与稳定 Session ID；
- 名称、工作目录、公告，以及创建/活动 metadata；
- VP roster 和 default VP；
- 可选的 Session-level model 与 reasoning effort override；
- 持久 messages、per-VP turns、tool results、后台任务状态和 debug traces；
- Session scope 与嵌套 VP/user memory。

Session metadata 和 history 位于所属 Agent 的 Yeaft 目录。`workDir` 是 execution context，也是 project-tier instructions、Skills 与 MCP discovery 的根；它不是 Session 数据目录。

## 创建 Session

1. 在统一侧栏选择 **新建聊天**，runtime 选择 **Yeaft**。
2. 选择拥有目标工作目录的 Agent。
3. 设置 Session name 和 working directory。
4. 选择一个或多个 VP，并指定 default VP。
5. 创建 Session。
6. 创建后在 composer 选择 model/effort，在 Session settings 编辑公告，然后发送消息。

如果没有传 roster，而 Agent 的 VP library 中存在 `omni`，runtime 可以使用**全能助手**作为默认通用助手。其内部 ID 仍为 `omni`，已有引用无需修改。显式传入的非空 roster 永远不会被静默覆盖。

全能助手可帮助处理问答、研究、写作、翻译、学习、规划、数据分析和编程执行，而不只是澄清需求或转交任务。它会根据任务选择直接回答、使用工具或协作，并遵守项目分工与授权边界。Agent 启动时会将精确匹配旧默认版本的 soul 和对应旧名称、角色、简介升级；用户改写过的 soul 或自定义元数据不会被覆盖。

## 选择工作目录

创建 Session、修改 Session 设置和创建 WorkItem 使用同一个工作目录选择器，浏览的是所选 Agent 机器上的目录，不是浏览器本机。

- 路径按正常目录格式紧凑显示，每一段都可点击：点击开头的 `/` 或盘符可直达根目录，点击其他层级可直接返回对应目录，无需逐层后退。
- 保留 **上级目录** 按钮；Windows 下在盘符根目录再点上级，即可切换盘符。不再重复显示独立的根目录按钮。
- 在路径输入框输入或粘贴路径，按 **Enter** 或点击跳转按钮，读取成功后再确认。相对路径由 Agent 按其默认工作目录解析。
- 单击文件夹即可进入，触屏不需要双击。确认按钮始终使用当前浏览目录，不混用“选中”和“进入”两套行为。
- 加载中、路径读取失败或输入路径尚未跳转时不能确认；错误会在弹窗内显示，可修改路径后重试。

目录选择本身不会移动文件或 Session 历史。修改 Session 工作目录后，后续执行使用新的项目上下文。

## Fork 当前 Session

在当前 Session 的侧栏菜单选择 **复制会话**，或点击 conversation 右上角的复制图标。无需填写创建弹窗，完成后自动打开同一 Agent 上的新 Session。

Fork 保留完整持久对话、公告、VP roster/default VP、工作目录和 Session model/effort 配置。原 Session 属于 Project 时，Server 会将新 Session 放入同一 Project，继续使用统一 instruction。原 Session 不变，之后两边的对话和 Session 配置修改彼此独立。

正在生成回复时需等待结束；断线或 Fork 进行中时入口禁用。Fork 不复制后台进程、运行任务、debug trace 或 Session memory 文件；附件引用保持原所有权。Project 继承要求 Server 和 Agent 均支持此能力。

在已完成 AI 回复下方选择 **从此轮分叉**，只复制持久历史开头到这轮回复结束（包含该轮），不包含后续消息。新会话仍继承相同配置和 Project，原会话不会截断或改变。需要新版 Agent 支持；旧记录缺少可靠轮次标识时不显示入口，边界不明确或会拆开工具调用/结果时会报错，不会退化为复制全部历史。多 VP 并行时以持久消息顺序为准，边界之前其他 VP 的消息也会保留。

## 路由一个 turn

没有 mention 的消息发送给 default VP。用 `@VPName` 指定子集：

```text
@Linus 实现最小安全修复，并补充定向测试。
```

```text
@Martin 审查当前 diff 的正确性、回归风险和缺失测试。
```

```text
@Linus @Martin 并行给出实现与审查视角。
```

选择多个 VP 时，Yeaft 只持久化一条 canonical user message，然后 fan-out 到独立 VP engine。每个 VP 有自己的 persona 和 memory view，流式输出自己的回复，并使用当前 Session 允许的工具；共享 timeline 会保留 speaker identity。

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

Yeaft 页面提供：

- 分页、virtualized conversation timeline；
- history outline，以及按文本/speaker 搜索；
- per-VP turn block 和 quote/edit-as-new message action；
- 包含公告、roster 和 active background task 的 Session status；
- composer 内的 model/effort selector；
- 可选 debug panel，用于检查 provider request、tools、tokens 和 stop reason；不再显示 Dream event 或设置。

Debug output 可能包含 project 文本与 tool result，只应由当前 owner 使用，不要随意导出或共享。

### 回复中的图片

工具返回的图片以紧凑缩略图穿插在回复文字之间，点击可放大并浏览同一回复的其他图片。新生成的 Yeaft 图片按来源工具定位，即使图片上传晚于后续文字，或重新加载历史，也会回到对应位置。旧图片缺少来源标记时保留原有位置，不猜测其与某段文字的关系。

### 回答 AskUser 提问

VP 调用 `AskUser` 时会出现交互卡片。切换 Session 后返回，只要 Agent 中的提问仍有效，就可以继续回答。

- 点击提交后显示“等待 Agent 确认”，不代表回答已被接受；收到 Agent 确认或已持久化的回答历史后才显示成功摘要。
- 15 秒仍未收到确认时，可以检查连接并使用“重发回答”；重发沿用原问题身份，不会重复完成同一个提问。
- Agent 暂不可用时显示可重试提示；问题已过期、执行已取消或 Agent 重启后等待请求已丢失时，需要让 VP 重新提问。重发不会复活已经结束的 turn。

## 用 Project 组织 Session

Project 是统一侧栏中面向用户的分组。你可以：

- 创建、重命名与删除 Project；
- 在 Project 与 **Recents** 之间拖动原生 Yeaft Session；
- 在不丢失 cross-Agent identity 的前提下重排 Session；
- 为 Project 设置一条 Project instruction。

Project 不会合并 Session transcript 或 storage。对于运行在某个 Agent 上的 Session，Yeaft 可以把同一 Agent 的兄弟 Session ID 加入 scoped recall，并注入保留来源 Session identity 的只读 summary。其他 Agent 上的 Session 仍会显示在 browser catalog，但当前 runtime 不会把它们当成本机 memory scope。

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
