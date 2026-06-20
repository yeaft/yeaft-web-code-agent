# Yeaft Memory System (H2-AMS)

H2-AMS is the **cross-session persistent memory** subsystem of the Yeaft engine. It combines an in-memory Active Memory Set with a SQLite FTS pre-flow recall layer (see `agent/yeaft/memory/DESIGN-H2-AMS.md` for the long-form rationale). Before each turn the engine actively recalls relevant memory and injects it into the system prompt; after each turn it uses an LLM to amend memory. This chapter covers the **architecture**, **scope model**, and **read/write paths**.

> Audience: developers who want to understand / debug / extend Yeaft memory. End-user blurb in [Yeaft Code Agent](../user/yeaft-group.md#memory-design).

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
│   • Resident summary  — Layer-A summary              │
│   • Recent            — recent high-priority segs    │
│   • OnDemand          — FTS-recalled relevant segs   │
└─────────────────┬───────────────────────────────────┘
                  │
                  ↓
┌─────────────────────────────────────────────────────┐
│ Segment Store — <scope>/memory.md (multiple segs)    │
│ Summary Store — Layer-A summary blob                 │
│ FTS5 Index    — SQLite FTS5 (one row per segment)    │
└─────────────────────────────────────────────────────┘
                  ↑
                  │ dream maintenance
┌─────────────────────────────────────────────────────┐
│ Dream Loop — background                              │
│   • Slice conversation into atomic segments          │
│   • LLM updates Layer-A summary                      │
│   • Mirror to FTS index                              │
└─────────────────────────────────────────────────────┘
```

## Scope Model

**Scope is the only isolation dimension.** No shards, no channels — just scope.

| Scope | Meaning | Who reads / writes |
| --- | --- | --- |
| `user/<userId>` | User-level profile / preference | All VPs / sessions of this user |
| `vp/<vpId>` | Persona memory of a single VP | That VP (private) |
| `vp/<vpId>/sub/<subId>` | Nested scope for VP sub-agent | That sub-agent |
| `group/<groupId>` | Session-shared (the on-disk name is still `group/`) | All VPs in this session |
| `feature/<featureId>` | Feature-level collaborative memory | VPs working on this feature |
| `global` | Global (product-level common knowledge) | Everyone |

### VP and Sub-Agent
VP is a scope owner at the same level as user. A VP's sub-agent is a nested scope (`vp/X/sub/Y`) with its own private memory.

### Session Fan-out Visibility
When multiple VPs run in parallel in a session:
- Each VP sees its own `vp/<vpId>` memory + the session-level (`group/<groupId>`) memory + the `user/<userId>` memory
- They **don't** share transcripts (each VP's conversation history is its own)
- VP→VP cross-visibility = via scope-aware pre-flow recall, **not** via a shared shard

### Explicit VP→VP Handoff
Use the `route_forward` tool to pass task context explicitly.

## Storage Primitives

### Segment Store (`segment-store.js`)
On disk each scope owns **one** `memory.md` file that bundles multiple atomic segments:

```
~/.yeaft/memory/user/memory.md
~/.yeaft/memory/vp/<vpId>/memory.md
~/.yeaft/memory/group/<groupId>/memory.md
~/.yeaft/memory/feature/<featureId>/memory.md
~/.yeaft/memory/topic/<l1>/memory.md
~/.yeaft/memory/topic/<l1>/<l2>/memory.md
```

A single `memory.md` looks like:

```markdown
<!-- segment: 2026-06-10-prefer-ts -->
<!-- created: 2026-06-10T08:32:11Z, source_turn: turn-abc, keywords: [typescript], priority: 0.7 -->

User prefers TypeScript over JavaScript. Rationale: "type safety has the highest ROI at team scale".

<!-- segment: 2026-06-09-dark-mode -->
...
```

Read/write is atomic at the scope level — the whole `memory.md` is rewritten when segments change.

### Summary Store / Layer A (`summary-store.js` / `store.js`)
Each scope has a Layer-A summary — the **condensed** view of all segments in that scope. The LLM incrementally updates it during dream maintenance.

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
- **Resident summary** — Layer-A summary of the current-session-related scopes, fixed length
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

Runs at most once per session to avoid hot looping on short turns.

```js
const adjustment = await llm.call({
  model: fastModel,
  system: adjustPrompt,
  messages: [{ role: 'user', content: `Turn diff: ${diff}` }],
});
await applyAdjustment(ams, adjustment);
```

### Dream (heavyweight, background)
`dream/` is a background daemon loop:
1. Detect which scopes have undigested conversation history
2. Use an LLM to **slice** the conversation into atomic segments
3. Append the new segments to the scope's `memory.md`
4. Update the Layer-A summary
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
Open `~/.yeaft/memory/<scope>/memory.md`. Plain markdown.

### Inspect the recall process
The Yeaft Web **Debug panel** shows per-turn preflow recall details:
- Which scopes were searched
- Which keywords were used
- Which segments were recalled
- Which made it into AMS / which got cut by budget

### Inspect the FTS index
```bash
sqlite3 ~/.yeaft/memory/index.db
> SELECT segment_id, keywords FROM segments WHERE body MATCH 'typescript';
```

## Backup / Migration

Memory is all files — `tar` `~/.yeaft/memory/` and you have a backup. To migrate: extract back to `~/.yeaft/memory/` on the new machine and start the Agent. Use `seed-backfill.js` to rebuild the FTS index.

## Key Files

```
agent/yeaft/memory/
  segment-store.js   — segment storage primitive (writes memory.md)
  segment-sync.js    — sync FTS on segment write/delete
  segment.js         — segment record helpers
  index-db.js        — SQLite FTS5 index
  store.js           — Layer-A summary read/write
  summary-store.js   — summary persistence
  ams.js             — Active Memory Set cache
  ams-registry.js    — session-level AMS hydrate/persist
  budget.js          — token budget calculator
  keywords.js        — FTS keyword extractor
  preflow.js         — pre-turn recall
  adjust.js          — post-turn adjustment
  seed-backfill.js   — historical data migration
```

> The dream loop itself lives in `agent/yeaft/dream/`, not in `memory/`. Consolidation triggers live in `agent/yeaft/dream/consolidate.js`.

## Design Trade-offs

**Why not vector search?** FTS5 + keywords + segment-level markdown is precise enough (recall ≥80% for our use cases), and it's **explainable / debuggable / backupable**. Vector search needs an embedding service + index rebuild + binary blobs — high maintenance, not much precision gain for short memory segments.

**Why is the Layer-A summary stored separately?** It's the LLM-maintained "current state of long-term memory" — more stable than raw segments. At recall time it's **read directly**, skipping the FTS query for latency savings.

**Why is dream backgrounded?** Dream involves LLM calls (expensive + slow); it can't block user turns. It's eventual consistency — what you said today may not be digested into segments until tomorrow.
