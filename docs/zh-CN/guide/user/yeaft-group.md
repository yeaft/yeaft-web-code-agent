# Yeaft Code Agent

**Yeaft Code Agent** 是 Yeaft 原生的 Web 端代码 Agent 体验。它运行在本机 `yeaft-agent` 内，不依赖 Claude Code CLI 或 GitHub Copilot CLI，核心编排单元是 **Session**：一个 Session 可以放 1 个或多个 VP（Virtual Person），每个 VP 都有独立人格、模型、记忆和工具权限。

本页文件名仍叫 `yeaft-group.md` 是为了保持旧链接兼容；产品概念现在统一叫 **Yeaft Code Agent**。在引擎内部，唯一编排单元叫 **Session**。

## 它适合做什么

Yeaft Code Agent 面向需要 Web 控制台 + 本地执行 Agent 的代码工作：

- **实现和审查代码**：文件、shell、git/worktree、notebook、搜索、patch 工具都在 Agent 机器上执行。
- **多视角并行思考**：把 PM、架构师、开发、审查、测试、设计等 VP 放进同一个 Session。
- **长期项目上下文**：H2-AMS 记忆会跨 Session 召回决策、偏好和历史工作。
- **混用 provider 和模型**：Anthropic、OpenAI Responses、GitHub Copilot API 凭证、Azure/OpenAI-compatible 网关、本地 proxy 都能接入。
- **一份 Web UI 管多台机器**：每个 `yeaft-agent` 把一台 laptop、VM 或容器接到 server，并通过 WebSocket 安全暴露工作区能力。

## 和其他后端的区别

| 路径 | 执行模型 | 最适合 |
| --- | --- | --- |
| **Claude Code Chat** | 每个 1:1 chat 一个 Claude Code CLI 子进程 | 最大化兼容 Claude Code、Claude skills/MCP 生态 |
| **Copilot 模式** | 每个 1:1 chat 一个 `copilot --acp` 子进程 | 复用 GitHub Copilot 权益、ACP 权限弹窗、快速切模型 |
| **Yeaft Code Agent** | `yeaft-agent` 内置 Yeaft 引擎，一个 Session 里 1..N 个 VP | 多 provider 代码 Agent、持久记忆、多 VP 协作、自定义工具策略 |

Yeaft Code Agent 不是某个 vendor CLI 的壳。它自己拥有 query loop、工具注册表、记忆召回、provider 路由和 VP 编排，因此也是接入非 Claude provider 或专用 proxy 的主路径。

## 心智模型：Session、VP、turn、tool

- **Session** 是持久协作空间，包含标题、公告、roster、默认 VP、消息历史、调试状态和记忆 scope。
- **VP** 是可配置虚拟人，拥有 persona、model ref、工具 allowlist、记忆和可选子 Agent。
- **Turn** 是一次用户消息被路由到一个或多个 VP。多个 VP 被点名时会并行运行。
- **Tool** 是 Yeaft 引擎显式暴露的能力，例如编辑文件、执行 shell、Web 搜索或派生子 Agent。

一个只有 1 个 VP 的 Session 就是专注型代码助手；当你需要并行设计评审、测试计划、产品批判或实现/审查分离时，再加入更多 VP。

## 首次设置

### 1. 安装并连接 Agent

```bash
npm install -g @yeaft/webchat-agent
yeaft-agent --server wss://your-server.com --name worker-1 --secret your-secret
```

Agent 运行在拥有代码的机器上。浏览器连接 server，server 把加密流量转给 Agent；Agent 读文件、跑命令、调用 provider，并把事件流式传回浏览器。

### 2. 配置至少一个 LLM provider

Yeaft Code Agent 从 `~/.yeaft/config.json` 读取 provider 配置。最快路径是 Agent CLI：

```bash
yeaft-agent llm setup
```

使用 GitHub Copilot 凭证，但不把 token 写进配置：

```bash
yeaft-agent llm use github-copilot --model claude-sonnet-4.5 --fast gpt-4.1
```

或接入 OpenAI-compatible provider：

```bash
OPENAI_KEY=sk-... yeaft-agent llm use openai-compatible \
  --name openai \
  --base-url https://api.openai.com/v1 \
  --api-key-env OPENAI_KEY \
  --model gpt-5
```

完整示例见 [Yeaft 引擎配置](../yeaft-config.md)，包括 Anthropic、Azure OpenAI、GitHub Copilot 动态凭证、自建 OpenAI-compatible gateway。

### 3. 打开 Yeaft 页面

Web UI 侧边栏切到 **Yeaft**。如果没有 Agent 在线，onboarding 会引导你去设置 Agent。Agent 连上且有 provider 后，就可以创建 Session。

## 创建和使用 Session

1. 进入 **Yeaft → + 新建 Session**。
2. 起名，例如 `Refactor auth flow` 或 `Release review`。
3. 从 roster 里选择一个或多个 VP。
4. 选择默认 VP。没有 `@mention` 的消息会发给它。
5. 发送消息。用 `@VPName` 定向给某些 VP。

示例：

```text
@Architect @Reviewer 先评审一下这个迁移方案，再决定是否实现。
```

```text
@Dev 做最小安全修复，加测试并开 PR。
```

```text
@Tester 看这个 diff 的回归风险，建议定向测试。
```

当多个 VP 被点名时，coordinator 会把同一个用户 turn fan-out 出去。每个 VP 构建自己的 prompt、召回自己的记忆、调用自己配置的 provider/model、执行允许的工具，并把结果流式写回同一个 Session timeline。

## Yeaft Code Agent 的工具

Yeaft 内置 30+ 工具，是否可用由 VP 配置和引擎 mode 共同控制。

- **文件与编辑**：`file_read`、`file_write`、`file_edit`、`apply_patch`、`notebook_edit`
- **搜索与发现**：`grep`、`glob`、`list_dir`、`history_search`
- **执行**：`bash`、`js_repl`、`enter_worktree`、`exit_worktree`
- **网络与媒体**：`web_fetch`、`web_search`、`image_generation`、`view_image`
- **计划与任务**：`start_plan`、`todo_write`
- **Agent 编排**：`agent`、`send_message`、`wait_agent`、`list_agents`、`close_agent`、`route_forward`
- **外部集成**：`ask_user`、`skill`、`mcp_tools`

代码任务的典型循环是：读文件 → 做计划 → 修改 → 跑定向测试 → 跑更大范围测试 → 汇报风险 → 交给 review。多 VP Session 可以把这个流程拆得很明确：一个 VP 实现，一个 VP review，一个 VP 专注测试。

## Provider 集成模型

Yeaft 有两层 provider：

1. **ChatProvider 层**：给 Claude Code CLI、Copilot CLI 这类 1:1 chat 后端用，把事件归一到共享 Web 渲染协议。
2. **Yeaft LLM adapter 层**：给原生 Yeaft 引擎用，也就是 Yeaft Code Agent 的主路径。每个 VP/model 请求由 `AdapterRouter` 路由到 Anthropic 或 OpenAI Responses 兼容 adapter。

原生 Yeaft 模型配置示例：

```json
{
  "providers": [
    {
      "name": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "apiKey": "sk-ant-...",
      "protocol": "anthropic",
      "models": ["claude-sonnet-4-20250514"]
    },
    {
      "name": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-...",
      "protocol": "openai-responses",
      "models": ["gpt-5", "gpt-5-mini"]
    },
    {
      "name": "github-copilot",
      "baseUrl": "https://api.githubcopilot.com",
      "credentialProvider": "github-copilot",
      "protocol": "openai-responses",
      "models": [
        { "id": "claude-sonnet-4.5", "protocol": "anthropic" },
        "gpt-5"
      ]
    }
  ],
  "primaryModel": "anthropic/claude-sonnet-4-20250514",
  "fastModel": "openai/gpt-5-mini"
}
```

一个 VP 可以用 `anthropic/claude-sonnet-4-20250514`，另一个用 `openai/gpt-5`，第三个用 `github-copilot/claude-sonnet-4.5`。per-model protocol override 允许同一个 provider 同时暴露 Claude 系和 GPT 系模型。

## 记忆设计

Yeaft Code Agent 使用 **H2-AMS** 记忆：

1. **Turn 前召回**：对相关 scope 做全文搜索，把命中的记忆注入 system prompt。
2. **Active Memory Set**：常驻摘要、最近上下文、按需记忆按预算进入本轮。
3. **Turn 后修正**：引擎可在 turn 后调整 active set。
4. **Dream 维护**：后台任务把对话历史切成原子 markdown 记忆段。

记忆按 scope 隔离，而不是随便全局共享：

- `user/<userId>` 存用户偏好和 profile。
- `vp/<vpId>` 存单个 VP 的长期知识。
- `session/<sessionId>` 存 Session 共享上下文。
- `feature/<featureId>` 存项目/feature 级协作记忆。
- `global` 存全局事实。

这就是为什么 Reviewer VP 可以记住你的 review 标准，Product VP 可以记住产品约束，而它们又能共享当前 Session 的任务事实。

## 推荐工作流

### 单 VP 代码助手

创建一个只有默认 VP 的 Session，像传统 coding agent 一样使用它，但拥有 Yeaft 的记忆和 provider 路由。适合实现、小 bug 修复、文档修改、在同一个 repo 上反复工作。

### PM + Developer + Reviewer

建三个 VP：

- PM VP 澄清用户意图和验收标准。
- Developer VP 做最小安全实现。
- Reviewer VP 检查架构、边界 case 和测试。

设计讨论时 mention 三个；实现时只 mention `@Dev`；diff 出来后 mention `@Reviewer`。

### Provider 对比

给两个 VP 相同 persona，但配置不同模型。让它们评审同一个设计或 bug。这样可以在真实任务上比较 Anthropic、OpenAI、Copilot 或本地 gateway。

### 长期项目记忆

为重要项目保留一个 Session。加入项目专用 VP，让记忆逐渐积累命名规则、部署约束、决策历史和 review 偏好。

## 调试与可观测性

Yeaft 页面有原生引擎 debug panel，可查看：

- 本轮由哪个 provider/model 处理；
- 召回了哪些记忆段；
- 发给模型的 messages 和 tools；
- tool call 输入/输出；
- token 和 stop reason 元数据。

如果 VP 的回答奇怪，先看记忆召回和模型路由。如果 provider 报错，检查 `~/.yeaft/config.json`、Agent 日志和 Yeaft LLM 层错误。

## 设计原则

Yeaft Code Agent 遵循这些产品/工程原则：

- **本地执行，Web 控制**：代码操作发生在你的 Agent 机器上；浏览器是控制台。
- **Session-first 协作**：原生引擎不再区分 chat mode / group mode。一个 Session 可以有一个 VP，也可以有多个 VP。
- **Provider-neutral core**：provider 是路由目标，不是产品身份。模型引用显式写成 `<provider>/<model-id>`。
- **记忆按 scope 管理**：VP 和用户拥有自己的记忆；共享通过 Session/feature scope 明确发生。
- **工具显式化**：每次文件编辑、shell 命令、网络请求都走具名工具，可记录、渲染、测试和 review。
- **兼容但不泄漏旧名**：部分 wire 字段和磁盘路径保留历史 `group`/`unify` alias，新文档和新代码应使用 Yeaft + Session 术语。

## 进阶阅读

- 配置自定义 provider / model：[Yeaft 引擎配置](../yeaft-config.md)
- 原生引擎架构：[Yeaft 引擎](../tech/yeaft-engine.md)
- LLM 路由与协议选择：[Yeaft LLM 层](../tech/yeaft-llm.md)
- 记忆系统内部：[Yeaft 记忆系统（H2-AMS）](../tech/yeaft-memory.md)
- CLI 后端 ChatProvider 集成：[Provider 系统](../tech/providers.md)
