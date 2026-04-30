/**
 * dream-v2/limits.js constants.
 *
 * Centralised so tests and runtime share one source of truth. Exposed
 * as both named exports and a `DEFAULT_LIMITS` object for `runDream()`
 * callers that want to override one knob without restating the rest.
 *
 * `loadLimitsFromConfig(config)` merges a `~/.yeaft/config.json`
 * `unify.dream` block on top of defaults; unknown keys are ignored,
 * malformed values fall back to default.
 */

export const DREAM_INTERVAL_HOURS = 12;
export const DREAM_OVERLAP = 3;
export const MIN_NEW_PER_GROUP = 20;
export const MAX_SINGLE_MESSAGE_CHARS = 8000;
export const MAX_DIFF_TOKENS_PER_TRIAGE = 60000;
export const MAX_APPLY_TOKENS = 80000;
export const DREAM_BACKUP_KEEP = 7;

export const DEFAULT_LIMITS = Object.freeze({
  DREAM_INTERVAL_HOURS,
  DREAM_OVERLAP,
  MIN_NEW_PER_GROUP,
  MAX_SINGLE_MESSAGE_CHARS,
  MAX_DIFF_TOKENS_PER_TRIAGE,
  MAX_APPLY_TOKENS,
  DREAM_BACKUP_KEEP,
});

/**
 * Merge a config object's `unify.dream` block on top of defaults.
 * @param {object} [config]
 */
export function loadLimitsFromConfig(config) {
  const out = { ...DEFAULT_LIMITS };
  const ud = config && config.unify && config.unify.dream;
  if (!ud || typeof ud !== 'object') return out;
  for (const k of Object.keys(out)) {
    if (Object.prototype.hasOwnProperty.call(ud, k)) {
      const v = ud[k];
      if (Number.isFinite(v) && v > 0) out[k] = v;
    }
  }
  return out;
}
