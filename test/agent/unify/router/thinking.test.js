/**
 * Phase 3b — thinking-mode precedence chain (DESIGN.md §9.16).
 *
 * Pin the resolution order: UI > Router plan (with continuity vs prior) >
 * VP default > Global default. Plus `allowRouterEscalate=false` hard-block.
 */

import { describe, it, expect } from 'vitest';
import { resolveThinking } from '../../../../agent/unify/router/thinking.js';

describe('resolveThinking', () => {
  it('UI override wins over everything', () => {
    expect(resolveThinking({
      uiOverride: 'high',
      routerPlan: 'max', priorPlan: 'max', vpDefault: 'max', globalDefault: 'max',
    })).toEqual({ value: 'high', source: 'ui' });

    expect(resolveThinking({
      uiOverride: 'max',
      routerPlan: 'high', priorPlan: 'high', vpDefault: 'high', globalDefault: 'high',
    })).toEqual({ value: 'max', source: 'ui' });
  });

  it('continuity: router agrees with prior → use prior (cache stable)', () => {
    const out = resolveThinking({ routerPlan: 'high', priorPlan: 'high' });
    expect(out).toEqual({ value: 'high', source: 'prior' });
  });

  it('router upgrades over silent prior', () => {
    expect(resolveThinking({ routerPlan: 'max' }))
      .toEqual({ value: 'max', source: 'router' });
  });

  it('router differs from prior → router wins (intentional escalation)', () => {
    const out = resolveThinking({ routerPlan: 'max', priorPlan: 'high' });
    expect(out).toEqual({ value: 'max', source: 'router' });
  });

  it('allowRouterEscalate=false blocks router max upgrade', () => {
    const out = resolveThinking({
      routerPlan: 'max', priorPlan: 'high', allowRouterEscalate: false,
    });
    expect(out).toEqual({ value: 'high', source: 'prior' });
  });

  it('allowRouterEscalate=false still allows router max when baseline is already max', () => {
    const out = resolveThinking({
      routerPlan: 'max', priorPlan: 'max', allowRouterEscalate: false,
    });
    expect(out).toEqual({ value: 'max', source: 'prior' });
  });

  it('allowRouterEscalate=false does not block UI override', () => {
    const out = resolveThinking({
      uiOverride: 'max', routerPlan: 'high', allowRouterEscalate: false,
    });
    expect(out).toEqual({ value: 'max', source: 'ui' });
  });

  it('falls back to prior when router silent', () => {
    expect(resolveThinking({ priorPlan: 'max' }))
      .toEqual({ value: 'max', source: 'prior' });
  });

  it('falls back to VP default when router and prior silent', () => {
    expect(resolveThinking({ vpDefault: 'max' }))
      .toEqual({ value: 'max', source: 'vp' });
  });

  it('falls back to global default when only global is set', () => {
    expect(resolveThinking({ globalDefault: 'max' }))
      .toEqual({ value: 'max', source: 'global' });
  });

  it('factory default high when nothing is set', () => {
    expect(resolveThinking({})).toEqual({ value: 'high', source: 'default' });
    expect(resolveThinking()).toEqual({ value: 'high', source: 'default' });
  });

  it('ignores invalid values (low/medium/garbage)', () => {
    expect(resolveThinking({ uiOverride: 'low' })).toEqual({ value: 'high', source: 'default' });
    expect(resolveThinking({ routerPlan: 'wat' })).toEqual({ value: 'high', source: 'default' });
  });
});
