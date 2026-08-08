# Workbench

Workbench is the development panel on the right side of Chat and Yeaft Sessions. Its tools run on the selected Agent and are scoped to the currently selected Session and working directory.

## Open and close Workbench

Use the **Workbench** action in the Chat header or Yeaft Session actions.

Workbench opens on a launcher with four capability cards:

- **Terminal** — run commands in the current Session working directory
- **Git** — inspect repository status and diffs
- **Files** — browse, preview, and edit Agent-local files
- **Browser** — view and control the Agent-local browser when Browser Runtime is available

All four cards remain visible. A card marked **Unavailable on this Agent** can be opened to see the current availability explanation, but it does not start a fake or partial tool.

Only the capability you select is started. Closing the capability returns focus to its launcher card; closing Workbench collapses the whole panel. You can also maximize the panel or drag its left resize handle.

Workbench follows the canonical Session route. Switching to another Session on the same Agent returns to the launcher and isolates Terminal, Git, and Files state from the previous Session.

## Terminal

Terminal provides an xterm.js terminal connected to a PTY on the Agent:

- opens in the selected Session's working directory
- supports horizontal and vertical splits
- supports normal terminal applications such as `vim`, `tmux`, and `htop`
- keeps terminal state only within the owning Session route

Use the Terminal toolbar to split or close terminal panes. Use the Workbench back action to return to the capability launcher without closing the entire Workbench.

## Files

Files provides a VS Code-style file tree, editor, and preview surface.

### File tree

- expand and collapse directories
- use `Ctrl+P` for quick open
- create, delete, move, copy, or upload files
- refresh the tree or choose another folder inside the current Session workspace

### Editor and previews

- edit multiple files with syntax highlighting
- use `Ctrl+F` / `Ctrl+H` to find and replace
- use `Ctrl+S` to save on the Agent
- preview Markdown, images, PDFs, and supported Office documents

Opening a file reference from chat opens Workbench directly in Files for the current Session route.

## Git

Git shows the repository selected for the current Session:

- branch and ahead/behind status
- staged, modified, and untracked files
- file diffs
- stage, unstage, discard, commit, and push actions
- an optional folder picker for another repository within the current Session workspace

Use Terminal for merge-conflict resolution and interactive rebase.

## Browser

Browser is part of the launcher so capability availability is explicit. The current Browser Runtime Phase 0 foundation does not advertise a usable Browser capability and does not expose signaling, a Web viewer, or user input. Current Agents therefore show an unavailable state instead of an embedded browser placeholder.

A future Agent must advertise the complete Browser capability combination before Workbench treats Browser as available.

## Troubleshooting

**A capability is unavailable**

- verify that the selected Agent advertises the required capability, including `workbench_session_routes` for route-scoped tools
- upgrade the Agent if necessary and check its startup logs

**Terminal does not open**

- check the Agent logs for PTY startup errors
- verify that the Agent installation includes the supported PTY backend

**Files or Git points at the wrong project**

- confirm the currently selected Session and its working directory
- close and reopen the capability after changing Session metadata

**Files cannot save**

- confirm that the Agent process user can write to the selected path
