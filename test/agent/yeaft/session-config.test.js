import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../agent/yeaft/config.js';
import { loadSession } from '../../../agent/yeaft/session.js';
import { loadSessionConfig, resolveSessionConfig, saveSessionConfig } from '../../../agent/yeaft/sessions/session-config.js';

let dir = null;

function makeDir() {
  dir = mkdtempSync(join(tmpdir(), 'yeaft-session-config-'));
  return dir;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('Yeaft session-scoped model config', () => {
  it('keeps model and effort isolated per Session', () => {
    const root = makeDir();
    const userConfig = {
      model: 'proxy/gpt-5',
      primaryModel: 'proxy/gpt-5',
      modelEffort: 'medium',
      providers: [{ name: 'proxy', models: ['gpt-5', 'claude-opus-4.8'] }],
    };

    mkdirSync(join(root, 'sessions', 'session-a'), { recursive: true });
    mkdirSync(join(root, 'sessions', 'session-b'), { recursive: true });
    saveSessionConfig(root, 'session-a', { model: 'github-copilot/gpt-5.5', modelEffort: 'minimal' });
    saveSessionConfig(root, 'session-b', { model: 'github-copilot/claude-opus-4.8', modelEffort: 'max' });

    const configA = resolveSessionConfig(userConfig, loadSessionConfig(root, 'session-a'));
    const configB = resolveSessionConfig(userConfig, loadSessionConfig(root, 'session-b'));

    expect(configA.model).toBe('github-copilot/gpt-5.5');
    expect(configA.primaryModel).toBe('github-copilot/gpt-5.5');
    expect(configA.modelEffort).toBe('minimal');
    expect(configB.model).toBe('github-copilot/claude-opus-4.8');
    expect(configB.primaryModel).toBe('github-copilot/claude-opus-4.8');
    expect(configB.modelEffort).toBe('max');
  });

  it('falls back to agent default when Session has no model', () => {
    const root = makeDir();
    const userConfig = { model: 'proxy/gpt-5', primaryModel: 'proxy/gpt-5' };

    const effective = resolveSessionConfig(userConfig, loadSessionConfig(root, 'session-empty'));

    expect(effective.model).toBe('proxy/gpt-5');
    expect(effective.primaryModel).toBe('proxy/gpt-5');
  });

  it('uses the first available model as an effective default when primaryModel is absent', () => {
    const root = makeDir();
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      providers: [
        { name: 'github-copilot', baseUrl: 'https://api.githubcopilot.com', credentialProvider: 'github-copilot', models: ['gpt-5.5', 'claude-opus-4.8'] },
      ],
    }));

    const config = loadConfig({ dir: root });
    const effective = resolveSessionConfig(config, {});

    expect(config.primaryModel).toBe(null);
    expect(config.model).toBe('github-copilot/gpt-5.5');
    expect(effective.model).toBe('github-copilot/gpt-5.5');
  });

  it('loads runtime config from agent root while storing workDir session data under project .yeaft', async () => {
    const root = makeDir();
    const workDir = mkdtempSync(join(tmpdir(), 'yeaft-session-config-workdir-'));
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      providers: [
        { name: 'global-provider', baseUrl: 'http://global.example/v1', apiKey: 'test', protocol: 'openai-responses', models: ['gpt-5'] },
      ],
      primaryModel: 'global-provider/gpt-5',
      language: 'zh',
    }, null, 2));

    let session = null;
    try {
      session = await loadSession({ dir: root, workDir, skipMCP: true, skipSkills: true });
      expect(session.config.dir).toBe(root);
      expect(session.config.primaryModel).toBe('global-provider/gpt-5');
      expect(session.config.providers?.[0]?.name).toBe('global-provider');
      expect(session.yeaftDir).toBe(join(workDir, '.yeaft'));
      expect(session.skillManager.skillsDir).toBe(join(root, 'skills'));

      session.conversationStore.append({ role: 'user', content: 'workdir-backed message', sessionId: 'session_cfg' });
      const segmentPath = join(workDir, '.yeaft', 'sessions', 'session_cfg', 'conversation', 'segments', '000001.jsonl');
      expect(existsSync(segmentPath)).toBe(true);
      expect(readFileSync(segmentPath, 'utf8')).toContain('workdir-backed message');
    } finally {
      await session?.shutdown?.();
      rmSync(workDir, { recursive: true, force: true });
    }
  });

});
