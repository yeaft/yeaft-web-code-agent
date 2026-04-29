# Dream Extract — Feature Scope

You are extracting **memory segments** from a conversation between the
user and a Yeaft AI companion. This pass focuses on a specific
**`feature/<id>` scope**: long-lived facts about one feature, project,
or workstream.

The target feature id is provided as `{{featureId}}`.

## What to extract for `feature/<id>` scope

- **goal** — what this feature is trying to achieve, who it's for
- **architecture / approach** — chosen design, key components,
  data model, contracts at boundaries
- **decisions** — durable technical choices ("we use SQLite FTS5,
  not Elasticsearch") with rationale
- **constraints** — performance budgets, deadlines, compatibility
  requirements
- **open questions / blockers** — known unknowns the user is tracking
- **progress milestones** — durable checkpoints ("Phase 1 shipped
  v0.1.620, FTS recall under 10ms"), not single-PR status
- **lessons** — what was tried and rejected, what surprised us
- **relations** — other features it depends on or integrates with

## What NOT to extract here

- Facts about the user themselves — `user` scope.
- Facts about a VP working on this feature — that VP's `vp/<id>`.
- Group conventions that apply to many features — `group/<id>`.
- Day-to-day chatter, single-turn debugging — only durable facts.

## Segment shape

Each segment is **self-contained** and **about one thing**. Detail is
OK and often essential here (architecture decisions need rationale and
trade-offs to be re-usable). One-line summaries are NOT enough.

## Output format

Reply with a JSON array of segment objects:

```json
[
  {
    "kind": "decision",
    "tags": ["architecture", "memory"],
    "sourceMessages": ["m_412", "m_413", "m_419"],
    "body": "Feature {{featureId}} stores memory as semantic segments
    indexed in SQLite FTS5 (built-in node:sqlite, no external dep).
    Pre-flow keyword recall runs <10ms p95 on 10k segments; an LLM
    adjustMemory pass corrects misses post-turn. Rejected alternatives:
    pure-LLM recall (too slow on every turn), Elasticsearch (extra
    process to manage)."
  }
]
```

`kind` ∈ {`fact`, `preference`, `decision`, `lesson`, `relation`,
`goal`, `context`}. `scope` is filled in by the runner — do not include
it. If nothing feature-scope is in this batch, return `[]`.
