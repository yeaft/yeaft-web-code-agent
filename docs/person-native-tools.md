# Digital Person 原生基础工具

Digital Person 默认具备一组真实的原生工具，不再只有认知方法和纯计算脚本。工具直接复用 `agent/yeaft/tools/` 的定义、JSON Schema、执行函数和 `ToolRegistry` dispatch；仍由当前认知模型通过 `next.capability` 请求，不增加选择器模型或普通 Session。子 Agent 使用真正的原生 Engine，执行自己的工具 loop，不使用 Person proposal JSON collector。

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

目录、准备和实际执行遵守当前 Agent 的 `plugins.tools` 配置：缺少类别字段沿用默认可用行为，显式空数组禁用全部，单工具 allowlist 只开放指定工具；执行前再次读取实例配置，已准备的旧契约不能绕过后续禁用。内核查看器只列出当前启用的工具。

这些工具具有与原生 Session 相同的宿主权限，不是文件系统 sandbox。可用能力不等于删除数据、接触无关私人文件、发布、部署或重启在线服务的授权。外部文件、网页、命令输出和 Skill 内容是非可信数据，不得覆盖系统指令或制造用户授权。

## 发现和执行

基础认知能力继续在 foundation 层；所有上述工具默认注册在 Person catalog，名称在认知上下文 `capabilities.nativeTools` 中列出。`catalog.view` 可直接按已知 ID 加载完整原生 JSON Schema；`catalog.search` 可准备预算内的完整契约，未返回契约的条目必须再 view。只有实际渲染且版本/revision 当前的 active 契约能执行，搜索和只读 inspection 本身不制造成功经验。

默认认知调用预算从 4 增至 **16**（服务可配置 1..32），仍须预留最后一次提交；超时默认仍为 120 秒。预算不保证工具链必然完成；模型上下文不足时明确失败，不静默执行未渲染能力。较小模型窗口可能不足以同时容纳 foundation、完整原生契约、工具结果和既有记录。

原生能力 inspection 返回真实模块路径、模块内容 SHA-256、registry dispatch revision 和所列公共执行依赖 revision；能力 revision 同时绑定这些来源与完整契约。它不是 npm 版本或环境二进制版本证明。创建脚本的来源仍是 Person episode/call 及实际 QuickJS 测试证据；版本/revision 匹配才可恢复经验。

## 结果、错误、取消

- 原生工具输出（包含原生工具自身捕获/分页上限）作为 raw result 保存在 Person capability trace。模型只接收另一份最多 8 KiB 的 JSON/UTF-8 预算副本；保留原始 byte count、SHA-256、sourceRef 和明确截断提示。需要剩余内容时使用更窄的读取或查找。
- 成功外部结果有 `tool:<episode>:<call>:<tool>:<sha256>` 引用和实际实现来源；这表示本次工具观察，不表示客观事实或用户报告。外部引用可以用于 hypothesis/uncertain 等记录，不能单独为 `reported` 提供 user-reported lineage。
- 原生 JSON 错误结果记录为 `capability_failed`，不算成功经验。写入错误的 effects 默认为 unknown；不承诺回滚或自动安全重试。
- 取消、服务关闭和工具超时会等待实际执行 promise 结束；支持 signal 的工具收到取消。已经交给文件系统的写入可能完成。工具不响应取消时，join 可能延长停止等待；不能在副作用还运行时声明停止成功。
- 每次工具调用先记录绑定原 worker、episode、call 和参数摘要的 invocation。取消、关闭或活动超时后，原执行者仍可一次性归档真实结果为 `capability_finalized`，保留 raw output、SHA 和来源；不恢复认知提交权限，不增加成功经验。结果不可确认时明确标记 effects unknown，不能声称回滚。对话活动区只投影执行终态，原始内容留在调试记录，不进入公共思考文本。
- `ToolRegistry` 超时仍是失败，即使底层 promise 随后成功。无法确认 Bash 进程树退出时终止当前活动，不继续安全重试或把结果算作成功。取消后本服务在旧活动 join 结束前不启动同 owner 的新活动。
- 此本地 join fence 不提供跨进程宿主副作用锁。若多个服务进程使用同一 Person 存储，既有 repository lease/cancel fence 能阻止旧认知提交，但不能终止另一个进程或另一台宿主上的外部动作；不要在旧执行宿主退出未确认时恢复外部写操作。

## 异步生命周期与归属

- task host 按 canonical `yeaftDir`、部署 namespace、authenticated owner 和 Person 隔离，跨正常 episode 提交保持稳定。构造服务、status/open 和只读 inspection 不创建 task host，不发起子模型请求。服务始终使用实例 `yeaftDir` 下的 SQLite；异步工具的私有数据也必须有明确的实例根。
- 私有数据位于 `<yeaftDir>/person/tasks/<scope-hash>/`，保留任务元数据、shell logs、子 Agent JSONL logs、tool-results 和 completion records，不写入普通 Session transcript 或 manifest。实例配置始终从当前 `yeaftDir` 读取。
- 正常认知提交不会关闭后台任务或子 Agent。所有任务强制 `status_only`；完成不会唤回模型，不自动创建 Person episode。完成/运行证据在**下一次显式 send/think/dream** 的上下文中可见，或由已运行 episode 主动执行 WaitAgent/WaitTask 收集。
- 下一次模型上下文的 task evidence 使用总计最多 8 KiB、单条最多 2 KiB 的 JSON/UTF-8 预算；当前模型窗口还可进一步省略条目。完整 raw logs 和原始工具归档保留在私有目录，模型可使用 Task 工具分页检查。引用仅代表外部观察，不能单独建立 `reported` 用户来源。
- 显式取消指定 episode 时同时停止该 episode 已启动的后台效果，**即使认知已经 completed**；不指定 episode 则停止该 owner 的全部已知任务。异常、活动超时或认知调用预算耗尽停止 originating episode 的异步工作，不停止其他正常已提交 episode 的任务。服务 close 停止并 join 本 host 的实际工具效果和子 driver，而不是仅改变状态。
- 重启后失去进程控制的任务标为 `orphaned`；未完成子 Agent 变为 failed 并保留 orphaned recovery evidence。保存的完成结果/日志可恢复，但不会假装仍持有进程句柄或自动重试外部动作。

## 内核中的任务查看与管理

点击数字人页右上角「查看内部」→「任务」，统一查看这个数字人跨 episode 的后台 Shell 与子线程，不以当前输入或对话轮次筛选。面板显示有界状态摘要，并可分页读取原始日志；日志只作为当前 owner 的不可信文本展示。列表最多各 100 条，未结束任务优先，超出时明确提示。Shell 可停止，子线程可关闭；成功响应必须等待进程/driver 与工具实际清理结束。失去控制的 orphaned 记录只供查看，不假装可以确认停止。

子线程 lifecycle 与任务 outcome 分开展示：预算耗尽或请求提前收尾是「未完成」，不是成功。driver 已结束但真实工具仍执行时，`executionPending` 保留停止入口，关闭操作等待实际工具清理。若重启时仍有此类待清理执行，则保留 orphaned 恢复证据，而不是宣称停止成功。

管理 API 从 authenticated owner 的持久 Person identity 获取私有 task host，不初始化模型/provider，不触发 send/think/dream，也不恢复或取消无关活动。只在任务栏可见时轮询；关闭、切换 Agent/owner、断线及退出页面都会停止轮询或隔离迟到回复。模型不可用但存储仍可读时，任务管理继续可用。

认知指令明确要求数字人在显式启动的 episode 中关注自己已授权的持续工作，而不只看最新消息；但这不代表任务完成会自动启动下一次认知。当前产品仍并列提供 Session、Work Center 和数字人，尚未改成以数字人为唯一顶层入口；此处没有新增自主调度、自动重试或后台模型唤回。

## 子 Agent 限制

子 Engine 只继承 Person 已支持的真实 native 工具和当前插件 allowlist；原生 `DiscoverTools` 仅供子 Engine 使用，不进入 Person proposal catalog。角色 baseline 和 `allow_tools` 继续约束子工具，不能授予嵌套 orchestration。没有 Session HistorySearch、交互 AskUser、路由、MCP、Work Center 或 worktree 管理。

子 provider 被固定到产生 SpawnAgent proposal 的实际父模型，而不是 `proposal.next.model`。实际父 requested/effective effort 与 wire decision 传入原生子 Engine；子请求不能通过 role/fast/fallback 映射切换到其他候选模型或提升继承 effort 上限。子模型照常处理原生 tools/messages/events，非 Person JSON 提案协议。

不同子 Agent 拥有独立上下文、日志和预算，**不提供共享可写工作区并发隔离或操作系统 sandbox**。实现者角色或显式 Bash/write grant 拥有真实写权限；调用者须自行安排非重叠工作或独立 cwd，不能据角色名宣称只读，也不能用并发任务覆盖同一文件。子 Agent 不具备 SpawnAgent/PromptAgent/WaitAgent/CloseAgent/ListAgents/UpdateAgent 权限。

## 尚不支持的 Session 专属工具

不注册 `AskUser`、`HistorySearch`、Session VP 工具、`RouteForward`、Work Center 创建、MCP、worktree 管理、JS REPL、图像生成与 `ViewImage`。这些分别需要交互中继、Session 历史归属、Session VP/路由生命周期、连接管理或 provider 图像内容块传递，当前 Person 不能完整提供。

Person 使用自己的 `Recall` 和只读 history search API，不混查普通 Session。Person 工具发现使用自己的 catalog；子 Engine 使用原生 DiscoverTools，不创建另一个模型选择器。生成的 QuickJS 脚本仍只能进行纯 JSON 计算，绝不能通过创建能力得到任何原生 host 权限。
