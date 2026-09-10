# Config Reference

This chapter is the **field-by-field** reference for an Agent instance's Yeaft `config.json` plus Agent/Server environment variables. The default instance uses `~/.yeaft/config.json`; named instances use `~/.yeaft/instances/<name>/config.json` unless overridden. For day-to-day filling, see [Yeaft Engine Configuration](../yeaft-config.md); this chapter is a lookup table.

> The schema documented here is what the code actually reads at the time of writing — extracted from `agent/yeaft/config.js`, `agent/browser-runtime/config.js`, `agent/index.js`, and `server/config.js`. Fields the code does not consume are intentionally omitted; if you remember a field that used to be here and is now gone, it almost certainly never had a code path.

---

## Instance `config.json`

### Top-Level

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `providers` | `Provider[]` | — (required) | LLM provider list |
| `primaryModel` | `string` | — (required) | Primary model `<provider>/<model-id>` |
| `fastModel` | `string` | `primaryModel` | Lightweight model for internal tasks such as recall and classification; Dream uses the Session's primary model |
| `fallbackModel` | `string` | `null` | Model used when the primary fails with a retryable error |
| `language` | `'en' \| 'zh'` | `'en'` | System prompt language |
| `debug` | `boolean` | `false` | Verbose-log raw LLM req/resp + engine events to stdout |
| `maxContextTokens` | `number` | model registry → `200000` | Provider context-window reference used for request guards |
| `maxOutputTokens` | `number` | model registry → `16384` | Per-call output token cap |
| `messageTokenBudget` | `number` | `32768` | Deterministic provider-request history-window budget; does not modify transcript |
| `maxContinueTurns` | `number` | `3` | Auto-continue turns after `max_tokens` stop |
| `projectDocMaxBytes` | `number` | `32768` | CLAUDE.md / AGENTS.md injection cap (0 = disabled) |
| `yeaft` | `YeaftSection` | see below | Engine runtime caps and feature flags |
| `browserRuntime` | `BrowserRuntimeSection` | see below | Agent-instance Browser Runtime enablement, executable, and resource limits |
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
| `credentialScopeId` | `string` | — | Stable, non-secret account scope for native reasoning replay and caching. Required for dynamic credentials/custom endpoints; official static-key routes default to a key fingerprint. Change when switching accounts; preserve when rotating tokens |
| `capabilities` | `object` | — | Boolean `nativeReasoningState`, `promptCaching`, `parallelToolCalls`; `translation: true` disables all three. Model overrides take precedence |

> The chat-completions protocol was removed in Phase 7 (v0.1.590). Only `anthropic` and `openai-responses` are valid.

### Model Entry (string shorthand also valid)

A model entry can be either the bare id string (`"gpt-5"`) or an object:

| Field | Type | Required | Description |
| --- | --- | :---: | --- |
| `id` | `string` | ✓ | Model id the vendor recognizes |
| `protocol` | `'anthropic' \| 'openai-responses'` | — | Overrides the provider protocol |
| `contextWindow` | `number` | — | Overrides the registry default for this model |
| `maxOutput` | `number` | — | Overrides the registry default output cap |
| `capabilities` | `object` | — | Per-field overrides of provider protocol capabilities |

#### Reasoning continuity and caching

The official `https://api.openai.com/v1` and `https://api.anthropic.com` endpoints enable native capabilities by default. Unknown proxies default to disabled. Enable capabilities only after verifying both the proxy and upstream; model names do not prove support. Translating Messages into Chat Completions is not native Anthropic passthrough.

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

This is a capability fragment; retain your existing `apiKey` or `credentialProvider`. No automatic probing or live configuration changes occur. Responses uses `store: false`, native encrypted reasoning replay, and a stable cache key scoped to instance/Session/VP/thread. Anthropic preserves thinking/signature/redacted block order and adds at most three ephemeral cache breakpoints on system, tools, and the latest user/tool-result boundary, never on thinking blocks.

Private state persists with the instance transcript but is excluded from ordinary message, search, cross-VP and child-agent context projections. Signed Anthropic tool turns fail closed on model, account, owner or message-projection mismatches rather than silently dropping signatures. For official endpoints using a static API key, an omitted `credentialScopeId` defaults to a full cryptographic key fingerprint (never the key itself), stable across restarts and invalidated by key rotation. Dynamic credentials and custom endpoints require an explicit scope; without one, caching is not sent and unowned reasoning is not persisted. Legacy `thinkingBlocks` remain readable but are never replayed directly; signed legacy tool history requires a fresh context. A native signed-thinking tool response without capability/ownership configuration also terminates explicitly: configure the verified native route first. Raw request/response debugging is a separate sensitive data layer.

Sending cache fields requests caching; only provider cache usage establishes a hit. Caching usually reduces billed input and latency, not HTTP request count. `reasoningTokens`, when reported upstream, is a subset of output tokens and is not added again to totals.

Child agents inherit a snapshot of the actual parent request effort that produced SpawnAgent/PromptAgent, capped at `high`. Unknown parent defaults conservatively use `medium`; different models select a supported tier no higher than the ceiling or fail explicitly. `/max`, config boosts, `extraBody`, and disabling the thinking feature flag cannot bypass the final payload cap.

Safe read-only tools run in shared segments without a uniform four-call cap; writes, unknown tools and control tools retain exclusive barriers. Read paths preload applicable project rules, but writes in the same model response still cannot use rule scopes the model has not seen. `projectDocMaxBytes: 0` continues to disable rule loading.

Anything else on a model entry is silently ignored. UI affordances like display names live in the bundled `models.js` / `models-dev.js` registries, not in user config.

### `yeaft` Section (engine runtime caps)

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

| Field | Type | Default | Clamp | Description |
| --- | --- | --- | --- | --- |
| `maxConcurrentThreads` | `number` | `6` | `1–50` | Concurrent ThreadEngineRegistry cap; includes the always-on `main` thread |
| `autoArchiveIdleDays` | `number` | `30` | `1–3650` | Idle days before a thread is auto-archived |
| `recentTurnsLimit` | `number` | `10` | `1–500` | Compatible cold-start replay setting. Provider history targets the latest 10 turns and shrinks from the oldest end under budget pressure. It protects a three-turn floor when possible; if three complete turns still do not fit, related recall is omitted, those three turns are compressed in the disposable provider copy, and tool replay narrows to the newest turn |
| `relatedTurnsLimit` | `number` | `5` | `0–5` | Same-Session automatic related-turn cap; only clearly relevant full turns are included (0–5 actual turns). Set 0 to disable; older 8/10 values read as 5 |
| `multiVp.enabled` | `boolean` | `false` | — | Legacy feature flag retained for compatibility; the current Session UI does not use it as a mode gate |
| `dream.*` | object | see [dream/limits.js](https://github.com/yeaft/yeaft-web-code-agent/blob/main/agent/yeaft/dream/limits.js) | — | Overrides any UPPER_CASE constant in `DEFAULT_LIMITS` |

Out-of-range numeric values are **clamped** to the valid range rather than silently reset (so a hand-edit of `maxConcurrentThreads: 100` loads as `50`, not the default `6`).

### `browserRuntime` Section

Prefer **Workbench → Browser** for interactive setup, or `yeaft-agent browser ... --name <instance>` for unattended setup. Manual JSON editing is supported but does not refresh a running Agent process.

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

| Field | Default | Clamp / behavior | Description |
| --- | --- | --- | --- |
| `enabled` | `false` | only literal `true` enables | Enables startup probing for this Agent instance |
| `executablePath` | `null` | compatible pinned Chrome required | Explicit Chrome for Testing executable; `null` resolves the managed install |
| `cacheDir` | `null` | runtime default: `<yeaftDir>/managed-browser` | Managed Chrome cache root |
| `headless` | `true` | boolean | Launch probe and Browser Sessions headless |
| `maxSessions` | `2` | `1–4` | Concurrent Browser Sessions |
| `maxPeersPerSession` | `2` | `1–4` | Concurrent viewers per Browser Session |
| `maxWidth` / `maxHeight` | `1920` / `1080` | `320–3840` / `240–2160` | Captured viewport bounds |
| `maxFps` | `30` | `1–60` | Capture frame-rate ceiling |
| `maxBitrate` | `4000000` | `100000–8000000` | Video bitrate ceiling in bits/s |
| `maxQueuedActionsPerSession` | `128` | `1–256` | Per-Session action queue item cap |
| `maxQueuedActionsPerProducer` | `32` | `1–64` | Per-producer action queue item cap |
| `maxActionQueueBytes` | `1048576` | `65536–4194304` | Per-Session action queue byte cap |
| `maxActionRuntimeMs` | `30000` | `1000–120000` | Single Browser action deadline |
| `producerCreditBurst` | `16` | `1–64` | Producer action-rate burst credits |
| `producerCreditRefillPerSecond` | `8` | `1–64` | Producer action-rate refill |
| `noViewerIdleMs` | `120000` | `10000–1800000` | Reclaim delay after the last viewer detaches |
| `interactiveIdleMs` | `2100000` | `60000–28800000` | Interactive Browser Session idle limit |
| `maxDownloadsBytes` | `536870912` | `0–2147483648` | Per-Session download byte limit; `0` disables downloads |
| `startupProbeTimeoutMs` | `20000` | `5000–60000` | Total startup media-probe deadline |

Hand-edited numeric values are clamped on read. UI/API writes reject unknown or out-of-range fields. The ready viewer data plane currently requires a Linux x64 Agent and a successful tab-capture probe; `enabled: true` alone is not readiness.

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
| `WORK_DIR` | `workDir` | `~/.yeaft/instances/<agentName>` | Default working directory passed to provider sessions; explicit env/file values override it |

### Yeaft engine

| Variable | `fileConfig` key | Default | Description |
| --- | --- | --- | --- |
| `YEAFT_DIR` | `yeaftDir` | default: `~/.yeaft`; named: `~/.yeaft/instances/<name>` | Override this instance's Yeaft data root |
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

> If you have an Anthropic / OpenAI key, prefer putting it in the selected instance's `config.json` under a provider's `apiKey` field — the engine itself does not read `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` directly.

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
| `BROWSER_RUNTIME_ENABLED` | — | `true` | Set to `false` to disable Browser setup, signaling, and viewer routes globally |
| `BROWSER_STUN_URLS` | — | — | Comma-separated STUN URLs used by Browser WebRTC peers |
| `BROWSER_TURN_URLS` | — | — | Comma-separated TURN URLs; required for reliable remote Browser viewers across NATs/restrictive networks and requires `BROWSER_TURN_SECRET` |
| `BROWSER_TURN_SECRET` | required with TURN URLs | — | coturn REST API shared secret for short-lived endpoint credentials; must match the TURN service and never be exposed to Web/Agent endpoints |
| `BROWSER_TURN_TTL_SECONDS` | — | `600` | TURN credential TTL, clamped to `60–3600` seconds |
| `BROWSER_ICE_TRANSPORT_POLICY` | — | `all` | `all` or `relay`; `relay` requires at least one TURN URL |
| `BROWSER_ROUTE_TTL_MS` | — | `900000` | Browser peer route TTL, clamped to `60000–3600000` ms |
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
| `TOTP_ISSUER` | `'Claude Web Chat'` (legacy default) | Issuer label embedded in the otpauth URI; set to `Yeaft Web Code Agent` for new deployments |
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
