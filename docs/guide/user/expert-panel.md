# Expert Panel

Expert Panel (in zh-CN UI: **帮帮团**) is a **side helper panel** in Claude Code Chat mode — while you're talking to Claude in the main chat, you can open one or more "expert teams" simultaneously to get perspectives from a different angle, without breaking your main conversation.

> Only available in **Claude Code Chat** mode. Copilot and Yeaft Sessions don't have Expert Panel yet — for Yeaft Sessions, multi-VP parallel is the (stronger) equivalent.

## Open the Expert Panel

The chat header has a **💡 Expert Panel** button (or a corresponding sidebar entry). Click to open the **side panel** on the right of the main chat:

- Top chip-tabs switch between teams (Writing / Trading / Startup / Custom etc.)
- Middle: the selected team's multi-perspective replies, rendered as per-role cards
- Bottom input: send a message directly to the currently selected team

## Team templates

A few built-in teams (your Agent's config may vary):

| Team | Roles (example) |
| --- | --- |
| **Writing Team** | Editor, Copywriter, Reader Proxy, Marketing |
| **Trading Team** | Quant Strategist, Risk, Macro, Technicals |
| **Startup Team** | PM, CTO, CMO, User Research |
| **Code Review** | Architect, Security, Performance, Test |
| **Custom** | Roles you define |

Each team is a set of personas + an independent conversation context, all calling the same Claude API.

## How it works

1. You ask Claude something in the main chat (e.g. "Could my plan be tweaked this way?")
2. Drop a simplified version of the question into the Expert Panel input (or copy-paste from the main chat)
3. Pick a team (e.g. **Code Review**)
4. The team's N roles reply **in parallel** (each role gets its own turn)
5. After reading all the opinions, return to the main chat with Claude to continue

## Relationship to the main chat

- Expert Panel **doesn't affect** the main chat's context — it's an independent conversation with its own token counter
- Use it for "I want to sanity-check this" / "I want to look from another angle"
- Main chat = execution; Expert Panel = judgment

## Team management

- **Switch team** — chip-tab, one click
- **Clear** — each team has a "🗑 Clear" button to reset
- **Close panel** — click the 💡 button in the header again, or the panel's ×

## Comparison with Yeaft Sessions

- **Expert Panel** is a helper panel for Claude Code Chat; all roles call the same Claude API; the session lasts only this window
- **Yeaft Sessions** elevates multi-role to the main interaction model; each VP picks its own provider/model and has persistent cross-task memory

For "quick multi-perspective sanity check on a single question" — use Expert Panel.
For "long-term multi-role group with persistent memory across tasks" — use Yeaft Sessions.

## Troubleshooting

**Expert Panel button greyed out / missing**
- The current session's provider isn't Claude Code (Copilot doesn't have this capability)
- The Agent capability flag `expert` is missing — upgrade the Agent

**Team replies stay empty**
- The team config has no roles — open settings and add roles
- Or Claude API throttling / out of budget — check Agent logs
