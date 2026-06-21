import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { autoConfigureGitHubCopilotIfAvailable } from '../../agent/service/index.js';
import { readLocalLlmConfig, writeLocalLlmConfig } from '../../agent/llm-config-cli.js';

let tmp;
function yeaftDir() {
  tmp = mkdtempSync(join(tmpdir(), 'yeaft-service-copilot-'));
  return join(tmp, '.yeaft');
}

function liveGpt55Options() {
  return {
    getTokenFn: async () => ({ token: 'copilot-token' }),
    fetchFn: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [{ id: 'gpt-5.5' }] }),
    }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('service GitHub Copilot auto-config integration', () => {
  it('configures the target Yeaft directory with GitHub Copilot when credentials are available', async () => {
    const dir = yeaftDir();
    const configPath = join(dir, 'config.json');
    writeLocalLlmConfig({ language: 'zh' }, configPath);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await autoConfigureGitHubCopilotIfAvailable(dir, liveGpt55Options());

    expect(result.configured).toBe(true);
    expect(readLocalLlmConfig(configPath).primaryModel).toBe('github-copilot/gpt-5.5');
    expect(log).toHaveBeenCalledWith('Configured GitHub Copilot provider automatically with gpt-5.5.');
  });

  it('skips an existing user LLM config without discovering Copilot models', async () => {
    const dir = yeaftDir();
    const configPath = join(dir, 'config.json');
    writeLocalLlmConfig({
      providers: [{ name: 'proxy', baseUrl: 'http://proxy/v1', apiKey: 'k', models: ['m'] }],
      primaryModel: 'proxy/m',
    }, configPath);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await autoConfigureGitHubCopilotIfAvailable(dir, {
      getTokenFn: async () => { throw new Error('should not read credentials'); },
      fetchFn: async () => { throw new Error('should not fetch models'); },
    });

    expect(result).toMatchObject({ configured: false, reason: 'already-configured' });
    expect(readLocalLlmConfig(configPath).primaryModel).toBe('proxy/m');
    expect(log).toHaveBeenCalledWith('LLM config already exists; skipped automatic GitHub Copilot setup.');
  });

  it('allows the generated seed config to be replaced after install initialization', async () => {
    const dir = yeaftDir();
    const configPath = join(dir, 'config.json');
    writeLocalLlmConfig({
      providers: [{ name: 'my-proxy', baseUrl: 'http://localhost:6628/v1', apiKey: 'proxy', models: ['gpt-5'] }],
      primaryModel: 'my-proxy/gpt-5',
      fastModel: 'my-proxy/gpt-5',
    }, configPath);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await autoConfigureGitHubCopilotIfAvailable(dir, liveGpt55Options());

    expect(result.configured).toBe(true);
    expect(readLocalLlmConfig(configPath).primaryModel).toBe('github-copilot/gpt-5.5');
  });

  it('continues without writing config when credentials are missing', async () => {
    const dir = yeaftDir();
    const configPath = join(dir, 'config.json');
    writeLocalLlmConfig({}, configPath);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await autoConfigureGitHubCopilotIfAvailable(dir, {
      getTokenFn: async () => null,
    });

    expect(result).toMatchObject({ configured: false, reason: 'credential-missing' });
    expect(readLocalLlmConfig(configPath)).toEqual({});
  });

  it('continues without rewriting malformed config', async () => {
    const dir = yeaftDir();
    const configPath = join(dir, 'config.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, '{bad json', 'utf8');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await autoConfigureGitHubCopilotIfAvailable(dir, liveGpt55Options());

    expect(result).toMatchObject({ configured: false, reason: 'invalid-config' });
    expect(readFileSync(configPath, 'utf8')).toBe('{bad json');
    expect(log).toHaveBeenCalledWith('Existing LLM config is invalid; skipped automatic GitHub Copilot setup.');
  });
});
