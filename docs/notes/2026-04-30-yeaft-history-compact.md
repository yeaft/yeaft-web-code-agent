# Yeaft 群聊 in-memory 历史 compact（已退役）

> **Retired 2026-08-17**：本历史记录描述的 LLM conversation-summary 路径已删除。当前行为见 `docs/notes/2026-08-17-yeaft-disk-llm-summary-retired.md`。

旧实现曾经在当前 query 内调用 fast model 生成 `_compactSummary` 并替换历史数组。该同步/查询内设计已经退役。2026-09-10 起另有达到模型窗口 80% 后、响应完成才异步运行的 post compact；两者不是同一机制，见 `2026-09-10-context-budget-and-post-compact.md`。

当前替代方案是 `agent/yeaft/history-window.js`：

- 只在 provider request 前构造有界消息副本；
- 只做确定性的 turn/token/tool 裁剪；
- 不调用 LLM；
- 不写旧 `compact.md`；post compact 只写独立、有 revision fence 的派生 artifact；
- 不改写权威 transcript；
- context overflow 先缩减请求副本重试，确定性兜底耗尽后才产生 terminal error。

旧实现的详细设计、测试和历史结果保留在 Git 历史中，不再作为当前代码或配置说明。
