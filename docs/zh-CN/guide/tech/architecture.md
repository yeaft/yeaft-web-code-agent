# 架构总览

Yeaft 是三层系统。Browser 是控制面，Server 负责认证与中继，每台 Agent 拥有代码执行和原生 Yeaft runtime data。

```text
Browser（Vue 3 + Pinia）
        │ HTTP + 经过认证的 WebSocket relay（生产环境使用 WSS）
        ▼
Server（Express + ws + SQLite）
        │ owner-checked relay 与 browser-facing catalog
        ▼
Agent（运行在代码机器的 Node.js）
        ├── Claude Code CLI provider
        ├── GitHub Copilot CLI provider（ACP）
        ├── 原生 Yeaft engine
        │   ├── Session + 1..N VP 编排
        │   ├── Anthropic / OpenAI Responses adapter
        │   ├── 33 个内置工具 + Skills + MCP
        │   ├── H2-AMS memory + Dream maintenance
        │   ├── Project 与 scoped sibling-Session recall
        │   └── Work Center（WorkItem → Action → Run）
        └── Workbench 能力选择页（Terminal、Git、Files、Browser 可用性）
```

## 所有权边界

| 层 | 拥有 | 不拥有 |
| --- | --- | --- |
| **Browser** | 当前 UI state、统一 catalog projection、locale/theme、draft | 代码执行或权威 Agent runtime data |
| **Server** | User/auth record、invitation/admin data、browser-facing conversation catalog metadata、WebSocket routing | 原生 Session transcript、Agent memory、provider credential 或 Work Center execution |
| **Agent** | CLI subprocess、原生 provider call、tools、Session history、memory、background task、Project Agent-side context、Work Center SQLite、workbench access | Server user account 或 cross-owner data |

Session 的 `workDir` 是 execution 与 project asset context。原生 Session data 和 Work Center state 仍位于 Agent 的 Yeaft data root。

## Runtime 路径

### Claude Code

```text
Web send_message
  → Server relay
  → Agent ChatProvider
  → Claude Code CLI stream-json process
  → normalized claude_output event
  → 共享 Web message renderer
```

每个 CLI conversation 由一个 provider process 拥有。Claude Code 对其 command 和 resume 行为保持权威。

### GitHub Copilot

```text
Web send_message / permission response
  → Server relay
  → Agent Copilot ChatProvider
  → copilot --acp JSON-RPC process
  → normalized claude_output event
  → 共享 Web message renderer
```

ACP permission prompt 与 live Copilot model catalog 保持 provider-specific。

### 原生 Yeaft Session

```text
Web yeaft_session_send
  → Server owner-checked relay
  → Agent Session coordinator
  → 解析 default/@mentioned VP
  → 独立运行 VP turn
  → Engine query/tool loop
  → yeaft_output event
  → 共享 Web message renderer
```

`yeaft_session_send` 是当前 send channel。历史 alias 与 `claude_output` shape 的 rendering payload 为 wire/storage 兼容保留，不是当前领域术语。

### Work Center

```text
Browser WorkItem request
  → Server relay
  → Agent Work Center store/controller
  → triage 与经过校验的 Action graph
  → watcher claim ready Action
  → runner 复用原生 Engine
  → 有 fence 的 Run result + evidence
  → controller 推进 dependency/final gate
```

Work Center 属于 Agent。Source Session 是 origin/link，不是 storage owner。Coordinator conversation 没有 side-effect tool；Action Run 获得 task-specific tools 与 workspace policy。

## 原生 engine query loop

每个 VP turn 中，engine：

1. 解析 Session、VP、Project、project doc、memory 和 pending sub-agent context；
2. 在 token budget 内构造 prompt 与 compacted history；
3. 从所选 Anthropic Messages 或 OpenAI Responses adapter stream；
4. 执行允许的工具，并 fold 较长 tool arc；
5. 持久化 raw event、message、usage 和 trace；
6. 调整 H2-AMS，按需触发 Dream/compact，并报告 stop/result event。

Context error 可以触发强制 compact/retry；配置的 fallback model 处理符合条件的 provider failure。Background job 与 child agent 使用持久 Session-scoped task record。

## 主要源码布局

```text
server/                     Express/ws relay、auth、catalog、SQLite、port proxy
agent/
  providers/                Claude Code 与 Copilot CLI ChatProvider adapter
  connection/               Agent WebSocket 与 message routing
  yeaft/
    engine.js               原生 query/tool loop
    sessions/               Session roster、store、coordinator、pre-flow
    projects/               Agent-side Project context store
    llm/                    Anthropic/OpenAI Responses adapter 与 routing
    memory/                 H2-AMS、FTS index、summary、segment
    tools/                  33 个内置工具
    work-center/            WorkItem/Action/Run store、planner、watcher、runner
    sub-agent/              Child-agent execution 与 notification
    tasks/                  Background shell task persistence
  workbench/                Route-scoped Terminal、Git、files 与 Browser runtime 服务
web/                        Vue 3 Options API + Pinia + static CSS/i18n
test/                       Vitest unit/integration tests
e2e/                        Playwright browser tests
docs/                       中英文 VitePress 文档
```

## Project 与 memory flow

Server catalog 给 Browser 一个 Agent-aware 的原生/CLI conversation 视图。Project membership 会同步给 Agent。原生 turn 开始前，当前 Agent 可以解析 Project 中同一 Agent 的 sibling Session，并将保留来源标签的只读 scope 加入 H2-AMS recall。

这不是 transcript merging。User、VP、Session、Project-related Session、WorkItem 与 legacy compatibility scope 都保留明确所有权和 ACL rule。

## 与安全有关的路径

- Browser/Server auth 支持 JWT、可选 TOTP/邮件验证和可配置 SSO provider。
- 当前 Web 与 Agent peer 在认证后协商 plaintext JSON payload；生产环境的保密性依赖 HTTPS/WSS transport security。
- TweetNaCl payload encryption 只在 legacy peer 未协商 plaintext 时作为 compatibility fallback。
- Server 对 Agent 与 WebSocket traffic 执行 owner routing。
- Provider credential、raw tool output、project file、debug trace 与原生 runtime storage 留在 Agent，除非显式返回 Browser。
- `SKIP_AUTH` 与 local mode 是开发/受信任工作站路径，不是公网部署设置。

## 构建与发布

- `npm test` 运行核心 Vitest manifest。
- `npm run test:e2e` 运行 Playwright。
- `npm run release:guard` 导入 Server/Agent module 并执行 Server startup smoke。
- `npm run build` 生成 production Web asset。
- `npm run docs:build` 构建中英文 VitePress 站点。
- `v1.0.*` tag 触发 development release workflow；`release-v1.0.*` 是显式 production release tag。Release workflow 发布 npm/Docker artifact 前会校验 tag 指向当前 `main`。

## 相关参考

- [CLI provider 系统](./providers.md)
- [原生 Yeaft engine](./yeaft-engine.md)
- [H2-AMS memory](./yeaft-memory.md)
- [原生 LLM 层](./yeaft-llm.md)
- [WebSocket 协议](./wire-protocol.md)
- [WebRTC Browser Runtime 设计](../../../notes/2026-08-07-webrtc-browser-runtime-design.md)
- [Work Center 用户合同](../user/work-center.md)
