# 配置文件参考

本章是 Agent instance Yeaft `config.json` 与 Agent/Server 环境变量的**全字段**参考。Default instance 使用 `~/.yeaft/config.json`；named instance 默认使用 `~/.yeaft/instances/<name>/config.json`。日常配怎么填看 [Yeaft 引擎配置](../yeaft-config.md)；本章供查阅。

> 这里记录的 schema 是代码**当前**实际会读的字段（来自 `agent/yeaft/config.js`、`agent/browser-runtime/config.js`、`agent/index.js` 和 `server/config.js`）。代码不消费的字段一律不列；如果你印象中某个字段曾经存在却没出现在这里，几乎可以确定它从来没接进 codepath。

---

## Instance `config.json`

### 顶层

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `providers` | `Provider[]` | — (required) | LLM provider 列表 |
| `primaryModel` | `string` | — (required) | 主 model 引用 `<provider>/<model-id>` |
| `fastModel` | `string` | `primaryModel` | compact、召回和分类等内部任务使用的轻量 model；Dream 使用 Session 的 primary model |
| `fallbackModel` | `string` | `null` | 主 model 出现可重试错误时换用的 model |
| `language` | `'en' \| 'zh'` | `'en'` | System prompt 语言 |
| `debug` | `boolean` | `false` | 把 LLM raw req/resp + 引擎事件 verbose-log 到 stdout |
| `maxContextTokens` | `number` | model 注册表 → `200000` | 单 turn 注入的最大 token，超过触发 compact |
| `maxOutputTokens` | `number` | model 注册表 → `16384` | 单次调用的输出 token 上限 |
| `messageTokenBudget` | `number` | `32768` | compact 时单条 message 的渲染上限 |
| `maxContinueTurns` | `number` | `3` | `max_tokens` 后自动续写的最多次数 |
| `projectDocMaxBytes` | `number` | `32768` | CLAUDE.md / AGENTS.md 注入上限字节数（0 = 关闭） |
| `yeaft` | `YeaftSection` | 见下 | 引擎运行时上限 / feature flag |
| `browserRuntime` | `BrowserRuntimeSection` | 见下 | Agent instance 的 Browser Runtime 开关、可执行文件与资源上限 |
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
| `credentialScopeId` | `string` | — | 原生 reasoning 回传与缓存的稳定、非敏感账号归属；动态凭据/自定义 endpoint 必填，官方静态 key 路径默认使用 key 指纹。换账号时更换；仅轮换 token 时保持 |
| `capabilities` | `object` | — | `nativeReasoningState`、`promptCaching`、`parallelToolCalls` 布尔开关；`translation: true` 强制关闭这三项。模型级覆盖优先 |

> chat-completions 协议已在 Phase 7（v0.1.590）移除。当前合法值只有 `anthropic` 和 `openai-responses`。

### Model entry（字符串简写也可）

model 项可以是裸字符串（`"gpt-5"`），也可以是对象：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | :---: | --- |
| `id` | `string` | ✓ | vendor 端识别的 model id |
| `protocol` | `'anthropic' \| 'openai-responses'` | — | 覆盖 provider 协议 |
| `contextWindow` | `number` | — | 覆盖该 model 的注册表默认 |
| `maxOutput` | `number` | — | 覆盖该 model 的注册表输出默认 |
| `capabilities` | `object` | — | 逐字段覆盖 provider 的协议能力开关 |

#### Reasoning 连续性与缓存

官方 `https://api.openai.com/v1` 和 `https://api.anthropic.com` 默认启用协议能力；未知代理默认关闭。仅在确认代理和上游完整支持后设置 `capabilities`，不要根据模型名称推断能力。Messages 转 Chat Completions 不等于原生 Anthropic 透传。

```json
{
  "name": "verified-proxy",
  "baseUrl": "https://proxy.example/v1",
  "protocol": "openai-responses",
  "credentialScopeId": "account-a",
  "capabilities": {
    "nativeReasoningState": true,
    "promptCaching": true,
    "parallelToolCalls": true
  },
  "models": ["gpt-5"]
}
```

这是能力配置片段；凭据沿用已有 `apiKey` 或 `credentialProvider`。不会自动探测或修改在线配置。Responses 使用 `store: false`、加密 reasoning 原生 output 回传和隔离到实例/Session/VP/thread 的稳定 cache key。Anthropic 保留 thinking/signature/redacted block 顺序，并在 system、tools、最近 user/tool result 设置最多三个 ephemeral 缓存断点；不对 thinking block 设置缓存。

私有状态随实例 transcript 保存，不进入普通消息、搜索、跨 VP 或子 Agent 的上下文投影。原生 Anthropic 签名工具回合在模型、账号、归属或消息投影不一致时终止，不能通过丢弃签名静默继续。官方 endpoint 使用静态 API key 时，缺失的 `credentialScopeId` 默认使用完整密码学 key 指纹（不保存 key 本身），重启保持一致，换 key 后失效。动态凭据与自定义 endpoint 仍需显式 scope；缺失时不会发送缓存或保存无归属的 reasoning。旧 `thinkingBlocks` 可以读取，但不再直接回传；含旧签名的工具历史会提示开启新上下文。原生 signed thinking 工具响应缺少能力/归属配置时也会明确终止，需先配置已验证的直通路径。原始请求/响应调试数据是单独的数据层，仍应视为敏感数据。

发送缓存字段只表示请求了缓存；以 provider 返回的 cache usage 判断命中。缓存通常减少计费输入和延迟，不减少 HTTP 请求数。`reasoningTokens` 仅在上游提供时记录，是 output tokens 的子集，不重复计入总量。

子 Agent 使用生成 SpawnAgent/PromptAgent 工具调用的父请求实际 effort 快照，最高 `high`；未知父默认保守 `medium`，不同模型选择不高于上限的支持档位，无法表示时显式报错。`/max`、配置 boost、`extraBody` 和关闭 thinking feature flag 均不能绕过最终 payload 上限。

安全只读工具按共享段并发，不再统一限制为四个；写入、未知工具及控制工具保持独占 barrier。读取路径时提前补载对应项目规则，但同一模型响应里的写入仍不能使用尚未进入模型上下文的规则 scope。`projectDocMaxBytes: 0` 仍禁用规则加载。

其他字段会被静默忽略。模型显示名等 UI 元数据来自打包好的 `models.js` / `models-dev.js`，不走用户 config。

### `yeaft` 段（引擎运行时上限）

```json
"yeaft": {
  "maxConcurrentThreads": 6,
  "autoArchiveIdleDays":  30,
  "recentTurnsLimit":     10,
  "relatedTurnsLimit":    5,
  "multiVp": { "enabled": true },
  "dream":   { "DREAM_INTERVAL_HOURS": 1, "MIN_NEW_PER_GROUP": 20, "MAX_DREAM_PROMPT_CHARS": 96000 }
}
```

| 字段 | 类型 | 默认 | 范围 | 说明 |
| --- | --- | --- | --- | --- |
| `maxConcurrentThreads` | `number` | `6` | `1–50` | ThreadEngineRegistry 并发上限；含常驻的 `main` thread |
| `autoArchiveIdleDays` | `number` | `30` | `1–3650` | thread 自动归档的空闲天数 |
| `recentTurnsLimit` | `number` | `10` | `1–500` | 保留冷启回放配置兼容；provider 默认争取最近 10 turn，预算不足时从最旧端缩减并尽量保护 3 turn。连 3 个完整 turn 也装不下时，取消相关召回，只压缩这 3 个 turn 的临时 provider 副本，并将工具回放收窄到最新 1 turn |
| `relatedTurnsLimit` | `number` | `5` | `0–5` | 当前 Session 自动相关召回上限；只选明显相关的完整问答，实际可为 0–5 个 turn。0 关闭召回；旧值 8/10 读取时收敛到 5 |
| `multiVp.enabled` | `boolean` | `false` | — | 为兼容保留的 legacy feature flag；当前 Session UI 不把它作为 mode gate |
| `dream.*` | object | 见 [dream/limits.js](https://github.com/yeaft/yeaft-web-code-agent/blob/main/agent/yeaft/dream/limits.js) | — | 任何 `DEFAULT_LIMITS` 里的 UPPER_CASE 常量都可覆盖 |

数值超范围会被**钳制**到合法范围（而不是悄悄回落默认），所以手写一个 `maxConcurrentThreads: 100` 会被读成 `50`，不是默认的 `6`。

### `browserRuntime` 段

交互式设置优先使用 **Workbench → 浏览器**；无人值守设置使用 `yeaft-agent browser ... --name <instance>`。也可以手改 JSON，但这不会刷新已经运行的 Agent 进程。

```json
"browserRuntime": {
  "enabled": false,
  "executablePath": null,
  "cacheDir": null,
  "headless": true,
  "maxSessions": 2,
  "maxPeersPerSession": 2,
  "maxWidth": 1920,
  "maxHeight": 1080,
  "maxFps": 30,
  "maxBitrate": 4000000,
  "noViewerIdleMs": 120000,
  "interactiveIdleMs": 2100000,
  "startupProbeTimeoutMs": 20000
}
```

| 字段 | 默认 | 范围 / 行为 | 说明 |
| --- | --- | --- | --- |
| `enabled` | `false` | 只有字面量 `true` 才启用 | 为当前 Agent instance 启用启动探测 |
| `executablePath` | `null` | 必须是兼容的固定 Chrome build | 显式 Chrome for Testing 路径；`null` 使用 managed install |
| `cacheDir` | `null` | runtime 默认：`<yeaftDir>/managed-browser` | managed Chrome cache 根目录 |
| `headless` | `true` | boolean | 以 headless 方式运行探测和 Browser Session |
| `maxSessions` | `2` | `1–4` | Browser Session 并发数 |
| `maxPeersPerSession` | `2` | `1–4` | 每个 Browser Session 的 viewer 并发数 |
| `maxWidth` / `maxHeight` | `1920` / `1080` | `320–3840` / `240–2160` | capture viewport 上限 |
| `maxFps` | `30` | `1–60` | capture 帧率上限 |
| `maxBitrate` | `4000000` | `100000–8000000` | 视频 bitrate 上限（bit/s） |
| `maxQueuedActionsPerSession` | `128` | `1–256` | 每个 Session 的 action queue 条数上限 |
| `maxQueuedActionsPerProducer` | `32` | `1–64` | 每个 producer 的 action queue 条数上限 |
| `maxActionQueueBytes` | `1048576` | `65536–4194304` | 每个 Session 的 action queue 字节上限 |
| `maxActionRuntimeMs` | `30000` | `1000–120000` | 单次 Browser action deadline |
| `producerCreditBurst` | `16` | `1–64` | producer action rate burst credit |
| `producerCreditRefillPerSecond` | `8` | `1–64` | producer action rate credit 恢复速度 |
| `noViewerIdleMs` | `120000` | `10000–1800000` | 最后一个 viewer detach 后的回收延迟 |
| `interactiveIdleMs` | `2100000` | `60000–28800000` | 交互式 Browser Session 空闲上限 |
| `maxDownloadsBytes` | `536870912` | `0–2147483648` | 每个 Session 的下载字节上限；`0` 禁止下载 |
| `startupProbeTimeoutMs` | `20000` | `5000–60000` | 启动媒体探测总 deadline |

手改的数值会在读取时钳制；UI/API 写入则会拒绝未知或超范围字段。Ready viewer 数据面目前要求 Linux x64 Agent 且 tab-capture probe 成功；仅有 `enabled: true` 不代表 ready。

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
| `WORK_DIR` | `workDir` | `~/.yeaft/instances/<agentName>` | provider session 默认工作目录；显式 env/file 配置优先 |

### Yeaft 引擎

| 变量 | `fileConfig` key | 默认 | 说明 |
| --- | --- | --- | --- |
| `YEAFT_DIR` | `yeaftDir` | default: `~/.yeaft`；named: `~/.yeaft/instances/<name>` | Override 当前 instance 的 Yeaft data root |
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

> 如果你有 Anthropic / OpenAI key，优先写进所选 instance `config.json` 的 provider `apiKey` 字段 — 引擎本身不会去读 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`。

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
| `BROWSER_RUNTIME_ENABLED` | — | `true` | 设置为 `false` 时全局关闭 Browser setup、信令和 viewer route |
| `BROWSER_STUN_URLS` | — | — | Browser WebRTC peer 使用的 STUN URL，英文逗号分隔 |
| `BROWSER_TURN_URLS` | — | — | TURN URL，英文逗号分隔；跨 NAT/受限网络的远程 Browser Viewer 要稳定工作必须配置，并同时设置 `BROWSER_TURN_SECRET` |
| `BROWSER_TURN_SECRET` | 配置 TURN URL 时必填 | — | coturn REST API shared secret，用于生成短期 endpoint credential；必须与 TURN 服务一致，且不能暴露给 Web/Agent endpoint |
| `BROWSER_TURN_TTL_SECONDS` | — | `600` | TURN credential TTL，钳制到 `60–3600` 秒 |
| `BROWSER_ICE_TRANSPORT_POLICY` | — | `all` | `all` 或 `relay`；`relay` 至少需要一个 TURN URL |
| `BROWSER_ROUTE_TTL_MS` | — | `900000` | Browser peer route TTL，钳制到 `60000–3600000` ms |
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
| `TOTP_ISSUER` | `'Claude Web Chat'`（legacy default） | otpauth URI 里的 issuer label；新部署建议设为 `Yeaft Web Code Agent` |
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
