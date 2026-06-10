# Security

Yeaft has three independent credential layers to think about:

1. **Web user auth** — how humans log into the web UI
2. **Agent auth** — how an agent process proves it's allowed to connect to the server
3. **Yeaft engine credentials** — how the agent's Yeaft engine reaches third-party LLM APIs

They don't share secrets and don't fall back on each other.

## Web User Authentication

1. **Username + Password** (bcrypt hashed)
2. **TOTP 2FA** (optional, Google/Microsoft Authenticator)
3. **Email verification** (optional, requires SMTP)

JWT tokens are issued after login and used for subsequent REST + WebSocket calls.

## Production Requirements

The server **refuses to start** in production mode if:
- `JWT_SECRET` is left at default

If no users are configured, the server starts with a warning — create the first user via `docker compose exec`.

## Agent Authentication

- Agents authenticate via WebSocket message (secret never in URL)
- **Per-user agent secret**: Agent bound to a specific user (only that user can see it) — created in **Settings → Security**, takes precedence for that user
- **Global AGENT_SECRET**: Env var fallback, only visible to admin users
- Each connection gets a unique session key for encryption (TweetNaCl XSalsa20-Poly1305)

## Yeaft Engine Credentials

When the agent runs Yeaft Group Mode it talks directly to the LLM providers you list in `~/.yeaft/config.json`. Each provider entry has **one of two** credential modes:

| Mode | Field | What happens |
| --- | --- | --- |
| **Static API key** | `apiKey: "sk-..."` | Used as-is for every request to that provider |
| **Dynamic credential** | `credentialProvider: "github-copilot"` | At request time the engine asks the credential provider for a short-lived token. Currently supported: `github-copilot` (uses your existing GitHub OAuth, exchanges it for a Copilot API token) |

**Security consequences:**

- `apiKey` sits in `~/.yeaft/config.json` in plain text — chmod 600 the file, don't commit it
- `credentialProvider` keeps no long-lived secret on disk; tokens live in memory and refresh as needed
- Yeaft credentials are **not** seen by the server — only the agent uses them. The server never proxies LLM calls
- **Two-factor effect**: to run Yeaft against Copilot you need both a working agent secret (server-side gate) AND a working GitHub OAuth token (provider-side gate)

## Encryption

| Layer | Algorithm | Key source |
| --- | --- | --- |
| Web ↔ Server WebSocket | TweetNaCl XSalsa20-Poly1305 | Per-connection session key (Diffie-Hellman key exchange at connect) |
| Agent ↔ Server WebSocket | TweetNaCl XSalsa20-Poly1305 | Per-connection session key |
| LLM API traffic | TLS (standard HTTPS) | Provider TLS cert |

End-to-end encryption refers to the web ↔ agent path *through* the server — the server is a routing relay and cannot read message bodies in clear text.

## Roles & Permissions

All registered users are **Pro** by default. The first user created via CLI is **Admin**.

| Feature | `pro` | `admin` |
|---|:---:|:---:|
| Chat | yes | yes |
| Own agents (per-user secret) | yes | yes |
| Global agents (AGENT_SECRET) | - | yes |
| Workbench (Terminal, Git, Files) | yes | yes |
| Port Proxy | yes | yes |
| Manage invitations | - | yes |
| Admin Dashboard | - | yes |

## Threat Model — What Yeaft Does Not Protect Against

- **Compromised agent machine**: an attacker with root on the agent box can read `~/.yeaft/config.json`, intercept Yeaft credentials, exfiltrate `~/.yeaft/scopes/**` memory segments, and tail running CLI processes. Run agents on machines you trust.
- **Malicious server operator**: encryption protects message body confidentiality through routing, but the server still sees metadata (who connects to which agent, timing, message sizes). A hostile server can also serve modified web JS to clients.
- **Browser-side XSS**: the web client renders agent output as HTML/markdown. The renderer sanitizes, but if you connect to an agent you don't trust, that agent can craft messages that try to abuse the sanitizer. Don't connect to agents you don't trust.
