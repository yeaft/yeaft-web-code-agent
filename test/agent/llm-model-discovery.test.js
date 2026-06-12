import { describe, expect, it } from 'vitest';
import {
  discoverGitHubCopilotModels,
  discoverOpenAICompatibleModels,
  modelEntryForProvider,
  openAIModelsUrl,
} from '../../agent/llm-model-discovery.js';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
  };
}

describe('LLM model discovery', () => {
  it('discovers GitHub Copilot models from data payload and marks Claude models as anthropic', async () => {
    const calls = [];
    const result = await discoverGitHubCopilotModels({
      getTokenFn: async () => ({ token: 'copilot-token', source: 'test', exchanged: true }),
      fetchFn: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse({ data: [{ id: 'claude-sonnet-4.5' }, { id: 'gpt-5' }] });
      },
    });

    expect(calls[0].url).toBe('https://api.githubcopilot.com/models');
    expect(calls[0].init.headers.Authorization).toBe('Bearer copilot-token');
    expect(result.source).toBe('live');
    expect(result.models).toEqual(['claude-sonnet-4.5', 'gpt-5']);
    expect(result.providerModels).toEqual([{ id: 'claude-sonnet-4.5', protocol: 'anthropic' }, 'gpt-5']);
  });

  it('falls back to the built-in Copilot list when live catalog is unavailable', async () => {
    const result = await discoverGitHubCopilotModels({
      getTokenFn: async () => ({ token: 'copilot-token' }),
      fetchFn: async () => jsonResponse({ error: 'nope' }, { ok: false, status: 503 }),
    });

    expect(result.source).toBe('fallback');
    expect(result.warning).toContain('Live model catalog unavailable');
    expect(result.models.length).toBeGreaterThan(0);
  });

  it('throws a clear error when Copilot credentials are missing', async () => {
    await expect(discoverGitHubCopilotModels({ getTokenFn: async () => null })).rejects.toMatchObject({
      code: 'COPILOT_CREDENTIAL_MISSING',
    });
  });

  it('normalizes OpenAI-compatible model URLs and payload variants', async () => {
    expect(openAIModelsUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1/models');
    expect(openAIModelsUrl('https://api.example.com')).toBe('https://api.example.com/v1/models');

    const result = await discoverOpenAICompatibleModels({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      fetchFn: async (url, init) => {
        expect(url).toBe('https://api.example.com/v1/models');
        expect(init.headers.Authorization).toBe('Bearer sk-test');
        return jsonResponse([{ id: 'gpt-5' }, { id: 'claude-sonnet-4.5' }]);
      },
    });

    expect(result.models).toEqual(['gpt-5', 'claude-sonnet-4.5']);
    expect(modelEntryForProvider('claude-sonnet-4.5')).toEqual({ id: 'claude-sonnet-4.5', protocol: 'anthropic' });
  });
});
