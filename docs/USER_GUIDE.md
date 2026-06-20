# User Guide

> **This page is now an index.** The full user guide has been split into focused chapters under [Guide → User Guide](./guide/user/login.md). External links to `USER_GUIDE` are preserved — pick the chapter you want below.

**Language**: [中文版](/zh-CN/USER_GUIDE)

## Where Did the Content Go?

The previous monolithic USER_GUIDE has been broken up into smaller, dedicated chapters so each feature has its own page. Use the table below to find what you're looking for.

### Getting Started

| Old section | New page |
| --- | --- |
| Getting Started | [Getting Started](./guide/getting-started.md) |
| Login & Registration | [Login & Registration](./guide/user/login.md) |
| Choose a Code Agent Path | [Choose a Code Agent Path](./guide/user/choose-backend.md) (NEW) |

### Chat & Conversation Modes

| Old section | New page |
| --- | --- |
| Chat Mode (Claude Code) | [Chat (Claude Code)](./guide/user/chat-mode.md) |
| Copilot Mode | [Copilot Mode](./guide/user/copilot-mode.md) (NEW) |
| Yeaft Code Agent | [Yeaft Code Agent](./guide/user/yeaft-group.md) (NEW) |
| Crew Mode | [Crew (Multi-Role)](./guide/user/crew.md) |
| Expert Panel | [Expert Panel](./guide/user/expert-panel.md) |
| Split Screen | [Split Screen](./guide/user/split-screen.md) |

### Tools & Workspace

| Old section | New page |
| --- | --- |
| Workbench (Terminal/Files/Git) | [Workbench](./guide/user/workbench.md) |
| Settings | [Settings](./guide/user/settings.md) |
| Keyboard Shortcuts | [Shortcuts](./guide/user/shortcuts.md) |
| Sidebar / Session List | covered in [Chat (Claude Code)](./guide/user/chat-mode.md) |

### Agent & Deployment

| Old section | New page |
| --- | --- |
| Agent Installation & Connection | [Agent Installation](./guide/deploy-agent.md) |
| Agent CLI Reference | [Agent CLI](./guide/agent-cli.md) |

### Technical Reference

For the technical implementation (provider system, Yeaft engine, wire protocol, etc.), see [Guide → Technical](./guide/architecture.md).

## Why the Restructure?

The old single-page guide was getting too long to maintain and was missing entire features:

1. **Copilot CLI backend** (via ACP) has been a first-class chat provider for months — it wasn't in the guide
2. **Yeaft Code Agent** (multi-VP parallel collaboration) is the current main dev direction — wasn't documented
3. Splitting per feature lets each page link straight to the relevant component without overwhelming a new reader

If you bookmarked a section anchor on this page, the equivalent content lives on the linked chapter — the URLs above are stable going forward.
