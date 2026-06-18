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
  useGitHubCopilot,
  useOpenAICompatible,
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

  it('uses GitHub Copilot preset with discovered models without writing an API key', async () => {
    const result = await useGitHubCopilot({ debug: true }, {
      model: 'claude-sonnet-4.5',
      fast: 'gpt-5',
      getTokenFn: async () => ({ token: 'copilot-token' }),
      fetchFn: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [{ id: 'claude-sonnet-4.5' }, { id: 'gpt-5' }] }),
      }),
    });

    expect(result.config.debug).toBe(true);
    expect(result.config.primaryModel).toBe('github-copilot/claude-sonnet-4.5');
    expect(result.config.fastModel).toBe('github-copilot/gpt-5');
    expect(result.provider).toMatchObject({
      name: 'github-copilot',
      baseUrl: 'https://api.githubcopilot.com',
      credentialProvider: 'github-copilot',
      managed: 'github-copilot',
    });
    expect(result.provider.protocol).toBeUndefined();
    expect(result.provider.apiKey).toBeUndefined();
    expect(result.provider.models).toBeUndefined();
  });

  it('clears stale fast model when GitHub Copilot is used without --fast', async () => {
    const result = await useGitHubCopilot({
      primaryModel: 'my-proxy/claude-sonnet-4',
      fastModel: 'my-proxy/claude-haiku-3',
    }, {
      model: 'gpt-5.5',
      getTokenFn: async () => ({ token: 'copilot-token' }),
      fetchFn: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [{ id: 'gpt-5.5' }] }),
      }),
    });

    expect(result.config.primaryModel).toBe('github-copilot/gpt-5.5');
    expect(result.config.fastModel).toBeUndefined();
  });

  it('rejects unknown GitHub Copilot model unless explicitly allowed', async () => {
    const discovery = {
      getTokenFn: async () => ({ token: 'copilot-token' }),
      fetchFn: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [{ id: 'gpt-5' }] }),
      }),
    };

    await expect(useGitHubCopilot({}, { model: 'missing-model', ...discovery })).rejects.toThrow('was not found');
    const allowed = await useGitHubCopilot({}, { model: 'missing-model', allowUnknownModel: true, ...discovery });
    expect(allowed.config.primaryModel).toBe('github-copilot/missing-model');
    expect(allowed.provider.models).toBeUndefined();
  });



  it('uses OpenAI-compatible preset by discovering /models', async () => {
    const result = await useOpenAICompatible({}, {
      name: 'proxy',
      baseUrl: 'https://proxy.example/v1',
      apiKeyEnv: 'PROXY_KEY',
      model: 'gpt-5',
      fetchFn: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [{ id: 'gpt-5' }] }),
      }),
    }, { PROXY_KEY: 'sk-proxy' });

    expect(result.config.primaryModel).toBe('proxy/gpt-5');
    expect(result.provider).toMatchObject({
      name: 'proxy',
      baseUrl: 'https://proxy.example/v1',
      apiKey: 'sk-proxy',
      protocol: 'openai-responses',
      models: ['gpt-5'],
    });
  });

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
