# H2-AMS Memory（已退役）

> **已退役的 runtime 实现：** Dream/H2-AMS 已禁用。启动不会迁移或同步该存储，交互 turn、历史加载和 Work Center 也不会读取或注入它。旧文件、index、模块和命令入口为数据兼容与技术追溯暂时保留；enable/manual 命令返回 `disabled`。历史真实消息与常规 debug 数据保留。Turn 后 compact 是独立且仍启用的 history-window 能力。

下文记录保留的实现和历史数据格式，不代表当前 runtime 行为。

H2-AMS 是 Yeaft 原生 engine 的 scoped persistent-memory system。它以可读 Markdown 为 source of truth，以 SQLite FTS5 作为可重建搜索 index，并为当前 Session 维护有预算的 in-memory Active Memory Set（AMS）。

> 本页面描述开发者行为。用户边界见 [Yeaft Session 与 Project](../user/yeaft-session.md#memory-边界) 和 [Work Center](../user/work-center.md#memory-reuse)。

## 目标

- 跨 turn 与符合条件的 Session 召回有用信息；
- 隔离 user、VP、Session 和相关 scope；
- 保留 source identity 与 ACL check；
- 不依赖 vector database，保持可检查；
- 注入有界 memory block，而不是无限 history。

Memory retrieval 是 reference context，不高于 system prompt、当前 user request、WorkItem contract 或 tool/safety policy。

## Storage 与 index

每个 scope 的 memory root 可以包含：

```text
<scope>/memory.md             序列化的多个 atomic segment
<scope>/summary.md            有界 English/default summary
<scope>/summary.zh.md         可选 Chinese summary
```

`segment-store.js` 解析并原子重写包含多个 segment 的 `memory.md`。`store.js` 是当前 runtime reader/writer 使用的 scope/path/ACL 边界。`summary-store.js` 管理有界 Layer-A summary。

`index-db.js` 维护 derived SQLite database：

- 每个 atomic segment 一条 `memory_segments` row；
- body、tags 和 scope 的 FTS5 table；
- `source_msgs` 保存归一化 source message ID；
- 按 scope 和 update time 的 index。

Markdown file 是 source of truth。`segment-sync.js` 可以根据磁盘重建/同步 FTS index。

## Scope 模型

Scope 是隔离维度。当前 storage reader 处理 active 与 compatibility layout，包括：

| Scope family | 用途 |
| --- | --- |
| `user` | 授权原生工作可用的 Agent user preference/profile |
| `chat/<chatId>` 与 nested `chat/.../vp/<vpId>` | 活跃 1:1 原生/CLI Session memory |
| `sessions/<sessionId>` 与 nested user/VP/feature/topic path | 当前 Session-shaped storage layout |
| `group/<sessionId>` 与 nested path | 迁移期间仍读取的历史 storage-compatible Session layout |
| Prompt/Dream path 使用的 VP/sub-agent scope | Role-specific 或 child-agent memory |
| topic/feature compatibility scope | 当前 reader 授权时的有界 semantic collaboration scope |

新领域代码使用 Session 术语。Storage layer 必须继续读取 legacy `group` path，直到持久数据迁移完成。

当存在 current VP identity 时，VP ACL 会阻止另一个 VP 的 nested private path。更高层 owner/session authorization 在 scope 进入 memory store 前解析。

## Active Memory Set

AMS 属于 Session，由 `ams-registry.js` 在内存中持有。它有三层：

1. **Resident** — 相关 scope 的 summary；
2. **Recent** — 最近触达的 high-priority segment；
3. **OnDemand** — 为当前任务选择的 FTS hit。

`budget.js` 在三层之间分配 token limit。`preflow.js` 提取 searchable keyword，只查询 authorized scope，hydrate OnDemand hit，并为 prompt 渲染唯一 memory block。

Registry 持久化足够的 Session state，使 AMS 能在重启后 hydrate，包括该 Session 是否已运行 LLM adjustment。Rendered prompt block 会重建，不作为第二个 source of truth。

## 读路径

原生 turn 之前：

1. Session pre-flow 确定授权的 user、VP、current Session 和 related Project-Session scope。
2. Project sibling recall 只限同一 Agent 的 Session，并保留 source Session identity。
3. 从当前任务提取 keyword。
4. FTS5 在 scope filter 内返回 ranked matching segment。
5. AMS 在 budget 内组合 summary、recent segment 和 OnDemand hit。
6. Prompt renderer 明确把 memory 标记为 reference context。

Project recall 不合并 transcript。只有当前 Agent 与 Project membership 授权时，sibling Session 才提供带 source label 的 scope summary/segment。

## 写路径

Conversation message 不会直接复制进每个 memory scope。持久提取由 Dream maintenance 完成：

1. 收集符合条件的 conversation/diff input；
2. 让 maintenance model 输出带 scope、tags、source message ID 与 timestamp 的 atomic fact；
3. 在 scope 的 `memory.md` 中 merge/deduplicate segment；
4. 同步 derived FTS index；
5. 重建受影响的 scope summary。

`adjust.js` 与 durable extraction 分离。它根据当前 turn 修正 AMS membership。它保证一次初始 adjustment 机会，之后只在已实现的 budget-pressure/change policy 下再次运行；不是每个 turn 无条件调用 LLM 重写。

## Dream maintenance

Dream 是 restricted prompt/tool contract 下的后台 maintenance operation。它切分 source material，拒绝 malformed/unsafe scope write，更新 atomic segment 并刷新 summary。Dream output 是 memory data，不是 user-authored turn。

Source message normalization 很重要：持久 segment metadata 只保存 ID，Markdown source text 只是 debug/history fallback，避免 raw message object 泄漏到 memory provenance 字段。

## 历史 Work Center memory reuse

Work Center 与 Session 不共享一个 memory owner。`reuseMemory=true` 时，WorkItem 可以计算三类有边界的候选来源：

- 当前 Agent 的 scope-bounded FTS recall；
- 相同 canonical workspace key 下 completed WorkItem 的 structured summary/evidence；
- 解析到相同 canonical workspace 的普通 Session user-visible excerpt。

Browser-created 和 legacy item 读取 Agent user scope。Trusted Session producer 还可以授权 source Session 与 current VP scope。Workspace-Session recall 会验证 canonical path，只在 owner 本地运行，排除当前 source Session，并且不暴露 raw tool output。

候选计算不等于 prompt injection。Execution schema v1 会附加非空的 Runner-computed memory/workspace block；schema v2 当前渲染 immutable Mainline context 与 fixed suffix，不附加这些预计算 block。所有 context 都有 token budget，不能覆盖 WorkItem contract 或 execution rule。`reuseMemory=false` 关闭三类候选来源。

## 运维注意事项

- Memory file 与 FTS database 可能包含敏感 project fact。
- Raw debug output 与 Dream input 应留在所属 Agent 边界。
- 删除 Session/VP 时必须清理或迁移所有 owned memory path；部分清理会在 ID reuse 时暴露 stale context。
- Scope path 变化必须配 compatibility reader 与显式 migration，不能盲目 rename。
- FTS 是 lexical search，不是 semantic vector search；缺少 keyword 会降低 recall。
- Summary 是有损信息。重要 acceptance evidence 应保留在权威 Session 或 WorkItem record。

## 主要文件

- `agent/yeaft/memory/store.js` — scope path、I/O 与 nested VP ACL
- `agent/yeaft/memory/segment-store.js` — `memory.md` segment serialization
- `agent/yeaft/memory/index-db.js` — SQLite/FTS5 derived index
- `agent/yeaft/memory/segment-sync.js` — disk/index synchronization
- `agent/yeaft/memory/summary-store.js` — Layer-A summary
- `agent/yeaft/memory/ams.js` / `ams-registry.js` — active memory 与 Session hydration
- `agent/yeaft/memory/preflow.js` — keyword recall 与 prompt injection
- `agent/yeaft/memory/adjust.js` — post-turn AMS membership adjustment
- `agent/yeaft/dream/` — 持久后台提取与 summary refresh
