# What is Yeaft?

**Yeaft Web Code Agent** is a web-based, multi-provider code agent platform. It gives you one browser UI for Claude Code CLI, GitHub Copilot CLI, and Yeaft's native Code Agent engine, while execution stays on your connected Agent machines.

![Screenshot](/images/hero.jpg)

## Three Code Agent Paths, Each Has Its Strengths

Yeaft doesn't lock you to a single AI backend. When you start a new session you pick:

| Backend | Best for | Details |
| --- | --- | --- |
| **Claude Code** | 1:1 chat with the full Claude toolset | [Chat Mode](./user/chat-mode.md) |
| **Copilot** | Same 1:1 shape but via GitHub Copilot CLI (ACP), pick any Claude / GPT model | [Copilot Mode](./user/copilot-mode.md) |
| **Yeaft Code Agent** | Native multi-provider code agent, 1..N VPs, parallel fan-out, persistent memory, 30+ tools | [Yeaft Code Agent](./user/yeaft-group.md) |

Not sure which? See [Choose a Code Agent Path](./user/choose-backend.md).

## Core Capabilities

### 💬 Multi-mode chat
- ChatGPT-style UI, streaming output
- Live tool execution visualization (Read / Edit / Bash / WebFetch, etc.)
- Slash commands + autocomplete
- Drag-drop file / image attachments
- Bilingual UI (English / 中文) + dark / light theme

![Chat](/images/chat.jpg)

### 👥 Yeaft Code Agent
- Create a Session with one focused VP or many VPs (Virtual Persons with independent persona / model / tools)
- `@mention` decides which VPs handle the message — parallel fan-out
- Cross-session persistent memory (H2-AMS) — VPs remember project decisions and preferences
- Multi-provider routing across Anthropic, OpenAI Responses, GitHub Copilot dynamic credentials, and compatible gateways
- Explicit VP→VP handoff (`route_forward` tool) plus sub-agent orchestration

### 🧠 Expert Panel
AI expert teams in a side panel that assist your main conversation.
- Multiple pre-built expert teams
- Chip-style team switcher
- Runs alongside main chat without interrupting


### 🖥️ Split Screen + Workbench
- **Split screen**: up to 3 panels showing different sessions at once
- **Workbench**: terminal / Git / files / port proxy, all in one

![Workbench](/images/workbench.jpg)

### 📊 Admin Dashboard
User activity / agent status / traffic stats.

![Dashboard](/images/dashboard.jpg)

## Prerequisites

- **Server**: Node.js >= 22.5, Docker recommended for production
- **Agent**: Node.js >= 22.5, plus:
  - [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (required for Claude Chat mode)
  - [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli) (optional, required for Copilot mode)
  - Yeaft engine is bundled in the npm package — **no extra CLI needed**
- **Web Client**: Modern browser (Chrome / Firefox / Safari / Edge)

## Tech Stack

- **Server**: Node.js, Express, ws, node:sqlite, compression
- **Frontend**: Vue 3, Pinia, xterm.js, CodeMirror 5, marked, highlight.js
- **Build**: esbuild
- **Testing**: Vitest (2,700+ unit/integration tests), Playwright (E2E)
- **Encryption**: TweetNaCl (XSalsa20-Poly1305)
- **Auth**: JWT, bcrypt, speakeasy (TOTP), nodemailer
- **Docs**: VitePress
- **Deploy**: Docker multi-stage build

## What's Next

- Never installed → [Getting Started](./getting-started.md)
- Picking a backend → [Choose a Code Agent Path](./user/choose-backend.md)
- Understanding the architecture → [Architecture Overview](./tech/architecture.md)
