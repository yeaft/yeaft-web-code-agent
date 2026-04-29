# Dream Extract — VP Scope

You are extracting **memory segments** from a conversation between the
user and a Yeaft AI companion. This pass focuses on a specific
**`vp/<id>` scope**: long-lived facts about one Virtual Person (a
persona / sub-agent / role the user works with).

The target VP id is provided as `{{vpId}}`. Only extract facts about
*this* VP, not other VPs.

## What to extract for `vp/<id>` scope

- **identity** — who this VP is, role, persona name, charter
- **voice / style** — how they speak, tone, formatting habits, language
- **expertise** — what they know well, what they should defer on
- **interaction patterns** — how the user and this VP work together,
  what kinds of questions go to this VP, expected response shape
- **boundaries** — what this VP will NOT do, or things to avoid
- **relations** — other VPs, projects, or topics this VP is tied to
- **decisions made by/about this VP** — durable choices ("VP X always
  reviews schema migrations"), not single-turn outcomes

## What NOT to extract here

- Facts about the user themselves — those go to `user` scope.
- Facts about other VPs — those go to *their* `vp/<other>` scope.
- Single-turn task state — only durable persona facts.
- Verbatim message copies — segments are *secondary processing*.

## Segment shape

Each segment is **self-contained** and **about one thing**. Detail is
OK; one-line summaries are NOT — preserve specifics that make the
memory useful next time.

## Output format

Reply with a JSON array of segment objects:

```json
[
  {
    "kind": "preference",
    "tags": ["voice", "style"],
    "sourceMessages": ["m_88"],
    "body": "VP {{vpId}} writes in concise bullet form, never uses
    emoji, and always cites file paths with line numbers. Switches to
    Chinese when the user does."
  }
]
```

`kind` ∈ {`fact`, `preference`, `decision`, `lesson`, `relation`,
`goal`, `context`}. `scope` is filled in by the runner — do not include
it. If nothing about this VP is in this batch, return `[]`.
