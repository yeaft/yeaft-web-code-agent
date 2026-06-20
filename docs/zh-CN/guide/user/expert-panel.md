# 帮帮团（Expert Panel）

Expert Panel（中文 UI 叫 **帮帮团**）是 Claude Code Chat 模式下的一个**侧边辅助面板** — 你在主聊天和 Claude 讨论时，可以同时打开一个或多个"专家团队"，从不同视角获取建议，不打断主对话。

> 仅在 **Claude Code Chat** 模式下可用。Copilot / Yeaft Code Agent 暂不支持 Expert Panel — Yeaft Code Agent 的多 VP 并行就是更强的等价物。

## 打开 Expert Panel

聊天 header 上有 **💡 帮帮团**按钮（或 sidebar 上的对应入口）。点开后，主聊天区域右侧出现一个**侧边面板**，里面：

- 顶部 chip-tab 切团队（写作 / 交易 / 创业 / 自定义 等）
- 中间：该团队的多视角回复区，分角色卡片渲染
- 底部输入框：直接给当前选中团队发消息

## 团队模板

内置几个预设团队（具体看你的 Agent 配置）：

| 团队 | 角色（示例） |
| --- | --- |
| **写作团队** | 编辑、文案、读者代理、营销 |
| **交易团队** | 量化策略师、风控、宏观分析、技术分析 |
| **创业团队** | PM、CTO、CMO、用户研究 |
| **代码评审** | 架构师、安全专家、性能专家、测试专家 |
| **自定义** | 你自己定义角色 |

每个团队就是一组 persona + 一个对话上下文，下游接同一个 Claude API。

## 工作方式

1. 你在主聊天问 Claude 一个问题（如 "我的方案能不能这样改"）
2. 同时在 Expert Panel 输入框打个简化问题（或复制主聊天的问题进去）
3. 选择一个团队（如 **代码评审**）
4. 团队的 N 个角色**并行**回复（每个角色独立 turn）
5. 你看完所有角色意见，回到主聊天继续跟 Claude 讨论

## 跟主聊天的关系

- Expert Panel **不影响** 主聊天的上下文 — 它是独立的会话，独立的 token 计数
- 适合"我想 sanity check 一下" / "我想从另一个视角看看"
- 主聊天关注**执行**，Expert Panel 关注**判断**

## 团队管理

- **切团队** — chip-tab，一键切
- **清空** — 团队内有 "🗑 清空" 按钮，重置对话
- **关闭面板** — header 上再点一次 💡 按钮，或面板 × 关闭

## 跟 Yeaft Code Agent 的对比

- **Expert Panel** 是 Claude Code Chat 的辅助面板，所有角色都用同一个 Claude API，session 仅在本次窗口
- **Yeaft Code Agent** 把多角色升级成主交互模式，每个 VP 可选不同 provider/model，跨任务有持久记忆

如果你的诉求是 "在一次问题里多视角 sanity check" — 用 Expert Panel。
如果你的诉求是 "建一个长期协作的多角色小组，跨任务延续记忆" — 用 Yeaft Code Agent。

## 常见问题

**Expert Panel 按钮灰着 / 看不到**
- 当前会话 provider 不是 Claude Code（Copilot 模式没有这个能力）
- Agent 的 capabilities 里没有 `expert` 标志 — 升级 Agent

**团队回复一直空**
- 该团队配置里没有角色 — 进设置加角色
- 或 Claude API 限流 / 余额不足 — 看 Agent logs
