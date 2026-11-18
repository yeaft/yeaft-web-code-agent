import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ctx from '../../../agent/context.js';
import { loadConfig } from '../../../agent/yeaft/config.js';
import { getLlmConfig, getPluginConfig, updateLlmConfig, updatePluginConfig } from '../../../agent/yeaft/config-api.js';
import { addOrUpdateProvider, useGemini } from '../../../agent/llm-config-cli.js';
import { AdapterRouter } from '../../../agent/yeaft/llm/router.js';
import { GeminiAdapter } from '../../../agent/yeaft/llm/gemini.js';
import { OpenAIResponsesAdapter } from '../../../agent/yeaft/llm/openai-responses.js';
import { flushAllAgentPerfTraces } from '../../../agent/yeaft/perf-trace.js';
import { closeConversationHistoryIndexes } from '../../../agent/yeaft/conversation/history-index.js';
import { __testHooks, __testResetVpState, __testSetSession, handleYeaftLoadHistory, handleYeaftManagedSkill, handleYeaftPluginCatalog, handleYeaftUpdateSessionConfig, validateQuickSend } from '../../../agent/yeaft/web-bridge.js';
import { buildPluginCatalog, buildPluginSkillDetail } from '../../../agent/yeaft/plugins.js';
import { _resetAgentRegistry } from '../../../agent/yeaft/tools/agent.js';
import { loadSessionConfig, resolveSessionConfig, saveSessionConfig } from '../../../agent/yeaft/sessions/session-config.js';
import { createSession } from '../../../agent/yeaft/sessions/session-store.js';
import { sessionsRoot, updateSessionConfig } from '../../../agent/yeaft/sessions/session-crud.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';

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

describe('Yeaft Skill bootstrap', () => {
  it('replays enabled Skills for a warm cached project runtime on every browser bootstrap', async () => {
    const root = makeDir();
    const workDir = join(root, 'workspace');
    const handle = createSession(sessionsRoot(root), { id: 'warm-session', name: 'Warm Session', workDir, roster: [] });
    const meta = handle.getMeta();
    handle.close();
    const original = { ws: ctx.ws, encryption: ctx.serverEncryptionRequired,
      queue: ctx.outboundSendQueue, active: ctx.outboundSendQueueActive };
    writeFileSync(join(root, 'config.json'), JSON.stringify({ plugins: { skills: ['daily-brief'] } }));
    ctx.CONFIG = { yeaftDir: root };
    ctx.ws = { readyState: 1, send() {} };
    ctx.serverEncryptionRequired = false;
    ctx.outboundSendQueue = [];
    ctx.outboundSendQueueActive = true;
    __testSetSession({ yeaftDir: root, config: { plugins: { skills: ['daily-brief'] } },
      skillManager: { list: () => [{ name: 'wrong-base', tier: 'user' }] },
      status: { skills: 1, tools: 0, mcpServers: [] } });
    __testHooks.setYeaftConversationIdForTest('warm-bridge');
    __testHooks.seedProjectRuntime(workDir, { skillManager: { list: () => [
      { name: 'daily-brief', tier: 'user' }, { name: 'disabled', tier: 'user' },
    ] } });
    try {
      for (const requestId of ['initial', 'browser-reload', 'reconnect']) {
        ctx.outboundSendQueue = [];
        await handleYeaftLoadHistory({ sessionId: meta.id, requestId, limit: 0 });
        await vi.waitFor(() => expect(ctx.outboundSendQueue.some(row => row.msg.type === 'slash_commands_update')).toBe(true));
        const update = ctx.outboundSendQueue.find(row => row.msg.type === 'slash_commands_update').msg;
        expect(update).toMatchObject({ commandSet: 'yeaft', conversationId: 'warm-bridge', slashCommands: ['yeaft-skills:daily-brief'] });
        await vi.waitFor(() => expect(ctx.outboundSendQueue.some(row => row.msg.event?.type === 'session_ready')).toBe(true));
      }
    } finally {
      ctx.ws = original.ws;
      ctx.serverEncryptionRequired = original.encryption;
      ctx.outboundSendQueue = original.queue;
      ctx.outboundSendQueueActive = original.active;
    }
  });
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

describe('Model-level Gemini options', () => {
  it('sanitizes and persists JSON options, then forwards fresh config-only copies on native call and stream', async () => {
    const root = makeDir();
    const modelId = 'gemini-2.5-flash';
    const expected = {
      serviceTier: 'flex',
      safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' }],
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['search'] } },
      generationConfig: { topP: 0.8, stopSequences: ['END'], presencePenalty: -0.5, frequencyPenalty: 0.2,
        responseLogprobs: true, logprobs: 0, mediaResolution: 'MEDIA_RESOLUTION_MEDIUM',
        responseMimeType: 'application/json', responseSchema: { type: 'OBJECT', properties: { model: { type: 'STRING' } } },
        thinkingConfig: { thinkingBudget: 0, includeThoughts: false } },
    };
    const dirty = {
      ...expected, model: 'forged', contents: [], systemInstruction: {}, tools: [], cachedContent: 'forged', store: true, continuationToken: 'forged',
      safetySettings: [...expected.safetySettings, { category: 'bogus', threshold: 'BLOCK_NONE' }],
      toolConfig: { ...expected.toolConfig, betaField: true },
      generationConfig: { ...expected.generationConfig, temperature: '0.5', imageConfig: {}, speechConfig: {},
        responseModalities: ['TEXT', 'IMAGE'], maxOutputTokens: 9000, candidateCount: 2, _responseJsonSchema: {} },
    };
    const second = { generationConfig: { responseJsonSchema: { type: 'object', additionalProperties: false } } };
    const provider = { name: 'fixture', baseUrl: 'https://gemini.invalid/v1', apiKey: 'fixture-key', protocol: 'gemini',
      models: [{ id: modelId, geminiOptions: dirty }, { id: 'other-native', geminiOptions: second },
        { id: 'gemini-compat', protocol: 'openai-responses', geminiOptions: expected }, 'no-options'] };
    expect(updateLlmConfig({ providers: [provider], primaryModel: `fixture/${modelId}` }, root).error).toBeUndefined();
    expect(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')).providers[0].models[0]).toEqual({ id: modelId, geminiOptions: expected });
    expect(getLlmConfig(root).agentConfig.providers[0].models[1]).toEqual({ id: 'other-native', geminiOptions: second });

    const nativeCall = vi.spyOn(GeminiAdapter.prototype, 'call').mockResolvedValue({ text: 'fixture' });
    const nativeStream = vi.spyOn(GeminiAdapter.prototype, 'stream').mockImplementation(async function* () { yield { type: 'done' }; });
    const responsesCall = vi.spyOn(OpenAIResponsesAdapter.prototype, 'call').mockResolvedValue({ text: 'fixture' });
    try {
      const config = loadConfig({ dir: root });
      const router = new AdapterRouter({ providers: config.providers });
      const params = { messages: [], maxTokens: 123, geminiOptions: { serviceTier: 'priority' } };
      config.providers[0].models[0].geminiOptions.generationConfig.stopSequences[0] = 'config mutation';
      await router.call({ ...params, model: `fixture/${modelId}` });
      expect(nativeCall).toHaveBeenLastCalledWith(expect.objectContaining({ model: modelId, maxTokens: 123, geminiOptions: expected }));
      nativeCall.mock.calls[0][0].geminiOptions.generationConfig.stopSequences[0] = 'adapter mutation';
      for await (const event of router.stream({ ...params, model: `fixture/${modelId}` })) expect(event.type).toBe('done');
      expect(nativeStream).toHaveBeenLastCalledWith(expect.objectContaining({ model: modelId, geminiOptions: expected }));
      await router.call({ ...params, model: 'fixture/other-native' });
      expect(nativeCall.mock.lastCall[0].geminiOptions).toEqual(second);
      await router.call({ ...params, model: 'fixture/no-options' });
      expect(nativeCall.mock.lastCall[0]).not.toHaveProperty('geminiOptions');
      await router.call({ ...params, model: 'fixture/gemini-compat' });
      expect(responsesCall.mock.lastCall[0]).not.toHaveProperty('geminiOptions');
    } finally {
      nativeCall.mockRestore();
      nativeStream.mockRestore();
      responsesCall.mockRestore();
    }
  });

  it('keeps legacy Gemini Max Quick Sends usable without advertising a nonexistent level', () => {
    const root = makeDir();
    const model = 'google/gemini-3.1-pro-preview';
    const quickSend = { id: 'q1', name: 'Existing shortcut', model, effort: 'max', maxOutputTokens: null };
    writeFileSync(join(root, 'config.json'), JSON.stringify({ providers: [{ name: 'google', protocol: 'gemini',
      apiKey: 'fixture', models: ['gemini-3.1-pro-preview'] }], quickSends: [quickSend] }));
    const cfg = getLlmConfig(root);
    expect(cfg.quickSends).toEqual([{ ...quickSend, effort: 'high' }]);
    expect(cfg.availableModels[0].effortOptions).not.toContain('max');
    expect(validateQuickSend(quickSend, loadConfig({ dir: root }))).toEqual({ model, effort: 'high', maxOutputTokens: null });
    expect(updateLlmConfig({ quickSends: [{ ...quickSend, name: 'Renamed' }] }, root).quickSends)
      .toEqual([{ ...quickSend, name: 'Renamed', effort: 'high' }]);
    const duplicate = { ...cfg.providers[0], models: ['gemini-3.1-pro-preview', 'gemini-3.1-pro-preview'] };
    expect(updateLlmConfig({ providers: [duplicate], quickSends: [quickSend] }, root).error).toContain('unambiguous');
    const hydrogen = 'google/gemini-4-hydrogen';
    const ambiguous = { ...quickSend, model: hydrogen, effort: 'high' };
    writeFileSync(join(root, 'config.json'), JSON.stringify({ providers: [{ ...duplicate,
      models: ['gemini-4-hydrogen', 'gemini-4-hydrogen'] }], quickSends: [ambiguous] }));
    expect(getLlmConfig(root).quickSends).toEqual([{ ...ambiguous, available: false }]);
    expect(() => validateQuickSend(ambiguous, loadConfig({ dir: root }))).toThrow('unambiguous');
  });

  it('keeps configured options by model ID through CLI edits and Gemini discovery', async () => {
    const model = 'gemini-2.5-flash';
    const geminiOptions = { generationConfig: { responseModalities: ['TEXT'] } };
    const config = { providers: [{ name: 'google', protocol: 'gemini', models: [{ id: model, geminiOptions }] }] };
    const edit = addOrUpdateProvider(config, { name: 'google', protocol: 'gemini', models: `${model},new-model`, apiKey: 'fixture' });
    expect(edit.provider.models).toEqual([{ id: model, geminiOptions }, 'new-model']);
    const fetchFn = vi.fn(async () => Response.json({ models: [{ name: `models/${model}`,
      supportedGenerationMethods: ['generateContent'], outputTokenLimit: 1024 }] }));
    const discovered = await useGemini(config, { model, apiKey: 'fixture', baseUrl: 'https://gemini.invalid/v1', fetchFn });
    expect(discovered.provider.models).toEqual([{ id: model, protocol: 'gemini', maxOutput: 1024, geminiOptions }]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
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

  it('round-trips an effort-only update against the inherited provider without pinning its model', () => {
    const root = makeDir();
    const sessionId = 'inherited-effort';
    const modelId = 'gemini-4-hydrogen';
    const providers = [
      { name: 'proxy', protocol: 'openai-responses', models: [modelId] },
      { name: 'google', protocol: 'gemini', models: [modelId] },
    ];
    createSession(sessionsRoot(root), { id: sessionId, roster: ['omni'] }).close();
    const keys = ['CONFIG', 'ws', 'outboundSendQueue', 'outboundSendQueueActive', 'serverEncryptionRequired', 'serverCapabilities'];
    const previous = Object.fromEntries(keys.map(key => [key, ctx[key]]));
    Object.assign(ctx, { CONFIG: { yeaftDir: root }, ws: { readyState: 1, send() {} }, outboundSendQueue: [],
      outboundSendQueueActive: true, serverEncryptionRequired: false, serverCapabilities: new Set(['yeaft_session_config_delta']) });
    try {
      for (const [primaryModel, expected] of [[`google/${modelId}`, ['low', 'high']], [modelId, ['medium', 'xhigh']]]) {
        writeFileSync(join(root, 'config.json'), JSON.stringify({ providers, primaryModel }));
        const config = loadConfig({ dir: root });
        __testSetSession({ yeaftDir: root, config });
        for (const [index, effort] of ['low', 'high'].entries()) {
          const saved = { modelEffort: expected[index] };
          handleYeaftUpdateSessionConfig({ sessionId, requestId: `${primaryModel}:${effort}`, config: { modelEffort: effort } });
          expect(ctx.outboundSendQueue.at(-1)?.msg.event).toMatchObject({ ok: true, sessionId, config: saved });
          expect(JSON.parse(readFileSync(join(sessionsRoot(root), sessionId, 'config.json'), 'utf8'))).toEqual(saved);
          expect(loadSessionConfig(root, sessionId)).toEqual(saved);
          expect(resolveSessionConfig(config, saved)).toMatchObject({ model: primaryModel, ...saved });
        }
      }
    } finally { Object.assign(ctx, previous); }
  });

  it('bounds a model/effort edit to the target metadata/config and never repairs unrelated inventory or logs', () => {
    const root = makeDir();
    const sessionId = 'session_model_target';
    const target = join(root, 'sessions', sessionId);
    createSession(sessionsRoot(root), { id: sessionId, roster: ['omni'] }).close();
    const metadata = join(target, 'session.json');
    const before = JSON.parse(readFileSync(metadata, 'utf8'));
    writeFileSync(metadata, JSON.stringify({ ...before, metadataUpdatedAt: '2000-01-01T00:00:00.000Z' }));
    const logIndex = join(target, 'messages', 'index.json');
    writeFileSync(logIndex, 'DO_NOT_REBUILD_TARGET_LOG');
    // Manifest contents and all sibling data are deliberately unusable. A
    // settings edit must not load, bootstrap or repair any of them.
    writeFileSync(join(root, 'sessions-manifest.json'), 'DO_NOT_READ_MANIFEST');
    const sibling = join(root, 'sessions', 'session_broken_sibling');
    mkdirSync(join(sibling, 'messages'), { recursive: true });
    writeFileSync(join(sibling, 'messages', '000001.jsonl'), '{"id":"m1","text":"unrelated"}\n');
    const keys = ['CONFIG', 'ws', 'outboundSendQueue', 'outboundSendQueueActive', 'serverEncryptionRequired', 'serverCapabilities'];
    const previous = Object.fromEntries(keys.map(key => [key, ctx[key]]));
    ctx.CONFIG = { yeaftDir: root };
    ctx.ws = { readyState: 1, send() {} };
    ctx.outboundSendQueue = [];
    ctx.outboundSendQueueActive = true;
    ctx.serverEncryptionRequired = false;
    ctx.serverCapabilities = new Set(['yeaft_session_config_delta']);
    __testSetSession({ yeaftDir: root, config: { dir: root, model: 'test/old', modelEffort: 'medium' } });
    const reads = [];
    const originalRead = fs.readFileSync;
    const read = vi.spyOn(fs, 'readFileSync').mockImplementation((path, ...args) => {
      reads.push(String(path));
      return originalRead(path, ...args);
    });
    const readdir = vi.spyOn(fs, 'readdirSync');
    syncBuiltinESMExports();
    try {
      handleYeaftUpdateSessionConfig({ sessionId, requestId: 'target-edit', _requestClientId: 'browser-1',
        config: { model: 'test/new', modelEffort: 'xhigh' } });
      expect(reads.every(path => [metadata, join(target, 'config.json')].includes(path))).toBe(true);
      expect(reads.length).toBeLessThanOrEqual(4);
      expect(readdir).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
      readdir.mockRestore();
      syncBuiltinESMExports();
    }
    try {
      expect(ctx.outboundSendQueue).toHaveLength(1);
      const frame = ctx.outboundSendQueue[0].msg;
      expect(frame).not.toHaveProperty('_requestClientId'); // Existing owner broadcast reaches every tab.
      expect(frame.event).toMatchObject({ type: 'session_crud_result', op: 'update_config', ok: true,
        requestId: 'target-edit', sessionId, config: { model: 'test/new', modelEffort: 'xhigh' },
        session: { ...before, config: { model: 'test/new', modelEffort: 'xhigh' }, metadataUpdatedAt: expect.any(String) } });
      expect(frame.event.session.metadataUpdatedAt).not.toBe('2000-01-01T00:00:00.000Z');
      expect(loadSessionConfig(root, sessionId)).toEqual(frame.event.config);
      expect(JSON.parse(readFileSync(metadata, 'utf8'))).toMatchObject({ metadataUpdatedAt: frame.event.session.metadataUpdatedAt });
      expect(readFileSync(logIndex, 'utf8')).toBe('DO_NOT_REBUILD_TARGET_LOG');
      expect(existsSync(join(sibling, 'session.json'))).toBe(false);
      expect(existsSync(join(sibling, 'messages', 'index.json'))).toBe(false);
      for (const id of ['../escape', '..\\escape', 'session_missing']) {
        expect(() => updateSessionConfig(root, id, { model: 'test/nope' })).toThrow();
      }
      expect(() => updateSessionConfig(root, sessionId, { unknown: true })).toThrow('unknown config key');
      expect(loadSessionConfig(root, sessionId)).toEqual(frame.event.config);
      expect(updateSessionConfig(root, sessionId, { model: null, modelEffort: '' })).toEqual({});
      // A rolling-upgrade peer without delta support still gets the old full
      // snapshot after the correlated ACK, so its shadow catalog stays current.
      ctx.serverCapabilities = new Set();
      ctx.outboundSendQueue = [];
      handleYeaftUpdateSessionConfig({ sessionId, requestId: 'old-server', config: { model: 'test/legacy', modelEffort: 'xhigh' } });
      expect(ctx.outboundSendQueue.map(row => row.msg.event.type)).toEqual(['session_crud_result', 'session_list_updated']);
      expect(ctx.outboundSendQueue[1].msg.event.sessions.find(row => row.id === sessionId).config)
        .toEqual({ model: 'test/legacy', modelEffort: 'xhigh' });
    } finally {
      Object.assign(ctx, previous);
    }
  });

  it('publishes persisted config to cached engines at the next provider boundary without aborting a running stream', async () => {
    const root = makeDir();
    const sessionId = 'session_live_model';
    const otherId = 'session_other_model';
    for (const id of [sessionId, otherId]) createSession(sessionsRoot(root), { id, roster: ['omni'] }).close();
    const otherConfig = { model: 'test/other', modelEffort: 'max' };
    saveSessionConfig(root, otherId, otherConfig);
    const keys = ['CONFIG', 'ws', 'outboundSendQueue', 'outboundSendQueueActive', 'serverEncryptionRequired', 'serverCapabilities'];
    const previous = Object.fromEntries(keys.map(key => [key, ctx[key]]));
    ctx.CONFIG = { yeaftDir: root };
    ctx.ws = { readyState: 1, send() {} };
    ctx.outboundSendQueue = [];
    ctx.outboundSendQueueActive = true;
    ctx.serverEncryptionRequired = false;
    const requests = [];
    const adapter = { async *stream(params) {
      requests.push(params);
      if (requests.length === 1) {
        // Refresh while the provider request is in flight, not between queries.
        handleYeaftUpdateSessionConfig({ sessionId, requestId: 'live-edit', config: { model: 'test/new', modelEffort: 'ultra' } });
        expect(params).toMatchObject({ model: 'test/old', effort: 'medium' });
        expect(params.signal.aborted).toBe(false);
        yield { type: 'text_delta', text: 'old stream completed' };
        yield { type: 'tool_call', id: 'loop', name: 'echo', input: {} };
        yield { type: 'stop', stopReason: 'tool_use' };
      } else {
        yield { type: 'text_delta', text: 'new loop completed' };
        yield { type: 'stop', stopReason: 'end_turn' };
      }
    } };
    const config = { dir: root, model: 'test/old', primaryModel: 'test/old', modelEffort: 'medium', maxOutputTokens: 1024 };
    __testSetSession({ yeaftDir: root, config, adapter, trace: new NullTrace() });
    const getEngine = __testHooks.getOrCreateVpEngineForTest;
    const engine = getEngine(sessionId, 'omni');
    const backgroundThread = getEngine(sessionId, 'omni', 'background');
    const otherEngine = getEngine(otherId, 'omni');
    const targetRefresh = vi.spyOn(engine, 'refreshConfig');
    const backgroundRefresh = vi.spyOn(backgroundThread, 'refreshConfig');
    const otherRefresh = vi.spyOn(otherEngine, 'refreshConfig');
    const running = __testHooks.seedRunningVpTurn({ sessionId, vpId: 'omni' });
    const coordinator = __testHooks.seedSessionContext(sessionId, { id: sessionId, roster: ['omni'], defaultVpId: 'omni' });
    engine.registerTool({ name: 'echo', description: 'Continue test loop', parameters: { type: 'object' }, execute: async () => 'ok' });
    try {
      const events = [];
      for await (const event of engine.query({ prompt: 'Run two provider loops', sessionId, signal: running.ctrl.signal })) events.push(event);
      expect(requests.map(({ model, effort }) => ({ model, effort }))).toEqual([
        { model: 'test/old', effort: 'medium' }, { model: 'test/new', effort: 'ultra' },
      ]);
      expect(running.ctrl.signal.aborted).toBe(false);
      expect(events.filter(event => event.type === 'error')).toEqual([]);
      expect(events.filter(event => event.type === 'turn_end' && event.terminal)).toHaveLength(1);
      expect(targetRefresh).toHaveBeenCalledTimes(1);
      expect(backgroundRefresh).toHaveBeenCalledTimes(1);
      expect(otherRefresh).not.toHaveBeenCalled();
      expect(loadSessionConfig(root, otherId)).toEqual(otherConfig);
      expect(resolveSessionConfig(config, loadSessionConfig(root, otherId)))
        .toMatchObject({ model: 'test/other', primaryModel: 'test/other', modelEffort: 'max' });
      expect(loadSessionConfig(root, sessionId)).toEqual({ model: 'test/new', modelEffort: 'ultra' });
      expect(__testHooks.getOrCreateSessionContextForTest(sessionId)).toBe(coordinator);
      expect(getEngine(sessionId, 'omni')).toBe(engine);
      expect(targetRefresh).toHaveBeenCalledTimes(1); // Published cache key agrees with the persisted config.
      // Resetting to inheritance also keeps cached Engines and active controls.
      handleYeaftUpdateSessionConfig({ sessionId, config: { model: null, modelEffort: null } });
      expect(targetRefresh).toHaveBeenLastCalledWith(expect.objectContaining(config));
      expect(running.ctrl.signal.aborted).toBe(false);
    } finally {
      Object.assign(ctx, previous);
    }
  });

});
