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
- preview Markdown, images, PDFs, supported Office documents, and browser-supported MP4, M4V, WebM, OGV/OGG, and MOV videos; videos stream from the Agent and can also be downloaded

Opening a file reference from chat opens Workbench directly in Files for the current Session route.

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

Browser opens an isolated Chromium process on the selected Agent and displays its active tab as a live WebRTC video stream. Browser Sessions are memory-only, use a temporary profile, and are bounded by the Agent's configured Session and idle limits.

The current viewer is read-only. Navigation, keyboard, pointer, and scroll control arrive in the next Browser Runtime phase; the UI does not pretend those controls are available in this release.

### Enable Browser Runtime

The viewer data plane currently supports **Linux x64 Agents only**. Other platforms may be able to run CLI install/status commands, but they do not advertise a ready viewer capability.

Browser routes are available on the Server by default. The selected Agent still stays disabled and downloads nothing until the user explicitly enables Browser:

1. Select the Linux x64 Agent and open **Workbench → Browser**. If Browser is not ready, the launcher says **Enable required** and the setup panel shows the exact pinned build and platform download size. Opening the panel does not start a download.
2. Click **Enable Browser** once. Workbench shows the real byte count and percentage while the Agent downloads and verifies the archive. The Agent installs it only in that Agent instance's data directory, persists enablement, runs the local media probe, refreshes capabilities, and automatically starts the Viewer attachment. There is no second enable button and no Agent restart on this UI path.
3. Configure ICE for the deployment. The Agent probe validates Chrome, tab capture, VP8, and a same-host WebRTC loop; it cannot validate the remote Web-to-Agent network path. `BROWSER_STUN_URLS` is optional for direct connectivity. Production deployments across NATs or restrictive networks should deploy TURN and configure `BROWSER_TURN_URLS` plus `BROWSER_TURN_SECRET`; use `BROWSER_ICE_TRANSPORT_POLICY=relay` when direct candidates are not allowed. The URLs are comma-separated. Use the repository's `deploy/browser-turn/` directory for the self-hosted template.

Administrators can set `BROWSER_RUNTIME_ENABLED=false` and restart the Server to disable Browser setup, signaling, and viewer routes globally. This is an administrative off switch, not a normal user setup step.

For unattended administration, use the equivalent instance-scoped CLI. Every command must select the same `--name` or `--yeaft-dir` as the running Agent:

```bash
yeaft-agent browser install --name <agent-instance>
yeaft-agent browser probe --name <agent-instance>
yeaft-agent browser enable --name <agent-instance>
yeaft-agent restart --name <agent-instance>  # managed Agent service
yeaft-agent browser status --name <agent-instance>
```

The CLI `enable` command persists `browserRuntime.enabled=true`; it does not refresh an already running Agent process. Restart a managed service, or stop and start a foreground Agent, after CLI enablement. `browser probe` exercises the pinned Chrome build, extension, tab capture, offscreen runtime, and WebRTC media path. `browser status` only reports selected-instance configuration and managed-browser installation state, so `installed: true` by itself does not mean the viewer is ready.

A successful Linux tab-capture probe advertises `browser_runtime`, `browser_webrtc`, and `browser_capture_tab`. Workbench enables the viewer only after Web protocol negotiation, the Server's administrative off switch, and the complete Agent capability combination all allow it. Older Agents that do not advertise `browser_runtime_setup` remain compatible when they already advertise the probe-ready viewer capabilities.

A deployment without TURN may work over direct ICE, but it is a degraded direct-only setup and is not a production availability guarantee across NATs or restrictive networks.

### Session lifecycle

- opening Browser restores an existing ready Browser Session for that Agent or creates one
- closing the Browser capability detaches only the viewer; the Agent reclaims a no-viewer Session after the configured idle timeout
- **End browser** closes Chromium and deletes its temporary profile immediately
- WebSocket or Agent transport replacement invalidates the peer generation and closes Agent-owned Browser Sessions fail-closed
- SDP, ICE candidates, TURN credentials, video, and temporary profile data are never written to Chat or Yeaft transcripts

## Troubleshooting

**A capability is unavailable**

- for Browser, first run `yeaft-agent browser status --name <agent-instance>` and confirm that the command reports the same `yeaftDir` as the running Agent
- run `yeaft-agent browser probe --name <agent-instance>`; a nonzero exit or `ok: false` means the Chrome/media path is not ready
- confirm the Agent is Linux x64, the Server was not explicitly started with `BROWSER_RUNTIME_ENABLED=false`, and the Agent advertises `browser_runtime`, `browser_webrtc`, and `browser_capture_tab`
- for other capabilities, verify that the selected Agent advertises the required capability, including `workbench_session_routes` for route-scoped tools
- upgrade the Agent if necessary and check its startup logs

**Terminal does not open**

- check the Agent logs for PTY startup errors
- verify that the Agent installation includes the supported PTY backend

**Files or Git points at the wrong project**

- confirm the currently selected Session and its working directory
- close and reopen the capability after changing Session metadata

**Files cannot save**

- confirm that the Agent process user can write to the selected path
