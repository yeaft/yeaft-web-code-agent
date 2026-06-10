# 快速开始

Yeaft 由两个组件构成：

1. **Server** —— 中心枢纽（Express + WebSocket），每个部署只需一份
2. **Agent** —— 在每台你想驱动的机器（笔记本、VPS、沙箱容器）上跑。Group Mode 的 Yeaft 引擎 **已内置** 在 agent 里；Claude / Copilot CLI 是 **可选** 的，看你要用哪种后端

## 方式 A：npm 安装（仅 Agent）

如果你已经有一个运行中的服务器，只需安装 Agent：

```bash
# 全局安装 Agent
npm install -g @yeaft/webchat-agent

# 连接到服务器
yeaft-agent --server wss://your-server.com --name my-worker --secret your-secret

# 升级到最新版
yeaft-agent upgrade
```

Yeaft 引擎开箱即用 —— 只要在 `~/.yeaft/config.json` 配好至少一个 LLM provider（见 [Yeaft 引擎配置](./yeaft-config.md)）。如果要用 Claude Code / Copilot 聊天模式，在 agent 机器上装对应 CLI 并登录，agent 启动时会自动检测。完整对照见 [Agent 安装](./deploy-agent.md)。

## 方式 B：完整开发环境

```bash
git clone https://github.com/yeaft/claude-web-chat.git
cd claude-web-chat

# 安装所有依赖
npm install

# 启动服务器 + Agent（开发模式，无需认证）
npm run dev
```

然后浏览器打开 `http://localhost:3456`

## 下一步

- [选择会话后端](./user/choose-backend.md) —— Claude Code vs Copilot vs Yeaft Group
- [部署服务器 (Docker)](./deploy-server.md) —— 生产环境部署指南
- [安装 Agent](./deploy-agent.md) —— 连接工作机器
- [Yeaft 引擎配置](./yeaft-config.md) —— `~/.yeaft/config.json` 字段说明
- [Chat（Claude Code）](./user/chat-mode.md) —— 开始使用聊天界面
- [Yeaft Group 模式](./user/yeaft-group.md) —— 多 VP 协作
