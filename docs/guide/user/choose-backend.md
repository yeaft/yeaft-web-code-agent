# Choose a Session Backend

Yeaft puts three AI backends side-by-side in the same Web UI — you pick one per task. They're **not mutually exclusive**: a single Agent can run Claude Code sessions, Copilot sessions and Yeaft Groups in parallel without interfering with each other.

| Backend | Good for | Not ideal for |
| --- | --- | --- |
| **Claude Code Chat** | Long project collaboration, deep code understanding, requires `/skills` and MCP tools | No Claude Code CLI installed; budget-tight workflows |
| **Copilot Mode** | Existing GitHub Copilot subscription, want to swap between GPT-5 / Gemini / Claude on demand, standardized ACP protocol | Need `/compact`; depend on Claude-only skill system |
| **Yeaft Group Mode** | Multi-role parallel discussion, cross-task persistent memory, custom VPs (persona + model + tools) | Single-thread 1:1 chat (Group Mode is for groups, not 1:1) |

## Core differences

### Claude Code Chat (1:1 chat backed by Claude Code CLI)

- Each session = one Claude Code CLI subprocess
- Full Claude Code stack: skills, MCP, subagents, `/compact`, `/clear`, `/btw`
- Tool calls go through Claude Code's own stream-json protocol
- Session history lives in `~/.claude/projects/` and can be resumed

### Copilot Mode (1:1 chat backed by GitHub Copilot CLI)

- Each session = one `copilot --acp` subprocess, talks ACP (Agent Client Protocol)
- Multiple models available (Claude Sonnet 4.x / Claude Opus 4.x / GPT-5.x / Gemini 2.5 Pro etc.), gated by your Copilot subscription
- Tool permissions confirmed **per call via ask-user popup** (you can toggle "Allow all tools" to skip)
- Session history lives in `~/.copilot/session-store.db` and can be resumed

### Yeaft Group Mode (multi-VP group collaboration on the in-house engine)

- No external CLI dependency — Yeaft ships its own query loop, memory and tools
- A group hosts multiple **VPs (Virtual Persons)** — each VP has its own persona, model and toolset
- A single user message **fan-outs in parallel** to multiple VPs, each replies independently
- **H2-AMS persistent memory** — keeps VP / group / user / feature scope across sessions
- Multi-provider LLM: configure OpenAI / Anthropic / GitHub Copilot in any combination via `~/.yeaft/config.json`

## How to pick in the UI

### Chat / Crew Mode (Claude Code or Copilot)

Sidebar `+` opens the session config modal:

1. Pick **Agent** (machine)
2. Pick **Provider**: `Claude Code` or `Copilot`
3. Pick **Working directory**
4. If Copilot, a **model picker** and **Allow all tools** checkbox appear

### Yeaft Group Mode

Sidebar tab bar at the top → switch to **Yeaft**, then use `+` to create a group:

1. Enter group name
2. Add VPs (each picks model, optional persona, optional tool whitelist)
3. Send a user message to the group; the VPs reply **in parallel**

## Which one should I use?

- **Write code daily + already using Claude Code** → Claude Code Chat
- **Want it cheaper / want GPT-5 / company has Copilot Enterprise** → Copilot Mode
- **Want "PM + Dev + Reviewer" to discuss a feature with you simultaneously** → Crew Mode (on top of Claude Code)
- **Want multiple VPs to remember you long-term / continue memory across tasks / mix OpenAI + Anthropic freely** → Yeaft Group Mode

Next:

- [Claude Code Chat](./chat-mode.md)
- [Copilot Mode](./copilot-mode.md)
- [Yeaft Group Mode](./yeaft-group.md)
