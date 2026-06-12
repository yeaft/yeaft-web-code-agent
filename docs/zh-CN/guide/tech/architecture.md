# 架构总览

Yeaft 是一个**三层架构**的多 provider AI 协作平台：

```
┌────────────────────────────────────────────────────────────────┐
│                       Web Client (Vue 3)                        │
│   ChatPage  /  YeaftPage  /  Crew / Workbench / Settings        │
│              统一的 MessageList 渲染管线（不区分后端）          │
└──────────────────────────────┬─────────────────────────────────┘
                               │ WebSocket（加密）
                               ↓
┌────────────────────────────────────────────────────────────────┐
│                     Server (Express + ws)                       │
│  - 哑中继：按 conversationId / agentId 路由                     │
│  - 鉴权（JWT + TOTP + Email）                                   │
│  - 端到端加密（TweetNaCl）                                      │
│  - SQLite session / user / invite codes                         │
└──────────────────────────────┬─────────────────────────────────┘
                               │ WebSocket（加密）
                               ↓
┌────────────────────────────────────────────────────────────────┐
│                          Agent (Node.js)                        │
│  ┌─────────────────────┐  ┌──────────────────────────────────┐ │
│  │  Provider 抽象层      │  │  Yeaft 引擎（独立 AI orchestrator）│ │
│  │  ─ claude-code        │  │  ─ engine.js query loop          │ │
│  │  ─ copilot (ACP)      │  │  ─ H2-AMS 记忆                   │ │
│  │                       │  │  ─ multi-provider LLM router      │ │
│  │  spawn 外部 CLI 子进程 │  │  ─ 40+ 工具                       │ │
│  └─────────────────────┘  └──────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │  Crew 多角色子系统（独立 wire type，跨 worktree）          │  │
│  └─────────────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │  Workbench：terminal / git / files / port-proxy           │  │
│  └─────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

## 关键分层

### Provider 抽象层（`agent/providers/`）
- 接口 `ChatProvider`（`base.js`）— `start / sendInput / abort / listSessions / loadHistory`
- 两个实现：`claude-code`（spawn Claude CLI）、`copilot`（spawn `copilot --acp`）
- 所有 provider **输出**翻译成同一个 `claude_output` envelope，前端零分支
- 详见 [Provider 系统](./providers.md)

### Yeaft 引擎层（`agent/yeaft/`）
- 完全自含的 AI orchestrator —— **不**依赖任何外部 CLI
- 自有 query loop、记忆系统（H2-AMS）、多 provider LLM router、工具系统
- 通过 `yeaft_output` wire type 出消息（payload 跟 claude_output 同构，前端复用渲染管线）
- 详见 [Yeaft 引擎](./yeaft-engine.md)

### Wire 协议层
- WebSocket envelope 用 `type` 字段区分消息种类
- `claude_output` 是 **protocol name**，不是 vendor name — 所有 chat 输出都用它
- 详见 [WebSocket 协议](./wire-protocol.md)

## 项目结构

```
claude-web-chat/
├── server/                  # 中央 WebSocket hub
│   ├── index.js             # 入口
│   ├── handlers/            # 消息处理器（agent↔client 路由）
│   ├── api.js               # REST 接口（认证、会话、用户）
│   ├── proxy.js             # 端口代理转发
│   ├── database.js          # SQLite 存储
│   └── auth.js              # JWT + TOTP + 邮箱验证
├── agent/                   # 工作机器 Agent
│   ├── cli.js               # CLI 入口（yeaft-agent 命令）
│   ├── index.js             # 启动 + 能力检测
│   ├── connection/          # WebSocket 连接、认证、消息路由
│   ├── providers/           # Provider 抽象 + claude-code/copilot 实现
│   │   ├── base.js          # ChatProvider 接口
│   │   ├── claude-code.js   # Claude CLI 驱动
│   │   ├── copilot.js       # Copilot CLI 驱动（ACP）
│   │   └── acp-client.js    # ACP JSON-RPC 客户端
│   ├── yeaft/               # Yeaft 自有引擎
│   │   ├── engine.js        # 主 query loop
│   │   ├── memory/          # H2-AMS 记忆
│   │   ├── llm/             # LLM adapter（anthropic / openai-responses）
│   │   ├── sessions/        # Session 编排（多 VP fan-out）
│   │   ├── tools/           # 40+ 内置工具
│   │   └── ...
│   ├── claude.js            # Claude Chat 旧路径（仍保留）
│   ├── conversation.js      # Chat session 生命周期
│   ├── crew/                # Crew 多角色子系统
│   ├── sdk/                 # Claude CLI stream-json SDK
│   ├── terminal.js          # PTY 终端（node-pty）
│   └── workbench/           # Git + 文件操作
├── web/                     # Vue 3 前端
│   ├── app.js               # Vue 应用入口
│   ├── build.js             # esbuild 生产构建
│   ├── components/          # Vue 组件（ChatPage / YeaftPage / Crew / Workbench）
│   ├── stores/              # Pinia 状态管理
│   ├── styles/              # CSS（深色 / 浅色主题）
│   ├── i18n/                # en / zh-CN 翻译
│   └── vendor/              # 第三方库（本地，无 CDN）
├── test/                    # Vitest 单元/集成测试
├── e2e/                     # Playwright E2E
├── docs/                    # VitePress 文档（本站）
├── Dockerfile               # 多阶段生产构建
└── LICENSE                  # MIT
```

## 数据流

### Claude Code / Copilot 模式
```
Web → ws "send_message" → Server → ws agent
  → provider.sendInput()
  → CLI 子进程
  → 事件流（stream-json / ACP）→ 翻译为 claude_output envelope
  → ws "claude_output" → Server → ws Web → MessageList 渲染
```

### Yeaft 会话
```
Web → ws "yeaft_session_chat" → Server → ws agent
  → coordinator.ingest() → Promise.all(runVpTurn × VPs)
  → Engine.query() → tool exec → LLM stream → 事件
  → web-bridge.js 翻译为 claude_output envelope
  → ws "yeaft_output" → Server → ws Web → handleYeaftOutput → handleClaudeOutput → MessageList
```

## CI/CD

内置 GitHub Actions：
- **CI** (`ci.yml`)：Node 24 跑测试 + 构建前端（`workflow_dispatch` 手动触发）
- **Release** (`release.yml`)：推 `release-*` tag → 自动发 npm 包 + Docker 镜像 + GitHub Release

## 接下来

- 想加新 provider → [Provider 系统](./providers.md)
- 想读 Yeaft 引擎 → [Yeaft 引擎](./yeaft-engine.md)
- 想看 wire 类型 → [WebSocket 协议](./wire-protocol.md)
