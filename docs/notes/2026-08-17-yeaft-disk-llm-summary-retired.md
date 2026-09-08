# Yeaft 磁盘级 LLM 对话摘要退役

**日期**：2026-08-17

Yeaft 原生引擎不再在 turn 结束后调用 LLM，把 conversation transcript 折成 `compact.md` 或 scoped compact summary。

## 现在的职责划分

- **Transcript**：ConversationStore JSONL 是完整历史的权威来源。
- **Runtime cache + history window**：Session runtime 只保留 bounded disposable history cache；`agent/yeaft/history-window.js` 在 hydrate/append 后和每次 provider request 前做确定性 turn/token/tool/multimodal 裁剪；不调用 LLM、不写盘、不改 transcript。
- **Memory/Dream**：长期事实、偏好和决策仍由 Memory/Dream 在后台管理；2026-09-08 起，原生 Session 自动历史上下文改用[当前 Session 原始问答双桶召回](./2026-09-08-session-message-history-recall.md)，不再靠 Dream 内容自动召回。Memory 工具与其他适用路径不受影响，已有 memory 不删除。
- **Browser**：只展示当前可见窗口，旧 transcript 通过分页和搜索读取。

## 明确删除的行为

- post-turn `Compactor` / `history-compact` LLM summarizer；
- `Engine.#maybeConsolidate()` 的 conversation-summary 路径；
- `compact.md` 和 `conversation/compact/*.md` 的读写和 prompt 注入；
- context overflow 时的隐藏摘要调用和重试；
- Yeaft compact WS 事件。

## Context overflow

Provider 仍然可能因 system prompt、工具定义或单个 turn 过大返回 context overflow。此时运行时不再偷偷调用摘要模型，不改写历史，直接产生 terminal error。用户可通过提高模型上下文、缩小工具输出或重新提交请求解决；长期语义应由 Memory/Dream 保存。

旧 summary 文件只读不读，不在本次改动中主动删除用户运行时数据。后续清理必须另做可回滚、非 LLM 的迁移。

Provider 私有的 signed thinking block 不做字符串截断：history window 计费完整 payload + signature，超预算时无 tool arc 的 row 只保留普通文本，带 tool call 的 row 与配对 tool result 一起从 provider 副本移除；ConversationStore 原文不变。对 wire 前会 `JSON.stringify` 的 object output，按序列化后的字符串计费并只在 provider 副本中裁剪。
