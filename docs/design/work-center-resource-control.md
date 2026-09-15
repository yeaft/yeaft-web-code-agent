# Work Center 持久资源控制

资源控制属于 Agent 实例的 Work Center，不改变 Engine / Session 的全局行为。SQLite 中的 `work_item_execution_controls` 与 `work_item_resource_requests` 保存累计限额、停止原因与请求账本。

## 默认限额

| 字段 | 默认值 | 范围 |
| --- | ---: | --- |
| `maxRequests` | 200 | WorkItem 全生命周期 Coordinator + Action 请求 |
| `maxTokens` | 2,000,000 | WorkItem 全生命周期 token 准入预算 |
| `maxRunRequests` | 40 | 每个 Run 的请求数，包括内部重试和辅助调用 |
| `maxActionAttempts` | 3 | 同一个 Action 所有 generation 的累计 Run 数 |
| `maxCoordinatorFailures` | 3 | WorkItem 累计 Coordinator 失败次数，不因成功或重启清零 |

实际 provider dispatch 前，`BEGIN IMMEDIATE` 内原子检查并预留请求数与估算 token。原生 adapter 使用现有 `onRequestStart`（紧邻 fetch）；普通 legacy adapter 在调用/迭代前预留，兼容未实现 callback 的 adapter。原生 adapter 必须遵守每个真实请求都触发 callback 的既有契约。认证刷新等隐藏重试也各占一次请求。

失败、取消或缺失 usage 不退还请求数。Token 准入采用序列化 system/messages/tools 的 UTF-8 字节数 / 3 向上取整，加上请求的最大输出 token；未指定最大输出时预留 16,384。这不是 tokenizer 精确计算，也不是账单或成本保证，图片、reasoning、provider 特定 wire 参数可能产生偏差。完整响应的 reported usage 取代本次估算；部分/未知响应保留估算与已报告 usage 中的较大值。若真实消耗超出 token 限额，保留真实值并阻止后续请求，不能撤回已发生的消耗。

在途请求不显示为免费：`chargedTokens` 包含其预留值，`totalTokens` 只表示已报告值。历史无 usage 的请求、崩溃及不明确的结果继续占用预算；只导入一次 legacy Run/provider-turn 数据，重启或响应回放不重复相加。旧记录若没有持久化请求/usage 信息，无法重建真实账单。旧 Run 的请求数取已记录请求数、已派发 EngineTurn 数及 running 最低一次的最大值。

## 持久停止

拒绝请求或耗尽重试额度时，持久化 `stopReason` 并将 WorkItem 置为 `needs_attention`。SQLite 状态 fence 防止其他自动状态变迁清除此状态（用户取消仍为 `cancelled`，但保留原因）。Action claim、Coordinator mailbox/recovery、provider dispatch 和工具的运行检查共同阻止继续执行。已经发出的请求/外部副作用不能被保证撤回，迟到的 usage 仍记账，但决策仍受原有 revision/lease fence 约束。

Coordinator 失败使用持久指数退避（首次 1 秒、2 秒……上限 5 分钟），达到失败额度后停止。用户消息可以越过退避等待，不能越过硬停止。正常 shutdown/abort 不作为 provider 失败计数；重启发现未完成且不可恢复的 Coordinator turn 计失败。Action 的代际 `attempt` 字段保持兼容，额外以全部历史 Run 数限制 lifetime attempts；生成新 Action 仍受同一 WorkItem 的总预算限制。

自动 guidance、更新目标、retry Action、暂停 watcher、取消/重启都不清除停止原因。只有明确用户 resume 可以解除它；额度不足时须先增加相应预算。追加预算本身不启动执行、不清除停止原因、不清零 usage/failure/attempt。

## 浏览器/API 契约

detail 和 summary 都包含 `executionControl`：

```js
{
  limits: { maxRequests, maxTokens, maxRunRequests, maxActionAttempts, maxCoordinatorFailures },
  usage: {
    llmRequestCount, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens,
    reservedTokens, chargedTokens, unknownRequests, inFlightRequests
  },
  stopReason: null, // 或 { code, at, runId?, actionId?, attempts?, failures?, turnId?, estimatedNextTokens? }
  breakdown: { coordinator: /* 同 usage */, actions: /* 同 usage */ },
  coordinatorFailures,
  retryAfter, // epoch milliseconds；0 表示无等待
  tokenAccounting: 'estimated_admission_reported_usage_unknown_retained'
}
```

`executionStats` 的请求/token 已包含 Coordinator + 全部 Action，不要再把 breakdown 或 Runs 相加；loop/tool 仍来自 Run。`reservedTokens` 是未获完整 reported usage 的保守占用（包括未知请求），不应与 `chargedTokens` 再相加。

停止 code：`work_item_requests_exhausted`、`work_item_tokens_exhausted`、`run_requests_exhausted`、`action_attempts_exhausted`、`coordinator_failures_exhausted`。

通过现有 `work_center_request` relay：

- `op: 'extend_budget'`，payload `{ id, revision, additions: { maxRequests?: 100, maxTokens?: 1000000, ... } }`。仅上述 limit 字段的正安全整数增量可用；必需至少一项；revision 必须匹配。返回更新 detail，revision +1，不启动执行。
- `op: 'resume'`，payload `{ id, revision }`。使用最新 revision；返回 detail。若 WorkItem 总请求/token、失败或触发停止的 Action attempts 已耗尽，先增加预算。Run 限额停止后 resume 会结束旧 Run，后续新 Run 使用相同 `maxRunRequests`。动态任务交回 Coordinator；legacy 任务恢复未完成 Action 的新 generation。

Service 仅在 `requestContext.userOriginated === true` 时接受这两项操作；该上下文由已有浏览器 bridge 设置，不读取 payload 自报的权限。Server 继续使用已有 owner-scoped relay。Store/controller 是可信内部边界，不向模型工具暴露增加额度或解除停止能力。
