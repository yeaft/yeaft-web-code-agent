import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../../agent/yeaft/config.js';
import { initYeaftDir } from '../../../agent/yeaft/init.js';
import {
  getModelEffortOptions, getThinkingCapability, modelSupportsEffort,
  DEFAULT_CONTEXT_WINDOW, getModelInfo, resolveContextWindow, resolveMaxOutputTokens,
  normalizeEffort, normalizeProviderModels, serializeModelForPersistence,
} from '../../../agent/yeaft/models.js';
import { applyAnthropicThinking } from '../../../agent/yeaft/llm/anthropic.js';
import { filterEffortForModel, normalizeModelEntry } from '../../../agent/yeaft/llm/router.js';
import { captureEffortDecision, enforceSubAgentEffortPayload } from '../../../agent/yeaft/effort.js';

import { _setMemCacheForTest } from '../../../agent/yeaft/llm/models-dev.js';

const anthropicOptions = ['medium', 'xhigh', 'max'];
const openaiOptions = ['medium', 'xhigh', 'max', 'ultra'];

describe('API-based effort capability', () => {
  it('uses the 1M fallback across runtime and initialized config while preserving existing explicit limits', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-default-context-'));
    _setMemCacheForTest(null);
    try {
      expect(DEFAULT_CONTEXT_WINDOW).toBe(1000000);
      expect(loadConfig({ dir }).maxContextTokens).toBe(1000000);
      expect(resolveContextWindow('unknown-model')).toBe(1000000);
      expect(resolveContextWindow('unknown-model', { maxContextTokens: 200000 })).toBe(200000);
      expect(resolveContextWindow('unknown-model', { modelInfo: { contextWindow: 64000 } })).toBe(64000);
      initYeaftDir(dir);
      const configFile = join(dir, 'config.json');
      const seeded = JSON.parse(readFileSync(configFile, 'utf8'));
      expect(seeded.maxContextTokens).toBe(1000000);
      expect(loadConfig({ dir }).maxContextTokens).toBe(1000000);
      seeded.maxContextTokens = 200000;
      const existing = JSON.stringify(seeded);
      writeFileSync(configFile, existing);
      initYeaftDir(dir);
      expect(readFileSync(configFile, 'utf8')).toBe(existing);
      const config = loadConfig({ dir });
      expect(config.maxContextTokens).toBe(200000);
      expect(resolveContextWindow('unknown-model', config)).toBe(200000);
    } finally { _setMemCacheForTest(null); rmSync(dir, { recursive: true, force: true }); }
  });

  it('resolves qualified Opus/Fable limits above 200K without weakening overrides or namespaced IDs', () => {
    const model = (context, output = 128000) => ({ limit: { context, output } });
    _setMemCacheForTest({
      anthropic: { models: { 'claude-opus-5-5': model(1000000), 'claude-fable-5-2': model(1000000),
        'claude-opus-4-8': model(1000000) } },
      relay: { models: { 'claude-opus-4-8': model(200000, 16000), 'vendor/model': model(333000),
        'model': model(999000), 'literal/claude-opus-5-5': model(128000, 8000) } },
    });
    try {
      for (const id of ['claude-opus-5-5', 'claude-fable-5-2', 'claude-opus-4-8']) {
        expect(resolveContextWindow('codex-proxy/' + id, { maxContextTokens: 200000 })).toBe(1000000);
        expect(resolveMaxOutputTokens('codex-proxy/' + id, { maxOutputTokens: 16384 })).toBe(128000);
        expect(getModelInfo('codex-proxy/' + id)).toMatchObject({ id: 'codex-proxy/' + id, contextWindow: 1000000, maxOutput: 128000 });
        const override = { modelInfo: { contextWindow: 64000, maxOutput: 4096 } };
        expect(resolveContextWindow('codex-proxy/' + id, override)).toBe(64000);
        expect(resolveMaxOutputTokens('codex-proxy/' + id, override)).toBe(4096);
      }
      // A genuine catalog ID with slashes wins over its bare-name fallback.
      expect(resolveContextWindow('literal/claude-opus-5-5')).toBe(128000);
      expect(resolveMaxOutputTokens('literal/claude-opus-5-5')).toBe(8000);
      expect(resolveContextWindow('gateway/vendor/model')).toBe(333000);
      expect(resolveContextWindow('gateway/unknown', { maxContextTokens: 123000 })).toBe(123000);
      expect(resolveContextWindow('gateway/unknown')).toBe(1000000);
      expect(resolveContextWindow('claude-opus-5-50')).toBe(1000000);
    } finally { _setMemCacheForTest(null); }
  });

  it('resolves nested aliases longest-first while preserving small catalog limits and wire IDs', () => {
    const model = (context, output) => ({ limit: { context, output } });
    _setMemCacheForTest({
      anthropic: { models: {
        'claude-fable-5-2': model(1000000, 128000),
        'claude-opus-5-5': model(1000000, 96000),
        'claude-haiku-3-20250414': model(200000, 8192),
      } },
      relay: { models: {
        'literal/sandbox/claude-fable-5-2': model(64000, 4096),
        'vendor/claude-fable-5-2': model(128000, 8000),
      } },
    });
    try {
      for (const [id, context, output] of [
        ['loki/sandbox/claude-fable-5-2', 1000000, 128000],
        ['codex-proxy/claude-opus-5-5', 1000000, 96000],
        ['loki/sandbox/claude-haiku-3-20250414', 200000, 8192],
        ['literal/sandbox/claude-fable-5-2', 64000, 4096],
        ['loki/sandbox/vendor/claude-fable-5-2', 128000, 8000],
      ]) {
        expect(resolveContextWindow(id, { maxContextTokens: 200000 })).toBe(context);
        expect(resolveMaxOutputTokens(id, { maxOutputTokens: 16384 })).toBe(output);
        expect(getModelInfo(id)).toMatchObject({ id, contextWindow: context, maxOutput: output });
        const override = { contextWindow: 32000, maxOutput: 2048 };
        expect(resolveContextWindow(id, { modelInfo: override })).toBe(32000);
        expect(resolveMaxOutputTokens(id, { modelInfo: override })).toBe(2048);
        expect(getModelInfo(id, override)).toMatchObject({ id, ...override });
      }
    } finally { _setMemCacheForTest(null); }
  });

  it('uses only the exact Fable 5.2 context fallback without catalog metadata', () => {
    _setMemCacheForTest(null);
    try {
      const config = { maxContextTokens: 200000, maxOutputTokens: 4096 };
      for (const id of ['claude-fable-5-2', 'loki/sandbox/claude-fable-5-2']) {
        expect(resolveContextWindow(id, config)).toBe(1000000);
        expect(resolveMaxOutputTokens(id, config)).toBe(4096);
        expect(getModelInfo(id)).toEqual({ id, contextWindow: 1000000 });
        expect(resolveContextWindow(id, { ...config, modelInfo: { contextWindow: 64000 } })).toBe(64000);
      }
      for (const id of ['loki/sandbox/claude-fable-5-20', 'loki/sandbox/claude-fable-5-2-preview',
        'codex-proxy/claude-opus-5-5', 'loki/sandbox/claude-haiku-3-20250414', 'unknown']) {
        expect(resolveContextWindow(id, config)).toBe(200000);
        expect(resolveMaxOutputTokens(id, config)).toBe(4096);
      }
      // Even smaller catalog metadata beats the known-capability fallback.
      _setMemCacheForTest({ relay: { models: { 'claude-fable-5-2': { limit: { context: 128000, output: 8000 } } } } });
      expect(resolveContextWindow('loki/sandbox/claude-fable-5-2', config)).toBe(128000);
      expect(resolveMaxOutputTokens('loki/sandbox/claude-fable-5-2', config)).toBe(8000);
    } finally { _setMemCacheForTest(null); }
  });

  it('uses the effective API for future models, opaque aliases and IDs from the other vendor', () => {
    for (const model of ['new-model', 'proxy/private-alias', 'gpt-4.1', 'gpt-5.5', 'claude-haiku-3-20250414', 'claude-fable-50', 'anthropic.claude-mythos-preview']) {
      for (const [protocol, thinkingProtocol, effortOptions] of [
        ['anthropic', 'anthropic-adaptive', anthropicOptions],
        ['openai-responses', 'openai-reasoning', openaiOptions],
      ]) {
        expect(getThinkingCapability(model, { protocol }), model).toEqual({
          supportsThinking: true, thinkingProtocol, defaultEffort: protocol === 'anthropic' ? 'xhigh' : null,
          maxBudgetTokens: null, effortOptions,
        });
        expect(getModelEffortOptions(model, { protocol }), model).toEqual(effortOptions);
        expect(modelSupportsEffort(model, { protocol }), model).toBe(true);
      }
    }
    for (const [legacy, current] of [['minimal', 'medium'], ['low', 'medium'], ['high', 'xhigh']]) {
      expect(normalizeEffort(legacy)).toBe(current);
      for (const protocol of ['anthropic', 'openai-responses']) {
        expect(filterEffortForModel({ model: 'alias', effort: legacy, effortSource: 'user' }, { protocol }).effort).toBe(current);
      }
    }
    // Legacy callers may still infer the API, but never a model-specific tier list.
    expect(getModelEffortOptions('claude-opus-4-6')).toEqual(anthropicOptions);
    expect(getModelEffortOptions('gpt-future')).toEqual(openaiOptions);
    const copy = getModelEffortOptions('alias', { protocol: 'anthropic' });
    copy.pop();
    expect(getModelEffortOptions('alias', { protocol: 'anthropic' })).toEqual(anthropicOptions);
  });

  it('preserves explicit disable, tier restrictions and legacy manual budgets without overriding the wire API', () => {
    for (const protocol of ['anthropic', 'openai-responses']) {
      for (const override of [{ supportsEffort: false }, { thinkingProtocol: 'none' }]) {
        const entry = normalizeModelEntry({ id: 'alias', ...override });
        const persisted = serializeModelForPersistence(normalizeProviderModels({ models: [entry] })[0]);
        expect(persisted).toMatchObject(override);
        expect(getModelEffortOptions('alias', { protocol, ...persisted })).toEqual([]);
        expect(filterEffortForModel({ model: 'alias', effort: 'high', effortSource: 'user' }, { protocol, entry })).toEqual({ model: 'alias' });
      }
      expect(getModelEffortOptions('alias', { protocol, effortOptions: ['high', 'low', 'low', 'invalid', 'ultra'] }))
        .toEqual(protocol === 'anthropic' ? ['medium', 'xhigh'] : ['medium', 'xhigh', 'ultra']);
    }
    expect(getThinkingCapability('alias', { protocol: 'openai-responses', thinkingProtocol: 'anthropic' }).thinkingProtocol).toBe('openai-reasoning');
    expect(getThinkingCapability('alias', { protocol: 'anthropic', thinkingProtocol: 'openai-reasoning' }).thinkingProtocol).toBe('anthropic-adaptive');
    expect(getModelEffortOptions('alias', { protocol: 'unsupported' })).toEqual([]);
    expect(getModelEffortOptions('alias', { protocol: 'anthropic', effortOptions: ['ultra'] })).toEqual([]);
    const manual = { protocol: 'anthropic', thinkingProtocol: 'anthropic', maxBudgetTokens: 6000, effortOptions: ['low', 'high', 'max'] };
    const persisted = serializeModelForPersistence(normalizeProviderModels({ models: [{ id: 'legacy-alias', ...manual }] })[0]);
    expect(persisted).toMatchObject({ ...manual, effortOptions: ['medium', 'xhigh', 'max'] });
    const body = { max_tokens: 4096 };
    applyAnthropicThinking(body, 'legacy-alias', 'max', persisted);
    expect(body).toEqual({ max_tokens: 7024, thinking: { type: 'enabled', budget_tokens: 6000 } });
    expect(getModelEffortOptions('legacy-alias', persisted)).toEqual(['medium', 'xhigh', 'max']);
  });

  it('retains user effort through router and payload translation while enforcing inherited child ceilings', () => {
    for (const model of ['new-model', 'claude-mythos-preview', 'gpt-4.1']) {
      for (const effort of anthropicOptions) {
        const params = { model, effort, effortSource: 'user' };
        expect(filterEffortForModel(params, { protocol: 'anthropic' })).toEqual(params);
        const body = { max_tokens: 4096 };
        applyAnthropicThinking(body, model, effort);
        expect(body).toEqual({ max_tokens: 4096, thinking: { type: 'adaptive' }, output_config: { effort } });
      }
      for (const effort of openaiOptions) {
        const params = { model, effort, effortSource: 'user' };
        expect(filterEffortForModel(params, { protocol: 'openai-responses' })).toEqual(params);
      }
      for (const effort of ['ultra', 'invalid']) {
        expect(filterEffortForModel({ model, effort, effortSource: 'user' }, { protocol: 'anthropic' })).toEqual({ model });
      }
      expect(captureEffortDecision({ model, protocol: 'anthropic' })).toMatchObject({ effective: 'xhigh', source: 'model-default', wireMode: 'omitted' });
      for (const protocol of ['anthropic', 'openai-responses']) {
        const body = { max_tokens: 4096, reasoning: { effort: 'ultra' }, thinking: { type: 'adaptive' }, output_config: { effort: 'max' } };
        expect(enforceSubAgentEffortPayload(body, { model, protocol,
          effortConstraint: { parentDecision: { effective: 'max' } },
        })).toMatchObject({ effective: 'medium', wireMode: protocol === 'anthropic' ? 'adaptive' : 'reasoning-effort' });
        if (protocol === 'anthropic') {
          expect(body).toEqual({ max_tokens: 4096, thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } });
        } else {
          expect(body).toEqual({ max_tokens: 4096, reasoning: { effort: 'medium' } });
        }
      }
    }
  });
});

describe('native Gemini config and catalog integration', () => {
  it('resolves native limits, API effort and explicit overrides without changing Copilot routes', async () => {
    const { geminiThinkingBudgetForEffort, resolveModel } = await import('../../../agent/yeaft/models.js');
    const { normalizeKnownProviderForRuntime } = await import('../../../agent/yeaft/llm/known-providers.js');
    const { updateLlmConfig, getLlmConfig } = await import('../../../agent/yeaft/config-api.js');
    const { addOrUpdateProvider } = await import('../../../agent/llm-config-cli.js');
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-gemini-config-'));
    _setMemCacheForTest(null);
    try {
      expect(resolveModel('gemini-2.5-pro')).toMatchObject({ adapter: 'gemini', supportsImages: true });
      expect(resolveContextWindow('google/gemini-2.5-pro')).toBe(1048576);
      expect(resolveMaxOutputTokens('gemini-2.5-flash')).toBe(65536);
      expect(getModelEffortOptions('gemini-2.5-pro', { protocol: 'gemini' })).toEqual(anthropicOptions);
      expect(getModelEffortOptions('gemini-2.5-pro', { protocol: 'openai-responses' })).toEqual(openaiOptions);
      expect(getModelEffortOptions('gemini-2.5-pro', { protocol: 'gemini', supportsEffort: false })).toEqual([]);
      expect(getModelEffortOptions('gemini-2.5-flash', { protocol: 'gemini', effortOptions: ['medium'] })).toEqual(['medium']);
      expect(getThinkingCapability('gemini-3-pro-preview', { protocol: 'gemini' }).maxBudgetTokens).toBeNull();
      expect(['medium', 'xhigh', 'max'].map(e => geminiThinkingBudgetForEffort('gemini-2.5-pro', e))).toEqual([8192, 16384, 32768]);
      expect(geminiThinkingBudgetForEffort('gemini-2.5-flash', 'max')).toBe(24576);
      const copilot = normalizeKnownProviderForRuntime({ name: 'github-copilot', models: ['gemini-2.5-pro'] });
      expect(copilot.models[0].protocol).toBe('openai-responses');
      const { provider } = addOrUpdateProvider({}, { name: 'google', protocol: 'gemini', models: 'gemini-2.5-pro', apiKey: 'fixture' });
      expect(provider.baseUrl).toBe('https://generativelanguage.googleapis.com/v1');
      delete provider.baseUrl;
      expect(updateLlmConfig({ providers: [provider, copilot], primaryModel: 'google/gemini-2.5-pro' }, dir).error).toBeUndefined();
      const config = loadConfig({ dir });
      expect(config.providers[0].baseUrl).toContain('/v1');
      expect(config.availableModels.find(m => m.ref === 'google/gemini-2.5-pro')).toMatchObject({ protocol: 'gemini', effortOptions: anthropicOptions });
      expect(getLlmConfig(dir).availableModels.find(m => m.ref === 'github-copilot/gemini-2.5-pro').protocol).toBe('openai-responses');
      expect(updateLlmConfig({ providers: [{ ...provider, protocol: 'bogus' }] }, dir).error).toContain('Unsupported');
    } finally { _setMemCacheForTest(null); rmSync(dir, { recursive: true, force: true }); }
  });

  it('discovers paginated native models with header credentials, limits and setup validation', async () => {
    const { discoverLlmModels, discoverGeminiModels } = await import('../../../agent/llm-model-discovery.js');
    const { useGemini } = await import('../../../agent/llm-config-cli.js');
    const calls = [];
    const fetchFn = async (url, options) => {
      calls.push({ url, options });
      const second = new URL(url).searchParams.has('pageToken');
      return { ok: true, text: async () => JSON.stringify(second ? {
        models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1048576, outputTokenLimit: 65536 }],
      } : {
        models: [{ name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'opaque+/=',
      }) };
    };
    const result = await discoverLlmModels({ providerType: 'gemini', apiKey: 'fixture-secret', fetchFn });
    expect(result.models).toEqual(['gemini-2.5-pro', 'gemini-2.5-flash']);
    expect(result.providerModels[1]).toMatchObject({ protocol: 'gemini', contextWindow: 1048576, maxOutput: 65536 });
    expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1/models');
    expect(calls[0].options.headers['x-goog-api-key']).toBe('fixture-secret');
    expect(calls[1].url).not.toContain('fixture-secret');
    expect(new URL(calls[1].url).searchParams.get('pageToken')).toBe('opaque+/=');
    const setup = await useGemini({}, { model: 'gemini-2.5-pro', apiKeyEnv: 'FIXTURE', fetchFn }, { FIXTURE: 'fixture-secret' });
    expect(setup.config.primaryModel).toBe('google/gemini-2.5-pro');
    expect(setup.provider.protocol).toBe('gemini');
    await expect(useGemini({}, { model: 'not-there', apiKey: 'fixture', fetchFn })).rejects.toThrow('not found');
    await expect(discoverGeminiModels({})).rejects.toThrow('API key');
    await expect(discoverGeminiModels({ apiKey: 'fixture', fetchFn: async () => ({ ok: false, status: 401 }) })).rejects.toThrow('HTTP 401');
    await expect(discoverGeminiModels({ apiKey: 'fixture', fetchFn: async () => ({ ok: true, text: async () => JSON.stringify({ models: [], nextPageToken: 'repeated' }) }) })).rejects.toThrow('pagination');
  });
});
