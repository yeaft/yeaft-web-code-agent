# 快速开始

Yeaft 包含 browser/server control plane 和一台或多台 Agent。Agent 运行在代码所在机器并拥有执行环境。原生 Yeaft engine 已内置于 npm 包；Claude Code 与 GitHub Copilot CLI 是可选 runtime。

## 要求

- Server 与 Agent 机器使用 Node.js `>=22.5.0`
- 现代浏览器
- Yeaft Session 至少配置一个原生 LLM provider，或者为对应 conversation path 安装并登录 vendor CLI
- 生产 Server 推荐使用 Docker

以下安装命令适用于 POSIX shell，显式跳过 ONNX Runtime 的额外 CUDA 下载，仍保留 CPU 原生依赖与安装脚本。直接 npm 安装不会自动继承一键安装器策略；Windows 请用[安装指南中的 PowerShell 临时环境块](./deploy-agent.md#手动-npm-安装)，安装结束恢复原设置。完整数字人混合召回推荐 Node 24。

## 最快路径：Local mode

Local mode 在 `127.0.0.1` 启动内置 Web UI、Server 和 Agent：

```bash
ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install -g @yeaft/webchat-agent
yeaft-agent local --name local
```

浏览器打开 `http://127.0.0.1:6868`。

Local mode 不启用 Web 认证，并且只监听 loopback。它适合受信任的单机体验，不应直接暴露到公网。显式 `--name local` 选择 Agent instance 及其默认 Yeaft 目录 `~/.yeaft/instances/local/`。Local mode 创建的正式 Session 会保存到该 instance 目录，并同步到本地 Server 的 sidebar catalog；刷新页面或重启 local stack 后仍可打开原 conversation。

临时放到后台运行：

```bash
yeaft-agent local --name local --background
```

Linux 上需要开机自动运行时，安装 user-level systemd service：

```bash
yeaft-agent local install --name local --port 6868
yeaft-agent local status --name local
yeaft-agent local logs --name local
```

该 service 在用户登录时自动启动。需要机器开机后、用户尚未登录也启动一次时，执行 `sudo loginctl enable-linger $(whoami)`。移除 service 使用 `yeaft-agent local uninstall --name local`。

在另一个 shell 配置同一 instance。`llm` subcommand 不会自动推断 named instance，因此必须传 config path：

```bash
YEAFT_CONFIG="$HOME/.yeaft/instances/local/config.json"
yeaft-agent llm setup --config "$YEAFT_CONFIG"
```

使用 GitHub Copilot-backed native model：

```bash
yeaft-agent llm use github-copilot --config "$YEAFT_CONFIG" \
  --model claude-sonnet-4.5 \
  --fast gpt-4.1
```

原生 credential provider 复用本机 device/`gh auth` credential flow，不把 token 本身写入 config。Default service instance 使用 `~/.yeaft/config.json`；自定义 `YEAFT_DIR` / `--yeaft-dir` 使用 `<yeaftDir>/config.json`。

## 连接已有 Server

```bash
ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install -g @yeaft/webchat-agent
yeaft-agent --server wss://your-server.example --name my-worker --secret your-agent-secret
```

需要开机自动重连时安装为系统服务：

```bash
yeaft-agent install --server wss://your-server.example --name my-worker --secret your-agent-secret
yeaft-agent status --name my-worker
```

每个 `--name` 同时也是 Agent instance identity。除非显式覆盖，不同 instance 会解析到各自的 Agent-local Yeaft 目录。

## 从源码运行

```bash
git clone https://github.com/yeaft/yeaft-web-code-agent.git
cd yeaft-web-code-agent
ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install
npm run dev
```

打开 `http://localhost:3456`。

常用验证命令：

```bash
npm test
npm run test:e2e
npm run release:guard
npm run build
npm run docs:build
```

## 创建第一个原生 Session

1. 确认 Agent online。
2. 在统一侧栏选择 **新建聊天**。
3. 选择 **Yeaft** 和目标 Agent。
4. 选择 working directory。
5. 选择一个或多个 VP，并指定 default VP。
6. 创建 Session。
7. 创建后在 composer 选择 model/effort，在 Session settings 编辑公告，然后发送消息。

1 个 VP 适合普通代码 Agent workflow。只有确实需要独立角色时才增加 VP，并用 `@mention` 指定每个 turn 的参与者。

## 体验 Work Center

从侧栏打开 **Work Center**，或在 Yeaft Session composer 创建 WorkItem。提供具体 goal、acceptance criteria 和 working directory。Work Center 会在所选 Agent 持久化自己的 Coordinator conversation 与规划 Action graph。

## 可选 CLI runtime

要创建 Claude Code 或 GitHub Copilot conversation，请在 Agent 机器安装并登录对应 CLI。Agent 检测支持的 runtime 并在创建 UI 中展示。原生 Yeaft Session 不依赖任何 vendor CLI。

## 下一步

- [选择代码 Agent 路径](./user/choose-backend.md)
- [Yeaft Session 与 Project](./user/yeaft-session.md)
- [Work Center](./user/work-center.md)
- [Agent 与原生 CLI 参考](./agent-cli.md)
- [Provider/model 配置](./yeaft-config.md)
- [部署 Server](./deploy-server.md)
- [安装 Agent](./deploy-agent.md)
