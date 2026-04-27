/**
 * router/vp-planner.js — DESIGN.md Phase 3a (router per-VP plans).
 *
 * The legacy `intent-classifier.js` decides "which thread continues this
 * turn" — single-VP, single-plan. The multi-VP redesign (DESIGN.md §1.2.1)
 * generalises that into a `plans[]` array: one plan per VP that should act
 * this turn, in execution order. This module is the per-VP planner.
 *
 * Phase 3a scope: schema + validation + sequential fan-out runner. The LLM
 * call itself is wired in Phase 3b along with `priorPlan` continuity. Until
 * then, callers either (a) construct plans directly from override paths, or
 * (b) wrap the legacy single-plan classifier and call `wrapLegacyDecision`.
 *
 * Non-goals here:
 *   - parallel fan-out (Phase 3.5).
 *   - thinking-mode resolution (handled at the dispatcher level alongside
 *     the UI > Router > VP > Global precedence chain — DESIGN.md §9.16).
 *   - `priorPlan` skip-router heuristic (Phase 3b).
 *
 * Shape contract (DESIGN.md §1.2.1):
 *
 *   {
 *     action: 'continue' | 'switch_vp' | 'fork_task' | 'join_task' |
 *             'broadcast' | 'noop',
 *     targetTaskId: string | null,
 *     plans: [
 *       {
 *         vpId: string,
 *         forwardQuery: { userOriginal: string, intent: string },
 *         preselect: { memoryPaths: string[], taskIds: string[] },
 *         thinking: 'high' | 'max' | null,
 *         thinkingReason: string,
 *       }
 *     ],
 *     reason: string,
 *   }
 */

import { isVpForeign } from '../memory/scope-tree.js';

/** @typedef {{ userOriginal: string, intent: string }} ForwardQuery */
/** @typedef {{ memoryPaths: string[], taskIds: string[] }} Preselect */
/** @typedef {{
 *    vpId: string,
 *    forwardQuery: ForwardQuery,
 *    preselect: Preselect,
 *    thinking: 'high'|'max'|null,
 *    thinkingReason: string,
 *  }} VpPlan
 */
/** @typedef {{
 *    action: 'continue'|'switch_vp'|'fork_task'|'join_task'|'broadcast'|'noop',
 *    targetTaskId: string | null,
 *    plans: VpPlan[],
 *    reason: string,
 *  }} RouterDecisionV2
 */

const ALLOWED_ACTIONS = new Set([
  'continue', 'switch_vp', 'fork_task', 'join_task', 'broadcast', 'noop',
]);

const ALLOWED_THINKING = new Set([null, 'high', 'max']);

/**
 * Validate + canonicalise a router decision. Throws on truly malformed
 * input (we want loud failures during Phase 3 wiring), but tolerates
 * missing optional fields by filling defaults.
 *
 * @param {*} raw
 * @returns {RouterDecisionV2}
 */
export function validateDecision(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('validateDecision: decision must be an object');
  }
  const action = ALLOWED_ACTIONS.has(raw.action) ? raw.action : 'continue';
  const targetTaskId = (typeof raw.targetTaskId === 'string' && raw.targetTaskId)
    ? raw.targetTaskId : null;
  if (!Array.isArray(raw.plans)) {
    throw new Error('validateDecision: plans must be an array');
  }
  const plans = raw.plans.map(validatePlan);
  const reason = typeof raw.reason === 'string' ? raw.reason : '';
  return { action, targetTaskId, plans, reason };
}

/**
 * @param {*} raw
 * @returns {VpPlan}
 */
export function validatePlan(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('validatePlan: plan must be an object');
  }
  if (typeof raw.vpId !== 'string' || !raw.vpId) {
    throw new Error('validatePlan: vpId required');
  }
  const fq = raw.forwardQuery && typeof raw.forwardQuery === 'object'
    ? raw.forwardQuery : {};
  const userOriginal = typeof fq.userOriginal === 'string' ? fq.userOriginal : '';
  const intent = typeof fq.intent === 'string' ? fq.intent : '';
  const pre = raw.preselect && typeof raw.preselect === 'object'
    ? raw.preselect : {};
  const memoryPaths = Array.isArray(pre.memoryPaths)
    ? pre.memoryPaths.filter(p => typeof p === 'string' && p)
    : [];
  const taskIds = Array.isArray(pre.taskIds)
    ? pre.taskIds.filter(t => typeof t === 'string' && t)
    : [];
  const thinkingRaw = raw.thinking === undefined ? null : raw.thinking;
  const thinking = ALLOWED_THINKING.has(thinkingRaw) ? thinkingRaw : null;
  const thinkingReason = typeof raw.thinkingReason === 'string'
    ? raw.thinkingReason : '';
  return {
    vpId: raw.vpId,
    forwardQuery: { userOriginal, intent },
    preselect: { memoryPaths, taskIds },
    thinking,
    thinkingReason,
  };
}

/**
 * Strip `vp/<other>/` paths from a plan's `preselect.memoryPaths`. The
 * planner runs BEFORE the worker so this is the right place to enforce
 * the cross-VP private-memory hard block (DESIGN.md §2.2). Returns a new
 * plan; original is not mutated.
 *
 * @param {VpPlan} plan
 * @returns {VpPlan}
 */
export function stripForeignVpPaths(plan) {
  if (!plan) return plan;
  const own = plan.vpId;
  const filtered = plan.preselect.memoryPaths.filter(p => !isVpForeign(p, own));
  if (filtered.length === plan.preselect.memoryPaths.length) return plan;
  return {
    ...plan,
    preselect: { ...plan.preselect, memoryPaths: filtered },
  };
}

/**
 * Produce a default single-plan decision for "explicit @vp" or "no router
 * needed" paths. The dispatcher uses this when it has decided not to call
 * the LLM router (DESIGN.md §1.2.1 scenario A — explicit @vp; or §9.15
 * priorPlan skip).
 *
 * @param {{
 *   vpId: string,
 *   userOriginal: string,
 *   intent?: string,
 *   memoryPaths?: string[],
 *   taskIds?: string[],
 *   targetTaskId?: string | null,
 *   thinking?: 'high'|'max'|null,
 *   thinkingReason?: string,
 *   action?: RouterDecisionV2['action'],
 *   reason?: string,
 * }} args
 * @returns {RouterDecisionV2}
 */
export function buildDirectDecision(args) {
  const {
    vpId, userOriginal, intent = '',
    memoryPaths = [], taskIds = [],
    targetTaskId = null,
    thinking = null, thinkingReason = '',
    action = 'continue', reason = 'direct',
  } = args || {};
  if (!vpId) throw new Error('buildDirectDecision: vpId required');
  return validateDecision({
    action,
    targetTaskId,
    plans: [{
      vpId,
      forwardQuery: { userOriginal, intent },
      preselect: { memoryPaths, taskIds },
      thinking,
      thinkingReason,
    }],
    reason,
  });
}

/**
 * Translate a legacy `intent-classifier` single-thread decision (action +
 * targetThreadId) into the V2 plans schema. We treat the old `targetThreadId`
 * as the `vpId` because — in the multi-VP redesign — every "thread" is a VP
 * (groups are sessions, see DESIGN.md §0.1). Callers that still produce
 * legacy decisions can pipe them through this until Phase 3b.
 *
 * Mapping:
 *   continue / switch → continue / switch_vp (single-VP plan)
 *   fork              → fork_task   (single-VP plan)
 *   anything else     → continue
 *
 * @param {{
 *   action?: string,
 *   targetThreadId?: string,
 *   reason?: string,
 *   source?: string,
 * }} legacy
 * @param {string} userOriginal
 * @returns {RouterDecisionV2}
 */
export function wrapLegacyDecision(legacy, userOriginal = '') {
  if (!legacy || typeof legacy !== 'object') {
    return validateDecision({ action: 'noop', targetTaskId: null, plans: [], reason: '' });
  }
  const vpId = typeof legacy.targetThreadId === 'string' ? legacy.targetThreadId : '';
  if (!vpId) {
    return validateDecision({ action: 'noop', targetTaskId: null, plans: [], reason: legacy.reason || '' });
  }
  let action = 'continue';
  if (legacy.action === 'switch') action = 'switch_vp';
  else if (legacy.action === 'fork') action = 'fork_task';
  else if (legacy.action === 'continue') action = 'continue';
  return validateDecision({
    action,
    targetTaskId: null,
    reason: legacy.reason || '',
    plans: [{
      vpId,
      forwardQuery: { userOriginal, intent: '' },
      preselect: { memoryPaths: [], taskIds: [] },
      thinking: null,
      thinkingReason: '',
    }],
  });
}

/**
 * Sequential fan-out runner. Calls `runOne(plan, index, prior)` for each
 * plan in order, awaiting each before starting the next. The previous
 * plans' results are passed via `prior` so a later plan can read what an
 * earlier plan emitted (DESIGN.md §1.2.1 — "ordering is load bearing").
 *
 * Plans whose `vpId` is missing from `groupMemberIds` (when the caller
 * supplies that whitelist) are skipped with a logged `skipped:not_member`
 * entry — never silently routed to a non-member.
 *
 * Errors from `runOne` are caught, recorded, and the loop continues; the
 * report holds whatever each plan produced. The dispatcher decides whether
 * to surface or retry.
 *
 * @param {VpPlan[]} plans
 * @param {(plan: VpPlan, index: number, prior: any[]) => Promise<*>} runOne
 * @param {{ groupMemberIds?: string[] }} [opts]
 * @returns {Promise<{ results: any[], errors: Array<{ index: number, error: Error }> }>}
 */
export async function runPlansSequential(plans, runOne, opts = {}) {
  if (!Array.isArray(plans)) throw new Error('runPlansSequential: plans array required');
  if (typeof runOne !== 'function') throw new Error('runPlansSequential: runOne fn required');
  const memberSet = Array.isArray(opts.groupMemberIds)
    ? new Set(opts.groupMemberIds) : null;
  const results = [];
  const errors = [];
  const prior = [];
  for (let i = 0; i < plans.length; i += 1) {
    const plan = plans[i];
    if (memberSet && !memberSet.has(plan.vpId)) {
      const skip = { index: i, vpId: plan.vpId, skipped: 'not_member' };
      results.push(skip);
      prior.push(skip);
      continue;
    }
    try {
      const out = await runOne(plan, i, prior);
      results.push(out);
      prior.push(out);
    } catch (err) {
      errors.push({ index: i, error: err });
      // Insert a sentinel into prior so a later plan can see "the previous
      // VP errored" rather than nothing — useful when a fallback VP is
      // queued behind a primary.
      prior.push({ index: i, vpId: plan.vpId, error: err });
    }
  }
  return { results, errors };
}
