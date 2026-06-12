# Yeaft Sessions

A **Yeaft session** is the dominant usage pattern of the Yeaft in-house AI engine today — a session hosts multiple VPs (Virtual Persons, customizable persona / model / tool bundles), one user message can **fan out in parallel** to many VPs, each VP replies independently, and all share a **persistent memory** that crosses sessions.

> Yeaft also plans a **single-VP chat mode** (1:1 with a single VP), but it's **not yet implemented**. This chapter covers the current multi-VP session experience.

## What sets it apart from Claude Code Chat / Copilot

- **No external CLI dependency** — Yeaft runs its own query loop (`agent/yeaft/engine.js`) with a built-in toolset
- **Multi-VP parallel** — get opinions from PM, Dev and Reviewer simultaneously, no session-switching
- **Cross-session memory** — the H2-AMS memory subsystem persists by scope (user / vp / group / feature / global), so VPs remember you across sessions
- **Multi-provider** — different VPs in the same session can use different models (one Claude, one GPT-5, one Copilot)

## Enter the Yeaft page

Click the **Yeaft** tab at the top of the sidebar tab bar. On first entry, Yeaft handshakes with its bound Agent and establishes a **virtual conversationId** (it doesn't occupy a Claude Chat / Copilot session slot).

> One Agent can run Claude Code sessions, Copilot sessions and Yeaft simultaneously — they don't interfere with each other.

## Create a session

1. Yeaft page → sidebar **+ New session**
2. **Name** — e.g. "Weekly report review", "Refactor discussion"
3. **Pick VPs** — tick the VPs you want in this session. VPs are managed in the VP Library (each one has its own persona / model / tool config; see VP setup notes below).
4. **Default VP** — the VP that answers when no one is `@`-mentioned
5. **Create**

> VPs themselves are reusable across sessions — you build them once in the VP Library, then mix and match them per session.

## Talk to the session

Inside a session, the input box looks like Chat mode. The differences:

- **@mention selects VPs**: `@PM @Reviewer take a look at this report`
  - Without `@`, the default VP handles the turn
  - With `@`, only the mentioned VPs receive it (parallel fan-out)
- **VPs reply in parallel** — each mentioned VP runs the query loop in its own turn; completion times differ; the UI groups replies by VP
- **Attachments** are supported — drag/paste like in Chat

## What the memory system does

Yeaft has a background memory subsystem called **H2-AMS** (AMS + SQLite FTS pre-flow — see the engine's `memory/DESIGN-H2-AMS.md` for the long form). It works in three loops:

1. **Pre-turn**: Yeaft runs FTS5 full-text recall over relevant scopes and injects the hits into the system prompt
2. **Post-turn** (max once per session per session-id): an LLM adjusts the Active Memory Set
3. **Background dream maintenance**: chops conversation history into atomic memory segments and stores them as markdown files in the relevant scope

What you see:
- VPs remember things you told them last time (across multiple sessions)
- VPs in a session share session-scoped memory, but each VP also has its own vp-scoped private memory
- Your profile / preferences live in user scope and are read by every VP in every session during pre-flow

> Memories live on the Agent machine at `~/.yeaft/memory/<scope>/memory.md` — plain markdown files you can read, back up, or migrate.

## Debug panel

The Yeaft page has a **Debug panel** (icon at the bottom of the sidebar) showing:

- Turn history per VP for the current session
- For each turn: recalled memory segments, messages sent to the LLM, tool_calls received, final reply
- Token / cost stats
- LLM provider / model routing result

Good for:
- Wondering why a VP replied a certain way — look at what memory it recalled
- Optimizing memory — see which segments hit, which missed
- Debugging a new tool — see tool_call inputs / outputs

## Tools

The Yeaft engine ships 40+ built-in tools, grouped by category:

- **Files**: file_read / file_write / file_edit / apply_patch / notebook_edit
- **Search**: grep / glob / list_dir / history_search
- **Execution**: bash / js_repl / enter_worktree / exit_worktree
- **Network**: web_fetch / web_search / image_generation / view_image
- **Orchestration**: agent (spawn a sub-Agent) / send_message / wait_agent / close_agent / list_agents / route_forward (explicit VP→VP handoff)
- **Tasks**: todo_write / start_plan
- **External**: ask_user / skill / mcp_tools

Whether a VP can call a given tool is determined by per-VP tool config + the tool registry's mode filter.

## Common usage patterns

### Pattern A — Decision review

Create a session with 3–4 VPs of different personas (e.g. PM-Jobs + Dev-Torvalds + Architect-Fowler + Designer-Rams), drop your proposal in, let them **opine in parallel**. Much more efficient than switching personas one at a time.

### Pattern B — Long-project assistant

Create a session with one default VP and treat it as your project's "personal assistant". Yeaft's memory lets it gradually learn your codebase, style preferences and decision history.

### Pattern C — Cross-VP handoff

Use the `route_forward` tool to make VPs explicitly hand off — the PM VP breaks down the requirement and hands it to the Dev VP, the Dev VP finishes the code and hands the PR to the Reviewer VP.

## Difference vs Crew Mode

- **Crew** runs on top of Claude Code (each role is a Claude CLI process); full Claude Code capability but only one model
- **Yeaft Sessions** run on top of the Yeaft engine; each VP picks its own provider/model, with persistent memory built in, but the toolset differs from Claude Code

If your need is "multi-AI roles collaborating on a concrete feature", both work. Pick **Yeaft Sessions** for "cross-session persistent memory + freely mixed providers"; pick **Crew** for "full Claude Code skill / MCP ecosystem + standard dev pipeline".

## Going deeper

- Configure custom providers / models: see [Yeaft Engine Config](../yeaft-config.md)
- How the engine works: see [Yeaft Engine](../tech/yeaft-engine.md)
- Memory system design: see [Yeaft Memory (H2-AMS)](../tech/yeaft-memory.md)
- LLM routing / multi-provider: see [Yeaft LLM Layer](../tech/yeaft-llm.md)
