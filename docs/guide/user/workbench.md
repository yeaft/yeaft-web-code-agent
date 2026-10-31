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
- refresh the tree or choose another folder on the selected Agent

In ordinary Sessions, manually selected files can be outside the Session working directory; browsing, editing, and previews use the Agent account’s filesystem permissions and do not change the Session working directory. WorkItem Files remain confined to the WorkItem workspace. Automatic response file/image references still require paths inside the Session workspace.

Opening or switching files expands their parent folders and highlights the active file. Click any segment of the editor path to show and locate that folder (or the filename to locate the file). In ordinary Sessions, an external file can move the tree root to its parent without changing the Session working directory or discarding edits; WorkItem navigation stays inside its workspace.

On Windows, the top-level drive list shows only fixed disks, not mapped network drives, removable drives, or optical drives. The Agent queries drive types asynchronously through Windows PowerShell with a five-second execution timeout, without probing drive roots; concurrent requests share the query, and subsequent requests refresh it. Enumeration failures appear as errors with a retry action instead of an empty list. Other paths remain accessible through existing direct-path inputs, subject to the same permissions and workspace boundaries. macOS/Linux root browsing is unchanged.

### Editor and previews

- edit multiple files with syntax highlighting
- use `Ctrl+F` / `Ctrl+H` to find and replace
- use `Ctrl+S` to save on the Agent
- preview Markdown, images, PDFs, supported Office documents, and browser-supported MP4, M4V, WebM, OGV/OGG, and MOV videos; videos stream from the Agent and can also be downloaded

Audio files (`.mp3`, `.wav`, `.m4a`, `.flac`, `.aac`) play locally using the browser’s native controls when its codec is supported; `.ogg` keeps the video streaming path. Every non-text file has **Download**, including failed previews. PDF includes a fallback hint when the browser viewer is unavailable or blank. Office files are rendered locally only: legacy Office Online settings are ignored, and private preview URLs are never sent to Microsoft or a cloud conversion service. Legacy `.doc`, PowerPoint (`.ppt` / `.pptx`), archives, and other unsupported binary files show their format and download action instead of opening as garbled editable text. Unknown files with control bytes or invalid UTF-8 also use this safe fallback; non-UTF-8 text should be opened locally.

CSV (`.csv`), SVG (`.svg`), HTML (`.html` / `.htm`), and Markdown open in Preview by default. Switch between **Preview / Edit**; preview reflects your current edits, including unsaved changes. HTML uses an isolated static preview with inline styles and data images. Scripts, link navigation, form submission, and external or relative-path resources are disabled. Use your project’s local development server for interactive or multi-file pages.

CSV and local Excel (`.xlsx` / `.xls`) previews share read-only table controls: click a column heading to cycle ascending / descending / original order; search all columns or filter a selected column by contained text. These operations cover only the bounded loaded preview and never write the file. Original record/worksheet row numbers remain visible after sorting. Click or drag cells to select a rectangle, use Shift+click or Shift+arrow keys to extend, and **Copy selection** or Ctrl/Cmd+C to copy plain-text TSV. Arrow keys move the focused cell; Ctrl/Cmd+A selects the current 50-row page. Selection resets on page, worksheet, header, sort or filter changes. Pasting into another spreadsheet may interpret formula-like text; check the destination’s paste-as-text option.

Local Excel preview has worksheet switching, sticky column headings and row numbers, and independent horizontal/vertical scrolling in light and dark themes. Excel starts with A/B/C column labels; enable **First row is header** if appropriate. It displays cached/formatted cell values only: no formula recalculation, links, macros, HTML, charts, merged-cell layout or workbook editing. The first 100 worksheet names are available. Parsing runs off the UI thread, one selected sheet at a time, with a 15-second deadline, a 20 MiB file limit, and at most 1,000 worksheet rows, 100 columns, 10,000 characters per cell and 1 million displayed characters. Empty sheets, partial previews and invalid/encrypted/timed-out files show explicit states. Download/open the original in a spreadsheet application when the preview is insufficient.

CSV opens as a read-only table with sticky headers, row numbers, horizontal scrolling, and 50-row pages. You can turn off **First row is header** for headerless files. Commas, quoted newlines, escaped quotes, a UTF-8 BOM, and empty fields are supported; values are text only, not executable formulas or HTML. Preview scans at most the first 1 million source characters and displays up to 1,000 records, 100 columns, and 10,000 characters per cell, with an explicit partial-preview notice. Incomplete records at the scan boundary are omitted. These limits never change the original file; **Edit** still shows the full loaded text. Invalid CSV shows an error with the record number and can be repaired in Edit.

SVG renders in safe image mode with gradients, filters, and self-contained CSS/SMIL animations. JavaScript and linked resources are disabled. Click the image to zoom; invalid SVG shows an error while Edit remains available to fix the source.

Clicking a file reference in a response opens Workbench directly in Files for the current Session route, loads the file, and reveals the starting line when specified. Markdown links, inline code, and plain-text paths are supported, including `src/main.js:20-35`, `src/main.js#L20-L35`, and Unicode filenames. Put paths containing spaces in inline code or Markdown links.

References are resolved in batches during streaming and checked again when the response finishes. Only files confirmed by the current Agent inside the Session workspace become clickable; missing, ambiguous, and out-of-workspace paths are not automatically linked. External HTTP/HTTPS links open in Workbench Browser and are never mapped to local files with the same name. Ctrl/Cmd-click keeps the native new-tab behavior.

Temporary resolution errors are retried up to twice. Unresolved paths in completed responses are checked up to twice more when subsequent work in the current Session finishes, so newly created files can appear without endless polling. If a read fails or the connection drops, Files shows an error; after reconnecting, click the same reference to retry without closing its tab. Repeated clicks do not overwrite loaded content or unsaved edits.

Non-video binary previews and downloads support files up to 100 MiB. Individual preview renderers may have lower parsing limits (for example, Excel preview remains limited to 20 MiB); these do not prevent downloading the original file. Videos use bounded byte-range streaming and are not subject to that whole-file transfer limit. Session-routed preview URLs do not expire when switching Sessions or when the Server evicts its 10-minute byte cache. On a cache miss, the Server reads the file from the original Agent automatically; no manual URL renewal is needed. Treat the URL as an access credential bound to the original user, Agent, Session, and workspace—do not share it publicly. Access is rechecked on every request; an offline Agent, deleted file, archived Session, or changed workspace can prevent access. Refills read the current file at the original path, not a permanent snapshot. Rotating the Server's `JWT_SECRET` invalidates existing URLs. Legacy previews without Session routes still use temporary caching.

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
- Sites can refuse embedding using CSP or `X-Frame-Options`. The panel always explains embed limitations and stops the loading message after a longer wait; neither a cross-origin `load` event nor a timeout proves success or blocking. For blank pages, script failures, or sign-in problems, use **Open in new tab** to use your client browser’s cookies, sign-in state, and full site features (subject to browser and enterprise policies). Yeaft does not bypass site restrictions or copy credentials.
- Unlike the Files panel’s static HTML preview, Browser allows JavaScript (inline and external scripts) and forms, but not same-origin access, popups, or top-level navigation. Module scripts and `fetch` remain subject to CORS, and sign-in or storage may be limited. Use **Open in new tab** when full site capabilities are needed. Credentials in URLs and destinations on Yeaft’s origin are rejected. Embedded content does not inherit Yeaft’s visual theme.

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
