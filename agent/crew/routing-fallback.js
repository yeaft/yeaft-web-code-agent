/**
 * task-330b — Single fallback-target resolver (Final Spec §B item 3).
 *
 * Replaces ad-hoc `session.decisionMaker` lookups scattered across
 * routing.js / role-output.js / human-interaction.js when a message has
 * nowhere obvious to go. Centralising this in ONE function lets us:
 *
 *   - test the fallback policy in isolation
 *   - add per-reason policy without touching every call site
 *   - keep the §B `recordRoutingEvent` calls right next to the decision
 *
 * Policy (mirrors what the codebase already does — this is a refactor,
 * not a behaviour change for the existing 4 reasons):
 *
 *   missing-route     → PM (decisionMaker) IF caller is non-PM AND has
 *                       active task or routing intent. Else: pending (null).
 *                       PM-no-auto-forward rule (§B item 2): if caller IS
 *                       PM → ALWAYS pending (null), even with active task.
 *   parse-fail        → PM (decisionMaker)
 *   self-route        → null (rejected; §A handles, §B only logs)
 *   state-stopped     → null (let session.status block the dispatch)
 *   fallback-forward  → PM (decisionMaker) — explicit auto-forward path
 *
 * Returns the target role NAME, or null when "do nothing / pending".
 *
 * @param {object} session — crew session (.decisionMaker, .roles)
 * @param {string} fromRole
 * @param {string} reason — one of ROUTING_REASONS
 * @param {object} [opts]
 * @param {boolean} [opts.hasActiveTask]
 * @param {boolean} [opts.hasRouteIntent]
 * @returns {string|null}
 */
export function resolveFallbackTarget(session, fromRole, reason, opts = {}) {
  if (!session) return null;
  const dm = session.decisionMaker || null;

  switch (reason) {
    case 'missing-route': {
      // PM-no-auto-forward rule (§B item 2): PM never auto-forwards to
      // itself. Returning null signals "park as pending, wait for human".
      if (fromRole === dm) return null;
      // Non-PM: only auto-forward when there is something to forward
      // (active task OR detected routing intent in the prose).
      if (opts.hasActiveTask || opts.hasRouteIntent) return dm;
      return null;
    }
    case 'parse-fail':
      // Parser found a ROUTE block but couldn't read it — PM should see
      // the malformed output to decide next step.
      return dm;
    case 'self-route':
      // §A rejects self-routing; §B records, no fallback dispatch.
      return null;
    case 'state-stopped':
      // Session is stopped/paused; routing must not auto-resume here.
      return null;
    case 'fallback-forward':
      // Explicit safety net (the rename of the existing auto-forward).
      return dm;
    default:
      return null;
  }
}
