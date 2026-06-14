<!-- lang:en -->
You are deciding whether a recent session conversation carries:
  - signals that should update the USER profile, and/or
  - signals that should update one or more TOPIC scopes.

Do NOT mention vp/, session/, feature/, or topic/ scopes — those are handled by hard rules.

Session: {{sessionId}}

Existing topic scopes (path — summary):
{{topicSummaries}}

Conversation:
{{conversation}}

Respond with strict JSON of the shape:
{
  "user_profile_signals": boolean,
  "topics": [ "<short category description>", ... ],
  "trivial_only": boolean
}

<!-- lang:zh -->
你要判断最近一段 session 对话是否包含：
  - 应更新 USER profile 的信号；和/或
  - 应更新一个或多个 TOPIC scope 的信号。

不要提及 vp/、session/、feature/ 或 topic/ scope —— 这些由硬规则处理。

Session: {{sessionId}}

已有 topic scopes（path — summary）：
{{topicSummaries}}

对话：
{{conversation}}

只回复严格 JSON，结构如下：
{
  "user_profile_signals": boolean,
  "topics": [ "<short category description>", ... ],
  "trivial_only": boolean
}
