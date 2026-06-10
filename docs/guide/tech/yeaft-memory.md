# Yeaft Memory System (H2-AMS)

H2-AMS (Hierarchical 2-layer Active Memory Set) is the **cross-session persistent memory** of the Yeaft engine. Before each turn the engine actively recalls relevant memory and injects it into the system prompt; after each turn it uses an LLM to amend memory. This chapter covers the **architecture**, **scope model**, and **read/write paths**.

> Audience: developers who want to understand / debug / extend Yeaft memory. End-user blurb in [Yeaft Group Mode](../user/yeaft-group.md#what-can-the-memory-system-do).

## Design Goals

1. **Cross-session memory** — A VP remembers what you said last time in a new session
2. **Multi-scope isolation** — user / vp / group / feature / global stay independent, no cross-pollution
3. **Recall precision** — Uses FTS5 full-text index, **not** vector search (lightweight, explainable, debuggable)
4. **Readable / backupable** — Memory is plain markdown files, no binary blobs

## Architecture Layers

```
┌─────────────────────────────────────────────────────┐
│ Engine Query Loop                                     │
└─────────────────┬───────────────────────────────────┘
                  │ preflow.recall(scopes)
                  ↓
┌─────────────────────────────────────────────────────┐
│ AMS (Active Memory Set) — in-memory 3-layer cache    │
│   • Resident summary  — <scope>/summary.md          │
│   • Recent            — recent high-priority segs    │
│   • OnDemand          — FTS-recalled relevant segs   │
└─────────────────┬───────────────────────────────────┘
                  │
                  ↓
┌─────────────────────────────────────────────────────┐
│ Segment Store — <scope>/segments/*.md atomic segs    │
│ Summary Store — <scope>/summary.md  Layer-A summary  │
│ FTS5 Index    — SQLite FTS5 (one row per segment)    │
└─────────────────────────────────────────────────────┘
                  ↑
                  │ dream maintenance
┌─────────────────────────────────────────────────────┐
│ Dream Loop — background                              │
│   • Slice conversation into atomic segments          │
│   • LLM updates summary.md                           │
│   • Mirror to FTS index                              │
└─────────────────────────────────────────────────────┘
```

## Scope Model

**Scope is the only isolation dimension.** No shards, no channels — just scope.

| Scope | Meaning | Who reads / writes |
| --- | --- | --- |
| `user/<userId>` | User-level profile / preference | All VPs / groups of this user |
| `vp/<vpId>` | Persona memory of a single VP | That VP (private) |
| `vp/<vpId>/sub/<subId>` | Nested scope for VP sub-agent | That sub-agent |
| `group/<groupId>` | Group-shared | All VPs in this group |
| `feature/<featureId>` | Feature-level collaborative memory | VPs working on this feature |
| `global` | Global (product-level common knowledge) | Everyone |

### VP and Sub-Agent
VP is a scope owner at the same level as user. A VP's sub-agent is a nested scope (`vp/X/sub/Y`) with its own private memory.

### Group Fan-out Visibility
When multiple VPs run in parallel in a group:
- Each VP sees its own `vp/<vpId>` memory + the `group/<groupId>` memory + the `user/<userId>` memory
- They **don't** share transcripts (each VP's conversation history is its own)
- VP→VP cross-visibility = via scope-aware pre-flow recall, **not** via a shared shard

### Explicit VP→VP Handoff
Use the `route_forward` tool to pass task context explicitly.

## Storage Primitives

### Segment Store (`segment-store.js`)
Atomic memory segment, stored as markdown:

```
~/.yeaft/<scope>/segments/<segment-id>.md
```

Each segment has:
- frontmatter: metadata (creation time, source turn id, keywords, priority)
- body: natural-language paragraph

Example (`~/.yeaft/user/uid-123/segments/2026-06-10-prefer-ts.md`):

```markdown
---
created: 2026-06-10T08:32:11Z
source_turn: turn-abc
keywords: [typescript, prefer, type-system]
priority: 0.7
---

User prefers TypeScript over JavaScript. Rationale: "type safety has the highest ROI at team scale".
```

### Summary Store / Layer A (`store-v2.js`)
Each scope has a `<scope>/summary.md` — the **condensed** view of all segments in that scope. The LLM incrementally updates it during dream maintenance.

### Index DB / FTS (`index-db.js`)
SQLite FTS5 table, one row per segment:

```sql
CREATE VIRTUAL TABLE segments USING fts5(
  segment_id UNINDEXED,
  scope UNINDEXED,
  keywords,
  body,
  tokenize='unicode61'
);
```

Sharded by scope; recall unions across the scope list as needed.

### AMS (Active Memory Set, `ams.js`)
In-memory 3-layer cache:
- **Resident summary** — `summary.md` of the current-group-related scopes, fixed length
- **Recent** — recent high-priority segments, sorted by priority, capped by token budget
- **OnDemand** — segments recalled by this preflow, capped by token budget

Each layer has an independent budget (`budget.js`); the total doesn't exceed the memory portion of the system prompt budget.

## Read Path — Preflow (before each turn)

`preflow.js` runs at the start of every turn:

```js
async function preflow({ scopes, query, budget }) {
  // 1. Extract keywords from query (keywords.js)
  const kws = extractKeywords(query);

  // 2. FTS recall against each scope
  const hits = await Promise.all(
    scopes.map(s => indexDb.search(s, kws, { limit: 20 }))
  );

  // 3. Rank by priority + recall score
  const ranked = rankHits(hits.flat());

  // 4. Truncate to budget
  const selected = pickWithinBudget(ranked, budget);

  // 5. Render into system prompt
  return renderMemoryBlock(selected);
}
```

Recall results are injected into the `### Memory` section of the system prompt.

## Write Path — adjust + dream after the turn

### Adjust (lightweight, at most once per turn)
`adjust.js`: a lightweight LLM call **amends** AMS with new info from the current turn (e.g. user changed a preference — deactivate the old one, bump priority on the new).

Runs at most once per session per group to avoid hot looping on short turns.

```js
const adjustment = await llm.call({
  model: fastModel,
  system: adjustPrompt,
  messages: [{ role: 'user', content: `Turn diff: ${diff}` }],
});
await applyAdjustment(ams, adjustment);
```

### Dream (heavyweight, background)
`dream-v2/` is a background daemon loop:
1. Detect which scopes have undigested conversation history
2. Use an LLM to **slice** the conversation into atomic segments
3. Write new segments to `<scope>/segments/`
4. Update `<scope>/summary.md`
5. Mirror to the FTS index

Dream does **not** block user turns. It runs when idle or when the user manually triggers `/yeaft compact`.

## Consolidation Decision

`consolidate.js` decides when dream maintenance should kick in:

- Segment count exceeds threshold
- Cumulative character count exceeds threshold
- It's been N minutes since the last dream
- User manually triggers

When the condition is met → mark scope `needs_dream: true` → dream loop picks it up.

## Debugging

### Read memory directly
Open `~/.yeaft/<scope>/segments/*.md` and `~/.yeaft/<scope>/summary.md`. Plain markdown.

### Inspect the recall process
The Yeaft Web **Debug panel** shows per-turn preflow recall details:
- Which scopes were searched
- Which keywords were used
- Which segments were recalled
- Which made it into AMS / which got cut by budget

### Inspect the FTS index
```bash
sqlite3 ~/.yeaft/<scope>/index.db
> SELECT segment_id, keywords FROM segments WHERE body MATCH 'typescript';
```

## Backup / Migration

Memory is all files — `tar` `~/.yeaft/` and you have a backup. To migrate: extract back to `~/.yeaft/` on the new machine and start the Agent. Use `seed-backfill.js` to rebuild the FTS index.

## Key Files

```
agent/yeaft/memory/
  segment-store.js   — segment storage primitive
  segment-sync.js    — sync FTS on segment write/delete
  segment.js         — segment record helpers
  index-db.js        — SQLite FTS5 index
  store-v2.js        — Layer-A summary read/write
  ams.js             — Active Memory Set cache
  ams-registry.js    — group-level AMS hydrate/persist
  budget.js          — token budget calculator
  keywords.js        — FTS keyword extractor
  preflow.js         — pre-turn recall
  adjust.js          — post-turn adjustment
  consolidate.js     — dream-trigger decision
  seed-backfill.js   — historical data migration
```

> The dream loop itself lives in `agent/yeaft/dream-v2/`, not in `memory/`.

## Design Trade-offs

**Why not vector search?** FTS5 + keywords + segment-level markdown is precise enough (recall ≥80% for our use cases), and it's **explainable / debuggable / backupable**. Vector search needs an embedding service + index rebuild + binary blobs — high maintenance, not much precision gain for short memory segments.

**Why is Layer-A summary stored separately as markdown?** `summary.md` is the LLM-maintained "current state of long-term memory" — more stable than raw segments. At recall time it's **read directly**, skipping the FTS query for latency savings.

**Why is dream backgrounded?** Dream involves LLM calls (expensive + slow); it can't block user turns. It's eventual consistency — what you said today may not be digested into segments until tomorrow.
