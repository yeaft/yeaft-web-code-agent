import { describe, expect, it } from 'vitest';
import { resolveWorkItemModel, selectWorkItemVp } from '../../../../agent/yeaft/work-center/assignment.js';
import {
  defaultWorkCenterSettings,
  normalizeModelPolicy,
  normalizeWorkCenterSettings,
} from '../../../../agent/yeaft/work-center/workflow.js';

const vps = [
  { id: 'zeta', role: 'Systems Engineer', area: 'engineering' },
  { id: 'alpha', role: 'Quality Analyst', area: 'testing' },
];

function select(policy, stageType = 'custom', priorRuns = []) {
  return selectWorkItemVp({ policy, stageType, vps, priorRuns });
}

describe('Work Center VP assignment', () => {
  it('uses capability scoring before deterministic tie-breaking', () => {
    const result = select({ mode: 'auto', capability: 'test' });

    expect(result.vp.id).toBe('alpha');
    expect(result.reason).toMatch(/^auto:test:score=/);
  });

  it('falls back from an unknown capability to the Action type', () => {
    const result = select({ mode: 'auto', capability: 'protocol-forensics' }, 'diagnose');

    expect(result.vp.id).toBe('zeta');
    expect(result.reason).toMatch(/fallback=diagnose:score=/);
  });

  it('uses the lowest eligible VP id when capability and Action type scores are zero', () => {
    const result = select({ mode: 'auto', capability: 'protocol-forensics' });

    expect(result.vp.id).toBe('alpha');
    expect(result.reason).toBe('auto:protocol-forensics:fallback=custom:eligible-id:score=0');
  });

  it('preserves fixed, planned, pool, availability, and separation semantics', () => {
    expect(select({ mode: 'fixed', fixedVpId: 'zeta' }).vp.id).toBe('zeta');
    expect(select({
      mode: 'planned', candidateVpIds: ['zeta', 'alpha'], assignmentReason: 'plan',
    }).vp.id).toBe('zeta');
    expect(select({
      mode: 'planned', candidateVpIds: ['zeta', 'alpha'], assignmentReason: 'plan',
      separateFromStageTypes: ['review'],
    }, 'custom', [{ actionType: 'review', vpSnapshot: { id: 'zeta' } }]).vp.id).toBe('alpha');
    expect(select({
      mode: 'pool', candidateVpIds: ['missing', 'zeta', 'alpha'], capability: 'unknown',
    }).vp.id).toBe('alpha');
  });

  it('fails when separation removes every candidate and includes sanitized context', () => {
    const priorRuns = [
      { actionType: 'review', vpSnapshot: { id: 'alpha' } },
      { actionType: 'review', vpSnapshot: { id: 'zeta' } },
    ];

    expect(() => select({
      mode: 'auto', capability: 'protocol forensics/value', separateFromStageTypes: ['review'],
    }, 'custom', priorRuns)).toThrowError(expect.objectContaining({
      retryable: false,
      message: expect.stringMatching(
        /mode=auto; capability=protocol-forensics-value; fallback=not-attempted; candidates=alpha,zeta; excluded=alpha,zeta/,
      ),
    }));
  });

  it('fails deterministically when no VP is available', () => {
    expect(() => selectWorkItemVp({
      policy: { mode: 'auto', capability: 'unsafe capability/value' },
      stageType: 'custom',
      vps: [],
    })).toThrowError(expect.objectContaining({
      retryable: false,
      message: expect.stringMatching(
        /capability=unsafe-capability-value; fallback=not-attempted; candidates=none; excluded=none/,
      ),
    }));
  });

  it('reports unavailable fixed and planned candidates without changing policy modes', () => {
    expect(() => select({ mode: 'fixed', fixedVpId: 'missing/value' }))
      .toThrow(/Fixed Work Center VP is unavailable: missing-value.*mode=fixed.*candidates=missing-value/);
    expect(() => select({
      mode: 'planned', candidateVpIds: ['missing/value'], assignmentReason: 'plan',
    })).toThrow(/No configured Work Center VP candidates are available.*mode=planned.*candidates=missing-value/);
  });
});

describe('Work Center model tags', () => {
  const availableModels = [
    { id: 'gpt-5.6-luna', ref: 'openai/gpt-5.6-luna', effortOptions: ['medium', 'high', 'xhigh', 'max'] },
    { id: 'gpt-5.6-sol', ref: 'openai/gpt-5.6-sol', effortOptions: ['medium', 'high', 'xhigh'] },
    { id: 'gpt-6-astra', ref: 'openai/gpt-6-astra', effortOptions: ['high', 'xhigh', 'max'] },
    { id: 'untagged', ref: 'openai/untagged', effortOptions: ['medium'] },
  ];

  it('ships a small default tag catalog and scenario-specific policies', () => {
    const settings = defaultWorkCenterSettings();

    expect(settings.modelTags).toEqual({
      fast: 'gpt-5.6-luna',
      balanced: 'gpt-5.6-sol',
      ultimate: 'gpt-6-astra',
    });
    expect(settings.actionModelPolicies.implement).toMatchObject({ mode: 'tag', tag: 'balanced', effort: 'high' });
    expect(settings.actionModelPolicies.research).toMatchObject({ mode: 'tag', tag: 'ultimate', effort: 'xhigh' });
    expect(settings.actionModelPolicies.deliver).toMatchObject({ mode: 'tag', tag: 'fast', effort: 'medium' });
  });

  it('selects an available model by tag without requiring every model to be tagged', () => {
    const resolved = resolveWorkItemModel(
      { availableModels },
      {},
      { mode: 'tag', tag: 'balanced', effort: 'high' },
      { balanced: 'gpt-5.6-sol' },
    );

    expect(resolved).toMatchObject({
      model: 'openai/gpt-5.6-sol',
      effort: 'high',
      source: 'tag:balanced',
    });
  });

  it('rejects missing tags and never resolves forbidden effort levels', () => {
    expect(() => resolveWorkItemModel(
      { availableModels }, {}, { mode: 'tag', tag: 'missing', effort: 'high' }, {},
    )).toThrow(/has no configured model/);
    expect(normalizeModelPolicy({ mode: 'tag', tag: 'ultimate', effort: 'max' }))
      .toEqual({ mode: 'tag', model: null, tag: 'ultimate', effort: null });
    expect(resolveWorkItemModel(
      { availableModels }, {}, { mode: 'tag', tag: 'ultimate', effort: 'xhigh' },
      { ultimate: 'gpt-6-astra' },
    ).effort).toBe('xhigh');
  });

  it('normalizes legacy settings while adding defaults without tagging unrelated models', () => {
    const settings = normalizeWorkCenterSettings({
      revision: 4,
      modelPolicy: { mode: 'primary', effort: 'high' },
    });

    expect(settings.revision).toBe(4);
    expect(settings.modelTags).toEqual(defaultWorkCenterSettings().modelTags);
    expect(Object.values(settings.modelTags)).not.toContain('untagged');
  });
});
