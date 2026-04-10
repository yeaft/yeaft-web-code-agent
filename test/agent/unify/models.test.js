import { describe, it, expect } from 'vitest';
import {
  MODEL_REGISTRY,
  resolveModel,
  listModels,
  isKnownModel,
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
      expect(['anthropic', 'chat-completions']).toContain(info.adapter);
      expect(info.baseUrl).toBeTruthy();
      expect(info.contextWindow).toBeGreaterThan(0);
      expect(info.maxOutputTokens).toBeGreaterThan(0);
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

  it('should use "chat-completions" adapter for non-Claude models', () => {
    for (const [name, info] of MODEL_REGISTRY) {
      if (!name.startsWith('claude-')) {
        expect(info.adapter).toBe('chat-completions');
      }
    }
  });
});

describe('resolveModel', () => {
  it('should return ModelInfo for known models', () => {
    const info = resolveModel('gpt-5');
    expect(info).not.toBeNull();
    expect(info.adapter).toBe('chat-completions');
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
    expect(info.adapter).toBe('chat-completions');
    expect(info.baseUrl).toBe('https://api.deepseek.com');
    expect(info.contextWindow).toBe(131072);
  });

  it('should resolve Gemini models correctly', () => {
    const info = resolveModel('gemini-2.5-pro');
    expect(info.adapter).toBe('chat-completions');
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
      expect(m.contextWindow).toBeGreaterThan(0);
      expect(m.displayName).toBeTruthy();
    }
  });

  it('should include both Anthropic and OpenAI models', () => {
    const models = listModels();
    const adapters = new Set(models.map(m => m.adapter));
    expect(adapters.has('anthropic')).toBe(true);
    expect(adapters.has('chat-completions')).toBe(true);
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
