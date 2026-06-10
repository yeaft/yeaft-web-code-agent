# Settings

Open via the **⚙ gear** at the bottom of the sidebar. Settings live in a **fixed-shell modal** — switching tabs scrolls content, the modal frame itself stays put.

## General

- **Theme** — Light / Dark
- **Language** — 中文 / English (UI re-renders immediately)
- **Office preview mode** — how Office docs (doc/docx/xls/xlsx/ppt/pptx) preview:
  - **Local render** — built-in viewer, no network
  - **Office Online** — Microsoft's online viewer; requires the Agent file URL to be reachable from the public Internet

## Account

- **Username** — login name (read-only)
- **Role** — `Pro` or `Admin` (read-only)
- **Email** — if set at registration
- **Sign out** — clear token, return to login

## Security

### Agent Key
- Authenticates Agent ↔ Server WebSocket connections
- **👁** show / hide the key
- **📋** copy to clipboard
- **Reset key** — generate a new one (**will disconnect all existing Agents** until they re-connect with the new key)

### Install commands (Agent side)
Renders the full two-line command:
```bash
npm install -g @yeaft/webchat-agent
yeaft-agent install --server <your-server-url> --secret <your-agent-key>
```
Click **Copy** to copy the whole command and paste it on the Agent machine.

### Change password
- Enter current password + new password (≥6 chars) + confirm new password
- Click **Change password**

## Invite codes (Admin only)

Admins create invite codes for new users:

- **Create** — pick role (`Pro`) + expiry → click **+**
- **List** — each row shows:
  - The code string
  - Role tag
  - Status: **Available** / **Used** / **Expired**
  - User who consumed it (if used)
  - Expiry time
  - 📋 Copy (unused codes)
  - 🗑 Delete (unused codes)

Users redeem codes on the registration page.

## Port Proxy

Expose Agent-machine local services through your browser (e.g. `localhost:3000` dev server):

- **+ Add port** — Agent, host, port, optional label
- **Toggle** — enable / disable each rule
- **🌐 Open in browser** — new tab to the proxy URL
- **📋 Copy URL**

> The Workbench has the same tab with shared data.

## LLM settings (Yeaft mode)

If your Agent has the Yeaft engine enabled, you also see a **Yeaft / LLM** tab:

- **Config file path** — shows `~/.yeaft/config.json` location
- **Providers list** — currently configured providers / models / protocols
- **Test connection** — pick a model and ping; confirms endpoint + auth works
- **Reload** — make the Agent re-read the config file (no Agent restart needed after edits)

Full field reference: [Yeaft Engine Config](../yeaft-config.md).

## Debug / experimental

> Admin / debug-mode only

- **Debug mode** — turn on for extra console logging
- **Experimental flags** — switches for features still in flight

## Saving

Settings **auto-save** — switch tabs or close the modal and it's persisted; no "Save" button.

> Exception: **Reset Agent Key**, **Change password** and similar sensitive operations need their respective in-tab button, not auto-save.
