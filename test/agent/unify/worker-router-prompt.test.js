/**
 * Phase 1 of the multi-VP redesign — pin the contract for the new prompt
 * builders before any caller migrates onto them.
 *
 * Coverage:
 *   - renderLayerASummaries: only renders blocks that have non-empty bodies,
 *     uses scope-named headers (`## summary_user/group/vp`), respects zh.
 *   - buildWorkerPrompt: composes harness + buildSystemPrompt + Layer A/B/C/D
 *     in the correct order, omits blank layers, and never emits the harness
 *     when `includeShape:false`.
 *   - buildRouterPrompt: emits harness + summaries + routerContext, and never
 *     emits any persona / VP-identity content (a Router speaks as routing
 *     brain, not as a VP).
 *   - ACL leakage red line: nothing in the Router prompt mirrors persona
 *     bodies passed through `vpPersona` (those belong to Worker only).
 */

import { describe, it, expect } from 'vitest';
import {
  buildWorkerPrompt,
  buildRouterPrompt,
  renderLayerASummaries,
} from '../../../agent/unify/prompts.js';

describe('renderLayerASummaries', () => {
  it('renders all three sections with scope-named headers (en)', () => {
    const out = renderLayerASummaries({
      user: 'prefers terse replies',
      group: 'kernel folks',
      vp: 'Linus voice',
    }, 'en');
    expect(out).toMatch(/## summary_user\nprefers terse replies/);
    expect(out).toMatch(/## summary_group\nkernel folks/);
    expect(out).toMatch(/## summary_vp\nLinus voice/);
  });

  it('skips blank / missing sections', () => {
    const out = renderLayerASummaries({ user: 'only user', group: '', vp: undefined }, 'en');
    expect(out).toMatch(/## summary_user/);
    expect(out).not.toMatch(/## summary_group/);
    expect(out).not.toMatch(/## summary_vp/);
  });

  it('renders zh headers when language=zh', () => {
    const out = renderLayerASummaries({ user: '只看代码' }, 'zh');
    expect(out).toMatch(/## 用户总结/);
    expect(out).toMatch(/只看代码/);
  });

  it('returns empty string when no summaries provided', () => {
    expect(renderLayerASummaries(undefined)).toBe('');
    expect(renderLayerASummaries({})).toBe('');
    expect(renderLayerASummaries({ user: '   ' })).toBe('');
  });
});

describe('buildWorkerPrompt', () => {
  it('composes harness + base + Layer A summaries + B + C + D in order', () => {
    const out = buildWorkerPrompt({
      language: 'en',
      summaries: { user: 'U-SUM', group: 'G-SUM', vp: 'V-SUM' },
      preselectedMemory: '## preselect\n- mem-1',
      taskScope: '## task_scope\nworking on alpha',
      turnScope: '## turn_scope\ninbound from ken',
      vpPersona: { displayName: 'Linus Torvalds', persona: 'show me the code' },
    });
    // Order: harness → base (with persona) → summaries → B → C → D
    const idx = (re) => out.search(re);
    const iHarness = idx(/Prompt Shape \(Worker\)/);
    // Phase 8 wire-up: persona is now persona-as-identity (`# <name>`)
    // not the legacy `## active_persona` overlay.
    const iPersona = idx(/# Linus Torvalds/);
    const iSumU = idx(/## summary_user/);
    const iPre = idx(/## preselect/);
    const iTask = idx(/## task_scope/);
    const iTurn = idx(/## turn_scope/);
    expect(iHarness).toBeGreaterThanOrEqual(0);
    expect(iPersona).toBeGreaterThan(iHarness);
    expect(iSumU).toBeGreaterThan(iPersona);
    expect(iPre).toBeGreaterThan(iSumU);
    expect(iTask).toBeGreaterThan(iPre);
    expect(iTurn).toBeGreaterThan(iTask);
  });

  it('omits the harness when includeShape:false', () => {
    const out = buildWorkerPrompt({
      language: 'en',
      includeShape: false,
      summaries: { user: 'U' },
    });
    expect(out).not.toMatch(/Prompt Shape \(Worker\)/);
    expect(out).toMatch(/## summary_user/);
  });

  it('omits empty layers without leaving stray blank blocks', () => {
    const out = buildWorkerPrompt({
      language: 'en',
      summaries: { user: 'U' },
    });
    expect(out).not.toMatch(/## preselect/);
    expect(out).not.toMatch(/## task_scope/);
    expect(out).not.toMatch(/## turn_scope/);
    // No accidental triple-newlines
    expect(out).not.toMatch(/\n\n\n\n/);
  });
});

describe('buildRouterPrompt', () => {
  it('emits harness + summaries + routerContext', () => {
    const out = buildRouterPrompt({
      language: 'en',
      summaries: { group: 'G-SUM' },
      routerContext: '## roster\n- linus\n- ken',
    });
    expect(out).toMatch(/Prompt Shape \(Router\)/);
    expect(out).toMatch(/## summary_group/);
    expect(out).toMatch(/## roster/);
  });

  it('does NOT inject any VP persona — Router speaks as routing brain', () => {
    // Even if a caller accidentally forwards vpPersona-shaped data via the
    // generic builder, the Router entry point should ignore it.
    const out = buildRouterPrompt({
      language: 'en',
      summaries: { user: 'U' },
      routerContext: 'recent turns: …',
      // @ts-expect-error — extra field, deliberately ignored
      vpPersona: { displayName: 'Linus Torvalds', persona: 'leak-me' },
    });
    expect(out).not.toMatch(/active_persona/);
    expect(out).not.toMatch(/Linus Torvalds/);
    expect(out).not.toMatch(/leak-me/);
  });

  it('omits harness when includeShape:false', () => {
    const out = buildRouterPrompt({
      language: 'en',
      includeShape: false,
      summaries: { user: 'U' },
    });
    expect(out).not.toMatch(/Prompt Shape \(Router\)/);
    expect(out).toMatch(/## summary_user/);
  });
});
