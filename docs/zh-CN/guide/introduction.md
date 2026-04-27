# 什么是 Claude Web Chat？

Claude Web Chat 是一个用于远程访问 [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) 的 Web 界面 — 提供多机器管理、端到端加密和多角色协作。

![Screenshot](/images/zh-CN/hero.jpg)

## 核心功能

### Chat 聊天

ChatGPT 风格对话界面，实时工具追踪，会话管理和文件上传。

- Claude 响应实时流式输出
- 可视化显示 Read、Edit、Bash 等工具操作
- 斜杠命令（`/model`、`/memory`、`/skills` 等）+ 自动补全
- `/btw` 侧边提问 — 在不打断当前任务的情况下快速追问
- Sub-Agent 面板 — 实时监控和查看嵌套 Agent 工具调用
- SQLite 会话持久化，支持历史恢复
- 会话置顶 — 将重要对话固定在侧边栏顶部
- 拖放上传文件和图片
- 深色 / 浅色主题一键切换
- 双语界面（English / 中文），运行时切换语言
- 移动端响应式布局

![Chat](/images/zh-CN/chat.jpg)

### 分屏模式（Split Screen）

并排打开多个对话 — 最多同时显示 3 个面板。

- 从侧边栏将任意 session 分屏到新面板
- 每个面板是完全独立的对话视图
- 活跃面板焦点指示器，便于键盘和侧边栏交互
- 可逐个关闭面板；全部关闭后自动回到单面板模式

### 帮帮团（Expert Panel）

AI 专家团队辅助对话 — 选择一个团队（如写作、交易），在侧边面板获取多视角建议。

- 多个预置专家团队，各有专属角色
- 专家回复显示在可折叠侧边面板中
- Chip 风格标签切换团队
- 与正常对话并行，不打断聊天流程

### Crew（多角色协作）

多角色 AI 团队协作，PM、开发者、审查者、测试者等角色协同完成 Feature 开发。

- 角色间通过 ROUTE 协议自动任务路由
- Feature 进度追踪面板，实时状态显示（streaming 呼吸灯动画）
- 决策者消息在主流中直接显示，按角色分组
- 多 Agent 跨 worktree 并行执行
- Feature 完成检测，有新活动时自动重新激活
- AskUserQuestion 交互卡片 — Agent 可在任务进行中向用户请求决策
- Typing Indicator 事件驱动健康监控（Agent 离线 / Session 丢失 / 正在压缩）

![Crew Features](/images/zh-CN/crew-features.jpg)

![Crew Feature Detail](/images/zh-CN/crew-feature-detail.jpg)

### Workbench（工作台）

集成开发环境：终端、Git 操作、文件浏览器和端口代理。

- 全功能终端模拟器 (xterm.js)，支持 PTY
- Git 状态查看、差异对比、分支管理
- 文件浏览器 + CodeMirror 代码编辑器
- 端口代理：将 Agent 本地端口转发到浏览器

![Workbench](/images/zh-CN/workbench.jpg)

### 仪表板（Admin Dashboard）

管理员使用统计与系统监控。

- 用户活跃度指标，支持时间范围筛选（今天/本周/本月）
- 按用户维度的使用量明细（消息数、会话数、请求数、流量）
- Agent 连接状态与延迟监控
- 移动端响应式卡片布局

![Dashboard](/images/zh-CN/dashboard.jpg)

## 前置要求

- **Server**: Node.js >= 18, Docker（推荐用于生产环境部署）
- **Agent**: Node.js >= 18, 需在工作机器上安装并认证 [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
- **Web 客户端**: 现代浏览器（Chrome, Firefox, Safari, Edge）

## 技术栈

- **Server**: Node.js, Express, ws, node:sqlite, compression
- **Frontend**: Vue 3, Pinia, xterm.js, CodeMirror 5, marked, highlight.js
- **Build**: esbuild
- **Testing**: Vitest（2,700+ 单元/集成测试），Playwright（E2E）
- **Encryption**: TweetNaCl (XSalsa20-Poly1305)
- **Auth**: JWT, bcrypt, speakeasy (TOTP), nodemailer
- **Docs**: VitePress
- **Deploy**: Docker 多阶段构建
