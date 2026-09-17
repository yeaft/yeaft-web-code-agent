# Conversation fold 与历史读取

`foldMessages()` 在 append-only transcript 中追加 reflection，并记录 `foldedMessageIds`。这些 ID 是**模型上下文替换标记**，不是用户历史的删除标记。

## 读取契约

- `SegmentStore.readAll()` / `scan()` 默认 `projection: 'context'`：应用 fold 替换。`loadRecentBySession()`、`loadAllBySession()`、VP 历史和 provider 历史维持模型语义，不能直接作为用户历史回放来源。
- `projection: 'transcript'`：读取原始持久记录，包含被 fold 替换的行。它本身不是安全的公开输出；调用方仍须过滤 internal、reflection、compact 控制行、非用户创作的控制消息和敏感字段。
- 用户入口 `loadVisibleBySession()`、`loadAfterSeqByGroup()`、搜索、outline、定位窗口及 canonical visible entries 使用 transcript，再应用可见投影。`loadOlderBySession()` 兼容入口也读取 transcript，但保留工具配对原始行，调用方仍须执行 UI 投影。
- `compactOrphans()`、`reassignThread()` 等读后重写必须读取完整 transcript，避免把模型上下文误写回磁盘、永久删除折叠历史。Session copy 同样保留完整持久记录。

## 分页与兼容

首屏同步扫描继续有预算，工具密集的单轮可以跨多页。调用方必须使用 `nextBeforeSeq` / `hasMore` 继续读取，包括没有可见消息的空页；delta 使用 `latestSeq` / `hasMoreAfter`，保留工具配对安全边界。展示预算不等于历史删除。

已有 JSONL 的 `foldedMessageIds` 无需迁移。旧 markdown 与 JSONL 混存时按 sequence 合并，重复 ID 以 JSONL 为准；模型投影也把 JSONL index 的 fold 标记应用于 legacy 副本。

浏览器历史的 `getSessionHistoryMetadata()` 在物理 `streamId` 后附加 `:visible-v2`，使旧折叠投影缓存即使 head seq、revision 完全相同也不再匹配；bridge 必须转为 snapshot，不能回退复用 `afterMessageId`。此版本只标识用户投影，不改变磁盘 stream、revision 或模型上下文；同版本 reader 重启后身份保持稳定。

SQLite history index 是可重建缓存。schema 版本 3 改为索引未折叠的可见 transcript：即使源文件及 mutation revision 未改变，旧版本缓存也必须重建，不能作为 stale 结果公开。升级沿用递增 generation；重启可复用已完成的版本 3 索引，不修改 transcript 或实例配置。
