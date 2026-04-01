# 架构

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
│ - 管理 Claude │      │ - 分屏多面板    │
│   CLI 进程    │      │ - 端到端加密    │
│ - Crew 多角色 │      │ - 深色/浅色主题 │
│   协调        │      │ - 中英双语      │
│ - 终端 / Git  │      │ - 文件上传      │
│ - 文件管理    │      │                 │
└───────────────┘      └─────────────────┘
```

## 项目结构

```
claude-web-chat/
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
│   ├── claude.js        # Claude CLI 进程管理
│   ├── conversation.js  # 会话生命周期与斜杠命令
│   ├── crew/            # 多角色 Crew 协调（13 个模块）
│   ├── sdk/             # Claude CLI stream-json SDK
│   ├── terminal.js      # PTY 终端 (node-pty)
│   └── workbench/       # Git + 文件操作
├── web/                 # Vue 3 前端
│   ├── app.js           # Vue 应用入口
│   ├── build.js         # 生产构建脚本（esbuild）
│   ├── components/      # Vue 组件（25 个顶级 + crew/ 子目录）
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

## CI/CD

内置 GitHub Actions 工作流：

- **CI** (`ci.yml`): 在 Node 18/20/22 上运行测试 + 构建前端（手动触发 `workflow_dispatch`）
- **Release** (`release.yml`): 推送 `release-*` tag 时自动发布 npm 包 + Docker 镜像 + GitHub Release
