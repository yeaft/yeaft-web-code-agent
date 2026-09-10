# Yeaft 上下文预算与响应后 compact

本文记录原生 Yeaft 请求的预算边界。它不适用于 Claude Code / Copilot CLI provider。

## 两层预算

- `messageTokenBudget` 默认保持 32768，只约束当前用户 turn 之前的历史消息。当前 turn 的用户输入、助手输出、tool call/result 不计入该配额。
- 每次 provider 请求另按实际模型的 `contextWindow` 校验完整请求：system prompt、tool schemas、历史、当前 turn，以及该模型的 output reserve 全部计入。
- 模型窗口按当前请求实际采用的模型重新解析；fallback 或运行中模型切换会在下一个 provider 边界采用新的窗口。

历史选择优先保留最近的完整文本 turn，但不存在“必须保留 5 轮”的成功门槛。旧 tool call/result 是可选 enrichment，按配对整组删除。所有裁剪只发生在 provider 请求副本，ConversationStore 的原始 transcript 不变。

## Query 内兜底

每次 provider 调用前都会重新构造和拟合请求，因此 tool loop 中新增的结果也受检查。顺序是：

1. 在 32K 内选择旧历史，当前 turn 原样进入下一层；
2. 对可归档的长 tool result 生成 provider-only stub；
3. 按模型窗口支付 system、schemas 和 output reserve，先丢最旧历史，再丢当前 turn 中最旧的可淘汰工具协议单元；
4. 保持 tool call/result 配对。

若 provider 的实际 tokenizer 仍返回 context overflow，未产生 tool call 的请求最多以更小窗口重试三次。已执行工具不会重放；已经流给用户的部分文本会作为 continuation 边界保存，后续请求只继续，不重复显示。Query 内不会为此调用 conversation compact / summary LLM。

长工具执行仍由 T1 reflection 控制增长。触发单位是 tool loop（一次 assistant tool-use batch 及其执行），不是 batch 内的工具数量；每约 30 个 tool loop 折叠一次。

## 响应后 compact

provider 报告的单次请求上下文占用达到模型 `contextWindow` 的 80% 时，Engine 在 `turn_close` 已交付后才启动异步 compact：

- 低于 80% 不调用 compact；阈值与 32K 历史预算无关。
- compact 失败不产生迟到的 turn error，也不影响已返回答案。
- 下一轮只读取已经完成的 artifact，不等待仍在运行的 compact。
- 每个 Session / VP / thread 有 revision fence；下一轮先到会使旧后台结果失效，失效结果不能覆盖新上下文。
- artifact 独立保存在 `sessions/<sessionId>/conversation/post-compact/*.json`，记录来源 turn、模型、窗口和生成时间。它仅作为下一轮 system context 的派生缓存；原始 conversation segments 不删除、不覆盖。
