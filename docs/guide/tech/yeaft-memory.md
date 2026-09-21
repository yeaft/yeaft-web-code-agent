# H2-AMS Memory (Retired)

> **Retired runtime implementation:** Dream/H2-AMS is disabled. Startup does not migrate or synchronize this store, and interactive turns, history loading, and Work Center do not read or inject it. Legacy files, indexes, modules, and command entry points remain for data compatibility and technical reference; enable/manual commands report `disabled`. Historical messages and ordinary debug data are retained. Post-turn compact is a separate active history-window feature.

The remainder of this page documents the retained implementation and historical data format, not current runtime behavior.

H2-AMS is the native Yeaft engine's scoped persistent-memory system. It uses readable Markdown as the source of truth, SQLite FTS5 as a rebuildable search index, and a budgeted in-memory Active Memory Set (AMS) for the current Session.

> This page describes developer-facing behavior. For the user boundary, see [Yeaft Sessions and Projects](../user/yeaft-session.md#memory-boundaries) and [Work Center](../user/work-center.md#memory-reuse).

## Goals

- recall useful information across turns and eligible Sessions;
- keep user, VP, Session, and related scopes isolated;
- preserve source identity and ACL checks;
- remain inspectable without a vector database;
- inject a bounded memory block rather than unbounded history.

Memory retrieval is reference context. It does not outrank the system prompt, current user request, WorkItem contract, or tool/safety policy.

## Storage and index

For each scope, the memory root can contain:

```text
<scope>/memory.md             multiple serialized atomic segments
<scope>/summary.md            bounded English/default summary
<scope>/summary.zh.md         optional Chinese summary
```

`segment-store.js` parses and atomically rewrites the multi-segment `memory.md`. `store.js` was the scope/path/ACL boundary for runtime readers and writers. `summary-store.js` manages the bounded Layer-A summary.

`index-db.js` maintains a derived SQLite database:

- one `memory_segments` row per atomic segment;
- an FTS5 table over body, tags, and scope;
- `source_msgs` storing normalized source message IDs;
- indexes by scope and update time.

The Markdown files are the source of truth. `segment-sync.js` can rebuild/synchronize the FTS index from disk.

## Scope model

Scope is the isolation dimension. The retained storage implementation recognizes historical and compatibility layouts, including:

| Scope family | Purpose |
| --- | --- |
| `user` | Agent user preferences/profile available to authorized native work |
| `chat/<chatId>` and nested `chat/.../vp/<vpId>` | Active 1:1 native/CLI Session memory |
| `sessions/<sessionId>` and nested user/VP/feature/topic paths | Current Session-shaped storage layout |
| `group/<sessionId>` and nested paths | Historical storage-compatible Session layout still read during migration |
| VP/sub-agent scopes used by prompt and Dream paths | Role-specific or child-agent memory |
| topic/feature compatibility scopes | Bounded semantic collaboration scopes where current readers authorize them |

New domain code uses Session terminology. The storage layer must continue reading legacy `group` paths until persisted data is migrated.

The VP ACL blocks another VP's nested private path when a current VP identity is present. Higher-level owner/session authorization is resolved before scopes reach the memory store.

## Active Memory Set

AMS is Session-scoped and held in memory by `ams-registry.js`. It has three layers:

1. **Resident** — summaries for relevant scopes;
2. **Recent** — recently touched high-priority segments;
3. **OnDemand** — FTS hits selected for the current task.

`budget.js` allocates token limits across these layers. `preflow.js` extracts searchable keywords, queries only authorized scopes, hydrates OnDemand hits, and renders one memory block for the prompt.

The registry persists enough Session state to hydrate AMS after restart, including whether the LLM adjustment has run for that Session. The rendered prompt block itself is rebuilt rather than treated as a second source of truth.

## Read path

Before a native turn:

1. Session pre-flow determines the authorized user, VP, current Session, and related Project-Session scopes.
2. Project sibling recall is limited to Sessions on the same Agent and retains source Session identity.
3. Keywords are derived from the current task.
4. FTS5 returns ranked matching segments within the scope filter.
5. AMS combines summaries, recent segments, and OnDemand hits within budget.
6. The prompt renderer clearly labels memory as reference context.

Project recall does not merge transcripts. A sibling Session contributes a source-labelled scope summary/segment only when the current Agent and Project membership authorize it.

## Write path

Conversation messages are not copied directly into every memory scope. Durable extraction happens through Dream maintenance:

1. collect eligible conversation/diff input;
2. ask the maintenance model for atomic facts with scope, tags, source message IDs, and timestamps;
3. merge/deduplicate segments in the scope's `memory.md`;
4. synchronize the derived FTS index;
5. regenerate affected scope summaries.

`adjust.js` is separate from durable extraction. It can correct AMS membership based on the current turn. It is guaranteed an initial adjustment opportunity and may run again only under the implemented budget-pressure/change policy; it is not an unconditional LLM rewrite after every turn.

## Dream maintenance

Dream is a background maintenance operation with a restricted prompt/tool contract. It slices source material, rejects malformed or unsafe scope writes, updates atomic segments, and refreshes summaries. Dream output is memory data, not a user-authored turn.

Source message normalization matters: persisted segment metadata stores IDs, while Markdown source text is a debug/history fallback. This prevents raw message objects from leaking into memory provenance fields.

## Historical Work Center memory reuse

Work Center does not share one memory owner with Sessions. With `reuseMemory=true`, a WorkItem may compute three bounded candidates:

- scope-bounded FTS recall from the current Agent;
- structured summary/evidence from completed WorkItems with the same canonical workspace key;
- user-visible excerpts from ordinary Sessions resolved to the same canonical workspace.

Browser-created and legacy items read the Agent user scope. A trusted Session producer may also authorize source Session and current VP scopes. Workspace-Session recall verifies the canonical path, is owner-local, excludes the current source Session, and does not expose raw tool output.

Candidate computation is not identical to prompt injection. Execution schema v1 appends non-empty runner-computed memory/workspace blocks. Schema v2 currently renders immutable Mainline context plus a fixed suffix and does not append those precomputed blocks. All context is token-bounded and cannot override the WorkItem contract or execution rules. `reuseMemory=false` disables the three candidates.

## Operational cautions

- Memory files and the FTS database may contain sensitive project facts.
- Raw debug output and Dream input should remain inside the owning Agent boundary.
- Deleting a Session/VP must clear or migrate all owned memory paths; partial cleanup can expose stale context on ID reuse.
- Scope path changes require compatibility readers and explicit migration, not blind renames.
- FTS is lexical, not semantic vector search; missing keywords can reduce recall.
- Summary text is lossy. Important acceptance evidence should remain in the authoritative Session or WorkItem record.

## Main files

- `agent/yeaft/memory/store.js` — scope paths, I/O, and nested VP ACL
- `agent/yeaft/memory/segment-store.js` — segment serialization for `memory.md`
- `agent/yeaft/memory/index-db.js` — SQLite/FTS5 derived index
- `agent/yeaft/memory/segment-sync.js` — disk/index synchronization
- `agent/yeaft/memory/summary-store.js` — Layer-A summaries
- `agent/yeaft/memory/ams.js` / `ams-registry.js` — active memory and Session hydration
- `agent/yeaft/memory/preflow.js` — keyword recall and prompt injection
- `agent/yeaft/memory/adjust.js` — post-turn AMS membership adjustment
- `agent/yeaft/dream/` — durable background extraction and summary refresh
