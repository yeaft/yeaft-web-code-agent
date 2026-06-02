# Yeaft 群聊 in-memory 历史 compact

**日期**: 2026-04-30
**关联 PR**: `feat(yeaft): in-memory history compact for group chat`
**关联文件**:
- `agent/yeaft/web-bridge.js` — 接入点（`handleYeaftGroupChat` 顶部 entry gate + fan-out 结束后 schedule）
- `agent/yeaft/history-compact.js` — 新增的纯函数 helper
- `agent/yeaft/engine.js` — 新增 `engine.summarizeForCompact()` 方法
- `test/agent/yeaft/history-compact/history-compact.test.js` — 48 个 helper 单测
- `test/agent/engine-summarize-for-compact.test.js` — 4 个 engine 接入测试

## 现象

用户反馈："yeaft 群聊 load history message 不会以窗口的方式收窄，导致 message 无限膨胀。"

## 根因

`agent/yeaft/web-bridge.js` 第 82 行有个**模块级**数组：

```js
let conversationMessages = [];
```

它是 group fan-out 时喂给每个 VP 的"上下文 base"。每轮 turn 完成后 `appendTurnToHistory` 仅 `push`：user prompt + assistant + N×tool result。

链路上**只有这个数组没有窗口**：

| 环节 | 是否限窗 | 文件:行 |
|---|---|---|
| 前端 Yeaft 打开时拉历史 | ✅ `limit: 50` | `web/stores/chat.js:518, 1195` |
| 后端响应前端 history 请求 | ✅ 默认 50 | `web-bridge.js:1430` |
| 启动 / 重置时从磁盘 seed | ✅ `loadRecent(50)` | `web-bridge.js:929, 1410, 1415, 1487` |
| **每轮 turn 喂给 LLM 的 baseSnapshot** | ❌ **完全无 cap** | `web-bridge.js:826` |
| 每轮完成后 push 进 conversationMessages | ❌ 仅 push，无裁剪 | `web-bridge.js:1128-1152` |

`engine.js` 里已经存在的 `#runOrchestratorCompact` 是另一条路径——它操作磁盘上的 `conversationStore`，不会触碰这个 in-memory 数组。所以即使它判定"该 compact 了"，对群聊送 LLM 的 prompt 也**没有任何效果**。

## 修复策略

参考 Claude Code 的 compact 模式，做 in-memory 数组层面的 compact：

**触发条件**（任一即可，每次 fan-out **结束之后** 检查）：
- turn 数 > 20（去重后的 user-role 消息数；多 VP fan-out 算一轮 turn）
- 估算 token 数 > 80,000

**Compact 时机（post-turn）**：
- compact 跑在 `Promise.all(runVpTurn)` 完成 **之后**，是一个 fire-and-forget 的后台任务，不会给当前用户消息加延迟。
- `_compactInFlight` 暴露成 module-level Promise。下一条用户消息进来时，`handleYeaftGroupChat` 顶部有个 entry gate 会先 `await _compactInFlight`，确保 baseSnapshot 读到的是 compact 之后的历史。
- 单飞守卫：同时只允许一个 compact 跑。

**Compact 动作**：
1. 找到"切点"：从尾部往前数，保留最近 2 个 user→assistant 弧（`keepRecent=2`），切点之前的全部折叠。多 VP fan-out 算同一个 turn（按 `@vp-X` 前缀剥离后比对 canonical text）。
2. 折叠区送给 fast model 做 summary（drop tool results、drop 已存在的 `_compactSummary`、把 toolCalls 折成 `[tool name: input...]` 占位符——节省 token）。
3. summary 用 user-role 包装（沿用 `tool-folding/index.js#collapseRangeToReflection` 的做法，与 Claude Code 的 compact marker 一致）：

```text
This session is being continued from a previous conversation. The earlier
context has been summarized for efficiency.

Summary of conversation so far:
<summary>

Continue the conversation from where it left off without asking the user any
further questions.
```

4. 换掉 `conversationMessages` 为 `[summaryMsg, ...recentTail]`。

**为什么 user role**：Anthropic Messages API 要求 messages 以 user 结尾才能开下一轮 assistant。assistant prefill 会被 400 拒。Claude Code 的 compact 也是 user role，前端 / server 已经存在的过滤器 (`web/stores/helpers/claudeOutput.js`、`server/db/message-db.js`) 就是匹配 `"This session is being continued from a previous conversation"` 这个字符串，自动复用。

**为什么不落盘**：磁盘那条 `loadRecent(50)` 已经有窗口，重启后再次累积超限会再触发 compact。落盘需要识别 compact_summary 锚点的逻辑，作为 follow-up PR 单独做。

## 实现

### `agent/yeaft/history-compact.js`（新增）

纯函数模块，无副作用，无 I/O：

| 导出 | 作用 |
|---|---|
| `DEFAULT_TURN_LIMIT = 20` | 触发阈值常量 |
| `DEFAULT_TOKEN_LIMIT = 80_000` | 触发阈值常量 |
| `DEFAULT_KEEP_RECENT_TURNS = 2` | tail 保留量 |
| `estimateMessageTokens(m)` | 单条消息 token 估算（content + role 框架 + toolCalls） |
| `estimateMessagesTokens(ms)` | 数组求和 |
| `countTurns(ms)` | turn 数（多 VP fan-out 去重） |
| `shouldCompactHistory(ms, opts)` | 触发判定，返回 `{trigger, reason, turnCount, tokenCount, ...}` |
| `findCutIndex(ms, keepRecent)` | 切点计算 |
| `buildSummarizerInput(ms)` | 喂给 summary LLM 之前清洗（drop tool / `_compactSummary`，elide toolCalls） |
| `wrapSummaryAsUserMessage(summary)` | 输出 `{role:'user', content:wrapped, _compactSummary:true}` |
| `buildSummaryPrompt(cleaned)` | 返回 `{system, prompt}` |
| `compactHistory(ms, opts)` | 端到端：触发判定 → 切点 → summarize → 包装 → 返回新数组 |

### `agent/yeaft/engine.js`（新增方法）

```js
async summarizeForCompact({ system, prompt, maxTokens = 1024 }) {
  if (!system || !prompt) return '';
  try {
    const out = await this.#adapter.call({
      model: this.#fastConfig.model,
      system,
      messages: [{ role: 'user', content: prompt }],
      maxTokens,
    });
    return (out?.text || '').trim();
  } catch (err) {
    console.warn('[Engine] summarizeForCompact failed:', err?.message || err);
    return '';
  }
}
```

避免 web-bridge 直接戳 `#adapter` 私有字段。沿用 fast model（`fastModelId`）—— compact 是内部任务，不该烧 primary 模型预算。

### `agent/yeaft/web-bridge.js`（接入点）

`handleYeaftGroupChat` 顶部有 entry gate；fan-out 结束后调度 compact：

```js
// 顶部 — entry gate：等待上一轮 turn 触发的 compact 完成
if (_compactInFlight) {
  try { await _compactInFlight; } catch { /* first caller logs */ }
}

// ... 现有逻辑，captureBaseSnapshot, fan-out ...
const baseSnapshot = [...conversationMessages];
await Promise.all(captured.map(runVpTurn));

// fan-out 结束后调度 compact（fire-and-forget，不阻塞响应）
scheduleCompactAfterTurn(groupId);
```

`scheduleCompactAfterTurn(groupId)`（同步函数）：
- 单飞守卫 `_compactInFlight`：避免重复触发。
- 先做 cheap pre-check（`shouldCompactHistory` 是纯 O(n)），不触发就直接返回，不打 LLM。
- 触发后把 `runCompactNow(groupId)` 挂到 `_compactInFlight`，下一轮 turn 自然在 entry gate 处等它。

`runCompactNow(groupId)`（async 工作函数）：
- **Race guard**：进入时先 `const snapshot = conversationMessages` 把引用记下；compact 跑完准备 swap 时检查 `conversationMessages !== snapshot`——如果在我们 await 期间有人 reassign 过这个数组（engine consolidate 事件、`clearYeaftMessages`、session reset），就丢弃 stale summary，不污染 fresh state。
- summarize 失败：保留原历史，下次 fan-out 重试。
- 成功后向前端发 `yeaft_history_compacted` 事件（携带 reason / 折前折后的 turn 和 token 数）—— 前端目前不消费，留给 dev tools 或将来的 UI 通知。

### 多 VP fan-out 的 turn 计数去重

`countTurns` / `findCutIndex` 都对 user-role 消息做 canonical text 去重——把 `@vp-${vpId} ` 前缀剥掉后比对，连续相同的算一个 turn。否则 5 个 VP 的一次 fan-out 会被算成 5 个 turn，触发器会过早触发。

注意去重**只发生在计数和切点计算时**——`appendTurnToHistory` 仍然每个 VP push 一条 user-role 消息（带 `@vp-X` 前缀），存储不变。这是按 user-facing notion 去重，不动底层数据。

## 测试

`agent/yeaft/history-compact.test.js` — **48 个 case**：

| 模块 | 覆盖 |
|---|---|
| 默认值 | 20 turns / 80K tokens / keepRecent=2 |
| token 估算 | content / toolCalls / null / tool messages |
| turn 计数 | user-only / 空 / 非数组 |
| 触发判定 | turn-only / token-only / both / 自定义 / 不触发 |
| 切点 | 空 / 不够长 / 多种 keepRecent |
| summarizer input | drop tool / drop `_compactSummary` / elide toolCalls / 截断长 input / drop 空消息 |
| wrap 格式 | role=user / `_compactSummary=true` / 包含 Claude Code 锚点字符串 / Continue directive / summary 体逐字 / 空 summary 兜底 |
| 端到端 | 不触发即 no-op / 缺 summarize 抛错 / turn 触发 / token 触发 / summarizer 失败兜底 / 不污染输入 / 自定义 keepRecent / 触发但太短无法折 |
| **关键回归保护** | tail 起始的孤儿 tool 消息会被丢掉（否则 chat-completions 适配器 400） |

`engine-summarize-for-compact.test.js` — **4 个 case**：fast model 路由、空字符串失败兜底、缺参数兜底、自定义 maxTokens。

`npx vitest run` —— **1278 / 1278 通过**（既有 1226 + 新增 52）。

## 影响面

- **API**: 无变化。
- **持久化**: 无变化（只动 in-memory，不写盘）。
- **wire 协议**: 新增 `type: 'yeaft_history_compacted'` 事件（前端可忽略，无 schema 破坏）。
- **行为变化**: 长会话不再无限膨胀 LLM prompt。compact 跑在 turn 结束后，不延迟当前消息——但 **下一条** 用户消息进来时如果 compact 还没跑完，会在 entry gate 处等待（fast model 通常 1–3s）。与"模型彻底卡死/超长 prompt 报错"相比可接受。
- **既有 compact 路径**: 完全不受影响。`engine.#runOrchestratorCompact` 还在做磁盘 store 的 compact，两条路径互不干扰。

## Follow-up（不在本 PR）

- 落盘：让重启后能从磁盘恢复 compact summary（需要识别 `_compactSummary` 锚点 + `loadRecent` 切片逻辑配合）。
- 前端 UI：消费 `yeaft_history_compacted` 事件，给用户一个轻提示"对话历史已压缩"。
- 阈值可配：把 20/80K 提到 `~/.yeaft/config.json`。
