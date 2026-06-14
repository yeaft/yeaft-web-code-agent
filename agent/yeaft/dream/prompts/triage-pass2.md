<!-- lang:en -->
Bind a free-form topic description to an exact path under topic/.
Rules:
  - At most TWO path segments. Reject any third level.
  - Segments may contain letters, digits, dashes, underscores, dots, CJK.
  - Prefer matching an existing path if the description fits.

Description: {{description}}

Existing topics:
{{existingTopics}}

Reply with strict JSON, exactly one of:
  { "decision": "match", "path": "<existing path>" }
  { "decision": "new",   "path": "<new ≤2-segment path>" }
  { "decision": "none" }

<!-- lang:zh -->
把一个自由描述的 topic 绑定到 topic/ 下的精确路径。
规则：
  - 最多 TWO 个路径段。拒绝任何第三级路径。
  - 路径段可包含字母、数字、短横线、下划线、点、CJK 字符。
  - 如果描述适合已有路径，优先匹配已有路径。

描述：{{description}}

已有 topics：
{{existingTopics}}

只回复严格 JSON，且必须是以下三种之一：
  { "decision": "match", "path": "<existing path>" }
  { "decision": "new",   "path": "<new ≤2-segment path>" }
  { "decision": "none" }
