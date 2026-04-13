import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { existsSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getLlmConfig, updateLlmConfig } from '../../../agent/unify/config-api.js';

const TEST_DIR = join(tmpdir(), `yeaft-test-config-api-${Date.now()}`);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

describe('getLlmConfig', () => {
  it('returns defaults when no config.json exists', () => {
    const config = getLlmConfig(TEST_DIR);
    expect(config.providers).toEqual([]);
    expect(config.primaryModel).toBeNull();
    expect(config.fastModel).toBeNull();
    expect(config.language).toBe('en');
    expect(config.needsSetup).toBe(true);
    expect(config.error).toBeUndefined();
  });

  it('reads providers and model selections from config.json', () => {
    writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({
      providers: [
        { name: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-123', models: ['gpt-5'] }
      ],
      primaryModel: 'openai/gpt-5',
      fastModel: 'openai/gpt-5',
      language: 'zh-CN',
      debug: true,
      maxContextTokens: 200000
    }));

    const config = getLlmConfig(TEST_DIR);
    expect(config.providers).toHaveLength(1);
    expect(config.providers[0].name).toBe('openai');
    expect(config.providers[0].apiKey).toBe('sk-123');
    expect(config.primaryModel).toBe('openai/gpt-5');
    expect(config.fastModel).toBe('openai/gpt-5');
    expect(config.language).toBe('zh-CN');
  });

  it('returns error on malformed JSON', () => {
    writeFileSync(join(TEST_DIR, 'config.json'), 'not json');
    const config = getLlmConfig(TEST_DIR);
    expect(config.error).toBeDefined();
    expect(config.error).toContain('Failed to read');
  });

  it('handles config with no providers field', () => {
    writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({
      language: 'en',
      debug: false
    }));
    const config = getLlmConfig(TEST_DIR);
    expect(config.providers).toEqual([]);
    expect(config.primaryModel).toBeNull();
    expect(config.needsSetup).toBe(true);
  });

  it('sets needsSetup=true when all providers have placeholder apiKey', () => {
    writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({
      providers: [
        { name: 'proxy', baseUrl: 'http://localhost:6628/v1', apiKey: 'proxy', models: ['gpt-5'] }
      ]
    }));
    const config = getLlmConfig(TEST_DIR);
    expect(config.needsSetup).toBe(true);
  });

  it('sets needsSetup=false when at least one provider has a real apiKey', () => {
    writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({
      providers: [
        { name: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-real-key', models: ['gpt-5'] }
      ]
    }));
    const config = getLlmConfig(TEST_DIR);
    expect(config.needsSetup).toBe(false);
  });
});

describe('updateLlmConfig', () => {
  it('creates config.json if it does not exist', () => {
    const result = updateLlmConfig({
      providers: [
        { name: 'test', baseUrl: 'http://localhost:8080/v1', apiKey: 'key', models: ['model-a'] }
      ],
      primaryModel: 'test/model-a'
    }, TEST_DIR);

    expect(result.error).toBeUndefined();
    expect(result.providers).toHaveLength(1);
    expect(result.primaryModel).toBe('test/model-a');

    // Verify file was written
    const raw = JSON.parse(readFileSync(join(TEST_DIR, 'config.json'), 'utf8'));
    expect(raw.providers[0].name).toBe('test');
    expect(raw.primaryModel).toBe('test/model-a');
  });

  it('preserves non-LLM fields when updating', () => {
    writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({
      providers: [{ name: 'old', baseUrl: 'http://old/v1', apiKey: 'k', models: ['m'] }],
      primaryModel: 'old/m',
      debug: true,
      maxContextTokens: 300000,
      messageTokenBudget: 16384
    }));

    const result = updateLlmConfig({
      providers: [
        { name: 'new', baseUrl: 'http://new/v1', apiKey: 'nk', models: ['n'] }
      ],
      primaryModel: 'new/n'
    }, TEST_DIR);

    expect(result.error).toBeUndefined();
    expect(result.providers[0].name).toBe('new');

    // Non-LLM fields preserved
    const raw = JSON.parse(readFileSync(join(TEST_DIR, 'config.json'), 'utf8'));
    expect(raw.debug).toBe(true);
    expect(raw.maxContextTokens).toBe(300000);
    expect(raw.messageTokenBudget).toBe(16384);
  });

  it('validates provider name is required', () => {
    const result = updateLlmConfig({
      providers: [{ baseUrl: 'http://x/v1', apiKey: 'k', models: ['m'] }]
    }, TEST_DIR);
    expect(result.error).toContain('must have a name');
  });

  it('validates provider baseUrl is required', () => {
    const result = updateLlmConfig({
      providers: [{ name: 'x', apiKey: 'k', models: ['m'] }]
    }, TEST_DIR);
    expect(result.error).toContain('must have a baseUrl');
  });

  it('validates provider must have at least one model', () => {
    const result = updateLlmConfig({
      providers: [{ name: 'x', baseUrl: 'http://x/v1', apiKey: 'k', models: [] }]
    }, TEST_DIR);
    expect(result.error).toContain('must have at least one model');
  });

  it('validates providers must be an array', () => {
    const result = updateLlmConfig({
      providers: 'not-array'
    }, TEST_DIR);
    expect(result.error).toContain('must be an array');
  });

  it('updates only primaryModel without touching providers', () => {
    writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({
      providers: [{ name: 'p', baseUrl: 'http://p/v1', apiKey: 'k', models: ['a', 'b'] }],
      primaryModel: 'p/a',
      fastModel: 'p/a'
    }));

    const result = updateLlmConfig({ primaryModel: 'p/b' }, TEST_DIR);
    expect(result.error).toBeUndefined();
    expect(result.primaryModel).toBe('p/b');
    expect(result.providers[0].name).toBe('p'); // unchanged
  });

  it('handles corrupt existing config.json by starting fresh', () => {
    writeFileSync(join(TEST_DIR, 'config.json'), 'corrupt!!!');

    const result = updateLlmConfig({
      providers: [
        { name: 'fresh', baseUrl: 'http://fresh/v1', apiKey: 'k', models: ['m'] }
      ]
    }, TEST_DIR);

    expect(result.error).toBeUndefined();
    expect(result.providers[0].name).toBe('fresh');
  });

  it('updates language field', () => {
    writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({ language: 'en' }));
    const result = updateLlmConfig({ language: 'zh-CN' }, TEST_DIR);
    expect(result.language).toBe('zh-CN');
  });
});
