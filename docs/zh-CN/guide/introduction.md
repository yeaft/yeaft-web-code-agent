# 什么是 Yeaft？

**Yeaft Web Code Agent** 是 Web 端多 provider 代码 Agent 平台。一份浏览器 UI 可以接 Claude Code CLI、GitHub Copilot CLI，也可以使用 Yeaft 原生 Code Agent 引擎；实际代码执行仍发生在你连接的 Agent 机器上。

![Screenshot](/images/zh-CN/hero.jpg)

## 三条代码 Agent 路径，各自擅长

Yeaft 不绑定单一 AI 后端。打开一个新会话时你能选：

| 后端 | 适合 | 详细 |
| --- | --- | --- |
| **Claude Code** | 单 1:1 chat，配 Claude 全套工具 | [Chat 模式](./user/chat-mode.md) |
| **Copilot** | 同样 1:1，但走 GitHub Copilot CLI（ACP 协议），可挑 Claude / GPT 系 model | [Copilot 模式](./user/copilot-mode.md) |
| **Yeaft Code Agent** | 原生多 provider 代码 Agent，1..N 个 VP，并行 fan-out，持久记忆，30+ 工具 | [Yeaft Code Agent](./user/yeaft-group.md) |

不确定选哪个？看 [选择会话后端](./user/choose-backend.md)。

## 核心能力

### 💬 多模式 chat
- ChatGPT 风格界面，流式输出
- 工具执行实时可视化（Read / Edit / Bash / WebFetch 等）
- 斜杠命令 + 自动补全
- 拖放文件 / 图片附件
- 双语 UI（English / 中文）+ 深色 / 浅色主题

![Chat](/images/zh-CN/chat.jpg)

### 👥 Yeaft Code Agent
- 创建一个 Session，可以只有一个专注 VP，也可以放多个 VP（Virtual Person，人格 / 模型 / 工具独立配置）
- `@mention` 决定哪些 VP 接管本轮消息，并行 fan-out
- 跨 session 持久记忆（H2-AMS）— 记住项目决策和个人偏好
- 多 provider 路由：Anthropic、OpenAI Responses、GitHub Copilot 动态凭证和兼容 gateway
- VP→VP 显式 handoff（`route_forward` 工具）和子 Agent 编排

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

- **Server**：Node.js >= 22.5，推荐 Docker 部署
- **Agent**：Node.js >= 22.5，外加：
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
