# Yeaft User Guide

This stable URL is a compact index of the current product documentation.

**Language:** [中文](/zh-CN/USER_GUIDE)

## Start here

- [What is Yeaft?](./guide/introduction.md)
- [Getting started](./guide/getting-started.md)
- [Choose a code agent path](./guide/user/choose-backend.md)

## Sidebar shortcuts

**New chat / New task / New folder / Plugins**, followed by **Search Sessions**, show icons and labels on separate rows by default. When the Session list needs scrolling, hover over the shortcuts to reveal an upward collapse arrow at the far right. Click it to switch to a row of small icons and make more room for Sessions. A downward expand arrow stays at the far right of the compact row; layouts never switch automatically. This preference is stored on the Server per signed-in user and shared across desktops. Reloading, signing in again, or returning focus to a window loads the latest choice. Failed saves are disclosed and restore the previous settings.

Click **Search Sessions** to open an input under the shortcuts. Typing lists matching Sessions from supported online Agents in place of the folder tree. Clear the query or press Escape to return to the tree.

The Session list is one file tree. Folders come first and can hold subfolders, up to five levels; each folder lists its subfolders, then its Sessions. Sessions outside every folder follow below the folders. Click a folder to expand or collapse it. On hover or keyboard focus a folder shows **New chat / New task** icons, whose chat or task belongs to that folder, and a menu with **New subfolder**, **Folder instructions**, **Rename**, **Move to** and **Delete folder**. These folder actions and the shortcut disclosure arrow stay visible on touch devices.

Drag a Session onto a folder to move it in, or into the space below the last row to move it to the top level. Drag a folder onto the middle of another folder to nest it there, or onto its top or bottom edge to place it before or after (the bottom edge of an open folder that has contents nests too); the space below the last row moves it to the top level. **Move to** in the folder menu does the same without dragging. A folder cannot move into itself or one of its subfolders. A folder's instruction applies to the chats in it and in all of its subfolders; the instruction dialog shows how much its chats already inherit from parent folders. Deleting a folder also deletes its subfolders; their chats move up one level and are never deleted.

## Native Yeaft

- [Sessions and Projects](./guide/user/yeaft-session.md)
- [Provider and model configuration](./guide/yeaft-config.md)
- [Settings](./guide/user/settings.md)

## CLI conversations and workspace

- [Claude Code conversations](./guide/user/chat-mode.md)
- [GitHub Copilot conversations](./guide/user/copilot-mode.md)
- [Expert Panel](./guide/user/expert-panel.md)
- [Split screen](./guide/user/split-screen.md)
- [Workbench](./guide/user/workbench.md)
- [Keyboard shortcuts](./guide/user/shortcuts.md)

## Install and operate

- [Deploy the Server](./guide/deploy-server.md)
- [Install an Agent](./guide/deploy-agent.md)
- [Agent and native CLI reference](./guide/agent-cli.md)
- [Login and registration](./guide/user/login.md)
- [Security](./guide/security.md)
- [Admin dashboard](./guide/features-dashboard.md)

## Technical reference

- [Architecture](./guide/tech/architecture.md)
- [CLI provider system](./guide/tech/providers.md)
- [Native Yeaft engine](./guide/tech/yeaft-engine.md)
- [Retired H2-AMS implementation](./guide/tech/yeaft-memory.md)
- [Native LLM layer](./guide/tech/yeaft-llm.md)
- [WebSocket protocol](./guide/tech/wire-protocol.md)
- [Configuration reference](./guide/reference/config-reference.md)
- [FAQ](./guide/faq.md)

Internal design and migration notes under `docs/notes/` and `docs/work-center/` are maintainer references, not the public feature contract.
