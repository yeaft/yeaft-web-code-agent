# Sub-agent 执行收敛与诊断

## 目标与边界

工具活动不等于任务进展。一次委派一个明确、独立的结果，提供工作目录、基线和完成证据，让子 Agent 自主选择步骤；父 VP 保留整体规划及最终交付责任。比如「审查这份 diff 是否引入回归，返回可复现的问题及未验证范围」，而不是逐条指定读取顺序、同时塞入多个不相关任务并附极小调用上限。不要为了并行而拆分单个琐碎读取，也不要在预算耗尽后自动重新 Spawn 同一任务。

预算状态属于 child ToolRegistry 和内存中的子任务记录；Engine 仅在 `isSubAgent` 的 provider 边界读取收尾策略，不修改父引擎 registry、Session config 或磁盘 schema。在线 Agent 需要通过正常发布升级后才生效。

## 执行预算

- 默认最多执行 64 个工具；`implementer` 为 128。`budget.max_tool_calls` 可显式覆盖。
- 默认 elapsed-time 上限为 15 分钟；`budget.wall_time_ms` 可覆盖，包含等待后续提示的时间。
- token / query-turn 上限仍可选。`max_turns` 不是工具轮次或工具次数。
- 工具配额在实际 dispatch 前同步预留，别名使用 canonical tool 计数，并行调用共享同一个配额；MCP / DiscoverTools 不绕过 child registry。
- token 配额在 provider usage 事件到达时检查，因此只能阻止后续调用，不能撤回已消费 token，也不是逐 token 硬上限。
- 通常委派时省略 `budget`，不要因希望节省 token 就人为给多文件 review 设置 14/24 次等极小额度。上限是止损线，不是应完成的调用数量。
- 接近工具上限时，在下一次 provider 请求中提示尽快交付；达到上限后禁止新 dispatch，等待已预留工具完成，再以已有 conversation 请求一次无工具报告（最多 4096 output tokens）。不另启调查、不重复加载历史、不对报告自动续写或重试。
- 收尾仍受原 wall-time、token 和用户取消控制，不保证网络故障/时间耗尽时一定取得模型报告。空报告返回明确的未完成说明；已有正文仍保留，报告是否收到单独记录。
- 结果始终是 `budget_exceeded`，报告不是任务成功证明；TaskManager 投影为失败而非 succeeded，父 VP 应根据已检查范围决定下一步，不自动从头重跑。
- 已经在执行的外部副作用只能发送 abort，不能保证撤回或立即终止；不得盲目重试。新 dispatch 在 abort 后被阻止。

默认值是保守的工程安全上限，尚无线上 A/B 成本数据支持“最佳值”结论。复杂任务应依据目标和已有证据显式调整，不以取消全部限制代替任务划分。

## Persona 与交付契约

`explorer`、`reviewer`、`researcher` 按 persona 模板工具表构建结构性 allowlist。`Read` 兼容别名解析为 `FileRead`；不能通过 DiscoverTools 或 MCP 热注册获得写工具。`reviewer` 增加受限的 `GitRead`，可以直接获取本地 diff，而不是寻找不可用的 Bash；它不获得任意 Shell 或 Git 写权限。`implementer` 和未指定 persona 保留原有工作工具，但仍不能递归 Spawn / AskUser / handoff。

`GitRead` 仅支持本地 status/diff/show/log，固定 argv 且输出有界。禁用 external diff、textconv、clean/process 等内容 filter 和子模块遍历；不写 Git 配置，不触发网络读取。代价是 LFS 等 filter 文件展示原始工作区字节，子模块内容需另行检查；配置过滤器无法完整检查时拒绝执行，不降级为不受限 Git。

模板角色文本在嵌入父 VP soul 前选择语言，避免内部 language marker 截断父 soul 或任务契约。`expected_output` 注入提示，但不提供 JSON Schema 强制验证；不能把它等同于已通过结构验收。

## 可观测性

ListAgents / WaitAgent 的 liveness 中附加 `execution`：实际 dispatch 次数、已结束次数（包含错误）、失败次数、剩余额度、最近 8 次工具名称和状态，以及最近 12 次只读调用中相同输入/输出的重复累计次数。不会在诊断里输出原始输入、文件内容或哈希。

重复结果只是 advisory：合法轮询、并发读取也可能重复；它不直接触发自动停止，不替代现有 stale/stalled liveness，也不能证明语义进展。父 VP 应结合部分结果和必要的有界日志决定继续、缩小任务或停止。
