# Unify Prompt 概念定义

> **Status**: 设计基线（v1）
> **Scope**: 定义 Unify 引擎每轮发给 LLM 的 system prompt + messages 的概念分层、预算、生命周期。
> **关系**: 与既有 `DESIGN-H2-AMS` / `DESIGN.md` 等文档不一致的部分，以本文为准；老文档对应章节标记 deprecated。

---

## 1. 设计动机

之前的实现把概念糊在了一起：

- **Memory 没有单一出口**：FTS 召回 (`recallResult.formatted`)、AMS snapshot、`renderLayerASummaries(summaries)`、`renderUserProfile`、`renderCoreMemory` 五条路径各自往 system prompt 推内容，同样的 `summary.md` 被渲染两到三次。
- **Compact summary 装错位置**：被当成"全局事实"塞在 system prompt 里，但它本质是**老对话被压缩后的产物**——属于对话时间线，应该在 messages 里。
- **"Working Context" 概念模糊**：既能指对话历史，又能指当前 task / feature / envelope，导致 `taskCtx / userProfile / coreMemory` 等字段散落在 system prompt 末尾，没有统一约束。
- **Memory budget 太小**：`min(50_000, ctx × 0.10)`，对 200K 模型只给 20K，而 `prompts.js` 里其他重复渲染的内容反而吃掉更多 token。

后果：200K context 模型实测 prompt 经常飙到 168K+，远超合理范围。

---

## 2. 顶层概念分层

每一轮（一个 user prompt → engine.query() → LLM）发给 LLM 的输入分成两块：

```
┌─────────────────────────────────────────────────────────┐
│ system prompt                                           │
│                                                         │
│  ① Identity            — 我是谁                          │
│  ② Rules               — 我怎么干活                      │
│  ③ Memory              — 我脑子里都记着啥（AMS 单出口）   │
│  ④ Active Scope        — 我现在处在哪个范围             │
└─────────────────────────────────────────────────────────┘

messages: [
  { role:'user',     content:'<conversation_summary>...</>' }   ← compact = 老对话压缩
  { role:'assistant',content:'OK' }
  ...近 N 轮 hot history（近期对话原文）...
  { role:'user',     content:'<本轮提问>' }
]
```

**System prompt** 装"我是谁 / 规则 / 我知道什么 / 我现在在哪"。
**Messages** 装"我们说过什么"。
两条独立的预算线。

---

## 3. System Prompt 四大类

### ① Identity — 我是谁

- VP persona（`vp/<vpId>/role.md`）；无 persona 时回退到 Yeaft base identity
- 极少变化，会话内基本静态
- 预算：~3K tokens（hard cap，超长截断）

### ② Rules — 我怎么干活

- Group announcement（CLAUDE.md 风格的群级共享前缀）
- Mode unified template（mode-unified.md）
- Tool 列表 + tool-guidance.md
- Skills 内容（按用户 prompt 相关性挑选）
- 通用规则（commonRules：输出格式、代码编辑、搜索、前端约定）

预算：~25K tokens
- tools 名 + 描述：~15K
- skills 内容：~5K（按 budget 截断）
- announcement：~2K（hard cap）
- mode/guidance：~3K

### ③ Memory — 我脑子里都记着啥（AMS 单出口）

> 这是这次重构的核心：**所有"长期/中期记忆"必须经由 AMS 渲染**。其他渲染入口废弃。

**预算**：

```
memoryBudget = min(maxContextTokens × 0.20, 100_000 tokens)
```

| 模型 | maxContext | × 20% | 实际 budget |
|---|---|---|---|
| 200K（Sonnet/Opus）| 200K | 40K | **40K** |
| 1M（Gemini）| 1M | 200K | **100K**（hit cap） |
| 128K（GPT-4 老） | 128K | 25.6K | **25.6K** |

**结构**（AMS 三层）：

```
③ Memory
   ├─ Resident   常驻知识（永远在 prompt 里）
   │   └─ Layer-A summaries：user/group/vp 的 summary.md
   ├─ Recent     最近 N 轮触碰过的 segments（LRU 容量上限）
   └─ OnDemand   本轮 FTS 召回的 segments
```

> **历史脚注（v1 实现状态）**：早期草稿曾计划把 `UserProfile` / `CoreMemory`
> 也合并进 Resident 并以 `pinned` 标记区分优先级。落地时这两条数据源已
> 在前序提交中废弃 —— 用户偏好与核心记忆现在统一通过 `summary.md`（由
> dream consolidation 维护）流入 Layer-A，不再需要单独入口。`pinned`
> 字段同步推迟，等真正出现"必须置顶的常驻条目"再落实。当前 Resident 结构
> 即 `{ scope, summary }`，没有 pinned。

**渲染契约**：

- 只有 `ams.renderForPrompt()`（或等价方法）能写 Memory 块
- engine 不再有第二条渲染路径——`recallResult.formatted` 不再直接注入 system prompt
- `renderLayerASummaries / renderUserProfile / renderCoreMemory` 在 Worker
  prompt 中废弃；`renderUserProfile` / `renderCoreMemory` 已删除
- **Router 例外**：Router prompt 是一条独立的轻量 LLM 调用，**不跑 AMS**
  （它只决定 plans[]，不消费 segments），因此仍然直接调
  `renderLayerASummaries(summaries)` 把三条 Layer-A summary 平铺进 Router
  的 system 上下文。这是**有意保留的例外**，不是迁移漏网。如果将来 Router
  也接入 AMS（让它能看到 OnDemand），这个例外会被一并清理

**写入路径**（每轮 pre-flow）：

```js
// engine.js#runQuery — 真实落地形态
ams.setResident([
  { scope:'user',          summary: layerASummaries.user  },
  { scope:`group/${gid}`,  summary: layerASummaries.group },
  { scope:`vp/${vpId}`,    summary: layerASummaries.vp    },
]);
ams.setOnDemand(ftsRecallEntries);          // FTS 命中
// recent 由各轮自然 LRU
const memoryBlock = ams.renderForPrompt();  // 唯一渲染出口
```

**Budget 切分**（AMS 内部，按 `memoryBudget` 比例打包）：

- Resident：60%（按 scope 顺序打包；`pinned` 字段尚未实现）
- Recent：15%
- OnDemand：25%

层间溢出可借调：Resident 用不完时让给 OnDemand。

### ④ Active Scope — 我现在处在哪个范围

> 不归 AMS。这是**确定性、结构化的小块**，告诉 LLM 当前轮次的作用域信息。

**结构**（每行一项；**只装 ID + 极短标题**，不装长内容）：

```
## Active Scope
feature: <featureId> "<title>"     ← 当前 feature（如果有；可为空）
group:   <groupId>                 ← 当前 group
vp:      <vpId>                    ← 当前发言 VP
envelope: <inbound routing info>   ← 谁 @ 我了 / 上一跳是谁
```

**关键约束**：
- Feature 是 scope，**不是块**。`feature/<id>` 是 memory 的一个 scope，长期内容（决策、状态、历史）走 AMS 召回；Active Scope 只标记"我现在处在哪个 feature 里"
- 大多数轮次 Active Scope 就 1-2 行
- 预算：~1-3K tokens（基本不会触发 cap）

**当前字段映射**：

| Active Scope 字段 | 当前代码字段来源 |
|---|---|
| `feature` | `inboundEnvelope.featureId` |
| `group` | `groupId` |
| `vp` | `vpPersona.vpId` 或 `senderVpId` |
| `envelope` | `inboundEnvelope` 的简化摘要（routing info） |

---

## 4. Messages 数组

### 4.1 结构

```
messages: [
  // 可选：compact summary（老对话被压缩后的产物）
  { role:'user',      content: '<conversation_summary>\n...\n</conversation_summary>' },
  { role:'assistant', content: 'Acknowledged.' },

  // hot history：近 N 轮的 user/assistant/tool messages
  ...hotHistory,

  // 本轮新提问
  { role:'user', content: '<本轮提问>' },
]
```

### 4.2 预算

独立的 `messageTokenBudget`（默认 8K，可调到 25K 左右）。

由 `consolidate.partitionMessages` 决定 hot/cold 分界，cold 部分被 `#runOrchestratorCompact` 压成 compact summary。

### 4.3 Compact Summary 在哪

**当前（错的）**：拼在 system prompt 第 7 节
**目标（对的）**：作为 messages 数组开头的一对 `{user, assistant}` 注入

理由：
- 它是**老对话压缩后的产物**，性质上属于对话时间线
- 放 system 会让 prompt cache 在 compact 更新时失效（因为 system 整体变了），放 messages 头则只让前缀的几条消息变，cache 命中率更高
- 概念干净：system 装"我"，messages 装"我们说过什么"

---

## 5. Post-Turn 处理（四条独立轨）

每轮 `end_turn` 之后，按以下次序检查/触发：

| 轨 | 名称 | 输入 | 输出 | 频率 |
|---|---|---|---|---|
| **T1** | Compact | hot messages 超 `messageTokenBudget × threshold` | 一段压缩文字写到 conversationStore（`compact.md`），下轮注入 messages 头 | 触发式 |
| **T2** | AMS Adjust | 本轮 LLM 决策"哪些 segment 该 pin/evict" | 改 AMS OnDemand 成员 + 持久化 `adjustRanThisSession` | 每会话每 group 至多 1 次 |
| **T3** | Dream（异步） | 本轮 user/assistant 文本 | 写新 segments 到 `<scope>/segments/`、roll-up `summary.md` | 后台 |
| **T4** | Scope Tagging | 本轮内容是否归属某 feature / 该新建 feature | 标记本轮所属 featureId；必要时新建 feature | **暂未实现** |

### 5.1 T4 Scope Tagging（占位）

**当前现状**：T4 不存在。结果：feature scope 只能靠用户/工具显式创建，自动归集机制缺失，AMS 的 `feature/<id>` scope 多半为空。

**暂定方案**（v1 不实现）：
- Active Scope 的 `feature` 字段允许为 `null`
- 所有 feature 创建/分配依赖**外部显式触发**（用户说"开个 feature 叫 X"、工具显式调用）

**未来方向**（记录方向，不动）：
- Post-turn 跑一个轻量 LLM 判定："这轮属于已有的某个 feature 吗 / 该新开 feature 吗 / 不属于任何 feature？"
- 归属已有：下轮 Active Scope 带 featureId
- 新开：创建 `feature/<newId>/` scope + 初始 `summary.md`
- **节流**：不是每轮都跑——只在满足某些信号时触发（用户消息长度 > 阈值、含特定动词、显式 `@feature`）

---

## 6. 与现有代码的差异（重构 Roadmap）

### 6.1 当前代码的五处违反

| # | 位置 | 问题 | 修复 |
|---|---|---|---|
| 1 | `engine.js:953-957` | `recallResult.formatted` 直接拼进 `memoryInjection` | 删除——FTS 结果只通过 AMS OnDemand 出口 |
| 2 | `prompts.js:733-734` `buildWorkerPrompt` | 调 `renderLayerASummaries(summaries)` 第二次渲染 summary.md | 从 Worker prompt 中删除调用；函数本身保留供 Router 使用（Router 不跑 AMS——见 §3 ③ Router 例外） |
| 3 | `prompts.js:362-365` | `compactSummary` 拼在 system prompt | 移到 messages 数组头部 |
| 4 | `prompts.js:371-377` | `renderUserProfile / renderCoreMemory` 各自独立块 | 函数与其依赖的 lang headers 一并删除；UserProfile/CoreMemory 数据源在前序提交中已废弃，统一通过 `summary.md` 流入 Layer-A（见 §3 ③ 历史脚注） |
| 5 | `memory/budget.js` | budget = `min(50K, ctx × 0.10)` | 改为 `min(100K, ctx × 0.20)` |

### 6.2 Phase 化（每个 Phase 单独 PR）

| Phase | 改动 | 风险 | 节省（200K 模型估算） |
|---|---|---|---|
| **P1** | budget = `min(100K, ctx × 0.20)` | 低（纯参数） | budget 提升，AMS 容量翻倍 |
| **P2** | 删除三处重复渲染（违反 #1, #2, #4），统一走 AMS | 低 | ~35K |
| **P3** | compactSummary 从 system 迁到 messages 头 | 中（影响 prompt cache 行为） | ~5K + cache 改善 |
| **P4** | 把散落的 feature/vp/group/envelope 字段整理成统一的 Active Scope 块 | 中（命名 + 字段收紧） | 概念清晰，少量节省 |
| **P5** | T4 Scope Tagging 占位（接口/字段，不实现逻辑） | 低 | 0（仅留口子） |

每个 Phase 之前先跑 `npx vitest run` 锁基线，每个 PR 自带相应测试。

### 6.3 不动的部分

- **AMS 三层结构**：Resident/Recent/OnDemand 这套继续用，只调整 budget 和注入方式
- **Dream（T3）**：异步写盘逻辑不变
- **Adjust（T2）**：调用时机不变
- **Scope/路径模型**：`user/<id>` `group/<id>` `vp/<id>` `feature/<id>` 不变

---

## 7. 验收口径

200K context 模型，重构完成后的 prompt 总量目标：

| 区块 | 预算 |
|---|---|
| ① Identity | ~3K |
| ② Rules（announcement/mode/tools/guidance/skills/commonRules）| ~25K |
| ③ Memory（AMS 单出口，hard budget = 40K） | ≤ 40K |
| ④ Active Scope | ~3K |
| **system 小计** | **≤ 71K** |
| messages（hot history + 可选 compact，受 messageTokenBudget 控） | ~25K |
| **总输入** | **≤ 96K** |

实际预期会更低（很少所有上限同时打满）。

用户期望对齐：
- 总 prompt ≤ 80KB（≈ 20K tokens）—— 在常规会话下能落进
- Memory ≤ 60KB（≈ 15K tokens）—— budget 上限是 40K，常规命中远低于此

---

## 8. 命名约定

为避免后续重复混淆，固定术语：

| 术语 | 含义 | 不要混用 |
|---|---|---|
| **Memory** | system prompt ③ 大类，AMS 出口 | ❌ "上下文"、"context"、"working memory" |
| **AMS** | Active Memory Set，三层缓存（Resident/Recent/OnDemand） | ❌ "memory cache"、"recall layer" |
| **Active Scope** | system prompt ④ 大类，结构化作用域信息 | ❌ "context block"、"working context"、"task ctx" |
| **Messages** | 对话时间线，发给 LLM 的 messages 数组 | ❌ "history" 单独使用（要说 "hot messages" / "compact summary"） |
| **Compact Summary** | 老对话被压缩后的文字，注入 messages 头 | ❌ "summary"（太泛）、"history summary" |
| **Layer-A Summaries** | user/group/vp 三个 scope 的 `summary.md` 文本 | 仅在描述数据来源时使用；prompt 渲染时它们走 AMS Resident |
| **Feature** | 一个 scope 类型 (`feature/<id>`)；同时也是 Active Scope 的一个字段 | ❌ "task"（task 是另一回事） |

---

## 9. 引用

- `agent/unify/memory/ams.js` — AMS 实现
- `agent/unify/memory/budget.js` — Budget 计算
- `agent/unify/memory/preflow.js` — FTS 召回
- `agent/unify/groups/pre-flow.js` — Memory pre-flow 包装
- `agent/unify/prompts.js` — System prompt 装配
- `agent/unify/engine.js` — query loop（pre-flow → 装配 → adapter.stream → post-turn）
- `agent/unify/conversation/persist.js` — Messages + compact 持久化
