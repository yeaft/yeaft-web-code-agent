import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import ctx from '../../../agent/context.js';
import { loadConfig } from '../../../agent/yeaft/config.js';
import { getPluginConfig, updatePluginConfig } from '../../../agent/yeaft/config-api.js';
import { flushAllAgentPerfTraces } from '../../../agent/yeaft/perf-trace.js';
import { closeConversationHistoryIndexes } from '../../../agent/yeaft/conversation/history-index.js';
import { __testResetVpState, __testSetSession, handleYeaftManagedSkill } from '../../../agent/yeaft/web-bridge.js';
import { _resetAgentRegistry } from '../../../agent/yeaft/tools/agent.js';
import { loadSessionConfig, resolveSessionConfig, saveSessionConfig } from '../../../agent/yeaft/sessions/session-config.js';
import { createSession } from '../../../agent/yeaft/sessions/session-store.js';
import { sessionsRoot } from '../../../agent/yeaft/sessions/session-crud.js';

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

afterEach(async () => {
  flushAllAgentPerfTraces();
  await __testResetVpState();
  await closeConversationHistoryIndexes();
  ctx.CONFIG = originalConfig;
  __testSetSession(null);
  _resetAgentRegistry();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
});

describe('Yeaft managed Skill protocol', () => {
  it('rejects traversal and missing Session ids before any project Skill filesystem access', () => {
    const root = makeDir();
    const externalProject = tempRoot('yeaft-managed-skill-external-project-');
    // This is deliberately outside `sessionsRoot(root)`. The old traversal
    // would resolve `sessions/../external-session/session.json` and trust it.
    createSession(root, {
      id: 'external-session',
      name: 'External session metadata',
      roster: [],
      defaultVpId: null,
      workDir: externalProject,
    }).close();
    const originalWs = ctx.ws;
    const originalEncryption = ctx.serverEncryptionRequired;
    const originalBuffer = ctx.messageBuffer;
    const originalQueue = ctx.outboundSendQueue;
    const originalQueueActive = ctx.outboundSendQueueActive;
    ctx.messageBuffer = [];
    ctx.outboundSendQueue = [];
    ctx.outboundSendQueueActive = true;
    ctx.CONFIG = { ...(originalConfig || {}), yeaftDir: root };
    ctx.ws = { readyState: 1, send() {} };
    ctx.serverEncryptionRequired = false;
    __testSetSession({ yeaftDir: root, config: {}, skillManager: null, mcpManager: null, toolRegistry: null });

    try {
      for (const [requestId, sessionId] of [
        ['project-traversal-forward', '../external-session'],
        ['project-traversal-backslash', '..\\external-session'],
        ['project-missing', 'session_missing'],
      ]) {
        handleYeaftManagedSkill({
          requestId,
          action: 'create',
          scope: 'project',
          sessionId,
          skill: { name: `escaped-${requestId}`, description: 'Must not write outside a Session', content: 'Reject invalid Session ids.' },
        });
      }

      const responses = ctx.outboundSendQueue.map(item => item.msg)
        .filter(frame => frame.type === 'yeaft_managed_skill_result');
      expect(responses).toEqual([
        expect.objectContaining({ requestId: 'project-traversal-forward', error: 'invalid Session id' }),
        expect.objectContaining({ requestId: 'project-traversal-backslash', error: 'invalid Session id' }),
        expect.objectContaining({ requestId: 'project-missing', error: 'the selected Session was not found' }),
      ]);
      expect(existsSync(join(externalProject, '.yeaft', 'skills', 'escaped-project-traversal-forward.md'))).toBe(false);
      expect(existsSync(join(externalProject, '.yeaft', 'skills', 'escaped-project-traversal-backslash.md'))).toBe(false);
      expect(existsSync(join(root, '.yeaft', 'skills', 'escaped-project-missing.md'))).toBe(false);
    } finally {
      ctx.ws = originalWs;
      ctx.serverEncryptionRequired = originalEncryption;
      ctx.messageBuffer = originalBuffer;
      ctx.outboundSendQueue = originalQueue;
      ctx.outboundSendQueueActive = originalQueueActive;
    }
  });

  it('rejects a symlinked agent-local sessions root before project Skill create or remove', () => {
    const root = makeDir();
    const externalSessionRoot = tempRoot('yeaft-managed-skill-external-sessions-root-');
    const externalWorkDir = tempRoot('yeaft-managed-skill-external-sessions-workdir-');
    const sessionId = 'session_parent_link';
    createSession(sessionsRoot(externalSessionRoot), {
      id: sessionId,
      name: 'External parent-link metadata',
      roster: [],
      defaultVpId: null,
      workDir: externalWorkDir,
    }).close();
    const externalSkillPath = join(externalWorkDir, '.yeaft', 'skills', 'parent-link.md');
    mkdirSync(dirname(externalSkillPath), { recursive: true });
    writeFileSync(externalSkillPath, 'external Skill must survive', 'utf8');
    try {
      symlinkSync(sessionsRoot(externalSessionRoot), sessionsRoot(root), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) return;
      throw error;
    }
    const originalWs = ctx.ws;
    const originalEncryption = ctx.serverEncryptionRequired;
    const originalBuffer = ctx.messageBuffer;
    const originalQueue = ctx.outboundSendQueue;
    const originalQueueActive = ctx.outboundSendQueueActive;
    ctx.messageBuffer = [];
    ctx.outboundSendQueue = [];
    ctx.outboundSendQueueActive = true;
    ctx.CONFIG = { ...(originalConfig || {}), yeaftDir: root };
    ctx.ws = { readyState: 1, send() {} };
    ctx.serverEncryptionRequired = false;
    __testSetSession({ yeaftDir: root, config: {}, skillManager: null, mcpManager: null, toolRegistry: null });

    try {
      handleYeaftManagedSkill({
        requestId: 'parent-link-create', action: 'create', scope: 'project', sessionId,
        skill: { name: 'parent-link', description: 'Must not follow linked session roots', content: 'Reject parent links.' },
      });
      expect(readFileSync(externalSkillPath, 'utf8')).toBe('external Skill must survive');
      handleYeaftManagedSkill({
        requestId: 'parent-link-remove', action: 'remove', scope: 'project', sessionId, name: 'parent-link',
      });
      expect(readFileSync(externalSkillPath, 'utf8')).toBe('external Skill must survive');
      const responses = ctx.outboundSendQueue.map(item => item.msg)
        .filter(frame => frame.type === 'yeaft_managed_skill_result');
      expect(responses).toEqual([
        expect.objectContaining({ requestId: 'parent-link-create', error: 'the selected Session was not found' }),
        expect.objectContaining({ requestId: 'parent-link-remove', error: 'the selected Session was not found' }),
      ]);
    } finally {
      ctx.ws = originalWs;
      ctx.serverEncryptionRequired = originalEncryption;
      ctx.messageBuffer = originalBuffer;
      ctx.outboundSendQueue = originalQueue;
      ctx.outboundSendQueueActive = originalQueueActive;
    }
  });
});

describe('Yeaft session-scoped model config', () => {
  it('fails closed for an invalid config.json root and preserves every bad file', () => {
    const root = makeDir();
    const configPath = join(root, 'config.json');
    for (const invalidRoot of ['{"plugins":{"tools":["FileRead"]}', '[]']) {
      writeFileSync(configPath, invalidRoot);

      expect(loadConfig({ dir: root })).toMatchObject({
        plugins: { tools: [], skills: [], mcpServers: [] },
        pluginConfigError: expect.stringContaining('config.json is invalid'),
      });
      expect(getPluginConfig(root)).toMatchObject({ error: expect.stringContaining('Failed to read plugin config') });
      expect(updatePluginConfig({ tools: ['Bash'] }, root)).toMatchObject({
        error: expect.stringContaining('Failed to read plugin config'),
      });
      expect(readFileSync(configPath, 'utf8')).toBe(invalidRoot);
    }
  });

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
    saveSessionConfig(root, 'session-a', { model: 'github-copilot/gpt-5.5', modelEffort: 'ultra' });
    saveSessionConfig(root, 'session-b', { model: 'github-copilot/claude-opus-4.8', modelEffort: 'max' });

    const configA = resolveSessionConfig(userConfig, loadSessionConfig(root, 'session-a'));
    const configB = resolveSessionConfig(userConfig, loadSessionConfig(root, 'session-b'));

    expect(configA.model).toBe('github-copilot/gpt-5.5');
    expect(configA.primaryModel).toBe('github-copilot/gpt-5.5');
    expect(configA.modelEffort).toBe('ultra');
    expect(configB.model).toBe('github-copilot/claude-opus-4.8');
    expect(configB.primaryModel).toBe('github-copilot/claude-opus-4.8');
    expect(configB.modelEffort).toBe('max');
  });
});
