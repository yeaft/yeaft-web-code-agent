# Yeaft System Prompt — Token Budget

> Authoritative budget doc for Yeaft's assembled system prompt.
> **Source of truth:** `agent/yeaft/prompts.js` `buildSystemPrompt()`.
> **Ceiling:** **8,000 tokens** (soft cap; the engine does not enforce, but any section breaching its share is a regression).
> **Measurement unit:** "token" below uses the `4 chars ≈ 1 token` heuristic. Exact counts are provider-specific; use `scripts/dump-prompt.js` for the assembled prompt estimate.

---

## 1. Layered model

```text
┌────────────────────────────────────────────────────────────────┐
│  FINAL ASSEMBLED SYSTEM PROMPT  (target ≤ 8k tokens)           │
├────────────────────────────────────────────────────────────────┤
│  STATIC  — identity and mode instructions                      │
│           (loaded from templates/, constant per language)      │
├────────────────────────────────────────────────────────────────┤
│  DYNAMIC — Project/Session instructions, platform, skills,     │
│            notices, and multi-VP routing when applicable       │
├────────────────────────────────────────────────────────────────┤
│  CONTEXT — AMS memory injection                                │
│           (rebuilt each turn, provides recalled context)       │
└────────────────────────────────────────────────────────────────┘
```

Tool schemas and their operational descriptions travel in the provider `tools` array. They are intentionally not repeated in the system prompt and therefore are not counted here.

---

## 2. Section-by-section budget

| Section | Source | Hard ceiling | Notes |
| --- | --- | ---: | --- |
| Core identity | `templates/core.md` and VP persona | 1,500 | Stable identity and core behavior. |
| Date metadata | `new Date().toISOString()` | 30 | Single line. |
| Mode instructions | `templates/mode-dream.md` when applicable | 1,200 | Normal interactive turns have no additional mode block. |
| Skills | `skillContent` from SkillManager | 1,500 | Selected by relevance; empty when no skill is loaded. |
| Memory injection | AMS-rendered `memoryInjection` | 2,000 | Single memory outlet; includes bounded recalled context. |
| Joining whitespace | prompt assembly | 100 | Separators between sections. |

The remaining budget covers optional Project/Session instructions, project docs, runtime notices, platform metadata, and multi-VP routing. The aggregate prompt must stay below the 8,000-token soft cap.

---

## 3. Growth risks

| Risk | Mitigation |
| --- | --- |
| Tool descriptions grow | Keep them in provider tool schemas; do not duplicate them in the system prompt. |
| Memory injection grows | AMS Resident/Recent/OnDemand layers are token-budgeted. |
| Runtime history grows | `history-window.js` deterministically caps the provider message window without rewriting persisted history. |
| Skill content grows | SkillManager caps injected content; long references stay in skill files and are read on demand. |
| Project instructions or docs grow | Keep ownership-specific text bounded at its existing loader and selection boundary. |

---

## 4. How to measure

```bash
node scripts/dump-prompt.js --mode unified --language en
node scripts/dump-prompt.js --mode dream --language zh
node scripts/dump-prompt.js --mode unified --include-memory --include-skill
node scripts/dump-prompt.js --mode unified --include-memory --budget-check
```

The script prints the assembled prompt plus approximate section and total token counts, and exits non-zero when a configured ceiling is breached.

---

## References

- `agent/yeaft/prompts.js` — `buildSystemPrompt()` implementation
- `agent/yeaft/templates/*.md` — static prompt fragments
- `agent/yeaft/memory/` — AMS memory assembly and recall
- `scripts/dump-prompt.js` — budget measurement tool
