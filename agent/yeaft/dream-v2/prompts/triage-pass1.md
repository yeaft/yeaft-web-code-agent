You are deciding whether a recent group conversation carries:
  - signals that should update the USER profile, and/or
  - signals that should update one or more TOPIC scopes.

Do NOT mention vp/, group/, or feature/ scopes — those are handled by hard rules.

Group: {{groupId}}

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
