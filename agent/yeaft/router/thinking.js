/**
 * router/thinking.js — DESIGN.md §9.16 thinking-mode precedence chain.
 *
 * Resolves the final `thinking` value the engine should pass to the
 * adapter, given the four signal sources:
 *
 *   1. UI override     (highest)  — submitOptions / topbar selector
 *   2. Router plan     —           — per-plan thinking field
 *   3. VP default      —           — vp/<id>/role.md frontmatter
 *   4. Global default  (lowest)    — config.thinking.default
 *
 * Allowed values: `'high' | 'max' | null`. (`null` ⇒ adapter drops the
 * field; provider-specific normalisation happens at the adapter via
 * `models.js#normalizeEffort`.)
 *
 * Continuity rule (§9.16): when no UI override is in force AND the router
 * did not change its recommendation versus the prior plan, keep the prior
 * plan's value. Anthropic prompt cache keys include the thinking field;
 * unstable values cause prefix re-encoding every turn.
 *
 * The `allowRouterEscalate: false` config gate hard-blocks the router
 * from bumping below→`max`. UI overrides bypass that gate (they're the
 * user's direct intent, not a heuristic).
 */

const ALLOWED = new Set([null, 'high', 'max']);

/**
 * @param {*} v
 * @returns {'high'|'max'|null}
 */
function clean(v) {
  if (v === undefined) return null;
  return ALLOWED.has(v) ? v : null;
}

/**
 * @param {{
 *   uiOverride?: 'high'|'max'|null,
 *   routerPlan?: 'high'|'max'|null,
 *   priorPlan?: 'high'|'max'|null,
 *   vpDefault?: 'high'|'max'|null,
 *   globalDefault?: 'high'|'max'|null,
 *   allowRouterEscalate?: boolean,
 * }} signals
 * @returns {{ value: 'high'|'max'|null, source: 'ui'|'router'|'prior'|'vp'|'global'|'default' }}
 */
export function resolveThinking(signals = {}) {
  const ui = clean(signals.uiOverride);
  if (ui) return { value: ui, source: 'ui' };

  const router = clean(signals.routerPlan);
  const prior = clean(signals.priorPlan);
  const vp = clean(signals.vpDefault);
  const global_ = clean(signals.globalDefault);
  const escalateOk = signals.allowRouterEscalate !== false;

  // Continuity: if router agrees with prior or is silent, prefer prior to
  // keep the cache key stable.
  if (router && prior && router === prior) {
    return { value: prior, source: 'prior' };
  }

  if (router) {
    // allowRouterEscalate=false hard-blocks router from emitting 'max'
    // when the baseline is 'high'.
    const baseline = prior || vp || global_ || 'high';
    if (!escalateOk && router === 'max' && baseline !== 'max') {
      return { value: baseline, source: prior ? 'prior' : (vp ? 'vp' : 'global') };
    }
    return { value: router, source: 'router' };
  }

  if (prior) return { value: prior, source: 'prior' };
  if (vp) return { value: vp, source: 'vp' };
  if (global_) return { value: global_, source: 'global' };
  return { value: 'high', source: 'default' };
}
