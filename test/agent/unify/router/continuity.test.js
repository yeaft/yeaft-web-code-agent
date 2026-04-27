/**
 * Phase 3b — priorPlan carry-back. Pin the metadata plumbing contract
 * before any caller relies on `_meta.routerPlan` (DESIGN.md §9.15).
 *
 * Coverage:
 *   - attachRouterPlan: writes _meta.routerPlan, leaves user/tool messages
 *     untouched, no-ops on missing vpId or non-object plan.
 *   - extractPriorPlan: returns most recent matching assistant message's
 *     plan; null on cold start, ignores other VPs' plans.
 *   - stripMetaForWire: returns a shallow-cloned array with no _meta keys;
 *     no-op when nothing carried metadata.
 *   - renderPriorPlan (in prompts.js): renders prior_plan block, omits
 *     empty fields, returns '' when nothing to render.
 *   - buildRouterPrompt with priorPlan: includes prior_plan section in
 *     output; absent when priorPlan is null/undefined.
 */

import { describe, it, expect } from 'vitest';
import {
  attachRouterPlan,
  extractPriorPlan,
  stripMetaForWire,
} from '../../../../agent/unify/router/continuity.js';
import { buildRouterPrompt, renderPriorPlan } from '../../../../agent/unify/prompts.js';

describe('attachRouterPlan', () => {
  it('writes _meta.routerPlan on an assistant message', () => {
    const m = { role: 'assistant', content: 'hi' };
    attachRouterPlan(m, {
      vpId: 'linus',
      forwardQuery: { userOriginal: 'fix it', intent: 'wants fix' },
      preselect: { memoryPaths: ['vp/linus/x.md'], taskIds: ['t_1'] },
      thinking: 'high',
      thinkingReason: 'tricky',
    });
    expect(m._meta.routerPlan).toEqual({
      vpId: 'linus',
      forwardQuery: { userOriginal: 'fix it', intent: 'wants fix' },
      preselect: { memoryPaths: ['vp/linus/x.md'], taskIds: ['t_1'] },
      thinking: 'high',
      thinkingReason: 'tricky',
    });
  });

  it('leaves user/tool messages untouched', () => {
    const u = { role: 'user', content: 'hi' };
    const t = { role: 'tool', content: 'r' };
    attachRouterPlan(u, { vpId: 'linus' });
    attachRouterPlan(t, { vpId: 'linus' });
    expect(u._meta).toBeUndefined();
    expect(t._meta).toBeUndefined();
  });

  it('no-ops when plan has no vpId', () => {
    const m = { role: 'assistant', content: 'hi' };
    attachRouterPlan(m, { vpId: '' });
    attachRouterPlan(m, null);
    attachRouterPlan(m, 'not-an-object');
    expect(m._meta).toBeUndefined();
  });

  it('preserves existing _meta keys', () => {
    const m = { role: 'assistant', content: 'hi', _meta: { traceId: 'abc' } };
    attachRouterPlan(m, { vpId: 'linus' });
    expect(m._meta.traceId).toBe('abc');
    expect(m._meta.routerPlan.vpId).toBe('linus');
  });

  it('clones array fields so later mutation does not leak', () => {
    const memoryPaths = ['a.md'];
    const m = { role: 'assistant', content: 'x' };
    attachRouterPlan(m, { vpId: 'linus', preselect: { memoryPaths, taskIds: [] } });
    memoryPaths.push('mutated.md');
    expect(m._meta.routerPlan.preselect.memoryPaths).toEqual(['a.md']);
  });
});

describe('extractPriorPlan', () => {
  const buildLog = () => [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1', _meta: { routerPlan: { vpId: 'linus', preselect: { memoryPaths: ['x.md'], taskIds: [] } } } },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'a2', _meta: { routerPlan: { vpId: 'grace', preselect: { memoryPaths: ['y.md'], taskIds: [] } } } },
    { role: 'user', content: 'q3' },
    { role: 'assistant', content: 'a3', _meta: { routerPlan: { vpId: 'linus', preselect: { memoryPaths: ['z.md'], taskIds: ['t_1'] } } } },
  ];

  it('returns the latest matching VP plan', () => {
    const out = extractPriorPlan(buildLog(), 'linus');
    expect(out.preselect.memoryPaths).toEqual(['z.md']);
    expect(out.preselect.taskIds).toEqual(['t_1']);
  });

  it('returns null on cold start', () => {
    expect(extractPriorPlan([], 'linus')).toBeNull();
    expect(extractPriorPlan([{ role: 'user', content: 'hi' }], 'linus')).toBeNull();
  });

  it('returns null when no plan matches the VP', () => {
    expect(extractPriorPlan(buildLog(), 'never-spoke')).toBeNull();
  });

  it('skips assistant messages without _meta.routerPlan', () => {
    const log = [
      { role: 'assistant', content: 'pre-multi-vp', /* no _meta */ },
      { role: 'assistant', content: 'newer', _meta: { routerPlan: { vpId: 'linus', preselect: { memoryPaths: ['ok.md'] } } } },
    ];
    expect(extractPriorPlan(log, 'linus').preselect.memoryPaths).toEqual(['ok.md']);
  });

  it('handles bad inputs gracefully', () => {
    expect(extractPriorPlan(null, 'linus')).toBeNull();
    expect(extractPriorPlan([], '')).toBeNull();
    expect(extractPriorPlan([null], 'linus')).toBeNull();
  });
});

describe('stripMetaForWire', () => {
  it('returns a copy without _meta keys', () => {
    const log = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'a', _meta: { routerPlan: { vpId: 'linus' } } },
    ];
    const out = stripMetaForWire(log);
    expect(out[0]).toEqual({ role: 'user', content: 'hi' });
    expect(out[1]).toEqual({ role: 'assistant', content: 'a' });
    expect('_meta' in out[1]).toBe(false);
    // original untouched
    expect(log[1]._meta).toBeDefined();
  });

  it('returns the same reference when nothing has _meta', () => {
    const log = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'a' }];
    expect(stripMetaForWire(log)).toBe(log);
  });

  it('handles non-array input', () => {
    expect(stripMetaForWire(null)).toBeNull();
  });
});

describe('renderPriorPlan', () => {
  it('renders a prior_plan block (en)', () => {
    const out = renderPriorPlan({
      vpId: 'linus',
      forwardQuery: { userOriginal: 'fix it', intent: 'wants fix' },
      preselect: { memoryPaths: ['x.md'], taskIds: ['t_1'] },
      thinking: 'high',
    });
    expect(out).toMatch(/^## prior_plan/);
    expect(out).toMatch(/vpId: linus/);
    expect(out).toMatch(/intent: wants fix/);
    expect(out).toMatch(/memoryPaths: x.md/);
    expect(out).toMatch(/taskIds: t_1/);
    expect(out).toMatch(/thinking: high/);
  });

  it('renders zh header when language=zh', () => {
    const out = renderPriorPlan({ vpId: 'linus' }, 'zh');
    expect(out).toMatch(/上一轮 plan/);
  });

  it('omits empty fields', () => {
    const out = renderPriorPlan({
      vpId: 'linus',
      preselect: { memoryPaths: [], taskIds: [] },
    });
    expect(out).toMatch(/vpId: linus/);
    expect(out).not.toMatch(/memoryPaths/);
    expect(out).not.toMatch(/taskIds/);
    expect(out).not.toMatch(/thinking/);
  });

  it('returns empty string when nothing to render', () => {
    expect(renderPriorPlan(null)).toBe('');
    expect(renderPriorPlan(undefined)).toBe('');
    expect(renderPriorPlan({})).toBe('');
  });
});

describe('buildRouterPrompt with priorPlan', () => {
  it('includes the prior_plan block when priorPlan is provided', () => {
    const out = buildRouterPrompt({
      language: 'en',
      summaries: { user: 'U' },
      routerContext: '## roster\n- linus',
      priorPlan: { vpId: 'linus', preselect: { memoryPaths: ['x.md'] } },
    });
    expect(out).toMatch(/## prior_plan/);
    expect(out).toMatch(/vpId: linus/);
    // Order: harness → summaries → priorPlan → routerContext
    const iSum = out.indexOf('## summary_user');
    const iPrior = out.indexOf('## prior_plan');
    const iCtx = out.indexOf('## roster');
    expect(iSum).toBeGreaterThan(0);
    expect(iPrior).toBeGreaterThan(iSum);
    expect(iCtx).toBeGreaterThan(iPrior);
  });

  it('omits prior_plan when priorPlan is null/undefined', () => {
    const out = buildRouterPrompt({
      language: 'en',
      summaries: { user: 'U' },
      priorPlan: null,
    });
    expect(out).not.toMatch(/prior_plan/);
  });
});
