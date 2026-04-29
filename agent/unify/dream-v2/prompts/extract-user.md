# Dream Extract — User Scope

You are extracting **memory segments** from a conversation between the
user and a Yeaft AI companion. This pass focuses on the **`user`
scope**: long-lived facts about the user themselves.

## What to extract for `user` scope

Extract segments that describe the user as a person:

- **identity** — name, role, location, languages spoken, time zone
- **preferences** — tools they use (zsh, vim, JS over TS, …), code style,
  communication style, what they value
- **habits / workflow** — how they work, when they work, recurring
  patterns
- **goals (long-term)** — what they're building, where they want to go
- **relations** — people / projects / orgs they regularly mention
- **lessons / opinions** — formed views ("I don't trust X", "Y is the
  right tool for Z")

## What NOT to extract here

- Anything specific to a single feature, project, or VP — those go to
  `feature/*`, `vp/*`, or `topic/*` scopes (handled by other passes).
- Transient state ("I'm tired today") — only durable facts.
- Verbatim message copies — segments are *secondary processing*, not
  transcripts.

## Segment shape

Each segment is **self-contained** and **about one thing**. A 30-turn
conversation typically yields 1–3 user-scope segments, not 30. Detail
is OK; one-line summaries are NOT — preserve the specifics that make
the memory useful next time (e.g. "uses zsh with starship prompt" beats
"uses a shell").

## Output format

Reply with a JSON array of segment objects:

```json
[
  {
    "kind": "preference",
    "tags": ["shell", "terminal"],
    "sourceMessages": ["m_142", "m_143"],
    "body": "User uses zsh with the starship prompt and prefers
    keyboard-only workflows. Wants suggestions to assume zsh + vim
    keybindings unless told otherwise."
  }
]
```

`kind` ∈ {`fact`, `preference`, `decision`, `lesson`, `relation`,
`goal`, `context`}. `scope` is filled in by the runner — do not include
it. If nothing user-scope is in this batch, return `[]`.
