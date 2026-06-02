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
