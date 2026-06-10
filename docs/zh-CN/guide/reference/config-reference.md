# 配置文件参考

本章是**全字段**参考 — Yeaft 引擎 `~/.yeaft/config.json` + Agent 端 `.env`。日常配怎么填看 [Yeaft 引擎配置](../yeaft-config.md)；本章供查阅。

---

## `~/.yeaft/config.json`

### 顶层

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `providers` | `Provider[]` | — (required) | LLM provider 列表 |
| `primaryModel` | `string` | — (required) | 主 model 引用 `<provider>/<model-id>` |
| `fastModel` | `string` | `primaryModel` | 内部任务（dream / adjust）用的轻量 model |
| `language` | `'en' \| 'zh'` | `'en'` | System prompt 语言 |
| `debug` | `boolean` | `false` | 把 LLM raw req/resp 打到 console |
| `maxContextTokens` | `number` | `200000` | 单 turn 注入 LLM 的最大 token，超出触发 compact |
| `messageTokenBudget` | `number` | `32768` | 单条 message 渲染上限 |
| `memoryBudgets` | `MemoryBudgets` | 见下 | AMS 各层 token 预算 |
| `compact` | `CompactPolicy` | 见下 | 上下文压缩策略 |
| `dream` | `DreamPolicy` | 见下 | 后台记忆维护策略 |
| `tools` | `ToolsConfig` | `{}` | 工具系统配置（允许/禁用、并发） |
| `personas` | `PersonaDef[]` | `[]` | 自定义 VP 人格 |

### Provider 对象

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | :---: | --- |
| `name` | `string` | ✓ | provider 唯一名 |
| `baseUrl` | `string` | ✓ | API 根 URL（无 `/v1/...` 尾） |
| `apiKey` | `string` | △ | 静态 key（和 `credentialProvider` 二选一） |
| `credentialProvider` | `string` | △ | 动态凭证名（当前支持 `github-copilot`） |
| `protocol` | `'anthropic' \| 'openai-responses'` | — | provider 级默认 wire 协议 |
| `models` | `(string \| ModelEntry)[]` | ✓ | 支持的 model 列表 |
| `defaultHeaders` | `Record<string, string>` | — | 每次请求附加 header |
| `fallback` | `string[]` | — | 失败时按序尝试的备选 model（同 provider 内） |
| `timeout` | `number` | `300000` | 请求超时 ms |
| `maxRetries` | `number` | `2` | 可重试错误时的最大重试次数 |

### Model entry 对象（字符串简写也可）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | :---: | --- |
| `id` | `string` | ✓ | vendor 端识别的 model id |
| `protocol` | `'anthropic' \| 'openai-responses'` | — | 覆盖 provider protocol |
| `displayName` | `string` | — | UI 显示用 |
| `contextWindow` | `number` | — | 覆盖 `models.js` 默认 |
| `maxOutputTokens` | `number` | — | 覆盖默认输出上限 |
| `pricing` | `{input, output, cacheRead?, cacheWrite?}` | — | 自定义价格（USD per 1M token） |
| `disabled` | `boolean` | `false` | UI 上隐藏但保留配置 |

### MemoryBudgets

```json
"memoryBudgets": {
  "residentSummary": 2000,
  "recent":          3000,
  "onDemand":        5000
}
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `residentSummary` | `2000` | Layer-A summary 注入 token 上限 |
| `recent` | `3000` | 近期 high-priority 段上限 |
| `onDemand` | `5000` | preflow 召回的相关段上限 |

### CompactPolicy

```json
"compact": {
  "trigger":        "auto",
  "threshold":      0.85,
  "strategy":       "summary",
  "preserveRecent": 6
}
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `trigger` | `'auto' \| 'manual'` | `'auto'` 时按 `threshold` 自动跑 |
| `threshold` | `0.85` | context 占比超过这个 → compact |
| `strategy` | `'summary' \| 'truncate'` | summary 调 LLM 写 summary；truncate 直接砍 |
| `preserveRecent` | `6` | compact 时保留最近 N 个 turn 不压缩 |

### DreamPolicy

```json
"dream": {
  "enabled":       true,
  "idleMs":        300000,
  "minSegments":   5,
  "minDeltaChars": 4000
}
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 后台 dream loop 开关 |
| `idleMs` | `300000` | 用户无活动 N ms 后才跑 dream |
| `minSegments` | `5` | 新增段数达 N 才触发 |
| `minDeltaChars` | `4000` | 新增字符达 N 才触发 |

### ToolsConfig

```json
"tools": {
  "allowed":       null,
  "denied":        ["bash"],
  "askUser": {
    "enabled":     true,
    "timeoutMs":   120000
  },
  "bash": {
    "timeoutMs":   30000,
    "maxOutputKB": 256
  },
  "concurrency": {
    "agents":      4
  }
}
```

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `allowed` | `string[] \| null` | `null` (全开) | 白名单 |
| `denied` | `string[]` | `[]` | 黑名单 |
| `askUser.enabled` | `boolean` | `true` | ask-user 工具开关 |
| `askUser.timeoutMs` | `number` | `120000` | 用户无回复超时 |
| `bash.timeoutMs` | `number` | `30000` | bash 执行超时 |
| `bash.maxOutputKB` | `number` | `256` | bash 输出截断 |
| `concurrency.agents` | `number` | `4` | 并行子 agent 最大数 |

### PersonaDef

```json
"personas": [
  {
    "id":           "alice",
    "name":         "Alice",
    "model":        "my-proxy/claude-sonnet-4-20250514",
    "systemPrompt": "你是 Alice，专攻 frontend...",
    "tools":        ["bash", "file-read", "file-write"],
    "avatar":       "https://..."
  }
]
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | :---: | --- |
| `id` | `string` | ✓ | VP 唯一 id |
| `name` | `string` | ✓ | UI 显示名 |
| `model` | `string` | — | 覆盖 `primaryModel` |
| `systemPrompt` | `string` | — | 追加到 system prompt 末尾 |
| `tools` | `string[]` | — | 限制此 VP 可用工具 |
| `avatar` | `string` | — | 头像 URL |
| `temperature` | `number` | — | 覆盖默认 temperature |

---

## Agent `.env`

Agent 启动时读环境变量 — 既可写在 `.env`，也可 export 到 shell。

### 必填

| 变量 | 说明 |
| --- | --- |
| `AGENT_NAME` | Agent 唯一名（用于 server 端识别） |
| `AGENT_TOKEN` | 鉴权 token（server 端配同样的 token） |
| `SERVER_URL` | server WebSocket URL（如 `wss://chat.example.com`） |

### 可选

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AGENT_USER_ID` | — | 把 agent 绑到某个 user（否则任意 user 可见） |
| `WORKDIR` | `process.cwd()` | 默认工作目录 |
| `LOG_LEVEL` | `'info'` | `'debug' \| 'info' \| 'warn' \| 'error'` |
| `MAX_CONCURRENT_SESSIONS` | `8` | 同时跑的 session 上限 |
| `HEARTBEAT_INTERVAL_MS` | `15000` | 心跳间隔 |
| `RECONNECT_BACKOFF_MAX_MS` | `30000` | 断线重连最大退避 |

### Provider 相关（被 Yeaft 引擎用）

| 变量 | 说明 |
| --- | --- |
| `YEAFT_CONFIG_PATH` | 覆盖默认 `~/.yeaft/config.json` 路径 |
| `ANTHROPIC_API_KEY` | 如不在 config 写 apiKey，可从 env 读 |
| `OPENAI_API_KEY` | 同上 |
| `GITHUB_TOKEN` | github-copilot credential provider 用 |

### Workbench 相关

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `WORKBENCH_DISABLED` | `false` | 设 `true` 完全关闭 Workbench |
| `TERMINAL_MAX_SESSIONS` | `16` | PTY 上限 |
| `FILE_EDIT_MAX_SIZE_MB` | `20` | 编辑器单文件大小上限 |

### Proxy 相关

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT_PROXY_DISABLED` | `false` | 完全关闭端口转发 |
| `PORT_PROXY_BIND` | `127.0.0.1` | 代理绑定地址 |

---

## Server `.env`

| 变量 | 必填 | 默认 | 说明 |
| --- | :---: | --- | --- |
| `PORT` | — | `3000` | HTTP/WS 监听端口 |
| `JWT_SECRET` | ✓ | — | JWT 签名密钥 |
| `JWT_TTL_HOURS` | — | `720` | JWT 有效期 |
| `DB_PATH` | — | `./server-data.db` | SQLite 文件 |
| `ALLOW_REGISTRATION` | — | `false` | 是否允许公开注册 |
| `REQUIRE_INVITE_CODE` | — | `true` | 注册要不要邀请码 |
| `AGENT_TOKEN` | ✓ | — | 与 agent `.env` 的 AGENT_TOKEN 必须一致 |
| `SKIP_AUTH` | — | `false` | **仅开发**：跳过所有鉴权 |
| `MAX_UPLOAD_MB` | — | `25` | 单次上传上限 |
| `LOG_LEVEL` | — | `'info'` | 日志级别 |

---

## 兼容性矩阵

| 字段 / 变量 | 在哪个 release 引入 |
| --- | --- |
| `providers[].credentialProvider` | v0.1.420+ |
| `providers[].models[].protocol`（per-model 覆盖） | v0.1.430+ |
| `memoryBudgets` 顶层化 | v0.1.520+ |
| `personas[]` 顶层化 | v0.1.580+ |
| 移除 `protocol: "chat-completions"` | v0.1.590（Phase 7） |
| 移除 `protocol: "openai"` 别名 | v0.1.590（Phase 7） |

老版本 config 升级时如果碰到 `Phase 7 removed ...` 错误，照上面映射改即可。
