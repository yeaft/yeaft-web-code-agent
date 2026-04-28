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

Recent conversations:
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
- Never modify VP system-prompt, group charter, or user preferences.
- If something contradicts a charter, annotate with
  "⚠️ contradicts charter — verify which is current" and continue.

Reply with strict JSON of the shape:
{ "memory_md": "...", "summary_md": "..." }
