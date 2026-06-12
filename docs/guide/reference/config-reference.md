# Config Reference

This chapter is the **field-by-field** reference — Yeaft engine `~/.yeaft/config.json` + Agent / Server environment variables. For day-to-day filling, see [Yeaft Engine Configuration](../yeaft-config.md); this chapter is a lookup table.

> The schema documented here is what the code actually reads at the time of writing — extracted from `agent/yeaft/config.js`, `agent/index.js`, `server/config.js`. Fields the code does not consume are intentionally omitted; if you remember a field that used to be here and is now gone, it almost certainly never had a code path.

---

## `~/.yeaft/config.json`

### Top-Level

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `providers` | `Provider[]` | — (required) | LLM provider list |
| `primaryModel` | `string` | — (required) | Primary model `<provider>/<model-id>` |
| `fastModel` | `string` | `primaryModel` | Lightweight model for internal tasks (dream / adjust) |
| `fallbackModel` | `string` | `null` | Model used when the primary fails with a retryable error |
| `language` | `'en' \| 'zh'` | `'en'` | System prompt language |
| `debug` | `boolean` | `false` | Verbose-log raw LLM req/resp + engine events to stdout |
| `maxContextTokens` | `number` | model registry → `200000` | Max tokens injected per turn; engine compacts above this |
| `maxOutputTokens` | `number` | model registry → `16384` | Per-call output token cap |
| `messageTokenBudget` | `number` | `32768` | Per-message render cap used during compact |
| `maxContinueTurns` | `number` | `3` | Auto-continue turns after `max_tokens` stop |
| `projectDocMaxBytes` | `number` | `32768` | CLAUDE.md / AGENTS.md injection cap (0 = disabled) |
| `yeaft` | `YeaftSection` | see below | Engine runtime caps and feature flags |
| `mcpServers` | `MCPServer[]` | `[]` | MCP server configs (falls back to `~/.yeaft/mcp.json`) |

### Provider Object

| Field | Type | Required | Description |
| --- | --- | :---: | --- |
| `name` | `string` | ✓ | Unique provider name; used in `<provider>/<model-id>` refs |
| `baseUrl` | `string` | ✓ | API root URL (no `/v1/...` suffix) |
| `apiKey` | `string` | △ | Static key (mutually exclusive with `credentialProvider`) |
| `credentialProvider` | `string` | △ | Dynamic credential name (currently only `github-copilot`) |
| `protocol` | `'anthropic' \| 'openai-responses'` | — | Provider-level wire protocol; per-model overrides win |
| `models` | `(string \| ModelEntry)[]` | ✓ | Models served by this provider |

> The chat-completions protocol was removed in Phase 7 (v0.1.590). Only `anthropic` and `openai-responses` are valid.

### Model Entry (string shorthand also valid)

A model entry can be either the bare id string (`"gpt-5"`) or an object:

| Field | Type | Required | Description |
| --- | --- | :---: | --- |
| `id` | `string` | ✓ | Model id the vendor recognizes |
| `protocol` | `'anthropic' \| 'openai-responses'` | — | Overrides the provider protocol |
| `contextWindow` | `number` | — | Overrides the registry default for this model |
| `maxOutput` | `number` | — | Overrides the registry default output cap |

Anything else on a model entry is silently ignored. UI affordances like display names live in the bundled `models.js` / `models-dev.js` registries, not in user config.

### `yeaft` Section (engine runtime caps)

```json
"yeaft": {
  "maxConcurrentThreads": 6,
  "autoArchiveIdleDays":  30,
  "recentTurnsLimit":     20,
  "multiVp": { "enabled": true },
  "dream":   { "DREAM_INTERVAL_HOURS": 1, "MIN_NEW_PER_GROUP": 20 }
}
```

| Field | Type | Default | Clamp | Description |
| --- | --- | --- | --- | --- |
| `maxConcurrentThreads` | `number` | `6` | `1–50` | Concurrent ThreadEngineRegistry cap; includes the always-on `main` thread |
| `autoArchiveIdleDays` | `number` | `30` | `1–3650` | Idle days before a thread is auto-archived |
| `recentTurnsLimit` | `number` | `20` | `1–500` | Cold-start replay window when no compact summary exists |
| `multiVp.enabled` | `boolean` | `false` | — | Opt-in flag for multi-VP session mode (gates UI entry) |
| `dream.*` | object | see [dream/limits.js](https://github.com/yeaft/claude-web-chat/blob/main/agent/yeaft/dream/limits.js) | — | Overrides any UPPER_CASE constant in `DEFAULT_LIMITS` |

Out-of-range numeric values are **clamped** to the valid range rather than silently reset (so a hand-edit of `maxConcurrentThreads: 100` loads as `50`, not the default `6`).

### `mcpServers`

```json
"mcpServers": [
  { "name": "playwright", "command": "npx", "args": ["-y", "@playwright/mcp-server"] }
]
```

Each entry needs at minimum `name` and `command`; missing either is silently filtered out. If this field is absent the engine reads `~/.yeaft/mcp.json` instead (same shape, wrapped under `{ "servers": [...] }`).

---

## Agent environment / `.env`

The Agent reads environment variables on startup. Most values can also be set in the Agent's `config.json` (`fileConfig`); env wins when both are present.

### Connection

| Variable | `fileConfig` key | Default | Description |
| --- | --- | --- | --- |
| `SERVER_URL` | `serverUrl` | — | Server WebSocket URL (e.g. `wss://chat.example.com`) |
| `AGENT_NAME` | `agentName` | — | Unique agent name (server uses to identify) |
| `AGENT_SECRET` | `agentSecret` | — | Auth secret; must match the server's expected value |
| `WORK_DIR` | `workDir` | `process.cwd()` | Default working directory passed to provider sessions |

### Yeaft engine

| Variable | `fileConfig` key | Default | Description |
| --- | --- | --- | --- |
| `YEAFT_DIR` | `yeaftDir` | `~/.yeaft` | Override default Yeaft data root |
| `MAX_CONTEXT_TOKENS` | `maxContextTokens` | `128000` | Denominator used for the agent-side context % display |
| `AUTO_COMPACT_THRESHOLD` | `autoCompactThreshold` | `110000` | Token count at which the Chat-mode wrapper triggers compact |
| `YEAFT_THINKING_V1` | — | `"0"` | Set to `"1"` to enable the v1 thinking/reasoning protocol path |

### Tool gating

| Variable | `fileConfig` key | Default | Description |
| --- | --- | --- | --- |
| `DISALLOWED_TOOLS` | `disallowedTools` | — | Comma-separated tool names to deny (set to `"none"` to clear the list) |
| `ALLOWED_MCP_SERVERS` | `allowedMcpServers` | `"playwright"` | Comma-separated allow-list of MCP server names |

### Eval scripts (optional)

| Variable | Default | Description |
| --- | --- | --- |
| `YEAFT_API_KEY` | — | Anthropic key consumed by `agent/yeaft/eval/run-eval.js` |
| `YEAFT_OPENAI_API_KEY` | — | OpenAI key consumed by the same eval script |

> If you have an Anthropic / OpenAI key, prefer putting it in `~/.yeaft/config.json` under a provider's `apiKey` field — the engine itself does not read `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` directly.

---

## Server environment / `.env`

| Variable | Required | Default | Description |
| --- | :---: | --- | --- |
| `PORT` | — | `3456` | HTTP/WS listen port |
| `SKIP_AUTH` | — | `false` | **dev only**: skip all auth; never set in production |
| `JWT_SECRET` | ✓ in prod | `'default-secret-change-in-production'` | JWT signing secret; the server refuses to start in non-skipAuth mode if left at the default |
| `JWT_EXPIRES_IN` | — | `'3d'` | JWT lifetime (any value the `jsonwebtoken` package accepts) |
| `JWT_RENEW_THRESHOLD_MS` | — | `86400000` (1 day) | Sliding-renew threshold; tokens within this window of expiry are reissued |
| `TEMP_TOKEN_EXPIRES_IN` | — | `'10m'` | Lifetime for short-lived tokens (e.g. email-verification handoff) |
| `AGENT_SECRET` | ✓ | `'agent-shared-secret'` | Must match the Agent `AGENT_SECRET` |
| `AUTH_USERS` | — | — | `username:passwordHash:email,...` for bootstrap user list |
| `MAX_FILE_SIZE` | — | `52428800` (50 MB) | Single-upload byte cap |
| `FILE_CLEANUP_INTERVAL` | — | `600000` (10 min) | Temporary-file sweep interval (ms) |

### Email / verification

| Variable | Default | Description |
| --- | --- | --- |
| `EMAIL_CODE_LENGTH` | `6` | Digits in email verification codes |
| `EMAIL_CODE_EXPIRES_IN` | `300000` (5 min) | Verification code TTL (ms) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | — | Standard SMTP settings; email features stay disabled until `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` are all set |

### TOTP

| Variable | Default | Description |
| --- | --- | --- |
| `TOTP_ENABLED` | `true` | Globally enable TOTP 2FA |
| `TOTP_ISSUER` | `'Claude Web Chat'` | Issuer label embedded in the otpauth URI |
| `TOTP_WINDOW` | `1` | Allowed time-step drift |

### SSO providers

Azure AD plus four OAuth providers share the same enable/credential pattern. Each provider's email/SSO path stays off unless the listed variables are all set.

| Provider | Enable flag | Credential variables |
| --- | --- | --- |
| Azure AD | `AAD_ENABLED=true` | `AAD_CLIENT_ID`, `AAD_TENANT_ID`, `AAD_AUTO_CREATE_USER`, `AAD_DEFAULT_ROLE` |
| GitHub | `SSO_GITHUB_ENABLED=true` | `SSO_GITHUB_CLIENT_ID`, `SSO_GITHUB_CLIENT_SECRET`, `SSO_GITHUB_CALLBACK_URL`, `SSO_GITHUB_AUTO_CREATE_USER`, `SSO_GITHUB_DEFAULT_ROLE` |
| Google | `SSO_GOOGLE_ENABLED=true` | `SSO_GOOGLE_CLIENT_ID`, `SSO_GOOGLE_CLIENT_SECRET`, `SSO_GOOGLE_CALLBACK_URL`, `SSO_GOOGLE_AUTO_CREATE_USER`, `SSO_GOOGLE_DEFAULT_ROLE` |
| WeChat | `SSO_WECHAT_ENABLED=true` | `SSO_WECHAT_APP_ID`, `SSO_WECHAT_APP_SECRET`, `SSO_WECHAT_CALLBACK_URL`, `SSO_WECHAT_AUTO_CREATE_USER`, `SSO_WECHAT_DEFAULT_ROLE` |
| Alipay | `SSO_ALIPAY_ENABLED=true` | `SSO_ALIPAY_APP_ID`, `SSO_ALIPAY_PRIVATE_KEY`, `SSO_ALIPAY_PUBLIC_KEY`, `SSO_ALIPAY_CALLBACK_URL`, `SSO_ALIPAY_AUTO_CREATE_USER`, `SSO_ALIPAY_DEFAULT_ROLE` |

---

## Compatibility Matrix

| Field / Variable | Introduced in |
| --- | --- |
| `providers[].credentialProvider` | v0.1.420+ |
| `providers[].models[].protocol` (per-model override) | v0.1.430+ |
| `yeaft.multiVp.enabled` | v0.1.560+ |
| `yeaft.maxConcurrentThreads` / `autoArchiveIdleDays` (task-318) | v0.1.580+ |
| `yeaft.recentTurnsLimit` | v0.1.590+ |
| Removed `protocol: "chat-completions"` | v0.1.590 (Phase 7) |
| Removed `protocol: "openai"` alias | v0.1.590 (Phase 7) |

When upgrading and hitting `Phase 7 removed ...` errors, use the mapping above.
