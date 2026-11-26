# Yeaft LLM Layer

Yeaft is **not bound** to any single LLM vendor — through the adapter layer in `agent/yeaft/llm/`, you can configure Anthropic / OpenAI / GitHub Copilot / any OpenAI-compatible proxy simultaneously, and route per-model to the right adapter. This chapter covers the **architecture**, **config format**, **protocol resolution**, and **credential providers**.

## Design Goals

1. **Multi-provider** — one config supports many LLM backends at once
2. **Per-model protocol override** — same provider runs two wire protocols (typical: GitHub Copilot serving Claude + GPT)
3. **Hot-reloadable** — edit `config.json`, no Agent restart needed
4. **Credential abstraction** — static apiKey OR dynamic credential provider (e.g. GitHub OAuth)

## Web configuration drafts

LLM configuration is read on demand: when the editor opens, or when the composer first connects or genuinely reconnects. Routine Agent status snapshots do not trigger reads, and there is no periodic LLM configuration polling. Configuration changes saved through the UI are synchronized to clients on the same account.

The LLM form in Agent settings submits only when you click **Save**. Background configuration responses, reconnect reads, and other clients' updates do not overwrite unsaved input. Changes made while a save is pending remain unsaved and require another explicit save. Failed or timed-out saves also retain the draft.

Drafts live only in the open editor, not in persistent browser storage. Closing the form, switching Agents, or reloading the page discards unsaved changes; save explicitly first.

### Sub-agent model routing

In **Agent Settings → LLM**, select a **Fast Model** or choose **Auto** to clear the explicit choice. Explorer and researcher sub-agents prefer the Fast Model when no scene rule applies. Some internal tasks also use it, and the Decision Model follows Fast or Primary when set to **Auto**.

**Sub-agent models by scene** (`subAgentSceneModels`) applies to new native Session delegations. The scene is the one explicitly passed to `SpawnAgent`, or the parent Session's scene if omitted. A mapping must target a unique configured `provider/model`. An available mapped model takes priority over the `model` argument. **Auto** or an unavailable target restores ordinary model override, fast-persona, or parent-model routing. It does not change the parent Session, ongoing children, or the pinned model of a Digital Person.

**Sub-agent effort by role** (`subAgentPersonaEfforts`) is resolved after model routing and applies to newly delegated native sub-agents. A setting takes priority over the `SpawnAgent.effort` argument. In **Auto**, a one-off `effort` argument can override the default if the resolved model supports that exact tier. Otherwise, Designer and Reviewer target `xhigh`; the other roles retain the normal inherited policy. The engine selects the highest supported level not above the target (for example, Carbon on Chat Completions uses `high` for an `xhigh` target). A model with no effort control omits the parameter. If an explicitly configured target is below every supported tier, delegation errors rather than silently raising the effort. Parent Sessions, already-started children, and Digital Person effort guards are unchanged.

## Module Layout

```
agent/yeaft/llm/
  adapter.js              — Base LLMAdapter + error types + createLLMAdapter()
  router.js               — AdapterRouter: route by model to provider
  anthropic.js            — Anthropic Messages API adapter
  openai-responses.js     — OpenAI Responses API adapter (/v1/responses)
  openai-chat-completions.js — OpenAI Chat Completions API adapter (/v1/chat/completions)
  responses-tool-schema.js — Responses strict schema and argument conversion
  gemini.js               — Gemini GenerateContent API adapter
  models-dev.js           — models.dev registry (UI autocomplete)
  credentials/
    index.js              — credential provider registry
    github-copilot.js     — GitHub OAuth → Copilot API token
```

> Supported wire protocols: `anthropic`, `openai-responses`, `openai-chat-completions`, and `gemini`.

## Adapter Layer

### LLMAdapter Base Class (`adapter.js`)

```js
export class LLMAdapter {
  async *stream(params) { /* stream events */ }
  async call(params)    { /* one-shot, no tools */ }
}
```

`stream()` returns an async generator, event types:

```js
{ type: 'text_delta',     text }
{ type: 'thinking_delta', text }
{ type: 'thinking_block_end', thinking, signature }
{ type: 'tool_call',      id, name, input }
{ type: 'usage',          inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens? }
{ type: 'stop',           stopReason: 'end_turn' | 'tool_use' | 'max_tokens' }
{ type: 'error',          error, retryable }
```

### Error Types

| Class | HTTP code | Meaning | Retry policy |
| --- | --- | --- | --- |
| `LLMRateLimitError` | 429 / 529 | Rate-limited | Exponential backoff |
| `LLMAuthError` | 401 / 403 | Auth failure | No retry, surface to user |
| `LLMContextError` | 413 / API-specific | Context too long | Surface terminal error; no hidden summary call |
| `LLMServerError` | 500 / 502 / 503 | Server error | Retry |
| `LLMAbortError` | — | Signal aborted | No retry |

### AnthropicAdapter (`anthropic.js`)
- Targets Anthropic Messages API `/v1/messages`
- Supports thinking blocks (with signature)
- Supports prompt caching (`cache_control`)
- Supports fine-grained tool_use
- Effort follows the effective API, not a model-ID allowlist: `anthropic` exposes `medium / xhigh / max` and defaults to adaptive thinking with `output_config.effort`; `openai-responses` exposes `medium / xhigh / max / ultra` and sends `reasoning.effort`. New models and gateway aliases do not require a Yeaft update to show effort. Protocol resolution remains model override → provider override → ID inference → Responses default.
- These are the tiers Yeaft exposes for each API, not a guarantee that every upstream model or gateway accepts all of them. Unsupported combinations fail explicitly upstream rather than silently switching tiers. A model entry can narrow them with `effortOptions: ["medium", "xhigh"]` or disable effort with `supportsEffort: false`. For legacy Anthropic models requiring manual thinking, explicitly set `thinkingProtocol: "anthropic"` and optionally `maxBudgetTokens`; manual budgets are no longer guessed from model names. Explicit Session choices do not require the automatic-thinking feature flag.
- Legacy `minimal` / `low` selections normalize to `medium`, and `high` to `xhigh`, at read and request boundaries without rewriting history. Lightweight automatic scenarios use `medium`; Work Center retains its `medium / xhigh` policy subset. Child effort is capped at `medium`, the highest retained tier below the previous ceiling, rather than being raised to `xhigh`; an unrepresentable safe tier fails explicitly before dispatch.

### OpenAIResponsesAdapter (`openai-responses.js`)
- Targets OpenAI Responses API `/v1/responses`
- Supports reasoning models (o1 / o3 / o4 / gpt-5)
- Thinking surfaces via reasoning summary
- Tool calls use `tools` + `function_call` format

### OpenAIChatCompletionsAdapter (`openai-chat-completions.js`)
- Targets OpenAI Chat Completions API `/v1/chat/completions` (`protocol: "openai-chat-completions"`)
- Supports `max_completion_tokens`, top-level `reasoning_effort`, `stream_options.include_usage`, `prompt_cache_key` (with automatic single retry fallback if rejected), function tools, and multimodal user/tool images
- In Chat Completions, **High** sends `reasoning_effort: "high"`, distinct from **X-High**. For `gemini-4-carbon`, the picker offers Medium and High; saved X-High/Max/Ultra selections use the highest allowed tier up to High without rewriting the Session. Other routes keep their own effort tiers.
- Captures and replays native assistant reasoning state (`reasoning_opaque`, `reasoning_text`, `reasoning_content`, `reasoning`) in fenced `providerState` so Copilot Proxy Gemini and OpenAI-compatible reasoning gateways preserve multi-turn tool-loop signatures and prompt caching

### 工具 schema 按协议转换

Session、数字人、Work Center 和 MCP 共用工具定义，不按模型或厂商复制定义。适配器负责出站格式：

| 协议 | 工具参数在请求中的位置 | Yeaft 的处理 |
| --- | --- | --- |
| OpenAI Responses（包括走这个协议的 Copilot 路由） | `tools[].parameters` | 本地生成 OpenAI strict 子集，显式传 `strict: true`；不依赖网关自动转换。 |
| Anthropic Messages | `tools[].input_schema` | 延续已有的原始 schema，不自动开启 Anthropic 的 strict tool use。 |
| Gemini GenerateContent | `tools[].functionDeclarations[].parametersJsonSchema` | 保持原始 schema，由 Gemini 自己的接口定义支持范围。 |

Responses 的对象在出站时关闭额外字段，并将可省略字段表示为 `null`；工具执行前还原省略语义，必填的 `null` 不丢失。内置 `uniqueItems`、二选一等不能直接交给 strict 编译器的约束保留在公共定义和工具侧，由说明提示模型；例如 `Conversation__reply` 的执行前检查仍会拒绝重复 ID。无法直接表示的任意 JSON（例如子 Agent 的输出 schema 或开放的 MCP 参数）只在 Responses 的 wire 中用 JSON 文本承载，解析后再交给原工具。strict 约束的是这个外层传输结构，不保证内层 JSON 或业务规则有效。已有 provider 原生历史继续按原始 wire 参数回放；缺少原生状态时，对仍在工具列表中的调用按当前工具格式重建参数。

参考：[OpenAI strict mode](https://developers.openai.com/api/docs/guides/function-calling#strict-mode)、[Anthropic strict tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use)、[Gemini FunctionDeclaration](https://ai.google.dev/api/caching#FunctionDeclaration)。遵循公开的 Responses 子集不等于任意兼容网关都承诺支持；第三方工具的业务校验仍由其执行端负责。

## AdapterRouter (`router.js`)

Routes multi-provider config to the right adapter:

```js
const router = new AdapterRouter({ providers: config.providers });
const events = router.stream({ model: 'github-copilot/claude-sonnet-4.5', ... });
```

### Model Reference Format
`<provider-name>/<model-id>`, e.g.:
- `my-proxy/claude-sonnet-4-20250514`
- `github-copilot/gpt-5`
- `github-copilot/claude-sonnet-4.5`

Router parses `<provider-name>` to find the provider config, then uses `<model-id>` with the corresponding adapter.

### Protocol Resolution (key)

The effective wire protocol for each (provider, model) is resolved in this order:

1. **per-model `protocol`** override (on the model object)
2. **provider-level `protocol`** (on the provider)
3. **Heuristic by model id**:
   - `claude-*` / `*/claude*` / `*.claude*` → `anthropic`
   - `gpt-*` / `o1*` / `o3*` / `o4*` / `chatgpt-*` / `codex-*` / `omni-*` → `openai-responses`
4. **Default** `openai-responses`

This lets the same provider (like GitHub Copilot) run two protocols without splitting into two provider entries:

```json
{
  "name": "github-copilot",
  "baseUrl": "https://api.githubcopilot.com",
  "credentialProvider": "github-copilot",
  "protocol": "openai-responses",
  "models": [
    { "id": "claude-sonnet-4.5", "protocol": "anthropic" },  // override to anthropic
    "gpt-5"                                                    // use provider default
  ]
}
```

### Model Entry — two shapes

`models[]` accepts both:
- **String**: `"gpt-5"` — uses provider default protocol
- **Object**: `{ id: "claude-sonnet-4.5", protocol: "anthropic" }` — per-model override

`normalizeModelEntry()` unifies both into the object form.

## Prompt caching defaults

No settings switch is required for the native Yeaft engine, including Sessions, Digital Humans, and Work Center. The effective API protocol determines how caching works:

- **Anthropic Messages:** Send standard short-lived `cache_control` breakpoints for the tools, system instructions, and latest eligible user/tool result, including on compatible gateways with a known credential scope. Claude's short-lived cache writes are billed separately from cache reads.
- **OpenAI Responses:** Supported models already use provider-side caching. When request and credential ownership are known, send an opaque, stable `prompt_cache_key` on official and compatible routes. This is a routing hint and does not change `store: false` or request extended retention.
- **Gemini GenerateContent:** Supported Gemini models use Google's implicit caching with no request flag. Yeaft does not provision explicit `cachedContents` resources or incur their storage charges. Custom gateways control their own upstream caching.

If a gateway explicitly rejects a Yeaft-added cache field in request validation, Yeaft retries the request once without that field. Existing provider- or model-level `capabilities.promptCaching: false` and `capabilities.translation: true` suppress only the cache fields Yeaft adds; they cannot disable a provider's own implicit caching. A reported cache-read count—not the presence of a request hint—confirms a hit. It can be zero when the prefix changes, is too short, has expired, or the backend does not support caching.

## Native Anthropic continuity

Anthropic-compatible gateways preserve original signed thinking and redacted blocks with tool responses. Static keys automatically use an opaque credential fingerprint; Copilot uses the source GitHub credential so access-token refresh does not change ownership. Provider, endpoint, model, credential and instance/owner/Session/VP/thread fences still apply. Custom endpoints do not automatically opt into eager streaming; translation routes can disable native replay explicitly.

New thinking state is bound to the finalized wire prefix. Active Session tool loops keep already-sent messages/results immutable. On supported models, changed runtime instructions and tools are appended as native system messages and inline tool additions/removals, rather than rewriting the top-level system/tools. Unsupported models or a context that cannot fit fail visibly. No active thinking is silently removed and server-side `drop_block` is not enabled automatically.

Original stop reasons, refusal details, stop sequences, input transformations, citations and known fallback/server-tool blocks are retained. Public diagnostics contain identifiers/status/citations, not server-tool arguments/results. `pause_turn` continues with the exact assistant response, at most three times; refusal, context exhaustion and unknown stop reasons do not become successful results or dispatch tools. They are retried within `llmRetry`: context exhaustion through the smaller-request or context recovery, the others with a fresh response; once retries are exhausted, the error names the provider's own reason and the retry count. For the Anthropic Messages API, known Claude models that default to omitted thinking (Claude 5 / 5.5, Fable / Mythos 5–5.2, Mythos Preview, and Opus 4.7 / 4.8 when thinking is enabled) request `thinking.display: "summarized"` on both official and compatible gateway routes. Unknown models and OpenAI Responses are unchanged. Explicit `extraBody.thinking.display` values remain authoritative, including for effort-capped child agents; `disabled` / `between_tools` do not gain a display field. Summaries are not raw internal reasoning and do not guarantee progress within a fixed timeout.

## Credential Providers

A provider's `apiKey` and `credentialProvider` are **mutually exclusive**:

### Static apiKey
```json
{
  "name": "my-proxy",
  "baseUrl": "http://localhost:6628/v1",
  "apiKey": "sk-proxy-key-here",
  "models": [...]
}
```

Each request carries `Authorization: Bearer <apiKey>` (or `x-api-key`, per adapter).

### Dynamic credentialProvider
```json
{
  "name": "github-copilot",
  "baseUrl": "https://api.githubcopilot.com",
  "credentialProvider": "github-copilot",
  "models": [...]
}
```

Each request gets the current valid token from the credential provider.

#### `github-copilot` provider (`credentials/github-copilot.js`)
- Reads the GitHub Copilot OAuth token (`~/.config/github-copilot/hosts.json`)
- Exchanges it for a short-lived Copilot API token (~25 min cache)
- Adds required headers (`Copilot-Integration-Id`, `Editor-Version`, etc.)
- Auto-refreshes

> **Important**: this credential provider is a **completely different path** from [Copilot Mode](../user/copilot-mode.md) (which spawns `copilot --acp` subprocess), although both use the same GitHub OAuth token. The former lets the Yeaft engine call Copilot API directly; the latter uses Copilot CLI as a 1:1 chat backend in Yeaft Web Code Agent.

#### Writing a custom credential provider
1. Add `<name>.js` under `credentials/`, exporting `getToken({ provider })`
2. Register in `credentials/index.js`
3. Reference as `credentialProvider: "<name>"` in config

## Config Example

the selected Agent instance's resolved `config.json` (default instance: `~/.yeaft/config.json`):

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
  "language": "en",
  "maxContextTokens": 1000000,
  "messageTokenBudget": 32768
}
```

See [Config Reference](../reference/config-reference.md) for the complete field list.

## Models Registry

`models.js` maintains per-model metadata:
- contextWindow (input + output token cap)
- maxOutputTokens (single-output cap)
- inferProviderFromModel (infer provider name from model id)
- pricing (input / output / cache-hit price, for cost calculation)

`models-dev.js` is a more complete list scraped from [models.dev](https://models.dev), used for the UI model picker autocomplete.

## Token Counting / Cost Tracking

Every `stream()` finish emits a `usage` event; the engine accumulates:
- `inputTokens` / `outputTokens`
- `cacheReadTokens` / `cacheWriteTokens` (Anthropic only)
- Per-model price → `costUSD`

Per-VP / per-group / per-user totals live in `web/stores/chat.js` store state, visualized in the Debug panel.

## Hot Config Reload

The Agent re-reads its resolved instance `config.json` at the start of every turn, so **model and provider changes typically take effect without a restart**. The next `engine.query()` picks up the correct instance file and lazy-rebuilds adapters for new (provider, model) pairs.

Changes that **do** require restarting the Agent (read at startup, not per-turn): `language`, `debug`, global `maxContextTokens` / `messageTokenBudget`.

## Debugging

### View raw request / response
The Debug panel in the Web UI lets you **export raw request** (headers + body) per turn for reproducible curl debugging. Tokens are stripped via `redactRawRequest()`.

### Test an endpoint
Settings → Yeaft / LLM → pick model → **Test connection** — sends a ping request to verify endpoint + auth.

## Common Issues

**"No LLM adapter configured"**
- the selected Agent instance's resolved `config.json` is missing or has `providers: []`
- Add a provider

**"The chat-completions adapter was removed in Phase 7"**
- Old config used `protocol: "openai"` or `protocol: "chat-completions"`
- Change to `protocol: "openai-responses"` or `protocol: "anthropic"`

**"Cannot find credential provider github-copilot"**
- GitHub Copilot OAuth token is missing — log in with GitHub CLI first: `gh auth login`
- Or `~/.config/github-copilot/hosts.json` is missing — log in via Copilot CLI

## Key Files

- `agent/yeaft/llm/adapter.js` — base class + factory
- `agent/yeaft/llm/router.js` — multi-provider routing
- `agent/yeaft/llm/anthropic.js` — Anthropic adapter
- `agent/yeaft/llm/openai-responses.js` — OpenAI Responses adapter
- `agent/yeaft/llm/credentials/github-copilot.js` — GitHub OAuth → Copilot token


## Gemini 原生协议补充

协议值为 `gemini`，默认地址 `https://generativelanguage.googleapis.com/v1`，静态 `apiKey` 通过 `x-goog-api-key` 认证，不使用 OpenAI 兼容 `/openai` 路径。model 显式协议优先于 provider，之后才按模型 ID 推断。GitHub Copilot 的 Gemini 目录项显式保留 `openai-responses`，不改用 Google 地址或凭据。

配置、CLI / Web 模型目录发现、2.5 token 预算三档和窗口优先级见 [Gemini 配置](../yeaft-config.md#google-gemini-原生-api)。目录测试仅执行分页 GET，不发起生成。Gemini 2.5 用 `thinkingBudget`；Gemini 3/4 按模型用 `thinkingLevel`，二者互斥。显式 beta 地址不迁移；v1 隐式缓存由 Google 管理。图片输入复用原生附件链路。
