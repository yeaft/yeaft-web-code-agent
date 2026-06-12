# Yeaft LLM 层

Yeaft 不绑死任何一个 LLM 厂商 — 通过 `agent/yeaft/llm/` 的适配器层，可以同时配 Anthropic / OpenAI / GitHub Copilot / 任意 OpenAI 兼容 proxy，并按 model 路由到对应 adapter。本章讲**架构**、**配置格式**、**协议解析**、**credential providers**。

## 设计目标

1. **多 provider** — 一份 config 同时支持多个 LLM 后端
2. **per-model 协议覆盖** — 同一个 provider 同时跑两种 wire 协议（典型场景：GitHub Copilot 同时拿 Claude 和 GPT 系）
3. **可热 reload** — 改完 `config.json` 不用重启 Agent
4. **凭证抽象** — 静态 apiKey 或动态 credential provider（如 GitHub OAuth）二选一

## 模块布局

```
agent/yeaft/llm/
  adapter.js              — Base LLMAdapter + error 类型 + createLLMAdapter()
  router.js               — AdapterRouter：按 model 路由到 provider
  anthropic.js            — Anthropic Messages API 适配器
  openai-responses.js     — OpenAI Responses API 适配器（/v1/responses）
  models-dev.js           — models.dev 注册表（UI 自动补全用）
  credentials/
    index.js              — credential provider registry
    github-copilot.js     — GitHub OAuth → Copilot API token
```

> Phase 7（2026-04-27）移除了旧的 ChatCompletionsAdapter。当前只有两个 wire 协议：`anthropic` 和 `openai-responses`。

## 适配器层

### LLMAdapter 基类（`adapter.js`）

```js
export class LLMAdapter {
  async *stream(params) { /* 流式生成事件 */ }
  async call(params)    { /* 单次调用，无 tool */ }
}
```

`stream()` 返回 async generator，事件类型：

```js
{ type: 'text_delta',     text }
{ type: 'thinking_delta', text }
{ type: 'thinking_block_end', thinking, signature }
{ type: 'tool_call',      id, name, input }
{ type: 'usage',          inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens? }
{ type: 'stop',           stopReason: 'end_turn' | 'tool_use' | 'max_tokens' }
{ type: 'error',          error, retryable }
```

### Error 类型

| 类 | HTTP code | 含义 | 重试策略 |
| --- | --- | --- | --- |
| `LLMRateLimitError` | 429 / 529 | 限流 | 指数退避 |
| `LLMAuthError` | 401 / 403 | 鉴权失败 | 不重试，提示用户 |
| `LLMContextError` | 413 / API-specific | 上下文超长 | 强制 compact 后重试 |
| `LLMServerError` | 500 / 502 / 503 | 服务端错 | 重试 |
| `LLMAbortError` | — | signal aborted | 不重试 |

### AnthropicAdapter (`anthropic.js`)
- 对 Anthropic Messages API `/v1/messages`
- 支持 thinking blocks（带 signature）
- 支持 prompt caching（`cache_control`）
- 支持 fine-grained tool_use

### OpenAIResponsesAdapter (`openai-responses.js`)
- 对 OpenAI Responses API `/v1/responses`（**不是**老的 chat completions）
- 支持 reasoning models（o1 / o3 / o4 / gpt-5）
- thinking 部分通过 reasoning summary 输出
- 工具调用走 `tools` + `function_call` 格式

## AdapterRouter（`router.js`）

把多 provider 配置路由到对应 adapter：

```js
const router = new AdapterRouter({ providers: config.providers });
const events = router.stream({ model: 'github-copilot/claude-sonnet-4.5', ... });
```

### Model 引用格式
`<provider-name>/<model-id>`，例如：
- `my-proxy/claude-sonnet-4-20250514`
- `github-copilot/gpt-5`
- `github-copilot/claude-sonnet-4.5`

router 解析 `<provider-name>` 找到 provider 配置，用 `<model-id>` 调对应 adapter。

### 协议解析（关键）

每个 (provider, model) 的有效 wire 协议按以下顺序解析：

1. **per-model `protocol`** 覆盖（在 model 对象上）
2. **provider-level `protocol`**（在 provider 上）
3. **按 model id 启发式**：
   - `claude-*` / `*/claude*` / `*.claude*` → `anthropic`
   - `gpt-*` / `o1*` / `o3*` / `o4*` / `chatgpt-*` / `codex-*` / `omni-*` → `openai-responses`
4. **默认** `openai-responses`

这允许同一个 provider（如 GitHub Copilot）同时跑两种协议，无需拆成两个 provider 项：

```json
{
  "name": "github-copilot",
  "baseUrl": "https://api.githubcopilot.com",
  "credentialProvider": "github-copilot",
  "protocol": "openai-responses",
  "models": [
    { "id": "claude-sonnet-4.5", "protocol": "anthropic" },  // 覆盖到 anthropic
    "gpt-5"                                                    // 用 provider 默认
  ]
}
```

### Model entry 两种 shape

`models[]` 可以混合写：
- **字符串**：`"gpt-5"` — 用 provider 默认 protocol
- **对象**：`{ id: "claude-sonnet-4.5", protocol: "anthropic" }` — per-model 覆盖

`normalizeModelEntry()` 把两种 shape 统一成对象形式。

## Credential Providers

provider 的 `apiKey` 和 `credentialProvider` **二选一**：

### 静态 apiKey
```json
{
  "name": "my-proxy",
  "baseUrl": "http://localhost:6628/v1",
  "apiKey": "sk-proxy-key-here",
  "models": [...]
}
```

每次请求带 `Authorization: Bearer <apiKey>`（或 `x-api-key`，按 adapter）。

### 动态 credentialProvider
```json
{
  "name": "github-copilot",
  "baseUrl": "https://api.githubcopilot.com",
  "credentialProvider": "github-copilot",
  "models": [...]
}
```

每次请求由 credential provider 返回当前有效 token。

#### `github-copilot` provider（`credentials/github-copilot.js`）
- 读 GitHub Copilot OAuth token（`~/.config/github-copilot/hosts.json`）
- 换 short-lived Copilot API token（缓存 ~25min）
- 添加必需的 header（`Copilot-Integration-Id`、`Editor-Version` 等）
- 自动续期

> **重要**：这个 credential provider 跟 [Copilot 模式](../user/copilot-mode.md)（spawn `copilot --acp` 子进程）是**完全不同**的两条路径，只是共用同一个 GitHub OAuth token。前者给 Yeaft 引擎直接调 Copilot API 用；后者给 Web Chat 模式当 AI 后端。

#### 写自定义 credential provider
1. 在 `credentials/` 加 `<name>.js`，导出 `getToken({ provider })`
2. 在 `credentials/index.js` 注册
3. 在 config 里 `credentialProvider: "<name>"` 引用

## 配置示例

`~/.yeaft/config.json`：

```json
{
  "providers": [
    {
      "name": "my-proxy",
      "baseUrl": "http://localhost:6628/v1",
      "apiKey": "proxy",
      "protocol": "openai-responses",
      "models": ["claude-sonnet-4-20250514", "gpt-5", "deepseek-chat"]
    },
    {
      "name": "github-copilot",
      "baseUrl": "https://api.githubcopilot.com",
      "credentialProvider": "github-copilot",
      "protocol": "openai-responses",
      "models": [
        { "id": "claude-sonnet-4.5", "protocol": "anthropic" },
        "gpt-5"
      ]
    }
  ],
  "primaryModel": "my-proxy/claude-sonnet-4-20250514",
  "fastModel": "my-proxy/claude-haiku-3-20250414",
  "language": "zh",
  "maxContextTokens": 200000,
  "messageTokenBudget": 32768
}
```

完整字段说明见 [配置文件参考](../reference/config-reference.md)。

## Models 注册表

`models.js` 维护每个 model 的元数据：
- contextWindow（输入 + 输出 token 上限）
- maxOutputTokens（单次输出上限）
- inferProviderFromModel（用 model id 推断 provider name）
- pricing（input/output/cache hit 价格，供 cost 计算）

`models-dev.js` 是 [models.dev](https://models.dev) 抓的更完整列表，供 UI 模型选择器自动补全。

## Token 计数 / Cost 统计

每次 `stream()` 完成时返回 `usage` 事件，引擎累计：
- `inputTokens` / `outputTokens`
- `cacheReadTokens` / `cacheWriteTokens`（仅 Anthropic）
- 按 model 价格算出 `costUSD`

VP 级 / group 级 / user 级累计在 `web/stores/chat.js` 的 store state 里，Debug 面板可视化。

## 热 reload 配置

Agent 在每个 turn 开始时重新读取 `~/.yeaft/config.json`，所以 **model 和 provider 的改动通常不需要重启** — 改完文件，下一次 `engine.query()` 就会用新 config，并为新的 (provider, model) 组合 lazy-build 对应 adapter。

需要**重启** Agent 才生效的改动（这些是启动时一次性读的，不是 per-turn 读的）：`language`、`debug`、全局 `maxContextTokens` / `messageTokenBudget`。

## 调试

### 看 raw request / response
Web 端 Debug 面板的每个 turn 详情可以**导出 raw request**（headers + body），方便 reproducible curl 复现问题。Token 已经被 `redactRawRequest()` redact 掉。

### 测试 endpoint
设置 → Yeaft / LLM → 选 model → **Test connection** — 发 ping 请求确认 endpoint + 鉴权 OK。

## 常见问题

**"No LLM adapter configured"**
- `~/.yeaft/config.json` 不存在或 `providers: []`
- 加一个 provider 即可

**"The chat-completions adapter was removed in Phase 7"**
- 旧 config 用了 `protocol: "openai"` 或 `protocol: "chat-completions"`
- 改成 `protocol: "openai-responses"` 或 `protocol: "anthropic"`

**"Cannot find credential provider github-copilot"**
- GitHub Copilot OAuth token 不存在 — 先在本机用 GitHub CLI 登录 `gh auth login`
- 或缺少 `~/.config/github-copilot/hosts.json` — 先用 Copilot CLI 登录

## 关键文件

- `agent/yeaft/llm/adapter.js` — 基类 + factory
- `agent/yeaft/llm/router.js` — 多 provider 路由
- `agent/yeaft/llm/anthropic.js` — Anthropic adapter
- `agent/yeaft/llm/openai-responses.js` — OpenAI Responses adapter
- `agent/yeaft/llm/credentials/github-copilot.js` — GitHub OAuth → Copilot token
