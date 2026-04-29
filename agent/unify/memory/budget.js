/**
 * memory/budget.js — DESIGN-H2-AMS §5.2.
 *
 * Memory budget = `min(50_000, modelMaxContext * 0.10)`.
 *
 * Then split across the three AMS layers (resident / recent / onDemand)
 * with a configurable ratio. The defaults are tuned for ~200k context
 * models (Claude / GPT-5):
 *
 *   resident   40%   →  20k   (all relevant scope summaries)
 *   recent     25%   →  12.5k (LRU of recently-used segments)
 *   onDemand   35%   →  17.5k (this turn's FTS recall)
 *
 * Token counting here is approximate (chars / 4) — accurate enough for
 * budget enforcement. The engine has a real tokenizer for prompt
 * assembly; budget here is a guard rail, not the source of truth.
 */

export const ABSOLUTE_CAP = 50_000;
export const MODEL_FRACTION = 0.10;

export const DEFAULT_RATIO = {
  resident: 0.40,
  recent:   0.25,
  onDemand: 0.35,
};

/**
 * @typedef {object} BudgetSplit
 * @property {number} total
 * @property {number} resident
 * @property {number} recent
 * @property {number} onDemand
 */

/**
 * @param {number} modelMaxContext   tokens of the model's full context window
 * @param {Partial<typeof DEFAULT_RATIO>} [ratio]
 * @returns {BudgetSplit}
 */
export function computeBudget(modelMaxContext, ratio = {}) {
  const ctx = Number.isFinite(modelMaxContext) && modelMaxContext > 0
    ? modelMaxContext : 200_000;
  const total = Math.min(ABSOLUTE_CAP, Math.floor(ctx * MODEL_FRACTION));

  const r = { ...DEFAULT_RATIO, ...ratio };
  // Normalise so ratios sum to 1 (defensive).
  const sum = r.resident + r.recent + r.onDemand;
  const norm = sum > 0 ? sum : 1;
  return {
    total,
    resident: Math.floor(total * (r.resident / norm)),
    recent:   Math.floor(total * (r.recent   / norm)),
    onDemand: Math.floor(total * (r.onDemand / norm)),
  };
}

/**
 * Approximate token count of a string. Avg English ≈ 4 chars / token,
 * Chinese ≈ 1 char / token. We use a conservative blended estimate.
 *
 * @param {string} text
 * @returns {number}
 */
export function approxTokens(text) {
  if (!text) return 0;
  // Count CJK chars as ~1 token each, the rest as char/4.
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) || 0;
    if (
      (c >= 0x4e00 && c <= 0x9fff) ||
      (c >= 0x3040 && c <= 0x309f) ||
      (c >= 0x30a0 && c <= 0x30ff) ||
      (c >= 0xac00 && c <= 0xd7af)
    ) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return Math.ceil(cjk + other / 4);
}

/**
 * Greedy pack: pick items in order until adding the next would exceed
 * the budget. Returns the picked list and the total cost. Does NOT
 * sort — caller decides ordering.
 *
 * @template T
 * @param {T[]} items
 * @param {number} budget
 * @param {(item: T) => number} costFn
 * @returns {{ picked: T[], cost: number, dropped: T[] }}
 */
export function packWithinBudget(items, budget, costFn) {
  const picked = [];
  const dropped = [];
  let cost = 0;
  for (const it of items) {
    const c = costFn(it);
    if (cost + c <= budget) {
      picked.push(it);
      cost += c;
    } else {
      dropped.push(it);
    }
  }
  return { picked, cost, dropped };
}
