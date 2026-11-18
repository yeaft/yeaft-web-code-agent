import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { addOrUpdateProvider, useGemini } from '../../../agent/llm-config-cli.js';
import { discoverGeminiModels, GEMINI_BASE_URL } from '../../../agent/llm-model-discovery.js';
import { getLlmConfig, updateLlmConfig } from '../../../agent/yeaft/config-api.js';
import { loadConfig } from '../../../agent/yeaft/config.js';
import { createProviderContext } from '../../../agent/yeaft/llm/provider-state.js';

const HOST = 'https://generativelanguage.googleapis.com';
const BETA = `${HOST}/v1beta`;
const CUSTOM = 'https://gateway.invalid/prefix/v1beta/models/previous:streamGenerateContent?route=google';
const MODEL = 'gemini-2.5-pro';
const modelListFetch = (metadata = {}) => vi.fn(async () => ({ ok: true, text: async () => JSON.stringify({
  models: [{ name: `models/${MODEL}`, supportedGenerationMethods: ['generateContent'], ...metadata }],
}) }));

function provider(name, baseUrl) {
  return { name, protocol: 'gemini', models: [MODEL], apiKey: 'fixture-key',
    ...(baseUrl === undefined ? {} : { baseUrl }) };
}

describe('Gemini stable endpoint defaults', () => {
  it('defaults omitted config/API endpoints without rewriting existing explicit URLs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-gemini-endpoint-'));
    try {
      const configPath = join(dir, 'config.json');
      const providers = [provider('default'), provider('beta', BETA), provider('custom', CUSTOM)];
      const expected = [`${HOST}/v1`, BETA, CUSTOM];
      writeFileSync(configPath, JSON.stringify({ providers }));
      expect(loadConfig({ dir }).providers.map(p => p.baseUrl)).toEqual(expected);
      expect(getLlmConfig(dir).providers.map(p => p.baseUrl)).toEqual(expected);
      expect(JSON.parse(readFileSync(configPath, 'utf8')).providers).toEqual(providers);
      expect(updateLlmConfig({ providers }, dir).providers.map(p => p.baseUrl)).toEqual(expected);
      expect(JSON.parse(readFileSync(configPath, 'utf8')).providers.map(p => p.baseUrl)).toEqual(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses the same endpoint for CLI setup discovery and saved config, defaulting only when no native endpoint exists', async () => {
    const stable = `${HOST}/v1`;
    for (const [existing, baseUrl, expected, modelsUrl] of [
      [undefined, undefined, stable, `${stable}/models`],
      [{ ...provider('google', CUSTOM), protocol: 'openai-responses' }, undefined, stable, `${stable}/models`],
      [provider('google', CUSTOM), BETA, BETA, `${BETA}/models`],
      [provider('google', BETA), undefined, BETA, `${BETA}/models`],
      [provider('google', CUSTOM), undefined, CUSTOM, 'https://gateway.invalid/prefix/v1beta/models?route=google'],
    ]) {
      const config = { providers: existing ? [existing] : [] };
      const fetchFn = modelListFetch();
      const result = await useGemini(config, { baseUrl, fetchFn, apiKey: 'fixture-key', model: MODEL });
      expect(fetchFn).toHaveBeenCalledWith(modelsUrl, expect.objectContaining({ method: 'GET' }));
      expect(result.config.providers[0].baseUrl).toBe(expected);
      expect(result.discovery.provider.baseUrl).toBe(expected);
      expect(addOrUpdateProvider(config, { name: 'google', protocol: 'gemini', baseUrl, models: MODEL }).provider.baseUrl).toBe(expected);
    }
  });

  it('preserves matching model overrides on CLI update and rediscovery while refreshing supplied catalog limits', async () => {
    const saved = {
      id: MODEL, protocol: 'anthropic', effortOptions: ['high'], supportsEffort: true,
      thinkingProtocol: 'anthropic', maxBudgetTokens: 6000, contextWindow: 2048, maxOutput: 512,
      geminiOptions: { serviceTier: 'flex', generationConfig: { stopSequences: ['END'] } },
    };
    const config = { providers: [{ ...provider('google', CUSTOM), models: [saved] }] };
    const update = addOrUpdateProvider(config, { name: 'google', models: `${MODEL}, new-model` });
    expect(update.provider).toMatchObject({ protocol: 'gemini', baseUrl: CUSTOM, models: [saved, 'new-model'] });
    const fetchFn = modelListFetch({ inputTokenLimit: 65536, outputTokenLimit: 8192, thinking: false });
    const result = await useGemini(config, { fetchFn, apiKey: 'fixture-key', model: MODEL });
    expect(result.discovery.providerModels).toEqual([
      { id: MODEL, protocol: 'gemini', contextWindow: 65536, maxOutput: 8192, supportsEffort: false },
    ]);
    expect(result.provider.models).toEqual([{ ...saved, contextWindow: 65536, maxOutput: 8192 }]);
    expect(result.provider.models[0].geminiOptions).not.toBe(saved.geminiOptions);
  });

  it('normalizes host-only discovery to v1 and preserves custom collection prefixes and routing parameters', async () => {
    const fetchFn = modelListFetch();
    await discoverGeminiModels({ baseUrl: `${HOST}/?key=unused&alt=sse`, apiKey: 'fixture-key', fetchFn });
    await discoverGeminiModels({ baseUrl: CUSTOM, apiKey: 'fixture-key', fetchFn });
    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([
      `${HOST}/v1/models`, 'https://gateway.invalid/prefix/v1beta/models?route=google',
    ]);
  });

  it('uses one native continuation identity for omitted, host-only and stable paths but fences beta and custom URLs', () => {
    const context = baseUrl => createProviderContext({ protocol: 'gemini', baseUrl, model: MODEL, staticApiKey: 'fixture-key' });
    const stable = context(GEMINI_BASE_URL);
    expect(context(undefined)).toEqual(stable);
    expect(context(`${HOST}/`)).toEqual(stable);
    expect(stable.diagnostics.capabilitySource).toBe('native-endpoint');
    expect(context(BETA).diagnostics.capabilitySource).toBe('native-endpoint');
    expect(context(BETA).origin.endpointFingerprint).not.toBe(stable.origin.endpointFingerprint);
    expect(context(CUSTOM).origin.endpointFingerprint).not.toBe(stable.origin.endpointFingerprint);
  });
});
