/**
 * stock-ids.js — single source of truth for "is this vpId a stock seed VP?".
 *
 * Owns the canonical list of seed vpIds and exposes `STOCK_VP_IDS` (a Set
 * for O(1) lookup) plus `isStockVpId(vpId)`.
 *
 * Why this lives in its own tiny module instead of in seed-defaults.js:
 *   `seed-defaults.js` imports `createVp / VpCrudError` from `vp-crud.js`,
 *   so if `vp-crud.js` were to import `STOCK_VP_IDS` from `seed-defaults`
 *   directly, the module graph would be circular (vp-crud → seed-defaults
 *   → vp-crud). The cycle "works" today only because every consumer reads
 *   STOCK_VP_IDS inside a function body (live binding), but a future
 *   refactor that moves the check to module top level — say, to validate
 *   input on import — would crash with `STOCK_VP_IDS is undefined`. Moving
 *   the Set into a leaf module with zero inbound deps from elsewhere in
 *   the package breaks the cycle for good.
 *
 * Authoritative-vs-derived: this file is the SOURCE OF TRUTH for stock
 * ids. seed-defaults.js asserts at module load that every entry in
 * DEFAULT_VPS appears here, and vice versa — see the self-check at the
 * bottom of seed-defaults.js. So adding a new seed VP only requires
 * adding both the persona object *and* its id here (two-file change,
 * caught by the assertion if you forget either).
 */

const STOCK_VP_ID_LIST = Object.freeze([
  // engineering
  'steve', 'linus', 'martin', 'dieter', 'ada', 'grace', 'alice', 'ken',
  'margaret', 'shannon', 'alan', 'norman',
  // philosophy / psychology
  'kongzi', 'socrates', 'nietzsche', 'kahneman', 'jung',
  // strategy / business
  'sunzi', 'clausewitz', 'simaqian', 'harari',
  'buffett', 'munger', 'dalio', 'bezos', 'drucker',
  // arts / culture
  'luxun', 'sudongpo', 'borges', 'einstein', 'kubrick', 'miyazaki',
]);

/** @type {ReadonlySet<string>} */
export const STOCK_VP_IDS = new Set(STOCK_VP_ID_LIST);

/**
 * True iff `vpId` is a stock seed VP that ships with the agent.
 * Pure function of the string — undefined / non-string input returns false.
 *
 * @param {unknown} vpId
 * @returns {boolean}
 */
export function isStockVpId(vpId) {
  return typeof vpId === 'string' && STOCK_VP_IDS.has(vpId);
}
