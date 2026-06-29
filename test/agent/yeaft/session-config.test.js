import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import ctx from '../../../agent/context.js';
import { loadConfig } from '../../../agent/yeaft/config.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { loadSession } from '../../../agent/yeaft/session.js';
import { __testGetOrCreateVpEngine, __testResolveVpEffectiveConfig, __testSetSession } from '../../../agent/yeaft/web-bridge.js';
import { loadSessionConfig, resolveSessionConfig, saveSessionConfig } from '../../../agent/yeaft/sessions/session-config.js';
import { createSession } from '../../../agent/yeaft/sessions/session-store.js';
import { registerSessionWorkDir, sessionsRoot, snapshotSessions, updateSessionConfig } from '../../../agent/yeaft/sessions/session-crud.js';

const roots = [];
const originalConfig = ctx.CONFIG;

function tempRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function makeDir() {
  return tempRoot('yeaft-session-config-');
}

function createRegisteredWorkDirSession(root, workDir, sessionId = 'session-workdir-config') {
  const projectYeaftDir = join(workDir, '.yeaft');
  createSession(sessionsRoot(root), {
    id: sessionId,
    name: 'Stale agent-local session',
    roster: [],
    defaultVpId: null,
  }).close();
  createSession(sessionsRoot(projectYeaftDir), {
    id: sessionId,
    name: 'Project session',
    roster: [],
    defaultVpId: null,
    workDir,
  }).close();
  registerSessionWorkDir(root, sessionId, workDir);
  return { projectYeaftDir, sessionId };
}

afterEach(() => {
  ctx.CONFIG = originalConfig;
  __testSetSession(null);
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

  it('prefers a registered workDir Session config over an agent-local stale Session directory during manifest bootstrap', () => {
    const root = makeDir();
    const workDir = tempRoot('yeaft-session-config-workdir-');
    const { projectYeaftDir, sessionId } = createRegisteredWorkDirSession(root, workDir, 'session-workdir-first');
    writeFileSync(join(root, 'sessions', sessionId, 'config.json'), `${JSON.stringify({ model: 'agent/gpt-5', modelEffort: 'low' }, null, 2)}\n`);
    writeFileSync(join(projectYeaftDir, 'sessions', sessionId, 'config.json'), `${JSON.stringify({ model: 'project/claude-sonnet', modelEffort: 'high' }, null, 2)}\n`);

    const config = loadSessionConfig(root, sessionId);

    expect(config).toEqual({ model: 'project/claude-sonnet', modelEffort: 'high' });
    expect(JSON.parse(readFileSync(join(root, 'sessions', sessionId, 'config.json'), 'utf8')))
      .toEqual({ model: 'project/claude-sonnet', modelEffort: 'high' });
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

  it('includes workDir-backed session config in snapshots', () => {
    const root = makeDir();
    const workDir = tempRoot('yeaft-session-config-workdir-');
    const { sessionId } = createRegisteredWorkDirSession(root, workDir, 'session-workdir-snapshot');
    writeFileSync(join(root, 'sessions', sessionId, 'config.json'), `${JSON.stringify({ model: 'agent/gpt-5', modelEffort: 'low' }, null, 2)}\n`);
    updateSessionConfig(root, sessionId, { model: 'project/claude-sonnet', modelEffort: 'high' });

    const row = snapshotSessions(root).find(s => s.id === sessionId);

    expect(row?.config).toEqual({ model: 'project/claude-sonnet', modelEffort: 'high' });
  });

  it('writes migrated workDir session config through the agent-local root resolver', () => {
    const root = makeDir();
    const workDir = tempRoot('yeaft-session-config-workdir-');
    const { sessionId } = createRegisteredWorkDirSession(root, workDir, 'session-workdir-update');
    writeFileSync(join(root, 'sessions', sessionId, 'config.json'), `${JSON.stringify({ model: 'agent/gpt-5', modelEffort: 'low' }, null, 2)}\n`);

    const saved = updateSessionConfig(root, sessionId, { model: 'project/claude-haiku', modelEffort: 'max' });

    expect(saved).toEqual({ model: 'project/claude-haiku', modelEffort: 'max' });
    expect(loadSessionConfig(root, sessionId)).toEqual({ model: 'project/claude-haiku', modelEffort: 'max' });
    expect(JSON.parse(readFileSync(join(root, 'sessions', sessionId, 'config.json'), 'utf8')))
      .toEqual({ model: 'project/claude-haiku', modelEffort: 'max' });
  });

  it('uses the agent-local root resolver for VP engine model overrides', () => {
    const root = makeDir();
    const workDir = tempRoot('yeaft-session-config-workdir-');
    const { projectYeaftDir, sessionId } = createRegisteredWorkDirSession(root, workDir, 'session-workdir-engine');
    writeFileSync(join(projectYeaftDir, 'sessions', sessionId, 'config.json'), `${JSON.stringify({ model: 'project/claude-sonnet', modelEffort: 'high' }, null, 2)}\n`);
    ctx.CONFIG = { yeaftDir: root };
    __testSetSession({
      yeaftDir: projectYeaftDir,
      config: { model: 'agent/default', primaryModel: 'agent/default', modelEffort: 'medium' },
      conversationStore: { loadRecentBySession: () => [] },
    });

    const effective = __testResolveVpEffectiveConfig(sessionId);

    expect(effective.model).toBe('project/claude-sonnet');
    expect(effective.primaryModel).toBe('project/claude-sonnet');
    expect(effective.modelEffort).toBe('high');
  });

  it('rebuilds a cached VP engine when the session model config changes on disk', () => {
    const root = makeDir();
    const sessionId = 'session-engine-refresh';
    mkdirSync(join(root, 'sessions', sessionId), { recursive: true });
    writeFileSync(join(root, 'sessions', sessionId, 'session.json'), `${JSON.stringify({ id: sessionId, name: 'Engine refresh', roster: ['vp-a'], defaultVpId: 'vp-a' }, null, 2)}\n`);
    ctx.CONFIG = { yeaftDir: root };
    __testSetSession({
      yeaftDir: root,
      adapter: { stream: async function* () {}, call: async () => ({ text: '', usage: {} }) },
      trace: new NullTrace(),
      config: { model: 'agent/default', primaryModel: 'agent/default', modelEffort: 'medium', dir: root },
      conversationStore: { loadRecentBySession: () => [], readCompactSummary: () => '' },
      memoryIndex: null,
      amsRegistry: null,
      toolRegistry: null,
      skillManager: null,
      mcpManager: null,
      taskManager: { renderActiveTasksForPrompt: () => '' },
      toolStats: null,
    });
    saveSessionConfig(root, sessionId, { model: 'project/claude-sonnet', modelEffort: 'high' });
    const first = __testGetOrCreateVpEngine(sessionId, 'vp-a', 'main');
    saveSessionConfig(root, sessionId, { model: 'project/gpt-5', modelEffort: 'max' });

    const second = __testGetOrCreateVpEngine(sessionId, 'vp-a', 'main');
    const effective = __testResolveVpEffectiveConfig(sessionId);

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect(effective.model).toBe('project/gpt-5');
    expect(effective.primaryModel).toBe('project/gpt-5');
    expect(effective.modelEffort).toBe('max');
  });

  it('keeps agent-local overrides available after a workDir-backed runtime booted first', () => {
    const root = makeDir();
    const workDir = tempRoot('yeaft-session-config-workdir-');
    const { projectYeaftDir } = createRegisteredWorkDirSession(root, workDir, 'session-workdir-first-runtime');
    const agentLocalSessionId = 'session-agent-local-after-workdir';
    createSession(sessionsRoot(root), {
      id: agentLocalSessionId,
      name: 'Agent-local session',
      roster: [],
      defaultVpId: null,
    }).close();
    saveSessionConfig(root, agentLocalSessionId, { model: 'agent/local-sonnet', modelEffort: 'minimal' });
    ctx.CONFIG = { yeaftDir: root };
    __testSetSession({
      yeaftDir: projectYeaftDir,
      config: { model: 'agent/default', primaryModel: 'agent/default', modelEffort: 'medium' },
      conversationStore: { loadRecentBySession: () => [] },
    });

    const effective = __testResolveVpEffectiveConfig(agentLocalSessionId);

    expect(effective.model).toBe('agent/local-sonnet');
    expect(effective.primaryModel).toBe('agent/local-sonnet');
    expect(effective.modelEffort).toBe('minimal');
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
