# Yeaft Engine Configuration

To run Yeaft's own engine you need to tell it **which LLM providers to use** and **which model is primary / fast**. All of that lives in `~/.yeaft/config.json`. This chapter is the **field-by-field** filling guide.

> For the complete schema, every optional field, and Agent-side `.env`, see [Config Reference](./reference/config-reference.md).

## File Location

```
~/.yeaft/config.json
```

The Agent reads it on startup. **If it's missing or has no providers** → the engine starts but any call fails with `"No LLM adapter configured"`.

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
  "maxContextTokens": 200000,
  "messageTokenBudget": 32768
}
```

## Top-Level Fields

| Field | Type | Required | Default | Description |
| --- | --- | :---: | --- | --- |
| `providers` | `Provider[]` | ✓ | — | LLM provider list |
| `primaryModel` | `string` | ✓ | — | Primary model, format `<provider>/<model-id>` |
| `fastModel` | `string` | — | `primaryModel` | Lightweight model for internal tasks (dream / adjust) |
| `language` | `'en' \| 'zh'` | — | `'en'` | System prompt language |
| `debug` | `boolean` | — | `false` | Log raw LLM request/response to console |
| `maxContextTokens` | `number` | — | `200000` | Max tokens per turn into LLM (over → compact) |
| `messageTokenBudget` | `number` | — | `32768` | Per-message render cap (compact target) |

## Provider Object

| Field | Type | Required | Description |
| --- | --- | :---: | --- |
| `name` | `string` | ✓ | unique provider id, used by `primaryModel` reference |
| `baseUrl` | `string` | ✓ | API root URL (no `/v1/messages` path suffix) |
| `apiKey` | `string` | △ | static API key (or use `credentialProvider`) |
| `credentialProvider` | `string` | △ | dynamic credential provider name (or use `apiKey`) |
| `protocol` | `'anthropic' \| 'openai-responses'` | — | provider default wire protocol |
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
| `protocol` | `'anthropic' \| 'openai-responses'` | — | overrides provider protocol |
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

> The `github-copilot` credential provider here is a **completely different path** from [Copilot Mode](./user/copilot-mode.md) (which spawns `copilot --acp` subprocess). The former lets the Yeaft engine **directly** call the Copilot API; the latter uses the Copilot CLI as Web Chat's AI backend. Both reuse the same GitHub OAuth credential.

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

The Agent re-reads `~/.yeaft/config.json` at the start of every turn, so **model and provider changes typically take effect without a restart** — just edit the file and start a new turn.

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
