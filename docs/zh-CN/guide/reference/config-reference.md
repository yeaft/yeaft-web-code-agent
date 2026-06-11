# 配置文件参考

本章是**全字段**参考 — Yeaft 引擎 `~/.yeaft/config.json` + Agent / Server 环境变量。日常配怎么填看 [Yeaft 引擎配置](../yeaft-config.md)；本章供查阅。

> 这里记录的 schema 是代码**当前**实际会读的字段（来自 `agent/yeaft/config.js`、`agent/index.js`、`server/config.js`）。代码不消费的字段一律不列；如果你印象中某个字段曾经存在却没出现在这里，几乎可以确定它从来没接进 codepath。

---

## `~/.yeaft/config.json`

### 顶层

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `providers` | `Provider[]` | — (required) | LLM provider 列表 |
| `primaryModel` | `string` | — (required) | 主 model 引用 `<provider>/<model-id>` |
| `fastModel` | `string` | `primaryModel` | 内部任务（dream / adjust）用的轻量 model |
| `fallbackModel` | `string` | `null` | 主 model 出现可重试错误时换用的 model |
| `language` | `'en' \| 'zh'` | `'en'` | System prompt 语言 |
| `debug` | `boolean` | `false` | 把 LLM raw req/resp + 引擎事件 verbose-log 到 stdout |
| `maxContextTokens` | `number` | model 注册表 → `200000` | 单 turn 注入的最大 token，超过触发 compact |
| `maxOutputTokens` | `number` | model 注册表 → `16384` | 单次调用的输出 token 上限 |
| `messageTokenBudget` | `number` | `32768` | compact 时单条 message 的渲染上限 |
| `maxContinueTurns` | `number` | `3` | `max_tokens` 后自动续写的最多次数 |
| `projectDocMaxBytes` | `number` | `32768` | CLAUDE.md / AGENTS.md 注入上限字节数（0 = 关闭） |
| `yeaft` | `YeaftSection` | 见下 | 引擎运行时上限 / feature flag |
| `mcpServers` | `MCPServer[]` | `[]` | MCP server 配置（缺省时回落到 `~/.yeaft/mcp.json`） |

### Provider 对象

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | :---: | --- |
| `name` | `string` | ✓ | provider 唯一名；`<provider>/<model-id>` 里引用它 |
| `baseUrl` | `string` | ✓ | API 根 URL（不带 `/v1/...` 尾） |
| `apiKey` | `string` | △ | 静态 key（和 `credentialProvider` 二选一） |
| `credentialProvider` | `string` | △ | 动态凭证名（当前仅支持 `github-copilot`） |
| `protocol` | `'anthropic' \| 'openai-responses'` | — | provider 级 wire 协议；per-model 覆盖优先 |
| `models` | `(string \| ModelEntry)[]` | ✓ | 该 provider 服务的 model |

> chat-completions 协议已在 Phase 7（v0.1.590）移除。当前合法值只有 `anthropic` 和 `openai-responses`。

### Model entry（字符串简写也可）

model 项可以是裸字符串（`"gpt-5"`），也可以是对象：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | :---: | --- |
| `id` | `string` | ✓ | vendor 端识别的 model id |
| `protocol` | `'anthropic' \| 'openai-responses'` | — | 覆盖 provider 协议 |
| `contextWindow` | `number` | — | 覆盖该 model 的注册表默认 |
| `maxOutput` | `number` | — | 覆盖该 model 的注册表输出默认 |

其他字段会被静默忽略。模型显示名等 UI 元数据来自打包好的 `models.js` / `models-dev.js`，不走用户 config。

### `yeaft` 段（引擎运行时上限）

```json
"yeaft": {
  "maxConcurrentThreads": 6,
  "autoArchiveIdleDays":  30,
  "recentTurnsLimit":     20,
  "multiVp": { "enabled": true },
  "dream":   { "DREAM_INTERVAL_HOURS": 1, "MIN_NEW_PER_GROUP": 20 }
}
```

| 字段 | 类型 | 默认 | 范围 | 说明 |
| --- | --- | --- | --- | --- |
| `maxConcurrentThreads` | `number` | `6` | `1–50` | ThreadEngineRegistry 并发上限；含常驻的 `main` thread |
| `autoArchiveIdleDays` | `number` | `30` | `1–3650` | thread 自动归档的空闲天数 |
| `recentTurnsLimit` | `number` | `20` | `1–500` | 无 compact summary 时的冷启回放窗口 |
| `multiVp.enabled` | `boolean` | `false` | — | 多 VP session mode 的 opt-in flag（决定 UI 入口是否出现） |
| `dream.*` | object | 见 [dream/limits.js](https://github.com/yeaft/claude-web-chat/blob/main/agent/yeaft/dream/limits.js) | — | 任何 `DEFAULT_LIMITS` 里的 UPPER_CASE 常量都可覆盖 |

数值超范围会被**钳制**到合法范围（而不是悄悄回落默认），所以手写一个 `maxConcurrentThreads: 100` 会被读成 `50`，不是默认的 `6`。

### `mcpServers`

```json
"mcpServers": [
  { "name": "playwright", "command": "npx", "args": ["-y", "@playwright/mcp-server"] }
]
```

每项至少需要 `name` 和 `command`，缺一个就被静默过滤。如果整个字段缺失，引擎会回落到 `~/.yeaft/mcp.json`（同一形状，但外面包一层 `{ "servers": [...] }`）。

---

## Agent 环境变量 / `.env`

Agent 启动时读环境变量。多数值也可以写在 Agent 的 `config.json`（`fileConfig`）里；两边都有时，env 胜出。

### 连接

| 变量 | `fileConfig` key | 默认 | 说明 |
| --- | --- | --- | --- |
| `SERVER_URL` | `serverUrl` | — | Server WebSocket URL（如 `wss://chat.example.com`） |
| `AGENT_NAME` | `agentName` | — | Agent 唯一名（server 端用来识别） |
| `AGENT_SECRET` | `agentSecret` | — | 鉴权 secret；必须和 server 端配的一致 |
| `WORK_DIR` | `workDir` | `process.cwd()` | provider session 默认工作目录 |

### Yeaft 引擎

| 变量 | `fileConfig` key | 默认 | 说明 |
| --- | --- | --- | --- |
| `YEAFT_DIR` | `yeaftDir` | `~/.yeaft` | 覆盖默认的 Yeaft 数据根目录 |
| `MAX_CONTEXT_TOKENS` | `maxContextTokens` | `128000` | Agent 端 context 百分比展示的分母 |
| `AUTO_COMPACT_THRESHOLD` | `autoCompactThreshold` | `110000` | Chat-mode wrapper 触发 compact 的 token 阈值 |
| `YEAFT_THINKING_V1` | — | `"0"` | 设为 `"1"` 启用 v1 thinking/reasoning 协议路径 |

### 工具门控

| 变量 | `fileConfig` key | 默认 | 说明 |
| --- | --- | --- | --- |
| `DISALLOWED_TOOLS` | `disallowedTools` | — | 逗号分隔的禁用工具名（设为 `"none"` 可清空列表） |
| `ALLOWED_MCP_SERVERS` | `allowedMcpServers` | `"playwright"` | 逗号分隔的 MCP server 白名单 |

### Eval 脚本（可选）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `YEAFT_API_KEY` | — | `agent/yeaft/eval/run-eval.js` 用的 Anthropic key |
| `YEAFT_OPENAI_API_KEY` | — | 同上，OpenAI key |

> 如果你有 Anthropic / OpenAI 的 key，优先写进 `~/.yeaft/config.json` 对应 provider 的 `apiKey` 字段 — 引擎本身不会去读 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`。

---

## Server 环境变量 / `.env`

| 变量 | 必填 | 默认 | 说明 |
| --- | :---: | --- | --- |
| `PORT` | — | `3456` | HTTP/WS 监听端口 |
| `SKIP_AUTH` | — | `false` | **仅开发**：跳过所有鉴权；生产严禁开启 |
| `JWT_SECRET` | 生产必填 | `'default-secret-change-in-production'` | JWT 签名密钥；非 skipAuth 模式下用默认值会拒启 |
| `JWT_EXPIRES_IN` | — | `'3d'` | JWT 有效期（`jsonwebtoken` 包接受的任意格式） |
| `JWT_RENEW_THRESHOLD_MS` | — | `86400000`（1 天） | sliding-renew 阈值；离过期不足这么久的 token 会自动续 |
| `TEMP_TOKEN_EXPIRES_IN` | — | `'10m'` | 临时 token 寿命（如邮箱验证 handoff） |
| `AGENT_SECRET` | ✓ | `'agent-shared-secret'` | 必须和 Agent 端的 `AGENT_SECRET` 一致 |
| `AUTH_USERS` | — | — | `username:passwordHash:email,...` 启动期 bootstrap 用户列表 |
| `MAX_FILE_SIZE` | — | `52428800`（50 MB） | 单次上传字节上限 |
| `FILE_CLEANUP_INTERVAL` | — | `600000`（10 分钟） | 临时文件清扫间隔 ms |

### 邮件 / 验证

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `EMAIL_CODE_LENGTH` | `6` | 邮箱验证码位数 |
| `EMAIL_CODE_EXPIRES_IN` | `300000`（5 分钟） | 验证码 TTL ms |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | — | 标准 SMTP 设置；`SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` 全配齐了邮件功能才开启 |

### TOTP

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `TOTP_ENABLED` | `true` | 全局启用 TOTP 2FA |
| `TOTP_ISSUER` | `'Claude Web Chat'` | otpauth URI 里的 issuer label |
| `TOTP_WINDOW` | `1` | 允许的时间步漂移 |

### SSO

Azure AD 加四家 OAuth provider 走同一套 enable + credential 模式。每家 SSO 路径在所列变量全部填齐前都保持关闭。

| Provider | enable 开关 | 凭证变量 |
| --- | --- | --- |
| Azure AD | `AAD_ENABLED=true` | `AAD_CLIENT_ID`、`AAD_TENANT_ID`、`AAD_AUTO_CREATE_USER`、`AAD_DEFAULT_ROLE` |
| GitHub | `SSO_GITHUB_ENABLED=true` | `SSO_GITHUB_CLIENT_ID`、`SSO_GITHUB_CLIENT_SECRET`、`SSO_GITHUB_CALLBACK_URL`、`SSO_GITHUB_AUTO_CREATE_USER`、`SSO_GITHUB_DEFAULT_ROLE` |
| Google | `SSO_GOOGLE_ENABLED=true` | `SSO_GOOGLE_CLIENT_ID`、`SSO_GOOGLE_CLIENT_SECRET`、`SSO_GOOGLE_CALLBACK_URL`、`SSO_GOOGLE_AUTO_CREATE_USER`、`SSO_GOOGLE_DEFAULT_ROLE` |
| WeChat | `SSO_WECHAT_ENABLED=true` | `SSO_WECHAT_APP_ID`、`SSO_WECHAT_APP_SECRET`、`SSO_WECHAT_CALLBACK_URL`、`SSO_WECHAT_AUTO_CREATE_USER`、`SSO_WECHAT_DEFAULT_ROLE` |
| Alipay | `SSO_ALIPAY_ENABLED=true` | `SSO_ALIPAY_APP_ID`、`SSO_ALIPAY_PRIVATE_KEY`、`SSO_ALIPAY_PUBLIC_KEY`、`SSO_ALIPAY_CALLBACK_URL`、`SSO_ALIPAY_AUTO_CREATE_USER`、`SSO_ALIPAY_DEFAULT_ROLE` |

---

## 兼容性矩阵

| 字段 / 变量 | 在哪个 release 引入 |
| --- | --- |
| `providers[].credentialProvider` | v0.1.420+ |
| `providers[].models[].protocol`（per-model 覆盖） | v0.1.430+ |
| `yeaft.multiVp.enabled` | v0.1.560+ |
| `yeaft.maxConcurrentThreads` / `autoArchiveIdleDays`（task-318） | v0.1.580+ |
| `yeaft.recentTurnsLimit` | v0.1.590+ |
| 移除 `protocol: "chat-completions"` | v0.1.590（Phase 7） |
| 移除 `protocol: "openai"` 别名 | v0.1.590（Phase 7） |

老版本 config 升级时如果碰到 `Phase 7 removed ...` 错误，照上面映射改即可。
