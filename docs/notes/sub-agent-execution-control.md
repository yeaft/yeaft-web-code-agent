# Sub-agent 执行收敛与诊断

## 目标与边界

工具活动不等于任务进展。一次委派一个明确、独立的结果，提供工作目录、基线和完成证据，让子 Agent 自主选择步骤；父 VP 保留整体规划及最终交付责任。比如「审查这份 diff 是否引入回归，返回可复现的问题及未验证范围」，而不是逐条指定读取顺序、同时塞入多个不相关任务并附极小调用上限。不要为了并行而拆分单个琐碎读取，也不要在预算耗尽后自动重新 Spawn 同一任务。

预算状态属于 child ToolRegistry 和内存中的子任务记录；Engine 仅在 `isSubAgent` 的 provider 边界读取收尾策略，不修改父引擎 registry、Session config 或磁盘 schema。在线 Agent 需要通过正常发布升级后才生效。

## 执行预算

- 默认最多执行 64 个工具；`implementer` 为 128。`budget.max_tool_calls` 可显式覆盖。
- 默认 elapsed-time 上限为 15 分钟；`budget.wall_time_ms` 可覆盖，包含等待后续提示的时间。
- token / query-turn 上限仍可选。`max_turns` 不是工具轮次或工具次数。
- `max_llm_calls` 可选：限制 Engine 实际 provider dispatch（包括重试），不等同于 query turn。达到工具或 LLM 上限后，额外留一次无工具报告；`usage.llmCalls` 包含报告，`reportingLlmCalls` 单列，报告仍受时间/token 上限约束。此计数不代表代理内部重试或引擎外辅助 API 的 HTTP 请求数。
- 工具配额在实际 dispatch 前同步预留，别名使用 canonical tool 计数，并行调用共享同一个配额；MCP / DiscoverTools 不绕过 child registry。
- token 配额在 provider usage 事件到达时检查，因此只能阻止后续调用，不能撤回已消费 token，也不是逐 token 硬上限。
- 通常委派时省略 `budget`，不要因希望节省 token 就人为给多文件 review 设置 14/24 次等极小额度。上限是止损线，不是应完成的调用数量。
- 接近工具上限时，在下一次 provider 请求中提示尽快交付；达到上限后禁止新 dispatch，等待已预留工具完成，再以已有 conversation 请求一次无工具报告（最多 4096 output tokens）。不另启调查、不重复加载历史、不对报告自动续写或重试。
- 收尾仍受原 wall-time、token 和用户取消控制，不保证网络故障/时间耗尽时一定取得模型报告。空报告返回明确的未完成说明；已有正文仍保留，报告是否收到单独记录。
- 结果始终是 `budget_exceeded`，报告不是任务成功证明；TaskManager 投影为失败而非 succeeded，父 VP 应根据已检查范围决定下一步，不自动从头重跑。
- 已经在执行的外部副作用只能发送 abort，不能保证撤回或立即终止；不得盲目重试。新 dispatch 在 abort 后被阻止。

默认值是保守的工程安全上限，尚无线上 A/B 成本数据支持“最佳值”结论。复杂任务应依据目标和已有证据显式调整，不以取消全部限制代替任务划分。

## 运行中调整

父级在 `ListAgents` / `WaitAgent` 检查计数、已有证据与剩余目标后，使用 `UpdateAgent` 调整活跃任务；不需清零上下文再 Spawn。不自动按工具活动扩额，避免把空转当作进展。

- `budget` 是部分**累计绝对上限**：如从 64 次改为 96 次，而不是再加 96 次；未指定维度不变，原用量不清零，时间从最初启动计算。支持 `max_tool_calls` / `max_llm_calls` / `wall_time_ms`，以及原 token/query-turn 上限。时间修改会重新设置 watchdog；收紧到已用时间以下会立即终止。
- `reason` 必填，说明实际证据及剩余工作；每次调整记录原值、新值和原因，状态可在 liveness 查看。不通过这个工具发起新 query；需要补充任务说明时另用 PromptAgent 并收集回复。
- 只允许同 Session/VP/thread 的父级控制。终止、abort 或已进入无工具收尾的任务不能复活或追加额度；子任务不持有 UpdateAgent。
- 默认安全上限不变，无自动无限续期。父级可在有必要时显式提高或降低上限；这是编排控制，不是新的用户权限或生产操作授权。

## Persona 与交付契约

`explorer`、`reviewer`、`researcher` 默认按 persona 模板工具表构建 allowlist。`Read` 兼容别名解析为 `FileRead`；`reviewer` 默认包含受限 `GitRead`。`SpawnAgent.allow_tools` 可显式增加必要的父级已注册工具，如 `Bash`、`FileEdit`、`FileWrite`；`UpdateAgent.allow_tools` 替换额外授权（`[]` 撤销额外授权，省略则保持）。授权可在下一轮发现工具，撤销阻止后续 dispatch，不能撤回已经执行的外部副作用。

Bash 是任意 Shell/写入能力，不是只读 sandbox，也不受 cwd 的安全沙箱限制。父级必须确认任务授权和 workspace 隔离，避免并行写冲突；默认 persona 不是用户权限边界。授权不能超过父级实际 registry，也不能通过别名、DiscoverTools 或 MCP 热注册突破子级 allowlist。`implementer` 和未指定 persona 保留原有工作工具；所有子任务仍禁止递归 Spawn / UpdateAgent / AskUser / handoff。

`GitRead` 仅支持本地 status/diff/show/log，固定 argv 且输出有界。禁用 external diff、textconv、clean/process 等内容 filter 和子模块遍历；不写 Git 配置，不触发网络读取。代价是 LFS 等 filter 文件展示原始工作区字节，子模块内容需另行检查；配置过滤器无法完整检查时拒绝执行，不降级为不受限 Git。

模板角色文本在嵌入父 VP soul 前选择语言，避免内部 language marker 截断父 soul 或任务契约。`expected_output` 注入提示，但不提供 JSON Schema 强制验证；不能把它等同于已通过结构验收。

## 可观测性

ListAgents / WaitAgent 的 liveness 中附加 `execution`：实际 dispatch 次数、已结束次数（包含错误）、失败次数、剩余额度、最近 8 次工具名称和状态，以及最近 12 次只读调用中相同输入/输出的重复累计次数。不会在诊断里输出原始输入、文件内容或哈希。

重复结果只是 advisory：合法轮询、并发读取也可能重复；它不直接触发自动停止，不替代现有 stale/stalled liveness，也不能证明语义进展。父 VP 应结合部分结果和必要的有界日志决定继续、缩小任务或停止。
