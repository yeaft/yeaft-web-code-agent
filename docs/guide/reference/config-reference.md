# Config Reference

This chapter is the **field-by-field** reference — Yeaft engine `~/.yeaft/config.json` + Agent-side `.env`. For day-to-day filling, see [Yeaft Engine Configuration](../yeaft-config.md); this chapter is a lookup table.

---

## `~/.yeaft/config.json`

### Top-Level

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `providers` | `Provider[]` | — (required) | LLM provider list |
| `primaryModel` | `string` | — (required) | Primary model `<provider>/<model-id>` |
| `fastModel` | `string` | `primaryModel` | Lightweight model for internal tasks (dream / adjust) |
| `language` | `'en' \| 'zh'` | `'en'` | System prompt language |
| `debug` | `boolean` | `false` | Log raw LLM req/resp to console |
| `maxContextTokens` | `number` | `200000` | Max tokens per turn into LLM; triggers compact when exceeded |
| `messageTokenBudget` | `number` | `32768` | Per-message render cap |
| `memoryBudgets` | `MemoryBudgets` | see below | AMS layer token budgets |
| `compact` | `CompactPolicy` | see below | Context compaction policy |
| `dream` | `DreamPolicy` | see below | Background memory maintenance policy |
| `tools` | `ToolsConfig` | `{}` | Tool registry config (allow/deny, concurrency) |
| `personas` | `PersonaDef[]` | `[]` | Custom VP personas |

### Provider Object

| Field | Type | Required | Description |
| --- | --- | :---: | --- |
| `name` | `string` | ✓ | unique provider name |
| `baseUrl` | `string` | ✓ | API root URL (no `/v1/...` suffix) |
| `apiKey` | `string` | △ | static key (or use `credentialProvider`) |
| `credentialProvider` | `string` | △ | dynamic credential name (currently `github-copilot`) |
| `protocol` | `'anthropic' \| 'openai-responses'` | — | provider default wire protocol |
| `models` | `(string \| ModelEntry)[]` | ✓ | supported model list |
| `defaultHeaders` | `Record<string, string>` | — | extra headers per request |
| `fallback` | `string[]` | — | fallback models tried in order on failure (same provider) |
| `timeout` | `number` | `300000` | request timeout ms |
| `maxRetries` | `number` | `2` | max retries on retryable errors |

### Model Entry Object (string shorthand also valid)

| Field | Type | Required | Description |
| --- | --- | :---: | --- |
| `id` | `string` | ✓ | model id the vendor recognizes |
| `protocol` | `'anthropic' \| 'openai-responses'` | — | overrides provider protocol |
| `displayName` | `string` | — | UI label |
| `contextWindow` | `number` | — | overrides `models.js` default |
| `maxOutputTokens` | `number` | — | overrides default output cap |
| `pricing` | `{input, output, cacheRead?, cacheWrite?}` | — | custom pricing (USD per 1M token) |
| `disabled` | `boolean` | `false` | hide in UI but keep config |

### MemoryBudgets

```json
"memoryBudgets": {
  "residentSummary": 2000,
  "recent":          3000,
  "onDemand":        5000
}
```

| Field | Default | Description |
| --- | --- | --- |
| `residentSummary` | `2000` | Layer-A summary injection token cap |
| `recent` | `3000` | Recent high-priority segment cap |
| `onDemand` | `5000` | preflow-recalled relevant segment cap |

### CompactPolicy

```json
"compact": {
  "trigger":        "auto",
  "threshold":      0.85,
  "strategy":       "summary",
  "preserveRecent": 6
}
```

| Field | Default | Description |
| --- | --- | --- |
| `trigger` | `'auto' \| 'manual'` | `'auto'` runs automatically when threshold hit |
| `threshold` | `0.85` | context usage ratio above which compact triggers |
| `strategy` | `'summary' \| 'truncate'` | summary uses LLM to write digest; truncate just cuts |
| `preserveRecent` | `6` | preserve last N turns uncompacted |

### DreamPolicy

```json
"dream": {
  "enabled":       true,
  "idleMs":        300000,
  "minSegments":   5,
  "minDeltaChars": 4000
}
```

| Field | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | toggle background dream loop |
| `idleMs` | `300000` | wait this long without user activity before dreaming |
| `minSegments` | `5` | trigger after N new segments |
| `minDeltaChars` | `4000` | trigger after N new chars |

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

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `allowed` | `string[] \| null` | `null` (all open) | whitelist |
| `denied` | `string[]` | `[]` | blacklist |
| `askUser.enabled` | `boolean` | `true` | toggle ask-user tool |
| `askUser.timeoutMs` | `number` | `120000` | user no-reply timeout |
| `bash.timeoutMs` | `number` | `30000` | bash exec timeout |
| `bash.maxOutputKB` | `number` | `256` | bash output truncation |
| `concurrency.agents` | `number` | `4` | parallel sub-agent cap |

### PersonaDef

```json
"personas": [
  {
    "id":           "alice",
    "name":         "Alice",
    "model":        "my-proxy/claude-sonnet-4-20250514",
    "systemPrompt": "You are Alice, frontend specialist...",
    "tools":        ["bash", "file-read", "file-write"],
    "avatar":       "https://..."
  }
]
```

| Field | Type | Required | Description |
| --- | --- | :---: | --- |
| `id` | `string` | ✓ | unique VP id |
| `name` | `string` | ✓ | UI display name |
| `model` | `string` | — | overrides `primaryModel` |
| `systemPrompt` | `string` | — | appended to system prompt tail |
| `tools` | `string[]` | — | limit this VP's tools |
| `avatar` | `string` | — | avatar URL |
| `temperature` | `number` | — | overrides default temperature |

---

## Agent `.env`

Agent reads environment variables on startup — write into `.env` or export to the shell.

### Required

| Variable | Description |
| --- | --- |
| `AGENT_NAME` | unique agent name (server uses to identify) |
| `AGENT_TOKEN` | auth token (server must be configured with the same token) |
| `SERVER_URL` | server WebSocket URL (e.g. `wss://chat.example.com`) |

### Optional

| Variable | Default | Description |
| --- | --- | --- |
| `AGENT_USER_ID` | — | bind agent to a specific user (otherwise visible to any user) |
| `WORKDIR` | `process.cwd()` | default working directory |
| `LOG_LEVEL` | `'info'` | `'debug' \| 'info' \| 'warn' \| 'error'` |
| `MAX_CONCURRENT_SESSIONS` | `8` | concurrent session cap |
| `HEARTBEAT_INTERVAL_MS` | `15000` | heartbeat interval |
| `RECONNECT_BACKOFF_MAX_MS` | `30000` | max reconnect backoff |

### Provider-Related (used by Yeaft engine)

| Variable | Description |
| --- | --- |
| `YEAFT_CONFIG_PATH` | override default `~/.yeaft/config.json` path |
| `ANTHROPIC_API_KEY` | fallback when apiKey not in config |
| `OPENAI_API_KEY` | same |
| `GITHUB_TOKEN` | used by github-copilot credential provider |

### Workbench-Related

| Variable | Default | Description |
| --- | --- | --- |
| `WORKBENCH_DISABLED` | `false` | set `true` to fully disable Workbench |
| `TERMINAL_MAX_SESSIONS` | `16` | PTY cap |
| `FILE_EDIT_MAX_SIZE_MB` | `20` | editor max file size |

### Proxy-Related

| Variable | Default | Description |
| --- | --- | --- |
| `PORT_PROXY_DISABLED` | `false` | fully disable port forwarding |
| `PORT_PROXY_BIND` | `127.0.0.1` | proxy bind address |

---

## Server `.env`

| Variable | Required | Default | Description |
| --- | :---: | --- | --- |
| `PORT` | — | `3000` | HTTP/WS listen port |
| `JWT_SECRET` | ✓ | — | JWT signing secret |
| `JWT_TTL_HOURS` | — | `720` | JWT TTL |
| `DB_PATH` | — | `./server-data.db` | SQLite file |
| `ALLOW_REGISTRATION` | — | `false` | allow public registration |
| `REQUIRE_INVITE_CODE` | — | `true` | require invite code for registration |
| `AGENT_TOKEN` | ✓ | — | must match agent `.env`'s AGENT_TOKEN |
| `SKIP_AUTH` | — | `false` | **dev only**: skip all auth |
| `MAX_UPLOAD_MB` | — | `25` | single upload cap |
| `LOG_LEVEL` | — | `'info'` | log level |

---

## Compatibility Matrix

| Field / Variable | Introduced in |
| --- | --- |
| `providers[].credentialProvider` | v0.1.420+ |
| `providers[].models[].protocol` (per-model override) | v0.1.430+ |
| `memoryBudgets` at top level | v0.1.520+ |
| `personas[]` at top level | v0.1.580+ |
| Removed `protocol: "chat-completions"` | v0.1.590 (Phase 7) |
| Removed `protocol: "openai"` alias | v0.1.590 (Phase 7) |

When upgrading and hitting `Phase 7 removed ...` errors, use the mapping above.
