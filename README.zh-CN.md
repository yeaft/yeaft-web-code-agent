# Yeaft Web Code Agent

![CI](https://github.com/yeaft/claude-web-chat/actions/workflows/ci.yml/badge.svg)
[![npm](https://img.shields.io/npm/v/@yeaft/webchat-agent)](https://www.npmjs.com/package/@yeaft/webchat-agent)
[![Docker](https://img.shields.io/badge/docker-ghcr.io-blue)](https://ghcr.io/yeaft/claude-web-chat)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Node.js](https://img.shields.io/badge/node-%3E%3D18-green)

[English](README.md) | [中文](README.zh-CN.md) | [文档站点](https://yeaft.github.io/claude-web-chat/zh-CN/)

> Web 端多 provider 代码 Agent 平台 — 在同一个浏览器 UI 里运行 Claude Code CLI、GitHub Copilot CLI，或 Yeaft 原生 Code Agent。支持多工作机器、本地执行、跨 provider 模型路由、持久记忆和多 VP Session 协作。

**🌐 在线体验：[cc.yeaft.com](https://cc.yeaft.com)** — 开放注册，无需邀请码。

## 术语表

- **Yeaft Web Code Agent**：完整 Web 端产品，包括 server、浏览器 UI、已连接的 worker agent、文档和部署形态。
- **Yeaft Code Agent**：运行在 `yeaft-agent` 内的原生代码 Agent 能力，包含 Yeaft 引擎、工具、记忆和直接 LLM provider 路由。
- **Yeaft Session**：原生引擎的持久协作单元。一个 Session 可以只有 1 个 VP 做专注编码，也可以有多个 VP 并行协作。
- **Legacy wire/storage names**：部分代码和协议字段仍保留 `group`、`groupId`、`yeaft_session_chat`、`unify_*`、`claude_output` 等旧名。这些是兼容契约，不是新的产品语言。新文档和新代码应使用 Yeaft + Session 术语，除非是在明确说明兼容层。

![Screenshot](docs/images/zh-CN/hero.jpg)

## 功能特性

### 选择你的代码 Agent 路径

Yeaft Web Code Agent 不绑定单一 AI 厂商，也不绑定单一执行模型。开始工作时可以选择：

| 后端 | 适合 |
| --- | --- |
| **Claude Code** | 1:1 chat 配 Claude Code CLI — 全套 Claude 工具 |
| **Copilot** | 1:1 chat 走 GitHub Copilot CLI（ACP 协议）— 任挑 Claude / GPT 系 model |
| **Yeaft Code Agent** | 原生多 provider 代码 Agent，1..N 个 VP，并行 fan-out，持久记忆，30+ 内置工具 |

### Chat（Claude Code）

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

### Copilot CLI 后端

同样的 chat 界面，但后端跑 `copilot --acp` 而不是 `claude`。Copilot 走 ACP（Agent Client Protocol），Agent 把每条 ACP 事件翻译成同样的 `claude_output` envelope — 渲染管线共用。

- 任挑 Copilot 提供的 Claude / GPT 系 model
- per-session 权限弹窗（一次允许 / 永久允许 / 拒绝）
- Session 恢复 + 历史
- 复用你的 GitHub Copilot OAuth，不需要额外 API key

### Yeaft Code Agent

Yeaft 原生代码 Agent 引擎运行在 `yeaft-agent` 内，不需要外部 CLI 子进程。它以 Session 为核心：一个 Session 可以只有 1 个 VP 做专注编码，也可以放多个 VP 做产品 / 架构 / 实现 / 审查协作。

- 用可复用 VP 组建 Session，每个 VP 独立配置人格、provider/model、记忆和工具策略
- 用 `@mention` 决定哪些 VP 处理本轮；多个 VP 会并行运行
- 通过 H2-AMS 保留跨 session 持久记忆，按 user / VP / Session / feature 分 scope 管理
- LLM 调用可路由到 Anthropic、OpenAI Responses、GitHub Copilot 动态凭证、Azure/OpenAI-compatible gateway 或本地 proxy
- 内置 30+ 工具，覆盖文件、patch、shell、git worktree、Web、notebook、计划和子 Agent 编排
- 在 Yeaft debug panel 中查看模型路由、召回记忆、工具调用、token 用量和 stop reason

完整用法、provider 设置和设计原则见 [Yeaft Code Agent 指南](docs/zh-CN/guide/user/yeaft-group.md)。

![Chat](docs/images/zh-CN/chat.jpg)

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


多角色 AI 团队协作，PM、开发者、审查者、测试者等角色协同完成 Feature 开发。

- 角色间通过 ROUTE 协议自动任务路由
- Feature 进度追踪面板，实时状态显示（streaming 呼吸灯动画）
- 决策者消息在主流中直接显示，按角色分组
- 多 Agent 跨 worktree 并行执行
- Feature 完成检测，有新活动时自动重新激活
- AskUserQuestion 交互卡片 — Agent 可在任务进行中向用户请求决策
- Typing Indicator 事件驱动健康监控（Agent 离线 / Session 丢失 / 正在压缩）



### 仪表板（Admin Dashboard）

管理员使用统计与系统监控。

- 用户活跃度指标，支持时间范围筛选（今天/本周/本月）
- 按用户维度的使用量明细（消息数、会话数、请求数、流量）
- Agent 连接状态与延迟监控
- 移动端响应式卡片布局

![Dashboard](docs/images/zh-CN/dashboard.jpg)

### Workbench（工作台）

集成开发环境：终端、Git 操作、文件浏览器和端口代理。

- 全功能终端模拟器 (xterm.js)，支持 PTY
- Git 状态查看、差异对比、分支管理
- 文件浏览器 + CodeMirror 代码编辑器
- 端口代理：将 Agent 本地端口转发到浏览器

![Workbench](docs/images/zh-CN/workbench.jpg)

## 前置要求

- **Server**: Node.js >= 22.5, Docker（推荐用于生产环境部署）
- **Agent**: Node.js >= 22.5，按需安装下列至少一项：
  - [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) — Claude Chat 模式必需
  - [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli) — Copilot 模式必需（可选）
  - **Yeaft Code Agent 已内置**于 npm 包，原生 Yeaft Session **无需任何额外 CLI**
- **Web 客户端**: 现代浏览器（Chrome, Firefox, Safari, Edge）

### 通过 Agent CLI 配置 Yeaft LLM provider

安装后的 agent 可以通过 `yeaft-agent llm` 配置本机 LLM。所有命令只写当前机器的 `~/.yeaft/config.json`；不会写 server global config，也不会改任何 UI 全局 provider 列表。

```bash
yeaft-agent llm setup
```

```bash
yeaft-agent llm use github-copilot --model claude-sonnet-4.5 --fast gpt-4.1
```

GitHub Copilot 会使用本机 device token / `gh auth` credential provider，从 Copilot API 刷新实时模型列表，并且不会把 token 写入配置。自定义 OpenAI-compatible endpoint 可以这样配置：

```bash
OPENAI_KEY=sk-... yeaft-agent llm use openai-compatible --name openai --base-url https://api.openai.com/v1 --api-key-env OPENAI_KEY --model gpt-5
```

高级手动配置仍然保留：

```bash
OPENAI_KEY=sk-... yeaft-agent llm add-provider --name openai --base-url https://api.openai.com/v1 --models gpt-5,gpt-4.1 --api-key-env OPENAI_KEY --protocol openai-responses --set-primary gpt-5
```

```bash
yeaft-agent llm show
```

```bash
yeaft-agent llm set-model --primary openai/gpt-5 --fast openai/gpt-4.1
```

```bash
yeaft-agent llm remove-provider --name openai
```

完整用法和示例见 `yeaft-agent llm --help`。Yeaft Code Agent session header 里的 LLM 配置按钮编辑的是同一份 agent-local config。

## 架构

```
┌──────────────────────────────────────────┐
│        Server  (@yeaft/webchat-server)   │
│         Express + WebSocket Hub          │
│   - Agent / Web 客户端管理               │
│   - 多层认证（密码 + TOTP + 邮箱）      │
│   - 端到端加密 (TweetNaCl)              │
│   - 消息路由与队列                       │
│   - SQLite 会话持久化                    │
└──────────────────┬───────────────────────┘
                   │ 加密 WebSocket
        ┌──────────┴──────────┐
        │                     │
┌───────▼───────┐      ┌──────▼──────────┐
│    Agent      │      │   Web 客户端    │
│ @yeaft/       │      │    (web/)       │
│ webchat-agent │      │                 │
│               │      │ - Vue 3 + Pinia │
│ - 原生 Yeaft  │      │ - 分屏多面板    │
│   Code Agent  │      │ - 端到端加密    │
│ - Claude /    │      │ - 深色/浅色主题 │
│   Copilot CLI │      │ - 中英双语      │
│ - 终端 / Git  │      │ - 文件上传      │
│ - 文件管理    │      │                 │
└───────────────┘      └─────────────────┘
```

## 快速开始

### 方式 A：npm 安装（仅 Agent）

```bash
# 全局安装 Agent
npm install -g @yeaft/webchat-agent

# 连接到服务器
yeaft-agent --server wss://your-server.com --name my-worker --secret your-secret

# 升级到最新版
yeaft-agent upgrade
```

### 方式 B：完整开发环境

```bash
git clone https://github.com/yeaft/claude-web-chat.git
cd claude-web-chat

# 安装所有依赖
npm install

# 启动服务器 + Agent（开发模式，无需认证）
npm run dev
```

然后浏览器打开 `http://localhost:3456`

## 生产环境部署

### 服务器（Docker）

```bash
cd server
cp .env.example .env
```

编辑 `.env` 文件：

```env
PORT=3456

# 必须修改！使用随机字符串
JWT_SECRET=your-very-long-random-secret-key-here
AGENT_SECRET=your-agent-shared-secret-here

# 可选：邮箱验证
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your@gmail.com
SMTP_PASS=your-app-password
SMTP_FROM=Yeaft Web Code Agent <noreply@example.com>

# 可选：TOTP 双因素认证
TOTP_ENABLED=true
```

Docker Compose 配置：

```yaml
services:
  webchat:
    build:
      context: .
      dockerfile: Dockerfile
    expose:
      - "3456"
    env_file:
      - server/.env
    environment:
      - NODE_ENV=production
      - SKIP_AUTH=false
    volumes:
      - ./data:/app/data
    restart: unless-stopped
```

```bash
# 启动服务器（首次运行会自动创建 data/ 目录和 SQLite 数据库）
docker compose up -d --build webchat

# 创建第一个 admin 用户
docker compose exec webchat node server/create-user.js admin your-password admin@example.com
```

后续用户可直接在登录页注册（开放注册，无需邀请码）。

![登录页面](docs/images/login.png)

### Nginx 反向代理

```nginx
server {
    listen 443 ssl;
    server_name cc.your-domain.com;

    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    client_max_body_size 50M;

    location / {
        proxy_pass http://webchat:3456;
        proxy_http_version 1.1;

        # WebSocket 支持
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket 长连接超时
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

### 部署 Agent

**npm 安装**（推荐）：

```bash
npm install -g @yeaft/webchat-agent

# 前台运行
yeaft-agent --server wss://your-server.com --name worker-1 --secret your-secret

# 或安装为系统服务（开机自启、崩溃自重启）
yeaft-agent install --server wss://your-server.com --name worker-1 --secret your-secret

# 管理已安装的服务
yeaft-agent status                 # 查看运行状态
yeaft-agent logs                   # 查看日志（跟踪模式）
yeaft-agent restart                # 重启
yeaft-agent uninstall              # 卸载服务
```

**从源码运行**（开发环境或不使用 npm 全局安装）：

```bash
cd agent
cp .env.example .env
# 编辑 .env — 设置 SERVER_URL, AGENT_NAME, AGENT_SECRET, WORK_DIR

# 前台运行
node index.js

# 或安装为系统服务（自动读取 .env 配置）
node cli.js install

# 管理已安装的服务
node cli.js status
node cli.js logs
node cli.js uninstall
```

Agent Secret 可在 Web 界面的 **设置 > 安全** 中找到：

![设置 Agent](docs/images/zh-CN/setup-agent.jpg)

当没有 Agent 连接时，首页会引导你前往设置页面：

![无 Agent](docs/images/zh-CN/no-agent.jpg)

### Agent CLI 命令

```
yeaft-agent [选项]                  前台运行
yeaft-agent install [选项]          安装为系统服务 (Linux/macOS/Windows)
yeaft-agent uninstall               卸载系统服务
yeaft-agent start                   启动服务
yeaft-agent stop                    停止服务
yeaft-agent restart                 重启服务
yeaft-agent status                  查看服务状态
yeaft-agent logs                    查看服务日志
yeaft-agent upgrade                 升级到最新版本
yeaft-agent --version               显示版本号

选项：
  --server <url>      WebSocket 服务器地址
  --name <name>       Agent 显示名称
  --secret <secret>   认证密钥
  --work-dir <dir>    默认工作目录
  --auto-upgrade      启动时检查更新

环境变量（替代命令行参数）：
  SERVER_URL, AGENT_NAME, AGENT_SECRET, WORK_DIR
```

## 安全

### 认证流程

1. **用户名 + 密码**（bcrypt 哈希）
2. **TOTP 双因素认证**（可选，支持 Google/Microsoft Authenticator）
3. **邮箱验证码**（可选，需配置 SMTP）

### 生产模式要求

服务器在生产模式（`SKIP_AUTH=false`）下会检查：
- `JWT_SECRET` 必须修改为非默认值

如果未配置用户，服务器会启动但输出警告 — 通过 `docker compose exec` 创建首个用户即可。

### Agent 认证

- Agent 通过 WebSocket 消息认证（密钥不在 URL 中传输）
- **用户级 Agent 密钥**：Agent 绑定到特定用户，仅该用户可见
- **全局 AGENT_SECRET**：环境变量方式，仅 admin 可见
- 每个连接生成独立会话密钥用于加密

### 角色与权限

所有注册用户默认为 **Pro** 角色。通过 CLI 创建的第一个用户为 **Admin**。

| 功能 | `pro` | `admin` |
|---|:---:|:---:|
| 聊天 | ✓ | ✓ |
| 帮帮团（Expert Panel） | ✓ | ✓ |
| 自有 Agent（用户级密钥） | ✓ | ✓ |
| 全局 Agent（AGENT_SECRET） | - | ✓ |
| 工作台（终端、Git、文件） | ✓ | ✓ |
| 端口代理 | ✓ | ✓ |
| 仪表板（Admin Dashboard） | - | ✓ |
| 邀请码管理 | - | ✓ |

## 前端构建

前端资源在 Docker 构建时自动打包：

```bash
# 手动构建（开发测试用）
npm run build
```

构建输出：
- `web/dist/vendor.bundle.js` — 第三方库（Vue、Pinia、TweetNaCl 等）
- `web/dist/app.bundle.js` — 应用代码
- `web/dist/style.bundle.css` — 样式
- 所有文件同时生成 `.gz` 压缩版本

## 项目结构

```
yeaft-web-code-agent/
├── server/              # 中央 WebSocket 服务器
│   ├── index.js         # 入口
│   ├── handlers/        # 消息处理器（agent↔client 路由）
│   ├── api.js           # REST 接口（认证、会话、用户）
│   ├── proxy.js         # 端口代理转发
│   ├── database.js      # SQLite 存储
│   └── auth.js          # JWT + TOTP + 邮箱验证
├── agent/               # 工作机器 Agent
│   ├── cli.js           # CLI 入口（yeaft-agent 命令）
│   ├── index.js         # 启动与能力检测
│   ├── connection/      # WebSocket 连接、认证与消息路由
│   ├── providers/       # ChatProvider 抽象
│   │   ├── base.js      # ChatProvider 接口 + 能力声明
│   │   ├── claude-code.js # Claude CLI 驱动
│   │   ├── copilot.js   # GitHub Copilot CLI 驱动（ACP）
│   │   └── acp-client.js# ACP JSON-RPC 客户端
│   ├── yeaft/           # Yeaft 自有 AI 引擎（不依赖外部 CLI）
│   │   ├── engine.js    # 主 query loop
│   │   ├── memory/      # H2-AMS 记忆子系统
│   │   ├── llm/         # 多 provider LLM 适配器
│   │   ├── sessions/    # Session 编排
│   │   └── tools/       # 30+ 内置工具
│   ├── claude.js        # Legacy Claude CLI 进程管理
│   ├── conversation.js  # 会话生命周期与斜杠命令
│   ├── sdk/             # Claude CLI stream-json SDK
│   ├── terminal.js      # PTY 终端 (node-pty)
│   └── workbench/       # Git + 文件操作
├── web/                 # Vue 3 前端
│   ├── app.js           # Vue 应用入口
│   ├── build.js         # 生产构建脚本（esbuild）
│   ├── stores/          # Pinia 状态管理 + helpers
│   ├── styles/          # CSS（23 个样式表，深色/浅色主题）
│   ├── i18n/            # 国际化翻译（en、zh-CN）
│   └── vendor/          # 第三方库（本地加载，无 CDN）
├── test/                # Vitest 单元/集成测试（68 文件，2700+ 用例）
├── e2e/                 # Playwright 端到端测试
├── docs/                # VitePress 文档站点
├── Dockerfile           # 多阶段生产构建
└── LICENSE              # MIT
```

## 技术栈

- **Server**: Node.js, Express, ws, node:sqlite, compression
- **Frontend**: Vue 3, Pinia, xterm.js, CodeMirror 5, marked, highlight.js
- **Build**: esbuild
- **Testing**: Vitest（2,700+ 单元/集成测试），Playwright（E2E）
- **Encryption**: TweetNaCl (XSalsa20-Poly1305)
- **Auth**: JWT, bcrypt, speakeasy (TOTP), nodemailer
- **Docs**: VitePress
- **Deploy**: Docker 多阶段构建

## CI/CD

内置 GitHub Actions 工作流：

- **CI** (`ci.yml`): 在 Node 24 上运行测试 + 构建前端（手动触发 `workflow_dispatch`）
- **Release** (`release.yml`): 推送 `release-*` tag 时自动发布 npm 包 + Docker 镜像 + GitHub Release

### 发布新版本

```bash
git tag release-v1.0.0
git push origin release-v1.0.0
# GitHub Actions 自动完成后续工作
```

## 常见问题

### Agent 连接失败 "Invalid agent secret"

确保 Agent 的 `AGENT_SECRET`（或 `--secret` 参数）与服务器 `.env` 中配置一致。

### 服务器启动失败 "SECURITY CONFIGURATION ERROR"

生产模式下必须修改默认 JWT 密钥：
```env
JWT_SECRET=随机字符串（至少32位）
```

可用命令生成：`openssl rand -base64 32`

### Docker 部署后 502 Bad Gateway

1. 检查容器是否运行：`docker compose logs webchat`
2. 刷新 nginx DNS 缓存：`docker exec nginx nginx -s reload`

### SQLite 只读错误 (SQLITE_READONLY)

确保数据目录权限正确：
```bash
sudo chown -R root:root ./data
```

### TOTP 设置后无法登录

TOTP 码有时间窗口限制（默认 ±30 秒），确保服务器和手机时间同步。

### Agent 自动升级

```bash
# 手动升级
yeaft-agent upgrade

# 启动时自动检查
yeaft-agent --auto-upgrade --server wss://...
```

服务器也可通过设置 `AGENT_LATEST_VERSION` 环境变量，在 Agent 连接时推送升级通知。

## 贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.md) 了解开发环境搭建和贡献规范。

## 免责声明

本项目是一个独立的、社区驱动的开源项目，与 Anthropic, PBC **没有任何关联**，未获得其认可或官方授权。

"Claude" 是 Anthropic 的商标。本项目为 Claude Code CLI 提供 Web 界面，不修改或再分发任何 Anthropic 软件。

使用本软件的风险由用户自行承担。作者不对因使用本软件而产生的任何问题承担责任。

## License

[MIT](LICENSE)
