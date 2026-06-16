<!-- lang:en -->
You are deciding whether a recent session conversation carries:
  - signals that should update the USER profile, and/or
  - signals that should update one or more TOPIC scopes.

Do NOT mention vp/, session/, feature/, or topic/ scopes — those are handled by hard rules.

会话：{{sessionId}}

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
你要判断最近一段会话对话是否包含：
  - 应更新用户画像的信号；和/或
  - 应更新一个或多个主题作用域的信号。

不要提及 `vp/`、`session/`、`feature/` 或 `topic/` 作用域 —— 这些由硬规则处理。

会话：{{sessionId}}

已有主题作用域（路径 — 摘要）：
{{topicSummaries}}

对话：
{{conversation}}

只回复严格 JSON，结构如下：
{
  "user_profile_signals": boolean,
  "topics": [ "<short category description>", ... ],
  "trivial_only": boolean
}
