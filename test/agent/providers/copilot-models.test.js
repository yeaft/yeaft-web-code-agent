import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('copilot-models — listCopilotModels', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns mapped picker-enabled chat models from /models', async () => {
    vi.doMock('../../../agent/yeaft/llm/credentials/github-copilot.js', () => ({
      getApiToken: async () => ({ token: 'tok', source: 'test', exchanged: true }),
      resolveRawToken: async () => ({ token: 'tok', source: 'test' }),
      validateRawToken: () => ({ valid: true }),
      copilotRequestHeaders: () => ({ 'X-T': '1' }),
    }));
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [
        { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', vendor: 'Anthropic', model_picker_enabled: true, capabilities: { type: 'chat', family: 'claude-sonnet-4.5' } },
        { id: 'gpt-5', name: 'GPT-5', vendor: 'OpenAI', model_picker_enabled: true, capabilities: { type: 'chat', family: 'gpt-5' }, preview: true },
        { id: 'text-embedding-3', name: 'Embed', model_picker_enabled: true, capabilities: { type: 'embeddings' } }, // wrong type
        { id: 'gpt-3.5', name: 'GPT-3.5', model_picker_enabled: false, capabilities: { type: 'chat' } },             // not picker-enabled
      ] }),
    }));
    globalThis.fetch = fetchMock;
    const m = await import('../../../agent/providers/copilot-models.js');
    m._resetCopilotModelsCacheForTests();
    const out = await m.listCopilotModels();
    expect(out).toEqual([
      { id: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5', vendor: 'Anthropic', preview: false, family: 'claude-sonnet-4.5' },
      { id: 'gpt-5',             label: 'GPT-5',             vendor: 'OpenAI',    preview: true,  family: 'gpt-5' },
    ]);
  });

  it('falls back to static list when no auth available', async () => {
    vi.doMock('../../../agent/yeaft/llm/credentials/github-copilot.js', () => ({
      getApiToken: async () => null,
      resolveRawToken: async () => null,
      validateRawToken: () => ({ valid: false }),
      copilotRequestHeaders: () => ({}),
    }));
    const m = await import('../../../agent/providers/copilot-models.js');
    m._resetCopilotModelsCacheForTests();
    const out = await m.listCopilotModels();
    expect(out.length).toBeGreaterThan(0);
    expect(out).toEqual(m.FALLBACK_COPILOT_MODELS.slice());
  });

  it('falls back when /models returns non-OK', async () => {
    vi.doMock('../../../agent/yeaft/llm/credentials/github-copilot.js', () => ({
      getApiToken: async () => ({ token: 'tok', source: 'test', exchanged: true }),
      resolveRawToken: async () => ({ token: 'tok', source: 'test' }),
      validateRawToken: () => ({ valid: true }),
      copilotRequestHeaders: () => ({}),
    }));
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500, text: async () => 'boom' }));
    const m = await import('../../../agent/providers/copilot-models.js');
    m._resetCopilotModelsCacheForTests();
    const out = await m.listCopilotModels();
    expect(out).toEqual(m.FALLBACK_COPILOT_MODELS.slice());
  });
});
