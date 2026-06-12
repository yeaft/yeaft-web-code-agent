# Workbench

Workbench is the **dev tool panel** integrated to the right of the Yeaft chat surface — terminal, file browser, Git, port proxy, all running on the Agent machine, **without you opening SSH or VS Code**.

Use case: "I'm discussing code with Claude and want to glance at output / tweak a file / run a test inline."

## Open Workbench

- The **Workbench icon** in the sidebar header (panel layout icon)
- Also present in the collapsed sidebar
- Opens the Workbench panel on the right of the chat area
- **Maximize** — fill all space except the sidebar
- **Collapse** — minimize to an edge
- Drag the left **resize handle** to change width

> Which Workbench tabs (terminal / files / git / proxy) are available depends on the Agent's capabilities (`terminal`, `file_editor`, etc.). Unsupported tabs don't render.

## Terminal

Full terminal emulator (xterm.js + PTY) connected to the Agent machine:

- **Split** — header buttons ─ (horizontal) / │ (vertical), run multiple terminals at once
- **Close panel** — × on the active panel
- **Auto-spawn** — Agent's bash tool calls **automatically** create a terminal panel for output
- Click a panel to make it active (highlighted border)
- Fonts / colors follow theme
- Full terminal feature set: vim, tmux, htop all work

## Files

VS Code-style file browser + editor.

### File tree (left)
- Hierarchical, expandable / collapsible
- Type-aware file / folder icons
- **Search** — top input filters by name
- **Ctrl+P** — quick open file search (fuzzy)
- **+ New file** / **New folder** — toolbar buttons
- **🗑 Delete** / **➡ Move** — action toolbar after selection
- **↻ Refresh** — reload the tree
- **▼ Collapse all** — fold every expanded directory
- **📂 Open folder** — change root via folder picker
- **Drag-drop upload** — drag files from desktop onto the tree

### Editor (right, CodeMirror)
- **Multiple tabs** — multiple files open at once
- **Syntax highlighting** — all mainstream languages
- **Find / replace** — Ctrl+F / Ctrl+H
- **Ctrl+S** to save (writes to the Agent machine)
- **Office docs** — doc/docx/xls/xlsx/ppt with optional local preview or Office Online (configured in Settings)
- **Image preview** — png/jpg/gif/webp render inline
- **PDF preview** — embedded renderer

**Font size** — Ctrl+Wheel resizes the file-tree font.

## Git

Visual git status viewer:

- **Branch display** — current branch + ↑N behind / ↓N ahead commits
- **Push** — push pending commits
- **Pull** — pull from remote
- **Fetch** — fetch only, no merge
- **File list**:
  - Staged changes
  - Unstaged changes
  - Untracked files
  - Per-row status markers (M / A / D / R / ?)
- **Diff viewer** — side-by-side or unified
- **Stage / unstage** — single file or all
- **Commit** — write a commit message + commit
- **Branch switch** — dropdown to switch / create branches
- **Working directory** — folder picker to choose the repo

> Not supported: visual merge conflict resolution (use the terminal), interactive rebase.

## Port Proxy

Expose Agent-machine local services through the browser:

- **+ Add port** — Agent, host, port, optional label
- **Toggle** — enable / disable rules
- **🌐 Open in browser** — new tab to the proxy URL
- **📋 Copy URL**

Typical uses:
- `npm run dev` on the Agent (`:3000`) → add proxy → browse
- Jupyter on the Agent (`:8888`) → proxy → browse
- Remote DB management UIs

> Port Proxy also exists under Settings → Proxy with shared data.

## Working with chat

Workbench complements chat, not replaces it:

- **AI writes files** → open Files to inspect / tweak
- **AI runs commands** → terminal panel auto-spawns
- **AI changes git state** → Git tab refreshes
- **AI starts a service** → add a Port Proxy to access directly

## Performance notes

- Opening lots of large files, many long-running terminals, multiple dev server proxies — browser slows
- Close unused tabs / panels for instant relief
- Files editor on huge files (>10MB) gets laggy; use terminal instead

## Troubleshooting

**Some Workbench tabs missing**
- Agent doesn't support that capability — upgrade Agent or check startup logs

**Terminal won't open / stuck loading**
- Agent-side PTY startup failed — check `yeaft-agent logs`
- Often node-pty is missing; reinstall Agent

**Files editor save fails**
- Agent-side permission issue — confirm the Agent user can write that path

**Port Proxy won't connect**
- Target port isn't actually listening on the Agent — verify the service is up
- Agent firewall blocking — check server / Agent error logs
