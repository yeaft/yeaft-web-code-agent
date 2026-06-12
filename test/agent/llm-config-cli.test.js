import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addOrUpdateProvider,
  formatLlmConfig,
  readLocalLlmConfig,
  removeProvider,
  setLocalModels,
  writeLocalLlmConfig,
} from '../../agent/llm-config-cli.js';

let tmp;
function configPath() {
  tmp = mkdtempSync(join(tmpdir(), 'yeaft-llm-cli-'));
  return join(tmp, '.yeaft', 'config.json');
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('yeaft-agent local LLM config helpers', () => {
  it('adds a provider and sets primary/fast model refs with implicit provider prefix', () => {
    const result = addOrUpdateProvider({}, {
      name: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      models: 'gpt-5,gpt-4.1',
      apiKey: 'sk-test',
      protocol: 'openai-responses',
      setPrimary: 'gpt-5',
      setFast: 'openai/gpt-4.1',
    });

    expect(result.replaced).toBe(false);
    expect(result.config.providers).toEqual([
      {
        name: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        models: ['gpt-5', 'gpt-4.1'],
        protocol: 'openai-responses',
        apiKey: 'sk-test',
      }
    ]);
    expect(result.config.primaryModel).toBe('openai/gpt-5');
    expect(result.config.fastModel).toBe('openai/gpt-4.1');
  });

  it('updates an existing provider while preserving unrelated config fields', () => {
    const existing = {
      debug: true,
      maxContextTokens: 123,
      providers: [
        { name: 'old', baseUrl: 'http://old/v1', apiKey: 'old-key', models: ['old-model'] },
        { name: 'keep', baseUrl: 'http://keep/v1', apiKey: 'keep-key', models: ['keep-model'] },
      ]
    };

    const result = addOrUpdateProvider(existing, {
      name: 'old',
      baseUrl: 'http://new/v1',
      models: 'new-model',
      apiKey: 'new-key',
    });

    expect(result.replaced).toBe(true);
    expect(result.config.debug).toBe(true);
    expect(result.config.maxContextTokens).toBe(123);
    expect(result.config.providers.map(p => p.name)).toEqual(['old', 'keep']);
    expect(result.config.providers[0]).toMatchObject({ baseUrl: 'http://new/v1', apiKey: 'new-key', models: ['new-model'] });
  });

  it('sets primary and fast models with full refs only', () => {
    const result = setLocalModels({ providers: [] }, {
      primary: 'openai/gpt-5',
      fast: 'openai/gpt-4.1',
    });

    expect(result.config.primaryModel).toBe('openai/gpt-5');
    expect(result.config.fastModel).toBe('openai/gpt-4.1');
    expect(() => setLocalModels({}, { primary: 'gpt-5' })).toThrow(/provider\/model/);
  });

  it('removes a provider and clears primary/fast refs pointing at it', () => {
    const result = removeProvider({
      providers: [
        { name: 'openai', baseUrl: 'https://api.openai.com/v1', models: ['gpt-5'] },
        { name: 'other', baseUrl: 'http://other/v1', models: ['m'] },
      ],
      primaryModel: 'openai/gpt-5',
      fastModel: 'other/m',
    }, { name: 'openai' });

    expect(result.removed).toBe(true);
    expect(result.cleared).toEqual(['primaryModel']);
    expect(result.config.providers.map(p => p.name)).toEqual(['other']);
    expect(result.config.primaryModel).toBeUndefined();
    expect(result.config.fastModel).toBe('other/m');
  });

  it('masks API keys by default and reveals only when requested', () => {
    const config = {
      providers: [{ name: 'p', baseUrl: 'http://p/v1', apiKey: 'abcd1234SECRET', models: ['m'] }],
    };

    expect(formatLlmConfig(config)).toContain('apiKey: abcd…CRET');
    expect(formatLlmConfig(config)).not.toContain('abcd1234SECRET');
    expect(formatLlmConfig(config, { reveal: true })).toContain('apiKey: abcd1234SECRET');
  });

  it('reads --api-key-env values and never writes the env var name as apiKey', () => {
    const result = addOrUpdateProvider({}, {
      name: 'envp',
      baseUrl: 'http://env/v1',
      models: 'm',
      apiKeyEnv: 'LLM_KEY',
    }, { LLM_KEY: 'secret-value' });

    expect(result.config.providers[0].apiKey).toBe('secret-value');
    expect(() => addOrUpdateProvider({}, {
      name: 'envp', baseUrl: 'http://env/v1', models: 'm', apiKeyEnv: 'MISSING'
    }, {})).toThrow(/MISSING/);
  });

  it('rejects credentialProvider mixed with apiKey credentials', () => {
    expect(() => addOrUpdateProvider({}, {
      name: 'copilot',
      baseUrl: 'https://api.githubcopilot.com',
      models: 'gpt-5',
      credentialProvider: 'github-copilot',
      apiKey: 'secret',
    })).toThrow(/mutually exclusive/);
  });

  it('writes and reads config from an injected path', () => {
    const path = configPath();
    writeLocalLlmConfig({ providers: [{ name: 'p', baseUrl: 'http://p/v1', models: ['m'] }], debug: true }, path);

    expect(JSON.parse(readFileSync(path, 'utf8')).debug).toBe(true);
    expect(readLocalLlmConfig(path).providers[0].name).toBe('p');
  });

  it('preserves unknown fields during explicit write of mutated config', () => {
    const path = configPath();
    mkdirSync(join(tmp, '.yeaft'), { recursive: true });
    writeFileSync(path, JSON.stringify({ custom: { keep: true }, providers: [] }), 'utf8');
    const current = readLocalLlmConfig(path);
    const result = addOrUpdateProvider(current, {
      name: 'p', baseUrl: 'http://p/v1', models: 'm', apiKey: 'k'
    });
    writeLocalLlmConfig(result.config, path);

    const persisted = readLocalLlmConfig(path);
    expect(persisted.custom).toEqual({ keep: true });
    expect(persisted.providers[0].name).toBe('p');
  });
});
