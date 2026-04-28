# dream-v2 — placeholder

This directory currently holds the **R6-era** dream-v2 prototype:

- `diff-gate.js`
- `refresh.js`
- `scope-sig.js`
- `tick.js`

These are **deprecated** by the new design captured in
[`agent/unify/memory/DESIGN-v2.md`](../memory/DESIGN-v2.md).

## Migration plan

The new design replaces the sig-diff-gate trigger model with a 12h /
manual schedule, per-group triage with hard rules + 2-pass soft
classification, target-merge, batched apply, and overlap windows. See
the design doc for the full pipeline.

Implementation lands across 5 PRs:

| PR | Scope |
|---|---|
| PR-A | DESIGN-v2.md + this README (no runtime change) |
| PR-B | `store-v2` (memory.md + summary.md API) + scope-tree topic + migration script |
| PR-C | `dream-v2/` rewrite — `runner.js`, `triage.js`, `merge.js`, `apply.js`, `segment.js`, `snapshot.js`, `state.js`, `schedule.js`, prompt templates |
| PR-D | `recall-v2` + engine flag (shadow mode) |
| PR-E | Debug panel upgrade, flip default flag on, delete the four files above + the legacy memory dream paths |

Until PR-C lands, the four files above remain in service. Do not add
new code that depends on them.
