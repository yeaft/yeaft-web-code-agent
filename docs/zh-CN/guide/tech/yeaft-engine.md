# Yeaft 引擎

Yeaft 自有的 AI 引擎跑在 `agent/yeaft/`，**不依赖**任何外部 CLI（Claude / Copilot 都不需要）。它有自己的 query loop、记忆系统、工具集、LLM 路由。本章讲它的**核心架构**和 **turn lifecycle**。

> 本章面向**想读 Yeaft 引擎代码 / 改它**的开发者。普通用户视角看 [Yeaft Code Agent](../user/yeaft-group.md)。

## 模块布局

```
agent/yeaft/
  engine.js        — 主 query loop（turn-based）
  session.js       — Session orchestrator（loadSession 把所有子系统串起来）
  config.js        — 从 ~/.yeaft/config.json 读配置
  prompts.js       — 双语 system prompt builder
  models.js        — Model registry（上下文窗口、output limit、provider 推断）

  sessions/        — Session 编排（coordinator、roster、store、pre-flow）
  routing/         — Turn 内路由 + loop guard
  router/          — Continuity / thinking 相关路由策略
  memory/          — H2-AMS 记忆子系统（见 yeaft-memory.md）
  llm/             — LLM 适配器层（见 yeaft-llm.md）
  tools/           — 内置工具表
  templates/       — System prompt 模板
  conversation/    — Message 持久化 + 搜索
  dream/        — 后台记忆维护
  compact/         — 上下文 compact 策略
  eval/            — 评估脚本

  web-bridge.js    — Engine 事件 → claude_output envelope 翻译
```

## Engine Query Loop（核心 turn cycle）

`engine.js` 是引擎的主循环。一个 user turn 进来后，引擎做：

```
1. Pre-query
   - preflow.recall(scopes) — 跨 user/vp/group/feature scope FTS 召回相关记忆
   - 注入到 system prompt
   - AMS（Active Memory Set）三层缓存（Resident summary / Recent / OnDemand）一并注入

2. 构造 messages 数组
   - system: 模板 + 记忆 + persona + tool-guidance + project doc
   - history: 该 thread 的历史消息（如有 compact summary 一并带上）
   - 当前 user message

3. adapter.stream({ model, system, messages, tools, signal })
   - 收 text_delta / thinking_delta / tool_call / usage / stop 事件
   - 实时通过 web-bridge 推到前端

4. 收到 tool_call 事件
   - ToolRegistry.execute(name, input, ctx) — 执行工具
   - 把结果 append 到 messages（role: 'tool'）
   - 回到 step 3 继续 stream

5. 收到 stop 事件
   - stop_reason === 'end_turn' → 持久化 messages → 检查是否需要 consolidation → 完成 turn
   - stop_reason === 'max_tokens' → auto-continue（最多 3 次）
   - stop_reason === 'tool_use' → 已在 step 4 处理

6. 错误处理
   - LLMContextError → 强制 compact → 重试
   - 可重试错误 + 配了 fallbackModel → 换 model → 重试
   - 不可重试错误 → 终止 turn，错误传给用户
```

## Turn lifecycle 详细图

```
                  ┌─────────────────────────┐
   user message → │ runVpTurn(group, vp)    │
                  └────────────┬────────────┘
                               ↓
                  ┌─────────────────────────┐
                  │ preflow.recall(scopes)  │  ← FTS over user/vp/group/feature
                  │ → memory hits            │
                  └────────────┬────────────┘
                               ↓
                  ┌─────────────────────────┐
                  │ buildSystemPrompt()     │  ← templates + persona + memory + tool guidance
                  └────────────┬────────────┘
                               ↓
                  ┌─────────────────────────┐
                  │ Engine.query(messages)  │  ← the loop
                  └────────────┬────────────┘
              ┌────────────────┴────────────────┐
              ↓                                 ↓
      ┌──────────────┐                  ┌──────────────┐
      │ adapter.stream → events          │ tool_call event
      └──────┬───────┘                   └──────┬───────┘
             ↓                                  ↓
       text_delta / thinking_delta       ToolRegistry.execute
        → web-bridge → frontend           → append tool result
                                          → re-stream
             ↓
       stop event (end_turn)
             ↓
      ┌──────────────────────┐
      │ persist messages     │
      │ trigger consolidate? │  ← if yes, schedule dream maintenance
      │ adjust AMS (max 1×)  │
      └──────┬───────────────┘
             ↓
        turn complete → web-bridge emits 'result' envelope
```

## Session & VP 编排

### Session
`session.js` 的 `loadSession()` 把所有子系统串起来：

```js
const session = await loadSession({ conversationId, userId, agentId });
// → { engine, memory, tools, llm, ... }
```

一个 session 包含：
- 一个 `Engine` 实例
- Session 状态、roster、活跃 VP、以及每个 VP 的 turn 状态
- 共享的 `memory` / `tools` / `llm` 子系统

### Session fan-out
`sessions/coordinator.js` 接到 `yeaft_session_send`（legacy alias: `yeaft_session_chat`）后：

```js
async ingest({ sessionId, text, mentions, attachments }) {
  const vps = roster.resolveVps(mentions);  // @mention → VPs（不写默认 VP）
  await Promise.all(vps.map(vp => runVpTurn(session, vp, text)));
}
```

VP 并行跑 `runVpTurn`，每个 VP 一个 `Engine.query()`。完成时间不同，事件按 VP 分流。

### Routing & loop guard
`routing/` 处理 turn 内的路由（VP→VP `route_forward`）+ loop guard（防止 ping-pong）。`routing/loop-guard.js` 检测同一对 VP 在短时间内多次互相 ping-pong → 强制中止。

## System Prompt 模板

`templates/` 下有几个核心模板：

| 模板 | 作用 |
| --- | --- |
| `base.md` | 核心身份 + 原则（双语 EN/zh） |
| `identity-yeaft.md` | Yeaft 身份 + brand 指令 |
| `common-rules.md` | 公共行为规则（不撒谎、不假装查询…） |
| `mode-unified.md` | 当前唯一的运行 mode（覆盖 Session 协作所需指令） |
| `mode-dream.md` | Dream 模式：记忆维护用的 prompt |
| `plan-instruction.md` | 计划阶段的额外指令 |
| `tool-guidance.md` | 工具使用最佳实践 |
| `personas/` | Jobs / Torvalds / Fowler / Rams / Beck 等预设人格 |
| `harness/` | Harness 级指令（环境信息等） |

`prompts.js` 的 `buildSystemPrompt()` 按当前 VP 配置 + 当前 mode + 记忆 + 项目 doc 拼最终 prompt。

> 历史模板（`mode-chat.md` / `mode-worker.md` / `mode-coordinator.md`）已合并进 `mode-unified.md` + `personas/`，不再单独存在。

## Web Bridge

`web-bridge.js` 把 Engine 事件翻译成 `claude_output` envelope 推给 server：

```
Engine emits:                Web bridge emits:
─────────────────────────────────────────────────────────────
text_delta                   { type: 'assistant', message: { content: [{ type: 'text', text }] } }
thinking_delta               { type: 'assistant', ... thinking block }
tool_call                    { type: 'assistant', ... tool_use block }
tool_result                  { type: 'user',      ... tool_result block }
usage / stop                 { type: 'result',    subtype, ... }
```

这是 Yeaft 引擎复用 Claude 渲染管线的关键 — 前端 `MessageList` / `AssistantTurn` 不知道下游是 Yeaft 还是 Claude CLI。

## 工具系统

`tools/registry.js` 是工具注册表：

```js
const registry = createFullRegistry({ scope, mode, allowedTools });
const result = await registry.execute(toolName, input, ctx);
```

工具按 mode 过滤：`unified` 模式给完整 30+ 工具，`dream` 模式只给记忆维护相关工具。

工具实现按类别分文件，见 [Yeaft Code Agent](../user/yeaft-group.md) 的工具清单。

## 记忆 / LLM / Group 子系统

每个都有独立的章节：
- 记忆 → [Yeaft 记忆系统 (H2-AMS)](./yeaft-memory.md)
- LLM 层 → [Yeaft LLM 层](./yeaft-llm.md)
- Wire 协议 → [WebSocket 协议](./wire-protocol.md)

## 测试

- `test/agent/yeaft-phase5.test.js` — engine 核心
- `test/agent/yeaft-phase6.test.js` — 多 VP / group 编排
- `test/agent/yeaft-eval.test.js` — 端到端评估

> 测试文件名沿用历史 "yeaft" 前缀，实际覆盖现在叫 Yeaft 的引擎。

## 关键文件

- `agent/yeaft/engine.js` — 主 query loop
- `agent/yeaft/session.js` — Session orchestrator
- `agent/yeaft/sessions/coordinator.js` — Session 内多 VP fan-out
- `agent/yeaft/prompts.js` — System prompt builder
- `agent/yeaft/web-bridge.js` — Event → wire 翻译
- `agent/yeaft/tools/registry.js` — 工具注册表
