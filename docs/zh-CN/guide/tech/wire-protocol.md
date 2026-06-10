# WebSocket 协议

Yeaft 的 server / agent / web client 之间通过 **WebSocket** 通信，所有消息都是 JSON envelope，**字段 `type`** 标识消息类型。本章列**核心 wire types**、**envelope 形状**、**双向消息流**。

> 本章面向**写 server handler / agent driver / 前端 store** 的开发者。

## 设计原则

1. **Type 是协议名，不是品牌名** — `claude_output` 是 Claude stream-json envelope 形状，**所有** provider（含 Copilot、Yeaft 引擎）输出都翻译成它。前端不需要知道下游是谁
2. **Envelope 平坦** — 顶层 `type` + 必要的路由字段（`conversationId` / `sessionId` / `agentId`），其余 payload 在 `data` 或具名字段
3. **Server 是哑中继** — Server 不解析消息内容，只按 `agentId` / `userId` 路由
4. **Wire-level 向后兼容** — 老的字段名（`yeaft_*`、`unify_*`）作为别名保留；不允许为了改名批量重命名

## Envelope 通用结构

```js
{
  type: 'claude_output' | 'yeaft_output' | 'send_message' | ...,
  conversationId?: string,       // 哪个 chat session
  agentId?: string,              // 哪个 agent（server 路由用）
  sessionId?: string,            // provider-specific session id
  // ... 类型相关字段
}
```

## 三个方向

```
┌─────────┐                  ┌──────────┐                  ┌──────────┐
│  Web    │  ◄── server ──►  │  Server  │  ◄── agent ──►   │  Agent   │
│ Client  │     forward      │  (relay) │     forward      │ (driver) │
└─────────┘                  └──────────┘                  └──────────┘
   ▲                                                            ▲
   │                                                            │
   └──── 用户输入 / 渲染输出 ────────────────────── provider 实现 ──┘
```

## 核心 wire types

### 客户端 → Agent（用户输入类）

| Type | 字段 | 含义 |
| --- | --- | --- |
| `send_message` | `conversationId, text, attachments?` | 用户在 Chat 模式发消息 |
| `yeaft_group_chat` | `groupId, text, mentions?, attachments?` | 在 Yeaft Group Mode 发消息（可 @mention VP） |
| `cancel_execution` | `conversationId` | 中断当前 turn |
| `ask_user_answer` | `requestId, answer` | 用户回答 ask-user 提示 |
| `create_conversation` | `provider, workDir, options?` | 启动新 session |
| `resume_conversation` | `conversationId, sessionId` | 恢复历史 session |
| `delete_conversation` | `conversationId` | 删除 session |
| `list_history_sessions` | `provider, workDir` | 列可 resume 的历史 session |
| `list_folders` | `provider` | 列该 provider 有 session 的工作目录 |

### Agent → 客户端（输出类）

| Type | 字段 | 含义 |
| --- | --- | --- |
| `claude_output` | `conversationId, data` | **所有 provider 共用**的输出 envelope（见下） |
| `yeaft_output` | `conversationId, data` | Yeaft 引擎输出（同 `claude_output` 形状，单独 type 方便前端按 VP 分流） |
| `session_ready` | `conversationId, sessionId, ...` | Session 启动完成 |
| `agent_status` | `state, ...` | Agent 心跳状态 |
| `ask_user_question` | `requestId, prompt, choices?` | 工具请求用户输入 |
| `crew_output` | `sessionId, role, data` | Crew 子系统输出 |
| `llm_config` / `mcp_servers_list` / `yeaft_settings` | ... | 各种 settings 查询响应 |

### claude_output `data` 字段（核心）

`data` 是 Claude **stream-json** envelope 形状，无论上游是 Claude / Copilot / Yeaft：

```js
// Assistant 消息（含 text / thinking / tool_use 块）
{
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      { type: 'text', text: '...' },
      { type: 'thinking', thinking: '...', signature: '...' },
      { type: 'tool_use', id: 'tool_xxx', name: 'bash', input: {...} },
    ],
  },
}

// 用户消息（含 tool_result 回显）
{
  type: 'user',
  message: {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'tool_xxx', content: '...' },
    ],
  },
}

// Turn 结束
{
  type: 'result',
  subtype: 'success' | 'error_max_turns' | 'error_during_execution',
  session_id: '...',
  is_error: false,
  duration_ms: 1234,
  total_cost_usd: 0.012,
  usage: { input_tokens, output_tokens, ... },
}

// 系统事件
{
  type: 'system',
  subtype: 'init' | 'compact' | 'error' | ...,
  ...
}
```

**关键**：因为 envelope 形状统一，前端 `MessageList` / `AssistantTurn` / `ToolLine` 这条渲染管线**不需要分支**。

## Provider 翻译详例

### Claude Code → claude_output
Claude CLI 直接吐 stream-json，driver 几乎原样转发：
```js
// stdout 上的每行 JSON
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}
// 包成 envelope
sendToServer({ type: 'claude_output', conversationId, data: parsedLine });
```

### Copilot → claude_output（ACP 翻译）
Copilot 走 ACP JSON-RPC，事件类型不同 — driver 翻译：

| ACP 事件 | claude_output `data` |
| --- | --- |
| `session/agent_text { text }` | `{ type: 'assistant', message: { content: [{ type: 'text', text }] } }` |
| `session/agent_thought { text }` | `{ type: 'assistant', message: { content: [{ type: 'thinking', thinking: text }] } }` |
| `session/tool_call { id, name, input }` | `{ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } }` |
| `session/tool_result { id, content }` | `{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } }` |
| `session/turn_complete` | `{ type: 'result', subtype: 'success', ... }` |
| `session/request_permission` | 走独立 wire type `ask_user_question`（不进 claude_output） |

### Yeaft → claude_output（web-bridge 翻译）
Yeaft engine 吐自己的事件（`text_delta` / `thinking_delta` / `tool_call` / `usage` / `stop`），`web-bridge.js` 翻译成 stream-json：

| Engine 事件 | claude_output `data` |
| --- | --- |
| `text_delta { text }` | `{ type: 'assistant', message: { content: [{ type: 'text', text }] } }` |
| `thinking_delta { text }` | `{ type: 'assistant', message: { content: [{ type: 'thinking', thinking: text }] } }` |
| `tool_call { id, name, input }` | `{ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } }` |
| tool 结果（registry 执行完） | `{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id, content }] } }` |
| `stop { stopReason }` + `usage` | `{ type: 'result', subtype, usage, total_cost_usd }` |

Yeaft 走 `yeaft_output` type（payload 同 claude_output `data`），前端 store 收到后调 `handleYeaftOutput()` → 内部转给 `handleClaudeOutput()`。多套一层 type 是为了按 VP / group 分流。

## yeaft_group_chat（Group Mode 唯一发送通道）

```js
{
  type: 'yeaft_group_chat',
  conversationId: 'yeaft-virtual-xxx',
  groupId: 'group-abc',
  text: '@alice 帮我看下 bug',
  mentions: ['alice'],            // 解析后的 @mention VP names
  attachments: [{ name, mime, base64 }],
}
```

Agent 收到后：
1. `message-router.js` 派给 `handleYeaftGroupChat()`
2. `coordinator.ingest({ groupId, text, mentions, attachments })`
3. 按 mentions 选出 VP 集合（不写 mentions 默认全员）
4. `Promise.all(vps.map(runVpTurn))` 并行跑
5. 每个 VP 的 Engine 事件经 `web-bridge` 翻译成 `yeaft_output` 推回
6. 前端按 VP id 分流到对应 thread

历史别名：`unify_group_chat` 是 `yeaft_group_chat` 的同义词（早期 wire type），server / agent 都接受两个名字，**不要在新代码里使用 `unify_*`**。

## ask-user 双向通信

工具想问用户，走独立 wire：

```
Agent → Web:                                Web → Agent:
{                                           {
  type: 'ask_user_question',                  type: 'ask_user_answer',
  conversationId,                              conversationId,
  requestId: 'q-xxx',                          requestId: 'q-xxx',
  prompt: '...',                               answer: '...',
  choices: ['A', 'B'],         (optional)    }
  multiSelect: false,
}
```

UI 弹 modal → 用户选 → 回传 → 工具 resolve → 继续 turn。

## Conversation lifecycle

```
1. create_conversation        Web → Agent
   { provider, workDir, options }
                              ↓
2. session_ready              Agent → Web
   { conversationId, sessionId, capabilities, modelInfo }
                              ↓
3. send_message               Web → Agent
   { conversationId, text, attachments? }
                              ↓
4. claude_output × N          Agent → Web
   { conversationId, data: { type: 'assistant'/'user'/'result'/'system', ... } }
                              ↓
5. (turn 完成；可以再次 send_message)
                              ↓
   delete_conversation        Web → Agent
   { conversationId }
```

## Server 的角色

Server 是哑中继：
- **不**解析 `data` 内容
- 收到 `claude_output` / `yeaft_output` 等 → 按 `conversationId` 找该 session 所在的 web client → forward
- 收到 `send_message` 等 → 按 agent 路由（`session-pin-router.js`）找到该 conversation 锁定的 agent → forward
- 唯一的 server 侧逻辑：鉴权（JWT）、消息缓冲（agent 暂时断开时）、心跳

`server/handlers/agent-output.js` 是 agent → web 的分发；`server/handlers/client-conversation.js` 是 web → agent 方向。

## Session pin（agent 路由）

一个 user 可能连了多个 agent。Server 用 `session-pin-router.js` 把每个 conversation 锁到**第一次创建它的那个 agent**：
- `create_conversation` 时 server 选 agent → 记 `conversationId → agentId` 映射
- 后续所有 `send_message` 都路由到这个 agent
- agent 离线 → 该 conversation 暂时不可用（用户能看历史，发不出去）

## 心跳 / 缓冲

- **心跳**：agent 每 N 秒发 `agent_status { state: 'idle' | 'busy' }`，server 用来判断 agent 活性
- **缓冲**：agent 短暂断开时，server 缓存待发消息（`message-buffer`），重连后 flush。Web 端也有上行缓冲（`web/stores/chat.js` 里）

## 调试

### 看 raw wire
浏览器 DevTools → Network → WS → 选 WebSocket 连接 → Messages 标签可看每条 envelope。

Agent 侧：`yeaft-agent --debug` 把每条出入消息打到 stdout。

### 看 envelope 翻译
Web 端 Debug 面板的每个 turn 可看「raw envelope log」 — 包括 provider 翻译前的原事件 + 翻译后的 envelope。

## 关键文件

- `agent/connection/message-router.js` — Agent 入站消息分发
- `agent/connection/buffer.js` — `sendToServer()` 出站缓冲
- `server/handlers/agent-output.js` — Server 端 agent → web 分发
- `server/handlers/client-conversation.js` — Server 端 web → agent 分发
- `agent/yeaft/web-bridge.js` — Yeaft engine 事件 → claude_output 翻译
- `agent/providers/copilot.js` — Copilot ACP 事件 → claude_output 翻译

> Wire 兼容性：上面所有 type 名都已在生产环境 widely 使用 — 改一个名字 = 老 agent / 老 web client 全部坏掉。新加 type 没问题，**删除 / 重命名要走废弃流程**（先双发，灰度迁移，再下线）。
