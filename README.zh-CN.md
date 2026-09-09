# Yeaft Web Code Agent

[![CI](https://github.com/yeaft/yeaft-web-code-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/yeaft/yeaft-web-code-agent/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@yeaft/webchat-agent)](https://www.npmjs.com/package/@yeaft/webchat-agent)
[![Docker](https://img.shields.io/badge/docker-ghcr.io-blue)](https://ghcr.io/yeaft/yeaft-web-code-agent)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.5-green)](package.json)

[English](README.md) | [中文](README.zh-CN.md) | [文档站](https://yeaft.github.io/yeaft-web-code-agent/zh-CN/)

Yeaft 是运行在自有机器上的代码 Agent 的 Web 控制面。同一个浏览器可以连接多台 Agent，打开 Claude Code 或 GitHub Copilot CLI 对话，也可以运行 Yeaft 原生多 provider 引擎，使用持久 Session、可复用的 Virtual Person（VP）、有边界的记忆、Project 和 Work Center。

**在线体验：** [cc.yeaft.com](https://cc.yeaft.com)

![Yeaft Session 中的实现与独立审查交接](docs/images/zh-CN/session.png)

## 为什么使用 Yeaft

- **让执行靠近代码。** Shell、文件、Git、provider、凭据、Session 数据和 Work Center 状态都留在已连接的 Agent 机器。Server 负责用户认证和 Browser ↔ Agent 中继。
- **每个任务选合适的 runtime。** Claude Code CLI、基于 ACP 的 GitHub Copilot CLI 与 Yeaft 原生引擎共用一套 Web UI，但文档不会假装它们行为完全相同。
- **一个 Session 从 1 个 VP 扩到多个 VP。** 原生 Yeaft 只有 Session 这一种协作单元：1 个 VP 做专注任务，多个 VP 可并行承担实现、审查、调研或设计。
- **有意识地携带上下文。** H2-AMS 按 user、VP、Session 和相关 Project Session scope 召回记忆，不把一份全局 transcript 无差别塞给所有角色。
- **把长任务移出单次 chat turn。** Work Center 将目标持久化为 WorkItem，由 AI 规划经过校验的 Action graph，分配 VP、记录 Run 和工具证据，并能在浏览器断开或 Agent 重启后继续恢复。

## 产品模型

| 概念 | 准确定义 |
| --- | --- |
| **Agent** | 运行在笔记本、VM、服务器或容器上的 Node.js worker。它拥有执行环境、本机配置和原生 Yeaft 运行数据。 |
| **Session** | 原生 Yeaft 的持久对话单元，包含 1..N 个 VP、一个消息时间线、工作目录、模型 override、公告和记忆 scope。 |
| **VP（Virtual Person）** | 可复用角色，包含双语元数据、traits、persona prompt，以及 primary/fast model hint。VP 是角色，不是另一台机器。 |
| **Project** | 浏览器中对原生 Session 的分组。Project instruction 作用于成员 Session；同一 Agent 上的兄弟 Session 可召回只读的 scoped summary，并保留来源身份。 |
| **Work Center** | Agent 级持久任务系统。WorkItem 包含合同和对话；规划出的 Action 通过有 fence 的 Run 执行，记录状态、证据、重试、人工输入和 review 结论。 |

内部 wire type 和存储路径仍有 `group`、`unify_*`、`claude_output` 等历史名字用于兼容；它们不是当前产品术语。

## 三条执行路径

| 路径 | Runtime 与优势 | 重要边界 |
| --- | --- | --- |
| **Claude Code** | 每个 conversation 一个 Claude Code CLI 进程；支持 Claude Code 工具、skills、MCP、compact/clear、sub-agent event 和 resume | 本机必须安装并登录 Claude Code CLI |
| **GitHub Copilot** | 每个 conversation 一个 `copilot --acp` 进程；使用 Copilot model catalog 和明确的工具权限确认 | 本机必须安装 Copilot CLI，并拥有可用的 GitHub Copilot 账号 |
| **Yeaft Code Agent** | `yeaft-agent` 内的原生引擎；1..N 个 VP、33 个内置工具、多 provider 路由、H2-AMS 记忆、Project、sub-agent 和 Work Center 交接 | 不模拟 Claude Code 或 Copilot CLI 的所有命令和行为 |

Web UI 还提供终端、Git 状态与 diff、文件浏览/编辑、端口代理、CLI conversation 分屏、Claude Code conversation 的 Expert Panel、用量管理、light/dark theme，以及中英文切换。

### Markdown 消息中的数学公式

Markdown 消息通过本地 KaTeX 渲染 LaTeX 公式：行内使用 `$E=mc^2$` 或 `\(E=mc^2\)`，独立公式使用 `$$...$$` 或 `\[...\]`（可包含多行）。行内代码和代码块保持原样，不支持的公式保留为可读源码，长公式在窄屏中可横向滚动。支持范围是 KaTeX 数学语法，不是完整 LaTeX 文档；运行时无需 CDN。

## 当前原生 Yeaft 能力

### Session 与 Project

- 创建 Session 时选择 Agent、工作目录、roster 和 default VP；创建后在 composer 选择 model/effort，在 Session settings 编辑公告。
- 用 `@mention` 指定一个或多个 VP；选中的 VP 独立执行同一个 turn，也能通过 `RouteForward` 明确交接给同 Session 的其他 VP。
- 搜索和分页加载持久 Session history，检查每个 VP turn、运行中的后台任务、模型选择、记忆召回、工具调用、token 用量和 stop reason。
- 将原生 Session 放入 Project，在 Project 与 Recents 之间拖动，并为所有成员 Session 设置共享 Project instruction。
- 从当前 Session 创建持久 WorkItem；来源 Session 身份由 runtime 强制写入。

### Provider、工具与记忆

- 原生 adapter 支持 Anthropic Messages 和 OpenAI Responses 两种协议。
- Provider 可以使用静态 API key，也可以使用 GitHub Copilot 动态凭据。支持 per-model protocol、context window、output limit 和 reasoning effort 元数据。
- 当前原生 registry 提供 **33 个内置工具**，覆盖文件/patch、shell 与后台任务、Git worktree、搜索、Web、图片、notebook、计划、持久 WorkItem 创建，以及 sub-agent/VP 编排；Skills 和 MCP 可以继续扩展工具表。
- H2-AMS 组合 resident summary、recent context 与按需全文召回。Dream 在后台提取持久 segment；记忆始终遵守 scope 和 owner 边界。

### Work Center

![Work Center 中的持久 WorkItem、主对话与 Action graph](docs/images/zh-CN/work-center.png)

Work Center 用来处理必须跨越一次交互 turn 的目标。当前实现包括：

- 持久 WorkItem 合同：`goal`、acceptance criteria、工作目录、attachments 和 memory reuse policy；
- WorkItem 级 Coordinator conversation，用于查询状态、追加指导、修改合同和 replan；
- AI 规划并校验 Action graph：依赖关系、唯一 final acceptance gate，以及配置允许范围内的并发 Action；
- auto/pool/fixed VP 分配、model/effort policy、review 角色隔离、retry/waiting/failed 状态和明确的人工恢复输入；
- shared、read-only、isolated-write、integrate workspace policy，有 fence 的 Run，以及可保留的工具证据；
- Agent-local SQLite 持久化与重启恢复。WorkItem 会关联来源 Session，但不存放在 Session 内部。

Work Center **不等于**任意无人值守部署。外部副作用仍受所选 Agent/VP 可用工具、仓库规则、凭据和交付指令约束。

## 快速开始

### 本机单机体验

先安装发布的 Agent 包，再在 loopback 上启动内置 Web UI、Server 和 Agent：

```bash
npm install -g @yeaft/webchat-agent
```

`yeaft-agent local` 使用 named Agent instance。不传 `--name` 时，name 是经过清理的计算机 hostname；这里显式指定：

```bash
yeaft-agent local --name local
```

浏览器打开 `http://127.0.0.1:6868`。Local mode 关闭 Web 认证且只绑定 loopback，适合受信任的个人工作站，不应直接作为公网部署。

在另一个 shell 配置同一 instance。`llm` subcommand 不会自动推断它，因此必须显式传 config path：

```bash
YEAFT_CONFIG="$HOME/.yeaft/instances/local/config.json"
yeaft-agent llm setup --config "$YEAFT_CONFIG"
```

原生 GitHub Copilot provider 可以复用本机 `gh auth` / device credential，不把 token 本身写进 instance config：

```bash
yeaft-agent llm use github-copilot --config "$YEAFT_CONFIG" \
  --model claude-sonnet-4.5 \
  --fast gpt-4.1
```

Default service instance 是例外，使用 `~/.yeaft/config.json`。自定义 `YEAFT_DIR` / `--yeaft-dir` 时，应改为对应的 `<yeaftDir>/config.json`。

Claude Code 和 Copilot CLI conversation 仍需要分别安装并登录对应 CLI。

### 连接已有 Server

```bash
npm install -g @yeaft/webchat-agent
yeaft-agent --server wss://your-server.example --name my-worker --secret your-agent-secret
```

如果机器需要开机后自动重连，可以安装为系统服务：

```bash
yeaft-agent install --server wss://your-server.example --name my-worker --secret your-agent-secret
yeaft-agent status --name my-worker
```

### 启用 Browser Runtime（Linux x64）

Workbench 浏览器查看器目前支持 Linux x64 Agent。Server 默认开放浏览器路由，但浏览器二进制仍然需要在每个 Agent 上由用户明确启用：

1. 在 Yeaft 中选择 Agent，打开 **Workbench → 浏览器**。浏览器未就绪时，能力卡显示**需要启用**，面板会显示固定版本 Chrome for Testing 的下载大小。
2. 点击一次**启用浏览器**。Yeaft 会显示真实下载百分比，在该 Agent instance 的数据目录中完成浏览器校验和安装，持久化启用配置，执行媒体链路探测，刷新 capability，并自动打开 Viewer；不需要重启 Agent，也不需要再点一次启用。

仅安装 Yeaft 或 Agent 不会触发任何下载。管理员可以设置 `BROWSER_RUNTIME_ENABLED=false` 关闭整个浏览器能力。Agent 媒体 probe 只验证 Chrome、tab capture、VP8 和本机 WebRTC，无法证明远程 Web Viewer 到 Agent 具备可达的 ICE 路径。`BROWSER_STUN_URLS` 可选，用于 direct ICE。生产环境如果需要跨 NAT 或受限网络连接，应部署 TURN，并配置 `BROWSER_TURN_URLS` 和 `BROWSER_TURN_SECRET`；禁止 direct candidate 时设置 `BROWSER_ICE_TRANSPORT_POLICY=relay`。仓库在 [`deploy/browser-turn/`](deploy/browser-turn/README.md) 提供了加固的自托管模板。

无人值守安装必须在所有命令中使用同一个 named instance：

```bash
yeaft-agent browser install --name my-worker
yeaft-agent browser probe --name my-worker
yeaft-agent browser enable --name my-worker
yeaft-agent restart --name my-worker   # managed Agent service
yeaft-agent browser status --name my-worker
```

`browser probe` 才是 readiness 检查；`browser status` 只报告配置和安装状态。前台运行的 Agent 在 CLI enable 后需要手动停止并重新启动。ICE/TURN、生命周期和故障排查见 [Workbench：启用 Browser Runtime](docs/zh-CN/guide/user/workbench.md#启用-browser-runtime)。

### 从源码运行

```bash
git clone https://github.com/yeaft/yeaft-web-code-agent.git
cd yeaft-web-code-agent
npm install
npm run dev
```

然后打开 `http://localhost:3456`。

## CLI 边界

npm 包安装两个主要命令：

- `yeaft-agent`：运行/管理 Web-connected worker 与 local mode。它的 `llm` subcommand 修改显式 `--config` 路径，未传时固定使用 `~/.yeaft/config.json`；不会推断正在运行的 named instance。
- `yeaft`：直接从终端运行原生引擎。One-shot/interactive text mode 可以通过 `--session-id` 指向一个**已有**正式 Web Session；`stream-json` 也允许用新的已校验 ID 作为 ad-hoc CLI conversation key。其第一条 JSONL user prompt 可提供 `roster`（或内容完全相同的 `vps` 别名）及可选的 `defaultVpId` 来创建正式 Session；CLI 会写入规范的 `session.json` 并输出聚合 VP result。后续 prompt 不能修改该 roster。

机器可读的 ad-hoc CLI conversation 示例：

```bash
printf '%s\n' '{"type":"user","message":{"role":"user","content":"检查这个仓库并告诉我测试命令。"}}' \
  | yeaft --session-id session_docs \
      --cwd "$PWD" \
      --input-format stream-json \
      --output-format stream-json
```

这个 ID 用来隔离持久 CLI message，不代表新建了 Web Session。要执行已有 multi-VP Session，请传其现有 Session ID。完整参数与 JSONL 边界见 [Agent 与原生 CLI 参考](docs/zh-CN/guide/agent-cli.md)。

## 架构与所有权

```text
Browser（Vue 3 + Pinia）
        │ 经过认证的 WebSocket relay（生产环境使用 WSS）
        ▼
Server（Express + ws + SQLite）
        │ owner check、中继与浏览器 Session catalog
        ▼
Agent（运行在代码所在机器的 Node.js）
        ├── Claude Code CLI provider
        ├── GitHub Copilot CLI provider（ACP）
        ├── 原生 Yeaft engine
        │   ├── Session + VP 编排
        │   ├── Anthropic / OpenAI Responses adapter
        │   ├── 33 个内置工具 + Skills + MCP
        │   ├── H2-AMS memory + Dream maintenance
        │   └── Work Center（WorkItem → Action → Run）
        └── Workbench（terminal、Git、files、port proxy）
```

Server 拥有认证、用户可见的 catalog metadata 和 relay state。Agent 拥有代码执行与 Agent-local Yeaft runtime data。Session 的 `workDir` 只选择 project context，不会变成 Session transcript、memory、tasks 或 Work Center records 的存储根。

## 配置与部署

- **Runtime 要求：** Node.js `>=22.5.0`；release CI 使用 Node.js 24。
- **Agent 配置：** 每个 Agent instance 解析自己的 Yeaft 目录和 `config.json`。Provider credential 不是 server-global 设置。
- **Server：** 生产环境推荐 Docker。必须替换默认认证 secret、创建首个管理员、在反向代理终止 TLS，并持久化 Server data directory。
- **注册：** 当前 production route 支持开放注册。邀请管理代码仍保留，但 `server/auth/register.js` 目前不要求 invitation code。
- **安全边界：** 产品支持 password/JWT、可选 TOTP 与邮件验证、用户级 Agent secret 和 owner-checked relay。当前 Web/Agent peer 会协商 plaintext JSON payload，因此生产部署必须使用 HTTPS/WSS；TweetNaCl payload encryption 只作为 legacy peer compatibility fallback。Raw debug trace、tool output、attachment 和本机 provider credential 都应视为敏感 Agent 数据。

详细文档：

- [快速开始](docs/zh-CN/guide/getting-started.md)
- [Yeaft Session 与 Project](docs/zh-CN/guide/user/yeaft-session.md)
- [Work Center](docs/zh-CN/guide/user/work-center.md)
- [Provider 与 model 配置](docs/zh-CN/guide/yeaft-config.md)
- [架构](docs/zh-CN/guide/tech/architecture.md)
- [安全](docs/zh-CN/guide/security.md)
- [Server 部署](docs/zh-CN/guide/deploy-server.md)
- [Agent 安装](docs/zh-CN/guide/deploy-agent.md)

## 开发与验证

```bash
npm install
npm test                 # 核心 Vitest suite
npm run test:e2e         # Playwright browser suite
npm run release:guard    # Server/Agent import guard + startup smoke
npm run build            # production Web assets
npm run docs:build       # 中英文 VitePress 文档站
```

当前 revision 的核心 manifest 包含 49 个 Vitest 文件 / 499 个可列出的测试，E2E 目录包含 11 个 Playwright spec 文件。这些数字用于说明当前规模，不是兼容承诺。

仓库使用 ES modules、Node.js 22.5+、带 JSDoc 的纯 JavaScript、Vue 3 + Pinia、Express + `ws`、SQLite、esbuild、Vitest、Playwright 和 VitePress。

## 文档与兼容

面向用户的文档保持中英文双语。英文页面位于 `docs/guide/`，中文页面位于 `docs/zh-CN/guide/`。`docs/notes/` 和 `docs/work-center/` 下的内部设计记录可能描述迁移或历史决策，不应当作公开 feature contract。

Canonical repository 是 [github.com/yeaft/yeaft-web-code-agent](https://github.com/yeaft/yeaft-web-code-agent)。历史 package name 和 image alias 只在修改会破坏现有安装的地方保留。

## 贡献

请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。保持小而正确的 diff，尊重兼容边界，补齐定向测试，并根据当前实现核验每一条文档 claim。

## 免责声明

Yeaft 是独立开源项目，与 Anthropic、OpenAI、GitHub 或其他 model provider 无隶属或官方背书关系。Provider 和 model 名称属于各自权利方。

## License

[MIT](LICENSE)
