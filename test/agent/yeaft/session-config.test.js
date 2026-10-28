import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ctx from '../../../agent/context.js';
import { loadConfig } from '../../../agent/yeaft/config.js';
import { getPluginConfig, updatePluginConfig } from '../../../agent/yeaft/config-api.js';
import { flushAllAgentPerfTraces } from '../../../agent/yeaft/perf-trace.js';
import { closeConversationHistoryIndexes } from '../../../agent/yeaft/conversation/history-index.js';
import { __testResetVpState, __testSetSession, handleYeaftManagedSkill, handleYeaftPluginCatalog } from '../../../agent/yeaft/web-bridge.js';
import { buildPluginCatalog, buildPluginSkillDetail } from '../../../agent/yeaft/plugins.js';
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

describe('Yeaft Plugin Skill details', () => {
  it('projects only public view fields, rejects missing/invalid names and bounds UTF-8 bodies', () => {
    const skill = {
      name: 'inspect', description: 'Inspect code', trigger: '/inspect/', keywords: ['code', { secret: true }],
      category: 'development', _tier: 'project', content: 'Body', _path: '/private/skill',
      _source: 'directory', internal: 'SECRET',
    };
    const view = vi.fn(() => ({ skill, references: ['guide.md', { secret: true }], templates: ['form.md'], linkedContent: 'SECRET' }));
    const runtime = { skillManager: { view } };
    expect(buildPluginSkillDetail(runtime, 'inspect')).toEqual({
      name: 'inspect', description: 'Inspect code', trigger: '/inspect/', keywords: ['code'],
      category: 'development', tier: 'project', content: 'Body', references: ['guide.md'], templates: ['form.md'],
    });
    expect(view).toHaveBeenLastCalledWith('inspect');
    view.mockClear();
    for (const name of [undefined, null, 123, {}, '', ' ', ' inspect', 'inspect ', '../inspect', 'folder/inspect', 'folder\\inspect', 'a\n', '..']) {
      expect(() => buildPluginSkillDetail(runtime, name)).toThrow('invalid skillName');
    }
    expect(view).not.toHaveBeenCalled();
    view.mockReturnValueOnce(null);
    expect(() => buildPluginSkillDetail(runtime, 'missing')).toThrow('skill not found: missing');
    expect(() => buildPluginSkillDetail(runtime, 'different')).toThrow('skill not found: different');
    const limit = 256 * 1024;
    for (const content of ['a'.repeat(limit), 'a'.repeat(limit + 1), '界'.repeat(Math.ceil(limit / 3)), '😀'.repeat(limit / 4 + 1), 'a'.repeat(limit - 2) + '😀suffix']) {
      skill.content = content;
      const detail = buildPluginSkillDetail(runtime, 'inspect');
      expect(Buffer.byteLength(detail.content, 'utf8')).toBeLessThanOrEqual(limit);
      expect(content.startsWith(detail.content)).toBe(true);
      expect(detail.content).not.toContain('\ufffd');
      if (Buffer.byteLength(content, 'utf8') > limit) expect(detail.contentTruncated).toBe(true);
      else expect(detail).not.toHaveProperty('contentTruncated');
    }
    // Catalog discovery remains metadata-only and never reads the body.
    view.mockClear();
    const catalog = buildPluginCatalog({ skillManager: { view, list: () => [{ ...skill, tier: 'project' }] } });
    expect(catalog.skills).toEqual([{ id: 'inspect', label: 'inspect', description: 'Inspect code', category: 'development', tier: 'project' }]);
    expect(view).not.toHaveBeenCalled();
    expect(JSON.stringify(catalog)).not.toContain('SECRET');
  });

  it('reads fresh effective project/user Skills on demand without initializing inference or changing allowlists', () => {
    const root = makeDir();
    const project = tempRoot('yeaft-plugin-skill-project-');
    const skillName = 'catalog-detail-unique';
    const writeSkill = (dir, body) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${skillName}\ndescription: Current layered Skill\ntrigger: inspect\nkeywords: [code, review]\ncategory: development\n---\n${body}`);
    };
    const userSkill = join(root, 'skills', skillName);
    const projectSkill = join(project, '.yeaft', 'skills', skillName);
    writeSkill(userSkill, 'USER_BODY');
    writeSkill(projectSkill, 'PROJECT_BODY');
    mkdirSync(join(projectSkill, 'references'));
    mkdirSync(join(projectSkill, 'templates'));
    writeFileSync(join(projectSkill, 'references', 'guide.md'), 'PRIVATE_LINKED_CONTENT');
    writeFileSync(join(projectSkill, 'templates', 'form.md'), 'PRIVATE_TEMPLATE_CONTENT');
    const original = {
      ws: ctx.ws, encryption: ctx.serverEncryptionRequired, buffer: ctx.messageBuffer,
      queue: ctx.outboundSendQueue, active: ctx.outboundSendQueueActive,
    };
    const plugins = { tools: [], skills: [], mcpServers: [] };
    const inferenceManager = { view: vi.fn(() => { throw new Error('inference manager must not be used'); }) };
    ctx.CONFIG = { ...(originalConfig || {}), yeaftDir: root };
    ctx.ws = { readyState: 1, send() {} };
    ctx.serverEncryptionRequired = false;
    ctx.messageBuffer = [];
    ctx.outboundSendQueue = [];
    ctx.outboundSendQueueActive = true;
    __testSetSession({ yeaftDir: root, config: { plugins }, skillManager: inferenceManager });
    const request = (fields) => {
      handleYeaftPluginCatalog({ requestId: 'detail-1', _requestClientId: 'browser-1', ...fields });
      return ctx.outboundSendQueue.at(-1).msg;
    };
    try {
      const catalog = request({ workDir: project });
      expect(catalog).toMatchObject({ type: 'yeaft_plugin_catalog_result', requestId: 'detail-1', _requestClientId: 'browser-1', error: null });
      expect(catalog).not.toHaveProperty('skillDetail');
      expect(catalog.catalog.skills.filter(row => row.id === skillName)).toHaveLength(1);
      expect(JSON.stringify(catalog)).not.toContain('PROJECT_BODY');
      const detail = request({ workDir: project, skillName, filePath: 'references/guide.md' });
      expect(detail.skillDetail).toEqual({
        name: skillName, description: 'Current layered Skill', trigger: 'inspect', keywords: ['code', 'review'],
        category: 'development', tier: 'project', content: 'PROJECT_BODY', references: ['guide.md'], templates: ['form.md'],
      });
      expect(detail.error).toBeNull();
      expect(JSON.stringify(detail)).not.toContain('PRIVATE_LINKED_CONTENT');
      expect(JSON.stringify(detail)).not.toContain('PRIVATE_TEMPLATE_CONTENT');
      expect(JSON.stringify(detail)).not.toContain('_path');
      writeSkill(projectSkill, 'PROJECT_UPDATED');
      expect(request({ workDir: project, skillName }).skillDetail.content).toBe('PROJECT_UPDATED');
      expect(request({ skillName }).skillDetail).toMatchObject({ content: 'USER_BODY', tier: 'user' });
      for (const skillName of ['not-installed-unique', '', null, 42, '../escape']) {
        expect(request({ workDir: project, skillName })).toMatchObject({ skillDetail: null, error: expect.any(String), _requestClientId: 'browser-1' });
      }
      expect(plugins).toEqual({ tools: [], skills: [], mcpServers: [] });
      expect(inferenceManager.view).not.toHaveBeenCalled();
    } finally {
      ctx.ws = original.ws;
      ctx.serverEncryptionRequired = original.encryption;
      ctx.messageBuffer = original.buffer;
      ctx.outboundSendQueue = original.queue;
      ctx.outboundSendQueueActive = original.active;
    }
  });
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
