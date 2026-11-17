# 数字人的并发用户轮次

`episodeId` 是执行轮次身份，不是主题。空闲时直接沿用原 admission；运行中发送调用一次原生 provider 的有界文本路由（5 秒、256 output tokens、4096 字节结果、无工具/附件内容），判断补充某一运行轮次或开启并行轮次。复用 Session thread classifier 的 prompt/parser；失败时单运行轮次保持补充兼容，多运行轮次新开。重试先查 durable receipt，不重新分类。目标在分类期间结束时，新建轮次；多个空闲发送争抢时，未获 admission 的发送重新读取运行轮次并分类。

## 公共接口

- `send` 回执仍有 `episodeId / messageId / deliveryState`，新增 `rootMessageId`，指向该轮次初始用户消息。补充记录同样保留自己的 `messageId / clientMessageId`。
- 公共消息投影新增 `rootMessageId / turnStartedAt`；既有 `episodeId / replyToMessageIds` 保留。新消息持久保存归属，旧消息读取时从同 owner/Person 的 episode 只读补齐根身份与发起时间，避免分页窗口内的补充消息被当作根而重排。
- `snapshot.activeEpisodes[]`：`id / episodeId / rootMessageId / inputPreview / kind / status / createdAt / feedback?`，本进程执行时合并现有 runtime execution 元数据（phase、loops、model、models、executionGoal、resumable 等）。`inputPreview` 是初始请求的最多 1000 字符，不是私有推理。
- `executions.active[]` 和 `status.active[]` 返回本进程 owner-scoped runtime execution 元数据。`status.concurrentTurnsSupported: true` 表示支持并行。`main` 保留兼容，不能据此判断全部活动。
- `snapshot.busy` 表示任一持久 live episode；旧 `episodeId / latestEpisode / main` 保留。UI 应使用 activeEpisodes 判断和控制多轮次。
- `pause / resume {episodeId}`、`cancel {episodeId}` 仅控制指定轮次；`cancel {}` 停止 owner 的全部轮次和后台效果，保持旧 stop-all。cancel 仍关闭 autonomy 并暂时阻止 owner 新 admission，已有 sibling 执行不被清理。

## 存储与上下文

SQLite JSON record 加性增加 episode `leaseUntil / pendingInboxVersion`；无新增数据库或目录，无破坏性 schema migration。初次 recover 补齐旧 live record。每条 lease 由 episode 自身的 worker/epoch/status 控制，Person 的单 active 字段仅作兼容投影。inbox 按 episode ack，附件按该 episode 实际输入读取。结束、恢复和取消只处理目标 lease/inbox。

provider 边界读取同 namespace/owner/Person 的公开 messages、state 和活动轮次；增量上下文只追加于已完成工具批次之后，不修改带签名 provider 前缀。不自动注入运行中 sibling 的 call output、原始工具结果、thinking、signature 或 provider state。bootstrap 与等待恢复均按 episode lineage 筛选 task/tool/agent/completion 证据，保留本轮与已终结历史的恢复记录；未知或矛盾 lineage 不自动注入，原始证据仍可显式读取。共享消息最多 8 条、每条 1000 字符，活动轮次最多 16 条；初始上下文仍使用既有字节预算。其他轮次为观察，不是本轮次授权。

最终 cognition 通过 SQLite CAS 检查共享 state/concept revision；竞争时仅请求重新协调最终 JSON，保持工具关闭、不重放执行。用户输入到达仍优先走既有 INPUT_PENDING/next-loop 路径。

并发执行不是文件系统写入隔离；用户明确并行的轮次可同时操作相同 workspace。分类失败或 16 条候选外的运行轮次可能导致新增轮次，而不是自动补充。无跨实例旧版本运行时同时写入兼容保证，升级时应先结束旧运行时。
