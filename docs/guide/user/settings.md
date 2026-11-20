# Settings

Open via the **⚙ gear** at the bottom of the sidebar. Settings live in a **fixed-shell modal** — switching tabs scrolls content, the modal frame itself stays put.

## General

- **Theme** — Light / Dark
- **Language** — 中文 / English (UI re-renders immediately)
- **Waiting animation** — what plays under the conversation while a turn runs: Random (default; one of the animations, picked for each turn), Basketball, Dragon Ball, Running cat, or Off (three dots). Basketball and Dragon Ball are stick-figure scenes drawn straight onto the page: the scene appears as soon as the wait starts, with no caption. The animation takes up at most five lines of chat text. In a narrow conversation it scales down to fit; with more room, the scene stays centred and only the court or ground extends to either side, fading out. When the system asks for reduced motion, Basketball and Dragon Ball show their key moments one at a time, fading from one to the next, and the cat stays in place, walking, panting and napping. Remote Desktop and many virtual machines turn Windows animation effects off, which browsers report as reduced motion; for the full animations turn them back on (Windows 11: Settings → Accessibility → Visual effects → Animation effects; Windows 10: Settings → Ease of Access → Display → Show animations in Windows). If the connection drops, the stick-figure scenes stop and turn grey; the cat keeps moving in the status colour. Saved in this browser.
- **Office preview mode** — how Office docs (doc/docx/xls/xlsx/ppt/pptx) preview:
  - **Local render** — built-in viewer, no network
  - **Office Online** — Microsoft's online viewer; requires the Agent file URL to be reachable from the public Internet

### Custom shortcuts and quick sends

**General → Custom shortcuts** controls personal key bindings and the **Show quick sends** toggle. Quick-send buttons start hidden; new users receive simple `Alt + key` defaults and can replace or clear any binding. Preferences are isolated by signed-in user in this browser, not synchronized across devices.

Create up to five presets under **Agent settings → Quick send**. Each preset stores its name, model, effort and maximum output tokens in that Agent instance's `config.json`. Blank effort uses the runtime default. Blank maximum output tokens uses the selected model's resolved output limit, not the Session's previous model budget; enter a positive integer to use a smaller budget. The request is always capped to the actual model's output limit, including fallback retries. Each Agent has its own model catalog and presets.

When enabled, native Yeaft Session Composers add a small mode selector beside the ordinary send button. Open it to send the current draft, attachments and quote with one preset, or use that preset's shortcut directly. Session defaults and ordinary Enter sending are unchanged. CLI Chat and Work Center do not show this selector.

Defaults: terminal `Alt/Option+T`, files `Alt/Option+O`, Git workbench `Alt/Option+G`, new Session `Alt/Option+N`, close an open workbench `Alt/Option+W`, and quick-send slots `Alt/Option+1…5`. Known browser/application conflicts such as `Ctrl+T` and `Ctrl+F` are rejected; operating systems and extensions may reserve additional combinations. Global actions stay available while the message Composer is focused, and avoid editors, terminals, dialogs and other text fields. Quick-send bindings only operate in the Composer and ignore IME composition and key repeat.

### Sidebar layout

The Session list is a single folder tree without a separate Projects / Recents split, so it scrolls as one list. On desktop, drag the sidebar's right edge to set its width (220–480px). With the edge focused, arrow keys adjust it by 16px and Shift + arrow keys by 64px; Home or a double-click restores the default 260px. When the window narrows, the sidebar gives way so the content keeps at least 480px, and returns to your width when there is room again.

The width is saved in this browser and shared by Chat, Sessions and Work Center. Folder expand/collapse state and the compact shortcut row are user preferences on the Server instead, restored on other devices at sign-in or page load and refreshed when an open page regains focus. Phones use the overlay drawer, which has no width handle.

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


## LLM settings (Yeaft mode)

If your Agent has the Yeaft engine enabled, you also see a **Yeaft / LLM** tab:

- **Config file path** — shows the selected Agent instance's resolved `config.json` location
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
