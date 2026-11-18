# Yeaft Engine Configuration

To run **Yeaft Code Agent** you need to tell the native engine **which LLM providers to use** and **which model is primary / fast**. That configuration belongs to one Agent instance. The default instance uses `~/.yeaft/config.json`; named `<name>` uses `~/.yeaft/instances/<name>/config.json` unless its Yeaft directory is overridden. Anthropic, OpenAI Responses, GitHub Copilot dynamic credentials, Azure/OpenAI-compatible gateways, and local proxies can coexist in one instance config.

> For the complete schema, every optional field, and Agent-side `.env`, see [Config Reference](./reference/config-reference.md).

## File location

| Agent instance | Default config path |
| --- | --- |
| Default service instance | `~/.yeaft/config.json` |
| Named instance `<name>` | `~/.yeaft/instances/<name>/config.json` |
| Explicit Yeaft directory | `<yeaftDir>/config.json` |

`yeaft-agent local` defaults `<name>` to the sanitized computer hostname; use `--name` when you want a predictable path. The `yeaft-agent llm` subcommand does not infer that instance: pass `--config <path>` for a named/custom instance. If the instance config is missing or has no providers, the engine starts but calls fail with `"No LLM adapter configured"`.

## Minimum Working Config

```json
{
  "providers": [
    {
      "name": "my-proxy",
      "baseUrl": "http://localhost:6628/v1",
      "apiKey": "sk-proxy-xxx",
      "models": ["claude-sonnet-4-20250514"]
    }
  ],
  "primaryModel": "my-proxy/claude-sonnet-4-20250514"
}
```

That's enough — the engine will run.

## Full Example (recommended starting point)

```json
{
  "providers": [
    {
      "name": "my-proxy",
      "baseUrl": "http://localhost:6628/v1",
      "apiKey": "sk-proxy-xxx",
      "protocol": "openai-responses",
      "models": [
        "claude-sonnet-4-20250514",
        "claude-haiku-3-20250414",
        "gpt-5",
        "deepseek-chat"
      ]
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
  "debug": false,
  "maxContextTokens": 1000000,
  "messageTokenBudget": 32768
}
```

## Top-Level Fields

| Field | Type | Required | Default | Description |
| --- | --- | :---: | --- | --- |
| `providers` | `Provider[]` | ✓ | — | LLM provider list |
| `primaryModel` | `string` | ✓ | — | Primary model, format `<provider>/<model-id>` |
| `fastModel` | `string` | — | `primaryModel` | Lightweight model for active internal tasks such as classification |
| `language` | `'en' \| 'zh'` | — | `'en'` | System prompt language |
| `debug` | `boolean` | — | `false` | Log raw LLM request/response to console |
| `maxContextTokens` | `number` | — | `1000000` | Provider context-window reference used for request guards |
| `messageTokenBudget` | `number` | — | `32768` | Deterministic provider-request history-window budget; does not modify transcript |

## Provider Object

| Field | Type | Required | Description |
| --- | --- | :---: | --- |
| `name` | `string` | ✓ | unique provider id, used by `primaryModel` reference |
| `baseUrl` | `string` | ✓ | API root URL (no `/v1/messages` path suffix) |
| `apiKey` | `string` | △ | static API key (or use `credentialProvider`) |
| `credentialProvider` | `string` | △ | dynamic credential provider name (or use `apiKey`) |
| `protocol` | `'anthropic' \| 'openai-responses' \| 'gemini'` | — | provider default wire protocol |
| `models` | `(string \| ModelEntry)[]` | ✓ | supported model list |

### Model Entry

Both shapes can be mixed:

```json
"models": [
  "gpt-5",                                              // string: use provider default protocol
  { "id": "claude-sonnet-4.5", "protocol": "anthropic" }  // object: per-model protocol override
]
```

| Model entry field | Type | Required | Description |
| --- | --- | :---: | --- |
| `id` | `string` | ✓ | model id the vendor recognizes |
| `protocol` | `'anthropic' \| 'openai-responses' \| 'gemini'` | — | overrides provider protocol |
| `contextWindow` | `number` | — | overrides `models.js` default |
| `maxOutput` | `number` | — | overrides default output cap |

> Other keys on a model entry are silently dropped. Display names / pricing live in the bundled registry, not in user config.

### Protocol Resolution Order
(See [Yeaft LLM Layer § Protocol Resolution](./tech/yeaft-llm.md#protocol-resolution-key) for details.)

1. per-model `protocol`
2. provider-level `protocol`
3. heuristic by model id
4. default `openai-responses`

### Credential Provider

When `credentialProvider` is set, each request gets a token dynamically. **Mutually exclusive with `apiKey`.**

Built-in today:
- `github-copilot` — reads `~/.config/github-copilot/hosts.json` OAuth token → exchanges for Copilot API token

```json
{
  "name": "github-copilot",
  "baseUrl": "https://api.githubcopilot.com",
  "credentialProvider": "github-copilot",
  "models": ["claude-sonnet-4.5", "gpt-5"]
}
```

> The `github-copilot` credential provider here is a **completely different path** from [Copilot Mode](./user/copilot-mode.md) (which spawns `copilot --acp` subprocess). The former lets the Yeaft engine **directly** call the Copilot API; the latter uses the Copilot CLI as a 1:1 chat backend in Yeaft Web Code Agent. Both reuse the same GitHub OAuth credential.

## Model Reference Format

```
<provider-name>/<model-id>
```

Examples:
- `my-proxy/claude-sonnet-4-20250514`
- `github-copilot/gpt-5`
- `github-copilot/claude-sonnet-4.5`

## Common Provider Snippets

### Anthropic Official
```json
{
  "name": "anthropic",
  "baseUrl": "https://api.anthropic.com",
  "apiKey": "sk-ant-xxx",
  "protocol": "anthropic",
  "models": ["claude-sonnet-4-20250514", "claude-haiku-3-20250414"]
}
```

### OpenAI Official
```json
{
  "name": "openai",
  "baseUrl": "https://api.openai.com",
  "apiKey": "sk-xxx",
  "protocol": "openai-responses",
  "models": ["gpt-5", "gpt-5-mini", "o3"]
}
```

### Azure OpenAI (baseUrl includes deployment path + api-version)
```json
{
  "name": "azure-openai",
  "baseUrl": "https://<resource>.openai.azure.com/openai/deployments/<deployment>?api-version=2024-12-01-preview",
  "apiKey": "<azure-key>",
  "protocol": "openai-responses",
  "models": ["gpt-5"]
}
```

> The engine has no per-provider header-injection knob — pass Azure's `api-version` as a query string on `baseUrl` instead.

### Self-Hosted OpenAI-Compatible Proxy
```json
{
  "name": "my-proxy",
  "baseUrl": "http://localhost:6628/v1",
  "apiKey": "any-string-the-proxy-accepts",
  "protocol": "openai-responses",
  "models": [
    "claude-sonnet-4-20250514",
    "gpt-5",
    "deepseek-chat",
    "qwen-max"
  ]
}
```

### GitHub Copilot (dynamic creds + dual protocol)
```json
{
  "name": "github-copilot",
  "baseUrl": "https://api.githubcopilot.com",
  "credentialProvider": "github-copilot",
  "protocol": "openai-responses",
  "models": [
    { "id": "claude-sonnet-4.5", "protocol": "anthropic" },
    "gpt-5",
    "gpt-5-mini",
    "o3-mini"
  ]
}
```

## Hot Reload

The Agent re-reads its resolved instance `config.json` at the start of every turn, so **model and provider changes typically take effect without a restart** — edit the correct instance file and start a new turn.

Changes that **do** require restarting the Agent:
- `language` / `debug`
- Global `maxContextTokens` / `messageTokenBudget`
- Anything else read at startup rather than per-turn

## Verify Configuration

Yeaft Web UI: **Settings → Yeaft / LLM → pick model → Test connection** — sends a ping request to confirm endpoint + auth.

CLI:
```bash
node -e "
import('./agent/yeaft/config.js').then(async ({ loadConfig }) => {
  const cfg = await loadConfig();
  console.log(JSON.stringify(cfg, null, 2));
});
"
```

## Common Errors

| Error | Cause | Fix |
| --- | --- | --- |
| `No LLM adapter configured` | `providers: []` or file missing | Add a provider |
| `Cannot find model 'xxx/yyy'` | `primaryModel` reference `<provider>/<model-id>` not in `providers` | Add the model to the matching provider's `models` array |
| `The chat-completions adapter was removed in Phase 7` | Old config used `"protocol": "openai"` or `"chat-completions"` | Change to `"openai-responses"` or `"anthropic"` |
| `Cannot find credential provider github-copilot` | GitHub Copilot OAuth not installed | Run `gh auth login` + `copilot setup` first |
| `LLMAuthError 401` | apiKey wrong or expired | Update apiKey; for dynamic providers, re-login |

## Related Chapters

- [Yeaft LLM Layer](./tech/yeaft-llm.md) — adapter details, protocol resolution, error handling
- [Yeaft Engine](./tech/yeaft-engine.md) — how the config is used by the engine
- [Config Reference](./reference/config-reference.md) — every field + Agent .env


## Google Gemini 原生 API

`gemini` 对接 Google Gemini Developer API 的 `GenerateContent` / `StreamGenerateContent`，默认使用稳定版 `/v1`。显式填写的 `/v1beta` 或网关地址不会自动改写；Gemini 版 API 并不是 Vertex AI、OpenAI 转接、Interactions 或 Live API。

```json
{
  "providers": [{
    "name": "google",
    "protocol": "gemini",
    "baseUrl": "https://generativelanguage.googleapis.com/v1",
    "apiKey": "YOUR_GOOGLE_AI_STUDIO_KEY",
    "models": [
      {
        "id": "gemini-4-hydrogen",
        "geminiOptions": {
          "serviceTier": "standard",
          "generationConfig": { "temperature": 1, "thinkingConfig": { "includeThoughts": true } }
        }
      },
      "gemini-4-carbon"
    ]
  }],
  "primaryModel": "google/gemini-4-hydrogen",
  "fastModel": "google/gemini-4-carbon"
}
```

- 使用 Google AI Studio 密钥，Agent 通过 `x-goog-api-key` header 认证。CLI 示例：`yeaft-agent llm use gemini --api-key-env GEMINI_API_KEY --model gemini-4-hydrogen --fast gemini-4-carbon`。CLI 读取环境变量并将密钥保存在所选实例的本机配置中。Web 的“测试连接并刷新模型”仅在同一 API 版本分页查询 `/models`；不发起生成。模型可用性、配额和请求参数支持仍以账户及模型为准。
- **思考档位**：Gemini 4 Hydrogen 提供 `low / medium / high / xhigh`，默认 `xhigh`；4 Carbon、4 Argon 和 3.8 Flash 提供 `low / medium / high`。其他已确认的 Gemini 3 模型按各自能力展示（例如 3.6 Flash 支持 `minimal`）。请求用 `generationConfig.thinkingConfig.thinkingLevel`。Gemini 2.5 仍用 `thinkingBudget`：`medium / xhigh / max` 对应 8,192 / 16,384 / 模型预算上限（Pro 32,768，Flash 24,576）。两个字段不一起发。菜单从 `Medium` 起，有 `X-High` 时隐藏 `High`，没有该档的模型仍可显示 `High`。Gemini 3/4 的原生枚举没有独立 `Max`，不会把 `X-High` 重复列为 `Max`。可用 `supportsEffort: false` 禁用或 `effortOptions` 缩小范围；已有 Session 选择保留。
- **缓存**：Google 在支持的模型上自动使用隐式缓存，无需传请求参数。命中时 `usageMetadata.cachedContentTokenCount` 是输入 token 的一部分，不能重复计入。显式 `cachedContents` 资源和 `cachedContent` 请求字段只在支持的 **`v1beta` GenerateContent** 路径（且不是 Gemini 4）提供；Yeaft 不创建或管理显式缓存资源，也不为此自动切换 endpoint。
- **高级参数**：可在实例 `config.json` 的模型对象中设置 `geminiOptions`，支持 `safetySettings`、`serviceTier`、`toolConfig` 和 `generationConfig` 的文本参数（采样、stop sequences、结构化输出、logprobs、media resolution 和 thinking config）。具体组合受 Google 模型限制。Session 选择的 effort、Agent 的工具声明、输出上限及单候选约束仍由 Yeaft 决定。Web/CLI 编辑与刷新保留这些模型设置；当前没有独立表单。独立的 Files、Batch、Embeddings、Interactions、Live API 及非文本生成，不在这个会话适配器内。
- **Copilot Gemini 不变**：它使用自己的 `openai-responses` 协议和动态凭据，并不使用 Google 的地址、缓存或思考字段。

官方参考：[API 版本](https://aistudio.google.com/api-reference/api-versions)、[GenerateContent v1](https://aistudio.google.com/api-reference/generate-content/generate-content?api-version=v1)、[思考档位](https://aistudio.google.com/docs/thinking?generate-content=true#thinking-levels)、[上下文缓存](https://aistudio.google.com/docs/caching?generate-content=true)。
