# Copilot 模式

Copilot 模式让你用 GitHub Copilot CLI 作为 AI 后端，在同一个 Web 界面里跟 Claude Code Chat 共存。如果你已经有 GitHub Copilot 订阅，这是开箱用 GPT-5 / Claude Sonnet 4.x / Gemini 2.5 Pro 等多家模型的最简单方式。

## 前置要求

1. **GitHub Copilot CLI 已安装并登录** — 在 Agent 所在机器上：
   ```bash
   # 安装（参考 GitHub 官方文档）
   gh extension install github/gh-copilot
   # 或独立 CLI（推荐）：npm install -g @github/copilot

   # 登录
   copilot login
   ```
   登录后 `copilot --version` 应返回 **>= 1.0.59**（依赖 ACP 协议）。
2. **可选环境变量**：
   - `COPILOT_BIN` — 指定 `copilot` 可执行文件路径（默认从 `$PATH` 找）
   - `COPILOT_YOLO=1` — 全局自动批准所有工具调用（**不推荐**，建议用会话级 Allow all tools）

> Yeaft Web 端不会替你下载或安装 Copilot CLI — 这是用户层工具，请按 GitHub 官方流程装好。

## 创建 Copilot 会话

1. 侧边栏点 **+** 新建会话
2. 会话弹窗里：
   - **Agent** — 选一台 Agent
   - **Provider** — 下拉选 **Copilot**
   - **工作目录** — 项目路径
   - **模型** — 从 Copilot 提供的列表里选（见下）
   - **Allow all tools**（可选）— 勾选后自动批准所有工具调用，不再弹窗

## 模型选择器

Copilot 模型列表是**动态拉取**的 — Yeaft 首次启动 `copilot --acp` 时，从 ACP `session/new` 响应里抓真实的可用模型清单（包括 vendor、定价类别、preview 标记）。在你的 Copilot 订阅可用前提下，常见模型包括：

| Vendor | 典型模型 |
| --- | --- |
| Anthropic | Claude Sonnet 4.6 / 4.5、Claude Haiku 4.5、Claude Opus 4.5–4.8 |
| OpenAI | GPT-5.5 / 5.4 / 5.4-mini、GPT-5.3 Codex、GPT-5 Mini |
| Google | Gemini 2.5 Pro |

> **模型在会话中途不能改**。ACP 协议目前不支持热切换模型 — 想换模型请新建会话。

## 与 Claude Code Chat 的差异

| 能力 | Claude Code | Copilot |
| --- | :---: | :---: |
| `/compact` 自动压缩上下文 | ✓ | — |
| `/clear` 重置会话 | ✓ | ✓ |
| 模型选择器 | ✓ | ✓ |
| MCP 工具 | ✓ | ✓ |
| 图片 / 文件附件 | ✓ | ✓ |
| AskUser 权限弹窗 | ✓ | ✓ |
| Subagent 嵌套监控 | ✓ | — |
| Expert Panel（帮帮团） | ✓ | — |
| 会话历史恢复 | ✓ | ✓（基于 `~/.copilot/session-store.db`） |

UI 会根据 provider 的 capabilities 自动隐藏不支持的按钮 — 你看不到的功能就是这个 provider 没有，不是 bug。

## 工具权限：ask-user 弹窗

默认情况下（没勾 Allow all tools），Copilot 每次要执行 bash 命令、写文件等敏感操作时，都会**弹一个确认框**问你：

> Copilot wants to run `bash`. Allow?

按钮通常是 "Allow once" / "Allow always" / "Reject"，具体选项由 Copilot 后端返回。点击后，你的回答会通过 ACP 的 `session/request_permission` 协议回到 Copilot 子进程。

**最佳实践：**
- 临时探索性会话 — 默认逐次确认，谨防误操作
- 长任务（如批量重构、跑测试套件）— 在新建会话时勾 Allow all tools，省去频繁确认

## 会话历史

Copilot 把会话存在 `~/.copilot/session-store.db`（SQLite）。Yeaft 会：

- 在新建会话弹窗里列出该工作目录下的旧会话，点击即可 resume
- Resume 时调用 ACP `session/load`（如果 Copilot CLI 支持）；否则提示降级为新会话
- 把 `forge_trajectory_events` 表里的工具调用记录转成 `claude_output` 协议格式，在前端复用同一套渲染管线

> **环境变量**：`COPILOT_DB_PATH` 可覆盖默认 DB 路径，方便多账号 / 自定义存储。

## 故障排查

**"copilot ACP init failed: ... Run `copilot login` and ensure CLI >= 1.0.59"**
- 在 Agent 机器上执行 `copilot --version`，确认 >= 1.0.59
- 执行 `copilot login` 完成 GitHub OAuth 登录
- 如果 PATH 里没有 copilot：设环境变量 `COPILOT_BIN=/full/path/to/copilot`

**模型选择器是空的 / 只显示静态 fallback 列表**
- 新建一次 Copilot 会话；第一次连上后会缓存真实模型列表
- 静态 fallback 列表见 `agent/providers/copilot-models.js` 的 `FALLBACK_COPILOT_MODELS`

**"Copilot CLI does not advertise loadSession capability — starting a new session instead of resuming"**
- Copilot CLI 版本太老，没有 session resume 能力；升级到最新版

**Ask-user 弹窗弹出后页面卡住**
- 可能 Copilot 子进程崩溃了；这种情况 Yeaft 会自动 drain 所有 pending 弹窗，刷新一下页面应该就好
- 看 Agent 日志：`yeaft-agent logs`

## 进阶：跟 Yeaft 引擎里的 `github-copilot` credential 别搞混

注意区分两个不同的"Copilot"：

- **本章讲的 Copilot 模式** — Agent 启动一个 `copilot --acp` 子进程，**进程**充当 AI 后端，模型由 Copilot CLI 自己决定
- **Yeaft 引擎的 `github-copilot` credential provider** — 这是 Yeaft 会话 用的 — 由 Yeaft 自己拿 GitHub OAuth token 直接调 Copilot API，**不**启动 `copilot --acp` 子进程

两者用同一个 GitHub 账号鉴权，但走不同的代码路径。前者面向 "我想用 Copilot CLI 替代 Claude CLI"，后者面向 "我想让 Yeaft 会话 里的某个 VP 用 Copilot 拿到的模型"。
