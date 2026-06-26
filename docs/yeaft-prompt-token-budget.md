# Yeaft System Prompt — Token Budget

> Authoritative budget doc for Yeaft's assembled system prompt.
> **Source of truth:** `agent/yeaft/prompts.js` `buildSystemPrompt()`.
> **Ceiling:** **8,000 tokens** (soft cap; the engine does not enforce, but any section breaching its share is a regression).
> **Measurement unit:** "token" below uses the `4 chars ≈ 1 token` heuristic — exact counts are provider-specific (cl100k / o200k / Anthropic tokenizer differ by up to ~15%). Use `scripts/dump-prompt.js` for a real count.

---

## 1. Layered model

```
┌────────────────────────────────────────────────────────────────┐
│  FINAL ASSEMBLED SYSTEM PROMPT  (target ≤ 8k tokens)           │
├────────────────────────────────────────────────────────────────┤
│  STATIC  — identity, mode instructions, tool guidance          │
│           (loaded once from templates/, constant per language) │
├────────────────────────────────────────────────────────────────┤
│  DYNAMIC — tool name list, skill content, compact summary      │
│           (changes per session, rebuilt each turn)             │
├────────────────────────────────────────────────────────────────┤
│  CONTEXT — memory injection (index + recalled entries)         │
│           (rebuilt each turn, provides project/user ground)    │
└────────────────────────────────────────────────────────────────┘
```

The separation matters for cache hit rate: STATIC must stay byte-stable
across turns; DYNAMIC may drift; CONTEXT always drifts. Splitting the
prompt this way lets the adapter mark STATIC for prompt-caching.

---

## 2. Section-by-section budget

The table below is the **contract**. Any section that exceeds its upper
bound without a PM-approved spec change is a bug.

| # | Section | Source | Target | Hard ceiling | Current† | Notes |
|---|---------|--------|--------|--------------|----------|-------|
| 1 | Core identity | `templates/base.md` | ~1000 | 1500 | **~985** | Who Yeaft is, core principles, bilingual en/zh. One of two sections users "see" via persona. |
| 2 | Date metadata | `new Date().toISOString()` | <20 | 30 | ~12 | Single line, cheap. |
| 3 | Mode instructions | `templates/mode-unified.md` **or** `mode-dream.md` | ~800 | 1200 | **~790** (unified) / **~925** (dream) | Only ONE is ever included per turn. |
| 4a | Tool list | `toolNames.join(', ')` | ~300 | 600 | **~310** for 36 tools | Names only, no per-tool doc. |
| 4b | Tool guidance | `templates/tool-guidance.md` | ~750 | 1000 | **~745** | When/why to use tools; not per-tool reference. |
| 5 | Skills | `skillContent` (from SkillManager) | ≤1000 | 1500 | variable | Empty when no skills loaded; grows with installed skills. |
| 6 | Memory injection | `memoryInjection` (from `memory/preflow.js` FTS recall + AMS layers) | ~1500 | 2000 | variable | Memory Index + user preferences + optional project header. |
| 7 | Compact summary | `compactSummary` (consolidator output) | ≤800 | 1500 | variable | Present only after consolidation fires. |
| — | Joining `\n\n` whitespace | — | <50 | 100 | ~20 | Seven `\n\n` separators. |

**† Current ("as-of 2026-04-19"):** measured by `wc -c` on each template
divided by 4 (char→token heuristic). Actual counts via `scripts/dump-prompt.js`
will differ slightly per tokenizer.

### Totals

| Scenario | Static | Dynamic | Context | Total | vs 8k cap |
|----------|--------|---------|---------|-------|-----------|
| **Minimum** (cold session, no skills, no memory, no compact) | 985 + 790 + 745 = **2,520** | 310 | 0 | **~2,830** | 35% used |
| **Typical** (full skills ~500, memory ~1,200, no compact) | 2,520 | 310 + 500 = 810 | 1,200 | **~4,530** | 57% used |
| **Loaded** (full skills, full memory, post-consolidation summary) | 2,520 | 810 | 1,200 + 800 = 2,000 | **~5,330** | 67% used |
| **Dream mode** (dream instead of unified; no skills, no tools, small memory) | 985 + 925 = 1,910 | 0 | 500 | **~2,410** | 30% used |
| **Ceiling hit** (all sections at hard ceiling) | 1,500 + 1,200 + 1,000 = 3,700 | 600 + — | 2,000 + 1,500 = 3,500 | **~7,800** | 98% used — alarm |

We are well inside budget at "Typical". The 8k cap is there to prevent
silent drift when memory or skills grow over time.

---

## 3. Growth risks (watch-list)

| Risk | Section | Mitigation |
|------|---------|------------|
| Tool catalog grows (dev adds 20 more tools) | 4a | Names-only listing caps growth at ~8 tokens/tool; at 100 tools we still fit. No mitigation needed until >150. |
| Per-tool inline docs creep in | 4b | **Red line**: `tool-guidance.md` must stay behavioural, NOT per-tool reference. Per-tool docs belong to the tool's `description` field, which the LLM reads via `tools` array, not the system prompt. |
| Memory injection explodes on large projects | 6 | `memory/preflow.js` caps recall hits + AMS layers (Resident/Recent/OnDemand) are token-budgeted. Cap stays ≤ 2k. |
| Compact summary never truncates | 7 | Consolidator must clip to ≤ 1.5k. If `compactSummary` regularly > 2k, that's a bug in `memory/consolidate.js`. |
| Skill pack install blows up | 5 | SkillManager must cap total skill content ≤ 1.5k. Long skills go to `~/.yeaft/skills/` and are read on demand via `Skill` tool, not injected. |

---

## 4. Reserved for future sections (not yet implemented)

The current `buildSystemPrompt()` layout is 7 sections. The following are
candidates flagged by dev-2's task-332 analysis (F2 does NOT add them —
they're listed here for budget planning only):

| Candidate | Est. size | Section # |
|-----------|-----------|-----------|
| Env / CWD header (cwd, os, shell, node version) | ~150 | 1.5 |
| Capability manifest (what Yeaft *can't* do, e.g., "no GUI, no camera") | ~200 | 1.6 |
| Language auto-switch hint | ~80 | 1.7 |
| Assembled-prompt snapshot test hook | 0 (test only) | — |

If all four land, add ~430 tokens to every scenario above. Still well inside 8k.

---

## 5. How to measure

```
# Dump the prompt that would be sent with a given mode + model
node scripts/dump-prompt.js --mode unified --language en
node scripts/dump-prompt.js --mode dream --language zh
node scripts/dump-prompt.js --mode unified --include-memory --include-compact
```

The script prints the assembled prompt plus per-section byte/token stats,
compares against this doc's ceilings, and exits non-zero if any section
exceeds its hard ceiling. Wire it into CI when the budget stops moving.

---

## 6. Changelog

| Date | Change | By |
|------|--------|-----|
| 2026-04-19 | Initial doc — task-332 F2 補強方案, parallel to dev-2 gap analysis | dev-2 (F2) |

---

## References

- `agent/yeaft/prompts.js` — `buildSystemPrompt()` implementation
- `agent/yeaft/templates/*.md` — per-section static content
- `agent/yeaft/memory/preflow.js` — FTS recall feeding section 6
- `scripts/dump-prompt.js` — budget measurement tool
