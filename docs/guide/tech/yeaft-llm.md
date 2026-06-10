# Yeaft LLM Layer

Yeaft is **not bound** to any single LLM vendor — through the adapter layer in `agent/yeaft/llm/`, you can configure Anthropic / OpenAI / GitHub Copilot / any OpenAI-compatible proxy simultaneously, and route per-model to the right adapter. This chapter covers the **architecture**, **config format**, **protocol resolution**, and **credential providers**.

## Design Goals

1. **Multi-provider** — one config supports many LLM backends at once
2. **Per-model protocol override** — same provider runs two wire protocols (typical: GitHub Copilot serving Claude + GPT)
3. **Hot-reloadable** — edit `config.json`, no Agent restart needed
4. **Credential abstraction** — static apiKey OR dynamic credential provider (e.g. GitHub OAuth)

## Module Layout

```
agent/yeaft/llm/
  adapter.js              — Base LLMAdapter + error types + createLLMAdapter()
  router.js               — AdapterRouter: route by model to provider
  anthropic.js            — Anthropic Messages API adapter
  openai-responses.js     — OpenAI Responses API adapter (/v1/responses)
  models-dev.js           — models.dev registry (UI autocomplete)
  credentials/
    index.js              — credential provider registry
    github-copilot.js     — GitHub OAuth → Copilot API token
```

> Phase 7 (2026-04-27) removed the old ChatCompletionsAdapter. Only two wire protocols remain: `anthropic` and `openai-responses`.

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
| `LLMContextError` | 413 / API-specific | Context too long | Force compact then retry |
| `LLMServerError` | 500 / 502 / 503 | Server error | Retry |
| `LLMAbortError` | — | Signal aborted | No retry |

### AnthropicAdapter (`anthropic.js`)
- Targets Anthropic Messages API `/v1/messages`
- Supports thinking blocks (with signature)
- Supports prompt caching (`cache_control`)
- Supports fine-grained tool_use

### OpenAIResponsesAdapter (`openai-responses.js`)
- Targets OpenAI Responses API `/v1/responses` (**not** legacy chat completions)
- Supports reasoning models (o1 / o3 / o4 / gpt-5)
- Thinking surfaces via reasoning summary
- Tool calls use `tools` + `function_call` format

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

> **Important**: this credential provider is a **completely different path** from [Copilot Mode](../user/copilot-mode.md) (which spawns `copilot --acp` subprocess), although both use the same GitHub OAuth token. The former lets the Yeaft engine call Copilot API directly; the latter uses Copilot CLI as Web Chat's AI backend.

#### Writing a custom credential provider
1. Add `<name>.js` under `credentials/`, exporting `getToken({ provider })`
2. Register in `credentials/index.js`
3. Reference as `credentialProvider: "<name>"` in config

## Config Example

`~/.yeaft/config.json`:

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
  "maxContextTokens": 200000,
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

Edit `~/.yeaft/config.json` without restarting the Agent:
- Settings → Yeaft / LLM tab → **Reload config**
- Or call Agent API: `POST /api/yeaft/reload-config`

Reload will: re-parse config → rebuild AdapterRouter → new turns use the new config (in-flight turns finish on the old one).

## Debugging

### View raw request / response
The Debug panel in the Web UI lets you **export raw request** (headers + body) per turn for reproducible curl debugging. Tokens are stripped via `redactRawRequest()`.

### Test an endpoint
Settings → Yeaft / LLM → pick model → **Test connection** — sends a ping request to verify endpoint + auth.

## Common Issues

**"No LLM adapter configured"**
- `~/.yeaft/config.json` is missing or `providers: []`
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
