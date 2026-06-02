# Dream Extract — Group Scope

You are extracting **memory segments** from a conversation between the
user and a Yeaft AI companion. This pass focuses on a specific
**`group/<id>` scope**: long-lived facts about one collaboration group
(a project team, a study cohort, a working set of people/agents).

The target group id is provided as `{{groupId}}`.

## What to extract for `group/<id>` scope

- **purpose** — what this group exists to do, its charter / mission
- **members** — people, VPs, and roles in the group, and what each is
  responsible for
- **conventions** — how the group works (rituals, cadences, naming,
  channels, languages used)
- **shared decisions** — durable agreements ("we ship on Fridays",
  "all PRs need two reviewers")
- **shared context** — domain knowledge the whole group relies on
- **relations** — other groups, features, or topics this group owns or
  depends on
- **lessons** — collective takeaways ("we tried X in Q1, it didn't
  scale, switched to Y")

## What NOT to extract here

- Personal preferences of the user — those go to `user` scope.
- Single-VP traits — those go to that VP's `vp/<id>` scope.
- Feature-specific implementation detail — those go to
  `feature/<id>` scope.
- Transient status updates — only durable group facts.

## Segment shape

Each segment is **self-contained** and **about one thing**. Detail is
OK; one-line summaries are NOT — preserve specifics.

## Output format

Reply with a JSON array of segment objects:

```json
[
  {
    "kind": "decision",
    "tags": ["process", "review"],
    "sourceMessages": ["m_201"],
    "body": "Group {{groupId}} decided every PR touching the payments
    module needs sign-off from both the security VP and the payments
    feature owner before merge. Rationale: a near-miss in March."
  }
]
```

`kind` ∈ {`fact`, `preference`, `decision`, `lesson`, `relation`,
`goal`, `context`}. `scope` is filled in by the runner — do not include
it. If nothing group-scope is in this batch, return `[]`.
