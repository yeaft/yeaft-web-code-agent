# Claude Code Chat 模式

Claude Code Chat 是 Yeaft 最早支持的会话后端 — 把本地的 Claude Code CLI 进程包成一个 Web 端的对话界面，给你完整的 Claude Code 能力（skills、MCP、subagents、`/compact`、`/clear`），同时不丢 CLI 那套底层协议（stream-json）。

> 这是基于 **Claude Code CLI** 的 1:1 对话模式。如果想用 GitHub Copilot CLI 替代 Claude，看 [Copilot 模式](./copilot-mode.md)；如果想要多 VP 并行 + 跨任务记忆，看 [Yeaft 会话](./yeaft-group.md)。

## 前置要求

1. **Claude Code CLI 已安装**：Agent 机器上 `claude --version` 能正常返回
2. **登录态**：Agent 机器上跑过 `claude auth login`（或配了 `ANTHROPIC_API_KEY` 等环境变量）
3. **Agent 在线**：Web 端 sidebar 顶部能看到 ≥1 个 online Agent

## 创建会话

两种方式：

1. **欢迎页** — 没选会话时，主区域有"新建会话"按钮（Agent 在线时显示）
2. **侧栏** — "最近聊天"旁边的 **+** 图标

弹窗里填：
- **Agent** — 选哪台机器跑
- **Provider** — 选 **Claude Code**（默认）
- **工作目录** — 项目路径（影响 `cd` 后的工作目录、`.claude/` 配置查找位置）
- **模型**（可选）— Claude 默认会用你 `claude config` 的设置；这里可以覆盖

## 发送消息

- 底部输入框输入文本
- **Enter** 发送，**Shift+Enter** 换行
- 发送按钮在执行中变成**停止**按钮，可以随时中止当前 turn
- **草稿自动保存** — 切换会话不会丢未发的草稿

## 文件 / 图片附件

- 点输入框旁边的 **📎 回形针**，或拖文件 / 截图直接进输入框
- **粘贴图片**：Ctrl+V / Cmd+V
- 支持类型：图片（image/*）、文本、PDF、Word（doc/docx）、Excel（xls/xlsx）、JSON、Markdown、Python、JS、TS、CSS、HTML
- 发送前显示缩略图预览；发送后折叠成 "📎 2 张图片, 1 个文件" 标签，点开查看

## 斜杠命令

输入 `/` 弹自动补全菜单。常用命令：

| 命令 | 作用 |
| --- | --- |
| `/compact` | 压缩会话上下文 — 减少 token，保留要点 |
| `/clear` | 清空所有消息，重置上下文 |
| `/context` | 显示当前上下文用量明细 |
| `/cost` | 显示 token 用量和费用 |
| `/init` | 初始化项目（生成 CLAUDE.md） |
| `/doctor` | 跑诊断 |
| `/memory` | 管理 Claude 的项目记忆 |
| `/model` | 切换模型 |
| `/review` | 代码审查 |
| `/mcp` | MCP server 管理 |
| `/skills` | 列已加载 skill |
| `/btw` | 不打断当前任务的侧边追问 |

方向键导航补全菜单，**Tab** / **Enter** 选中执行。

## Compact 与 Clear 的区别

聊天头部右侧有两个按钮：

### Compact（↕ 压缩）
- **作用**：调用 Claude Code 的 `/compact`，让 Claude 用一段精简摘要替换历史上下文，节省 token
- **何时用**：上下文百分比超过 50%，且**想继续这条对话**
- **效果**：UI 里历史消息还在，但下一次发给 Claude 的实际 system context 是被压缩过的
- 压缩期间输入框被禁用，状态栏显示"正在压缩..."

### Clear（🗑 清除）
- **作用**：调用 `/clear`，彻底删除当前会话所有消息
- **何时用**：想在同一个会话里"从头开始"
- **确认**：点击后弹确认对话框，避免误操作

## 会话恢复

服务重启 / 网络断了，会话可以恢复：

- 聊天头部 **↻ 刷新按钮**重新从 Agent 同步最近 5 轮消息
- Agent 把 session 存在 `~/.claude/projects/<工作目录哈希>/sessions/<sessionId>.jsonl`
- 同一个 sessionId 可以跨重启恢复，前提是 jsonl 文件还在

## 上下文用量指示器

聊天头部右上角的百分比徽章告诉你当前上下文窗口用了多少：

- 🟢 **绿** (0–49%)：健康
- 🟡 **黄** (50–79%)：建议尽快 compact
- 🔴 **红** (80%+)：接近满载，立即 compact 或 clear

悬停看精确数值（如 `Context: 45k / 200k`）。

## 助手回复展示

Claude 的每条回复以一个 **Turn** 卡片渲染：

- **Markdown** — 代码块有语法高亮
- **复制** — 整条回复 / 单个代码块都有独立复制按钮
- **工具调用** — Read / Edit / Bash 等工具操作可视化，最新一条始终展开
- **Todo 进度** — TodoWrite 工具调用渲染成清单（✓ / ⏳ / ◯）
- **AskUserQuestion** — Claude 主动提问会渲染成交互卡片（单选 / 多选 / 自由文本 / 提交）
- **Sub-Agent 嵌套** — Agent 工具调起的 sub-agent，输出可展开查看完整流程

## 与 Copilot 模式 / Yeaft 会话 的差异

| 能力 | Claude Code | Copilot | Yeaft 会话 |
| --- | :---: | :---: | :---: |
| `/compact` 自动压缩 | ✓ | — | ✓（H2-AMS） |
| `/clear` 重置 | ✓ | ✓ | ✓ |
| 模型选择器 | ✓ | ✓ | ✓（每 VP 独立） |
| MCP 工具 | ✓ | ✓ | ✓ |
| 图片 / 文件附件 | ✓ | ✓ | ✓ |
| AskUser 权限弹窗 | ✓ | ✓ | ✓ |
| Subagent 嵌套监控 | ✓ | — | ✓ |
| Expert Panel | ✓ | — | — |
| 跨任务持久记忆 | — | — | ✓ |
| 多 VP 并行响应 | — | — | ✓ |

## 常见问题

**Agent 显示在线但创建不了会话**
- 确认 Agent 机器上 `claude --version` 能跑
- 看 Agent 日志：`yeaft-agent logs`
- 多半是 Claude CLI 没装 / 没登录

**Claude 一直 "thinking" 不出结果**
- 可能 Claude API 超时；点停止按钮，重新发
- 看 server logs 和 agent logs 的错误堆栈

**`/skills` 看不到我配的 skill**
- skills 是 Claude Code 自己的能力，放在 `~/.claude/skills/` 或项目 `.claude/skills/`
- 确认 Agent 机器上 `claude /skills` 能看到，否则 Web 端也看不到
