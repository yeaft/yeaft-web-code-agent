# 常见问题

## 连接与鉴权

### Agent 连接失败 "Invalid agent secret"

确保 Agent 的 `AGENT_SECRET`（或 `--secret` 参数）与服务器 `.env` 中配置一致。如果在 **设置 → 安全** 里设置了用户级 Agent Secret，该用户的会话会优先用用户级密钥（覆盖全局 `AGENT_SECRET`）。

### 服务器启动失败 "SECURITY CONFIGURATION ERROR"

生产模式下必须修改默认 JWT 密钥：

```ini
JWT_SECRET=随机字符串（至少32位）
```

可用命令生成：`openssl rand -base64 32`

### Docker 部署后 502 Bad Gateway

1. 检查容器是否运行：`docker compose logs webchat`
2. 刷新 nginx DNS 缓存：`docker exec nginx nginx -s reload`

### SQLite 只读错误 (SQLITE_READONLY)

确保数据目录权限正确：

```bash
sudo chown -R root:root ./data
```

### TOTP 设置后无法登录

TOTP 码有时间窗口限制（默认 ±30 秒），确保服务器和手机时间同步。

## 选择后端

### 新建会话弹窗里"Claude Code" / "Copilot"消失了

Agent 启动时会做后端能力检测。某个后端不出现，说明对应 CLI 在 agent 机器上不在 PATH 里或者没鉴权：

- **Claude Code 消失** → 在 agent 机器上跑 `claude --version`；失败的话装 `@anthropic-ai/claude-code` 然后 `claude login`
- **Copilot 消失** → 跑 `copilot --version`；失败的话装 GitHub Copilot CLI 然后 `copilot auth login`
- **Yeaft Group 消失** → 极少见；引擎是打包好的。试着 `yeaft-agent upgrade` 升级。

装好/鉴权新 CLI 后要重启 agent — 能力检测只在启动时跑一次。

### Claude Code、Copilot、Yeaft Group 选哪个？

详见 [选择会话后端](./user/choose-backend.md)。简短版：

- **Claude Code** —— 1:1 聊天，全套 Claude 工具
- **Copilot** —— 1:1 聊天，想对比 Claude vs GPT 模型 / 已有 Copilot 订阅
- **Yeaft Group** —— 多 VP 并行协作 + 跨 session 持久记忆

## Copilot 模式

### "Permission required" 弹窗反复出现

Copilot CLI 跑 `--acp` 模式时，每个 session 第一次执行 shell 命令或改文件前都会请求授权。选 **Always allow this session** 在本 session 后续不再问；选 **Always allow** 在同一台 agent 机器上记住下次也允许。

### Copilot 模式能选 Claude / GPT 以外的 model 吗？

只能用 Copilot CLI 暴露的模型 —— 当前是 Claude 系（Sonnet 4 / 4.5）和 GPT 系（4.1 / 5 等）。需要别的厂商就用 Yeaft Group Mode，在 `~/.yeaft/config.json` 里加 provider。

### Copilot 说"未鉴权"，但我 VS Code Copilot 是登录的

CLI 用的 OAuth token 和 IDE 插件不是同一个。在 agent 机器上跑 `copilot auth login` 单独给 CLI 鉴权。

## Yeaft Group 模式

### 发消息时报 "No LLM provider configured"

在 agent 机器上编辑 `~/.yeaft/config.json`，添加至少一个 provider 条目 —— schema 见 [Yeaft 引擎配置](./yeaft-config.md)。`primaryModel` 必须是 `providers[].models` 列表里存在的 model。

### VP 好像不记得上次说过的话

Yeaft 用 H2-AMS 持久化记忆，但新写入的记忆段要等本 turn 末尾 consolidation pass 跑完才会进召回索引。如果你五秒前刚说的话，可能还没入索引。等本轮 typing indicator 消失再问一次。

为什么这么设计，详见 [Yeaft 记忆系统（H2-AMS）](./tech/yeaft-memory.md)。

### `@mention` 没有 fan-out 到多个 VP

要逐个显式 mention：`@designer @dev 帮我看下这个布局`。Mentions 在 fan-out 前解析 —— 没被 @ 到的 VP 不会回。完全不 @ 任何人，由 group 的默认路由规则决定谁回答。

### 怎么看 VP 的记忆里有什么？

记忆段就在 agent 机器的 `~/.yeaft/scopes/vp/<vpId>/segments/*.md`。每个段都是普通 markdown 文件，可以直接看。

## Yeaft 引擎配置

### `~/.yeaft/config.json` 在哪？

在 **agent 机器** 上 —— 不是服务器。是 Yeaft 引擎启动时读取的文件。

### 同一个 provider 能既配 Claude 又配 GPT 吗？

可以 —— 用 per-model `protocol` 覆盖：

```json
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
```

详见 [Yeaft 引擎配置 → Protocol 解析](./yeaft-config.md#protocol-resolution)。

### 热加载 —— 改 config.json 要重启 agent 吗？

Agent 在下一个 turn 时会重新读 config，所以 model 和 provider 改动通常不用重启。改 language / debug / 全局 limits 可能需要重启。

## Agent 自动升级

```bash
# 手动升级
yeaft-agent upgrade

# 启动时检查
yeaft-agent --auto-upgrade --server wss://...
```

服务器也可通过 `AGENT_LATEST_VERSION` 环境变量给 Agent 推升级通知。
