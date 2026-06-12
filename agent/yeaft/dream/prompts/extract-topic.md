# Dream Extract — Topic Scope

You are extracting **memory segments** from a conversation between the
user and a Yeaft AI companion. This pass focuses on a specific
**`topic/<id>` scope**: long-lived facts and viewpoints about a domain
topic that recurs across conversations (e.g. `topic/lang/rust`,
`topic/auth/jwt`, `topic/ml/transformers`).

The target topic id is provided as `{{topicId}}`.

## What to extract for `topic/<id>` scope

- **core facts** — durable knowledge about the topic (how it works,
  key terms, gotchas) that the user has either taught the assistant
  or confirmed
- **viewpoints / opinions** — formed views the user holds on this
  topic ("I think GraphQL is overkill for internal tools")
- **canonical references** — sources the user trusts on this topic
  (specific docs, papers, people)
- **patterns** — how the user typically applies this topic
  ("when using JWT, always set short access-token TTL + refresh")
- **lessons** — things that bit them, things that worked
- **relations** — features, projects, or other topics tied to this one

## What NOT to extract here

- Facts about the user as a person — `user` scope.
- Facts specific to one feature implementation — `feature/<id>`.
- Session conventions — `session/<id>`.
- Generic encyclopedia facts the assistant already knows — only the
  user's *durable views and confirmed knowledge* about the topic.

## Segment shape

Each segment is **self-contained** and **about one thing**. Detail is
OK; one-line summaries are NOT — capture rationale and specifics so
the segment is useful next time without rehydrating the conversation.

## Output format

Reply with a JSON array of segment objects:

```json
[
  {
    "kind": "lesson",
    "tags": ["jwt", "auth"],
    "sourceMessages": ["m_330", "m_331"],
    "body": "On topic {{topicId}}: user always pairs short-lived JWT
    access tokens (≤15 min) with rotating refresh tokens stored as
    HttpOnly cookies. Got burned by a 24h-token leak in 2024 — single
    long-lived token is treated as a non-starter."
  }
]
```

`kind` ∈ {`fact`, `preference`, `decision`, `lesson`, `relation`,
`goal`, `context`}. `scope` is filled in by the runner — do not include
it. If nothing topic-scope is in this batch, return `[]`.
