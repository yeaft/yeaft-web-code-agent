# Architecture

```
┌──────────────────────────────────────────┐
│          Server  (@yeaft/webchat-server)  │
│         Express + WebSocket Hub          │
│   - Agent/web client management          │
│   - Multi-layer authentication           │
│   - End-to-end encryption (TweetNaCl)    │
│   - Message routing & queue              │
│   - SQLite session persistence           │
└──────────────────┬───────────────────────┘
                   │ Encrypted WebSocket
        ┌──────────┴──────────┐
        │                     │
┌───────▼───────┐      ┌──────▼──────────┐
│    Agent      │      │   Web Client    │
│ @yeaft/       │      │    (web/)       │
│ webchat-agent │      │                 │
│               │      │ - Vue 3 + Pinia │
│ - Manages     │      │ - Split-screen  │
│   Claude CLI  │      │   multi-panel   │
│ - Crew multi- │      │ - E2E encrypted │
│   agent coord │      │ - Dark / light  │
│ - Terminal    │      │ - en / zh-CN    │
│ - Git / Files │      │ - File upload   │
└───────────────┘      └─────────────────┘
```

## Project Structure

```
claude-web-chat/
├── server/              # Central WebSocket hub (Express + ws)
│   ├── index.js         # Entry point
│   ├── handlers/        # Message handlers (agent↔client routing)
│   ├── api.js           # REST endpoints (auth, sessions, users)
│   ├── proxy.js         # Port proxy forwarding
│   ├── database.js      # SQLite storage
│   └── auth.js          # JWT + TOTP + email verification
├── agent/               # Worker machine agent
│   ├── cli.js           # CLI entry point (yeaft-agent command)
│   ├── index.js         # Agent startup & capability detection
│   ├── connection/      # WebSocket connection, auth & message routing
│   ├── claude.js        # Claude CLI process management
│   ├── conversation.js  # Session lifecycle & slash commands
│   ├── crew/            # Multi-agent Crew coordination (13 modules)
│   ├── sdk/             # Claude CLI stream-json SDK
│   ├── terminal.js      # PTY terminal (node-pty)
│   └── workbench/       # Git + file operations
├── web/                 # Vue 3 frontend
│   ├── app.js           # Vue app entry
│   ├── build.js         # Production build (esbuild)
│   ├── components/      # Vue components (25 top-level + crew/ sub-dir)
│   ├── stores/          # Pinia stores + helpers
│   ├── styles/          # CSS (23 stylesheets, dark/light theme)
│   ├── i18n/            # Translations (en, zh-CN)
│   └── vendor/          # Third-party libs (local, no CDN)
├── test/                # Vitest unit & integration tests (68 files, 2700+ tests)
├── e2e/                 # Playwright end-to-end tests
├── docs/                # VitePress documentation site
├── Dockerfile           # Multi-stage production build
└── LICENSE              # MIT
```

## CI/CD

GitHub Actions workflows included:

- **CI** (`ci.yml`): Tests on Node 18/20/22 + frontend build (manual trigger via `workflow_dispatch`)
- **Release** (`release.yml`): On tag `release-*` — runs tests, publishes `@yeaft/webchat-agent` to npm, builds Docker image to GHCR, creates GitHub Release
