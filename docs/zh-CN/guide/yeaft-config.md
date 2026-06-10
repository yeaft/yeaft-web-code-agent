# Yeaft 引擎配置

Yeaft 自有引擎要跑起来，得让它知道**用哪些 LLM provider** + **用哪个 model 当 primary / fast**。这一切都写在 `~/.yeaft/config.json`。本章是**字段级**的填法指南。

> 想看完整 schema、所有可选字段、Agent 端 `.env`，去 [配置文件参考](./reference/config-reference.md)。

## 文件位置

```
~/.yeaft/config.json
```

Agent 启动时读它。**不存在或没 provider** → 引擎可启动但任何调用都会 fail with `"No LLM adapter configured"`。

## 最小可用配置

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

够了 — 引擎就能跑。

## 完整示例（推荐起手）

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
  "language": "zh",
  "debug": false,
  "maxContextTokens": 200000,
  "messageTokenBudget": 32768
}
```

## 顶层字段说明

| 字段 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | :---: | --- | --- |
| `providers` | `Provider[]` | ✓ | — | LLM provider 列表 |
| `primaryModel` | `string` | ✓ | — | 主 model，格式 `<provider>/<model-id>` |
| `fastModel` | `string` | — | `primaryModel` | 用于 dream / adjust 等内部任务的轻量 model |
| `language` | `'en' \| 'zh'` | — | `'en'` | System prompt 语言 |
| `debug` | `boolean` | — | `false` | 把每次 LLM raw request/response 打到 console |
| `maxContextTokens` | `number` | — | `200000` | 单 turn 注入 LLM 的最大 token（超出会触发 compact） |
| `messageTokenBudget` | `number` | — | `32768` | 单条 message 渲染上限（compact 时的目标） |

## Provider 对象

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | :---: | --- |
| `name` | `string` | ✓ | provider 唯一标识，用于 `primaryModel` 引用 |
| `baseUrl` | `string` | ✓ | API 根 URL（不带 `/v1/messages` 这种 path 尾巴） |
| `apiKey` | `string` | △ | 静态 API key（和 `credentialProvider` 二选一） |
| `credentialProvider` | `string` | △ | 动态 credential provider 名（和 `apiKey` 二选一） |
| `protocol` | `'anthropic' \| 'openai-responses'` | — | provider 级默认 wire 协议 |
| `models` | `(string \| ModelEntry)[]` | ✓ | 该 provider 支持的 model 列表 |
| `defaultHeaders` | `Record<string, string>` | — | 每次请求附加 header |

### Model entry

两种 shape 可混用：

```json
"models": [
  "gpt-5",                                              // 字符串：用 provider 默认 protocol
  { "id": "claude-sonnet-4.5", "protocol": "anthropic" }  // 对象：per-model 覆盖 protocol
]
```

| Model entry 字段 | 类型 | 必填 | 说明 |
| --- | --- | :---: | --- |
| `id` | `string` | ✓ | model id（vendor 端实际可识别的字符串） |
| `protocol` | `'anthropic' \| 'openai-responses'` | — | 覆盖 provider 级 protocol |
| `displayName` | `string` | — | UI 模型选择器显示用 |
| `contextWindow` | `number` | — | 覆盖 `models.js` 注册表默认 |
| `maxOutputTokens` | `number` | — | 覆盖默认输出上限 |

### Protocol 解析顺序
（详见 [Yeaft LLM 层 § 协议解析](./tech/yeaft-llm.md#协议解析关键)）

1. per-model `protocol`
2. provider-level `protocol`
3. 按 model id 启发式
4. 默认 `openai-responses`

### Credential provider

填了 `credentialProvider` → 每次请求由它动态返回 token。**和 `apiKey` 二选一**。

当前内置：
- `github-copilot` — 读 `~/.config/github-copilot/hosts.json` 的 OAuth token → 换 Copilot API token

```json
{
  "name": "github-copilot",
  "baseUrl": "https://api.githubcopilot.com",
  "credentialProvider": "github-copilot",
  "models": ["claude-sonnet-4.5", "gpt-5"]
}
```

> 这里的 `github-copilot` credential provider 跟 [Copilot 模式](./user/copilot-mode.md)（spawn `copilot --acp` 子进程）是**两条完全不同的路径**。前者让 Yeaft 引擎**自己**调 Copilot API；后者把 Copilot CLI 当作 Web Chat 的 AI 后端。两者都用同一份 GitHub OAuth 凭证。

## 引用 model 的格式

```
<provider-name>/<model-id>
```

例：
- `my-proxy/claude-sonnet-4-20250514`
- `github-copilot/gpt-5`
- `github-copilot/claude-sonnet-4.5`

## 常见 provider 配置 snippet

### Anthropic 官方
```json
{
  "name": "anthropic",
  "baseUrl": "https://api.anthropic.com",
  "apiKey": "sk-ant-xxx",
  "protocol": "anthropic",
  "models": ["claude-sonnet-4-20250514", "claude-haiku-3-20250414"]
}
```

### OpenAI 官方
```json
{
  "name": "openai",
  "baseUrl": "https://api.openai.com",
  "apiKey": "sk-xxx",
  "protocol": "openai-responses",
  "models": ["gpt-5", "gpt-5-mini", "o3"]
}
```

### Azure OpenAI（要 baseUrl 带 deployment path）
```json
{
  "name": "azure-openai",
  "baseUrl": "https://<resource>.openai.azure.com/openai/deployments/<deployment>",
  "apiKey": "<azure-key>",
  "protocol": "openai-responses",
  "defaultHeaders": { "api-version": "2024-12-01-preview" },
  "models": ["gpt-5"]
}
```

### 自建 OpenAI 兼容 proxy
```json
{
  "name": "my-proxy",
  "baseUrl": "http://localhost:6628/v1",
  "apiKey": "any-string-proxy-accepts",
  "protocol": "openai-responses",
  "models": [
    "claude-sonnet-4-20250514",
    "gpt-5",
    "deepseek-chat",
    "qwen-max"
  ]
}
```

### GitHub Copilot（动态凭证 + 双协议）
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

## 热 reload

改完 `config.json` 不用重启 Agent：
- **设置 → Yeaft / LLM → Reload config**
- 或 `POST /api/yeaft/reload-config`

reload 会：重新 parse config → 重建 AdapterRouter → 新 turn 用新配置（in-flight turn 用旧配置直到完成）。

## 验证配置

Yeaft Web 端：**设置 → Yeaft / LLM → 选 model → Test connection** — 发 ping 请求确认 endpoint + 鉴权 OK。

CLI：
```bash
node -e "
import('./agent/yeaft/config.js').then(async ({ loadConfig }) => {
  const cfg = await loadConfig();
  console.log(JSON.stringify(cfg, null, 2));
});
"
```

## 常见错误

| 错误 | 原因 | 解决 |
| --- | --- | --- |
| `No LLM adapter configured` | `providers: []` 或文件不存在 | 加一个 provider |
| `Cannot find model 'xxx/yyy'` | `primaryModel` 引用的 `<provider>/<model-id>` 在 `providers` 里找不到 | 加 model 到对应 provider 的 `models` 数组 |
| `The chat-completions adapter was removed in Phase 7` | 旧 config 用了 `"protocol": "openai"` 或 `"chat-completions"` | 改成 `"openai-responses"` 或 `"anthropic"` |
| `Cannot find credential provider github-copilot` | 没装 GitHub Copilot OAuth | 先 `gh auth login` + `copilot setup` |
| `LLMAuthError 401` | apiKey 错或过期 | 改 apiKey；动态 provider 重新登录 |

## 相关章节

- [Yeaft LLM 层](./tech/yeaft-llm.md) — adapter 实现细节、protocol 解析、错误处理
- [Yeaft 引擎](./tech/yeaft-engine.md) — config 怎么被引擎用
- [配置文件参考](./reference/config-reference.md) — 全字段表 + Agent .env
