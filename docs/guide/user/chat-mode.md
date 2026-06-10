# Claude Code Chat Mode

Claude Code Chat is the original Yeaft session backend — it wraps a local Claude Code CLI process in a Web chat surface, giving you the full Claude Code feature set (skills, MCP, subagents, `/compact`, `/clear`) without losing the underlying stream-json protocol.

> This is the **1:1 chat mode powered by Claude Code CLI**. To swap Claude for GitHub Copilot CLI, see [Copilot Mode](./copilot-mode.md). For multi-VP parallel + cross-task memory, see [Yeaft Group Mode](./yeaft-group.md).

## Prerequisites

1. **Claude Code CLI installed**: `claude --version` works on the Agent machine
2. **Logged in**: `claude auth login` has been run on the Agent machine (or `ANTHROPIC_API_KEY` is set)
3. **Agent online**: the sidebar shows at least one online Agent

## Create a session

Two ways:

1. **Welcome page** — when no session is selected the main area shows "New session" (only when an Agent is online)
2. **Sidebar** — the **+** icon next to "Recent chats"

In the modal:
- **Agent** — which machine runs it
- **Provider** — pick **Claude Code** (default)
- **Working directory** — project path (affects `cd`, `.claude/` lookup)
- **Model** (optional) — Claude defaults to whatever `claude config` says; override here if needed

## Sending messages

- Type in the bottom input box
- **Enter** sends, **Shift+Enter** newline
- The send button turns into a **stop** button mid-execution — interrupt any time
- **Draft auto-save** — switching sessions doesn't lose your draft

## File / image attachments

- Click the **📎 paperclip** next to the input, or drag a file / screenshot in
- **Paste images**: Ctrl+V / Cmd+V
- Supported types: image/* , text, PDF, Word (doc/docx), Excel (xls/xlsx), JSON, Markdown, Python, JS, TS, CSS, HTML
- Thumbnails preview before sending; after sending they collapse into a "📎 2 images, 1 file" tag

## Slash commands

Typing `/` opens an auto-complete menu:

| Command | What it does |
| --- | --- |
| `/compact` | Compact the session context — fewer tokens, key points kept |
| `/clear` | Wipe all messages, reset context |
| `/context` | Show the current context-usage breakdown |
| `/cost` | Token usage and cost |
| `/init` | Initialize the project (generate `CLAUDE.md`) |
| `/doctor` | Run diagnostics |
| `/memory` | Manage Claude's project memory |
| `/model` | Switch model |
| `/review` | Code review |
| `/mcp` | MCP server management |
| `/skills` | List loaded skills |
| `/btw` | Side-question without interrupting the current task |

Arrow keys navigate, **Tab** / **Enter** selects.

## Compact vs Clear

Two buttons on the right side of the chat header:

### Compact (↕)
- **What**: invokes Claude Code's `/compact`, replacing history with a concise summary
- **When**: context above 50% and you want to **keep this conversation going**
- **Effect**: history messages remain visible in the UI, but the next request to Claude carries the compressed context
- Input is disabled during compact; status bar shows "Compacting..."

### Clear (🗑)
- **What**: invokes `/clear`, deletes all messages in this session
- **When**: you want a fresh start in the same session shell
- **Confirmation**: a confirm dialog prevents misclicks

## Session resume

If the server restarts or the connection drops, sessions can resume:

- Click the **↻ refresh button** in the chat header to re-sync the last 5 turns from the Agent
- Agents store sessions at `~/.claude/projects/<hash>/sessions/<sessionId>.jsonl`
- The same sessionId resumes across restarts as long as the jsonl file is intact

## Context usage indicator

The percent badge top-right of the chat header tells you how much of the context window is used:

- 🟢 **Green** (0–49%): healthy
- 🟡 **Yellow** (50–79%): consider compacting soon
- 🔴 **Red** (80%+): nearly full, compact or clear now

Hover for the precise number (`Context: 45k / 200k`).

## Assistant reply rendering

Each reply renders as a **Turn** card:

- **Markdown** — syntax-highlighted code blocks
- **Copy** — per-reply and per-code-block copy buttons
- **Tool calls** — Read / Edit / Bash etc. visualized; latest stays expanded
- **Todo progress** — TodoWrite calls render as a checklist (✓ / ⏳ / ◯)
- **AskUserQuestion** — Claude-initiated questions become interactive cards (single/multi-select / freeform / submit)
- **Sub-Agent nesting** — Agent tool's sub-agents are inspectable

## Differences vs Copilot / Yeaft Group

| Capability | Claude Code | Copilot | Yeaft Group |
| --- | :---: | :---: | :---: |
| `/compact` auto-compress | ✓ | — | ✓ (H2-AMS) |
| `/clear` reset | ✓ | ✓ | ✓ |
| Model picker | ✓ | ✓ | ✓ (per VP) |
| MCP tools | ✓ | ✓ | ✓ |
| Image / file attachments | ✓ | ✓ | ✓ |
| AskUser permission popup | ✓ | ✓ | ✓ |
| Subagent nested monitor | ✓ | — | ✓ |
| Expert Panel | ✓ | — | — |
| Cross-task persistent memory | — | — | ✓ |
| Multi-VP parallel reply | — | — | ✓ |

## Troubleshooting

**Agent shows online but can't create sessions**
- Confirm `claude --version` works on the Agent machine
- Check Agent logs: `yeaft-agent logs`
- Usually Claude CLI isn't installed or logged in

**Claude keeps "thinking" forever**
- Could be a Claude API timeout; hit stop, resend
- Look at server and agent logs for stack traces

**`/skills` doesn't show my skill**
- Skills are a Claude Code feature, living in `~/.claude/skills/` or project `.claude/skills/`
- Confirm `claude /skills` shows it on the Agent machine first
