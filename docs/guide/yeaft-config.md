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

`gemini` 是独立的第三套 wire pattern，使用 Google GenerateContent / StreamGenerateContent；不是 OpenAI 兼容接口，也不是 Vertex AI 服务账号模式。

```json
{
  "providers": [{
    "name": "google",
    "protocol": "gemini",
    "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
    "apiKey": "YOUR_GOOGLE_AI_STUDIO_KEY",
    "models": ["gemini-2.5-pro", "gemini-2.5-flash"]
  }],
  "primaryModel": "google/gemini-2.5-pro",
  "fastModel": "google/gemini-2.5-flash"
}
```

- 显式 model protocol → provider protocol → model ID 推断 → `openai-responses` 默认。`gemini-*` 可自动识别；兼容网关需要使用其实际协议显式覆盖。省略原生 Gemini 的 `baseUrl` 时使用上例默认地址，不能填 `/v1beta/openai`。
- 静态凭据为 `apiKey`，请求通过 `x-goog-api-key` header 认证。CLI 的 `--api-key-env` 读取环境变量并把值写入本机实例配置，不会保存环境变量引用。命名实例请显式传 `--config ~/.yeaft/instances/<name>/config.json`。
- CLI：`yeaft-agent llm use gemini --api-key-env GEMINI_API_KEY --model gemini-2.5-pro --fast gemini-2.5-flash`；交互式 `yeaft-agent llm setup` 也提供 Google Gemini 选项。`yeaft-agent llm list-models google` 从已配置 provider 读取原生目录。
- Web：添加 provider，协议选“Google Gemini（原生 API）”，填写 key；“测试连接并刷新模型”通过 Agent 请求 `GET /v1beta/models`，逐页传递 `nextPageToken`，只保留支持 `generateContent` 的模型并保存输入/输出 token 上限到当前草稿；仍需点击“保存”。测试不调用生成接口，不能证明生成配额或工具调用权限。
- 静态起始目录只预置已有 `gemini-2.5-pro` / `gemini-2.5-flash`，不猜测未来模型名称；是否可用以账户实时目录为准。两者支持图片输入，已知离线输入窗口为 1,048,576、输出上限为 65,536 tokens；显式模型配置优先于目录和离线回退。
- Gemini 2.5 使用 `generationConfig.thinkingConfig.thinkingBudget`，不是 `thinkingLevel`。Yeaft 三档 `medium / xhigh / max` 分别为 8,192 / 16,384 / 模型预算上限（Pro 32,768，Flash 24,576）。这是本产品预算映射，不是 Google 同名枚举。`supportsEffort:false` 可禁用；`effortOptions` 可缩小选项。Gemini 3 系列使用独立的 `thinkingLevel`，不能同时发送两种控制。
- **GitHub Copilot 中的 Gemini 不走 Google 路径**：managed Copilot 模型目录会显式写入 `protocol: "openai-responses"`，继续使用 Copilot 动态凭据和地址。若迁移旧手工网关配置，须显式选择网关实际支持的协议。

官方参考：[思考控制](https://ai.google.dev/gemini-api/docs/thinking)、[模型目录与 token 上限](https://ai.google.dev/api/models)。官方思考页可能跳转至新 Interactions API 文档；本实现仍为 GenerateContent，不自动迁移协议或模型目录。
