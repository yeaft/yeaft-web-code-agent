import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ctx from '../../../agent/context.js';
import { loadConfig, loadMCPConfig, normalizeLlmRetry, normaliseTelemetrySection } from '../../../agent/yeaft/config.js';
import { readLocalLlmConfig, writeLocalLlmConfig } from '../../../agent/llm-config-cli.js';
import {
  getPluginConfig,
  getTelemetrySettings,
  listMcpServers,
  removeMcpServer,
  updateLlmConfig,
  updatePluginConfig,
  updateSearchSettings,
  updateTelemetrySettings,
  updateYeaftSettings,
  upsertMcpServer,
} from '../../../agent/yeaft/config-api.js';
import { handleMessage } from '../../../agent/connection/message-router.js';
import { flushAllAgentPerfTraces } from '../../../agent/yeaft/perf-trace.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { closeConversationHistoryIndexes } from '../../../agent/yeaft/conversation/history-index.js';
import {
  estimateTokens,
  compressDreamMessages,
  selectDreamNewMessages,
  boundDreamPrompt,
  batchSourcesForApply,
} from '../../../agent/yeaft/dream/segment.js';
import { buildPluginCatalog, createPluginSkillManager } from '../../../agent/yeaft/plugins.js';
import { loadSession } from '../../../agent/yeaft/session.js';
import { MCPManager } from '../../../agent/yeaft/mcp.js';
import { __testGetOrCreateVpEngine, __testHooks, __testLoadPluginCatalogMcpConfig, __testResetVpState, __testResolveVpEffectiveConfig, __testSetSession, handleYeaftCreateSession, handleYeaftLoadHistoryOutline, handleYeaftManagedSkill, handleYeaftSubAgentPrompt, handleYeaftTaskCancel, handleYeaftUpdateSessionConfig, handleYeaftVpSubscribe, refreshLiveSessionConfig } from '../../../agent/yeaft/web-bridge.js';
import { _resetAgentRegistry, getAgentRegistry } from '../../../agent/yeaft/tools/agent.js';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';
import { defineTool } from '../../../agent/yeaft/tools/types.js';
import { loadSessionConfig, normalizeSessionConfig, resolveSessionConfig, saveSessionConfig } from '../../../agent/yeaft/sessions/session-config.js';
import { createSession } from '../../../agent/yeaft/sessions/session-store.js';
import { isMultiVpEnabled, setMultiVpEnabled } from '../../../agent/yeaft/sessions/feature-flag.js';
import { DEFAULT_VPS } from '../../../agent/yeaft/vp/seed-defaults.js';
import { registerSessionWorkDir, renameSession, sessionsRoot, snapshotSessions, updateSessionConfig } from '../../../agent/yeaft/sessions/session-crud.js';
import {
  createProject,
  deleteProject,
  loadProjects,
  moveSessionToProject,
  removeSessionFromProjects,
  renameProject,
  reorderProjects,
  sharedSessionIdsForProject,
  updateProjectInstruction,
} from '../../../agent/yeaft/projects/store.js';

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

function createProjectSessionArtifact(root, workDir, sessionId = 'session-workdir-config') {
  const projectYeaftDir = join(workDir, '.yeaft');
  createSession(sessionsRoot(root), {
    id: sessionId,
    name: 'Stale agent-local session',
    roster: [],
    defaultVpId: null,
  }).close();
  createSession(sessionsRoot(projectYeaftDir), {
    id: sessionId,
    name: 'Ignored project session artifact',
    roster: [],
    defaultVpId: null,
    workDir,
  }).close();
  registerSessionWorkDir(root, sessionId, workDir);
  return { projectYeaftDir, sessionId };
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


describe('Yeaft Session context lifetime', () => {
  it('releases settled route-promise message keys', async () => {
    const pending = Promise.resolve('done');
    __testHooks.registerRoutePromiseForTest('route-msg-lifetime', pending);
    expect(__testHooks.routePromiseEntryCountForTest()).toBe(1);

    await pending;
    await Promise.resolve();

    expect(__testHooks.routePromiseEntryCountForTest()).toBe(0);
  });

  it('closes a newly opened handle when the cached coordinator already owns one', () => {
    const sessionId = 'session-handle-lifetime';
    const first = { getMeta: () => ({ id: sessionId, roster: [] }), close: vi.fn() };
    const unused = { getMeta: () => ({ id: sessionId, roster: [] }), close: vi.fn() };

    const cached = __testHooks.getOrCreateSessionContextForTest(sessionId, first);
    const reused = __testHooks.getOrCreateSessionContextForTest(sessionId, unused);

    expect(reused).toBe(cached);
    expect(first.close).not.toHaveBeenCalled();
    expect(unused.close).toHaveBeenCalledTimes(1);
    __testHooks.clearSessionContextForTest(sessionId);
    expect(first.close).toHaveBeenCalledTimes(1);
  });
});

describe('Yeaft managed Skill protocol', () => {
  it('writes user and Session-resolved project Skills without trusting a browser workDir', () => {
    const root = makeDir();
    const workDir = tempRoot('yeaft-managed-skill-project-');
    const sessionId = 'session_managed_skill';
    createSession(sessionsRoot(root), {
      id: sessionId,
      name: 'Managed Skill Project',
      roster: [],
      defaultVpId: null,
      workDir,
    }).close();
    const originalWs = ctx.ws;
    const originalEncryption = ctx.serverEncryptionRequired;
    const originalBuffer = ctx.messageBuffer;
    ctx.messageBuffer = [];
    ctx.outboundSendQueue = [];
    ctx.outboundSendQueueActive = true;
    ctx.CONFIG = { ...(originalConfig || {}), yeaftDir: root };
    ctx.ws = { readyState: 1, send() {} };
    ctx.serverEncryptionRequired = false;
    __testSetSession({ yeaftDir: root, config: {}, skillManager: null, mcpManager: null, toolRegistry: null });

    try {
      handleYeaftManagedSkill({
        requestId: 'user-create', action: 'create', scope: 'user',
        skill: { name: 'user-check', description: 'User check', content: 'Check every repository.' },
      });
      handleYeaftManagedSkill({
        requestId: 'project-create', action: 'create', scope: 'project', sessionId,
        workDir: join(root, 'must-not-be-used'),
        skill: { name: 'project-check', description: 'Project check', content: 'Check this repository only.' },
      });

      expect(readFileSync(join(root, 'skills', 'user-check.md'), 'utf8')).toContain('name: user-check');
      expect(readFileSync(join(workDir, '.yeaft', 'skills', 'project-check.md'), 'utf8')).toContain('name: project-check');
      const responses = ctx.outboundSendQueue.map(item => item.msg)
        .filter(frame => frame.type === 'yeaft_managed_skill_result');
      expect(responses).toEqual([
        expect.objectContaining({ requestId: 'user-create', error: null, scope: 'user', catalog: expect.objectContaining({ skillSources: expect.any(Array) }) }),
        expect.objectContaining({ requestId: 'project-create', error: null, scope: 'project', sessionId, catalog: expect.objectContaining({ skillSources: expect.any(Array) }) }),
      ]);

      handleYeaftManagedSkill({
        requestId: 'project-remove', action: 'remove', scope: 'project', sessionId, name: 'project-check',
      });
      expect(existsSync(join(workDir, '.yeaft', 'skills', 'project-check.md'))).toBe(false);
    } finally {
      ctx.ws = originalWs;
      ctx.serverEncryptionRequired = originalEncryption;
      ctx.messageBuffer = originalBuffer;
    }
  });

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

  it('rejects legacy-only registry metadata for project Skill create and remove', () => {
    const root = makeDir();
    const registeredProject = tempRoot('yeaft-managed-skill-registered-project-');
    const externalTarget = tempRoot('yeaft-managed-skill-external-target-');
    const sessionId = 'session_legacy_fallback';
    const legacySessionRoot = join(registeredProject, '.yeaft');
    createSession(sessionsRoot(legacySessionRoot), {
      id: sessionId,
      name: 'Legacy project-only metadata',
      roster: [],
      defaultVpId: null,
      workDir: externalTarget,
    }).close();
    registerSessionWorkDir(root, sessionId, registeredProject);
    const externalSkillPath = join(externalTarget, '.yeaft', 'skills', 'legacy-escape.md');
    mkdirSync(join(externalTarget, '.yeaft', 'skills'), { recursive: true });
    writeFileSync(externalSkillPath, 'legacy target must be preserved', 'utf8');

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
        requestId: 'legacy-only-create', action: 'create', scope: 'project', sessionId,
        skill: { name: 'legacy-escape', description: 'Must not be written', content: 'Reject legacy-only metadata.' },
      });
      expect(readFileSync(externalSkillPath, 'utf8')).toBe('legacy target must be preserved');

      handleYeaftManagedSkill({
        requestId: 'legacy-only-remove', action: 'remove', scope: 'project', sessionId, name: 'legacy-escape',
      });
      expect(readFileSync(externalSkillPath, 'utf8')).toBe('legacy target must be preserved');

      const responses = ctx.outboundSendQueue.map(item => item.msg)
        .filter(frame => frame.type === 'yeaft_managed_skill_result');
      expect(responses).toEqual([
        expect.objectContaining({ requestId: 'legacy-only-create', error: 'the selected Session was not found' }),
        expect.objectContaining({ requestId: 'legacy-only-remove', error: 'the selected Session was not found' }),
      ]);
      expect(readFileSync(externalSkillPath, 'utf8')).toBe('legacy target must be preserved');
      expect(existsSync(join(root, 'sessions', sessionId))).toBe(false);
    } finally {
      ctx.ws = originalWs;
      ctx.serverEncryptionRequired = originalEncryption;
      ctx.messageBuffer = originalBuffer;
      ctx.outboundSendQueue = originalQueue;
      ctx.outboundSendQueueActive = originalQueueActive;
    }
  });

  it('requires canonical agent-local session.json rather than a local group.json alias', () => {
    const root = makeDir();
    const workDir = tempRoot('yeaft-managed-skill-local-group-json-');
    const sessionId = 'session_local_group_json';
    const sessionDir = join(sessionsRoot(root), sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'group.json'), JSON.stringify({
      id: sessionId,
      name: 'Legacy local metadata',
      roster: [],
      defaultVpId: null,
      workDir,
    }), 'utf8');
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
        requestId: 'local-group-json-create', action: 'create', scope: 'project', sessionId,
        skill: { name: 'local-group-json', description: 'Must not trust compatibility metadata', content: 'Reject read-only aliases.' },
      });
      expect(ctx.outboundSendQueue.at(-1)?.msg).toMatchObject({
        requestId: 'local-group-json-create',
        error: 'the selected Session was not found',
      });
      expect(existsSync(join(workDir, '.yeaft', 'skills', 'local-group-json.md'))).toBe(false);
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

  it('rejects symlinked agent-local Session metadata before project Skill writes', () => {
    const root = makeDir();
    const externalSessionRoot = tempRoot('yeaft-managed-skill-external-session-');
    const externalWorkDir = tempRoot('yeaft-managed-skill-external-workdir-');
    const sessionId = 'session_symlinked_metadata';
    createSession(sessionsRoot(externalSessionRoot), {
      id: sessionId,
      name: 'External metadata',
      roster: [],
      defaultVpId: null,
      workDir: externalWorkDir,
    }).close();
    const linkedSessionDir = join(sessionsRoot(root), sessionId);
    mkdirSync(sessionsRoot(root), { recursive: true });
    try {
      symlinkSync(join(sessionsRoot(externalSessionRoot), sessionId), linkedSessionDir, process.platform === 'win32' ? 'junction' : 'dir');
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
        requestId: 'symlinked-session-create', action: 'create', scope: 'project', sessionId,
        skill: { name: 'symlinked-session', description: 'Must not trust linked Session metadata', content: 'Reject linked metadata.' },
      });
      expect(ctx.outboundSendQueue.at(-1)?.msg).toMatchObject({
        requestId: 'symlinked-session-create',
        error: 'the selected Session was not found',
      });
      expect(existsSync(join(externalWorkDir, '.yeaft', 'skills', 'symlinked-session.md'))).toBe(false);
    } finally {
      ctx.ws = originalWs;
      ctx.serverEncryptionRequired = originalEncryption;
      ctx.messageBuffer = originalBuffer;
      ctx.outboundSendQueue = originalQueue;
      ctx.outboundSendQueueActive = originalQueueActive;
    }
  });

  it('rejects a symlinked canonical session.json before project Skill writes', () => {
    const root = makeDir();
    const externalSessionRoot = tempRoot('yeaft-managed-skill-external-meta-');
    const externalWorkDir = tempRoot('yeaft-managed-skill-external-meta-workdir-');
    const sessionId = 'session_symlinked_session_json';
    createSession(sessionsRoot(externalSessionRoot), {
      id: sessionId,
      name: 'External canonical metadata',
      roster: [],
      defaultVpId: null,
      workDir: externalWorkDir,
    }).close();
    const sessionDir = join(sessionsRoot(root), sessionId);
    mkdirSync(sessionDir, { recursive: true });
    try {
      symlinkSync(
        join(sessionsRoot(externalSessionRoot), sessionId, 'session.json'),
        join(sessionDir, 'session.json'),
        'file',
      );
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
        requestId: 'symlinked-session-json-create', action: 'create', scope: 'project', sessionId,
        skill: { name: 'symlinked-session-json', description: 'Must not trust linked canonical metadata', content: 'Reject linked session.json.' },
      });
      expect(ctx.outboundSendQueue.at(-1)?.msg).toMatchObject({
        requestId: 'symlinked-session-json-create',
        error: 'the selected Session was not found',
      });
      expect(existsSync(join(externalWorkDir, '.yeaft', 'skills', 'symlinked-session-json.md'))).toBe(false);
    } finally {
      ctx.ws = originalWs;
      ctx.serverEncryptionRequired = originalEncryption;
      ctx.messageBuffer = originalBuffer;
      ctx.outboundSendQueue = originalQueue;
      ctx.outboundSendQueueActive = originalQueueActive;
    }
  });

  it('rejects a project Skill request when the Session has no project directory', () => {
    const root = makeDir();
    const sessionId = 'session_no_workdir';
    createSession(sessionsRoot(root), { id: sessionId, name: 'No Project', roster: [], defaultVpId: null }).close();
    const originalWs = ctx.ws;
    const originalEncryption = ctx.serverEncryptionRequired;
    const originalBuffer = ctx.messageBuffer;
    ctx.messageBuffer = [];
    ctx.outboundSendQueue = [];
    ctx.outboundSendQueueActive = true;
    ctx.CONFIG = { ...(originalConfig || {}), yeaftDir: root };
    ctx.ws = { readyState: 1, send() {} };
    ctx.serverEncryptionRequired = false;
    __testSetSession({ yeaftDir: root, config: {}, skillManager: null, mcpManager: null, toolRegistry: null });

    try {
      handleYeaftManagedSkill({
        requestId: 'project-without-workdir', action: 'create', scope: 'project', sessionId,
        skill: { name: 'blocked', description: 'Blocked', content: 'Must not be written.' },
      });
      expect(ctx.outboundSendQueue.at(-1)?.msg).toMatchObject({
        type: 'yeaft_managed_skill_result',
        requestId: 'project-without-workdir',
        error: 'the selected Session has no project directory',
      });
      expect(existsSync(join(root, '.yeaft', 'skills', 'blocked.md'))).toBe(false);
    } finally {
      ctx.ws = originalWs;
      ctx.serverEncryptionRequired = originalEncryption;
      ctx.messageBuffer = originalBuffer;
    }
  });
});

describe('Yeaft session-scoped model config', () => {
  it('does not let Dream fall back from a provider-qualified Session model', async () => {
    const root = makeDir();
    const model = 'session-provider/session-model';
    mkdirSync(join(root, 'sessions', 's1'), { recursive: true });
    writeFileSync(join(root, 'sessions', 's1', 'config.json'), JSON.stringify({ model }));
    const calls = [];
    const adapter = { call: vi.fn(async params => {
      calls.push(params);
      return { text: JSON.stringify({ user_profile_signals: false, topics: [], trivial_only: false }), usage: {} };
    }) };
    const session = {
      yeaftDir: root,
      adapter,
      config: {
        dir: root,
        model: 'session-model',
        primaryModel: 'session-provider/session-model',
        language: 'en',
      },
    };
    const opts = (await import('../../../agent/yeaft/dream/session-wiring.js')).buildRunDreamOpts(session);
    const result = await opts.llm({
      pass: 'triage-pass1',
      prompt: `HEAD${'x'.repeat(120_000)}TAIL`,
      system: 'system',
      sessionId: 's1',
    });
    expect(result).toContain('user_profile_signals');
    expect(calls[0].model).toBe(model);
    expect(calls[0].maxTokens).toBe(8192);
    expect(calls[0].messages[0].content.length).toBe(96_000);
    expect(calls[0].messages[0].content.startsWith('HEAD')).toBe(true);
    expect(calls[0].messages[0].content.endsWith('TAIL')).toBe(true);
  });

  it('uses the target Session model output cap instead of the caller Session capability', async () => {
    const root = makeDir();
    mkdirSync(join(root, 'sessions', 'target-session'), { recursive: true });
    writeFileSync(join(root, 'sessions', 'target-session', 'config.json'), JSON.stringify({
      model: 'target-provider/target-model',
    }));
    const adapter = { call: vi.fn(async () => ({
      text: JSON.stringify({ user_profile_signals: false, topics: [], trivial_only: false }),
      usage: {},
    })) };
    const session = {
      yeaftDir: root,
      adapter,
      config: {
        dir: root,
        model: 'caller-model',
        primaryModel: 'caller-provider/caller-model',
        modelInfo: { maxOutput: 64_000 },
        maxOutputTokens: 64_000,
        providers: [
          { name: 'caller-provider', models: ['caller-model'] },
          { name: 'target-provider', models: [{ id: 'target-model', maxOutput: 4096 }] },
        ],
        availableModels: [
          { id: 'caller-model', ref: 'caller-provider/caller-model', provider: 'caller-provider', maxOutput: 64_000 },
          { id: 'target-model', ref: 'target-provider/target-model', provider: 'target-provider', maxOutput: 4096 },
        ],
      },
    };
    const opts = (await import('../../../agent/yeaft/dream/session-wiring.js')).buildRunDreamOpts(session);

    await opts.llm({
      pass: 'triage-pass1',
      prompt: 'target Session memory',
      system: 'system',
      sessionId: 'target-session',
    });

    expect(adapter.call).toHaveBeenCalledWith(expect.objectContaining({
      model: 'target-provider/target-model',
      maxTokens: 4096,
    }));
  });

  it('surfaces truncated Dream output instead of parsing partial JSON', async () => {
    const root = makeDir();
    const adapter = { call: vi.fn(async () => ({
      text: '{"content_md":"partial',
      stopReason: 'max_tokens',
      usage: { inputTokens: 10, outputTokens: 8192 },
    })) };
    const session = {
      yeaftDir: root,
      adapter,
      config: {
        dir: root,
        model: 'session-model',
        primaryModel: 'session-provider/session-model',
        language: 'en',
      },
    };
    const opts = (await import('../../../agent/yeaft/dream/session-wiring.js')).buildRunDreamOpts(session);

    await expect(opts.llm({
      pass: 'update',
      prompt: 'update canonical memory',
      system: 'system',
      sessionId: 's1',
    })).rejects.toMatchObject({
      code: 'DREAM_OUTPUT_TRUNCATED',
      message: 'Dream update response exceeded the 8192-token output limit',
    });
  });

  it('creates an empty-roster Session from the active Agent instance VP library', () => {
    const root = makeDir();
    const vpId = 'vp-instance-only';
    const vpDir = join(root, 'virtual-persons', vpId);
    mkdirSync(vpDir, { recursive: true });
    writeFileSync(join(vpDir, 'role.md'), [
      '---',
      `id: ${vpId}`,
      'name: Instance Only',
      '---',
      'INSTANCE_ONLY_SOUL',
    ].join('\n'));
    ctx.CONFIG = { ...(originalConfig || {}), yeaftDir: root };

    const responseStart = ctx.messageBuffer.length;
    handleYeaftCreateSession({
      requestId: 'create-instance-session',
      payload: { name: 'Instance-scoped Session', roster: [] },
    });

    const response = ctx.messageBuffer.slice(responseStart)
      .map(frame => frame.event)
      .find(event => event?.type === 'session_crud_result' && event.requestId === 'create-instance-session');
    expect(response).toMatchObject({
      op: 'create',
      ok: true,
      session: {
        roster: [vpId],
        defaultVpId: vpId,
      },
    });
    expect(snapshotSessions(root)).toEqual([
      expect.objectContaining({
        id: response.session.id,
        roster: [vpId],
        defaultVpId: vpId,
      }),
    ]);
    expect(existsSync(join(root, 'memory', 'sessions', response.session.id, 'summary.md'))).toBe(true);
  });

  async function assertMcpBootstrapRemoveDoesNotRestoreServer({ workDir = '' } = {}) {
    const root = makeDir();
    const configPath = join(root, 'config.json');
    const previousTransport = {
      ws: ctx.ws,
      serverEncryptionRequired: ctx.serverEncryptionRequired,
      outboundSendQueue: ctx.outboundSendQueue,
      outboundSendQueueActive: ctx.outboundSendQueueActive,
      CONFIG: ctx.CONFIG,
    };
    const sent = [];
    const hotSwapSnapshots = [];
    let releaseConnect;
    const mayConnect = new Promise(resolve => { releaseConnect = resolve; });
    let markConnectStarted;
    const connectStarted = new Promise(resolve => { markConnectStarted = resolve; });
    const connected = new Set();
    const mcpManager = {
      get hasServers() { return connected.size > 0; },
      get toolCount() { return connected.size; },
      status: () => [...connected].map(name => ({ name, ready: true, toolCount: 1 })),
      async connectAll(servers) {
        markConnectStarted();
        await mayConnect;
        for (const server of servers) connected.add(server.name);
        return { connected: [...connected], failed: [] };
      },
      async connect() {},
      async disconnect(name) { connected.delete(name); },
      async disconnectAll() { connected.clear(); },
    };
    const liveSession = {
      yeaftDir: root,
      config: { dir: root, plugins: {} },
      skillManager: { size: 0, list: () => [] },
      mcpManager: { status: () => [], hasServers: false, async disconnect() {}, async disconnectAll() {}, async connect() {} },
      toolRegistry: {
        size: 0,
        replaceMcpTools(manager) {
          hotSwapSnapshots.push((manager?.status?.() || []).map(status => status.name));
          return { removed: 0, added: hotSwapSnapshots.at(-1).length };
        },
      },
      engine: { setRuntimeManagers() {} },
      status: { skills: 0, mcpServers: [], mcpFailed: [], mcpSkipped: [], tools: 0 },
    };
    writeFileSync(configPath, JSON.stringify({
      mcpServers: [{ name: 'github', command: 'node', args: [], env: {} }],
      plugins: {},
    }));
    ctx.CONFIG = { yeaftDir: root };
    ctx.ws = { readyState: 1, send(raw) { sent.push(JSON.parse(raw)); } };
    ctx.serverEncryptionRequired = false;
    ctx.outboundSendQueue = [];
    ctx.outboundSendQueueActive = false;
    __testSetSession(liveSession);
    __testHooks.setRuntimeFactoriesForTest({
      createSkillManager: () => ({ size: 0, list: () => [] }),
      createMcpManager: () => mcpManager,
      loadMcpConfig: () => ({
        servers: JSON.parse(readFileSync(configPath, 'utf8')).mcpServers,
        skipped: [],
      }),
    });

    try {
      const boot = workDir
        ? __testHooks.scheduleProjectRuntimeLoadForTest(workDir)
        : __testHooks.scheduleBaseRuntimeLoadForTest();
      await connectStarted;
      const remove = handleMessage({
        type: 'yeaft_mcp_remove',
        requestId: workDir ? 'remove-project-bootstrap-github' : 'remove-base-bootstrap-github',
        name: 'github',
      });
      await Promise.resolve();
      // The queued remove must not pass the loader while its old config is
      // still blocked in connectAll.
      expect(JSON.parse(readFileSync(configPath, 'utf8')).mcpServers.map(server => server.name))
        .toEqual(['github']);
      releaseConnect();
      await Promise.all([boot, remove]);
      await vi.waitFor(() => expect(sent.some(frame => (
        frame.type === 'yeaft_mcp_updated' && frame.reason === 'remove'
      ))).toBe(true));

      const finalBroadcast = sent.filter(frame => frame.type === 'yeaft_mcp_updated').at(-1);
      expect(JSON.parse(readFileSync(configPath, 'utf8')).mcpServers).toEqual([]);
      expect(connected).toEqual(new Set());
      expect(hotSwapSnapshots.at(-1)).toEqual([]);
      expect(finalBroadcast).toMatchObject({
        reason: 'remove',
        servers: [],
        runtime: { connected: false, perServer: [] },
        error: null,
      });
    } finally {
      releaseConnect?.();
      __testHooks.resetRuntimeFactoriesForTest();
      ctx.ws = previousTransport.ws;
      ctx.serverEncryptionRequired = previousTransport.serverEncryptionRequired;
      ctx.outboundSendQueue = previousTransport.outboundSendQueue;
      ctx.outboundSendQueueActive = previousTransport.outboundSendQueueActive;
      ctx.CONFIG = previousTransport.CONFIG;
    }
  }

  async function assertMcpReloadRuntimeCacheBehavior({ active = 'project', targetName = null } = {}) {
    const root = makeDir();
    const projectWorkDir = 'project-runtime';
    const configPath = join(root, 'config.json');
    const previousTransport = {
      ws: ctx.ws,
      serverEncryptionRequired: ctx.serverEncryptionRequired,
      outboundSendQueue: ctx.outboundSendQueue,
      outboundSendQueueActive: ctx.outboundSendQueueActive,
      CONFIG: ctx.CONFIG,
    };
    const sent = [];
    const hotSwapSnapshots = [];
    const managers = [];
    const makeManager = (label) => {
      const connected = new Set();
      return {
        label,
        get hasServers() { return connected.size > 0; },
        get toolCount() { return connected.size; },
        names: () => [...connected],
        status: () => [...connected].map(name => ({ name, ready: true, toolCount: 1 })),
        async connectAll(servers) {
          for (const server of servers) connected.add(server.name);
          return { connected: [...connected], failed: [] };
        },
        async connect(server) { connected.add(server.name); },
        async disconnect(name) { connected.delete(name); },
        async disconnectAll() { connected.clear(); },
      };
    };
    const liveSession = {
      yeaftDir: root,
      config: { dir: root, plugins: {} },
      skillManager: { size: 0, list: () => [] },
      mcpManager: {
        hasServers: false,
        status: () => [],
        async connect() {},
        async disconnect() {},
        async disconnectAll() {},
      },
      toolRegistry: {
        size: 0,
        replaceMcpTools(manager) {
          const snapshot = {
            label: manager?.label || 'none',
            names: (manager?.status?.() || []).map(status => status.name),
          };
          hotSwapSnapshots.push(snapshot);
          return { removed: 0, added: snapshot.names.length };
        },
      },
      engine: { setRuntimeManagers() {} },
      status: { skills: 0, mcpServers: [], mcpFailed: [], mcpSkipped: [], tools: 0 },
    };

    writeFileSync(configPath, JSON.stringify({
      mcpServers: [{ name: 'github', command: 'node', args: [], env: {} }],
      plugins: {},
    }));
    ctx.CONFIG = { yeaftDir: root };
    ctx.ws = { readyState: 1, send(raw) { sent.push(JSON.parse(raw)); } };
    ctx.serverEncryptionRequired = false;
    ctx.outboundSendQueue = [];
    ctx.outboundSendQueueActive = false;
    __testSetSession(liveSession);
    __testHooks.setRuntimeFactoriesForTest({
      createSkillManager: () => ({ size: 0, list: () => [] }),
      createMcpManager: () => {
        const manager = makeManager(`runtime-${managers.length}`);
        managers.push(manager);
        return manager;
      },
      loadMcpConfig: () => ({
        servers: JSON.parse(readFileSync(configPath, 'utf8')).mcpServers,
        skipped: [],
      }),
    });

    try {
      await __testHooks.scheduleBaseRuntimeLoadForTest();
      await __testHooks.scheduleProjectRuntimeLoadForTest(projectWorkDir);
      expect(managers).toHaveLength(2);
      expect(managers.map(manager => manager.names())).toEqual([['github'], ['github']]);

      if (active === 'base') __testHooks.activateBaseRuntimeForTest();
      const activeIndex = active === 'base' ? 0 : 1;
      const inactiveIndex = active === 'base' ? 1 : 0;
      expect(hotSwapSnapshots.at(-1)).toMatchObject({
        label: `runtime-${activeIndex}`,
        names: ['github'],
      });

      const requestId = `reload-${targetName || 'all'}-${active}`;
      if (!targetName) {
        // Full reload applies an Agent config/CLI/external edit, so it must
        // retire inactive caches before a later runtime switch can revive the
        // old server.
        writeFileSync(configPath, JSON.stringify({ mcpServers: [], plugins: {} }));
      }
      await handleMessage({
        type: 'yeaft_mcp_reload',
        requestId,
        ...(targetName ? { name: targetName } : {}),
      });
      await vi.waitFor(() => expect(sent.some(frame => (
        frame.type === 'yeaft_mcp_updated' && frame.reason === 'reload'
      ))).toBe(true));

      const reloadResult = sent.find(frame => frame.type === 'yeaft_mcp_reload_result');
      const reloadBroadcast = sent.filter(frame => (
        frame.type === 'yeaft_mcp_updated' && frame.reason === 'reload'
      )).at(-1);
      const expectedNames = targetName ? ['github'] : [];
      expect(reloadResult).toMatchObject({
        requestId,
        servers: targetName ? [expect.objectContaining({ name: 'github' })] : [],
        runtime: { connected: !!targetName, perServer: targetName ? [expect.objectContaining({ name: 'github' })] : [] },
        error: null,
      });
      expect(reloadBroadcast).toMatchObject({
        servers: targetName ? [expect.objectContaining({ name: 'github' })] : [],
        runtime: { connected: !!targetName, perServer: targetName ? [expect.objectContaining({ name: 'github' })] : [] },
        error: null,
      });
      expect(managers[activeIndex].names()).toEqual(expectedNames);
      expect(managers[inactiveIndex].names()).toEqual(expectedNames);

      if (targetName) {
        // Per-row reload is a local reconnect only. The inactive cache remains
        // warm and switching runtimes must not create a third manager.
        if (active === 'base') __testHooks.activateProjectRuntimeForTest(projectWorkDir);
        else __testHooks.activateBaseRuntimeForTest();
        expect(managers).toHaveLength(2);
        expect(hotSwapSnapshots.at(-1)).toMatchObject({
          label: `runtime-${inactiveIndex}`,
          names: ['github'],
        });
      } else {
        // A real next turn must rebuild the retired inactive runtime from the
        // current disk config, not merely fall back to an empty manager.
        if (active === 'base') {
          await __testHooks.scheduleProjectRuntimeLoadForTest(projectWorkDir);
          __testHooks.activateProjectRuntimeForTest(projectWorkDir);
        } else {
          await __testHooks.scheduleBaseRuntimeLoadForTest();
          __testHooks.activateBaseRuntimeForTest();
        }
        expect(managers).toHaveLength(3);
        expect(managers[2].names()).toEqual([]);
        expect(hotSwapSnapshots.at(-1)).toMatchObject({
          label: 'runtime-2',
          names: [],
        });
      }
    } finally {
      __testHooks.resetRuntimeFactoriesForTest();
      ctx.ws = previousTransport.ws;
      ctx.serverEncryptionRequired = previousTransport.serverEncryptionRequired;
      ctx.outboundSendQueue = previousTransport.outboundSendQueue;
      ctx.outboundSendQueueActive = previousTransport.outboundSendQueueActive;
      ctx.CONFIG = previousTransport.CONFIG;
    }
  }

  it('normalizes and persists bounded telemetry settings without touching other config', () => {
    expect(normaliseTelemetrySection({
      enabled: false,
      retentionDays: 0,
      flushIntervalMs: 99_999,
      maxQueueSize: 1,
      rawExchangeMaxBytes: 99 * 1024 * 1024,
      traceTextMaxBytes: -1,
      ignored: true,
    })).toEqual({
      enabled: false,
      retentionDays: 1,
      flushIntervalMs: 60_000,
      maxQueueSize: 100,
      rawExchangeMaxBytes: 4 * 1024 * 1024,
      traceTextMaxBytes: 0,
    });
    const root = makeDir();
    writeFileSync(join(root, 'config.json'), JSON.stringify({ primaryModel: 'proxy/model', debug: true }));
    expect(updateTelemetrySettings({ flushIntervalMs: 250, rawExchangeMaxBytes: 65_536 }, root)).toMatchObject({
      flushIntervalMs: 250,
      rawExchangeMaxBytes: 65_536,
    });
    expect(getTelemetrySettings(root)).toMatchObject({ flushIntervalMs: 250, rawExchangeMaxBytes: 65_536 });
    const persisted = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
    expect(persisted.primaryModel).toBe('proxy/model');
    expect(persisted.debug).toBe(true);
    expect(persisted.telemetry).toMatchObject({ flushIntervalMs: 250 });
  });

  it('loads bounded Dream limits from the Agent config', () => {
    const root = makeDir();
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      providers: [],
      yeaft: { dream: { MAX_DREAM_PROMPT_CHARS: 32_000, MIN_NEW_PER_GROUP: 7 } },
    }));
    expect(loadConfig({ dir: root }).yeaft.dream).toMatchObject({
      MAX_DREAM_PROMPT_CHARS: 32_000,
      MIN_NEW_PER_GROUP: 7,
    });
  });

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

  it('inherits only a missing plugins field and fails closed for invalid plugin schemas', () => {
    const root = makeDir();
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, JSON.stringify({ providers: [] }, null, 2));
    expect(loadConfig({ dir: root })).toMatchObject({ plugins: {}, pluginConfigError: null });
    expect(getPluginConfig(root)).toEqual({ plugins: {} });

    for (const [plugins, error] of [
      [null, 'plugins must be an object'],
      [{ tools: 'not-an-array' }, 'plugins.tools must be an array'],
    ]) {
      const invalidSchema = JSON.stringify({ providers: [], plugins }, null, 2);
      writeFileSync(configPath, invalidSchema);

      expect(loadConfig({ dir: root })).toMatchObject({
        plugins: { tools: [], skills: [], mcpServers: [] },
        pluginConfigError: error,
      });
      expect(getPluginConfig(root)).toMatchObject({ error: expect.stringContaining(error) });
      expect(updatePluginConfig({ tools: ['FileRead'] }, root)).toMatchObject({
        error: expect.stringContaining(error),
      });
      expect(readFileSync(configPath, 'utf8')).toBe(invalidSchema);
    }
  });

  it('exposes a newly saved Skill through an explicit Skill allowlist', () => {
    const baseSkillManager = {
      has: name => ['skill-b', 'created-skill'].includes(name),
      list: () => [
        { name: 'skill-b', description: 'Existing explicit Skill' },
        { name: 'created-skill', description: 'Newly created Skill' },
      ],
      get: name => ({ name }),
      resolve: name => ({ name }),
      view: name => ({ name }),
      findRelevant: () => [
        { name: 'skill-b', description: 'Existing explicit Skill' },
        { name: 'created-skill', description: 'Newly created Skill' },
      ],
      getPromptContent: name => `prompt:${name}`,
    };

    const plugins = { skills: ['skill-b', 'created-skill'] };
    const filtered = createPluginSkillManager(baseSkillManager, plugins);

    expect(filtered.list().map(skill => skill.name)).toEqual(['skill-b', 'created-skill']);
    expect(filtered.getPromptContent('created-skill')).toBe('prompt:created-skill');
  });

  it('rejects unrelated config writes over invalid Plugin policies', () => {
    const root = makeDir();
    const configPath = join(root, 'config.json');
    const writers = [
      { write: () => updateLlmConfig({ debug: true }, root), error: 'Failed to read config.json' },
      { write: () => updateYeaftSettings({ maxConcurrentThreads: 2 }, root), error: 'Failed to read config.json' },
      { write: () => updateTelemetrySettings({ enabled: false }, root), error: 'Failed to read config.json' },
      { write: () => updateSearchSettings({ backend: 'tavily' }, root), error: 'Failed to read config.json' },
      { write: () => updatePluginConfig({ tools: ['FileRead'] }, root), error: 'Failed to read plugin config' },
      { write: () => upsertMcpServer({ name: 'github', command: 'node', args: [] }, root), error: 'Failed to read config.json' },
      { write: () => removeMcpServer('github', root), error: 'Failed to read config.json' },
    ];

    for (const invalidConfig of [
      '{"plugins":{"tools":["FileRead"]}',
      'null',
      JSON.stringify({ plugins: { tools: 'not-an-array' } }),
    ]) {
      writeFileSync(configPath, invalidConfig);
      for (const { write, error } of writers) {
        expect(write()).toMatchObject({ error: expect.stringContaining(error) });
        expect(readFileSync(configPath, 'utf8')).toBe(invalidConfig);
      }
      expect(listMcpServers(root)).toMatchObject({ error: expect.stringContaining('Failed to read config.json') });
      expect(loadConfig({ dir: root })).toMatchObject({
        plugins: { tools: [], skills: [], mcpServers: [] },
        pluginConfigError: expect.any(String),
      });
    }
  });

  it('keeps missing config.json writable through strict config API writers', () => {
    const root = makeDir();
    const writes = [
      () => updateLlmConfig({ debug: true }, root),
      () => updateYeaftSettings({ maxConcurrentThreads: 2 }, root),
      () => updateTelemetrySettings({ enabled: false }, root),
      () => updateSearchSettings({ backend: 'tavily' }, root),
      () => removeMcpServer('github', root),
      () => upsertMcpServer({ name: 'github', command: 'node', args: [] }, root),
      () => updatePluginConfig({ tools: ['FileRead'] }, root),
    ];
    for (const write of writes) expect(write().error).toBeUndefined();

    expect(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))).toMatchObject({
      debug: true,
      yeaft: expect.objectContaining({ maxConcurrentThreads: 2 }),
      telemetry: expect.objectContaining({ enabled: false }),
      search: expect.objectContaining({ backend: 'tavily' }),
      mcpServers: [expect.objectContaining({ name: 'github' })],
      plugins: { tools: ['FileRead'] },
    });
  });

  it('rejects fail-open writes through the MCP and telemetry message routes', async () => {
    const root = makeDir();
    const configPath = join(root, 'config.json');
    const previousTransport = {
      ws: ctx.ws,
      serverEncryptionRequired: ctx.serverEncryptionRequired,
      outboundSendQueue: ctx.outboundSendQueue,
      outboundSendQueueActive: ctx.outboundSendQueueActive,
      CONFIG: ctx.CONFIG,
    };
    const sent = [];
    ctx.CONFIG = { yeaftDir: root, telemetry: { enabled: true } };
    ctx.ws = { readyState: 1, send(raw) { sent.push(JSON.parse(raw)); } };
    ctx.serverEncryptionRequired = false;
    ctx.outboundSendQueue = [];
    ctx.outboundSendQueueActive = false;
    try {
      const cases = [
        {
          config: '{"plugins":{"tools":["FileRead"]}',
          message: {
            type: 'yeaft_mcp_add',
            requestId: 'broken-json',
            server: { name: 'github', command: 'node', args: [] },
          },
          resultType: 'yeaft_mcp_add_result',
        },
        {
          config: 'null',
          message: {
            type: 'yeaft_mcp_add',
            requestId: 'null-root',
            server: { name: 'github', command: 'node', args: [] },
          },
          resultType: 'yeaft_mcp_add_result',
        },
        {
          config: JSON.stringify({ plugins: { tools: 'not-an-array' } }),
          message: {
            type: 'yeaft_mcp_add',
            requestId: 'invalid-plugin-schema',
            server: { name: 'github', command: 'node', args: [] },
          },
          resultType: 'yeaft_mcp_add_result',
        },
        {
          config: 'null',
          message: {
            type: 'update_telemetry_settings',
            settings: { enabled: false },
          },
          resultType: 'telemetry_settings_updated',
        },
      ];
      for (const testCase of cases) {
        sent.length = 0;
        writeFileSync(configPath, testCase.config);
        await handleMessage(testCase.message);
        await new Promise(resolve => setImmediate(resolve));
        expect(sent).toContainEqual(expect.objectContaining({
          type: testCase.resultType,
          error: expect.stringContaining('Failed to read config.json'),
        }));
        expect(readFileSync(configPath, 'utf8')).toBe(testCase.config);
        expect(loadConfig({ dir: root })).toMatchObject({
          plugins: { tools: [], skills: [], mcpServers: [] },
          pluginConfigError: expect.any(String),
        });
      }
    } finally {
      ctx.ws = previousTransport.ws;
      ctx.serverEncryptionRequired = previousTransport.serverEncryptionRequired;
      ctx.outboundSendQueue = previousTransport.outboundSendQueue;
      ctx.outboundSendQueueActive = previousTransport.outboundSendQueueActive;
      ctx.CONFIG = previousTransport.CONFIG;
    }
  });

  it('does not let a base runtime bootstrap restore an MCP removed during startup', async () => {
    await assertMcpBootstrapRemoveDoesNotRestoreServer();
  });

  it('does not let a project runtime bootstrap restore an MCP removed during startup', async () => {
    await assertMcpBootstrapRemoveDoesNotRestoreServer({ workDir: 'project-runtime' });
  });

  it('does not let full MCP reload revive a stale base cache after a project runtime is active', async () => {
    await assertMcpReloadRuntimeCacheBehavior({ active: 'project' });
  });

  it('does not let full MCP reload revive a stale project cache after the base runtime is active', async () => {
    await assertMcpReloadRuntimeCacheBehavior({ active: 'base' });
  });

  it('keeps the base cache warm after named MCP reload on an active project runtime', async () => {
    await assertMcpReloadRuntimeCacheBehavior({ active: 'project', targetName: 'github' });
  });

  it('keeps the project cache warm after named MCP reload on an active base runtime', async () => {
    await assertMcpReloadRuntimeCacheBehavior({ active: 'base', targetName: 'github' });
  });

  it('rejects MCP reload before touching a live runtime when config is invalid', async () => {
    const root = makeDir();
    const configPath = join(root, 'config.json');
    const previousTransport = {
      ws: ctx.ws,
      serverEncryptionRequired: ctx.serverEncryptionRequired,
      outboundSendQueue: ctx.outboundSendQueue,
      outboundSendQueueActive: ctx.outboundSendQueueActive,
      CONFIG: ctx.CONFIG,
    };
    const sent = [];
    const disconnectAll = vi.fn(async () => {});
    const disconnect = vi.fn(async () => {});
    const connect = vi.fn(async () => {});
    const replaceMcpTools = vi.fn(() => ({ removed: 0, added: 0 }));
    const mcpManager = {
      hasServers: true,
      status: () => [{ name: 'github', ready: true, toolCount: 1 }],
      disconnectAll,
      disconnect,
      connect,
    };
    ctx.CONFIG = { yeaftDir: root };
    ctx.ws = { readyState: 1, send(raw) { sent.push(JSON.parse(raw)); } };
    ctx.serverEncryptionRequired = false;
    ctx.outboundSendQueue = [];
    ctx.outboundSendQueueActive = false;
    __testSetSession({
      config: { plugins: {} },
      mcpManager,
      toolRegistry: { replaceMcpTools },
    });

    try {
      for (const [requestId, invalidConfig] of [
        ['reload-malformed', '{"plugins":{"tools":["FileRead"]}'],
        ['reload-invalid-plugins', JSON.stringify({ plugins: { tools: 'not-an-array' } })],
      ]) {
        sent.length = 0;
        disconnectAll.mockClear();
        disconnect.mockClear();
        connect.mockClear();
        replaceMcpTools.mockClear();
        writeFileSync(configPath, invalidConfig);

        await handleMessage({ type: 'yeaft_mcp_reload', requestId });
        await new Promise(resolve => setImmediate(resolve));

        expect(sent).toContainEqual(expect.objectContaining({
          type: 'yeaft_mcp_reload_result',
          requestId,
          servers: [],
          error: expect.stringContaining('Failed to read config.json'),
        }));
        expect(sent).not.toContainEqual(expect.objectContaining({
          type: 'yeaft_mcp_updated',
          reason: 'reload',
        }));
        expect(disconnectAll).not.toHaveBeenCalled();
        expect(disconnect).not.toHaveBeenCalled();
        expect(connect).not.toHaveBeenCalled();
        expect(replaceMcpTools).not.toHaveBeenCalled();
        expect(readFileSync(configPath, 'utf8')).toBe(invalidConfig);
        expect(loadConfig({ dir: root })).toMatchObject({
          plugins: { tools: [], skills: [], mcpServers: [] },
          pluginConfigError: expect.any(String),
        });
      }
    } finally {
      ctx.ws = previousTransport.ws;
      ctx.serverEncryptionRequired = previousTransport.serverEncryptionRequired;
      ctx.outboundSendQueue = previousTransport.outboundSendQueue;
      ctx.outboundSendQueueActive = previousTransport.outboundSendQueueActive;
      ctx.CONFIG = previousTransport.CONFIG;
    }
  });

  it('serializes overlapping MCP add and remove mutations through runtime publication', async () => {
    const root = makeDir();
    const configPath = join(root, 'config.json');
    const previousTransport = {
      ws: ctx.ws,
      serverEncryptionRequired: ctx.serverEncryptionRequired,
      outboundSendQueue: ctx.outboundSendQueue,
      outboundSendQueueActive: ctx.outboundSendQueueActive,
      CONFIG: ctx.CONFIG,
    };
    const sent = [];
    const connected = new Set(['github']);
    let releaseLinearConnect;
    const linearConnectStarted = new Promise(resolve => {
      releaseLinearConnect = () => resolve();
    });
    let markLinearConnectStarted;
    const waitingForLinearConnect = new Promise(resolve => {
      markLinearConnectStarted = resolve;
    });
    const connect = vi.fn(async server => {
      if (server.name === 'linear') {
        markLinearConnectStarted();
        await linearConnectStarted;
      }
      connected.add(server.name);
    });
    const disconnect = vi.fn(async name => { connected.delete(name); });
    const replaceMcpTools = vi.fn(() => ({ removed: 0, added: connected.size }));
    const mcpManager = {
      get hasServers() { return connected.size > 0; },
      status: () => [...connected].map(name => ({ name, ready: true, toolCount: 1 })),
      connect,
      disconnect,
    };
    ctx.CONFIG = { yeaftDir: root };
    ctx.ws = { readyState: 1, send(raw) { sent.push(JSON.parse(raw)); } };
    ctx.serverEncryptionRequired = false;
    ctx.outboundSendQueue = [];
    ctx.outboundSendQueueActive = false;
    __testSetSession({
      config: { plugins: {} },
      mcpManager,
      toolRegistry: { replaceMcpTools },
    });

    try {
      writeFileSync(configPath, JSON.stringify({
        mcpServers: [{ name: 'github', command: 'node', args: [], env: {} }],
        plugins: {},
      }));
      const add = handleMessage({
        type: 'yeaft_mcp_add',
        requestId: 'add-linear',
        server: { name: 'linear', command: 'node', args: [], env: {} },
      });
      await waitingForLinearConnect;

      const remove = handleMessage({
        type: 'yeaft_mcp_remove',
        requestId: 'remove-github',
        name: 'github',
      });
      await Promise.resolve();
      expect(disconnect).not.toHaveBeenCalled();
      expect(JSON.parse(readFileSync(configPath, 'utf8')).mcpServers.map(server => server.name))
        .toEqual(['github', 'linear']);

      releaseLinearConnect();
      await Promise.all([add, remove]);
      await vi.waitFor(() => expect(sent.some(frame => frame.type === 'yeaft_mcp_remove_result')).toBe(true));
      await vi.waitFor(() => expect(sent.some(frame => (
        frame.type === 'yeaft_mcp_updated' && frame.reason === 'remove'
      ))).toBe(true));

      const persisted = JSON.parse(readFileSync(configPath, 'utf8'));
      const mutationFrames = sent.filter(frame => (
        frame.type === 'yeaft_mcp_add_result'
        || frame.type === 'yeaft_mcp_remove_result'
        || frame.type === 'yeaft_mcp_updated'
      ));
      const finalResult = mutationFrames.at(-2);
      const finalFrame = mutationFrames.at(-1);
      const removeResult = sent.find(frame => frame.type === 'yeaft_mcp_remove_result');
      expect(persisted.mcpServers.map(server => server.name)).toEqual(['linear']);
      expect([...connected]).toEqual(['linear']);
      expect(disconnect).toHaveBeenCalledWith('github');
      expect(finalResult).toBe(removeResult);
      expect(finalResult).toMatchObject({
        type: 'yeaft_mcp_remove_result',
        requestId: 'remove-github',
        servers: [expect.objectContaining({ name: 'linear' })],
        runtime: expect.objectContaining({
          connected: true,
          perServer: [expect.objectContaining({ name: 'linear', ready: true })],
        }),
        error: null,
      });
      expect(finalFrame).toMatchObject({
        type: 'yeaft_mcp_updated',
        reason: 'remove',
        servers: [expect.objectContaining({ name: 'linear' })],
        runtime: expect.objectContaining({
          connected: true,
          perServer: [expect.objectContaining({ name: 'linear', ready: true })],
        }),
        error: null,
      });
      expect(finalFrame.servers.map(server => server.name)).toEqual(['linear']);
    } finally {
      releaseLinearConnect?.();
      ctx.ws = previousTransport.ws;
      ctx.serverEncryptionRequired = previousTransport.serverEncryptionRequired;
      ctx.outboundSendQueue = previousTransport.outboundSendQueue;
      ctx.outboundSendQueueActive = previousTransport.outboundSendQueueActive;
      ctx.CONFIG = previousTransport.CONFIG;
    }
  });

  it('serializes overlapping MCP reload and add mutations without restoring a stale server set', async () => {
    const root = makeDir();
    const configPath = join(root, 'config.json');
    const previousTransport = {
      ws: ctx.ws,
      serverEncryptionRequired: ctx.serverEncryptionRequired,
      outboundSendQueue: ctx.outboundSendQueue,
      outboundSendQueueActive: ctx.outboundSendQueueActive,
      CONFIG: ctx.CONFIG,
    };
    const sent = [];
    const connected = new Set(['github']);
    let releaseDisconnectAll;
    const reloadMayContinue = new Promise(resolve => {
      releaseDisconnectAll = () => resolve();
    });
    let markDisconnectAllStarted;
    const disconnectAllStarted = new Promise(resolve => {
      markDisconnectAllStarted = resolve;
    });
    const disconnectAll = vi.fn(async () => {
      markDisconnectAllStarted();
      await reloadMayContinue;
      connected.clear();
    });
    const connect = vi.fn(async server => { connected.add(server.name); });
    const replaceMcpTools = vi.fn(() => ({ removed: 0, added: connected.size }));
    const mcpManager = {
      get hasServers() { return connected.size > 0; },
      status: () => [...connected].map(name => ({ name, ready: true, toolCount: 1 })),
      disconnectAll,
      connect,
    };
    ctx.CONFIG = { yeaftDir: root };
    ctx.ws = { readyState: 1, send(raw) { sent.push(JSON.parse(raw)); } };
    ctx.serverEncryptionRequired = false;
    ctx.outboundSendQueue = [];
    ctx.outboundSendQueueActive = false;
    __testSetSession({
      config: { plugins: {} },
      mcpManager,
      toolRegistry: { replaceMcpTools },
    });

    try {
      writeFileSync(configPath, JSON.stringify({
        mcpServers: [{ name: 'github', command: 'node', args: [], env: {} }],
        plugins: {},
      }));
      const reload = handleMessage({ type: 'yeaft_mcp_reload', requestId: 'reload-before-add' });
      await disconnectAllStarted;

      const add = handleMessage({
        type: 'yeaft_mcp_add',
        requestId: 'add-linear-after-reload',
        server: { name: 'linear', command: 'node', args: [], env: {} },
      });
      await Promise.resolve();
      expect(connect).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'linear' }));
      expect(JSON.parse(readFileSync(configPath, 'utf8')).mcpServers.map(server => server.name))
        .toEqual(['github']);

      releaseDisconnectAll();
      await Promise.all([reload, add]);
      await vi.waitFor(() => expect(sent.some(frame => (
        frame.type === 'yeaft_mcp_updated' && frame.reason === 'add'
      ))).toBe(true));

      const persisted = JSON.parse(readFileSync(configPath, 'utf8'));
      const mutationFrames = sent.filter(frame => (
        frame.type === 'yeaft_mcp_reload_result'
        || frame.type === 'yeaft_mcp_add_result'
        || frame.type === 'yeaft_mcp_updated'
      ));
      const finalResult = mutationFrames.at(-2);
      const finalBroadcast = mutationFrames.at(-1);
      expect(persisted.mcpServers.map(server => server.name)).toEqual(['github', 'linear']);
      expect([...connected]).toEqual(['github', 'linear']);
      expect(finalResult).toMatchObject({
        type: 'yeaft_mcp_add_result',
        requestId: 'add-linear-after-reload',
        servers: [
          expect.objectContaining({ name: 'github' }),
          expect.objectContaining({ name: 'linear' }),
        ],
        runtime: expect.objectContaining({
          connected: true,
          perServer: [
            expect.objectContaining({ name: 'github', ready: true }),
            expect.objectContaining({ name: 'linear', ready: true }),
          ],
        }),
        error: null,
      });
      expect(finalBroadcast).toMatchObject({
        type: 'yeaft_mcp_updated',
        reason: 'add',
        servers: [
          expect.objectContaining({ name: 'github' }),
          expect.objectContaining({ name: 'linear' }),
        ],
        runtime: expect.objectContaining({
          connected: true,
          perServer: [
            expect.objectContaining({ name: 'github', ready: true }),
            expect.objectContaining({ name: 'linear', ready: true }),
          ],
        }),
        error: null,
      });
    } finally {
      releaseDisconnectAll?.();
      ctx.ws = previousTransport.ws;
      ctx.serverEncryptionRequired = previousTransport.serverEncryptionRequired;
      ctx.outboundSendQueue = previousTransport.outboundSendQueue;
      ctx.outboundSendQueueActive = previousTransport.outboundSendQueueActive;
      ctx.CONFIG = previousTransport.CONFIG;
    }
  });

  it('keeps the reload snapshot when config becomes invalid during runtime work', async () => {
    const root = makeDir();
    const configPath = join(root, 'config.json');
    const previousTransport = {
      ws: ctx.ws,
      serverEncryptionRequired: ctx.serverEncryptionRequired,
      outboundSendQueue: ctx.outboundSendQueue,
      outboundSendQueueActive: ctx.outboundSendQueueActive,
      CONFIG: ctx.CONFIG,
    };
    const initialConfig = JSON.stringify({
      mcpServers: [{ name: 'github', command: 'node', args: [], env: {} }],
      plugins: {},
    });
    const sent = [];
    const connected = new Set(['github']);
    const disconnectAll = vi.fn(async () => {
      connected.clear();
      writeFileSync(configPath, JSON.stringify({
        mcpServers: [{ name: 'github', command: 'node', args: [], env: {} }],
        plugins: { tools: 'invalid-after-reload-started' },
      }));
    });
    const connect = vi.fn(async server => { connected.add(server.name); });
    const replaceMcpTools = vi.fn(() => ({ removed: 0, added: 1 }));
    const mcpManager = {
      get hasServers() { return connected.size > 0; },
      status: () => [...connected].map(name => ({ name, ready: true, toolCount: 1 })),
      disconnectAll,
      disconnect: vi.fn(async name => { connected.delete(name); }),
      connect,
    };
    ctx.CONFIG = { yeaftDir: root };
    ctx.ws = { readyState: 1, send(raw) { sent.push(JSON.parse(raw)); } };
    ctx.serverEncryptionRequired = false;
    ctx.outboundSendQueue = [];
    ctx.outboundSendQueueActive = false;
    __testSetSession({
      config: { plugins: {} },
      mcpManager,
      toolRegistry: { replaceMcpTools },
    });

    try {
      writeFileSync(configPath, initialConfig);
      await handleMessage({ type: 'yeaft_mcp_reload', requestId: 'reload-snapshot-race' });
      await new Promise(resolve => setImmediate(resolve));

      await vi.waitFor(() => expect(sent.some(frame => (
        frame.type === 'yeaft_mcp_updated' && frame.reason === 'reload'
      ))).toBe(true));
      const reloadResult = sent.find(frame => frame.type === 'yeaft_mcp_reload_result');
      const reloadBroadcast = sent.find(frame => frame.type === 'yeaft_mcp_updated' && frame.reason === 'reload');
      expect(disconnectAll).toHaveBeenCalledTimes(1);
      expect(connect).toHaveBeenCalledWith(expect.objectContaining({ name: 'github' }));
      expect(replaceMcpTools).toHaveBeenCalledTimes(1);
      expect(reloadResult).toMatchObject({
        requestId: 'reload-snapshot-race',
        servers: [expect.objectContaining({ name: 'github' })],
        error: null,
        runtime: expect.objectContaining({ connected: true }),
      });
      expect(reloadBroadcast).toMatchObject({
        reason: 'reload',
        servers: [expect.objectContaining({ name: 'github' })],
        error: null,
        runtime: expect.objectContaining({ connected: true }),
      });
      expect(reloadBroadcast).not.toMatchObject({ servers: [] });
      expect(readFileSync(configPath, 'utf8')).not.toBe(initialConfig);
      expect(loadConfig({ dir: root })).toMatchObject({
        plugins: { tools: [], skills: [], mcpServers: [] },
        pluginConfigError: 'plugins.tools must be an array',
      });
    } finally {
      ctx.ws = previousTransport.ws;
      ctx.serverEncryptionRequired = previousTransport.serverEncryptionRequired;
      ctx.outboundSendQueue = previousTransport.outboundSendQueue;
      ctx.outboundSendQueueActive = previousTransport.outboundSendQueueActive;
      ctx.CONFIG = previousTransport.CONFIG;
    }
  });

  it('reports fallback MCP broadcast read errors without an empty server list', async () => {
    const root = makeDir();
    const configPath = join(root, 'config.json');
    const previousTransport = {
      ws: ctx.ws,
      serverEncryptionRequired: ctx.serverEncryptionRequired,
      outboundSendQueue: ctx.outboundSendQueue,
      outboundSendQueueActive: ctx.outboundSendQueueActive,
      CONFIG: ctx.CONFIG,
    };
    const sent = [];
    ctx.CONFIG = { yeaftDir: root };
    ctx.ws = { readyState: 1, send(raw) { sent.push(JSON.parse(raw)); } };
    ctx.serverEncryptionRequired = false;
    ctx.outboundSendQueue = [];
    ctx.outboundSendQueueActive = false;
    __testSetSession({
      mcpManager: {
        hasServers: true,
        status: () => [{ name: 'github', ready: true, toolCount: 1 }],
      },
    });

    try {
      writeFileSync(configPath, JSON.stringify({ plugins: { tools: 'not-an-array' } }));
      await __testHooks.broadcastMcpUpdatedForTest({ reason: 'base-runtime-load' });

      const update = sent.find(frame => frame.type === 'yeaft_mcp_updated');
      expect(update).toMatchObject({
        reason: 'base-runtime-load',
        error: expect.stringContaining('Failed to read config.json'),
        runtime: expect.objectContaining({ connected: true }),
      });
      expect(update).not.toHaveProperty('servers');
    } finally {
      ctx.ws = previousTransport.ws;
      ctx.serverEncryptionRequired = previousTransport.serverEncryptionRequired;
      ctx.outboundSendQueue = previousTransport.outboundSendQueue;
      ctx.outboundSendQueueActive = previousTransport.outboundSendQueueActive;
      ctx.CONFIG = previousTransport.CONFIG;
    }
  });

  it('rejects feature flag writes that would overwrite an invalid Agent config', () => {
    const root = makeDir();
    const configPath = join(root, 'config.json');
    for (const invalidConfig of [
      '{"plugins":{"tools":["FileRead"]}',
      'null',
      JSON.stringify({ plugins: { tools: 'not-an-array' } }, null, 2),
    ]) {
      writeFileSync(configPath, invalidConfig);
      expect(isMultiVpEnabled(root)).toBe(false);
      expect(setMultiVpEnabled(root, true)).toMatchObject({
        error: expect.stringContaining('Failed to read config.json'),
      });
      expect(readFileSync(configPath, 'utf8')).toBe(invalidConfig);
      expect(loadConfig({ dir: root })).toMatchObject({
        plugins: { tools: [], skills: [], mcpServers: [] },
        pluginConfigError: expect.any(String),
      });
    }
  });

  it('writes a feature flag only after a valid config precondition', () => {
    const root = makeDir();
    expect(setMultiVpEnabled(root, true)).toEqual({ enabled: true });
    expect(isMultiVpEnabled(root)).toBe(true);
    expect(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))).toMatchObject({
      yeaft: { multiVp: { enabled: true } },
    });
  });

  it('rejects CLI writes that would overwrite an invalid Agent config', () => {
    const root = makeDir();
    const configPath = join(root, 'config.json');
    for (const invalidConfig of [
      '{"plugins":{"tools":["FileRead"]}',
      'null',
      JSON.stringify({ plugins: { tools: 'not-an-array' } }, null, 2),
    ]) {
      writeFileSync(configPath, invalidConfig);
      expect(() => readLocalLlmConfig(configPath)).toThrow();
      expect(() => writeLocalLlmConfig({ primaryModel: 'proxy/gpt-5' }, configPath)).toThrow();
      expect(readFileSync(configPath, 'utf8')).toBe(invalidConfig);
      expect(loadConfig({ dir: root })).toMatchObject({
        plugins: { tools: [], skills: [], mcpServers: [] },
        pluginConfigError: expect.any(String),
      });
    }
  });

  it('preserves a valid CLI Plugin allowlist when an LLM write omits it', () => {
    const root = makeDir();
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      plugins: { tools: ['FileRead'] },
      providers: [{ name: 'old', baseUrl: 'https://example.invalid/v1', models: ['gpt-4'] }],
    }, null, 2));

    writeLocalLlmConfig({ primaryModel: 'new/gpt-5' }, configPath);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({
      primaryModel: 'new/gpt-5',
      plugins: { tools: ['FileRead'] },
    });
  });

  it('rejects falsy plugin update payloads instead of resetting the allowlist', async () => {
    const root = makeDir();
    const configPath = join(root, 'config.json');
    const original = JSON.stringify({ plugins: { tools: ['FileRead'] } }, null, 2);
    writeFileSync(configPath, original);
    const previousTransport = {
      ws: ctx.ws,
      serverEncryptionRequired: ctx.serverEncryptionRequired,
      outboundSendQueue: ctx.outboundSendQueue,
      outboundSendQueueActive: ctx.outboundSendQueueActive,
      CONFIG: ctx.CONFIG,
    };
    const sent = [];
    ctx.CONFIG = { yeaftDir: root };
    ctx.ws = { readyState: 1, send(raw) { sent.push(JSON.parse(raw)); } };
    ctx.serverEncryptionRequired = false;
    ctx.outboundSendQueue = [];
    ctx.outboundSendQueueActive = false;
    try {
      for (const payload of [null, false, '']) {
        await handleMessage({ type: 'update_yeaft_plugins', plugins: payload });
        await new Promise(resolve => setImmediate(resolve));
      }
      expect(sent.filter(frame => frame.type === 'yeaft_plugins_updated')).toEqual([
        expect.objectContaining({ error: expect.stringContaining('plugins must be an object') }),
        expect.objectContaining({ error: expect.stringContaining('plugins must be an object') }),
        expect.objectContaining({ error: expect.stringContaining('plugins must be an object') }),
      ]);
      expect(readFileSync(configPath, 'utf8')).toBe(original);
    } finally {
      ctx.ws = previousTransport.ws;
      ctx.serverEncryptionRequired = previousTransport.serverEncryptionRequired;
      ctx.outboundSendQueue = previousTransport.outboundSendQueue;
      ctx.outboundSendQueueActive = previousTransport.outboundSendQueueActive;
      ctx.CONFIG = previousTransport.CONFIG;
    }
  });

  it('persists Dream disable without bootstrapping a Session runtime', async () => {
    const root = makeDir();
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, JSON.stringify({ dream: { enabled: true } }, null, 2));
    const previousTransport = {
      ws: ctx.ws,
      serverEncryptionRequired: ctx.serverEncryptionRequired,
      outboundSendQueue: ctx.outboundSendQueue,
      outboundSendQueueActive: ctx.outboundSendQueueActive,
      CONFIG: ctx.CONFIG,
    };
    const sent = [];
    ctx.CONFIG = { yeaftDir: root };
    ctx.ws = { readyState: 1, send(raw) { sent.push(JSON.parse(raw)); } };
    ctx.serverEncryptionRequired = false;
    ctx.outboundSendQueue = [];
    ctx.outboundSendQueueActive = false;
    __testSetSession(null);

    try {
      await handleMessage({
        type: 'set_dream_enabled',
        enabled: false,
        requestId: 'dream-disable',
        clientId: 'browser-a',
      });
      await new Promise(resolve => setImmediate(resolve));

      expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({
        dream: { enabled: false },
      });
      expect(loadConfig({ dir: root }).dream.enabled).toBe(false);
      expect(sent).toContainEqual(expect.objectContaining({
        type: 'dream_enabled_changed',
        enabled: false,
        requestId: 'dream-disable',
        clientId: 'browser-a',
      }));
    } finally {
      ctx.ws = previousTransport.ws;
      ctx.serverEncryptionRequired = previousTransport.serverEncryptionRequired;
      ctx.outboundSendQueue = previousTransport.outboundSendQueue;
      ctx.outboundSendQueueActive = previousTransport.outboundSendQueueActive;
      ctx.CONFIG = previousTransport.CONFIG;
    }
  });

  it('reports persisted Dream disable even when the live scheduler refresh fails', async () => {
    const root = makeDir();
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, JSON.stringify({ dream: { enabled: true } }, null, 2));
    const previousTransport = {
      ws: ctx.ws,
      serverEncryptionRequired: ctx.serverEncryptionRequired,
      outboundSendQueue: ctx.outboundSendQueue,
      outboundSendQueueActive: ctx.outboundSendQueueActive,
      CONFIG: ctx.CONFIG,
    };
    const sent = [];
    ctx.CONFIG = { yeaftDir: root };
    ctx.ws = { readyState: 1, send(raw) { sent.push(JSON.parse(raw)); } };
    ctx.serverEncryptionRequired = false;
    ctx.outboundSendQueue = [];
    ctx.outboundSendQueueActive = false;
    __testSetSession({
      config: { dir: root, dream: { enabled: true } },
      dreamScheduler: { setEnabled() { throw new Error('scheduler unavailable'); } },
    });

    try {
      await handleMessage({ type: 'set_dream_enabled', enabled: false, requestId: 'dream-live-failure' });
      await new Promise(resolve => setImmediate(resolve));

      expect(loadConfig({ dir: root }).dream.enabled).toBe(false);
      expect(sent).toContainEqual(expect.objectContaining({
        type: 'dream_enabled_changed',
        enabled: false,
        requestId: 'dream-live-failure',
      }));
      expect(sent.find(frame => frame.type === 'dream_enabled_changed')).not.toHaveProperty('error');
    } finally {
      ctx.ws = previousTransport.ws;
      ctx.serverEncryptionRequired = previousTransport.serverEncryptionRequired;
      ctx.outboundSendQueue = previousTransport.outboundSendQueue;
      ctx.outboundSendQueueActive = previousTransport.outboundSendQueueActive;
      ctx.CONFIG = previousTransport.CONFIG;
      __testSetSession(null);
    }
  });

  it('disables bridge traces through the telemetry update message immediately', async () => {
    const root = makeDir();
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      primaryModel: 'session-test/gpt-5',
      telemetry: { enabled: true, flushIntervalMs: 60_000 },
    }, null, 2));
    const previousTransport = {
      ws: ctx.ws,
      serverEncryptionRequired: ctx.serverEncryptionRequired,
      outboundSendQueue: ctx.outboundSendQueue,
      outboundSendQueueActive: ctx.outboundSendQueueActive,
    };
    const sent = [];
    ctx.CONFIG = { yeaftDir: root, telemetry: { enabled: true, flushIntervalMs: 60_000 } };
    ctx.ws = { readyState: 1, send(raw) { sent.push(JSON.parse(raw)); } };
    ctx.serverEncryptionRequired = false;
    ctx.outboundSendQueue = [];
    ctx.outboundSendQueueActive = false;

    try {
      await handleMessage({ type: 'update_telemetry_settings', settings: { enabled: false } });
      await new Promise(resolve => setImmediate(resolve));
      expect(ctx.CONFIG.telemetry).toMatchObject({ enabled: false });
      expect(sent).toContainEqual(expect.objectContaining({
        type: 'telemetry_settings_updated',
        enabled: false,
      }));

      await handleYeaftLoadHistoryOutline({
        type: 'yeaft_load_history_outline',
        sessionId: 'session-telemetry-disabled',
        perfTraceId: 'trace-disabled-bridge',
      });
      await new Promise(resolve => setImmediate(resolve));
      flushAllAgentPerfTraces();
      expect(existsSync(join(root, 'perf-traces'))).toBe(false);
    } finally {
      ctx.ws = previousTransport.ws;
      ctx.serverEncryptionRequired = previousTransport.serverEncryptionRequired;
      ctx.outboundSendQueue = previousTransport.outboundSendQueue;
      ctx.outboundSendQueueActive = previousTransport.outboundSendQueueActive;
    }
  });

  it('keeps model and effort isolated per Session', async () => {
    expect(normalizeLlmRetry(null, null)).toMatchObject({
      maxRetries: 3,
      streamIdleTimeoutMs: 90_000,
    });
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

    // Simulate an already-loaded runtime whose MCP manager still reflects the
    // pre-CRUD connection set. The catalog must read the saved Agent config.
    const staleMcpManager = {
      status: () => [{ name: 'stale-runtime', ready: true, toolCount: 1 }],
    };
    __testSetSession({
      yeaftDir: root,
      config: { dir: root },
      toolRegistry: null,
      skillManager: null,
      mcpManager: staleMcpManager,
    });
    writeFileSync(join(root, 'config.json'), `${JSON.stringify({
      mcpServers: [
        { name: 'github', command: 'node', args: ['github.js'] },
        { name: 'slack', command: 'node', args: ['slack.js'] },
      ],
    }, null, 2)}\n`);
    const firstCatalog = __testLoadPluginCatalogMcpConfig(root);
    expect(firstCatalog.servers.map(server => server.name)).toEqual(expect.arrayContaining(['github', 'slack']));
    expect(firstCatalog.servers.map(server => server.name)).not.toContain('stale-runtime');

    writeFileSync(join(root, 'config.json'), `${JSON.stringify({
      mcpServers: [{ name: 'github', command: 'node', args: ['github-v2.js'] }],
    }, null, 2)}\n`);
    const refreshedCatalog = __testLoadPluginCatalogMcpConfig(root);
    expect(refreshedCatalog.servers.find(server => server.name === 'github')).toMatchObject({
      args: ['github-v2.js'],
    });
    expect(refreshedCatalog.servers.map(server => server.name)).not.toContain('slack');

    writeFileSync(join(root, 'config.json'), `${JSON.stringify({ providers: [] }, null, 2)}\n`);
    writeFileSync(join(root, 'mcp.json'), `${JSON.stringify({
      servers: [{ name: 'legacy', command: 'node', args: ['legacy.js'] }],
    }, null, 2)}\n`);
    const legacyCatalog = __testLoadPluginCatalogMcpConfig(root);
    expect(legacyCatalog.servers).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'legacy', args: ['legacy.js'] }),
    ]));

    writeFileSync(join(root, 'config.json'), `${JSON.stringify({ mcpServers: [] }, null, 2)}\n`);
    const explicitEmptyCatalog = __testLoadPluginCatalogMcpConfig(root);
    expect(explicitEmptyCatalog.servers).toEqual([]);
    expect(loadMCPConfig(root, undefined).servers.map(server => server.name)).not.toContain('legacy');
    expect(buildPluginCatalog({
      mcpConfig: explicitEmptyCatalog,
      mcpManager: staleMcpManager,
    }).mcpServers).toEqual([]);

    const alpha = createProject(root, 'Alpha');
    const beta = createProject(root, 'Beta');
    expect(reorderProjects(root, [beta.id, alpha.id]).map(project => project.id))
      .toEqual([beta.id, alpha.id]);
    expect(loadProjects(root).map(project => project.id)).toEqual([beta.id, alpha.id]);
    expect(() => reorderProjects(root, [alpha.id])).toThrow('Complete Project order is required');
    expect(() => reorderProjects(root, [alpha.id, alpha.id])).toThrow('Complete Project order is required');
    expect(loadProjects(root).map(project => project.id)).toEqual([beta.id, alpha.id]);
    reorderProjects(root, [alpha.id, beta.id]);
    moveSessionToProject(root, 'session-a', alpha.id);
    moveSessionToProject(root, 'session-b', alpha.id);
    moveSessionToProject(root, 'session-a', beta.id);
    expect(loadProjects(root)).toEqual([
      expect.objectContaining({ id: alpha.id, sessionIds: ['session-b'] }),
      expect.objectContaining({ id: beta.id, sessionIds: ['session-a'] }),
    ]);
    moveSessionToProject(root, 'session-b', beta.id);
    expect(sharedSessionIdsForProject(root, 'session-a')).toEqual(['session-b']);
    const siblingSummary = join(root, 'memory', 'sessions', 'session-b');
    mkdirSync(siblingSummary, { recursive: true });
    writeFileSync(join(siblingSummary, 'summary.zh.md'), '共享发布决策\n');
    expect(await __testHooks.sharedProjectContext(root, 'session-a', { language: 'zh' }))
      .toBe('[Session session-b]\n共享发布决策');
    expect(await __testHooks.sharedProjectContext(root, 'session-a', {
      language: 'zh',
      sessionIds: [],
    })).toBe('');
    expect(__testHooks.normalizeProjectContext({
      projectId: beta.id,
      projectName: 'Beta',
      projectInstruction: '  Use the shared release checklist.  ',
      sessionIds: ['session-a', 'session-b', 'session-b'],
    }, 'session-a')).toEqual({
      projectId: beta.id,
      projectName: 'Beta',
      projectInstruction: 'Use the shared release checklist.',
      sessionIds: ['session-b'],
    });
    __testHooks.handleProjectContextSyncForTest({
      contexts: [{
        sessionId: 'session-a',
        projectContext: {
          projectId: beta.id,
          projectName: 'Beta',
          projectInstruction: 'Use the shared release checklist.',
          sessionIds: ['session-a', 'session-b'],
        },
      }],
    });
    expect(__testHooks.projectContextForSessionForTest('session-a')).toEqual({
      projectId: beta.id,
      projectName: 'Beta',
      projectInstruction: 'Use the shared release checklist.',
      sessionIds: ['session-b'],
    });
    const bridgeAgent = {
      id: 'agent-project-prompt',
      name: 'project-prompt',
      status: 'idle',
      parentSessionId: 'session-a',
      parentVpId: 'vp-project',
      parentThreadId: 'main',
      pendingPrompts: [],
      messages: [],
    };
    getAgentRegistry().set(bridgeAgent.id, bridgeAgent);
    __testSetSession({
      taskManager: {
        getTask(sessionId, taskId) {
          return sessionId === 'session-a' && taskId === 'task-project'
            ? {
                id: taskId,
                kind: 'sub_agent',
                status: 'running',
                ownerVpId: 'vp-project',
                runtime: { subAgentId: bridgeAgent.id },
                source: { threadId: 'main' },
              }
            : null;
        },
        refreshTaskLog() {},
      },
    });
    handleYeaftSubAgentPrompt({
      sessionId: 'session-a',
      taskId: 'task-project',
      subAgentId: bridgeAgent.id,
      message: 'use current Project context',
    });
    expect(bridgeAgent.pendingPrompts[0]).toEqual({
      prompt: 'use current Project context',
      parentEffortDecision: expect.objectContaining({ effective: null, source: 'unknown', wireMode: 'omitted' }),
      projectSessionIds: ['session-b'],
      projectLabel: `Beta (${beta.id})`,
      projectInstruction: 'Use the shared release checklist.',
    });
    __testHooks.handleProjectContextSyncForTest({
      contexts: [{ sessionId: 'session-a', projectContext: null }],
    });
    handleYeaftSubAgentPrompt({
      sessionId: 'session-a',
      taskId: 'task-project',
      subAgentId: bridgeAgent.id,
      message: 'clear Project context',
    });
    expect(bridgeAgent.pendingPrompts[1]).toEqual({
      prompt: 'clear Project context',
      parentEffortDecision: expect.objectContaining({ effective: null, source: 'unknown', wireMode: 'omitted' }),
      projectSessionIds: [],
      projectLabel: '',
      projectInstruction: '',
    });

    const abortController = new AbortController();
    bridgeAgent.status = 'running';
    bridgeAgent.abortController = abortController;
    const completedTask = {
      id: 'task-project',
      sessionId: 'session-a',
      kind: 'sub_agent',
      status: 'cancelled',
      ownerVpId: 'vp-project',
      runtime: { subAgentId: bridgeAgent.id },
      source: { threadId: 'main' },
    };
    const completeTask = vi.fn(() => completedTask);
    __testSetSession({
      taskManager: {
        getTask: () => ({ ...completedTask, status: 'running' }),
        completeTask,
        cancelTask: vi.fn(),
      },
    });
    handleYeaftTaskCancel({
      sessionId: 'session-a',
      taskId: 'task-project',
      clientRequestId: 'stop-project-agent',
    });
    expect(abortController.signal.aborted).toBe(true);
    expect(abortController.signal.reason).toBe('stopped_by_user');
    expect(bridgeAgent.status).toBe('closed');
    expect(completeTask).toHaveBeenCalledWith('session-a', 'task-project', { status: 'cancelled' });
    expect(ctx.messageBuffer.some(frame => frame.event?.type === 'yeaft_task_cancel_result'
      && frame.event.success === true
      && frame.event.task?.status === 'cancelled')).toBe(true);

    expect(__testHooks.buildProjectSharedBlock({
      projectId: beta.id,
      projectName: 'Beta',
      sessionIds: [],
    })).toContain(`Project: Beta (${beta.id})`);
    expect(__testHooks.buildProjectSharedBlock({
      projectId: beta.id,
      projectName: 'Beta',
      sessionIds: ['session-b'],
    }, '[Session session-b]\n共享发布决策')).toContain('this Project on this Agent only');
    expect(await __testHooks.sharedProjectContext(root, 'session-outside', {
      language: 'zh',
      sessionIds: ['session-b'],
    })).toBe('[Session session-b]\n共享发布决策');
    rmSync(join(siblingSummary, 'summary.zh.md'));
    writeFileSync(join(siblingSummary, 'summary.md'), 'English fallback decision\n');
    expect(await __testHooks.sharedProjectContext(root, 'session-a', { language: 'zh' }))
      .toBe('[Session session-b]\nEnglish fallback decision');
    writeFileSync(join(siblingSummary, 'memory.md'), 'private transcript and tool output\n');
    expect(await __testHooks.sharedProjectContext(root, 'session-a', { language: 'zh' }))
      .not.toContain('private transcript and tool output');
    writeFileSync(join(siblingSummary, 'summary.md'), 'x'.repeat(32_000));
    const smallBudgetContext = await __testHooks.sharedProjectContext(root, 'session-a', { tokenBudget: 64 });
    expect(smallBudgetContext).toContain('[Summary truncated to Project context budget]');
    expect(estimateTokens(smallBudgetContext)).toBeLessThanOrEqual(64);
    const defaultBudgetContext = await __testHooks.sharedProjectContext(root, 'session-a');
    expect(defaultBudgetContext).toContain('[Summary truncated to Project context budget]');
    expect(estimateTokens(defaultBudgetContext)).toBeLessThanOrEqual(4096);
    expect(estimateTokens(defaultBudgetContext)).toBeGreaterThan(64);
    renameProject(root, beta.id, 'Beta 2');
    updateProjectInstruction(root, beta.id, '  Follow the Project release checklist.  ');
    removeSessionFromProjects(root, 'session-a');
    expect(loadProjects(root)[1]).toEqual(expect.objectContaining({
      name: 'Beta 2',
      instruction: 'Follow the Project release checklist.',
      sessionIds: ['session-b'],
    }));
    expect(() => updateProjectInstruction(root, beta.id, 'x'.repeat(20_001)))
      .toThrow('must not exceed 20000 characters');
    deleteProject(root, beta.id);
    expect(loadProjects(root).map(project => project.id)).toEqual([alpha.id]);
  });


  it('projects only durable Dream messages and chunks one oversized source', () => {
    const messages = [
      { id: 'm1', role: 'user', body: 'Keep this user request.' },
      { id: 'm2', role: 'tool', body: 'x'.repeat(10_000) },
      { id: 'm3', role: 'assistant', body: 'Keep this assistant answer.', kind: 'overlap' },
    ];
    expect(compressDreamMessages(messages).map(message => message.id)).toEqual(['m1', 'm3']);
    expect(selectDreamNewMessages([
      { id: 'm1', kind: 'overlap' },
      { id: 'm2', kind: 'new' },
    ]).map(message => message.id)).toEqual(['m2']);
    const bounded = boundDreamPrompt('HEAD' + 'x'.repeat(100) + 'TAIL', 32);
    expect(bounded.length).toBe(32);
    expect(bounded.startsWith('HEAD')).toBe(true);
    expect(bounded.endsWith('TAIL')).toBe(true);

    const batches = batchSourcesForApply({
      memoryMd: 'current memory',
      summaryMd: 'summary',
      sources: [{ sessionId: 's1', diff: Array.from({ length: 20 }, (_, i) => ({
        id: `m${i}`,
        role: 'user',
        body: 'message '.repeat(20),
      })) }],
    }, 40);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat().map(source => source.diff.length).reduce((sum, count) => sum + count, 0)).toBe(20);
  });

  it('connects only allowlisted MCP servers for a normal Session', async () => {
    const root = makeDir();
    writeFileSync(join(root, 'config.json'), `${JSON.stringify({
      providers: [{
        name: 'test-provider',
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'test-key',
        protocol: 'openai-responses',
        models: ['gpt-5'],
      }],
      primaryModel: 'test-provider/gpt-5',
      plugins: { mcpServers: ['github'] },
      mcpServers: [
        { name: 'github', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] },
        { name: 'slack', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] },
      ],
    }, null, 2)}\n`);

    const connected = [];
    const originalConnectAll = MCPManager.prototype.connectAll;
    const originalDisconnectAll = MCPManager.prototype.disconnectAll;
    MCPManager.prototype.connectAll = async function connectAll(servers) {
      connected.push(...servers.map(server => server.name));
      return { connected: servers.map(server => server.name), failed: [] };
    };
    MCPManager.prototype.disconnectAll = async function disconnectAll() {};
    let session = null;
    try {
      session = await loadSession({ dir: root, skipSkills: true });
      expect(connected).toEqual(['github']);
      expect(session.status.mcpServers).toEqual(['github']);
    } finally {
      await session?.shutdown?.();
      MCPManager.prototype.connectAll = originalConnectAll;
      MCPManager.prototype.disconnectAll = originalDisconnectAll;
    }
  });

  it('uses the user-level Session config for reads, writes, and metadata updates', () => {
    {
      const root = makeDir();
      const workDir = tempRoot('yeaft-session-config-workdir-');
      const { projectYeaftDir, sessionId } = createProjectSessionArtifact(root, workDir, 'session-workdir-first');

      writeFileSync(join(projectYeaftDir, 'sessions', sessionId, 'config.json'), `${JSON.stringify({ model: 'project/claude-sonnet', modelEffort: 'high' }, null, 2)}\n`);
      writeFileSync(join(root, 'sessions', sessionId, 'config.json'), `${JSON.stringify({ model: 'agent/gpt-5', modelEffort: 'low' }, null, 2)}\n`);

      const config = loadSessionConfig(root, sessionId);

      expect(config).toEqual({ model: 'agent/gpt-5', modelEffort: 'low' });
    }

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-29T10:00:00.000Z'));
      const root = makeDir();
      const workDir = tempRoot('yeaft-session-config-workdir-');
      const { projectYeaftDir, sessionId } = createProjectSessionArtifact(root, workDir, 'session-workdir-update');
      writeFileSync(join(projectYeaftDir, 'sessions', sessionId, 'config.json'), `${JSON.stringify({ model: 'project/stale', modelEffort: 'low' }, null, 2)}\n`);
      expect(snapshotSessions(root).find(session => session.id === sessionId).metadataUpdatedAt)
        .toBe('2026-07-29T10:00:00.000Z');

      vi.setSystemTime(new Date('2026-07-29T11:00:00.000Z'));
      renameSession(root, sessionId, 'Renamed');
      expect(snapshotSessions(root).find(session => session.id === sessionId).metadataUpdatedAt)
        .toBe('2026-07-29T11:00:00.000Z');

      vi.setSystemTime(new Date('2026-07-29T12:00:00.000Z'));
      const saved = updateSessionConfig(root, sessionId, { model: 'agent/claude-haiku', modelEffort: 'max' });

      expect(saved).toEqual({ model: 'agent/claude-haiku', modelEffort: 'max' });
      expect(loadSessionConfig(root, sessionId)).toEqual({ model: 'agent/claude-haiku', modelEffort: 'max' });
      expect(JSON.parse(readFileSync(join(projectYeaftDir, 'sessions', sessionId, 'config.json'), 'utf8')))
        .toEqual({ model: 'project/stale', modelEffort: 'low' });
      expect(JSON.parse(readFileSync(join(root, 'sessions', sessionId, 'config.json'), 'utf8')))
        .toEqual({ model: 'agent/claude-haiku', modelEffort: 'max', modelSource: 'explicit' });
      expect(snapshotSessions(root).find(session => session.id === sessionId).metadataUpdatedAt)
        .toBe('2026-07-29T12:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }

    const provenanceRoot = makeDir();
    mkdirSync(join(provenanceRoot, 'sessions', 'session-provenance'), { recursive: true });
    expect(() => saveSessionConfig(provenanceRoot, 'session-provenance', {
      model: 'github-copilot/gpt-new',
      modelSource: 'explicit',
    })).toThrow('unknown config key: modelSource');
  });


  it('rebuilds the live normal Session runtime with the updated MCP allowlist', async () => {
    const root = makeDir();
    const connectedByRuntime = [];
    const disconnectedRuntimes = [];
    let nextRuntimeId = 0;
    const createMcpManager = () => {
      const id = ++nextRuntimeId;
      return {
        async connectAll(servers) {
          connectedByRuntime.push({ id, servers: servers.map(server => server.name) });
          return { connected: servers.map(server => server.name), failed: [] };
        },
        async disconnectAll() { disconnectedRuntimes.push(id); },
        status: () => [],
      };
    };
    const liveSession = {
      yeaftDir: root,
      config: {
        dir: root,
        model: 'test-provider/gpt-5',
        primaryModel: 'test-provider/gpt-5',
        plugins: { mcpServers: ['github'] },
      },
      adapter: { refreshProviders() {} },
      engine: { refreshConfig: vi.fn() },
      trace: { refreshConfig() {} },
      toolRegistry: { size: 0, replaceMcpTools: vi.fn(() => ({})) },
      skillManager: { size: 0, list: () => [] },
      mcpManager: { disconnectAll: vi.fn() },
      status: {},
    };
    writeFileSync(join(root, 'config.json'), `${JSON.stringify({
      providers: [{
        name: 'test-provider',
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'test-key',
        protocol: 'openai-responses',
        models: ['gpt-5'],
      }],
      primaryModel: 'test-provider/gpt-5',
      mcpServers: [
        { name: 'github', command: 'github' },
        { name: 'slack', command: 'slack' },
      ],
      plugins: { mcpServers: ['slack'] },
    }, null, 2)}\n`);
    ctx.CONFIG = { yeaftDir: root };
    __testSetSession(liveSession);
    __testHooks.setRuntimeFactoriesForTest({
      createSkillManager: () => ({ size: 0, list: () => [] }),
      createMcpManager,
      loadMcpConfig: () => ({
        servers: [
          { name: 'github', command: 'github' },
          { name: 'slack', command: 'slack' },
        ],
        skipped: [],
      }),
    });
    try {
      await refreshLiveSessionConfig();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(connectedByRuntime).toHaveLength(1);
      expect(connectedByRuntime[0].servers).toEqual(['slack']);
      expect(disconnectedRuntimes).toEqual([]);
    } finally {
      __testHooks.resetRuntimeFactoriesForTest();
    }
  });

  it('refreshes an existing VP Engine through update_yeaft_plugins before its next turn', async () => {
    const root = makeDir();
    const sessionId = 'session-live-plugin-policy';
    const streamCalls = [];
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'SensitiveTool',
      description: 'Sensitive Tool',
      parameters: { type: 'object', properties: {} },
      execute: async () => { executions += 1; return 'executed'; },
    }));
    const adapter = {
      refreshProviders() {},
      async *stream(request) {
        streamCalls.push(request);
        if (streamCalls.length === 1) {
          yield { type: 'text_delta', text: 'initial turn' };
          yield { type: 'stop', stopReason: 'end_turn' };
          return;
        }
        if (streamCalls.length === 2) {
          yield { type: 'tool_call', id: 'blocked-tool', name: 'SensitiveTool', input: {} };
          yield { type: 'stop', stopReason: 'tool_use' };
          return;
        }
        if (streamCalls.length === 3) {
          yield { type: 'text_delta', text: 'blocked turn complete' };
          yield { type: 'stop', stopReason: 'end_turn' };
          return;
        }
        yield { type: 'text_delta', text: 'restored turn' };
        yield { type: 'stop', stopReason: 'end_turn' };
      },
      async call() { return { text: '', usage: {} }; },
    };
    const transport = {
      ws: ctx.ws,
      serverEncryptionRequired: ctx.serverEncryptionRequired,
      outboundSendQueue: ctx.outboundSendQueue,
      outboundSendQueueActive: ctx.outboundSendQueueActive,
      CONFIG: ctx.CONFIG,
    };
    const sent = [];
    writeFileSync(join(root, 'config.json'), `${JSON.stringify({
      providers: [{ name: 'test-provider', baseUrl: 'https://example.invalid/v1', apiKey: 'test-key', protocol: 'openai-responses', models: ['gpt-5'] }],
      primaryModel: 'test-provider/gpt-5',
    }, null, 2)}\n`);
    ctx.CONFIG = { yeaftDir: root };
    ctx.ws = { readyState: 1, send(raw) { sent.push(JSON.parse(raw)); } };
    ctx.serverEncryptionRequired = false;
    ctx.outboundSendQueue = [];
    ctx.outboundSendQueueActive = false;
    __testSetSession({
      yeaftDir: root,
      adapter,
      trace: new NullTrace(),
      config: loadConfig({ dir: root }),
      engine: { refreshConfig: vi.fn() },
      conversationStore: {
        append: record => ({ id: `message-${record.role}`, ...record }),
        loadRecentBySession: () => [],
      },
      memoryIndex: null,
      amsRegistry: null,
      toolRegistry: registry,
      skillManager: null,
      mcpManager: { disconnectAll: async () => {}, status: () => [] },
      taskManager: { renderActiveTasksForPrompt: () => '' },
      toolStats: null,
      status: { skills: 0, mcpServers: [], mcpFailed: [], tools: 1 },
    });
    __testHooks.setRuntimeFactoriesForTest({
      createSkillManager: () => ({ size: 0, list: () => [] }),
      createMcpManager: () => ({
        connectAll: async () => ({ connected: [], failed: [] }),
        disconnectAll: async () => {},
        status: () => [],
      }),
      loadMcpConfig: () => ({ servers: [], skipped: [] }),
    });
    try {
      const engine = __testGetOrCreateVpEngine(sessionId, 'vp-a', 'main');
      for await (const _event of engine.query({ prompt: 'initial', sessionId })) {}
      expect(streamCalls[0].tools?.map(tool => tool.name) || []).toEqual(['SensitiveTool']);

      await handleMessage({ type: 'update_yeaft_plugins', plugins: { tools: [] } });
      await new Promise(resolve => setTimeout(resolve, 10));
      const blockedEvents = [];
      for await (const event of engine.query({ prompt: 'attempt after disable', sessionId })) blockedEvents.push(event);
      expect(streamCalls[1].tools).toBeUndefined();
      expect(executions).toBe(0);
      expect(blockedEvents.find(event => event.type === 'tool_end')).toMatchObject({
        name: 'SensitiveTool',
        isError: true,
        output: expect.stringContaining('not active for this request'),
      });

      await handleMessage({ type: 'update_yeaft_plugins', plugins: {} });
      await new Promise(resolve => setTimeout(resolve, 10));
      for await (const _event of engine.query({ prompt: 'after restore', sessionId })) {}
      expect(streamCalls.at(-1).tools.map(tool => tool.name)).toEqual(['SensitiveTool']);
      expect(sent.filter(frame => frame.type === 'yeaft_plugins_updated')).toHaveLength(2);
    } finally {
      __testHooks.resetRuntimeFactoriesForTest();
      ctx.ws = transport.ws;
      ctx.serverEncryptionRequired = transport.serverEncryptionRequired;
      ctx.outboundSendQueue = transport.outboundSendQueue;
      ctx.outboundSendQueueActive = transport.outboundSendQueueActive;
      ctx.CONFIG = transport.CONFIG;
    }
  });

  it('removes a stale bare managed override from persisted Session config', () => {
    const root = makeDir();
    const sessionId = 'session-stale-bare';
    mkdirSync(join(root, 'sessions', sessionId), { recursive: true });
    saveSessionConfig(root, sessionId, { model: 'gpt-old' });
    const currentConfig = {
      providers: [{ name: 'github-copilot', credentialProvider: 'github-copilot', models: ['gpt-new'] }],
      primaryModel: 'github-copilot/gpt-new',
      availableModels: [{ id: 'gpt-new', ref: 'github-copilot/gpt-new', provider: 'github-copilot' }],
    };

    expect(normalizeSessionConfig(root, sessionId, currentConfig)).toEqual({});
    expect(loadSessionConfig(root, sessionId)).toEqual({});
  });


  it('refreshes cached VP Engines through Session config updates without retirement', () => {
    const root = makeDir();
    const sessionId = 'session-live-config';
    mkdirSync(join(root, 'sessions', sessionId), { recursive: true });
    ctx.CONFIG = { ...originalConfig, yeaftDir: root };
    const currentConfig = {
      dir: root,
      model: 'provider/old',
      primaryModel: 'provider/old',
      providers: [{ name: 'provider', models: ['old', 'new'] }],
      availableModels: [
        { id: 'old', ref: 'provider/old', provider: 'provider' },
        { id: 'new', ref: 'provider/new', provider: 'provider' },
      ],
    };
    const adapter = { refreshProviders: vi.fn() };
    __testSetSession({
      config: currentConfig,
      adapter,
      trace: new NullTrace(),
      conversationStore: { loadRecentBySession: () => [] },
      memoryIndex: null,
      amsRegistry: null,
      toolRegistry: null,
      skillManager: null,
      mcpManager: null,
      taskManager: { renderActiveTasksForPrompt: () => '' },
      toolStats: null,
    });

    const engine = __testGetOrCreateVpEngine(sessionId, 'vp-a', 'main');
    const refreshConfig = vi.spyOn(engine, 'refreshConfig');
    const responseStart = ctx.messageBuffer.length;
    handleYeaftUpdateSessionConfig({
      sessionId,
      requestId: 'live-config-update',
      config: { model: 'provider/new' },
    });

    const response = ctx.messageBuffer.slice(responseStart)
      .map(frame => frame.event)
      .find(event => event?.type === 'session_crud_result');
    expect(response).toMatchObject({ op: 'update_config' });
    expect(__testGetOrCreateVpEngine(sessionId, 'vp-a', 'main')).toBe(engine);
    expect(engine.isRunning).toBe(false);
    if (response.ok) {
      expect(refreshConfig).toHaveBeenCalledWith(expect.objectContaining({ model: 'provider/new' }));
    } else {
      expect(response.error?.message).toBeTruthy();
      expect(refreshConfig).not.toHaveBeenCalled();
    }

    const effective = resolveSessionConfig(
      { model: 'agent/default', primaryModel: 'agent/default', modelEffort: 'high' },
      { model: 'provider/other-model' },
    );
    expect(effective.model).toBe('provider/other-model');
    expect(effective.primaryModel).toBe('provider/other-model');
    expect(effective.modelEffort).toBe('high');
  });

  it('never sends a removed managed-catalog override on the next turn', async () => {
    const root = makeDir();
    const sessionId = 'session-live-request';
    mkdirSync(join(root, 'sessions', sessionId), { recursive: true });
    saveSessionConfig(root, sessionId, { model: 'github-copilot/gpt-old' });
    writeFileSync(join(root, 'config.json'), `${JSON.stringify({
      providers: [{ name: 'github-copilot', credentialProvider: 'github-copilot', models: ['gpt-new'] }],
      primaryModel: 'github-copilot/gpt-new',
    }, null, 2)}\n`);
    ctx.CONFIG = { yeaftDir: root };
    const streamCalls = [];
    const adapter = {
      refreshProviders() {},
      async *stream(params) {
        streamCalls.push(params);
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'stop', stopReason: 'end_turn' };
      },
      async call() { return { text: '', usage: {} }; },
    };
    __testSetSession({
      yeaftDir: root,
      adapter,
      trace: new NullTrace(),
      config: {
        dir: root,
        model: 'gpt-old',
        primaryModel: 'github-copilot/gpt-old',
        fastModel: 'github-copilot/gpt-old',
        fastModelId: 'gpt-old',
        providers: [{ name: 'github-copilot', models: ['gpt-old'] }],
        availableModels: [{ id: 'gpt-old', ref: 'github-copilot/gpt-old', provider: 'github-copilot' }],
        _readOnly: true,
      },
      engine: { refreshConfig: vi.fn() },
      conversationStore: { loadRecentBySession: () => [] },
      memoryIndex: null,
      amsRegistry: null,
      toolRegistry: null,
      skillManager: null,
      mcpManager: null,
      taskManager: { renderActiveTasksForPrompt: () => '' },
      toolStats: null,
    });

    await refreshLiveSessionConfig();
    const engine = __testGetOrCreateVpEngine(sessionId, 'vp-a', 'main');
    for await (const _event of engine.query({ prompt: 'use the new model', sessionId })) {}

    expect(streamCalls).toHaveLength(1);
    expect(streamCalls[0].model).toBe('github-copilot/gpt-new');
    expect(streamCalls[0].model).not.toBe('github-copilot/gpt-old');
    expect(loadSessionConfig(root, sessionId)).toEqual({});
  });


  it('omits the Work Center producer tool by default and restores it when explicitly enabled', async () => {
    const root = makeDir();
    let disabledSession = null;
    let enabledSession = null;
    try {
      disabledSession = await loadSession({ dir: root, skipMCP: true, skipSkills: true });
      expect(disabledSession.toolRegistry.has('CreateWorkItem')).toBe(false);
      await disabledSession.shutdown();
      disabledSession = null;

      enabledSession = await loadSession({
        dir: root,
        skipMCP: true,
        skipSkills: true,
        workCenterEnabled: true,
      });
      expect(enabledSession.toolRegistry.has('CreateWorkItem')).toBe(true);
    } finally {
      await disabledSession?.shutdown?.();
      await enabledSession?.shutdown?.();
    }
  });

  it('flushes lifecycle telemetry through a Session config dir', async () => {
    const root = makeDir();
    const originalFetch = global.fetch;
    let session = null;
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      providers: [{
        name: 'session-test',
        baseUrl: 'https://session-test.invalid/v1',
        apiKey: 'test-key',
        protocol: 'openai-responses',
        models: ['gpt-5'],
      }],
      primaryModel: 'session-test/gpt-5',
      telemetry: { flushIntervalMs: 60_000 },
    }, null, 2));

    try {
      global.fetch = async () => new Response([
        'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}',
        '',
      ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      session = await loadSession({ dir: root, skipMCP: true, skipSkills: true });
      expect(session.config.dir).toBe(root);
      expect(session.config.yeaftDir).toBeUndefined();

      for await (const _event of session.engine.query({
        prompt: 'trace this lifecycle',
        sessionId: 'session-perf-trace',
        inboundEnvelope: { _perfTraceId: 'session-config-dir-trace' },
      })) { /* consume */ }
      await session.shutdown();
      session = null;

      const day = new Date().toISOString().slice(0, 10);
      const tracePath = join(root, 'perf-traces', `${day}.jsonl`);
      expect(existsSync(tracePath)).toBe(true);
      const rows = readFileSync(tracePath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(rows.filter(row => row.traceId === 'session-config-dir-trace').map(row => row.phase)).toEqual(expect.arrayContaining([
        'llm.request_start',
        'llm.first_event',
        'llm.request_complete',
      ]));
    } finally {
      global.fetch = originalFetch;
      await session?.shutdown?.();
    }
  });

  it('seeds stock VPs before loading the user-level runtime', async () => {
    const seedRoot = makeDir();
    const previousTransport = {
      ws: ctx.ws,
      serverEncryptionRequired: ctx.serverEncryptionRequired,
      outboundSendQueue: ctx.outboundSendQueue,
      outboundSendQueueActive: ctx.outboundSendQueueActive,
    };
    const send = vi.fn();
    ctx.CONFIG = { yeaftDir: seedRoot };
    ctx.ws = { readyState: 1, send };
    ctx.serverEncryptionRequired = false;
    ctx.outboundSendQueue = [];
    ctx.outboundSendQueueActive = false;

    try {
      handleYeaftVpSubscribe({ requestId: 'vp-cold-start' });
      await vi.waitFor(() => expect(send).toHaveBeenCalled());
      const frames = send.mock.calls.map(([raw]) => JSON.parse(raw));
      const snapshot = frames.find(frame => frame.event?.type === 'vp_snapshot');
      expect(snapshot.requestId).toBe('vp-cold-start');
      expect(snapshot.event.emptyLibrary).toBe(false);
      expect(snapshot.event.vps).toHaveLength(DEFAULT_VPS.length);
      expect(snapshot.event.vps.some(vp => vp.vpId === 'omni')).toBe(true);
      expect(existsSync(join(seedRoot, 'virtual-persons', 'omni', 'role.md'))).toBe(true);
    } finally {
      await __testResetVpState();
      ctx.ws = previousTransport.ws;
      ctx.serverEncryptionRequired = previousTransport.serverEncryptionRequired;
      ctx.outboundSendQueue = previousTransport.outboundSendQueue;
      ctx.outboundSendQueueActive = previousTransport.outboundSendQueueActive;
    }

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
      expect(session.yeaftDir).toBe(root);
      expect(session.skillManager.skillsDir).toBe(join(root, 'skills'));

      session.conversationStore.append({ role: 'user', content: 'user-level message', sessionId: 'session_cfg' });
      const userSegmentPath = join(root, 'sessions', 'session_cfg', 'conversation', 'segments', '000001.jsonl');
      const projectSegmentPath = join(workDir, '.yeaft', 'sessions', 'session_cfg', 'conversation', 'segments', '000001.jsonl');
      expect(existsSync(userSegmentPath)).toBe(true);
      expect(readFileSync(userSegmentPath, 'utf8')).toContain('user-level message');
      expect(existsSync(projectSegmentPath)).toBe(false);
    } finally {
      await session?.shutdown?.();
      rmSync(workDir, { recursive: true, force: true });
    }
  });

});
