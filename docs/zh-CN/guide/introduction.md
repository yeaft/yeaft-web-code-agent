# 什么是 Yeaft？

**Yeaft** 是一个**多 provider AI 协作平台** — Web 端入口，背后可以接 Claude Code CLI、GitHub Copilot CLI，或 Yeaft 自有的多 VP 引擎。一份界面，三种后端，按任务自由切换。

![Screenshot](/images/zh-CN/hero.jpg)

## 三种后端，各自擅长

Yeaft 不绑定单一 AI 后端。打开一个新会话时你能选：

| 后端 | 适合 | 详细 |
| --- | --- | --- |
| **Claude Code** | 单 1:1 chat，配 Claude 全套工具 | [Chat 模式](./user/chat-mode.md) |
| **Copilot** | 同样 1:1，但走 GitHub Copilot CLI（ACP 协议），可挑 Claude / GPT 系 model | [Copilot 模式](./user/copilot-mode.md) |
| **Yeaft Group** | 多 VP 群组协作，并行 fan-out，跨 session 持久记忆 | [Yeaft Group Mode](./user/yeaft-group.md) |

不确定选哪个？看 [选择会话后端](./user/choose-backend.md)。

## 核心能力

### 💬 多模式 chat
- ChatGPT 风格界面，流式输出
- 工具执行实时可视化（Read / Edit / Bash / WebFetch 等）
- 斜杠命令 + 自动补全
- 拖放文件 / 图片附件
- 双语 UI（English / 中文）+ 深色 / 浅色主题

![Chat](/images/zh-CN/chat.jpg)

### 👥 Yeaft Group Mode
- 拉一个 group，里面塞多个 VP（Virtual Person，可独立配人格 / 模型 / 工具）
- `@mention` 决定哪些 VP 接管这条消息，并行 fan-out
- 跨 session 持久记忆（H2-AMS）— 新 session 也记得你上次说的事
- VP→VP 显式 handoff（`route_forward` 工具）

### 🧠 帮帮团（Expert Panel）
AI 专家团队侧边面板辅助你的对话。
- 多个预置专家团队
- Chip 风格切换团队
- 与主对话并行，不打断

### 👷 Crew 多角色协作
PM / 开发 / 审查 / 测试 / 架构师 / 设计师并行跑 feature。
- ROUTE 协议在角色间路由
- Feature 看板 + kanban 状态
- 跨 worktree 并行执行
- ask-user 卡片中断要决策

![Crew Features](/images/zh-CN/crew-features.jpg)

### 🖥️ 分屏 + Workbench
- **分屏**：最多 3 个面板同时显示不同会话
- **Workbench**：终端 / Git / 文件 / 端口代理一站式

![Workbench](/images/zh-CN/workbench.jpg)

### 📊 仪表板（Admin）
用户活跃度 / Agent 状态 / 流量统计。

![Dashboard](/images/zh-CN/dashboard.jpg)

## 前置要求

- **Server**：Node.js >= 18，推荐 Docker 部署
- **Agent**：Node.js >= 18，外加：
  - [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)（用 Claude Chat 模式必装）
  - [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli)（可选，用 Copilot 模式时装）
  - Yeaft 引擎内置在 npm 包里，**不需要额外 CLI**
- **Web 客户端**：现代浏览器（Chrome / Firefox / Safari / Edge）

## 技术栈

- **Server**：Node.js, Express, ws, node:sqlite, compression
- **Frontend**：Vue 3, Pinia, xterm.js, CodeMirror 5, marked, highlight.js
- **Build**：esbuild
- **Testing**：Vitest（2,700+ 单元/集成测试），Playwright（E2E）
- **Encryption**：TweetNaCl (XSalsa20-Poly1305)
- **Auth**：JWT, bcrypt, speakeasy (TOTP), nodemailer
- **Docs**：VitePress
- **Deploy**：Docker 多阶段构建

## 接下来

- 没装过 → [快速开始](./getting-started.md)
- 想选后端 → [选择会话后端](./user/choose-backend.md)
- 想了解架构 → [架构总览](./tech/architecture.md)
