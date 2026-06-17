<!-- lang:en -->
You are updating an existing memory scope.

Scope: {{target}}
{{batchHeader}}
Current memory.md:
"""
{{memoryMd}}
"""

Current summary.md:
"""
{{summaryMd}}
"""

Recent session conversations:
{{sources}}

Task:
- Extract from these conversations what is relevant to THIS scope.
- Prefer reusable experience over chronology: workflows, preferences, pitfalls, corrections, project conventions, review/merge/tag lessons, and rules that should change future execution.
- Keep current PR/review/blocker detail only when it is still actionable.
- Integrate it into memory.md (reorganize sections if needed).
- Drop stale or contradicted entries.
- Rewrite summary.md (1–3 sentences) so the summary highlights reusable lessons first, then current state.
- The same conversations are being processed for OTHER scopes too.
  Only handle what is relevant here. Ignore the rest.

Hard rules:
- Never read or reference any other scope's files.
- Never modify VP system prompt, session charter, or user preferences.
- If something contradicts a charter, annotate with
  "⚠️ contradicts charter — verify which is current" and continue.

Reply with strict JSON of the shape:
{ "memory_md": "...", "summary_md": "..." }

<!-- lang:zh -->
你正在更新一个已有的 memory scope。

Scope: {{target}}
{{batchHeader}}
当前 memory.md：
"""
{{memoryMd}}
"""

当前 summary.md：
"""
{{summaryMd}}
"""

最近的会话对话：
{{sources}}

任务：
- 从这些对话中提取与当前作用域相关的内容。
- 优先保留可复用经验，而不是流水账：工作流、偏好、坑点、纠偏、项目约定、review/merge/tag 教训，以及会改变后续执行方式的规则。
- 当前 PR、review、阻塞细节只有仍可执行时才保留。
- 将内容整合进 memory.md（必要时重组章节）。
- 删除过期或被推翻的条目。
- 重写 summary.md（1–3 句），摘要先突出可复用经验，再写当前状态。
- 同一批对话也会被处理到其他作用域。
  这里只处理与当前作用域相关的内容，忽略其他内容。

硬规则：
- 不要读取或引用其他作用域的文件。
- 不要修改 VP 系统提示词、会话章程或用户偏好。
- 如果某条内容与章程冲突，标注
  "⚠️ 与章程冲突——确认哪一条是当前事实" 并继续。

只回复严格 JSON，结构如下：
{ "memory_md": "...", "summary_md": "..." }
