/**
 * effort.js — Scenario → effort decision tree for Yeaft
 *
 * task-327b: given a per-query context (scenario tag, tool-loop depth,
 * user override), pick the thinking/reasoning effort level that should be
 * passed to `adapter.stream({ effort })`.
 *
 * Config layering (highest wins):
 *   1. userEffort (explicit per-query override — from `/max` prefix,
 *      Settings slider, or API caller)
 *   2. scenarioEffort (from the decision tree below)
 *   3. model defaultEffort (from registry) — handled at adapter level
 *   4. null (no effort = adapter/router drops the param)
 *
 * Red lines:
 *   • Never error on unknown scenario — default to 'max'.
 *   • Feature flag YEAFT_THINKING_V1 is enforced at the adapter/router
 *     layer; this module just computes the intended value. If the flag
 *     is off, adapters drop it anyway.
 *   • Unsupported models silently drop effort at the router — this
 *     module does NOT consult the capability matrix.
 */

import { normalizeEffort } from './models.js';

/**
 * Number of tool-loop turns past which a query is considered "complex"
 * and gets an auto-bump from 'high' to 'max'. Tuned to catch genuine
 * multi-hop work (code refactor across many files, sub-agent coordination)
 * without punishing normal 2–3 tool chat turns.
 */
export const LONG_LOOP_TURN_THRESHOLD = 8;

/**
 * Scenario → default effort mapping. The engine tags each LLM call with
 * a scenario string before invoking `pickEffort()`.
 *
 * Tiers (6 scenarios per architect spec):
 *   chat          → max    (default interactive pair-programming turn —
 *                            quality over latency; per user 2026-05-22)
 *   consolidate   → max    (memory compaction — quality matters, runs once)
 *   dream         → max    (memory maintenance — same rationale)
 *   sub_agent     → max    (coordinator spawns + merges)
 *   long_loop     → max    (auto-bumped when toolLoopTurns >= threshold)
 *   recall        → low    (keyword/tag pre-filter — cheap classifier)
 *   light         → low    (side-queries: summary title, extract pass1)
 *
 * Unknown scenarios fall through to 'high'.
 */
export const SCENARIO_EFFORT = Object.freeze({
  chat: 'max',
  consolidate: 'max',
  dream: 'max',
  sub_agent: 'max',
  long_loop: 'max',
  recall: 'low',
  light: 'low',
});

/**
 * Pick the effort level for a given query context.
 *
 * Decision order:
 *   1. If userEffort is a valid Effort ('minimal'|'low'|'medium'|'high'|'xhigh'|'max'),
 *      return it unchanged. This is the explicit override path —
 *      `/max` prefix, Settings slider, or API caller.
 *   2. If toolLoopTurns >= LONG_LOOP_TURN_THRESHOLD, upgrade the
 *      base scenario to 'long_loop' (→ 'max').
 *   3. Look up SCENARIO_EFFORT[scenario]; unknown → 'max'.
 *
 * @param {object} ctx
 * @param {string} [ctx.scenario='chat'] — Scenario tag; see SCENARIO_EFFORT.
 * @param {number} [ctx.toolLoopTurns=0] — Number of tool-use turns
 *   already consumed in the current `query()` call.
 * @param {unknown} [ctx.userEffort=null] — User-supplied override.
 *   Invalid values are ignored (fall through to scenario path).
 * @returns {'minimal'|'low'|'medium'|'high'|'xhigh'|'max'} Resolved effort. Never null —
 *   the adapter/router is responsible for dropping it when the
 *   feature flag is off or the model doesn't support thinking.
 */
export function pickEffort({ scenario = 'chat', toolLoopTurns = 0, userEffort = null } = {}) {
  // 1. Explicit user override wins.
  const normUser = normalizeEffort(userEffort);
  if (normUser) return normUser;

  // 2. Long-loop auto-bump (only when scenario was a "normal" one).
  //    If the scenario is already 'recall' / 'light' (explicitly cheap),
  //    we respect the operator's intent and don't bump — those are
  //    classifier calls where depth doesn't imply complexity.
  const cheap = scenario === 'recall' || scenario === 'light';
  if (!cheap && typeof toolLoopTurns === 'number' && toolLoopTurns >= LONG_LOOP_TURN_THRESHOLD) {
    return SCENARIO_EFFORT.long_loop;
  }

  // 3. Scenario table lookup.
  return SCENARIO_EFFORT[scenario] || 'max';
}

/**
 * Parse a user prompt for `/max`, `/xhigh`, `/high`, `/medium`, `/low` prefix
 * commands. Returns `{ effort, cleanedPrompt }` where cleanedPrompt has
 * the prefix (plus one trailing space) stripped.
 *
 * Red line: only ONE leading prefix is honoured — stacking (`/max /high
 * hello`) just eats the first and leaves the rest untouched.
 *
 * PM decision (task-327): `/max` prefix is retained; skills trigger
 * via `!` or `/skill:` instead to avoid collision.
 *
 * @param {string} prompt
 * @returns {{ effort: 'low'|'medium'|'high'|'xhigh'|'max'|null, cleanedPrompt: string }}
 */
export function parseEffortPrefix(prompt) {
  if (typeof prompt !== 'string') return { effort: null, cleanedPrompt: prompt };
  const m = prompt.match(/^\/(max|xhigh|high|medium|low)(\s+|$)/);
  if (!m) return { effort: null, cleanedPrompt: prompt };
  const effort = m[1];
  const cleanedPrompt = prompt.slice(m[0].length);
  return { effort, cleanedPrompt };
}
