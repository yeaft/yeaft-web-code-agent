# Getting Started

Yeaft has two components:

1. **Server** — central hub (Express + WebSocket), runs once per deployment.
2. **Agent** — runs on each machine you want to drive (your laptop, a VPS, a sandbox container). The Yeaft engine for Group Mode is **bundled** in the agent; the Claude / Copilot CLIs are **optional** depending on which backends you want.

## Option A: npm (Agent only)

If you already have a server running, just install the agent:

```bash
# Install the agent globally
npm install -g @yeaft/webchat-agent

# Connect to a server
yeaft-agent --server wss://your-server.com --name my-worker --secret your-secret

# Upgrade to latest
yeaft-agent upgrade
```

The Yeaft engine starts working out of the box once you create `~/.yeaft/config.json` with at least one LLM provider (see [Yeaft Engine Config](./yeaft-config.md)). For Claude Code / Copilot chat modes, install the corresponding CLI on the agent machine and authenticate — the agent will auto-detect them at startup. See [Agent Setup](./deploy-agent.md) for the full table.

## Option B: Full development setup

```bash
git clone https://github.com/yeaft/claude-web-chat.git
cd claude-web-chat

# Install all dependencies
npm install

# Start server + agent in dev mode (no auth)
npm run dev
```

Then open `http://localhost:3456` in your browser.

## Next Steps

- [Choose a Session Backend](./user/choose-backend.md) — Claude Code vs Copilot vs Yeaft Group
- [Deploy the Server (Docker)](./deploy-server.md) — Production deployment guide
- [Set up an Agent](./deploy-agent.md) — Connect a worker machine
- [Yeaft Engine Config](./yeaft-config.md) — `~/.yeaft/config.json` schema
- [Chat (Claude Code)](./user/chat-mode.md) — Start using the chat interface
- [Yeaft Group Mode](./user/yeaft-group.md) — Multi-VP collaboration
