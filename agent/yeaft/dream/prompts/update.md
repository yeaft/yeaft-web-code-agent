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
- Integrate it into memory.md (reorganize sections if needed).
- Drop stale or contradicted entries.
- Rewrite summary.md (1–3 sentences).
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

最近的 session 对话：
{{sources}}

任务：
- 从这些对话中提取与 THIS scope 相关的内容。
- 将内容整合进 memory.md（必要时重组章节）。
- 删除过期或被推翻的条目。
- 重写 summary.md（1–3 句）。
- 同一批对话也会被处理到 OTHER scopes。
  这里只处理与当前 scope 相关的内容，忽略其他内容。

硬规则：
- 不要读取或引用其他 scope 的文件。
- 不要修改 VP system prompt、session charter 或用户偏好。
- 如果某条内容与 charter 冲突，标注
  "⚠️ contradicts charter — verify which is current" 并继续。

只回复严格 JSON，结构如下：
{ "memory_md": "...", "summary_md": "..." }
