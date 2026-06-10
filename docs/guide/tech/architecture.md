# Architecture Overview

Yeaft is a **three-layer architecture** multi-provider AI collaboration platform:

```
┌────────────────────────────────────────────────────────────────┐
│                       Web Client (Vue 3)                        │
│   ChatPage  /  YeaftPage  /  Crew / Workbench / Settings        │
│             Shared MessageList pipeline (backend-agnostic)      │
└──────────────────────────────┬─────────────────────────────────┘
                               │ WebSocket (encrypted)
                               ↓
┌────────────────────────────────────────────────────────────────┐
│                     Server (Express + ws)                       │
│  - Dumb relay: routes by conversationId / agentId               │
│  - Auth (JWT + TOTP + email)                                    │
│  - End-to-end encryption (TweetNaCl)                            │
│  - SQLite session / user / invite codes                         │
└──────────────────────────────┬─────────────────────────────────┘
                               │ WebSocket (encrypted)
                               ↓
┌────────────────────────────────────────────────────────────────┐
│                          Agent (Node.js)                        │
│  ┌─────────────────────┐  ┌──────────────────────────────────┐ │
│  │  Provider abstraction │  │  Yeaft engine (standalone AI)    │ │
│  │  ─ claude-code        │  │  ─ engine.js query loop          │ │
│  │  ─ copilot (ACP)      │  │  ─ H2-AMS memory                 │ │
│  │                       │  │  ─ multi-provider LLM router     │ │
│  │  spawn external CLI    │  │  ─ 40+ tools                     │ │
│  └─────────────────────┘  └──────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │  Crew multi-role subsystem (own wire type, cross-worktree) │  │
│  └─────────────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │  Workbench: terminal / git / files / port-proxy           │  │
│  └─────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

## Key Layers

### Provider Abstraction (`agent/providers/`)
- Interface `ChatProvider` (`base.js`) — `start / sendInput / abort / listSessions / loadHistory`
- Two implementations: `claude-code` (spawns Claude CLI), `copilot` (spawns `copilot --acp`)
- All providers **translate their output** to the same `claude_output` envelope — frontend has zero branching
- Details: [Provider System](./providers.md)

### Yeaft Engine (`agent/yeaft/`)
- Self-contained AI orchestrator — does **not** depend on any external CLI
- Own query loop, memory system (H2-AMS), multi-provider LLM router, tool system
- Pushes messages via the `yeaft_output` wire type (payload shaped like claude_output for rendering reuse)
- Details: [Yeaft Engine](./yeaft-engine.md)

### Wire Protocol
- WebSocket envelope uses `type` field to identify message kinds
- `claude_output` is a **protocol name**, not a vendor name — all chat output flows through it
- Details: [WebSocket Protocol](./wire-protocol.md)

## Project Structure

```
claude-web-chat/
├── server/                  # Central WebSocket hub
│   ├── index.js             # Entry point
│   ├── handlers/            # Message handlers (agent↔client routing)
│   ├── api.js               # REST endpoints (auth, sessions, users)
│   ├── proxy.js             # Port proxy forwarding
│   ├── database.js          # SQLite storage
│   └── auth.js              # JWT + TOTP + email verification
├── agent/                   # Worker machine agent
│   ├── cli.js               # CLI entry (yeaft-agent command)
│   ├── index.js             # Startup + capability detection
│   ├── connection/          # WebSocket connection, auth, message routing
│   ├── providers/           # Provider abstraction + claude-code/copilot impls
│   │   ├── base.js          # ChatProvider interface
│   │   ├── claude-code.js   # Claude CLI driver
│   │   ├── copilot.js       # Copilot CLI driver (ACP)
│   │   └── acp-client.js    # ACP JSON-RPC client
│   ├── yeaft/               # Yeaft's own engine
│   │   ├── engine.js        # Main query loop
│   │   ├── memory/          # H2-AMS memory
│   │   ├── llm/             # LLM adapters (anthropic / openai-responses)
│   │   ├── groups/          # Group Mode orchestration
│   │   ├── tools/           # 40+ built-in tools
│   │   └── ...
│   ├── claude.js            # Legacy Claude Chat path (kept)
│   ├── conversation.js      # Chat session lifecycle
│   ├── crew/                # Crew multi-role subsystem
│   ├── sdk/                 # Claude CLI stream-json SDK
│   ├── terminal.js          # PTY terminal (node-pty)
│   └── workbench/           # Git + file operations
├── web/                     # Vue 3 frontend
│   ├── app.js               # Vue app entry
│   ├── build.js             # esbuild production build
│   ├── components/          # Vue components (ChatPage / YeaftPage / Crew / Workbench)
│   ├── stores/              # Pinia state stores
│   ├── styles/              # CSS (dark / light theme)
│   ├── i18n/                # en / zh-CN translations
│   └── vendor/              # Third-party libs (local, no CDN)
├── test/                    # Vitest unit & integration tests
├── e2e/                     # Playwright E2E
├── docs/                    # VitePress site (this one)
├── Dockerfile               # Multi-stage production build
└── LICENSE                  # MIT
```

## Data Flow

### Claude Code / Copilot Mode
```
Web → ws "send_message" → Server → ws agent
  → provider.sendInput()
  → CLI subprocess
  → event stream (stream-json / ACP) → translated to claude_output envelope
  → ws "claude_output" → Server → ws Web → MessageList render
```

### Yeaft Group Mode
```
Web → ws "yeaft_group_chat" → Server → ws agent
  → coordinator.ingest() → Promise.all(runVpTurn × VPs)
  → Engine.query() → tool exec → LLM stream → events
  → web-bridge.js translates to claude_output envelope
  → ws "yeaft_output" → Server → ws Web → handleYeaftOutput → handleClaudeOutput → MessageList
```

## CI/CD

Built-in GitHub Actions:
- **CI** (`ci.yml`): Node 18/20/22 tests + frontend build (`workflow_dispatch` manual)
- **Release** (`release.yml`): push `release-*` tag → auto-publish npm package + Docker image + GitHub Release

## What's Next

- Want to add a new provider → [Provider System](./providers.md)
- Want to read the Yeaft engine → [Yeaft Engine](./yeaft-engine.md)
- Want the full wire-type list → [WebSocket Protocol](./wire-protocol.md)
