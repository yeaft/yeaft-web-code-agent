# Yeaft 用户指南

这个稳定 URL 是当前产品文档的精简索引。

**语言：** [English](/USER_GUIDE)

## 从这里开始

- [什么是 Yeaft？](./guide/introduction.md)
- [快速开始](./guide/getting-started.md)
- [选择代码 Agent 路径](./guide/user/choose-backend.md)

## 侧栏快捷入口

「新建聊天 / 新建任务 / 插件」默认逐行显示图标和文字。Session 列表需要滚动时，列表底部会出现「收起快捷入口」；点击后改为一行小图标，为列表腾出空间。收起状态始终保留「展开快捷入口」，再次点击即可恢复文字布局；不会因空间变化自动切换。状态仅保留在当前侧栏，刷新页面恢复展开。

## 原生 Yeaft

- [Session 与 Project](./guide/user/yeaft-session.md)
- [Work Center](./guide/user/work-center.md)
- [Provider 与 model 配置](./guide/yeaft-config.md)
- [设置](./guide/user/settings.md)

## CLI conversation 与工作区

- [Claude Code conversation](./guide/user/chat-mode.md)
- [GitHub Copilot conversation](./guide/user/copilot-mode.md)
- [Expert Panel](./guide/user/expert-panel.md)
- [分屏](./guide/user/split-screen.md)
- [Workbench](./guide/user/workbench.md)
- [快捷键](./guide/user/shortcuts.md)

## 安装与运维

- [部署 Server](./guide/deploy-server.md)
- [安装 Agent](./guide/deploy-agent.md)
- [Agent 与原生 CLI 参考](./guide/agent-cli.md)
- [登录与注册](./guide/user/login.md)
- [安全](./guide/security.md)
- [管理员仪表板](./guide/features-dashboard.md)

## 技术参考

- [架构](./guide/tech/architecture.md)
- [CLI provider 系统](./guide/tech/providers.md)
- [原生 Yeaft engine](./guide/tech/yeaft-engine.md)
- [已退役的 H2-AMS 实现](./guide/tech/yeaft-memory.md)
- [原生 LLM 层](./guide/tech/yeaft-llm.md)
- [WebSocket 协议](./guide/tech/wire-protocol.md)
- [配置参考](./guide/reference/config-reference.md)
- [常见问题](./guide/faq.md)

`docs/notes/` 与 `docs/work-center/` 下的内部设计、迁移记录是 maintainer reference，不是公开 feature contract。
