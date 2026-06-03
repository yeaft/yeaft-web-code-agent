import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('copilot-models', () => {
  beforeEach(async () => {
    vi.resetModules();
    const m = await import('../../../agent/providers/copilot-models.js');
    m._resetCopilotModelsCacheForTests();
  });

  it('_normalizeAcpModel maps ACP model entries with metadata', async () => {
    const m = await import('../../../agent/providers/copilot-models.js');
    const out = m._normalizeAcpModelForTests({
      modelId: 'claude-sonnet-4.5',
      name: 'Claude Sonnet 4.5',
      _meta: {
        copilotUsage: '1x',
        copilotPriceCategory: 'medium',
        copilotEnablement: 'enabled',
      },
    });
    expect(out).toEqual({
      id: 'claude-sonnet-4.5',
      label: 'Claude Sonnet 4.5',
      vendor: 'Anthropic',
      usage: '1x',
      priceCategory: 'medium',
      enablement: 'enabled',
    });
  });

  it('_normalizeAcpModel skips the "auto" sentinel', async () => {
    const m = await import('../../../agent/providers/copilot-models.js');
    expect(m._normalizeAcpModelForTests({ modelId: 'auto', name: 'Auto' })).toBe(null);
  });

  it('_normalizeAcpModel infers vendor from id prefix', async () => {
    const m = await import('../../../agent/providers/copilot-models.js');
    expect(m._normalizeAcpModelForTests({ modelId: 'gpt-5' }).vendor).toBe('OpenAI');
    expect(m._normalizeAcpModelForTests({ modelId: 'gemini-2.5-pro' }).vendor).toBe('Google');
    expect(m._normalizeAcpModelForTests({ modelId: 'claude-opus-4.5' }).vendor).toBe('Anthropic');
    expect(m._normalizeAcpModelForTests({ modelId: 'mystery-1' }).vendor).toBe('');
  });

  it('cacheCopilotModelsFromAcp primes the cache so listCopilotModels returns it without probing', async () => {
    const m = await import('../../../agent/providers/copilot-models.js');
    m.cacheCopilotModelsFromAcp([
      { modelId: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', _meta: { copilotUsage: '1x', copilotPriceCategory: 'medium' } },
      { modelId: 'gpt-5', name: 'GPT-5', _meta: { copilotUsage: '1x', copilotPriceCategory: 'medium' } },
      { modelId: 'auto', name: 'Auto' },
    ]);
    const out = await m.listCopilotModels();
    expect(out.map(x => x.id)).toEqual(['claude-sonnet-4.5', 'gpt-5']);
    expect(out[0].usage).toBe('1x');
  });

  it('cacheCopilotModelsFromAcp ignores empty/invalid input', async () => {
    const m = await import('../../../agent/providers/copilot-models.js');
    m.cacheCopilotModelsFromAcp([]);
    m.cacheCopilotModelsFromAcp(null);
    m.cacheCopilotModelsFromAcp([{ name: 'no id' }]); // no modelId
    // Cache still cold — falls back to static list (probe will fail since `copilot` likely not on PATH in CI; either way we get a non-empty result).
    const out = await m.listCopilotModels();
    expect(out.length).toBeGreaterThan(0);
  });

  it('exposes FALLBACK_COPILOT_MODELS and DEFAULT_COPILOT_MODEL', async () => {
    const m = await import('../../../agent/providers/copilot-models.js');
    expect(Array.isArray(m.FALLBACK_COPILOT_MODELS)).toBe(true);
    expect(m.FALLBACK_COPILOT_MODELS.length).toBeGreaterThan(0);
    expect(typeof m.DEFAULT_COPILOT_MODEL).toBe('string');
  });
});
