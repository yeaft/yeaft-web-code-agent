---
layout: home

hero:
  name: Yeaft
  text: Yeaft Web Code Agent
  tagline: Web-based code agents with Claude Code, GitHub Copilot, and the native multi-provider Yeaft Code Agent
  image:
    src: /images/hero.jpg
    alt: Yeaft
  actions:
    - theme: brand
      text: Try it Online
      link: https://cc.yeaft.com
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/yeaft/claude-web-chat

features:
  - icon: 💬
    title: Chat (Claude Code)
    details: ChatGPT-style 1:1 conversation backed by Claude Code CLI — streaming, slash commands, file attachments, sub-agent monitoring.
    link: /guide/user/chat-mode
  - icon: 🪄
    title: Copilot Mode
    details: GitHub Copilot CLI as the backend (ACP protocol) — same interface, pick any Claude / GPT model.
    link: /guide/user/copilot-mode
  - icon: 👥
    title: Yeaft Code Agent
    details: Native multi-provider code agent — 1..N VPs, persistent memory, 30+ tools, provider/model routing.
    link: /guide/user/yeaft-group
  - icon: 🖥️
    title: Split Screen
    details: Up to 3 panels side by side — mix backends (one Claude + one Copilot + one native Yeaft Session).
    link: /guide/user/split-screen
  - icon: 🧠
    title: Expert Panel
    details: AI expert team in a side panel — pick a team, get multi-perspective advice without interrupting the main chat.
    link: /guide/user/expert-panel
  - icon: 👷
    details: PM / dev / reviewer / tester running features in parallel — ROUTE protocol, kanban board, cross-worktree execution.
  - icon: 🛠️
    title: Workbench
    details: Terminal / Git / files / port proxy — the agent machine's dev environment piped right into the browser.
    link: /guide/user/workbench
  - icon: 🔒
    title: Security
    details: TweetNaCl end-to-end encryption, multi-layer auth (password + TOTP + email), per-user agent secret + Yeaft credential 2FA.
    link: /guide/security
---
