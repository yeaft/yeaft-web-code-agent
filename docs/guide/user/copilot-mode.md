# Copilot Mode

Copilot Mode uses the GitHub Copilot CLI as an AI backend, sitting alongside Claude Code Chat in the same Web UI. If you already have a GitHub Copilot subscription, it's the easiest way to switch between GPT-5 / Claude Sonnet 4.x / Gemini 2.5 Pro and other vendor models from one chat surface.

## Prerequisites

1. **GitHub Copilot CLI installed and logged in** on the Agent machine:
   ```bash
   # Install (see GitHub's official docs)
   gh extension install github/gh-copilot
   # Or the standalone CLI (recommended): npm install -g @github/copilot

   # Log in
   copilot login
   ```
   After login, `copilot --version` must return **>= 1.0.59** (ACP protocol dependency).
2. **Optional environment variables**:
   - `COPILOT_BIN` — explicit path to the `copilot` executable (default: search `$PATH`)
   - `COPILOT_YOLO=1` — auto-approve all tool calls globally (**not recommended**; prefer per-session "Allow all tools")

> The Yeaft Web tier does **not** install or download the Copilot CLI for you — it's a user-tier tool, follow GitHub's official install flow.

## Create a Copilot session

1. Sidebar → **+** new session
2. In the session modal:
   - **Agent** — which machine to run on
   - **Provider** — drop-down → **Copilot**
   - **Working directory** — project path
   - **Model** — pick from the list Copilot provides (see below)
   - **Allow all tools** (optional) — auto-approve every tool call, no popups

## Model picker

The Copilot model list is **fetched dynamically** — on first `copilot --acp` startup, Yeaft scrapes the real available list (with vendor, pricing class and preview flags) from the ACP `session/new` response. Subject to your Copilot subscription, common models include:

| Vendor | Typical models |
| --- | --- |
| Anthropic | Claude Sonnet 4.6 / 4.5, Claude Haiku 4.5, Claude Opus 4.5–4.8 |
| OpenAI | GPT-5.5 / 5.4 / 5.4-mini, GPT-5.3 Codex, GPT-5 Mini |
| Google | Gemini 2.5 Pro |

> **Model can't change mid-session.** The ACP protocol currently doesn't allow hot model switching — open a new session to change model.

## Differences vs Claude Code Chat

| Capability | Claude Code | Copilot |
| --- | :---: | :---: |
| `/compact` auto-compress | ✓ | — |
| `/clear` reset | ✓ | ✓ |
| Model picker | ✓ | ✓ |
| MCP tools | ✓ | ✓ |
| Image / file attachments | ✓ | ✓ |
| AskUser permission popup | ✓ | ✓ |
| Subagent nested monitor | ✓ | — |
| Expert Panel | ✓ | — |
| Session history resume | ✓ | ✓ (via `~/.copilot/session-store.db`) |

The UI hides unsupported buttons based on the provider's capability flags — buttons you don't see simply aren't supported, not a bug.

## Tool permissions: the ask-user popup

By default (Allow all tools not checked), Copilot pops up a confirmation every time it wants to run bash, write files, etc.:

> Copilot wants to run `bash`. Allow?

Buttons are usually "Allow once" / "Allow always" / "Reject", with the exact options coming from the Copilot backend. Your choice goes back to the Copilot subprocess via ACP's `session/request_permission` flow.

**Best practice:**
- Exploratory sessions — leave default, confirm each call
- Long tasks (batch refactor, running a test suite) — toggle Allow all tools when creating the session to skip popups

## Session history

Copilot stores sessions in `~/.copilot/session-store.db` (SQLite). Yeaft will:

- List prior sessions for the working directory in the new-session modal — click to resume
- Use ACP's `session/load` for resume (when the Copilot CLI supports it); fall back to a fresh session otherwise
- Convert `forge_trajectory_events` rows into the `claude_output` protocol envelope so the front-end reuses the same renderer pipeline

> **Environment variable**: `COPILOT_DB_PATH` overrides the default DB path (handy for multi-account or custom storage).

## Troubleshooting

**"copilot ACP init failed: ... Run `copilot login` and ensure CLI >= 1.0.59"**
- Run `copilot --version` on the Agent machine; require >= 1.0.59
- Run `copilot login` to complete the GitHub OAuth flow
- If `copilot` isn't on `$PATH`, set `COPILOT_BIN=/full/path/to/copilot`

**The model picker is empty / only shows static fallback list**
- Create one Copilot session — first connection caches the real list
- Static fallback lives in `agent/providers/copilot-models.js` as `FALLBACK_COPILOT_MODELS`

**"Copilot CLI does not advertise loadSession capability — starting a new session instead of resuming"**
- Copilot CLI is too old to resume sessions; upgrade to the latest

**Ask-user popup appears and the page hangs**
- The Copilot subprocess may have crashed; Yeaft auto-drains pending popups, refresh and you should be fine
- Check Agent logs: `yeaft-agent logs`

## Advanced: don't confuse this with the Yeaft engine's `github-copilot` credential

There are two distinct "Copilots" — keep them separate:

- **Copilot Mode (this chapter)** — Agent spawns a `copilot --acp` subprocess; the **subprocess** is the AI backend, model selection lives inside the Copilot CLI
- **Yeaft engine's `github-copilot` credential provider** — used by Yeaft Code Agent; Yeaft grabs the GitHub OAuth token itself and calls the Copilot API directly, **no** `copilot --acp` subprocess

Both authenticate against the same GitHub account, but they take different code paths. The first is for "I want Copilot CLI as a Claude replacement"; the second is for "I want a VP inside Yeaft Code Agent to use Copilot-provided models".
