/**
 * Phase 3a — router per-VP planner. Pin the plans[] schema and the
 * sequential fan-out runner contract before any caller migrates onto
 * them (DESIGN.md §1.2.1, §8 Migration Plan).
 *
 * Scope:
 *   - validateDecision / validatePlan: defaults, canonicalisation, throws
 *     on truly malformed input.
 *   - stripForeignVpPaths: enforces the cross-VP ACL hard block (DESIGN.md §2.2).
 *   - buildDirectDecision: single-plan factory used on the "no router needed"
 *     path (explicit @vp, priorPlan skip).
 *   - wrapLegacyDecision: legacy intent-classifier → V2 mapping so Phase 3b
 *     can roll out behind a flag.
 *   - runPlansSequential: ordering load-bearing (DESIGN.md §1.2.1), prior[]
 *     propagation, group-member filter, per-plan error capture.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  validateDecision,
  validatePlan,
  stripForeignVpPaths,
  buildDirectDecision,
  wrapLegacyDecision,
  runPlansSequential,
  runPlansParallel,
} from '../../../../agent/unify/router/vp-planner.js';

describe('validatePlan', () => {
  it('canonicalises a fully-specified plan unchanged', () => {
    const out = validatePlan({
      vpId: 'linus',
      forwardQuery: { userOriginal: 'fix it', intent: 'user wants fix' },
      preselect: { memoryPaths: ['vp/linus/x.md'], taskIds: ['t_1'] },
      thinking: 'high',
      thinkingReason: 'tricky bug',
    });
    expect(out).toEqual({
      vpId: 'linus',
      forwardQuery: { userOriginal: 'fix it', intent: 'user wants fix' },
      preselect: { memoryPaths: ['vp/linus/x.md'], taskIds: ['t_1'] },
      thinking: 'high',
      thinkingReason: 'tricky bug',
    });
  });

  it('fills defaults for missing optional fields', () => {
    const out = validatePlan({ vpId: 'linus' });
    expect(out).toEqual({
      vpId: 'linus',
      forwardQuery: { userOriginal: '', intent: '' },
      preselect: { memoryPaths: [], taskIds: [] },
      thinking: null,
      thinkingReason: '',
    });
  });

  it('drops non-string memory paths and task ids', () => {
    const out = validatePlan({
      vpId: 'linus',
      preselect: { memoryPaths: ['ok.md', 42, '', null], taskIds: ['t_1', false] },
    });
    expect(out.preselect.memoryPaths).toEqual(['ok.md']);
    expect(out.preselect.taskIds).toEqual(['t_1']);
  });

  it('coerces invalid thinking to null', () => {
    expect(validatePlan({ vpId: 'l', thinking: 'extreme' }).thinking).toBeNull();
    expect(validatePlan({ vpId: 'l', thinking: 'high' }).thinking).toBe('high');
    expect(validatePlan({ vpId: 'l', thinking: 'max' }).thinking).toBe('max');
  });

  it('throws when vpId missing or non-string', () => {
    expect(() => validatePlan({})).toThrow(/vpId required/);
    expect(() => validatePlan({ vpId: 42 })).toThrow(/vpId required/);
    expect(() => validatePlan(null)).toThrow();
  });
});

describe('validateDecision', () => {
  it('defaults to continue + empty plans on minimal input', () => {
    const out = validateDecision({ plans: [] });
    expect(out).toEqual({ action: 'continue', targetTaskId: null, plans: [], reason: '' });
  });

  it('coerces unknown action to continue', () => {
    const out = validateDecision({ action: 'wat', plans: [] });
    expect(out.action).toBe('continue');
  });

  it('preserves all allowed actions', () => {
    for (const a of ['continue', 'switch_vp', 'fork_task', 'join_task', 'broadcast', 'noop']) {
      expect(validateDecision({ action: a, plans: [] }).action).toBe(a);
    }
  });

  it('throws when plans is not an array', () => {
    expect(() => validateDecision({ action: 'continue' })).toThrow(/plans must be an array/);
    expect(() => validateDecision({ action: 'continue', plans: {} })).toThrow();
  });

  it('throws on non-object input', () => {
    expect(() => validateDecision(null)).toThrow();
    expect(() => validateDecision('hi')).toThrow();
  });

  it('canonicalises each plan', () => {
    const out = validateDecision({
      action: 'switch_vp',
      targetTaskId: 't_1',
      plans: [{ vpId: 'linus' }, { vpId: 'grace', thinking: 'max' }],
      reason: 'because',
    });
    expect(out.plans).toHaveLength(2);
    expect(out.plans[0].forwardQuery).toEqual({ userOriginal: '', intent: '' });
    expect(out.plans[1].thinking).toBe('max');
    expect(out.targetTaskId).toBe('t_1');
    expect(out.reason).toBe('because');
  });
});

describe('stripForeignVpPaths', () => {
  it('removes vp/<other>/ paths', () => {
    const plan = validatePlan({
      vpId: 'grace',
      preselect: {
        memoryPaths: [
          'vp/linus/entries/secret.md',   // foreign — drop
          'vp/grace/entries/own.md',      // own — keep
          'groups/eng/entries/note.md',   // group — keep
          'user/entries/pref.md',         // user — keep
        ],
        taskIds: [],
      },
    });
    const out = stripForeignVpPaths(plan);
    expect(out.preselect.memoryPaths).toEqual([
      'vp/grace/entries/own.md',
      'groups/eng/entries/note.md',
      'user/entries/pref.md',
    ]);
  });

  it('returns the original plan reference when nothing to strip', () => {
    const plan = validatePlan({ vpId: 'grace', preselect: { memoryPaths: ['user/x.md'] } });
    expect(stripForeignVpPaths(plan)).toBe(plan);
  });

  it('does not mutate the input', () => {
    const plan = validatePlan({
      vpId: 'grace',
      preselect: { memoryPaths: ['vp/linus/x.md', 'user/y.md'] },
    });
    const out = stripForeignVpPaths(plan);
    expect(plan.preselect.memoryPaths).toEqual(['vp/linus/x.md', 'user/y.md']);
    expect(out.preselect.memoryPaths).toEqual(['user/y.md']);
  });
});

describe('buildDirectDecision', () => {
  it('produces a continue/single-plan decision with sensible defaults', () => {
    const out = buildDirectDecision({ vpId: 'linus', userOriginal: 'hi' });
    expect(out.action).toBe('continue');
    expect(out.plans).toHaveLength(1);
    expect(out.plans[0].vpId).toBe('linus');
    expect(out.plans[0].forwardQuery).toEqual({ userOriginal: 'hi', intent: '' });
    expect(out.reason).toBe('direct');
  });

  it('passes through preselect and thinking', () => {
    const out = buildDirectDecision({
      vpId: 'linus',
      userOriginal: 'q',
      intent: 'asks question',
      memoryPaths: ['user/x.md'],
      taskIds: ['t_1'],
      thinking: 'high',
      thinkingReason: 'because',
      action: 'switch_vp',
      reason: 'explicit @vp',
    });
    expect(out.action).toBe('switch_vp');
    expect(out.plans[0].preselect).toEqual({ memoryPaths: ['user/x.md'], taskIds: ['t_1'] });
    expect(out.plans[0].thinking).toBe('high');
    expect(out.plans[0].thinkingReason).toBe('because');
    expect(out.reason).toBe('explicit @vp');
  });

  it('throws when vpId missing', () => {
    expect(() => buildDirectDecision({ userOriginal: 'x' })).toThrow(/vpId required/);
  });
});

describe('wrapLegacyDecision', () => {
  it('maps continue → continue', () => {
    const out = wrapLegacyDecision({ action: 'continue', targetThreadId: 'linus' }, 'hello');
    expect(out.action).toBe('continue');
    expect(out.plans[0].vpId).toBe('linus');
    expect(out.plans[0].forwardQuery.userOriginal).toBe('hello');
  });

  it('maps switch → switch_vp', () => {
    const out = wrapLegacyDecision({ action: 'switch', targetThreadId: 'grace' });
    expect(out.action).toBe('switch_vp');
    expect(out.plans[0].vpId).toBe('grace');
  });

  it('maps fork → fork_task', () => {
    const out = wrapLegacyDecision({ action: 'fork', targetThreadId: 'linus' });
    expect(out.action).toBe('fork_task');
  });

  it('returns noop with empty plans when no targetThreadId', () => {
    const out = wrapLegacyDecision({ action: 'continue', reason: 'nothing' });
    expect(out.action).toBe('noop');
    expect(out.plans).toEqual([]);
    expect(out.reason).toBe('nothing');
  });

  it('returns noop with empty plans for nullish input', () => {
    expect(wrapLegacyDecision(null).action).toBe('noop');
    expect(wrapLegacyDecision(undefined).plans).toEqual([]);
  });

  it('preserves reason from legacy decision', () => {
    const out = wrapLegacyDecision({ action: 'continue', targetThreadId: 'linus', reason: 'staying' });
    expect(out.reason).toBe('staying');
  });
});

describe('runPlansSequential', () => {
  const plans = [
    validatePlan({ vpId: 'linus' }),
    validatePlan({ vpId: 'grace' }),
  ];

  it('throws on bad inputs', async () => {
    await expect(runPlansSequential(null, () => {})).rejects.toThrow(/plans array required/);
    await expect(runPlansSequential([], 'nope')).rejects.toThrow(/runOne fn required/);
  });

  it('calls runOne once per plan in order', async () => {
    const calls = [];
    const runOne = vi.fn(async (plan) => {
      calls.push(plan.vpId);
      return { vp: plan.vpId };
    });
    const { results, errors } = await runPlansSequential(plans, runOne);
    expect(calls).toEqual(['linus', 'grace']);
    expect(results).toEqual([{ vp: 'linus' }, { vp: 'grace' }]);
    expect(errors).toEqual([]);
    expect(runOne).toHaveBeenCalledTimes(2);
  });

  it('passes prior[] accumulator to runOne so plan N sees plan N-1 output', async () => {
    const seen = [];
    const runOne = async (plan, idx, prior) => {
      seen.push({ idx, priorLen: prior.length, priorVps: prior.map(p => p?.vp) });
      return { vp: plan.vpId };
    };
    await runPlansSequential(plans, runOne);
    expect(seen).toEqual([
      { idx: 0, priorLen: 0, priorVps: [] },
      { idx: 1, priorLen: 1, priorVps: ['linus'] },
    ]);
  });

  it('skips non-member plans without invoking runOne', async () => {
    const runOne = vi.fn(async (plan) => ({ vp: plan.vpId }));
    const { results } = await runPlansSequential(plans, runOne, {
      groupMemberIds: ['linus'],  // grace not a member
    });
    expect(runOne).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ vp: 'linus' });
    expect(results[1]).toMatchObject({ skipped: 'not_member', vpId: 'grace', index: 1 });
  });

  it('captures per-plan errors and continues to subsequent plans', async () => {
    const runOne = async (plan) => {
      if (plan.vpId === 'linus') throw new Error('boom');
      return { vp: plan.vpId };
    };
    const { results, errors } = await runPlansSequential(plans, runOne);
    expect(errors).toHaveLength(1);
    expect(errors[0].index).toBe(0);
    expect(errors[0].error.message).toBe('boom');
    expect(results).toEqual([{ vp: 'grace' }]);
  });

  it('error in plan N is visible to plan N+1 via prior[]', async () => {
    const seen = [];
    const runOne = async (plan, idx, prior) => {
      seen.push({ idx, prior: prior.map(p => p?.error?.message ?? p?.vp) });
      if (plan.vpId === 'linus') throw new Error('first-blew-up');
      return { vp: plan.vpId };
    };
    await runPlansSequential(plans, runOne);
    expect(seen[1]).toEqual({ idx: 1, prior: ['first-blew-up'] });
  });

  it('handles empty plans[] cleanly', async () => {
    const runOne = vi.fn();
    const { results, errors } = await runPlansSequential([], runOne);
    expect(results).toEqual([]);
    expect(errors).toEqual([]);
    expect(runOne).not.toHaveBeenCalled();
  });
});

describe('runPlansParallel', () => {
  const buildPlans = (n) =>
    Array.from({ length: n }, (_, i) => validatePlan({ vpId: `vp${i}` }));

  it('throws on bad inputs', async () => {
    await expect(runPlansParallel(null, () => {})).rejects.toThrow(/plans array required/);
    await expect(runPlansParallel([], 'nope')).rejects.toThrow(/runOne fn required/);
  });

  it('runs all plans and returns results in input order regardless of completion order', async () => {
    const plans = buildPlans(4);
    // Reverse-staggered delays so vp3 finishes first, vp0 last.
    const runOne = async (plan, idx) => {
      await new Promise(r => setTimeout(r, (plans.length - idx) * 5));
      return { vp: plan.vpId, idx };
    };
    const { results, errors } = await runPlansParallel(plans, runOne);
    expect(errors).toEqual([]);
    expect(results.map(r => r.vp)).toEqual(['vp0', 'vp1', 'vp2', 'vp3']);
  });

  it('actually runs concurrently (peak in-flight > 1)', async () => {
    const plans = buildPlans(4);
    let inFlight = 0;
    let peak = 0;
    const runOne = async (plan) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 10));
      inFlight -= 1;
      return { vp: plan.vpId };
    };
    await runPlansParallel(plans, runOne);
    expect(peak).toBeGreaterThan(1);
  });

  it('respects concurrency cap', async () => {
    const plans = buildPlans(6);
    let inFlight = 0;
    let peak = 0;
    const runOne = async (plan) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 10));
      inFlight -= 1;
      return { vp: plan.vpId };
    };
    await runPlansParallel(plans, runOne, { concurrency: 2 });
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(0);
  });

  it('captures per-plan errors without aborting siblings', async () => {
    const plans = buildPlans(3);
    const runOne = async (plan, idx) => {
      if (idx === 1) throw new Error(`boom-${plan.vpId}`);
      return { vp: plan.vpId };
    };
    const { results, errors } = await runPlansParallel(plans, runOne);
    expect(errors).toHaveLength(1);
    expect(errors[0].index).toBe(1);
    expect(errors[0].error.message).toBe('boom-vp1');
    expect(results[0]).toEqual({ vp: 'vp0' });
    expect(results[1]).toMatchObject({ index: 1, vpId: 'vp1' });
    expect(results[1].error.message).toBe('boom-vp1');
    expect(results[2]).toEqual({ vp: 'vp2' });
  });

  it('skips non-members without invoking runOne', async () => {
    const plans = buildPlans(3);
    const runOne = vi.fn(async (plan) => ({ vp: plan.vpId }));
    const { results } = await runPlansParallel(plans, runOne, {
      groupMemberIds: ['vp0', 'vp2'],
    });
    expect(runOne).toHaveBeenCalledTimes(2);
    expect(results[0]).toEqual({ vp: 'vp0' });
    expect(results[1]).toMatchObject({ skipped: 'not_member', vpId: 'vp1', index: 1 });
    expect(results[2]).toEqual({ vp: 'vp2' });
  });

  it('handles empty plans[] without launching workers', async () => {
    const runOne = vi.fn();
    const out = await runPlansParallel([], runOne);
    expect(out).toEqual({ results: [], errors: [] });
    expect(runOne).not.toHaveBeenCalled();
  });
});
