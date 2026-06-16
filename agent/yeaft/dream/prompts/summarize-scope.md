<!-- lang:en -->
# Dream Summarize — Per-Scope Compression

You are summarizing the **memory segments** of a single scope into a short, dense prose summary. This is NOT extraction — the segments already exist. Your job is to compress them into a paragraph the session can keep resident in working memory.

The target scope is `{{scope}}` and contains `{{segmentCount}}` segments listed below.

## Goals

- A future session member should grasp the gist of this scope from your summary alone, without reading all segments.
- Prioritize reusable experience: workflows, project/user preferences, pitfalls, corrections, review/merge/tag lessons, and conventions that change future behavior.
- Keep specifics that matter: names, numbers, decisions, durable views, current blockers, and next steps.
- Do not turn the summary into a chronology of completed work. Mention completed items only when they affect future execution.
- Stay faithful: do not invent facts not present in the segments. Do not soften decisions or opinions.
- Write in the same language the segments are mostly in, unless the surrounding language directive says otherwise.

## Length

- Target ≤ `{{tokenBudget}}` tokens.
- One paragraph for small scopes; two or three compact paragraphs for larger scopes.
- Prefer dense prose over bullet lists unless bullets are clearly more compact.

Segments:
{{segments}}

Return only the summary text.

<!-- lang:zh -->
# Dream Summarize — Per-Scope Compression

你正在把单个 scope 的 **memory segments** 压缩成一段简短、密集的 prose summary。这不是抽取 —— segments 已经存在。你的任务是把它们压缩成 session 可以常驻在工作记忆里的摘要。

目标 scope 是 `{{scope}}`，包含下面列出的 `{{segmentCount}}` 个 segments。

## 目标

- 未来的 session member 只读 summary，也应能理解这个 scope 的核心意思。
- 优先保留可复用经验：工作流、项目/用户偏好、坑点、纠偏、review/merge/tag 教训，以及会改变后续行为的约定。
- 保留重要具体信息：名字、数字、决策、稳定观点、当前阻塞和下一步。
- 不要把 summary 写成完成事项流水账；已完成事项只有会影响后续执行时才写。
- 忠于事实：不要编造 segments 中没有的事实。不要弱化已经明确的决策或观点。
- 使用 segments 主要使用的语言；如果外层语言指令另有要求，以外层语言指令为准。

## 长度

- 目标 ≤ `{{tokenBudget}}` tokens。
- 小 scope 用一段；较大 scope 用两到三个紧凑段落。
- 除非 bullet 明显更紧凑，否则优先使用密集自然段。

Segments:
{{segments}}

只返回 summary 文本。
