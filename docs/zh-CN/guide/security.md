# 安全

Yeaft 有三层独立的凭证模型，要分开理解：

1. **Web 用户认证** —— 真人怎么登录 Web UI
2. **Agent 认证** —— agent 进程怎么证明自己有权连服务器
3. **Yeaft 引擎凭证** —— agent 端 Yeaft 引擎怎么调三方 LLM API

它们不共享密钥，也不互相 fallback。

## Web 用户认证

1. **用户名 + 密码**（bcrypt 哈希）
2. **TOTP 双因素认证**（可选，支持 Google/Microsoft Authenticator）
3. **邮箱验证码**（可选，需配置 SMTP）

登录后签发 JWT token，后续 REST + WebSocket 调用都用它。

## 生产模式要求

服务器在生产模式（`SKIP_AUTH=false`）下会检查：
- `JWT_SECRET` 必须修改为非默认值

如果未配置用户，服务器会启动但输出警告 — 通过 `docker compose exec` 创建首个用户即可。

## Agent 认证

- Agent 通过 WebSocket 消息认证（密钥不在 URL 中传输）
- **用户级 Agent 密钥**：Agent 绑定到特定用户，仅该用户可见 —— 在 **设置 → 安全** 创建，对该用户的会话优先生效
- **全局 AGENT_SECRET**：环境变量方式，仅 admin 可见
- 每个连接生成独立会话密钥用于加密（TweetNaCl XSalsa20-Poly1305）

## Yeaft 引擎凭证

Agent 跑 Yeaft Group Mode 时会直接调你在 `~/.yeaft/config.json` 里列出的 LLM provider。每个 provider 条目 **二选一** 用一种凭证模式：

| 模式 | 字段 | 行为 |
| --- | --- | --- |
| **静态 API key** | `apiKey: "sk-..."` | 每次请求直接拿去用 |
| **动态凭证** | `credentialProvider: "github-copilot"` | 请求时由引擎向 credential provider 现取短期 token。当前支持 `github-copilot`（用你已登录的 GitHub OAuth，换出 Copilot API token） |

**安全后果：**

- `apiKey` 是明文写在 `~/.yeaft/config.json` 里的 —— `chmod 600` 保护，别 commit
- `credentialProvider` 在硬盘上不留长效 secret；token 只在内存里，按需刷新
- Yeaft 凭证 **服务器看不见** —— 只有 agent 用。服务器从不代理 LLM 调用
- **双因素效果**：用 Yeaft 跑 Copilot 时既需要 agent 密钥（服务端门禁）也需要 GitHub OAuth token（provider 端门禁）

## 加密

| 层 | 算法 | 密钥来源 |
| --- | --- | --- |
| Web ↔ Server WebSocket | TweetNaCl XSalsa20-Poly1305 | 每连接独立 session key（连接时 Diffie-Hellman 协商） |
| Agent ↔ Server WebSocket | TweetNaCl XSalsa20-Poly1305 | 每连接独立 session key |
| LLM API 流量 | TLS（标准 HTTPS） | provider TLS 证书 |

端到端加密指的是 web ↔ agent 路径 *穿过* 服务器 —— 服务器只做路由转发，看不到消息明文。

## 角色与权限

所有注册用户默认为 **Pro** 角色。通过 CLI 创建的第一个用户为 **Admin**。

| 功能 | `pro` | `admin` |
|---|:---:|:---:|
| 聊天 | ✓ | ✓ |
| 自有 Agent（用户级密钥） | ✓ | ✓ |
| 全局 Agent（AGENT_SECRET） | - | ✓ |
| 工作台（终端、Git、文件） | ✓ | ✓ |
| 端口代理 | ✓ | ✓ |
| 邀请码管理 | - | ✓ |
| 管理员仪表板 | - | ✓ |

## 威胁模型 —— Yeaft 不防什么

- **Agent 机器被攻陷**：拿到 root 的攻击者可以读 `~/.yeaft/config.json`、拦截 Yeaft 凭证、抓走 `~/.yeaft/scopes/**` 记忆段、tail 在跑的 CLI 进程。**只在可信机器上跑 agent。**
- **恶意服务器运营者**：加密保护路由穿透中的消息正文，但服务器仍能看到元数据（谁连了哪个 agent、时序、消息大小）。怀有恶意的服务器还能给客户端发改过的 web JS。
- **浏览器端 XSS**：Web 客户端把 agent 输出渲染成 HTML/Markdown。渲染器会做 sanitize，但如果你连了一个不可信的 agent，那个 agent 能构造消息去试探 sanitizer 漏洞。**别连不可信的 agent。**
