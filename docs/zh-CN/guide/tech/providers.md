# Provider 系统

Yeaft 有两条 provider 集成路径：

1. **ChatProvider**：给 Claude Code CLI、GitHub Copilot CLI 这类 1:1 CLI chat 后端使用。
2. **Yeaft LLM adapter**：给原生 **Yeaft Code Agent** 引擎使用，每个 VP 直接路由到 Anthropic 或 OpenAI Responses 兼容 provider。

本章重点讲 ChatProvider，因为这是新增 1:1 chat 后端的扩展点。如果你只是想把另一个 LLM 接到 Yeaft Code Agent，先看 [Yeaft 引擎配置](../yeaft-config.md) 和 [Yeaft LLM 层](./yeaft-llm.md)；大多数 provider 只需要改 `~/.yeaft/config.json`，不需要写新的 ChatProvider driver。

> 本章面向**想加新 provider** 或**想理解为什么前端不区分 Claude / Copilot 渲染**的开发者。普通用户视角看 [选择会话后端](../user/choose-backend.md)。

## 设计目标

1. **前端零分支** — `MessageList` / `AssistantTurn` / `ToolLine` 这一套渲染管线**不知道**消息来自 Claude 还是 Copilot
2. **协议而非品牌** — `claude_output` 是 **wire protocol 名**（envelope 形状），不是 vendor 名。任何 provider 把自己的事件流翻译成这个 envelope 就能复用前端
3. **能力声明而非硬编码** — UI 通过 `capabilities` flag 决定显隐按钮（compact 按钮 / 模型选择器 / Expert Panel 等），不去 string-match provider 名

## ChatProvider 接口

定义在 `agent/providers/base.js`（JSDoc 类型）：

```js
/**
 * @typedef {Object} ChatProvider
 * @property {string} name                            // 'claude-code' | 'copilot'
 * @property {ProviderCapabilities} capabilities      // 静态能力 flag
 * @property {(opts) => Promise<state>} start         // 启动会话
 * @property {(state, prompt, opts) => Promise<void>} sendInput  // 发消息
 * @property {(state) => void} abort                  // 中止当前 turn
 * @property {(state) => Promise<void>} [clear]       // 可选 — /clear in-place 重置
 * @property {() => Promise<FolderInfo[]>} listFolders        // 列工作目录
 * @property {(workDir) => Promise<SessionInfo[]>} listSessions  // 列可恢复 session
 * @property {(workDir, sessionId, limit?) => Promise<HistoryMessage[]>} loadHistory
 * }
 */
```

每个方法的契约：

| 方法 | 作用 | 失败处理 |
| --- | --- | --- |
| `start(opts)` | 启动会话；返回 `state` 对象（provider 内部用） | 抛 Error 让上层提示用户 |
| `sendInput(state, text, opts)` | 异步发消息，事件通过 `ctx.sendToServer` 流出去 | 抛 Error 中断当前 turn |
| `abort(state)` | 同步取消当前 turn（不抛错） | — |
| `clear(state)` | 可选；in-place 重置（不重启进程） | 不实现时前端只 wipe UI 消息 |
| `listFolders()` | 返回此 provider 有 session 的工作目录列表 | 返回 `[]` |
| `listSessions(workDir)` | 返回可 resume 的 session 列表 | 返回 `[]` |
| `loadHistory(workDir, sessionId)` | 把历史 transcript 翻译成 `claude_output` envelope 数组 | 抛错 |

## 能力 flag（capabilities）

```js
/**
 * @typedef {Object} ProviderCapabilities
 * @property {boolean} [compact]      支持 /compact
 * @property {boolean} [clear]        支持 in-place /clear
 * @property {boolean} [expert]       支持 Expert Panel
 * @property {boolean} [mcp]          每会话 MCP server 开关
 * @property {boolean} [subagents]    Subagent watcher 事件
 * @property {boolean} [attachments]  接受文件 / 图片附件
 * @property {boolean} [askUser]      ask-user 权限弹窗
 * @property {boolean} [modelPicker]  UI 切模型
 */
```

前端读这个 flag 决定显示什么按钮。新 provider 加进来：只要把 flag 设对，UI 自动适配，不用改 Vue 组件。

| 能力 | Claude Code | Copilot |
| --- | :---: | :---: |
| compact | ✓ | — |
| clear | ✓ | ✓ |
| expert | ✓ | — |
| mcp | ✓ | ✓ |
| subagents | ✓ | — |
| attachments | ✓ | ✓ |
| askUser | ✓ | ✓ |
| modelPicker | ✓ | ✓ |

## 协议：claude_output envelope

**所有** provider 必须通过 `ctx.sendToServer({ type: 'claude_output', conversationId, data })` 推消息，其中 `data` 是 Claude stream-json envelope 形状的对象：

```js
{ type: 'assistant', message: { role, content: [...] } }   // 助手消息
{ type: 'user',      message: { role, content: [...] } }   // 用户消息回显
{ type: 'result',    subtype, session_id, is_error, ... }  // turn 结束
{ type: 'system',    subtype, ... }                        // 系统事件
```

content 数组里的 block 类型也是 Claude 标准：`{ type: 'text', text }`、`{ type: 'tool_use', id, name, input }`、`{ type: 'tool_result', tool_use_id, content }` 等。

**Claude Code provider** 是 native — Claude CLI 本身就吐 stream-json，直接转发。

**Copilot provider** 走 ACP（Agent Client Protocol），它有自己的事件类型（`session/update`、`session/agent_text`、`session/tool_call`、`session/request_permission` 等）。Copilot driver 在 `agent/providers/copilot.js` 把每条 ACP 事件**翻译**成 claude_output envelope：

```
ACP session/agent_text  → { type: 'assistant', message: { content: [{ type: 'text', text }] } }
ACP session/tool_call   → { type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } }
ACP session/tool_result → { type: 'user',      message: { content: [{ type: 'tool_result', tool_use_id, content }] } }
ACP session/request_permission → askUser 协议（独立 wire type）
```

这是为什么 `claude_output` 是 **protocol name**，不是 **vendor name**。

## 注册新 provider

新 provider 加进来三步：

### Step 1 — 写 driver 文件

`agent/providers/<your-driver>.js`，导出 ChatProvider 接口：

```js
export const name = 'your-driver';
export const capabilities = { compact: false, clear: true, /* ... */ };
export async function start(opts) { /* ... */ }
export async function sendInput(state, prompt, opts) { /* ... */ }
export function abort(state) { /* ... */ }
// 可选 clear / listFolders / listSessions / loadHistory
```

### Step 2 — 在 registry 里注册

`agent/providers/index.js`：

```js
import * as yourDriver from './your-driver.js';

const REGISTRY = Object.freeze({
  'claude-code': claudeCode,
  'copilot': copilot,
  'your-driver': yourDriver,   // 新增
});
```

同时更新 `base.js` 的 `PROVIDER_NAMES`。

### Step 3 — 翻译事件流

driver 内部用任何 SDK / CLI / API，但**输出**必须翻译成 `claude_output` envelope。这一层翻译写在 driver 里，对前端透明。

### Step 4 — UI（可选）

新 provider 如果有特殊的配置项（如 Copilot 的 model picker / Allow all tools），在 `web/components/ChatPage.js` 的会话弹窗里加对应字段。前端会把字段塞进 `opts.providerOptions` 传给 driver。

## 现有两个 driver 概览

### claude-code.js（约 600 行）
- spawn `claude --output-format stream-json --resume <sessionId>` 子进程
- stdin 写用户消息 + 附件
- stdout 是 stream-json，原样转发
- 监听 stderr 翻译成系统消息
- session 文件存在 `~/.claude/projects/<hash>/sessions/<sid>.jsonl`

### copilot.js（约 1000 行）
- spawn `copilot --acp` 子进程
- 用 `acp-client.js` 处理 ACP JSON-RPC（session/new、session/prompt、session/cancel、session/load、session/request_permission）
- 把每个 ACP 事件翻译成 claude_output envelope
- session 元数据在 `~/.copilot/session-store.db`（SQLite）
- 模型选择 / 权限弹窗 → ACP method

## 不在这一层的东西

- **Yeaft Code Agent 引擎** — 不是 ChatProvider。它走原生 Yeaft Session 路径（`yeaft_session_send` → `yeaft_output`），因为它的事件模型（VP 并行 turn、Session fan-out、跨 session 记忆）和单 1:1 chat 不一样。`yeaft_session_chat`、`unify_group_chat`、旧 `groupId` payload 名仍仅作为兼容名接受。
- **WebSocket transport** — base.js 不管 WebSocket，driver 通过 `ctx.sendToServer` 推消息，transport 由 message-router 提供
- **鉴权** — driver 不管 token 验证，agent 启动时 server 已经握过手

## 测试

- 单元测试：`test/agent/providers/*.test.js`
- Copilot driver 测试：`test/agent/providers/copilot.test.js` / `copilot-history.test.js` / `copilot-models.test.js`
- ACP 协议层：`test/agent/providers/acp-client.test.js`

## 参考实现

- `agent/providers/base.js` — 接口定义
- `agent/providers/claude-code.js` — Claude Code driver
- `agent/providers/copilot.js` — Copilot driver
- `agent/providers/acp-client.js` — ACP JSON-RPC 客户端（供 copilot 使用）
- `agent/providers/copilot-models.js` — Copilot 模型列表 + fallback
