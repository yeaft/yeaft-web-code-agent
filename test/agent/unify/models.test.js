import { describe, it, expect } from 'vitest';
import {
  MODEL_REGISTRY,
  resolveModel,
  listModels,
  isKnownModel,
  getProviderForModel,
  parseModelRef,
} from '../../../agent/unify/models.js';

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

  it('should have correct adapter types', () => {
    for (const [name, info] of MODEL_REGISTRY) {
      expect(['anthropic', 'openai-responses']).toContain(info.adapter);
      expect(info.baseUrl).toBeTruthy();
      // gpt-5-{mini,nano,pro} intentionally omit context/output — their real limits
      // should come from provider config rather than unverified hardcoded values (task-284).
      if (!['gpt-5-mini', 'gpt-5-nano', 'gpt-5-pro'].includes(name)) {
        expect(info.contextWindow).toBeGreaterThan(0);
        expect(info.maxOutputTokens).toBeGreaterThan(0);
      }
      expect(info.displayName).toBeTruthy();
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
  it('should return ModelInfo for known models', () => {
    const info = resolveModel('gpt-5');
    expect(info).not.toBeNull();
    expect(info.adapter).toBe('openai-responses');
    expect(info.baseUrl).toBe('https://api.openai.com/v1');
    expect(info.contextWindow).toBe(256000);
    expect(info.displayName).toBe('GPT-5');
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
    expect(info.contextWindow).toBe(200000);
  });

  it('should resolve DeepSeek models correctly', () => {
    const info = resolveModel('deepseek-chat');
    expect(info.adapter).toBe('openai-responses');
    expect(info.baseUrl).toBe('https://api.deepseek.com');
    expect(info.contextWindow).toBe(131072);
  });

  it('should resolve Gemini models correctly', () => {
    const info = resolveModel('gemini-2.5-pro');
    expect(info.adapter).toBe('openai-responses');
    expect(info.baseUrl).toContain('googleapis.com');
    expect(info.contextWindow).toBe(1048576);
  });

  it('should return a copy, not a reference to the registry entry', () => {
    const info1 = resolveModel('gpt-5');
    const info2 = resolveModel('gpt-5');

    // Should be equal in value
    expect(info1).toEqual(info2);

    // But not the same object
    expect(info1).not.toBe(info2);

    // Mutating the copy should NOT affect the registry
    info1.contextWindow = 999;
    const info3 = resolveModel('gpt-5');
    expect(info3.contextWindow).toBe(256000); // original value unchanged
  });
});

describe('listModels', () => {
  it('should return all models with name property', () => {
    const models = listModels();
    expect(models.length).toBe(MODEL_REGISTRY.size);
    for (const m of models) {
      expect(m.name).toBeTruthy();
      expect(m.adapter).toBeTruthy();
      expect(m.baseUrl).toBeTruthy();
      // See note above — gpt-5-{mini,nano,pro} omit hardcoded ctx/max.
      if (!['gpt-5-mini', 'gpt-5-nano', 'gpt-5-pro'].includes(m.name)) {
        expect(m.contextWindow).toBeGreaterThan(0);
      }
      expect(m.displayName).toBeTruthy();
    }
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
    for (const [name, info] of MODEL_REGISTRY) {
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
