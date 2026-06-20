# Choose a Code Agent Path

Yeaft Web Code Agent puts three execution paths side-by-side in the same Web UI. They are **not mutually exclusive**: a single connected Agent can run Claude Code sessions, Copilot sessions, and native Yeaft Sessions in parallel.

| Path | Good for | Not ideal for |
| --- | --- | --- |
| **Claude Code Chat** | Long project collaboration, deep code understanding, Claude Code `/skills` and MCP tools | No Claude Code CLI installed; workflows that must avoid vendor CLI dependency |
| **Copilot Mode** | Existing GitHub Copilot subscription, GPT/Claude/Gemini switching through ACP, per-call permission prompts | Need `/compact`; depend on Claude-only skill behavior |
| **Yeaft Code Agent** | Native multi-provider coding, 1..N VPs, persistent memory, custom tool policy, provider mixing | Workflows that require exact Claude Code CLI behavior |

## Core differences

### Claude Code Chat

- Each chat session is one Claude Code CLI subprocess.
- Full Claude Code stack: skills, MCP, subagents, `/compact`, `/clear`, `/btw`.
- Tool calls go through Claude Code's stream-json protocol.
- Session history lives in `~/.claude/projects/` and can be resumed.

### Copilot Mode

- Each chat session is one `copilot --acp` subprocess.
- Model availability follows your GitHub Copilot entitlement.
- Tool permissions are confirmed per call via ask-user popup; the UI can also enable "Allow all tools".
- Session history lives in `~/.copilot/session-store.db` and can be resumed.

### Yeaft Code Agent

- No external CLI dependency. The native engine, memory, tools, and LLM router ship inside `yeaft-agent`.
- A Session can host one or many **VPs (Virtual Persons)**. Each VP has its own persona, model, memory, and tool allowlist.
- One user message can fan out in parallel to several VPs.
- **H2-AMS persistent memory** keeps user / VP / Session / feature scopes across tasks.
- Multi-provider LLM routing supports Anthropic, OpenAI Responses, GitHub Copilot dynamic credentials, Azure/OpenAI-compatible gateways, and local proxies through `~/.yeaft/config.json`.

## How to pick in the UI

### Claude Code Chat or Copilot Mode

Sidebar `+` opens the session config modal:

1. Pick **Agent** (machine).
2. Pick **Provider**: `Claude Code` or `Copilot`.
3. Pick **Working directory**.
4. If Copilot is selected, model and permission options appear.

### Yeaft Code Agent

Switch the sidebar tab bar to **Yeaft**, then use `+` to create a Session:

1. Enter a Session name.
2. Pick reusable VPs from the roster.
3. Choose the default VP.
4. Send a message; use `@VPName` to address a subset.

## Which one should I use?

- **Already use Claude Code daily and need exact Claude behavior** → Claude Code Chat.
- **Have Copilot Enterprise or want ACP permission prompts / Copilot model catalog** → Copilot Mode.
- **Want PM + Dev + Reviewer to reason in parallel with long-term memory** → Yeaft Code Agent.
- **Want to compare Anthropic, OpenAI, Copilot, or a proxy on the same task** → Yeaft Code Agent with multiple VPs.
- **Want a structured Claude Code based feature team** → Crew Mode.

Next:

- [Claude Code Chat](./chat-mode.md)
- [Copilot Mode](./copilot-mode.md)
- [Yeaft Code Agent](./yeaft-group.md)
