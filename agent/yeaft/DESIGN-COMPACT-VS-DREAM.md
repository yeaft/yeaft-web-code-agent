# Compact vs Dream — 边界文档（Hard Invariant）

> **Status**: 设计基线（v1，2026-06-09）
> **Scope**: 锁住"history compact"和"memory dream"两条管道的**物理边界**——磁盘根、写入口、读出口、prompt 注入位置、scheduler 各自独立，互不替代、互不污染。
> **关系**: 与 `DESIGN-PROMPT.md` §4.3、`engine.js:1494` HARD INVARIANT 注释、`memory/DESIGN-H2-AMS.md` 共同构成边界三件套。

---

## 0. 为什么要写这份文档

> 用户原话（2026-06-09）：**"compact 和 dream 是两个不一样的事情，不要混在一起。dream 解决的是 system prompt，compact 是解决 history message。但是这两个都必须要保证 work。"**

历史上这个边界被违反过两次：

1. **DESIGN-PROMPT.md §4.3 案例**：早期把 `<conversation_summary>`（compact 产物）塞进了 system prompt，导致每次 compact 都 invalidate 整个 prompt cache，prompt 飙到 168K+。修复方式是把它挪到 messages 数组头部。
2. **51e29a24 案例**：VP-thread 重构里误删了 `scheduleAfterTurn` 唯一的调用点，`Compactor` 类完整但成了死代码——直到本 PR (Part 2) 才接活。

两次都是 LLM cache-thrash + persona-dup 跟进 PR 才修干净。这份文档的作用：把两条管道的物理隔离写成一目了然的对照表，任何动这片代码的人**必须**读完。

---

## 1. 八列对照表

| 维度                 | Compact                                                   | Dream V2                                                          |
| ------------------- | --------------------------------------------------------- | ----------------------------------------------------------------- |
| **解决什么**         | 老 message 太长 → 压缩成一段 summary 文本                  | system prompt 里的 memory section 滞后于事实 → 后台维护           |
| **写入磁盘根**       | `<yeaftDir>/groups/<sessionId>/conversation/compact/`     | `<memoryRoot>/<scope>/`                                           |
| **写入文件**         | `<vpId>.md`（per-(session, vp) 一份纯文本 summary）        | `memory.md` + `summary.md` 配对（per-scope 一对，原子 rename）    |
| **谁写**             | `engine.js#runOrchestratorCompact` → `persist.replaceCompactSummaryFor(sessionId, vpId, summary)` <br/> 以及 `Compactor#_runOnce` → `compactHistory` | `dream-v2/apply.js` → `store-v2.writeMemory(...)` / `writeSummary(...)` |
| **谁读 / 怎么进 LLM** | `engine.js:1532` `#getCompactSummary()` → 包装成 `<conversation_summary>` user/assistant 对 → **prepend 到 messages 数组头** | `engine.js#buildResidentEntries` (≈:253) → AMS Resident 层 → `prompts.js#buildSystemPrompt` §6 Memory section |
| **Prompt slot**     | `messages[0..1]`（user + 'OK' assistant）                  | `system prompt` 的 §6 Memory（**唯一**注入位置）                  |
| **Scheduler**       | (a) 反应式：LLMContextError → `runOrchestratorCompact` <br/> (b) 主动式：`Compactor.scheduleAfterTurn(sessionId, historyHandle)` post-turn fire-and-forget，由 `web-bridge.js#handleYeaftSessionSend` 末尾接活 | (a) `engine.js#query()` 末尾的 consolidation 判断 → `triggerDream()` <br/> (b) `dream-v2/run.js` 后台 scheduler |
| **触发归属（谁判断）** | `shouldCompactHistory(messages, { maxContextTokens, tokenFraction: 0.7 })` 纯函数 | `memory/consolidate.js`（**注**：与本文件已分离的 `compact/partition.js` 同名巧合无关）+ `dream-v2/triage.js` |
| **LLM 调用**        | `engine.summarizeForCompact({ system, prompt, maxTokens })`（一次性 summarize） | `dream-v2` 自己的 extract/triage/apply 三段 LLM pipeline           |

---

## 2. 互不能做的 5 条规则 ❌

### ❌ Rule 1 — Compact 产物**永远**不进 system prompt

任何把 `<conversation_summary>...</conversation_summary>` 文本拼到 system prompt 的代码都是 bug。**理由**：

- 破坏 prompt cache hit-rate：compact 触发的频率比 system prompt 慢，混在一起意味着每次 compact 都 invalidate 整段 system；
- 概念错位：compact 是"老对话被压缩了"，本质属于 dialogue 时间线；
- DESIGN-PROMPT.md §4.3 已明文禁止。

**唯一注入点**：`engine.js:1532` 的 `compactMessages = [...]` 数组，被 prepend 到 `conversationMessages`。

### ❌ Rule 2 — Dream 产物**永远**不进 messages 数组

任何把 `memory.md` / `summary.md` 文本塞到 user / assistant message 的代码都是 bug。**理由**：

- 它本质是"事实库"，不是对话；放进 messages 会被 LLM 当成"用户刚说的话"重复处理；
- AMS Resident 层已经是 system prompt 的 §6 Memory section，**已经**进了 LLM 视野，再塞一份是重复。

**唯一注入点**：`prompts.js#buildSystemPrompt`（参考 :380-390 附近），由 AMS Resident 层喂给它的 `summaries` 参数。

### ❌ Rule 3 — Compact 和 Dream **不**共享 scheduler

两条管道**不**共用 trigger 判断、**不**共用 in-flight gate、**不**共用 single-flight slot：

- Compact 走 `Compactor`（per-session single-flight + anti-starvation pending，`compact/compactor.js`）；
- Dream 走 `dream-v2/run.js` 自己的 scheduler，per-session 独立。

如果出现一个"双管齐下"的统一 scheduler，那是反模式——立刻 revert。

### ❌ Rule 4 — Compact 和 Dream **不**共享存储原语

- Compact 只用 `conversation/persist.js#replaceCompactSummaryFor(sessionId, vpId, summary)`；
- Dream 只用 `memory/store-v2.js#writeMemory/writeSummary` 和 `memory/segment-store.js#writeSegment`。

任何一边调到对方的写入函数 = bug。文件树里两条路径完全不相交（一个在 `conversation/`，一个在 `memory/`）。

### ❌ Rule 5 — Compact 和 Dream **不**共享 trigger 触发器

- Compact 触发：`history tokens > tokenFraction × maxContextTokens`（默认 70%，旋钮 `config.compactTriggerRatio`）；
- Dream 触发：consolidation predicate（segment 数 / 最近写入间隔 / 待 triage diff 量等业务信号），**不**看 token 数。

合并触发器会让 dream 在 70% 时被错误唤醒（白烧 LLM token），或让 compact 在 segment 满了时被错误唤醒（拖延 turn latency）。**永不要合并。**

---

## 3. 物理结构图

```
<yeaftDir>/                                        ~/.yeaft/
├── groups/<sessionId>/conversation/               ┐
│   ├── compact/<vpId>.md          ← COMPACT 写入  │   per-(session, vp)
│   ├── messages/m####.md                          │   conversation tree
│   └── cold/m####.md                              ┘
│
└── memory/                                        ┐
    ├── user/                      ← DREAM 写入   │   per-scope memory
    │   ├── memory.md                              │   tree (Layer-A)
    │   └── summary.md                             │
    ├── group/<sessionId>/                         │
    │   ├── memory.md                              │
    │   └── summary.md                             │
    └── vp/<vpId>/                                 │
        ├── memory.md                              │
        ├── summary.md                             │
        └── segments/<id>.md       ← Dream segment │
                                                   ┘
```

> **注**：`memory/group/<sessionId>/...` 是当前 layout，scope kind 是 `'group'`/`'group-vp'` 等。Plan 里讨论过整体改名到 `session/...`，但 CLAUDE.md 明确："不要为了改名而批量重命名，会炸 wire compatibility"，所以**保留 group/ 字面值**，只在 engine.js 层修了 AMS scope 字符串里的 VP 隔离 bug（参考 `agent/yeaft/engine.js#buildResidentEntries`）。

---

## 4. "两者都必须 work" 的最小集成测试

回归测试在 `test/agent/yeaft/integration/compact-dream-boundary.test.js`，覆盖以下三个 case 摘要：

### Case A — Compact 写盘 ≠ Memory 写盘

构造长对话 → 触发 `runOrchestratorCompact` → 断言：

- `<yeaftDir>/groups/<sid>/conversation/compact/<vpId>.md` **存在且非空**；
- `<yeaftDir>/memory/group/<sid>/{memory.md,summary.md}` **未被改写**（mtime 未变）。

### Case B — Dream 写盘 ≠ Compact 写盘

手动 `triggerDream()` → 断言：

- `<yeaftDir>/memory/group/<sid>/{memory.md,summary.md}` **有更新**（mtime 推进）；
- `<yeaftDir>/groups/<sid>/conversation/compact/<vpId>.md` **未被改写**。

### Case C — 同时存在两份产物 → 互不替代

新 turn 跑完，抓 `_buildSystemPrompt` 返回值 + `conversationMessages` 出参 → 断言：

- system prompt 的 §6 Memory section **含** dream 产物（经 AMS）；
- messages 头部**含** `<conversation_summary>` 包裹的 compact 产物；
- system prompt **不含** `<conversation_summary>`；
- messages 数组**不含** dream 写的 `memory.md` / `summary.md` 内容。

任何一条断言失败 = 边界被破坏，立即修复（不是更新测试期望）。

---

## 5. 修改本文档相关代码的人必读

如果你正在动这片代码中的任何一处，回答这 3 个问题：

1. **我改的是 Compact 路径还是 Dream 路径？** 看上面对照表第二行的"写入磁盘根"——你的代码在哪个目录？
2. **我新加 / 改的 prompt 注入点在哪？** 必须是上面"Prompt slot"里列的位置，不是的话停下来重新设计。
3. **我有没有共用 scheduler / store / trigger？** 任何一项是"是"，去看上面 ❌ 规则 3 / 4 / 5。

如果有疑问，请 ping 当时设计这套架构的 reviewer（`engine.js:1494` HARD INVARIANT 注释里有 git history 入口），不要"我觉得合理"就动。

---

## 6. 相关文档

| 文档                              | 与本文档的关系                                                |
| -------------------------------- | ------------------------------------------------------------ |
| `engine.js:1494` 注释块          | 代码层面的 HARD INVARIANT 标记，引用本文件                    |
| `agent/yeaft/DESIGN-PROMPT.md` §4.3 | 历史 case 的根因复盘 + Memory section 唯一出口规则            |
| `agent/yeaft/memory/DESIGN-H2-AMS.md` | Dream V2 / AMS 的内部架构（本文档不重述）                    |
| `agent/yeaft/compact/orchestrator.js` | 反应式 compact 入口（LLMContextError 触发）                  |
| `agent/yeaft/compact/compactor.js`    | 主动式 compact 入口（post-turn 70% 触发），由 `Compactor` 类管理 |
| `agent/yeaft/compact/partition.js`    | Hot-window 切分纯函数（**注**：仅服务 compact，名字保留 `shouldConsolidate` 是历史 caller 别名） |
| `agent/yeaft/dream-v2/run.js`        | Dream 后台 scheduler 入口                                    |
