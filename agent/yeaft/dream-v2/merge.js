/**
 * dream-v2/merge.js.
 *
 * Pure-code stage between Triage and Apply.
 *
 * Triage emits per-group action lists; the runner needs to flip that
 * into a per-target source list so Apply runs once per target rather
 * than once per (group × target) pair. (User scope in particular would
 * be rewritten dozens of times if we didn't merge.)
 *
 * Input shape (one entry per group that crossed the newCount threshold):
 *
 *   [
 *     {
 *       sessionId: 'g-eng',
 *       diff: [<message>, ...],            // the per-group source diff
 *                                          // (already truncated/segmented if needed)
 *       actions: [
 *         { kind: 'update', scope: 'group/g-eng' },
 *         { kind: 'update', scope: 'vp/zhang-san' },
 *         { kind: 'update', scope: 'user' },
 *         { kind: 'create', scope: 'topic/life/parenting' },
 *         ...
 *       ],
 *     },
 *     ...
 *   ]
 *
 * Output shape:
 *
 *   [
 *     { target: 'user',
 *       kind: 'update',                    // 'update' wins over 'create' if any group says update
 *       sources: [
 *         { sessionId: 'g-eng',  diff: [...] },
 *         { sessionId: 'g-life', diff: [...] },
 *       ],
 *     },
 *     { target: 'topic/life/parenting',
 *       kind: 'create',                    // create only if every contributing group said create
 *       sources: [{ sessionId: 'g-life', diff: [...] }],
 *     },
 *     ...
 *   ]
 *
 * Determinism contract:
 *   - Targets are returned sorted alphabetically by target path.
 *   - Within a target, sources are sorted by sessionId.
 *   This makes the debug-panel output predictable across runs.
 */

/**
 * Merge per-group triage outputs into per-target apply units.
 *
 * @param {Array<{ sessionId: string, diff: any, actions: Array<{ kind: 'update'|'create', scope: string }> }>} groupTriages
 * @returns {Array<{ target: string, kind: 'update'|'create', sources: Array<{ sessionId: string, diff: any }> }>}
 */
export function mergeByTarget(groupTriages) {
  const byTarget = new Map();
  for (const g of (groupTriages || [])) {
    const sessionId = g && g.sessionId;
    const diff = g && g.diff;
    const actions = Array.isArray(g && g.actions) ? g.actions : [];
    if (!sessionId) continue;
    for (const a of actions) {
      if (!a || !a.scope) continue;
      const k = a.kind === 'create' ? 'create' : 'update';
      let entry = byTarget.get(a.scope);
      if (!entry) {
        entry = { target: a.scope, kind: k, sources: [] };
        byTarget.set(a.scope, entry);
      }
      // 'update' wins: any contributing group that already considers
      // the scope existing means we treat the apply as an update.
      if (k === 'update') entry.kind = 'update';
      // Avoid duplicate (target, group) pairs — should never happen
      // in normal triage but be defensive.
      if (!entry.sources.some(s => s.sessionId === sessionId)) {
        entry.sources.push({ sessionId, diff });
      }
    }
  }
  const out = Array.from(byTarget.values());
  out.sort((a, b) => a.target.localeCompare(b.target));
  for (const e of out) e.sources.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  return out;
}
