# Crew Collaboration

Crew Mode lets multiple Claude Code Agent roles (PM, Dev, Reviewer, Tester, Designer, etc.) work as a **team** — PM breaks down tasks, Dev writes code, Reviewer audits, Tester verifies. Roles route work to each other via the ROUTE protocol automatically.

> Crew is a multi-role mode built on **Claude Code CLI**. Each role = a separate Claude Code process running in its own worktree. So Crew requires the Agent machine to have Claude Code CLI installed, and every role consumes its own token budget.

## Create a Crew Session

1. Sidebar → **+** next to **Crew Sessions**
2. The Crew Session wizard opens:

### Step 1 — Pick an Agent
- The list shows **online** Agents with the `crew` capability only
- Crew is heavier than single chats (multiple roles + multiple worktrees) — pick a beefy machine

### Step 2 — Workspace
- Pick the project root (`.crew/` will be created here)
- If `.crew/` already exists you get the choice:
  - **Resume last session** — load `.crew/state.json`, all roles, kanban
  - **Delete & reset** — wipe and start fresh

### Step 3 — Configure team
- **Team name** (optional, ≤30 chars)
- **Team template** — pick a preset or start empty
- **Roles list** — add / remove / tune each role

### Step 4 — Launch
- Click **Launch**
- Status bar shows progress: "Preparing roles..." → "Setting up workspace..." → done

## Team templates

| Template | Description | Roles |
| --- | --- | --- |
| **Dev Team** | Software development | PM, Dev, Reviewer, Tester, Designer |
| **Writing Team** | Creative writing | Editor, Writer, Proofreader |
| **Trading Team** | Finance / trading | Strategist, Risk, Execution |
| **Short-video Team** | Video production | Scriptwriter, Editor, Producer |
| **Custom** | Empty template | No predefined roles |

Templates come in EN and zh-CN versions, picked based on UI language.

## Role configuration

Each role has:

| Field | Description |
| --- | --- |
| **Icon** | Emoji / short text (≤4 chars), shown as avatar |
| **Display name** | Name shown in UI |
| **Description** | One-line responsibility blurb |
| **Decider** | ★ star — exactly **one** decider per team, coordinates the others |
| **Custom prompt** | Advanced — extra `CLAUDE.md` instructions for this role |
| **Concurrency** | Dev / Reviewer / Tester can run 1–3 parallel instances |

**Add a role:**
- Click **Add role** to open the preset picker
- Presets: PM, Dev, Reviewer, Tester, Designer, Architect, Ops, Researcher
- Some roles bundle (adding Dev also adds Reviewer + Tester)
- Custom role — build from scratch

**Remove a role:**
- The **×** at the top-right of the role card
- Removing the decider auto-promotes the first remaining role

## Using a Crew

### Sending messages
- Type in the bottom input
- **@** mentions a specific role (`@pm break down this feature`)
  - The autocomplete menu shows available roles
  - **↑** / **↓** navigate, **Enter** select
- **Enter** sends, **Shift+Enter** newlines
- **No @** — routes to the decider, who dispatches to specific roles

### Message rendering
- Messages group by **Feature thread** (collapsible blocks)
- Each Feature thread shows:
  - Task title as header
  - Status: ⏳ active / ✓ done
  - Active role avatars
  - **View history** toggle for older messages
  - Latest message always visible
- **Global messages** (no feature binding) render outside Feature blocks
- **Round divider** marks new conversation rounds
- The **Latest** strip at the bottom shows the most recent message from any role

### Status bar
Above the input:
- **Round number** (R0, R1, R2...)
- **Cost** (USD)
- **Total tokens**

## Feature & task management

The **Feature panel** (right column) is a kanban-style task board.

### Overall progress
Progress bar at the top: "3 / 5 — 60%"

### In Progress
One card per active feature / task:
- Task title
- Progress bar
- Active role avatars
- Time since creation
- Expandable todo list
- Click the card title to expand / collapse
- Double-click the card to jump to the feature in the message stream

### Completed
Collapsed by default — click the header to expand; shows finished features with final progress and total time.

## Panel layout

### Desktop (>768px)
- **Three columns**: Roles (left) | Messages (middle) | Features (right)
- Both side panels toggle via header buttons (👤 = Roles, 📊 = Features)
- Hiding side panels expands the message area

### Mobile (≤768px)
- **Single column** — message area only by default
- Header **Roles** / **Features** buttons open drawer panels
- Tap the dark scrim or the drawer's **Close** button to dismiss

## Session controls

### Roles panel footer
- **+ Add role** — add to a running session
- **× Clear session** — wipe all messages + reset (with confirmation)
- **⏹ Stop all** — terminate all role processes

### Per-role card
- **⏹ Abort** — stop this role's current task (only shown when active)
- **🗑 Clear** — wipe this role's chat history

### Crew settings (header gear)
- Edit team name
- Add / remove roles
- **Apply changes** — take effect immediately

## Difference vs Yeaft Code Agent

|  | Crew | Yeaft Code Agent |
| --- | --- | --- |
| Engine | Claude Code CLI (one process per role) | Yeaft in-house engine |
| Model | Claude only (CLI decides) | Each VP picks provider/model |
| Memory | Within session | Cross-session H2-AMS |
| Routing | ROUTE protocol auto (PM dispatches) | @mention + `route_forward` explicit |
| Tools | Full Claude Code skill / MCP ecosystem | Yeaft's built-in 30+ tools |
| Resources | Process per role, multiple worktrees | Shared engine, VPs are logical entities |

**Pick Crew**: you're already in the Claude Code ecosystem and want the full pipeline for one concrete feature (decompose → write → review → test)
**Pick Yeaft Code Agent**: you want long-term memory + freely mixed providers + multi-VP parallel discussion

Detailed comparison: [Choose a Backend](./choose-backend.md).
