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
 *   • The ordinary picker preserves existing scenario defaults. Child effort
 *     is separately constrained by the capability-aware final payload helpers.
 *   • Child ceilings cannot be disabled by YEAFT_THINKING_V1, user overrides,
 *     routing, nesting, or extraBody. Unsupported models omit effort fields.
 */

import {
  normalizeEffort, getThinkingCapability, getModelEffortOptions, thinkingBudgetForEffort,
} from './models.js';

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
 *   1. If userEffort is a valid Effort ('minimal'|'low'|'medium'|'high'|'xhigh'|'max'|'ultra'),
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
 * @returns {'minimal'|'low'|'medium'|'high'|'xhigh'|'max'|'ultra'} Resolved effort. Never null —
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
 * Parse a user prompt for `/ultra`, `/max`, `/xhigh`, `/high`, `/medium`, `/low` prefix
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
 * @returns {{ effort: 'low'|'medium'|'high'|'xhigh'|'max'|'ultra'|null, cleanedPrompt: string }}
 */
export function parseEffortPrefix(prompt) {
  if (typeof prompt !== 'string') return { effort: null, cleanedPrompt: prompt };
  const m = prompt.match(/^\/(ultra|max|xhigh|high|medium|low)(\s+|$)/);
  if (!m) return { effort: null, cleanedPrompt: prompt };
  const effort = m[1];
  const cleanedPrompt = prompt.slice(m[0].length);
  return { effort, cleanedPrompt };
}

// Ordinal levels, not lexical sorting or cross-model token-budget equivalence.
export const EFFORT_LEVELS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const effortRank = value => EFFORT_LEVELS.indexOf(normalizeEffort(value));
const atMost = (value, ceiling) => effortRank(value) >= 0 && effortRank(value) <= effortRank(ceiling);

/** Copy only durable decision fields; never retain a mutable request/config object. */
export function snapshotEffortDecision(decision = null) {
  return Object.freeze({
    requested: normalizeEffort(decision?.requested),
    effective: normalizeEffort(decision?.effective),
    source: typeof decision?.source === 'string' ? decision.source : 'unknown',
    model: typeof decision?.model === 'string' ? decision.model : null,
    wireMode: typeof decision?.wireMode === 'string' ? decision.wireMode : 'omitted',
    thinkingEnabled: decision?.thinkingEnabled === true,
    cap: normalizeEffort(decision?.cap),
    ...(Number.isFinite(decision?.budgetTokens) ? { budgetTokens: decision.budgetTokens } : {}),
  });
}

/** Capture the decision belonging to the provider response that generated a tool call. */
export function captureParentEffortDecision(ctx = {}) {
  return snapshotEffortDecision(ctx.effortDecision ?? ctx.parentEngineDeps?.effortDecision);
}

function effortError(model, target, detail = '') {
  const error = new Error(`Sub-agent model "${model}" cannot express effort <= ${target}${detail ? ` (${detail})` : ''}. Select a compatible child model.`);
  error.code = 'SUB_AGENT_EFFORT_UNREPRESENTABLE';
  return error;
}

function capabilityContext(protocol, effortContext) {
  return { ...effortContext, protocol: protocol || effortContext?.protocol };
}

/**
 * Resolve the non-disableable child ceiling using the actual model's capabilities.
 * Unknown/omitted parent wire defaults are conservative medium, never chat/max.
 */
export function resolveSubAgentEffort({ parentDecision = null, model, effortContext = {}, protocol } = {}) {
  const parent = snapshotEffortDecision(parentDecision);
  // An unsupported intermediate model has no wire effort, but must not erase
  // an inherited lower ceiling when it delegates again.
  let parentTarget = parent.effective || 'medium';
  if (parent.cap && atMost(parent.cap, parentTarget)) parentTarget = parent.cap;
  const target = atMost(parentTarget, 'high') ? parentTarget : 'high';
  const context = capabilityContext(protocol, effortContext);
  const capability = getThinkingCapability(model, context);
  const base = {
    requested: parentTarget, source: parent.effective ? 'inherited' : 'fallback',
    model, cap: target, thinkingEnabled: false,
  };
  if (!capability.supportsThinking || capability.thinkingProtocol === 'none') {
    return snapshotEffortDecision({ ...base, effective: null, wireMode: 'unsupported' });
  }
  const supported = getModelEffortOptions(model, context).filter(value => atMost(value, target));
  const effective = EFFORT_LEVELS.filter(value => supported.includes(value)).at(-1);
  if (!effective) throw effortError(model, target);
  const wireMode = protocol === 'openai-responses' || capability.thinkingProtocol === 'openai-reasoning'
    ? 'reasoning-effort'
    : capability.thinkingProtocol === 'anthropic-adaptive' ? 'adaptive' : 'manual';
  return snapshotEffortDecision({ ...base, effective, wireMode, thinkingEnabled: true });
}

function manualEffortForBudget(model, budget) {
  if (!Number.isFinite(budget) || budget <= 0) return null;
  // Round upward: a nonstandard budget must never masquerade as a lower tier.
  return ['low', 'medium', 'high', 'max'].find(level => budget <= thinkingBudgetForEffort(model, level)) || 'ultra';
}

/**
 * Read the FINAL wire payload. requested is observability only, not effective.
 * Call after all extraBody/feature-flag/mapping changes, before serialization.
 */
export function captureEffortDecision({ body = {}, model, protocol, effortContext = {}, requested = null, source = 'scenario' } = {}) {
  const context = capabilityContext(protocol, effortContext);
  const capability = getThinkingCapability(model, context);
  const base = { requested, source, model, cap: null, thinkingEnabled: false };
  if (!capability.supportsThinking || capability.thinkingProtocol === 'none') {
    return snapshotEffortDecision({ ...base, effective: null, wireMode: 'unsupported' });
  }
  if (protocol === 'openai-responses') {
    const effective = normalizeEffort(body.reasoning?.effort);
    if (effective) return snapshotEffortDecision({ ...base, effective, wireMode: 'reasoning-effort', thinkingEnabled: true });
  } else if (body.thinking?.type === 'enabled') {
    const budgetTokens = body.thinking.budget_tokens;
    return snapshotEffortDecision({ ...base, effective: manualEffortForBudget(model, budgetTokens), wireMode: 'manual', thinkingEnabled: true, budgetTokens });
  } else if (body.thinking?.type === 'adaptive') {
    const effective = normalizeEffort(body.output_config?.effort);
    if (effective) return snapshotEffortDecision({ ...base, effective, wireMode: 'adaptive', thinkingEnabled: true });
  }
  const modelDefault = body.thinking?.type === 'disabled' ? null : normalizeEffort(capability.defaultEffort);
  return snapshotEffortDecision({ ...base, effective: modelDefault, source: modelDefault ? 'model-default' : source, wireMode: 'omitted' });
}

function removeEffortField(body, key) {
  if (!body[key] || typeof body[key] !== 'object' || Array.isArray(body[key])) {
    delete body[key];
    return;
  }
  const { effort: _effort, ...rest } = body[key];
  if (Object.keys(rest).length) body[key] = rest;
  else delete body[key];
}

/**
 * Mutate the FINAL provider body in place and return its immutable child decision.
 * The router must preserve effortConstraint even when YEAFT_THINKING_V1 is off.
 * All adapter stream/call paths invoke this AFTER extraBody, BEFORE fetch, and
 * must not subsequently rewrite reasoning/thinking/output_config/max_tokens.
 * @param {object} body Final body owned by the adapter (never caller config).
 * @param {{ model: string, protocol: string, effortContext?: object,
 *   effortConstraint: { parentDecision: object|null } }} options
 */
export function enforceSubAgentEffortPayload(body, { model, protocol, effortContext = {}, effortConstraint } = {}) {
  if (!effortConstraint) return captureEffortDecision({ body, model, protocol, effortContext });
  const decision = resolveSubAgentEffort({ parentDecision: effortConstraint.parentDecision, model, protocol, effortContext });
  if (decision.wireMode === 'unsupported') {
    removeEffortField(body, 'reasoning');
    removeEffortField(body, 'output_config');
    delete body.thinking;
    return decision;
  }
  const context = capabilityContext(protocol, effortContext);
  const options = getModelEffortOptions(model, context);
  const wireEffort = protocol === 'openai-responses' ? body.reasoning?.effort : body.output_config?.effort;
  const effective = options.includes(wireEffort) && atMost(wireEffort, decision.effective)
    ? wireEffort : decision.effective;
  if (protocol === 'openai-responses') {
    body.reasoning = { ...(body.reasoning && typeof body.reasoning === 'object' && !Array.isArray(body.reasoning) ? body.reasoning : {}), effort: effective };
    delete body.thinking;
    removeEffortField(body, 'output_config');
  } else if (decision.wireMode === 'adaptive') {
    body.thinking = { type: 'adaptive' };
    body.output_config = { ...(body.output_config && typeof body.output_config === 'object' && !Array.isArray(body.output_config) ? body.output_config : {}), effort: effective };
    removeEffortField(body, 'reasoning');
  } else {
    const capability = getThinkingCapability(model, context);
    let budget = thinkingBudgetForEffort(model, effective);
    if (!budget) throw effortError(model, decision.cap, 'no manual thinking budget');
    if (Number.isFinite(capability.maxBudgetTokens)) budget = Math.min(budget, capability.maxBudgetTokens);
    const supplied = body.thinking?.type === 'enabled' ? body.thinking.budget_tokens : null;
    if (Number.isInteger(supplied) && supplied >= 1024) budget = Math.min(budget, supplied);
    if (Number.isFinite(body.max_tokens)) budget = Math.min(budget, Math.floor(body.max_tokens) - 1);
    if (budget < 1024) throw effortError(model, decision.cap, 'max_tokens must allow at least 1024 thinking tokens');
    body.thinking = { type: 'enabled', budget_tokens: budget };
    removeEffortField(body, 'output_config');
    removeEffortField(body, 'reasoning');
    return snapshotEffortDecision({ ...decision, effective: manualEffortForBudget(model, budget), budgetTokens: budget });
  }
  return snapshotEffortDecision({ ...decision, effective });
}
