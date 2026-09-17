# Work Center 定时计划

一次性任务继续使用 `scheduledFor`（epoch 毫秒）和 `scheduleEnabled`。未提供时间的普通任务保持原有行为；一次性任务到期直接启动原 WorkItem，日程状态变为 `triggered`。

## 重复计划契约

创建时额外提供 `recurrence`：

```json
{
  "scheduledFor": 1791003600000,
  "scheduleEnabled": true,
  "recurrence": {
    "frequency": "weekly",
    "timeZone": "Asia/Shanghai",
    "time": "09:00",
    "weekdays": [1, 3, 5],
    "endsAt": null,
    "maxRuns": 20
  }
}
```

- `frequency`：`daily`、`weekdays`（周一至周五）、`weekly` 或 `monthly`。
- `timeZone`：持久保存浏览器选择的 IANA 时区，不使用 Agent 的本地时区；不接受固定偏移字符串。
- `time`：严格的 `HH:mm`，表示该时区的本地墙钟时间。
- `weekly` 必须提供不重复、非空的 `weekdays`（0 为周日，6 为周六）。
- `monthly` 必须提供 `dayOfMonth`（1–31）；短月份取当月最后一天，例如每月 31 日在二月落到 28/29 日。
- `endsAt`：可省略或为 `null`，否则为 epoch 毫秒；恰好在截止时刻可以生成，调度器发现当前时间已经超过截止时刻则不再补跑。
- `maxRuns`：可省略或为 `null`，否则为 1–1000 的整数；只计算实际生成的实例，不计算跳过的时段。
- 所有输入日期限于 1970–2099 年。创建时间必须在未来。`scheduledFor` 是首个时段的下界，后端向前对齐到满足规则的时刻（不是任意首次例外）。

返回的 `schedule` 包含 `status`、`scheduledFor`、`triggeredAt`、`recurrence`、`runCount`、`lastWorkItemId`；一次性任务的后三项分别为 `null`、`0`、`null`。`scheduledFor` 是下次到期时间，不再是创建时的固定时间；`triggeredAt` 是最近实际生成实例的调度时间。重复计划用 `completed` 表示次数、截止时间或支持的日期范围已经耗尽。

重复计划的源 WorkItem 始终是 `draft`，不会执行自己的 Actions，也不会覆盖任何已完成结果。每个时段生成独立 WorkItem，拥有自己的 Actions、Runs、执行预算用量，并暴露 `sourceScheduleId`（源计划 WorkItem ID）、`scheduledOccurrenceAt`（该实例对应的时段）。手动 `start`、执行 `resume`、Coordinator 消息不能启动源计划；修改目标/验收条件只更新草稿，作用于以后生成的实例。

## 暂停、恢复与取消

`update_schedule` 接受 `{ id, enabled, scheduledFor?, recurrence?, revision? }`，并兼容原有嵌套 `schedule` 对象。`enabled` 必须为布尔值。可提供源 WorkItem 当前 `revision` 来拒绝过期编辑；前端应发送它。

- 即使原到期时间已过，仍可暂停。
- 重复计划恢复时将下一时段移动到严格晚于当前时间的位置，不补跑暂停期间的时段。
- 一次性计划过期后恢复必须明确给出新的未来 `scheduledFor`，不隐式立即执行。
- 显式提交的 `scheduledFor` 必须在未来。省略 `recurrence` 保持原规则；提供对象完整替换规则，不重置累计次数。不能将重复计划转为一次性任务。
- 已完成日程不可编辑。取消源计划后停止生成，不允许通过任何启动/恢复接口重新启动该计划；已有实例不被取消。需要再次重复执行时创建新计划。

## 离线、重启与并发

到期扫描最多合并成一个最近已到的时段，下次时间严格在未来，不回放所有离线时段。如果同一计划仍有非终态实例，本次时段直接跳过并推进，不产生重叠。`done`、`cancelled`、兼容数据的 `failed` / `error` 视为终态；当前系统中失败 Run/Action 所在的 `needs_attention`、`waiting`、`running` WorkItem 仍然未结束，需完成或取消实例后才会生成下一次。

日历计算独立于执行调度。夏令时导致本地时间不存在时跳过当天；时钟回拨产生两个相同本地时间时仅选择较早的那个。SQLite `BEGIN IMMEDIATE` 在一个事务里完成到期检查、生成实例、入队启动、推进日程；唯一 `(sourceScheduleId, scheduledOccurrenceAt)` 索引进一步防止重启或并发扫描重复生成。事务失败不消耗次数。

## 来源与附件

实例只继承源计划已持久确认的来源、Session context、关联 Session、验收条件、执行策略快照、交付权限、记忆选项与执行预算限额；不继承历史用量、结果、停止原因或执行 claims，不重新从请求中授予权限。

附件通过源 owner 目录的文件描述符读取，拒绝符号链接，校验大小与 SHA-256，然后用新 ID 写入实例自己的只读 owner 目录，不共享路径。可恢复的失败清理未提交实例的附件。进程若在文件写入后、数据库提交前硬崩溃，可能遗留无数据库引用的附件目录；不会生成重复任务，但目前没有自动垃圾回收。附件失败发出 `work_item.schedule_failed`，保留到期时间供后续重试，不静默丢失输入。

存储迁移为 schema 41，采用新增列和索引，保留所有一次性日程和历史执行结果。
