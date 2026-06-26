# 用户指南

> **本页现已是索引页。** 完整用户指南已拆分为更聚焦的章节，位于 [指南 → 用户指南](./guide/user/login.md)。`USER_GUIDE` 外部链接保持有效 — 通过下表挑选你需要的章节。

**语言切换**: [English](/USER_GUIDE)

## 内容去哪了？

为了让每个功能拥有自己独立的页面，原本的单文件 USER_GUIDE 已被拆成多个小章节。下表帮你定位。

### 入门

| 旧章节 | 新页面 |
| --- | --- |
| 快速开始 | [快速开始](./guide/getting-started.md) |
| 登录与注册 | [登录与注册](./guide/user/login.md) |
| 选择会话后端 | [选择会话后端](./guide/user/choose-backend.md)（新增） |

### 聊天与会话模式

| 旧章节 | 新页面 |
| --- | --- |
| Chat 模式（Claude Code） | [Chat（Claude Code）](./guide/user/chat-mode.md) |
| Copilot 模式 | [Copilot 模式](./guide/user/copilot-mode.md)（新增） |
| Yeaft Code Agent | [Yeaft Code Agent](./guide/user/yeaft-group.md)（新增） |
| 帮帮团 | [帮帮团](./guide/user/expert-panel.md) |
| 分屏模式 | [分屏模式](./guide/user/split-screen.md) |

### 工具与工作区

| 旧章节 | 新页面 |
| --- | --- |
| Workbench（终端/文件/Git） | [Workbench 工作台](./guide/user/workbench.md) |
| 设置 | [设置](./guide/user/settings.md) |
| 快捷键 | [快捷键](./guide/user/shortcuts.md) |
| 侧栏 / 会话列表 | 已并入 [Chat（Claude Code）](./guide/user/chat-mode.md) |

### Agent 与部署

| 旧章节 | 新页面 |
| --- | --- |
| Agent 安装与连接 | [Agent 安装](./guide/deploy-agent.md) |
| Agent CLI 参考 | [Agent CLI](./guide/agent-cli.md) |

### 技术参考

如需了解技术实现（Provider 系统、Yeaft 引擎、协议等），请查阅 [指南 → 技术实现](./guide/architecture.md)。

## 为什么要重构？

旧版单页 USER_GUIDE 已经变得难以维护，并且漏掉了整片重要功能：

1. **Copilot CLI 后端**（通过 ACP 协议）已经做了几个月的一等公民 Chat Provider — 旧文档完全没提
2. **Yeaft Code Agent**（多 VP 并行协作）是当前的主开发方向 — 旧文档完全没写
3. 按功能拆开后，每个页面可以直接对应单个组件，新读者不至于被巨长的页面吓退

如果你之前书签了本页的某个锚点，对应内容就在上面表格的目标章节里 — 新 URL 自此稳定。
