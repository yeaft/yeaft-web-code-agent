# Unify Memory + Dream — Design v2

**Status**: Proposed (replaces R6 shard model)
**Date**: 2026-04-28
**Author**: design captured from product review session

> 本文档同时定义 **memory 模型** 与 **dream 流程**。两者紧耦合：memory 决定文件结构，dream 决定如何长期维护这些文件。分开看会丢失关键约束（例如 dream 假设每个 scope 只有一对 md 文件），所以合并成一份。

---

## TL;DR

- 每个 scope 一对文件：`memory.md`（自由形态全文）+ `summary.md`（LLM 写的概览）。不再有 shard，不再有 `index.md`，不再有 `index.json`。
- 五种 scope 同构：`user / vp/<id> / group/<id> / feature/<id> / topic/<l1>/<l2>`。topic 是新增的，最多两层，由 LLM 自动分类。
- Recall：先看每个相关 scope 的 summary，LLM 选要拉全文的 scope，再读 memory.md 注入上下文。
- Dream：12 小时跑一次（或手动），按 group 分批，每个 group 走 **Triage → Merge → Apply → Bookkeep** 四阶段。Triage 由 hard rules（结构化 scope）+ soft classification（topic 路径）共同决定 actions；Apply 把同一 target 的多个 group 来源合并，跑一次或多次 UPDATE/CREATE。
- 全部走 primaryModel，串行，不抢用户对话延迟。

---

# Part I — Memory Model

## 1. 设计原则

### 1.1 Markdown 是一等公民
LLM 已经能读 markdown 标题层级。不要再造程序员抽象（shard / 分类目录 / 索引文件）去切 LLM 的连续语义。结构由 LLM 在 memory.md 内部用标题表达，目录由文件自身的 markdown 结构承载。

### 1.2 所有 scope 同构
不分"强结构"和"弱结构" scope。feature（任务）和 topic（闲聊）走同一套数据模型。统一性带来：
- 一份 recall 代码路径
- 一份 dream 代码路径
- 一份 store API
- 心智模型简单：scope = "一段记忆的 owner"，仅此而已

### 1.3 LLM 友好优先于程序友好
持久存储用 markdown（LLM 能直接读懂）。需要快速访问的派生数据（如运行时索引）从源数据扫描重建，不持久化、不污染 LLM 视野。

### 1.4 Dream 是结构编辑者
Memory 的内部结构（章节划分、归并、淘汰）由 dream 维护。日常写入是流水帐（appending），dream 周期性整理成 LLM 可读的连贯笔记。

---

## 2. 目录结构

```
~/.yeaft/memory/
  user/
    memory.md
    summary.md

  vp/<vpId>/
    memory.md
    summary.md

  group/<groupId>/
    memory.md
    summary.md

  feature/<featureId>/
    memory.md
    summary.md

  topic/<l1>/<l2>/      ← 最多两层
    memory.md
    summary.md

  _proposals/<ts>.md    ← dream 输出的"建议人审"产物（跨 scope 提升）
  .dream-bak/<ts>/...   ← dream 前的 snapshot（保留最近 7 次）
```

**完全对称**：每个 scope 就是一对 `memory.md + summary.md`，没有特例。

---

## 3. Scope 语义

| Scope | 装什么 | 谁产生 | 用户感知 |
|---|---|---|---|
| **user** | 用户画像（背景、偏好、关系、目标） | 长期沉淀 | "AI 知道我是谁" |
| **vp** | 这个人格自己的技能、教训、风格 | VP 行为产生 | "VP 张三会什么" |
| **group** | 这个小队的共识、术语、协作规范 | 群协作产生 | "我们小队怎么做事" |
| **feature** | 这件任务的决策、进展、阻塞、产物 | 任务工作产生 | "这事做到哪了" |
| **topic** | 用户在某领域的对话沉淀 | 闲聊产生 | "我们之前聊 X 时聊到过…" |

### 3.1 Scope 之间的关系
- 互不嵌套（feature 不属于 vp，topic 不属于 user）
- 互不读对方文件（隔离）
- 通过 **recall 时联合查询** 实现"VP 在回答时同时看到自己 + 当前 feature + 用户画像 + 群共识"

### 3.2 ACL
- `vp/A` 不能读 `vp/B`（VP 隔离的产品承诺）
- 其他 scope 之间无 ACL 限制（同会话内）

---

## 4. Topic Scope 的分类机制

### 4.1 不是 ID，是 category
Topic 的标识是**业务分类**，不是唯一 id。多条对话可以归到同一个 `science/physics`。

### 4.2 路径上限两层
```
✓  science/physics
✓  life/parenting
✓  work                ← 一层也行
✗  science/physics/quantum   ← 拒绝，第三层用 tags
```

第三层细分通过 memory.md 内部章节或前端 tag（如果有）表达。

### 4.3 LLM 自动分类（dream 时机）
分类决策是 dream 流程的一部分（详见 §10 Triage）。决策时 prompt 里必须提供每个现有分类的 `summary.md` 摘要，LLM 才有判断依据——路径名 `science/physics` 不够 LLM 判断"这片段算不算物理"。

### 4.4 分类合并（未来）
Dream 在比对时如果发现两个 topic 高度重叠（如 `tech/ai` 和 `work/ai`），可以建议合并。这是 v2.1 的工作，v2.0 不实现。

---

## 5. 文件格式

### 5.1 memory.md
LLM 自由组织。建议结构（非强制）：

```md
# <scope-id> — <一句话定位>

## <LLM 自定的章节 1>
- 条目 1
- 条目 2

## <LLM 自定的章节 2>
内容...

<!-- dream-state -->
lastDreamAt: 2026-04-28T03:07:00Z
<!-- /dream-state -->
```

dream 完全负责章节布局。日常写入是追加在末尾（流水帐），dream 重写整理。

### 5.2 summary.md
单段或几段自然语言，描述这个 scope 的总览：

```md
# vp/zhang-san — summary

张三是物理学背景的 PM 风格人格，擅长把复杂概念用日常类比解释。
最近在 Atlas 项目里推进设计评审，倾向 ADR 文档化决策。
偏好简洁直接的表达，对过度工程敏感。
```

由 dream 生成。recall 第一步就读它。

---

## 6. Recall 流程

### 6.1 触发时机
每次 engine 准备调 LLM 之前。

### 6.2 流程

```
用户消息 + 当前会话上下文 (vpId, featureId, groupId, userId, activeTopic?)
    ↓
[Step 1] 收集相关 scope 的 summary.md（并行读）
    - user/summary.md             [总是]
    - vp/<vpId>/summary.md        [总是]
    - feature/<featureId>/summary.md  [如果在 feature]
    - group/<groupId>/summary.md  [如果在 group]
    - topic/<l1>/<l2>/summary.md  [如果在 topic 上下文]
    ↓
[Step 2] LLM 决策"哪些 scope 的全文需要拉"
    输入：用户消息 + 各 scope 的 summary
    输出：要拉全文的 scope 列表 + 每个的相关性评分
    ↓
[Step 3] 加载选中 scope 的 memory.md 全文（并行读）
    ↓
[Step 4] 配额合并 + 总长度截断
    - user 永远塞（不大）
    - vp/feature/group/topic 按相关性截断到 token budget
    ↓
[Step 5] 注入 system prompt
    格式：
    [memory:user]
    <user/memory.md 内容>
    [memory:vp/zhang-san]
    <vp/zhang-san/memory.md 内容>
    ...
```

### 6.3 长度控制
当某个 memory.md 超出 budget：
- 优先靠 dream 提前压缩（dream 的职责）
- 兜底：recall 时让 LLM 基于 summary + 当前 query 选段（grep section）注入

不再有"最多 N 条 entry"这种粒度——粒度由 markdown section 自然提供。

---

## 7. 写入路径

### 7.1 直接写入
日常写入是**追加到 memory.md 末尾**：

```
## [新条目 - 2026-04-28T10:30:00Z]
authoredBy: vp:zhang-san
context: feature/abc-123
---
张三在讨论中提出 ADR 模板...
```

不立即整理。等 dream。

> 注意：上面的"直接追加"是 v2 的可选路径。**默认走 dream**——日常对话不直接写 memory.md，而是由 dream 在每个周期把会话 diff 整理进去。直接追加保留给"用户在 UI 上手动添加一条 memory"等少数路径。

### 7.2 谁能写
- **VP**：通过 dream 周期性整理（不再每轮 extract）
- **User**：通过 UI 手动（user memory page 的"添加"按钮）
- **Dream 自身**：整理 / 提升 / 淘汰

### 7.3 Authored-by 元数据
直接追加时必须带 authoredBy（`vp:<id>` / `user:<id>` / `system:dream`），用于 dream 决策权重和 ACL。

---

## 8. 不做什么（明确排除）

| 项 | 为什么不做 |
|---|---|
| Shard / 多文件分类 | 见 §1.1，让 markdown 标题表达 |
| Index.md | 单文件场景下纯冗余 |
| Index.json | 启动时从 memory.md 扫描重建即可，不持久化 |
| Vector embedding / similarity search | dream + summary 已经做了语义压缩，LLM 选 scope 用文本足够 |
| 时间衰减 | 由 dream 在压缩时决定淘汰，不需独立 TTL 字段 |
| Importance 字段 | 由 dream 在 memory.md 里通过章节位置/篇幅表达，不需独立字段 |
| 第三层 topic 路径 | LLM 难判断、用户搞不清，用标题或 tag 替代 |
| Cross-VP memory 共享 | 通过 group / user / feature scope 表达，不破坏 VP 隔离 |
| 跨 scope 自动提升 | 只输出 `_proposals/`，等用户 UI 批准 |

---

## 9. 不变量（设计承诺）

1. **每个 scope 永远是 `memory.md + summary.md` 两个文件**，不增不减
2. **memory.md 的内部结构由 LLM 决定**，代码不规定章节
3. **Topic 路径永远 ≤ 2 层**
4. **VP 之间互不读 memory**
5. **任何持久化数据都对 LLM 可读**（无 binary，无 json metadata）
6. **运行时缓存可有可无**——重启从源 markdown 重建，不依赖缓存正确性
7. **Dream 永不修改 VP system-prompt / group charter / 用户 UI 设置**——冲突写注释，不动手

---

# Part II — Dream Pipeline

## 10. Dream 定位与触发

### 10.1 定位（先把基础锚定死）
- **Dream ≠ Compact**。Compact 是 token 预算到顶时把上下文压成 summary 塞回当前会话；Dream 是离线整理 memory 文件。两条路径独立，不复用代码、不共享 prompt、不互相触发。
- **Dream 覆盖所有 scope**，慢就慢，无所谓——不抢用户对话的延迟预算。
- **只用 primaryModel**。一个模型从头跑到尾。
- **可观测**：升级现有 debug panel 展示 dream 进度、每个 group/scope 的状态、LLM call 次数、耗时、产出 diff。不另起新 UI。

### 10.2 触发
- 12 小时定时
- 用户手动（UI "立即整理"按钮，复用 wave-6b 的 `unify_dream_trigger` 通道）
- `/dream`、`/dream <scope>` 命令

不做：idle 触发、scope-sig diff-gate、nightly cron。**两条路就够。**

### 10.3 跳过阈值
- **按 group 算**，不算全局
- 自动触发：某 group 的 newMessageCount < 20 → 跳过该 group
- 手动触发：newMessageCount === 0 → 跳过；> 0 → 不论多少都做

---

## 11. 状态记账

两个维度的记账，互不耦合。

### 11.1 Per-group（控制流用）
每个 group 维护：
```
~/.yeaft/memory/group/<id>/.dream-state
lastDreamMessageId: m-1024
lastDreamAt: 2026-04-28T03:07:00Z
messageCount: 491
```

`newMessageCount = messageCount - 上次 dream 时的 messageCount`。Dream 启动时按 group 算这个数，决定该 group 是否进入 triage。

虚拟 group `_no-group/`：装那些不属于任何群的 1:1 message（例如直接和一个 VP 单聊），有自己的 `.dream-state`。

### 11.2 Per-scope（观测用）
每个 scope 的 `memory.md` 末尾的 `<!-- dream-state -->` 块：
```
lastDreamAt: 2026-04-28T03:07:00Z
```

仅供 debug panel 显示"该 scope 上次被 dream 动过的时间"，不参与控制流。

---

## 12. Overlap 窗口

### 12.1 为什么需要
`lastDreamMessageId` 是硬切点。下次 dream 从它后面开始读，但前一次 dream 里 LLM 看到的"原始对话"已经被加工成 memory 摘要——下次 dream 读新 diff 时，第一条新 message 可能接着上文，没有上文理解不到位。

### 12.2 方案：尾部 overlap 3 条
推进 `lastDreamMessageId` 后，**下次读取时往前回溯 3 条**作为 context preamble：

```
本次 dream 读取 = [上次 lastDreamMessageId - 3, 现在末尾]
                   ↑ overlap (只看不算)         ↑ 真正新增
```

prompt 里清楚标注分界：
```
=== Context (already processed in previous dream, for continuity) ===
<3 条 overlap message>

=== New since last dream ===
<真正新 message>
```

### 12.3 约束
- overlap **不计入 newCount**（算阈值时只数 New 段）
- LLM 被告知 overlap 已处理过，**不要重复抽取**，只用作上下文
- bookkeep 推进的还是真实 diff 末尾，overlap 永远从"实际处理过的最后一条"往前数 3
- 按 group 算 overlap，每个 group 独立

常量：`DREAM_OVERLAP = 3`。

---

## 13. 管线总览

```
[trigger] 12h / 手动
  ↓
[enumerate groups] 列出所有 group/* （含虚拟 _no-group）
  ↓
for each group with newMessageCount ≥ 20 (或手动 > 0):
    [load diff]      加 3 条 overlap，单条过长截断
    [segment]        diff 超长则分段
    [Triage]         hard rules + soft classification
                     → group-local actions[]
  ↓
[merge by target]    所有 group 的 actions 按目标 scope 合并 source diff
  ↓
[Apply]              每个 target 一次（或多批）UPDATE/CREATE
  for each merged target:
    snapshot → run prompt → atomic write
    if 拼接 > MAX_APPLY_TOKENS: 分批，串行喂
  ↓
[Bookkeep]
    per-group lastDreamMessageId 推进
    per-scope lastDreamAt 更新
  ↓
[done] 上报 debug panel
```

LLM call 数 = `2 × G + B`（G = 跨阈值 group 数，每个走 2-pass triage；B = 合并后总 apply 批次数，最少 = target 数）。全部 primaryModel，全部串行。

---

## 14. Triage（决策阶段）

> Triage 解决一个核心问题：**这一段对话该影响哪些 scope？**

### 14.1 输入
- 该 group 的新 message diff（一整段，含 3 条 overlap preamble）
- **该 group 相关的 scope 候选集**：
  - `group/<id>`（群本身）
  - 群里出现过的所有 `vp/<id>`（按 message 发话方收集）
  - 群里被引用过的所有 `feature/<id>`
  - `user`（永远在候选集）
  - 现有所有 `topic/**`（topic 是全局共享的）
- 这些候选 scope 各自的 summary.md

### 14.2 Hard rules（代码，无 LLM）
不靠 LLM 判断的部分，代码硬扫：

| 规则 | 逻辑 |
|---|---|
| Active group | 当前 group 的 `group/<id>` 必加（除非是 `_no-group`） |
| Active VP | 凡是 assistant message 的发话 VP，**强制**加 `vp/<id>` |
| Active feature | message 带 `featureId` 的，**强制**加 `feature/<id>` |
| User scope | 总是加（防漏画像；apply 阶段自己判断要不要改） |

这四类是结构化能确定的，不让 LLM 决定。

### 14.3 Soft classification（LLM 两 pass）

**Pass 1 — 候选枚举（高召回）**

让 LLM 输出**类目级别**的标签，不要求精确路径：

```json
{
  "touches": {
    "user_profile_signals": true,
    "topics": [
      "physics / quantum mechanics",
      "parenting / sleep training"
    ],
    "trivial_only": false
  }
}
```

VP / group / feature 不在这里问（hard rules 已覆盖）。

**Pass 2 — 路径绑定（高精度）**

只对 Pass 1 输出的 topic 描述做精确路径绑定。每个 topic 描述一次问 LLM：
- 给定现有 topic 树 + 各自 summary
- 输出 `match: <existing-path>` / `new: <proposed-path>` / `none`
- 校验 ≤2 层、不与现有冲突

`user_profile_signals === true` 时不需要 Pass 2 二次确认（hard rules 已经把 user 加进去了，是否实质更新由 apply 阶段决定）。

### 14.4 输出
```json
{
  "groupId": "g-eng",
  "actions": [
    { "kind": "update", "scope": "group/g-eng" },
    { "kind": "update", "scope": "vp/zhang-san" },
    { "kind": "update", "scope": "vp/li-si" },
    { "kind": "update", "scope": "user" },
    { "kind": "update", "scope": "feature/abc-123" },
    { "kind": "update", "scope": "topic/science/physics" },
    { "kind": "create", "scope": "topic/life/parenting" }
  ],
  "skip_reason": null
}
```

每个 action 都带这个 group 的 source diff 作为伴随数据（merge 阶段用）。

### 14.5 兜底（v2.1，先不做）
Apply 阶段每个 UPDATE 输出可附 `noticed_other_scopes_should_update: [...]`。Runner 收集回报，触发最多一轮补 apply，避免无限循环。v2 先不做，等真出现 miss 再上。

---

## 15. Merge by Target（纯代码，无 LLM）

所有 group 的 triage 完成后，按 target scope 合并。

### 15.1 合并规则
- `group/<id>`：永远只来自一个 group，不合并
- `vp/<id>`：可能来自多个 group（同一 VP 在多个群发言），合并
- `user`：几乎来自所有 group，合并（这就是 user 不会被几十次重写的原因——只重写一次）
- `topic/**`：可能来自多个 group（同一话题在多个群聊过），合并
- `feature/<id>`：通常只属于一个 group，但代码不假设，按合并逻辑处理

### 15.2 合并产物
```
mergedActions: [
  { target: 'user', sources: [
      { groupId: 'g-eng',  diff: <...> },
      { groupId: 'g-life', diff: <...> },
      { groupId: 'g-1on1', diff: <...> },
    ]
  },
  { target: 'vp/zhang-san', sources: [
      { groupId: 'g-eng',  diff: <...> },
      { groupId: 'g-life', diff: <...> },
    ]
  },
  ...
]
```

每个 merged action 在 apply 阶段只跑一次 LLM call（除非超长，§17）。

---

## 16. Apply（执行阶段）

每个 merged target 走 UPDATE 或 CREATE prompt。两个 prompt 责任单一，输出格式好约束。

### 16.1 UPDATE prompt
```
You are updating an existing memory scope.

Scope: <path>
Current memory.md: <full>
Current summary.md: <full>

Recent conversations across groups:

[group/g-eng]
=== Context (already processed) ===
<overlap>
=== New ===
<diff>

[group/g-life]
=== Context (already processed) ===
<overlap>
=== New ===
<diff>

Task:
- Extract from these conversations what's relevant to THIS scope.
- Integrate into memory.md (reorganize sections if needed).
- Drop stale/contradicted entries.
- Rewrite summary.md.

The same conversations are being processed for other scopes too.
You only handle what's relevant here. Ignore the rest.

Hard rules:
- Never read or reference any other scope's files.
- Never modify VP system-prompt, group charter, or user preferences.
- If something contradicts a charter, annotate the memory with
  "⚠️ contradicts charter — verify which is current" and continue.

Return JSON:
{
  "memory_md": "...",
  "summary_md": "..."
}
```

### 16.2 CREATE prompt（目前只有 topic 会用到）
```
You are creating a new memory scope.

Scope path: <path>   (must be ≤2 levels)
Initial source diffs:

[group/g-life]
=== Context ===
<overlap>
=== New ===
<diff>

For tone reference, sibling/parent topic summaries:
  - <sibling path>: <summary>

Task:
1. Write memory.md from scratch with reasonable section structure.
2. Write summary.md (1–3 sentences).

Return JSON:
{
  "memory_md": "...",
  "summary_md": "..."
}
```

### 16.3 原子写
每个 apply：
1. snapshot 到 `~/.yeaft/memory/.dream-bak/<ts>/<scope-path>/`
2. 跑 LLM
3. 写 tmp 文件 → rename 到目标位置
4. 更新 `<!-- dream-state -->` 块

snapshot 保留最近 7 次。

---

## 17. 长度处理

三个独立场景，分开处理。

### 17.1 单个 group diff 超长（segment）
```js
MAX_DIFF_TOKENS_PER_TRIAGE = 60000
```

```
对该 group：
  if diff tokens > MAX_DIFF_TOKENS_PER_TRIAGE:
    分成 K 段，每段 ≤ MAX，相邻段 overlap 3
    顺序 triage 每段，actions 累加（去重）
    按段推进 lastDreamMessageId
  这个 group 的合并 actions 进 merge 阶段
```

### 17.2 合并后单 target 超长（batch apply）
```js
MAX_APPLY_TOKENS = 80000
```

```
对 merged target：
  if memory + summary + 全部 sources 拼接 > MAX_APPLY_TOKENS:
    按 group 切批，每批塞满为止
    snapshot 一次（视为单 atomic 工作单元）
    串行调 UPDATE：
      第 1 批：UPDATE(memory=当前, sources=batch1) → 写回
      第 2 批：UPDATE(memory=刚写回的, sources=batch2) → 写回
      ...
    prompt 里告知 "this is batch K of N, batches 1..K-1 already processed"
```

### 17.3 单条 message 超长（截断进入 dream）
```js
MAX_SINGLE_MESSAGE_CHARS = 8000
```

dream 装载 diff 时，对单条 > 限制的 message 截断 + 加注：
```
[message truncated for dream, original preserved in conversation log]
```

原始 message 在会话历史里完整保留——dream 只是把它从自己的视野里收窄。

---

## 18. Limits & Config

```js
DREAM_INTERVAL_HOURS = 12
DREAM_OVERLAP = 3
MIN_NEW_PER_GROUP = 20
MAX_SINGLE_MESSAGE_CHARS = 8000
MAX_DIFF_TOKENS_PER_TRIAGE = 60000
MAX_APPLY_TOKENS = 80000
DREAM_BACKUP_KEEP = 7
```

写成 config 项（`~/.yeaft/config.json` 的 `unify.dream` 段），可调。

---

## 19. Debug Panel 升级

复用现有 debug panel（`unify_memory_query` / `unify_memory_trace` / `unify_dream_trigger` 已有），新增 dream 视图。

### 19.1 顶部状态
```
Dream:  idle | running | cooling-down
Last run: 2026-04-28 03:07  duration 4m12s  groups 7/12  targets 11
Next auto: in 7h 53m
[ Run dream now ]   [ /dream <scope> ]
```

### 19.2 本次/最近一次 dream 详情（两层表）

```
┌─ Groups ────────────────────────────────────────┐
│ group/g-eng    new=87  segments=1  actions=5    │
│ group/g-life   new=23  segments=1  actions=3    │
│ group/g-1on1   new=14  skip (<20)               │
│ _no-group      new=0   skip                     │
└─────────────────────────────────────────────────┘

┌─ Merged Targets ────────────────────────────────┐
│ user                  sources=3  batches=1  ✓   │
│ vp/zhang-san          sources=2  batches=1  ✓   │
│ topic/science/physics sources=1  batches=1  ✓   │
│ topic/life/parenting  sources=1  batches=1  ✓ (created) │
│ feature/abc-123       sources=1  batches=1  ✓   │
└─────────────────────────────────────────────────┘
```

每行可点击展开：
- Groups 行：看该 group 的 diff、triage prompt、triage 输出
- Targets 行：看 merged sources、UPDATE/CREATE prompt、输出 diff（旧 vs 新 memory.md）

### 19.3 历史
最近 N 次 dream 的同样视图。点击进入只读历史详情。

### 19.4 事件协议
Dream runner 向 web bridge 发 `dream_progress` 事件（复用 `unify_output` 通道）：
```json
{ "phase": "triage", "groupId": "g-eng", "status": "running" }
{ "phase": "triage", "groupId": "g-eng", "status": "done", "actions": 5 }
{ "phase": "apply",  "target": "user",   "status": "running", "batches": 1 }
{ "phase": "apply",  "target": "user",   "status": "done", "diffSize": 234 }
{ "phase": "done", "groups": 7, "targets": 11, "duration": "4m12s" }
```

不新增 WebSocket 类型。

---

## 20. 文件落点

新增：
- `agent/unify/dream-v2/runner.js` — 主循环（enumerate → per-group triage → merge → apply → bookkeep）
- `agent/unify/dream-v2/state.js` — group .dream-state + scope dream-state 块的读写
- `agent/unify/dream-v2/triage.js` — hard rules + 2-pass soft classification
- `agent/unify/dream-v2/merge.js` — merge by target
- `agent/unify/dream-v2/apply.js` — UPDATE/CREATE 执行 + 分批 + 原子写
- `agent/unify/dream-v2/segment.js` — diff 切段 / 单条截断
- `agent/unify/dream-v2/prompts/{triage-pass1,triage-pass2,update,create}.md`
- `agent/unify/dream-v2/schedule.js` — 12h 定时器
- `agent/unify/dream-v2/snapshot.js` — `.dream-bak/<ts>/` 管理

弃用（旧 dream 路径整体移除）：
- `agent/unify/memory/dream.js`
- `agent/unify/memory/dream-extract.js`
- `agent/unify/memory/dream-prompt.js`
- `agent/unify/memory/dream-scheduler.js`
- `agent/unify/memory/dream-shard.js`
- `agent/unify/memory/consolidate.js`
- `agent/unify/memory/recompression.js`
- `agent/unify/memory/shard-store.js`
- `agent/unify/dream-v2/{diff-gate,refresh,scope-sig,tick}.js`（基于 sig-diff 触发模型，弃用）

保留并改造：
- `agent/unify/memory/store.js` — 简化为 read/write memory.md + summary.md 两文件 API
- `agent/unify/memory/recall.js` — 重写为 §6 描述的 summary-first 多 scope 流程
- `agent/unify/memory/scope-tree.js` — 加 topic 注册 + 2 层路径校验
- `agent/unify/memory/extract.js` — 不再每轮 extract，仅供 dream 内部复用工具函数

---

## 21. 迁移路径（R6 → v2）

### 21.1 一次性迁移脚本
```
for each scope under ~/.yeaft/memory/:
  - 读所有 memory-<shard>.md 文件
  - 读所有 entries/<id>.md 文件
  - LLM 任务：整合成单个 memory.md（保留全部信息，调整结构）
  - 生成 summary.md
  - 删除原 shard 文件、entries 目录、index.md、index.json
  - 初始化空的 .dream-state（messageCount = 0，lastDreamMessageId = null）
```

### 21.2 兼容性
- 旧数据迁移期间保留备份（`~/.yeaft/memory.v1.bak/`）
- 迁移失败的 scope 跳过，下次启动重试
- 一次迁移后旧代码路径删除（不留双模式——双模式是技术债）

### 21.3 时间窗口
建议在新版本上线时做。旧的 dream 调度器在迁移前禁用。

---

## 22. 实施分期

### Phase 1：Memory 基础设施
- [ ] 新 store API（read/write memory.md + summary.md）
- [ ] 移除 shard-store / shard-index
- [ ] 移除 index.md 写入路径（保留读取兼容用于迁移）
- [ ] 迁移脚本
- [ ] scope-tree 加 topic 注册 + 2 层校验
- [ ] 单元测试

### Phase 2：Recall 重写
- [ ] Engine 持有 scope→path 映射
- [ ] Recall 改为 summary-first（§6.2）
- [ ] 配额合并
- [ ] 集成测试

### Phase 3：Dream 重写
- [ ] runner 主循环
- [ ] state.js（group .dream-state + scope dream-state 块）
- [ ] triage.js（hard rules + 2-pass soft classification）
- [ ] merge.js
- [ ] apply.js（UPDATE/CREATE + 分批 + 原子写）
- [ ] segment.js（diff 切段 + 单条截断）
- [ ] schedule.js（12h 定时）
- [ ] snapshot.js（备份 + 保留 7 次）
- [ ] 4 个 prompt 模板
- [ ] 集成测试（覆盖：正常路径、newCount<20 跳过、超长 diff 切段、超长 merge 分批、CREATE topic、错误回滚）

### Phase 4：Topic Scope 上线
- [ ] scope-tree 注册 topic
- [ ] Engine 注入 activeTopic 上下文
- [ ] UI 展示（user memory page 改为 user + topic 浏览）

### Phase 5：Debug Panel 升级
- [ ] dream 顶部状态 + 触发按钮
- [ ] groups 表 + targets 表
- [ ] 行内展开（diff / prompt / output）
- [ ] 历史视图
- [ ] `dream_progress` 事件接入

### Phase 6（v2.1）：
- Cross-scope 提升 / 沉淀（`_proposals/` 流）
- Topic 合并建议
- Apply 阶段 `noticed_other_scopes_should_update` 兜底
- 派生视图（feature 决策列表 JSON 等）

---

## 23. 开放问题

1. **Topic 怎么"激活"？** 用户进入闲聊后，engine 怎么知道当前在哪个 topic？
   - 候选 A：每轮 LLM 分类，结果作为 activeTopic
   - 候选 B：用户显式选择（UI tab）
   - 候选 C：fastModel 在背景里跑分类，置信度高才注入
   - **倾向 C**，但 v2 不强求——recall 即便不知道 activeTopic，依然能从 user query + 各 topic summary 选出相关的 topic

2. **memory.md 超长时怎么办？**
   - 第一道防线：dream 压缩
   - 第二道防线：recall 时 section pick
   - 极端情况：dream 决定拆分 topic（例如 `science/physics` 太大）—— 但这违反"两层上限"，需要更高决策（v2.1）

3. **Feature 完成后 memory 怎么办？**
   - 候选：归档到只读，不再写入，summary 提升到 group/user
   - 候选：直接保留，dream 周期性压缩
   - **倾向归档+提升**（v2.1，走 `_proposals/`）

4. **VP 学到"这个用户喜欢简洁"，写到 vp 还是 user？**
   - 原则：about user 的事实写 user；about VP 自己怎么应对 user 的策略写 vp
   - 例：
     - "用户喜欢简洁" → user
     - "面对这个用户，我应该精简措辞" → vp/<self>
   - Triage 的 user_profile_signals 命中后，apply 阶段 LLM 自己分情况——hard rules 总是把 user 加进来，让 LLM 在抽取时自然分流

---

## 24. 与 R6 的差异速查

| 维度 | R6 | v2 |
|---|---|---|
| 一个 scope 的文件数 | 1 summary + 1 index + N shard + index.json | 2 文件（memory + summary） |
| 是否有 shard | 是（user/vp/feature 各 5 个） | 否 |
| Topic scope | 不存在 | 一等公民，2 层分类 |
| Index 是否给 LLM 看 | index.md 给（但 recall 没用），index.json 不给 | 没 index，给 LLM 看 summary |
| Recall 选什么 | shard | scope 全文 |
| LLM rerank 看什么 | id+kind+tags（无标题） | summary 文本 |
| 联合多 scope recall | 不支持（一次一个 store） | 一等公民 |
| 写入粒度 | per-entry 文件，每轮 extract | 直接写 memory.md（少数路径），主流程靠 dream 整理 |
| Dream 工作粒度 | 维护 shard，5 阶段单 scope | 全局按 group 分批，4 阶段（triage / merge / apply / bookkeep） |
| Dream 触发 | scope-sig diff-gate + tick | 12h 定时 + 手动 |
| Dream 模型 | fast + primary 混用 | 只用 primaryModel |
| Dream 阈值 | per-scope sig 跳变 | per-group newMessageCount ≥ 20 |
| Overlap 窗口 | 无 | 3 条 message，跨 dream 周期 |
| 长度处理 | 无显式策略 | diff 分段 + apply 分批 + 单条截断 |
| 跨 scope 提升 | 自动 promote | 仅 `_proposals/`，人审 |
| 可观测 | 散在日志 | debug panel 二层视图 + `dream_progress` 事件 |
