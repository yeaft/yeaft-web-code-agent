# Workbench

Workbench is the development panel on the right side of Chat and Yeaft Sessions. Terminal, Git, and Files run on the selected Agent; Browser loads pages directly on your device. Tools are scoped to the currently selected Session and working directory.

## Open and close Workbench

Use the **Workbench** action in the Chat header or Yeaft Session actions.

Workbench opens on a launcher with four capability cards:

- **Terminal** — run commands in the current Session working directory
- **Git** — inspect repository status and diffs
- **Files** — browse, preview, and edit Agent-local files
- **Browser** — open external HTTP/HTTPS pages in a client-side iframe without Agent setup

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
- preview Markdown, images, PDFs, supported Office documents, and browser-supported MP4, M4V, WebM, OGV/OGG, and MOV videos; videos stream from the Agent and can also be downloaded

HTML (`.html` / `.htm`) and Markdown open in Preview by default. Switch between **Preview / Edit**; preview reflects your current edits, including unsaved changes. HTML uses an isolated static preview with inline styles and data images. Scripts, link navigation, form submission, and external or relative-path resources are disabled. Use your project’s local development server for interactive or multi-file pages.

Clicking a file reference in a response opens Workbench directly in Files for the current Session route, loads the file, and reveals the starting line when specified. Markdown links, inline code, and plain-text paths are supported, including `src/main.js:20-35`, `src/main.js#L20-L35`, and Unicode filenames. Put paths containing spaces in inline code or Markdown links.

References are resolved in batches during streaming and checked again when the response finishes. Only files confirmed by the current Agent inside the Session workspace become clickable; missing, ambiguous, and out-of-workspace paths are not automatically linked. External HTTP/HTTPS links open in Workbench Browser and are never mapped to local files with the same name. Ctrl/Cmd-click keeps the native new-tab behavior.

Temporary resolution errors are retried up to twice. Unresolved paths in completed responses are checked up to twice more when subsequent work in the current Session finishes, so newly created files can appear without endless polling. If a read fails or the connection drops, Files shows an error; after reconnecting, click the same reference to retry without closing its tab. Repeated clicks do not overwrite loaded content or unsaved edits.

Non-video binary previews and downloads support files up to 20 MiB. Videos use bounded byte-range streaming and are not subject to that whole-file transfer limit. Session-routed preview URLs do not expire when switching Sessions or when the Server evicts its 10-minute byte cache. On a cache miss, the Server reads the file from the original Agent automatically; no manual URL renewal is needed. Treat the URL as an access credential bound to the original user, Agent, Session, and workspace—do not share it publicly. Access is rechecked on every request; an offline Agent, deleted file, archived Session, or changed workspace can prevent access. Refills read the current file at the original path, not a permanent snapshot. Rotating the Server's `JWT_SECRET` invalidates existing URLs. Legacy previews without Session routes still use temporary caching.

## Git

Git shows the repository selected for the current Session:

- branch and ahead/behind status
- staged, modified, and untracked files
- file diffs
- stage, unstage, discard, commit, and push actions
- an optional folder picker for another repository within the current Session workspace

Use Terminal for merge-conflict resolution and interactive rebase.

## Browser

Browser embeds HTTP/HTTPS pages directly in your client browser. It does not start an Agent browser, install Chromium, use WebRTC, or proxy page traffic through the Server. It works without Browser Runtime capabilities, including in Work Center.

- Plain-click external links in responses, Markdown previews, or WorkItem outputs to open them here. Ctrl/Cmd-click, middle-click, and downloads keep native browser behavior.
- Enter an address, refresh, or use **Open in new tab**. The address stays at the URL you opened; cross-origin redirects and in-page navigation cannot be observed reliably, so no fake back/forward controls are shown.
- URLs are scoped to the owning Agent/Session or WorkItem and workspace, kept only for the lifetime of the Workbench component. Switching tools restores the last opened URL; closing the Browser tab clears it. Refreshing Yeaft clears this ephemeral state.
- `localhost` and private network addresses refer to your **client device and network**, not the Agent. An HTTPS Yeaft page may block HTTP content.
- Sites can refuse embedding using CSP or `X-Frame-Options`. A blank iframe is not proof the site loaded; use **Open in new tab**. Yeaft does not bypass these restrictions.
- The iframe allows scripts and forms but not same-origin access, popups, or top-level navigation. This protects the control plane, but may limit sign-in, storage, and interaction. Credentials in URLs and destinations on Yeaft’s origin are rejected. Embedded content does not inherit Yeaft’s visual theme.

Legacy Agent Browser Runtime configuration/CLI remains for compatibility; this Workbench view does not use it. No existing runtime process or instance data is changed by opening this view.

## Troubleshooting

**A capability is unavailable**

- Terminal, Git, and Files require the selected Agent’s capabilities, including `workbench_session_routes` for route-scoped tools. Browser does not require an Agent browser capability.
- upgrade the Agent if necessary and check its startup logs

**Terminal does not open**

- check the Agent logs for PTY startup errors
- verify that the Agent installation includes the supported PTY backend

**Files or Git points at the wrong project**

- confirm the currently selected Session and its working directory
- close and reopen the capability after changing Session metadata

**Files cannot save**

- confirm that the Agent process user can write to the selected path
