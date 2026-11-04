# Yeaft 用户指南

这个稳定 URL 是当前产品文档的精简索引。

**语言：** [English](/USER_GUIDE)

## 从这里开始

- [什么是 Yeaft？](./guide/introduction.md)
- [快速开始](./guide/getting-started.md)
- [选择代码 Agent 路径](./guide/user/choose-backend.md)

## 侧栏快捷入口

「新建聊天 / 新建任务 / 插件」默认逐行显示图标和文字。Session 列表需要滚动时，悬停快捷入口区域可在最右侧看到向上的收起箭头，点击后改为一行小图标，为列表腾出空间。紧凑布局的最右侧保留向下的展开箭头，再次点击即可恢复文字布局；不会因空间变化自动切换。布局偏好按登录用户保存在 Server，同一账号在不同桌面共享；刷新、重新登录或窗口重新获得焦点时读取最新偏好。保存失败会明确提示并恢复之前的设置。

快捷入口与「项目 / 最近」分区统一使用上下箭头：向上收起，向下展开。分区标题的操作图标和快捷入口的收展箭头在鼠标悬停对应区域或键盘聚焦时显示；触屏设备始终显示，方便直接点击。每个项目文件夹也提供独立的「新建聊天 / 新建任务」图标，在文件夹行悬停或聚焦时显示；新建的聊天或任务仍归属于该项目。

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
