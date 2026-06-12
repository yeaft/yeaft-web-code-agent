import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  MODEL_REGISTRY,
  resolveModel,
  resolveContextWindow,
  resolveMaxOutputTokens,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT_TOKENS,
  listModels,
  isKnownModel,
  getProviderForModel,
  parseModelRef,
  getModelInfo,
} from '../../../agent/yeaft/models.js';
import { _setMemCacheForTest, _resetMemCache } from '../../../agent/yeaft/llm/models-dev.js';

// Seed the models.dev cache with a deterministic snapshot so the resolver
// ladder lights up rung 2 (models.dev). The shape mirrors the real
// `https://models.dev/api.json` payload: `{providerId: {models: {modelId:
// {limit: {context, output}}}}}`. We override `beforeEach` per-suite so
// unrelated tests don't leak state.
const SNAPSHOT = {
  anthropic: {
    models: {
      'claude-sonnet-4-20250514': { limit: { context: 200_000, output: 64_000 } },
      'claude-opus-4-20250514': { limit: { context: 200_000, output: 32_000 } },
    },
  },
  openai: {
    models: {
      'gpt-5': { limit: { context: 400_000, output: 128_000 } },
      'o3': { limit: { context: 200_000, output: 100_000 } },
    },
  },
  deepseek: {
    models: {
      'deepseek-chat': { limit: { context: 131_072, output: 8_192 } },
    },
  },
  google: {
    models: {
      'gemini-2.5-pro': { limit: { context: 1_048_576, output: 65_536 } },
    },
  },
  // Cross-provider collision: same id under three providers with different
  // context windows. The MIN policy should pick the smallest.
  cerebras: { models: { 'shared-collision': { limit: { context: 32_000, output: 8_000 } } } },
  groq: { models: { 'shared-collision': { limit: { context: 64_000, output: 8_000 } } } },
  fireworks: { models: { 'shared-collision': { limit: { context: 128_000, output: 16_000 } } } },
};

describe('MODEL_REGISTRY', () => {
  it('should contain Anthropic models', () => {
    expect(MODEL_REGISTRY.has('claude-sonnet-4-20250514')).toBe(true);
    expect(MODEL_REGISTRY.has('claude-opus-4-20250514')).toBe(true);
    expect(MODEL_REGISTRY.has('claude-haiku-3-20250414')).toBe(true);
  });

  it('should contain OpenAI models', () => {
    expect(MODEL_REGISTRY.has('gpt-5')).toBe(true);
    expect(MODEL_REGISTRY.has('gpt-5.4')).toBe(true);
    expect(MODEL_REGISTRY.has('gpt-4.1')).toBe(true);
    expect(MODEL_REGISTRY.has('gpt-4.1-mini')).toBe(true);
    expect(MODEL_REGISTRY.has('o3')).toBe(true);
    expect(MODEL_REGISTRY.has('o4-mini')).toBe(true);
  });

  it('should contain DeepSeek models', () => {
    expect(MODEL_REGISTRY.has('deepseek-chat')).toBe(true);
    expect(MODEL_REGISTRY.has('deepseek-reasoner')).toBe(true);
  });

  it('should contain Gemini models', () => {
    expect(MODEL_REGISTRY.has('gemini-2.5-pro')).toBe(true);
    expect(MODEL_REGISTRY.has('gemini-2.5-flash')).toBe(true);
  });

  it('should have correct adapter/baseUrl/displayName + NO hardcoded token fields', () => {
    for (const [, info] of MODEL_REGISTRY) {
      expect(['anthropic', 'openai-responses']).toContain(info.adapter);
      expect(info.baseUrl).toBeTruthy();
      expect(info.displayName).toBeTruthy();
      // Token limits MUST NOT live on the registry anymore — they come from
      // models.dev at runtime (see resolveContextWindow / resolveMaxOutputTokens).
      // Hardcoded numbers go stale; the registry is meant to carry only
      // routing + capability metadata.
      expect(info.contextWindow).toBeUndefined();
      expect(info.maxOutputTokens).toBeUndefined();
    }
  });

  it('should use "anthropic" adapter for Claude models', () => {
    for (const [name, info] of MODEL_REGISTRY) {
      if (name.startsWith('claude-')) {
        expect(info.adapter).toBe('anthropic');
        expect(info.baseUrl).toBe('https://api.anthropic.com');
      }
    }
  });

  it('should use "openai-responses" adapter for non-Claude models', () => {
    for (const [name, info] of MODEL_REGISTRY) {
      if (!name.startsWith('claude-')) {
        expect(info.adapter).toBe('openai-responses');
      }
    }
  });
});

describe('resolveModel', () => {
  it('should return ModelInfo (no token fields) for known models', () => {
    const info = resolveModel('gpt-5');
    expect(info).not.toBeNull();
    expect(info.adapter).toBe('openai-responses');
    expect(info.baseUrl).toBe('https://api.openai.com/v1');
    expect(info.displayName).toBe('GPT-5');
    // Token limits intentionally not on the registry entry.
    expect(info.contextWindow).toBeUndefined();
  });

  it('should return null for unknown models', () => {
    expect(resolveModel('nonexistent-model')).toBeNull();
    expect(resolveModel('gpt-99')).toBeNull();
  });

  it('should return null for null/undefined', () => {
    expect(resolveModel(null)).toBeNull();
    expect(resolveModel(undefined)).toBeNull();
    expect(resolveModel('')).toBeNull();
  });

  it('should resolve Anthropic models correctly', () => {
    const info = resolveModel('claude-sonnet-4-20250514');
    expect(info.adapter).toBe('anthropic');
    expect(info.baseUrl).toBe('https://api.anthropic.com');
    expect(info.provider).toBe('anthropic');
  });

  it('should resolve DeepSeek models correctly', () => {
    const info = resolveModel('deepseek-chat');
    expect(info.adapter).toBe('openai-responses');
    expect(info.baseUrl).toBe('https://api.deepseek.com');
    expect(info.provider).toBe('deepseek');
  });

  it('should resolve Gemini models correctly', () => {
    const info = resolveModel('gemini-2.5-pro');
    expect(info.adapter).toBe('openai-responses');
    expect(info.baseUrl).toContain('googleapis.com');
    expect(info.provider).toBe('google');
  });

  it('should return a copy, not a reference to the registry entry', () => {
    const info1 = resolveModel('gpt-5');
    const info2 = resolveModel('gpt-5');
    expect(info1).toEqual(info2);
    expect(info1).not.toBe(info2);
    // Mutating the copy must not leak back through resolveModel calls.
    info1.displayName = 'mutated';
    const info3 = resolveModel('gpt-5');
    expect(info3.displayName).toBe('GPT-5');
  });
});

describe('resolveContextWindow + resolveMaxOutputTokens', () => {
  beforeEach(() => {
    _setMemCacheForTest(SNAPSHOT);
  });
  afterEach(() => {
    _resetMemCache();
  });

  it('returns models.dev value when the snapshot has the model under the hinted provider', () => {
    // gpt-5 lives under `openai` in the snapshot at 400K. MODEL_REGISTRY's
    // `provider: 'openai'` field is used as the hint.
    expect(resolveContextWindow('gpt-5', null)).toBe(400_000);
    expect(resolveMaxOutputTokens('gpt-5', null)).toBe(128_000);
  });

  it('returns models.dev value for Claude / DeepSeek / Gemini via hint match', () => {
    expect(resolveContextWindow('claude-sonnet-4-20250514', null)).toBe(200_000);
    expect(resolveContextWindow('deepseek-chat', null)).toBe(131_072);
    expect(resolveContextWindow('gemini-2.5-pro', null)).toBe(1_048_576);
  });

  it('falls back to MIN-of-all providers when no hint is provided', () => {
    // shared-collision lives under 3 providers with 32K / 64K / 128K
    // context. Without a hint, MIN = 32K (the safest ceiling).
    expect(resolveContextWindow('shared-collision', null)).toBe(32_000);
    expect(resolveMaxOutputTokens('shared-collision', null)).toBe(8_000);
  });

  it('uses config.modelInfo override when present (rung 1)', () => {
    const ctx = resolveContextWindow('gpt-5', {
      modelInfo: { contextWindow: 9_999 },
    });
    expect(ctx).toBe(9_999);
  });

  it('falls through to config.maxContextTokens when models.dev misses (rung 3)', () => {
    const ctx = resolveContextWindow('totally-unknown-model', {
      maxContextTokens: 50_000,
    });
    expect(ctx).toBe(50_000);
    const out = resolveMaxOutputTokens('totally-unknown-model', {
      maxOutputTokens: 4_096,
    });
    expect(out).toBe(4_096);
  });

  it('falls through to DEFAULT_CONTEXT_WINDOW when every rung misses (rung 4)', () => {
    expect(resolveContextWindow('totally-unknown-model', null)).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(resolveMaxOutputTokens('totally-unknown-model', null)).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });

  it('returns DEFAULT when cache is empty even for a known model', () => {
    // Wipe the snapshot — registry hint exists but no data behind it.
    _resetMemCache();
    expect(resolveContextWindow('gpt-5', null)).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(resolveMaxOutputTokens('gpt-5', null)).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });
});

describe('listModels', () => {
  beforeEach(() => {
    _setMemCacheForTest(SNAPSHOT);
  });
  afterEach(() => {
    _resetMemCache();
  });

  it('should return all models with name property + resolved limits', () => {
    const models = listModels();
    expect(models.length).toBe(MODEL_REGISTRY.size);
    for (const m of models) {
      expect(m.name).toBeTruthy();
      expect(m.adapter).toBeTruthy();
      expect(m.baseUrl).toBeTruthy();
      // contextWindow / maxOutputTokens are now always present because
      // listModels() runs the resolver — worst case it returns DEFAULT.
      expect(m.contextWindow).toBeGreaterThan(0);
      expect(m.maxOutputTokens).toBeGreaterThan(0);
      expect(m.displayName).toBeTruthy();
    }
  });

  it('should reflect live models.dev values for models in the snapshot', () => {
    const models = listModels();
    const gpt5 = models.find(m => m.name === 'gpt-5');
    expect(gpt5.contextWindow).toBe(400_000);
    expect(gpt5.maxOutputTokens).toBe(128_000);
  });

  it('should include both Anthropic and OpenAI models', () => {
    const models = listModels();
    const adapters = new Set(models.map(m => m.adapter));
    expect(adapters.has('anthropic')).toBe(true);
    expect(adapters.has('openai-responses')).toBe(true);
  });
});

describe('isKnownModel', () => {
  it('should return true for known models', () => {
    expect(isKnownModel('gpt-5')).toBe(true);
    expect(isKnownModel('claude-sonnet-4-20250514')).toBe(true);
    expect(isKnownModel('deepseek-chat')).toBe(true);
  });

  it('should return false for unknown models', () => {
    expect(isKnownModel('nonexistent')).toBe(false);
    expect(isKnownModel('')).toBe(false);
  });
});

describe('MODEL_REGISTRY provider field', () => {
  it('should have provider field on all models', () => {
    for (const [, info] of MODEL_REGISTRY) {
      expect(info.provider).toBeTruthy();
      expect(['anthropic', 'openai', 'deepseek', 'google']).toContain(info.provider);
    }
  });

  it('should have provider=anthropic for Claude models', () => {
    expect(MODEL_REGISTRY.get('claude-sonnet-4-20250514').provider).toBe('anthropic');
    expect(MODEL_REGISTRY.get('claude-opus-4-20250514').provider).toBe('anthropic');
    expect(MODEL_REGISTRY.get('claude-haiku-3-20250414').provider).toBe('anthropic');
  });

  it('should have provider=openai for GPT models', () => {
    expect(MODEL_REGISTRY.get('gpt-5').provider).toBe('openai');
    expect(MODEL_REGISTRY.get('gpt-4.1').provider).toBe('openai');
    expect(MODEL_REGISTRY.get('o3').provider).toBe('openai');
  });

  it('should have provider=deepseek for DeepSeek models', () => {
    expect(MODEL_REGISTRY.get('deepseek-chat').provider).toBe('deepseek');
    expect(MODEL_REGISTRY.get('deepseek-reasoner').provider).toBe('deepseek');
  });

  it('should have provider=google for Gemini models', () => {
    expect(MODEL_REGISTRY.get('gemini-2.5-pro').provider).toBe('google');
    expect(MODEL_REGISTRY.get('gemini-2.5-flash').provider).toBe('google');
  });
});

describe('getProviderForModel', () => {
  it('should return provider for known models', () => {
    expect(getProviderForModel('gpt-5')).toBe('openai');
    expect(getProviderForModel('claude-sonnet-4-20250514')).toBe('anthropic');
    expect(getProviderForModel('deepseek-chat')).toBe('deepseek');
    expect(getProviderForModel('gemini-2.5-pro')).toBe('google');
  });

  it('should return null for unknown models', () => {
    expect(getProviderForModel('nonexistent')).toBeNull();
  });
});

describe('parseModelRef', () => {
  it('should parse provider/model format', () => {
    const result = parseModelRef('my-proxy/claude-sonnet-4-20250514');
    expect(result.providerName).toBe('my-proxy');
    expect(result.modelId).toBe('claude-sonnet-4-20250514');
  });

  it('should handle bare model ID (no provider)', () => {
    const result = parseModelRef('gpt-5');
    expect(result.providerName).toBeNull();
    expect(result.modelId).toBe('gpt-5');
  });

  it('should handle null/undefined', () => {
    expect(parseModelRef(null)).toEqual({ providerName: null, modelId: '' });
    expect(parseModelRef(undefined)).toEqual({ providerName: null, modelId: '' });
    expect(parseModelRef('')).toEqual({ providerName: null, modelId: '' });
  });

  it('should handle model IDs with multiple slashes', () => {
    const result = parseModelRef('org/models/v1');
    expect(result.providerName).toBe('org');
    expect(result.modelId).toBe('models/v1');
  });
});

describe('getModelInfo', () => {
  beforeEach(() => {
    _setMemCacheForTest(SNAPSHOT);
  });
  afterEach(() => {
    _resetMemCache();
  });

  it('should merge registry metadata with models.dev token limits', () => {
    const info = getModelInfo('gpt-5');
    expect(info).toBeDefined();
    expect(info.id).toBe('gpt-5');
    expect(info.provider).toBe('openai');
    expect(info.adapter).toBe('openai-responses');
    expect(info.contextWindow).toBe(400_000);
    expect(info.maxOutput).toBe(128_000);
  });

  it('should let providerConfig override beat models.dev', () => {
    const info = getModelInfo('gpt-5', { contextWindow: 50_000, maxOutput: 8_000 });
    expect(info.contextWindow).toBe(50_000);
    expect(info.maxOutput).toBe(8_000);
  });

  it('should return undefined for unknown model with no override + no snapshot data', () => {
    expect(getModelInfo('totally-unknown-model')).toBeUndefined();
  });

  it('should return registry-only info when the model is not in models.dev', () => {
    // gpt-5-mini is in MODEL_REGISTRY but not in our test snapshot.
    const info = getModelInfo('gpt-5-mini');
    expect(info).toBeDefined();
    expect(info.id).toBe('gpt-5-mini');
    expect(info.provider).toBe('openai');
    expect(info.contextWindow).toBeUndefined();
    expect(info.maxOutput).toBeUndefined();
  });
});
