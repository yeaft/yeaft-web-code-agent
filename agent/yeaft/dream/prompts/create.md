<!-- lang:en -->
You are creating a new memory scope from scratch.

Scope path: {{target}}   (must be ≤2 levels)

Source session conversations:
{{sources}}

{{siblingsBlock}}
Task:
1. Write memory.md from scratch with a reasonable section structure.
2. Prioritize reusable experience: workflows, preferences, pitfalls, corrections, project conventions, review/merge/tag lessons, and rules that should change future execution.
3. Keep current PR/review/blocker detail only when it is still actionable.
4. Write summary.md (1–3 sentences) with reusable lessons before current state.

Reply with strict JSON of the shape:
{ "memory_md": "...", "summary_md": "..." }

<!-- lang:zh -->
你正在从零创建一个新的 memory scope。

Scope path: {{target}}   (must be ≤2 levels)

来源 session 对话：
{{sources}}

{{siblingsBlock}}
任务：
1. 从零编写 memory.md，并使用合理的章节结构。
2. 优先保留可复用经验：workflow、preference、pitfall、correction、project convention、review/merge/tag 教训，以及会改变后续执行方式的规则。
3. 当前 PR、review、阻塞细节只有仍可执行时才保留。
4. 编写 summary.md（1–3 句），先写可复用经验，再写当前状态。

只回复严格 JSON，结构如下：
{ "memory_md": "...", "summary_md": "..." }
