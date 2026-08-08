---
layout: home

hero:
  name: Yeaft
  text: 运行在自有机器上的 Web Code Agent
  tagline: 一个浏览器统一使用原生多 provider Session、持久 Work Center、Claude Code CLI 与 GitHub Copilot CLI
  image:
    src: /images/zh-CN/session.png
    alt: Light theme 下的 Yeaft 多 VP Session
  actions:
    - theme: brand
      text: 在线体验
      link: https://cc.yeaft.com
    - theme: brand
      text: 快速开始
      link: /zh-CN/guide/getting-started
    - theme: alt
      text: GitHub
      link: https://github.com/yeaft/yeaft-web-code-agent

features:
  - title: 原生 Yeaft Session
    details: 1 个 VP 做专注编码，或同时点名多个 VP 并行实现、审查、调研和明确交接。
    link: /zh-CN/guide/user/yeaft-session
  - title: 持久 Work Center
    details: 将目标保存为 WorkItem，规划经过校验的 Action graph，分配 VP、保留 Run 证据，并在断开或重启后恢复。
    link: /zh-CN/guide/user/work-center
  - title: 多 provider LLM routing
    details: 原生请求通过 Anthropic Messages 或 OpenAI Responses provider 路由，也支持已实现的 GitHub Copilot 动态凭据和 compatible gateway。
    link: /zh-CN/guide/yeaft-config
  - title: Scoped persistent memory
    details: H2-AMS 在明确的 user、VP、Session 与相关 Project-Session scope 中组合 resident summary、recent context 和全文召回。
    link: /zh-CN/guide/tech/yeaft-memory
  - title: Claude Code 与 Copilot CLI
    details: 需要 vendor CLI 行为时继续使用对应 runtime；Browser 只共享导航和可兼容的 event rendering，不掩盖行为差异。
    link: /zh-CN/guide/user/choose-backend
  - title: 本地开发工作区
    details: 在已连接 Agent 上启动 route-scoped Terminal、Git、Files、Browser 能力，并使用 33 个原生工具、Skills、MCP、后台任务和 sub-agent。
    link: /zh-CN/guide/user/workbench
---
