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
3. 按模型窗口支付 system、schemas 和 output reserve；当前 turn 超过剩余预算时，先从最旧的工具结果开始 compact 请求副本中的文本，保留首尾、省略标记、错误状态和调用配对，尽量保护最新结果；
4. compact 后仍不足时，再丢最旧历史及当前 turn 中最旧的可淘汰工具协议单元；
5. 保持 tool call/result 配对。

若 provider 的实际 tokenizer 仍返回 context overflow，未产生 tool call 的请求最多以更小窗口重试三次。已执行工具不会重放；已经流给用户的部分文本会作为 continuation 边界保存，后续请求只继续，不重复显示。Query 内不会为此调用 conversation compact / summary LLM。

不再按工具循环次数运行 T1 reflection，也不再启动 T2 reflection 或将其结果带入下一轮。执行期 compact 是确定性的 tool-result 投影，不额外调用模型、不生成反思内容、不折叠或覆盖 transcript。图片和文档不按字节切割；仅压缩文本不足以适配时，仍使用已有整块附件/工具协议单元的有界降级。请求诊断中的 `tool_result_compact` 记录数量与预算，不复制敏感结果正文。

## Anthropic 签名前缀的例外

支持 preserved thinking 的 Anthropic 模型一旦在当前 query 内建立签名前缀，后续请求必须保持原有 system、tools 和消息前缀不变；不能再对这些工具结果做 compact、去重或丢弃。运行中指令与工具变更仍通过追加消息传递。

此时 `max_tokens` 只是输出上限，不属于签名前缀。Engine 先按剩余窗口缩小本次输出额度，而不是因为配置的最大输出额度过大就终止。预算以最近成功请求的实际 input（按 provider 语义计入 cache）为下界，再计入助手响应及新增工具结果；新增内容的估算按该请求实际 input / 文本估算比值校准。没有实际 usage 时回退到文本估算。`request_output_reserve` trace 只记录窗口、输入预算和输出额度，不复制正文。

Engine 将配置输出目标 `maxTokens` 与剩余上下文硬上限 `contextOutputLimit` 分开传递。适配器在最终 wire body 规范化之后再次校验签名 continuation 的实际输出额度：manual thinking 或 `extraBody` 可以高于配置目标，但不能超过剩余上下文；等于硬上限仍可发送，超过则在 fetch 前显式失败，不默默降低用户指定的 thinking budget，也不发送越界请求；stream 和 side call 采用同一保护。

若剩余额度不足 1024 tokens（用户或执行策略配置的上限本来更小则沿用更小值），仍显式终止并要求缩小上下文后开始新 turn。不删除签名、不改写 transcript、不重放已经执行的工具，也不在 query 中生成摘要。该兜底推迟的是不必要的提前失败，不承诺单个 turn 可无限增长。

## 响应后 compact

provider 报告的单次请求上下文占用达到模型 `contextWindow` 的 80% 时，Engine 在 `turn_close` 已交付后才启动异步 compact：

- 低于 80% 不调用 compact；阈值与 32K 历史预算无关。
- compact 失败不产生迟到的 turn error，也不影响已返回答案。
- 下一轮只读取已经完成的 artifact，不等待仍在运行的 compact。
- 每个 Session / VP / thread 有 revision fence；下一轮先到会使旧后台结果失效，失效结果不能覆盖新上下文。
- artifact 独立保存在 `sessions/<sessionId>/conversation/post-compact/*.json`，记录来源 turn、模型、窗口和生成时间。它仅作为下一轮 system context 的派生缓存；原始 conversation segments 不删除、不覆盖。
