import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../agent/yeaft/config.js';
import { loadSession } from '../../../agent/yeaft/session.js';
import { __testResolveVpEffectiveConfig, __testSetSession } from '../../../agent/yeaft/web-bridge.js';
import { loadSessionConfig, resolveSessionConfig, saveSessionConfig } from '../../../agent/yeaft/sessions/session-config.js';
import { createSession } from '../../../agent/yeaft/sessions/session-store.js';
import { registerSessionWorkDir, sessionsRoot } from '../../../agent/yeaft/sessions/session-crud.js';

const roots = [];

function tempRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function makeDir() {
  return tempRoot('yeaft-session-config-');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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

  it('prefers a registered workDir Session config over an agent-local stale Session directory', () => {
    const root = makeDir();
    const workDir = tempRoot('yeaft-session-config-workdir-');
    const sessionId = 'session-workdir-first';

    createSession(sessionsRoot(root), {
      id: sessionId,
      name: 'Stale agent-local session',
      roster: [],
      defaultVpId: null,
    }).close();
    createSession(sessionsRoot(join(workDir, '.yeaft')), {
      id: sessionId,
      name: 'Project session',
      roster: [],
      defaultVpId: null,
      workDir,
    }).close();
    registerSessionWorkDir(root, sessionId, workDir);

    saveSessionConfig(root, sessionId, { model: 'project/claude-sonnet', modelEffort: 'high' });
    writeFileSync(join(root, 'sessions', sessionId, 'config.json'), `${JSON.stringify({ model: 'agent/gpt-5', modelEffort: 'low' }, null, 2)}\n`);

    const config = loadSessionConfig(root, sessionId);

    expect(config).toEqual({ model: 'project/claude-sonnet', modelEffort: 'high' });
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

  it('uses the workDir-backed session root for VP engine model overrides', () => {
    const root = makeDir();
    const workDir = tempRoot('yeaft-session-config-workdir-');
    const projectYeaftDir = join(workDir, '.yeaft');
    const sessionId = 'session-workdir-engine';
    mkdirSync(join(root, 'sessions', sessionId), { recursive: true });
    mkdirSync(join(projectYeaftDir, 'sessions', sessionId), { recursive: true });
    writeFileSync(join(root, 'sessions', sessionId, 'config.json'), `${JSON.stringify({ model: 'agent/gpt-5', modelEffort: 'low' }, null, 2)}\n`);
    writeFileSync(join(projectYeaftDir, 'sessions', sessionId, 'config.json'), `${JSON.stringify({ model: 'project/claude-sonnet', modelEffort: 'high' }, null, 2)}\n`);

    try {
      __testSetSession({
        yeaftDir: projectYeaftDir,
        config: { model: 'agent/default', primaryModel: 'agent/default', modelEffort: 'medium' },
        conversationStore: { loadRecentBySession: () => [] },
      });
      const effective = __testResolveVpEffectiveConfig(sessionId);
      expect(effective.model).toBe('project/claude-sonnet');
      expect(effective.primaryModel).toBe('project/claude-sonnet');
      expect(effective.modelEffort).toBe('high');
    } finally {
      __testSetSession(null);
    }
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
