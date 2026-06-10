# Yeaft 记忆系统（H2-AMS）

H2-AMS（Hierarchical 2-layer Active Memory Set）是 Yeaft 引擎的**跨 session 持久记忆系统**。每个 turn 之前主动召回相关记忆注入 system prompt，每个 turn 之后用 LLM 修正记忆。本章讲它的**架构**、**scope 模型**、**读写路径**。

> 面向想理解 / 调试 / 扩展 Yeaft 记忆的开发者。用户视角的简介在 [Yeaft Group Mode](../user/yeaft-group.md#记忆系统能干什么)。

## 设计目标

1. **跨 session 记忆** — VP 在新 session 也记得你上次说的事
2. **多 scope 隔离** — user / vp / group / feature / global 各自独立，互不污染
3. **召回精度** — 用 FTS5 全文索引，不是向量搜索（轻量、可解释、调试友好）
4. **可读可备份** — 记忆都是 markdown 文件，不依赖 binary blob

## 架构层次

```
┌─────────────────────────────────────────────────────┐
│ Engine Query Loop                                     │
└─────────────────┬───────────────────────────────────┘
                  │ preflow.recall(scopes)
                  ↓
┌─────────────────────────────────────────────────────┐
│ AMS (Active Memory Set) — in-memory 三层缓存          │
│   • Resident summary  — <scope>/summary.md          │
│   • Recent            — 近期 high-priority 段        │
│   • OnDemand          — FTS5 召回的相关段             │
└─────────────────┬───────────────────────────────────┘
                  │
                  ↓
┌─────────────────────────────────────────────────────┐
│ Segment Store — <scope>/segments/*.md 原子段          │
│ Summary Store — <scope>/summary.md  Layer-A 摘要      │
│ FTS5 Index    — SQLite FTS5（每段一行，按 scope 分）   │
└─────────────────────────────────────────────────────┘
                  ↑
                  │ dream maintenance
┌─────────────────────────────────────────────────────┐
│ Dream Loop — 后台跑                                  │
│   • 切对话历史为原子段                                  │
│   • LLM 写入 summary.md                              │
│   • 镜像 FTS 索引                                    │
└─────────────────────────────────────────────────────┘
```

## Scope 模型

**Scope 是唯一的隔离维度。** 没有 shard、没有 channel — 只有 scope。

| Scope | 含义 | 谁能读 / 写 |
| --- | --- | --- |
| `user/<userId>` | 用户级 profile / preference | 该用户的所有 VP / group |
| `vp/<vpId>` | 单个 VP 的人格记忆 | 该 VP（独立私有） |
| `vp/<vpId>/sub/<subId>` | VP 子 Agent 嵌套 scope | 该子 Agent |
| `group/<groupId>` | group 内共享 | 该 group 的所有 VP |
| `feature/<featureId>` | feature 级协作记忆 | 该 feature 相关的所有 VP |
| `global` | 全局（产品级常识） | 所有 |

### VP 与子 Agent
VP 是 scope owner，跟用户同级。VP 的子 Agent 是嵌套 scope（`vp/X/sub/Y`），独立有自己的记忆。

### Group fan-out 时的可见性
Group 里多个 VP 并行执行时：
- 每个 VP 看自己的 `vp/<vpId>` 记忆 + `group/<groupId>` 记忆 + `user/<userId>` 记忆
- **不**共享 transcript（每个 VP 看到的对话历史是它自己的）
- VP→VP 跨视野 = 通过 scope-aware pre-flow 召回实现，**不**走共享 shard

### VP→VP 显式 handoff
用 `route_forward` 工具显式传递任务上下文。

## 存储原语

### Segment Store（`segment-store.js`）
原子记忆段，存为 markdown 文件：

```
~/.yeaft/<scope>/segments/<segment-id>.md
```

每段包含：
- frontmatter：metadata（创建时间、来源 turn id、关键词、priority）
- body：自然语言段落

例子（`~/.yeaft/user/uid-123/segments/2026-06-10-prefer-ts.md`）：

```markdown
---
created: 2026-06-10T08:32:11Z
source_turn: turn-abc
keywords: [typescript, prefer, type-system]
priority: 0.7
---

用户偏好 TypeScript 而非 JavaScript。理由是"类型安全在团队规模上是 ROI 最高的投资"。
```

### Summary Store / Layer A（`store-v2.js`）
每个 scope 一个 `<scope>/summary.md` — 是该 scope 所有段的**浓缩**版。LLM 在 dream 维护时增量更新它。

### Index DB / FTS（`index-db.js`）
SQLite FTS5 表，每条段对应一行：

```sql
CREATE VIRTUAL TABLE segments USING fts5(
  segment_id UNINDEXED,
  scope UNINDEXED,
  keywords,
  body,
  tokenize='unicode61'
);
```

按 scope 分库写，召回时按需要的 scope 列表跨库 union。

### AMS（Active Memory Set，`ams.js`）
in-memory 三层缓存：
- **Resident summary** — 当前 group 关联 scope 的 `summary.md` 直读，定长
- **Recent** — 近期 high-priority 段，按 priority 排序，限 token budget
- **OnDemand** — 本次 preflow 召回的相关段，限 token budget

三层都有独立 budget（`budget.js` 算），加起来不超过 system prompt 的记忆部分总预算。

## 读路径 — preflow（每 turn 前）

`preflow.js` 在每 turn 开始前跑：

```js
async function preflow({ scopes, query, budget }) {
  // 1. 抽 query 关键词（keywords.js）
  const kws = extractKeywords(query);

  // 2. 对每个 scope FTS 召回
  const hits = await Promise.all(
    scopes.map(s => indexDb.search(s, kws, { limit: 20 }))
  );

  // 3. 按 priority + 召回分排序
  const ranked = rankHits(hits.flat());

  // 4. 截到 budget
  const selected = pickWithinBudget(ranked, budget);

  // 5. 渲染到 system prompt
  return renderMemoryBlock(selected);
}
```

召回结果注入 system prompt 的 `### Memory` section。

## 写路径 — turn 后的 adjust + dream

### Adjust（轻量，每 turn 后最多一次）
`adjust.js`：用一次轻量 LLM 调用把当前 turn 的新信息**修正** AMS（如：用户改了偏好，要把旧偏好失活、新偏好升 priority）。

每个 session 每个 group 最多跑一次，避免短 turn 高频跑。

```js
const adjustment = await llm.call({
  model: fastModel,
  system: adjustPrompt,
  messages: [{ role: 'user', content: `Turn diff: ${diff}` }],
});
await applyAdjustment(ams, adjustment);
```

### Dream（重量级，后台跑）
`dream-v2/` 是后台 daemon loop：
1. 监测哪些 scope 有新对话历史尚未消化
2. 用 LLM 把对话历史**切分**成原子段
3. 写新段到 `<scope>/segments/`
4. 更新 `<scope>/summary.md`
5. 镜像 FTS 索引

Dream 不阻塞 user turn。它在 idle 时跑，或在用户主动 `/yeaft compact` 时触发。

## Consolidation 决策

`consolidate.js` 判断何时该跑 dream maintenance：

- 段数超过阈值
- 累计字符数超过阈值
- 距离上次 dream 超过 N 分钟
- 用户主动触发

满足条件 → 标记 scope `needs_dream: true` → dream loop 拾取。

## 调试

### 看记忆原文
直接读 `~/.yeaft/<scope>/segments/*.md` 和 `~/.yeaft/<scope>/summary.md`。它们是 plain markdown。

### 看召回过程
Yeaft Web 端的 **Debug 面板**显示每 turn 的 preflow 召回明细：
- 哪些 scope 被搜
- 用了哪些关键词
- 召回了哪些段
- 哪些进了 AMS / 哪些被 budget cut

### 看 FTS 索引
```bash
sqlite3 ~/.yeaft/<scope>/index.db
> SELECT segment_id, keywords FROM segments WHERE body MATCH 'typescript';
```

## 备份 / 迁移

记忆全是文件 — `~/.yeaft/` 整个目录 tar 一下就备份了。迁到新机器：解压回 `~/.yeaft/`，启动 Agent 即可。FTS 索引重建用 `seed-backfill.js`。

## 关键文件

```
agent/yeaft/memory/
  segment-store.js   — 段存储原语
  segment-sync.js    — 段写/删时同步到 FTS
  segment.js         — 段记录辅助
  index-db.js        — SQLite FTS5 索引
  store-v2.js        — Layer-A summary 读写
  ams.js             — Active Memory Set 缓存
  ams-registry.js    — group 级 AMS hydrate/persist
  budget.js          — token 预算计算
  keywords.js        — FTS 关键词抽取
  preflow.js         — turn 前召回
  adjust.js          — turn 后修正
  consolidate.js     — 触发 dream 的决策
  seed-backfill.js   — 历史数据迁移
```

> Dream loop 本身在 `agent/yeaft/dream-v2/`，不在 memory 目录。

## 设计取舍说明

**为什么不用向量搜索？** FTS5 + 关键词 + 段级 markdown 已经足够准（实际召回率 ≥80% 对我们的场景），且**可解释 / 可调试 / 可备份**。向量搜索要 embedding 服务 + 索引重建 + binary blob，维护成本高，对短记忆段精度提升不明显。

**为什么 Layer-A summary 单独存 markdown？** summary.md 是 LLM 主动维护的"长期记忆当前状态"，比段更稳定，召回时**直读**不走 FTS，节省 query 时延。

**为什么 dream 是后台？** dream 涉及 LLM 调用（贵 + 慢），不能阻塞 user turn。它是 eventual consistency — 你今天讲的事可能明天才被消化成段。
