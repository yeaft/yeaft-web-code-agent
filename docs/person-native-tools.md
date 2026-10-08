# Digital Person 原生基础工具

Digital Person 默认具备一组真实的原生工具，不再只有认知方法和纯计算脚本。工具直接复用 `agent/yeaft/tools/` 的定义、JSON Schema、执行函数和 `ToolRegistry` dispatch；仍由当前认知模型通过 `next.capability` 请求，不增加选择器模型或另一条 Agent/Session。

## 当前支持

| 能力 | 执行约束 |
| --- | --- |
| `FileRead` / `FileWrite` / `FileEdit` | 使用现有文件读写编辑实现，包括原有分页、版本提示和错误结果。读写不是事务；取消不能撤销已发生的修改。 |
| `Glob` / `Grep` / `ListDir` / `DiskUsage` | 使用原生查找、目录和磁盘占用工具。未提供 managed CLI 安装生命周期，已有 CLI 可用时使用，其他情况按原生工具回退 Node 实现。 |
| `ApplyPatch` / `NotebookEdit` | 使用原生补丁校验和 notebook 编辑；运行时写入失败可能留下部分修改。 |
| `GitRead` | 使用原生只读 Git 证据契约，不 fetch、不创建 worktree；执行目录来自部署工作目录。 |
| `Bash` | 只支持前台 Shell。原生超时、进程树清理和输出捕获约定保持不变；Linux 需要原生工具所要求的 systemd 或 unshare 支持。不支持 `background:true`，也不创建假的 Session TaskManager。 |
| `WebSearch` / `WebFetch` | 使用原生网络实现和 AbortSignal；搜索配置来自实例配置。搜索源不可用时返回真实错误，不伪造搜索结果。 |
| `Skill` | 使用现有 SkillManager 的 bundled → instance user → project tiers 和覆盖顺序，只读 list/view/search/load。不会把 Person-created `Script.*` 发布到普通 Skill 库。 |

`workDir` 是部署传入的执行目录；`yeaftDir` 仍拥有实例配置、Person 数据和 user skills。缺少显式 `workDir` 的程序调用兼容使用进程工作目录。Person transcript、能力经验和创建的脚本只写入自己的 repository；没有普通 Session transcript 或 Session 身份。

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
- `ToolRegistry` 超时仍是失败，即使底层 promise 随后成功。无法确认 Bash 进程树退出时终止当前活动，不继续安全重试或把结果算作成功。取消后本服务在旧活动 join 结束前不启动同 owner 的新活动。
- 此本地 join fence 不提供跨进程宿主副作用锁。若多个服务进程使用同一 Person 存储，既有 repository lease/cancel fence 能阻止旧认知提交，但不能终止另一个进程或另一台宿主上的外部动作；不要在旧执行宿主退出未确认时恢复外部写操作。

## 尚不支持的 Session 专属工具

不注册 `AskUser`、`HistorySearch`、后台 Task 工具、子 Agent/VP 工具、`RouteForward`、Work Center 创建、MCP、worktree 管理、JS REPL、图像生成与 `ViewImage`。这些分别需要交互中继、Session 历史归属、持久任务/Agent/路由生命周期、连接管理或 provider 图像内容块传递，当前 Person 不能完整提供。

Person 使用自己的 `Recall` 和只读 history search API，不混查普通 Session。工具发现使用自己的 catalog，不创建第二个 DiscoverTools 选择器。生成的 QuickJS 脚本仍只能进行纯 JSON 计算，绝不能通过创建能力得到任何原生 host 权限。
