# 反思消息以 user role 收尾 — Bug 修复记录

**日期**: 2026-04-30
**关联 PR**: `fix: reflection collapses to user-role to satisfy Anthropic API contract`
**关联文件**:
- `agent/unify/tool-folding/index.js`
- `test/agent/tool-folding/t1-reflector.test.js`
- `test/agent/tool-folding/engine-reflection-integration.test.js`
- `test/agent/unify/llm/messages-tail-contract.test.js`（新增）

## 现象

Unify 模式下，跟同一个 VP 连续对话超过 13 轮、且这一回合有大量 tool 调用之后，下一次 API 调用返回 400：

> "This model does not support assistant message prefill. The conversation must end with a user message."

## 根因

`agent/unify/tool-folding/index.js` 的 `collapseRangeToReflection()` 把 13 个 tool 调用的弧（assistant + tool, assistant + tool, …）折叠成**一条 `role: 'assistant'` 消息**：

```js
const reflectionMsg = {
  role: 'assistant',          // ← 问题点
  content: reflectionContent,
  _reflection: true,
};
```

折叠之后 `conversationMessages` 形如：

```
[ user(原始 prompt), assistant(反思摘要) ]
```

下一次 `adapter.stream()` 调用会把这个数组直接喂给 Anthropic Messages API。Anthropic 要求：在每一轮 assistant 回复之前，messages 数组必须以 user 消息收尾——否则就被当作"让我接着说我刚才那条 assistant"，而该模型不支持 assistant prefill，于是 400。

T1（13 轮触发的同步反思）和 T2（5 轮触发的异步反思）都走同一个 `collapseRangeToReflection` 函数，所以两条路径都受影响。

## 修复

把折叠后的反思消息从 `assistant` 改成 `user`，并在内容外面包一层 Claude Code 风格的 compact-summary 包装，让模型清楚理解这是一个"上下文恢复指令"而不是"新的用户提问"：

```js
const wrappedContent =
  `The previous ${toolCount} tool calls have been folded for context efficiency.

Summary:
${reflectionContent}

Continue from here.`;

const reflectionMsg = {
  role: 'user',
  content: wrappedContent,
  _reflection: true,
};
```

参考 Claude Code 的 compact 实现 (`src/services/compact/compact.ts`, `src/services/compact/prompt.ts`)：它的压缩摘要也是用 user 消息装的，开头说"This session is being continued..."、结尾说"Continue the conversation..."，靠提示词工程让模型把这条 user 消息当作恢复指令。我们的反思摘要采用了同样的模式。

## 为什么 `user` 而不是 `assistant` / `system`

| 候选 | 问题 |
|---|---|
| `assistant` | 数组以 assistant 收尾 → API 400（当前 bug） |
| `system` | Anthropic Messages API 没有 `system` role 在 messages 数组里——`system` 是顶层独立参数。把摘要放到 system prompt 又会破坏 prompt 缓存，并污染 system 的"静态描述"语义。 |
| `user` ✅ | 唯一合法选项。模型靠 prompt 头尾文字理解这是恢复指令而非真用户提问。 |

## 为什么不用 Claude Code 的 `isCompactSummary` / `isVisibleInTranscriptOnly` flag

Claude Code 给 compact 摘要消息挂了两个本地标签：`isCompactSummary` 和 `isVisibleInTranscriptOnly`。这两个**不是 API 字段**，是 Claude Code 自己前端/transcript/recovery 用的本地标识——Anthropic API 看到的就是干净的 `{role, content}`，模型靠提示词文本本身识别这是摘要。

unify 当前的反思消息**只活在 engine 内部 `conversationMessages` 数组里**，前端走的是 `reflection` 事件（不是把这条消息原样渲染），所以这两个 flag 在 unify 里没消费方。已有的 `_reflection: true` 已经够用——继续保留它即可。

## 测试

1. **`test/agent/tool-folding/t1-reflector.test.js`** — 更新单元测试断言：折叠后消息 role 为 `user`，并验证文本包装正确（含 "folded for context efficiency"、"Continue from here." 收尾、tool 数量）。
2. **`test/agent/tool-folding/engine-reflection-integration.test.js`** — 更新集成测试：跑 13 轮 → T1 触发 → 第 14 次 `adapter.stream()` 看到的 `messages` 数组里有 2 条 user（原始 prompt + 反思摘要）、0 条 assistant、0 条 tool；最后一条 role 为 `user` 且 `_reflection === true`。
3. **`test/agent/unify/llm/messages-tail-contract.test.js`**（新增契约测试）— 直接守卫"messages 数组每次都以 user role 收尾"这条不变量。跑两个 case：
   - 4 个 tool 调用（不触发反思）：每次 `adapter.stream()` 看到的尾部都是 `user` 或 `tool`（后者在 Anthropic adapter 里会合并成 user content block，等价于 user-tail）。
   - 13 个 tool 调用（触发 T1 反思）：第 14 次（折叠后）看到的尾部必须是 `user`，且 `_reflection: true`。

这条契约测试是这个回归没被早发现的根因——之前的集成测试硬断言了 bug 状态（`assistantMsgs.length === 1`，把 bug 当绿色），mock 的 adapter 又不会真的拿这个数组去打 Anthropic，所以测试通过但生产上 400。新加的契约测试**与 mock adapter 无关**，它只盯着"喂给 adapter 的 messages 数组的 tail"，任何把反思消息或别的什么放回 assistant-tail 的改动都会立刻让它红。

## 影响面

- **API**: 修复 400 错误。
- **消息历史**: 折叠后的反思消息从 assistant 变成 user。如果有持久化历史（`agent/unify/conversation/persist.js`），新的反思消息会以 user role 写入 `.md` 文件——这对前端/persist 都是 schema-additive，没有迁移负担。旧的、已写入磁盘的 assistant-role 反思消息（如果存在）也无需迁移：它们就在那儿，下次再调 API 时如果重新走折叠路径，只会替换正在合并的范围，已写盘的旧记录不会被回填。
- **前端**: 不变。前端走的是 engine 的 `reflection` 事件流，不直接读 `conversationMessages`。

## 全量测试

`npx vitest run` — 1203 / 1203 通过。
