// Sub-agent model, effort, scene, designer persona, and machine-oriented prompt protocol.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getPersona, listPersonaIds, _resetPersonaCache } from '../../../agent/yeaft/personas.js';
import { resolveSubAgentEffort, enforceSubAgentEffortPayload } from '../../../agent/yeaft/effort.js';
import { renderSessionScene } from '../../../agent/yeaft/sessions/scene-prompts.js';
import { buildSystemPrompt } from '../../../agent/yeaft/prompts.js';
import { buildSpawnedPreamble } from '../../../agent/yeaft/sub-agent/spawned-prompt.js';
import { resolveSubAgentSelection, formatSubAgentModelCatalogNotice } from '../../../agent/yeaft/sub-agent/selection.js';
import { readOutputLog } from '../../../agent/yeaft/sub-agent/output-log.js';
import { STATUS } from '../../../agent/yeaft/sub-agent/status.js';
import { _resetNotifications } from '../../../agent/yeaft/sub-agent/notifications.js';
import agentTool, { _resetAgentRegistry, getAgentRegistry } from '../../../agent/yeaft/tools/agent.js';
import sendMessage from '../../../agent/yeaft/tools/send-message.js';
import waitAgent from '../../../agent/yeaft/tools/wait-agent.js';
import listAgents from '../../../agent/yeaft/tools/list-agents.js';
import closeAgent from '../../../agent/yeaft/tools/close-agent.js';
import { TaskManager } from '../../../agent/yeaft/tasks/manager.js';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';
import { defineTool } from '../../../agent/yeaft/tools/types.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { Engine } from '../../../agent/yeaft/engine.js';
import { AdapterRouter } from '../../../agent/yeaft/llm/router.js';
import { GeminiAdapter } from '../../../agent/yeaft/llm/gemini.js';
import { createPersonProvider } from '../../../agent/yeaft/person/provider.js';
import { createPersonChildProvider } from '../../../agent/yeaft/person/child-provider.js';

function mkCatalogConfig(overrides = {}) {
  return {
    model: 'anthropic/claude-sonnet-4.6',
    primaryModel: 'anthropic/claude-sonnet-4.6',
    fastModel: 'openai/gpt-5.4-mini',
    maxOutputTokens: 4096,
    language: 'en',
    _readOnly: true,
    availableModels: [
      {
        id: 'claude-sonnet-4.6',
        ref: 'anthropic/claude-sonnet-4.6',
        provider: 'anthropic',
        protocol: 'anthropic',
        supportsEffort: true,
        effortOptions: ['medium', 'xhigh', 'max'],
        effortProtocol: 'anthropic-adaptive',
        contextWindow: 200000,
        maxOutput: 16384,
      },
      {
        id: 'gpt-5.4',
        ref: 'openai/gpt-5.4',
        provider: 'openai',
        protocol: 'openai-responses',
        supportsEffort: true,
        effortOptions: ['medium', 'xhigh', 'max', 'ultra'],
        effortProtocol: 'openai-reasoning',
        contextWindow: 400000,
        maxOutput: 32768,
      },
      {
        id: 'gpt-5.4-mini',
        ref: 'openai/gpt-5.4-mini',
        provider: 'openai',
        protocol: 'openai-responses',
        supportsEffort: true,
        effortOptions: ['medium', 'xhigh'],
        effortProtocol: 'openai-reasoning',
        contextWindow: 200000,
        maxOutput: 16384,
      },
      {
        id: 'gemini-3.8-flash',
        ref: 'google/gemini-3.8-flash',
        provider: 'google',
        protocol: 'gemini',
        supportsEffort: true,
        effortOptions: ['low', 'medium', 'high'],
        effortProtocol: 'gemini',
        contextWindow: 200000,
        maxOutput: 8192,
      },
      {
        id: 'plain-no-effort',
        ref: 'proxy/plain-no-effort',
        provider: 'proxy',
        protocol: 'openai-responses',
        supportsEffort: false,
        effortOptions: [],
        contextWindow: 64000,
        maxOutput: 4096,
      },
    ],
    ...overrides,
  };
}

function mkParentRegistry() {
  const reg = new ToolRegistry();
  const readTool = defineTool({ name: 'FileRead', aliases: ['Read'], description: 'read', parameters: { type: 'object', properties: {} }, isReadOnly: () => true, execute: async () => 'ok' });
  const gitTool = defineTool({ name: 'GitRead', description: 'git', parameters: { type: 'object', properties: {} }, isReadOnly: () => true, execute: async () => 'ok' });
  const grepTool = defineTool({ name: 'Grep', description: 'grep', parameters: { type: 'object', properties: {} }, isReadOnly: () => true, execute: async () => 'ok' });
  const globTool = defineTool({ name: 'Glob', description: 'glob', parameters: { type: 'object', properties: {} }, isReadOnly: () => true, execute: async () => 'ok' });
  const listTool = defineTool({ name: 'ListDir', description: 'ls', parameters: { type: 'object', properties: {} }, isReadOnly: () => true, execute: async () => 'ok' });
  const webSearch = defineTool({ name: 'WebSearch', description: 'search', parameters: { type: 'object', properties: {} }, isReadOnly: () => true, execute: async () => 'ok' });
  const webFetch = defineTool({ name: 'WebFetch', description: 'fetch', parameters: { type: 'object', properties: {} }, isReadOnly: () => true, execute: async () => 'ok' });
  const writeTool = defineTool({ name: 'FileWrite', description: 'write', parameters: { type: 'object', properties: {} }, execute: async () => 'ok' });
  const bashTool = defineTool({ name: 'Bash', description: 'bash', parameters: { type: 'object', properties: {} }, execute: async () => 'ok' });
  reg.registerAll([readTool, gitTool, grepTool, globTool, listTool, webSearch, webFetch, writeTool, bashTool, agentTool, waitAgent, listAgents, closeAgent]);
  return reg;
}

describe('sub-agent model, effort, scene, and machine protocol', () => {
  beforeEach(() => {
    _resetPersonaCache();
    _resetAgentRegistry();
    _resetNotifications();
    vi.restoreAllMocks();
  });

  it('dispatches a scene-mapped child to its exact provider despite slash IDs and caches, then persists the wire effort', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yeaft-sub-agent-task-route-'));
    const events = [];
    const taskManager = new TaskManager({ yeaftDir: dir, onEvent: event => events.push(event) });
    const model = 'openai/gpt-5.4';
    const config = mkCatalogConfig({ subAgentSceneModels: { frontend: model } });
    const adapter = new AdapterRouter({ providers: [
      { name: 'proxy', protocol: 'openai-chat-completions', baseUrl: 'https://proxy.invalid/v1',
        apiKey: 'fixture', models: [model] },
      { name: 'openai', protocol: 'openai-responses', baseUrl: 'https://alternate.invalid/v1',
        apiKey: 'fixture', models: ['gpt-5.4-mini'] },
      { name: 'openai', protocol: 'openai-responses', baseUrl: 'https://openai.invalid/v1',
        apiKey: 'fixture', models: ['gpt-5.4'] },
    ] });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let captureDispatch;
    const dispatched = new Promise(resolve => { captureDispatch = resolve; });
    const urls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      urls.push(String(url));
      if (urls.length > 1) {
        captureDispatch(JSON.parse(init.body));
        await gate;
      }
      return new Response([
        'data: {"type":"response.output_text.delta","delta":"status: done"}',
        'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}',
        '', '',
      ].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } });
    }));
    let child;
    try {
      expect(adapter.getProtocolForModel(model)).toBe('openai-responses');
      expect(adapter.getProviderForModel(model).baseUrl).toBe('https://openai.invalid/v1');
      expect(adapter.getProviderForModel(`proxy/${model}`).name).toBe('proxy');
      for await (const _event of adapter.stream({ model: 'gpt-5.4-mini', messages: [] })) { /* warm adapter cache */ }
      const spawn = JSON.parse(await agentTool.execute({
        name: 'route-test', mission: 'Check route', scene: 'frontend', model: config.model,
      }, {
        sessionId: 's', sceneId: 'software', currentVpId: 'omni', taskManager,
        parentEngineDeps: { adapter, config, trace: new NullTrace(), taskManager,
          yeaftDir: dir, subAgentLogDir: dir, parentToolRegistry: mkParentRegistry() },
      }));
      expect(spawn.success).toBe(true);
      child = getAgentRegistry().get(spawn.agentId);
      expect(events[0]).toMatchObject({ event: 'started', task: {
        source: { sceneId: 'software' }, subAgentRoute: { model, sceneId: 'frontend' },
      } });
      expect(events[0].task.subAgentRoute).not.toHaveProperty('effort');
      expect(await dispatched).toMatchObject({ model: 'gpt-5.4', reasoning: { effort: 'medium' } });
      expect(urls).toEqual(['https://alternate.invalid/v1/responses', 'https://openai.invalid/v1/responses']);
      const route = { model, effort: 'medium', sceneId: 'frontend' };
      expect(events.some(event => event.event === 'updated' && event.task.subAgentRoute?.effort === 'medium')).toBe(true);
      expect(taskManager.listActiveTasks('s')[0].subAgentRoute).toEqual(route);
      expect(taskManager.store.readTask('s', spawn.taskId).subAgentRoute).toEqual(route);
      release();
      await child.driverPromise;
      expect(events.find(event => event.event === 'completed')).toMatchObject({ event: 'completed', task: { status: 'succeeded', subAgentRoute: route } });
      expect(new TaskManager({ yeaftDir: dir }).getTask('s', spawn.taskId).subAgentRoute).toEqual(route);
    } finally {
      release();
      await child?.driverPromise;
      vi.unstubAllGlobals();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps Chat High in Person catalogs, pinned children, and SpawnAgent selections', async () => {
    const id = 'chat-alias', model = `proxy/${id}`, protocol = 'openai-chat-completions';
    const config = mkCatalogConfig({ model, primaryModel: model, providers: [{ name: 'proxy', protocol, models: [id] }],
      availableModels: [{ id, ref: model, protocol, effortOptions: ['medium', 'high', 'xhigh'], contextWindow: 128000, maxOutput: 4096 }] });
    const stream = vi.fn(async function* () { yield { type: 'stop', stopReason: 'end_turn' }; });
    const provider = await createPersonProvider({ config, adapter: { stream }, effortEnabled: true, minimumRequestBytes: 1 });
    expect(provider.catalog[0].efforts).toEqual(['medium', 'high', 'xhigh']);
    const child = createPersonChildProvider(provider, { model, effort: 'high' });
    await child.adapter.call({ model });
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({ model, effort: 'high', effortSource: 'user' }));
    expect(resolveSubAgentSelection({ config, requestedEffort: 'high' })).toMatchObject({ ok: true, explicitEffortTarget: 'high' });
    expect(resolveSubAgentSelection({ config, personaData: { defaultEffort: 'high' } })).toMatchObject({ ok: true, explicitEffortTarget: 'high' });
  });

  it('applies saved persona targets before tool overrides, without changing unrelated roles', () => {
    const config = mkCatalogConfig({ subAgentPersonaEfforts: { explorer: 'max', designer: 'medium', reviewer: 'high' } });
    const resolve = (personaId, extra) => resolveSubAgentSelection({ personaId, config, ...extra });
    expect(resolve('designer', { requestedEffort: 'xhigh' })).toMatchObject({ effort: 'medium', effortSource: 'persona-config' });
    expect(resolve('reviewer')).toMatchObject({ effort: 'medium', effortSource: 'persona-config' });
    expect(resolve('explorer')).toMatchObject({ model: 'openai/gpt-5.4-mini', effort: 'xhigh', effortSource: 'persona-config' });
    expect(resolve('implementer')).toMatchObject({ effort: null, effortSource: 'inherited' });
    expect(resolve('reviewer', { requestedModel: 'proxy/plain-no-effort' })).toMatchObject({ effort: null, explicitEffortTarget: 'high', effortSource: 'persona-config' });
    expect(resolveSubAgentSelection({ personaId: 'reviewer', config: mkCatalogConfig(), requestedEffort: 'medium' }))
      .toMatchObject({ effort: 'medium', effortSource: 'explicit' });
    expect(resolve('reviewer', { config: { ...config, subAgentPersonaEfforts: { reviewer: 'low' } } }))
      .toMatchObject({ ok: false, error: expect.stringContaining('without increasing it') });
    expect(formatSubAgentModelCatalogNotice({ ...config, availableModels: [] })).toContain('reviewer → high');
    // A literal High from a Chat/Gemini route doesn't mean X-High if a
    // fallback model speaks Responses instead; keep it a real ceiling.
    expect(resolveSubAgentEffort({ targetEffort: 'high', model: 'gpt-5.4', protocol: 'openai-responses' }))
      .toMatchObject({ effective: 'medium', cap: 'high' });
  });

  it('sends the review preset over the actual provider route and records the wire effort', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yeaft-review-effort-'));
    const id = 'gemini-4-carbon', carbon = `chat/${id}`;
    const config = mkCatalogConfig();
    config.availableModels.push({ id, ref: carbon, provider: 'chat', protocol: 'openai-chat-completions' });
    const adapter = new AdapterRouter({ providers: [
      { name: 'chat', protocol: 'openai-chat-completions', baseUrl: 'https://chat.invalid/v1', apiKey: 'fixture', models: [id] },
      { name: 'openai', protocol: 'openai-responses', baseUrl: 'https://openai.invalid/v1', apiKey: 'fixture', models: ['gpt-5.4'] },
    ] });
    const wire = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      wire.push([String(url), JSON.parse(init.body)]);
      const events = String(url).endsWith('/chat/completions')
        ? ['{"choices":[{"index":0,"delta":{"content":"status: done"},"finish_reason":"stop"}]}', '[DONE]']
        : ['{"type":"response.output_text.delta","delta":"status: done"}', '{"type":"response.completed","response":{"id":"resp_1","status":"completed"}}'];
      return new Response(events.map(event => `data: ${event}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    }));
    const taskManager = new TaskManager({ yeaftDir: dir });
    try {
      for (const [model, effort, override] of [[carbon, 'high', false], ['openai/gpt-5.4', 'xhigh', false], ['openai/gpt-5.4', 'medium', true]]) {
        const ctx = { cwd: dir, sessionId: 's', sceneId: 'software', currentVpId: 'omni', taskManager,
          parentEngineDeps: { adapter, config: { ...config, subAgentSceneModels: { software: model },
            ...(override ? { subAgentPersonaEfforts: { reviewer: 'medium' } } : {}) },
            trace: new NullTrace(), taskManager, yeaftDir: dir, subAgentLogDir: dir, parentToolRegistry: mkParentRegistry() } };
        const spawn = JSON.parse(await agentTool.execute({ name: 'review', mission: 'Review the changed file', persona: 'reviewer',
          ...(override ? { effort: 'xhigh' } : {}) }, ctx));
        expect(spawn).toMatchObject({ success: true, model, effort });
        await getAgentRegistry().get(spawn.agentId).driverPromise;
        const [url, body] = wire.at(-1);
        expect(url).toBe(model === carbon ? 'https://chat.invalid/v1/chat/completions' : 'https://openai.invalid/v1/responses');
        expect(model === carbon ? body.reasoning_effort : body.reasoning?.effort).toBe(effort);
        expect(taskManager.getTask('s', spawn.taskId)).toMatchObject({ status: 'succeeded',
          subAgentRoute: { model, effort, sceneId: 'software' } });
      }
      expect(wire).toHaveLength(3);
    } finally {
      vi.unstubAllGlobals();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retains the original role target when a retryable failure changes provider protocol', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yeaft-effort-fallback-'));
    const carbon = 'chat/gemini-4-carbon', plain = 'chat/plain', neon = 'google/gemini-4-neon';
    const providers = [
      { name: 'chat', protocol: 'openai-chat-completions', baseUrl: 'https://chat.invalid/v1', apiKey: 'fixture',
        models: ['gemini-4-carbon', { id: 'plain', supportsEffort: false }] },
      { name: 'openai', protocol: 'openai-responses', baseUrl: 'https://openai.invalid/v1', apiKey: 'fixture', models: ['gpt-5.4'] },
      { name: 'google', protocol: 'gemini', baseUrl: 'https://gemini.invalid/v1beta', apiKey: 'fixture', models: ['gemini-4-neon'] },
    ];
    const adapter = new AdapterRouter({ providers });
    const wire = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      wire.push([String(url), JSON.parse(init.body)]);
      if (String(url).startsWith('https://chat.invalid')) return new Response('unavailable', { status: 503 });
      const events = String(url).startsWith('https://gemini.invalid')
        ? ['{"candidates":[{"content":{"role":"model","parts":[{"text":"status: done"}]},"finishReason":"STOP"}]}']
        : ['{"type":"response.output_text.delta","delta":"status: done"}', '{"type":"response.completed","response":{"id":"resp_1","status":"completed"}}'];
      return new Response(events.map(event => `data: ${event}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    }));
    const taskManager = new TaskManager({ yeaftDir: dir });
    try {
      for (const [model, initial, target, fallbackModel, expected] of [
        [carbon, 'high', null, 'openai/gpt-5.4', 'xhigh'], [plain, undefined, 'low', neon, 'low'],
      ]) {
        const config = mkCatalogConfig({ model, primaryModel: model, fallbackModel, llmRetry: { maxRetries: 0 },
          ...(target ? { subAgentPersonaEfforts: { reviewer: target } } : {}) });
        config.availableModels.push(...providers.filter(p => p.name !== 'openai').flatMap(p => p.models.map(raw => {
          const info = typeof raw === 'string' ? { id: raw } : raw;
          return { ...info, ref: `${p.name}/${info.id}`, provider: p.name, protocol: p.protocol };
        })));
        const ctx = { cwd: dir, sessionId: 's', sceneId: 'software', currentVpId: 'omni', taskManager,
          parentEngineDeps: { adapter, config, trace: new NullTrace(), taskManager, yeaftDir: dir,
            subAgentLogDir: dir, parentToolRegistry: mkParentRegistry() } };
        const spawn = JSON.parse(await agentTool.execute({ name: 'review', mission: 'Review the changed file', persona: 'reviewer' }, ctx));
        expect(spawn.success).toBe(true);
        await getAgentRegistry().get(spawn.agentId).driverPromise;
        const [[primaryUrl, primary], [fallbackUrl, fallback]] = wire.splice(0);
        expect(primaryUrl).toContain('chat.invalid/v1/chat/completions');
        expect(primary.reasoning_effort).toBe(initial);
        if (fallbackModel === neon) {
          expect(fallbackUrl).toContain('gemini.invalid/v1beta/models/gemini-4-neon:streamGenerateContent');
          expect(fallback.generationConfig.thinkingConfig.thinkingLevel).toBe('LOW');
        } else {
          expect(fallbackUrl).toContain('openai.invalid/v1/responses');
          expect(fallback.reasoning.effort).toBe('xhigh');
        }
        expect(taskManager.getTask('s', spawn.taskId)).toMatchObject({ status: 'succeeded',
          subAgentRoute: { model: fallbackModel, effort: expected, sceneId: 'software' } });
      }
    } finally {
      vi.unstubAllGlobals();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('validates and resolves designer persona, model whitelist, effort rules, and scene inheritance', () => {
    expect(listPersonaIds()).toContain('designer');
    const designer = getPersona('designer');
    expect(designer).toMatchObject({
      id: 'designer',
      modelTier: 'primary',
      defaultEffort: 'xhigh',
    });
    expect(designer.tools).toEqual(expect.arrayContaining(['GitRead', 'Read', 'Grep', 'Glob', 'ListDir', 'WebSearch', 'WebFetch']));
    expect(designer.tools).not.toContain('FileWrite');
    expect(designer.tools).not.toContain('Bash');

    const config = mkCatalogConfig();

    // Default persona routing: explorer uses fastModel, designer inherits primary + xhigh.
    expect(resolveSubAgentSelection({ personaId: 'explorer', config, parentSceneId: 'software' })).toMatchObject({
      ok: true,
      model: 'openai/gpt-5.4-mini',
      modelSource: 'persona-fast',
      effort: null,
      effortSource: 'inherited',
      explicitEffortTarget: null,
      sceneId: 'software',
      sceneSource: 'inherited',
    });
    expect(resolveSubAgentSelection({ personaId: 'designer', config, parentSceneId: 'software' })).toMatchObject({
      ok: true,
      model: 'anthropic/claude-sonnet-4.6',
      modelSource: 'inherited',
      effort: 'xhigh',
      effortSource: 'persona-default',
      explicitEffortTarget: 'xhigh',
      sceneId: 'software',
      sceneSource: 'inherited',
    });

    // Designer adapts xhigh down to highest supported native level on Gemini 3.x (high).
    expect(resolveSubAgentSelection({
      personaId: 'designer',
      requestedModel: 'google/gemini-3.8-flash',
      requestedScene: 'frontend',
      config,
      parentSceneId: 'software',
    })).toMatchObject({
      ok: true,
      model: 'google/gemini-3.8-flash',
      modelSource: 'explicit',
      effort: 'high',
      effortSource: 'persona-default',
      explicitEffortTarget: 'xhigh',
      sceneId: 'frontend',
      sceneSource: 'explicit',
    });

    // Unambiguous bare modelId resolves to full provider/model ref.
    expect(resolveSubAgentSelection({
      requestedModel: 'gpt-5.4',
      requestedEffort: 'ultra',
      config,
    })).toMatchObject({
      ok: true,
      model: 'openai/gpt-5.4',
      modelSource: 'explicit',
      effort: 'ultra',
      effortSource: 'explicit',
      explicitEffortTarget: 'ultra',
    });

    // Ambiguous bare modelId fails closed and lists provider-qualified choices.
    const dupConfig = mkCatalogConfig({
      availableModels: [
        ...config.availableModels,
        { id: 'gpt-5.4', ref: 'copilot/gpt-5.4', provider: 'copilot', protocol: 'openai-responses', supportsEffort: true, effortOptions: ['medium', 'xhigh'] },
      ],
    });
    const ambiguous = resolveSubAgentSelection({ requestedModel: 'gpt-5.4', config: dupConfig });
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.error).toMatch(/ambiguous/i);
    expect(ambiguous.error).toContain('openai/gpt-5.4');
    expect(ambiguous.error).toContain('copilot/gpt-5.4');

    // Out-of-catalog model, unsupported effort, and unknown scene all fail closed.
    expect(resolveSubAgentSelection({ requestedModel: 'openai/unknown-model', config })).toMatchObject({ ok: false });
    expect(resolveSubAgentSelection({ requestedModel: 'proxy/plain-no-effort', requestedEffort: 'xhigh', config })).toMatchObject({ ok: false });
    expect(resolveSubAgentSelection({ requestedModel: 'anthropic/claude-sonnet-4.6', requestedEffort: 'ultra', config })).toMatchObject({ ok: false });
    // Fail closed on retired/unsupported explicit efforts (must NOT silently escalate low -> medium or high -> xhigh).
    expect(resolveSubAgentSelection({ requestedModel: 'openai/gpt-5.4', requestedEffort: 'low', config })).toMatchObject({ ok: false });
    expect(resolveSubAgentSelection({ requestedModel: 'anthropic/claude-sonnet-4.6', requestedEffort: 'high', config })).toMatchObject({ ok: false });
    expect(resolveSubAgentSelection({ requestedScene: 'not-a-scene', config })).toMatchObject({ ok: false });

    // Catalog entries omitting `protocol` (carrying only `effortProtocol`) still map to valid wire protocol.
    const effortProtoOnlyConfig = mkCatalogConfig({
      availableModels: [
        { id: 'claude-sonnet-4.6', ref: 'anthropic/claude-sonnet-4.6', provider: 'anthropic', effortProtocol: 'anthropic-adaptive', effortOptions: ['medium', 'xhigh', 'max'] },
        { id: 'gpt-5.4', ref: 'openai/gpt-5.4', provider: 'openai', effortProtocol: 'openai-reasoning', effortOptions: ['medium', 'xhigh', 'max', 'ultra'] },
      ],
    });
    expect(resolveSubAgentSelection({
      personaId: 'designer',
      requestedModel: 'anthropic/claude-sonnet-4.6',
      requestedEffort: 'xhigh',
      config: effortProtoOnlyConfig,
    })).toMatchObject({ ok: true, model: 'anthropic/claude-sonnet-4.6', effort: 'xhigh' });

    // Bare config.model keeps primaryModel's provider ownership and canonicalizes to provider/model ref.
    const bareModelConfig = mkCatalogConfig({
      model: 'gpt-5.4',
      primaryModel: 'copilot/gpt-5.4',
      availableModels: [
        ...config.availableModels,
        { id: 'gpt-5.4', ref: 'copilot/gpt-5.4', provider: 'copilot', protocol: 'openai-responses', supportsEffort: true, effortOptions: ['medium', 'xhigh'] },
      ],
    });
    expect(resolveSubAgentSelection({ config: bareModelConfig })).toMatchObject({
      ok: true,
      model: 'copilot/gpt-5.4',
      modelSource: 'inherited',
    });

    // Catalog notice omits single-model configs, handles zh-CN locale, and counts only unique entries for truncation.
    expect(formatSubAgentModelCatalogNotice({ availableModels: [config.availableModels[0]] }, 'en')).toBe('');
    const noticeZhCn = formatSubAgentModelCatalogNotice({
      availableModels: [...config.availableModels, config.availableModels[0]],
    }, 'zh-CN');
    expect(noticeZhCn).toContain('SpawnAgent 可选模型与 effort');
    expect(noticeZhCn).toContain('openai/gpt-5.4 [medium,xhigh,max,ultra]');
    expect(noticeZhCn).toContain('proxy/plain-no-effort [no-effort]');
    expect(noticeZhCn).not.toContain('more)');
  });

  it('applies scene routes to both inherited and explicit scenes before any model override, then resolves effort', () => {
    const config = mkCatalogConfig({ subAgentSceneModels: {
      software: 'openai/gpt-5.4', frontend: 'google/gemini-3.8-flash', writing: 'retired/model',
    } });
    expect(resolveSubAgentSelection({ config, personaId: 'explorer', parentSceneId: 'software',
      requestedModel: 'anthropic/claude-sonnet-4.6' })).toMatchObject({
      model: 'openai/gpt-5.4', modelSource: 'scene-config', sceneSource: 'inherited',
    });
    const explicit = { config, personaId: 'designer', parentSceneId: 'software', requestedScene: 'frontend' };
    expect(resolveSubAgentSelection(explicit)).toMatchObject({
      model: 'google/gemini-3.8-flash', modelSource: 'scene-config',
      sceneId: 'frontend', sceneSource: 'explicit', effort: 'high',
    });
    expect(resolveSubAgentSelection({ ...explicit, requestedEffort: 'xhigh' })).toMatchObject({
      ok: false, error: expect.stringContaining('google/gemini-3.8-flash'),
    });
    expect(resolveSubAgentSelection({ config, personaId: 'explorer', requestedScene: 'writing' })).toMatchObject({
      model: 'openai/gpt-5.4-mini', modelSource: 'persona-fast',
    });
    expect(resolveSubAgentSelection({ config: { ...config, ambiguousModelRefs: ['openai/gpt-5.4'] },
      parentSceneId: 'software' })).toMatchObject({ model: config.model, modelSource: 'inherited' });
    const notice = formatSubAgentModelCatalogNotice({ ...config, availableModels: [config.availableModels[1]] });
    expect(notice).toContain('software → openai/gpt-5.4');
    expect(notice).not.toContain('retired/model');
  });

  it('uses the first catalog owner for legacy slash-delimited fastModel IDs only if no exact ref exists', () => {
    const catalog = mkCatalogConfig().availableModels;
    const legacy = { id: 'upstream/gpt-fast', provider: 'proxy', ref: 'proxy/upstream/gpt-fast' };
    const exact = { id: 'gpt-fast', provider: 'upstream', ref: 'upstream/gpt-fast' };
    for (const [entries, model] of [[[legacy], legacy.ref], [[legacy, exact], exact.ref]]) {
      const config = mkCatalogConfig({ fastModel: legacy.id, availableModels: [...catalog, ...entries] });
      expect(resolveSubAgentSelection({ config, personaId: 'explorer' })).toMatchObject({ model, modelSource: 'persona-fast' });
    }
  });

  it('honors explicit targetEffort across OpenAI, Anthropic, and Gemini while preserving legacy medium ceiling by default', () => {
    const parentMax = { effective: 'max', source: 'user', wireMode: 'reasoning-effort', thinkingEnabled: true };

    // Legacy omitted targetEffort stays capped at medium.
    expect(resolveSubAgentEffort({ parentDecision: parentMax, model: 'gpt-5.4', protocol: 'openai-responses' }))
      .toMatchObject({ effective: 'medium', cap: 'medium' });

    // Explicit targetEffort raises ceiling for Responses, Anthropic adaptive, and Gemini native levels.
    const responsesBody = { model: 'gpt-5.4', reasoning: { effort: 'xhigh' } };
    const responsesDecision = enforceSubAgentEffortPayload(responsesBody, {
      model: 'gpt-5.4',
      protocol: 'openai-responses',
      effortConstraint: { parentDecision: parentMax, targetEffort: 'xhigh' },
    });
    expect(responsesDecision).toMatchObject({ effective: 'xhigh', cap: 'xhigh', source: 'explicit' });
    expect(responsesBody.reasoning.effort).toBe('xhigh');

    const anthropicBody = { model: 'claude-opus-4.8', max_tokens: 8192, thinking: { type: 'adaptive' }, output_config: { effort: 'max' } };
    const anthropicDecision = enforceSubAgentEffortPayload(anthropicBody, {
      model: 'claude-opus-4.8',
      protocol: 'anthropic',
      effortConstraint: { parentDecision: parentMax, targetEffort: 'max' },
    });
    expect(anthropicDecision).toMatchObject({ effective: 'max', cap: 'max', source: 'explicit' });
    expect(anthropicBody.output_config.effort).toBe('max');

    // Gemini adapter preserves native thinkingLevel on both Gemini 4 (XHIGH) and Gemini 3.x (HIGH, never corrupted to XHIGH).
    const capturedBodies = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      capturedBodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      }), { headers: { 'content-type': 'application/json' } });
    }));
    const gemini = new GeminiAdapter({ apiKey: 'fixture', baseUrl: 'https://generativelanguage.googleapis.com' });
    return gemini.call({
      model: 'gemini-4-hydrogen',
      messages: [{ role: 'user', content: 'design' }],
      effort: 'xhigh',
      effortSource: 'user',
      effortConstraint: { parentDecision: parentMax, targetEffort: 'xhigh' },
    }).then(() => gemini.call({
      model: 'gemini-3.8-flash',
      messages: [{ role: 'user', content: 'design' }],
      effortConstraint: { parentDecision: parentMax, targetEffort: 'high' },
    })).then(() => {
      expect(capturedBodies[0].generationConfig.thinkingConfig.thinkingLevel).toBe('XHIGH');
      expect(capturedBodies[1].generationConfig.thinkingConfig.thinkingLevel).toBe('HIGH');
      expect(resolveSubAgentEffort({ parentDecision: parentMax, model: 'gemini-3.8-flash', protocol: 'gemini', targetEffort: 'high' }))
        .toMatchObject({ effective: 'high', cap: 'high', wireMode: 'thinking-level' });
    });
  });

  it('strips human conversational prose from sub-agent scene prompts and uses structured AI-to-AI delivery protocol', () => {
    for (const lang of ['en', 'zh']) {
      const humanScene = renderSessionScene('software', lang);
      const childScene = renderSessionScene('software', lang, { audience: 'sub-agent' });
      expect(childScene).toContain(lang === 'zh' ? '扩展、迁移、收缩' : 'expand, migrate, contract');
      expect(childScene).not.toContain(lang === 'zh' ? '像一位可信赖的资深顾问跟聪明的朋友说话' : 'Talk like a trusted senior adviser to a capable friend');
      expect(humanScene).toContain(lang === 'zh' ? '像一位可信赖的资深顾问跟聪明的朋友说话' : 'Talk like a trusted senior adviser to a capable friend');

      const preamble = buildSpawnedPreamble({
        parentName: 'Session assistant',
        agentName: 'architect',
        mission: 'Compare designs A and B',
        sceneId: 'frontend',
        language: lang,
      });
      expect(preamble).toContain('status');
      expect(preamble).toContain('evidence');
      expect(preamble).toContain('gaps');
      expect(preamble).not.toMatch(/inherit the spawner's persona and voice|继承了派出方的人格与风格/);

      const childSystem = buildSystemPrompt({
        language: lang,
        vpPersona: {
          sceneId: 'frontend',
          runtimePreamble: preamble,
          subAgent: { agentId: 'agent-1', agentName: 'architect', sceneId: 'frontend' },
        },
      });
      expect(childSystem).toContain(lang === 'zh' ? '设计系统' : 'design system');
      expect(childSystem).toContain(preamble);
      expect(childSystem).not.toContain(lang === 'zh' ? '顺着对方的话，用对方的语言聊' : "Pick up the thread in the user's language");
      expect(childSystem).not.toContain(lang === 'zh' ? '像一位可信赖的资深顾问' : 'Talk like a trusted senior adviser');
      expect(childSystem).not.toContain(lang === 'zh' ? '先得到对方明确同意' : "get the person's explicit go-ahead");
    }
  });

  it('routes SpawnAgent model/effort/scene end-to-end, differentiates delegation identity, and injects parent catalog notice', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-selection-e2e-'));
    const recorded = [];
    const adapter = {
      async *stream(params) {
        recorded.push(params);
        yield { type: 'text_delta', text: 'status: done\nconclusion: selected option B' };
        yield { type: 'stop', stopReason: 'end_turn' };
      },
    };
    const config = mkCatalogConfig();
    const deps = {
      adapter,
      trace: new NullTrace(),
      config,
      parentModel: config.model,
      parentToolRegistry: mkParentRegistry(),
      parentName: 'Session assistant',
      parentVpId: 'omni',
      parentVpPersona: { sceneId: 'software', vpId: 'omni' },
      parentSessionId: 'sess-selection',
      parentThreadId: 'main',
      language: 'en',
      subAgentLogDir: dir,
    };
    const ctx = {
      cwd: dir,
      queryTurnId: 'turn-selection-1',
      sessionId: 'sess-selection',
      senderVpId: 'omni',
      sceneId: 'software',
      effortDecision: { effective: 'max', source: 'user', wireMode: 'adaptive', thinkingEnabled: true },
      parentEngineDeps: deps,
    };

    const spawnedIds = [];
    try {
      // 1. Designer persona with explicit model + scene override.
      const designSpawn = JSON.parse(await agentTool.execute({
        name: 'arch-designer',
        mission: 'Design the storage contract',
        persona: 'designer',
        scene: 'frontend',
        model: 'openai/gpt-5.4',
      }, ctx));
      expect(designSpawn).toMatchObject({
        success: true,
        persona: 'designer',
        scene: 'frontend',
        model: 'openai/gpt-5.4',
        effort: 'xhigh',
      });
      spawnedIds.push(designSpawn.agentId);

      const designWait = JSON.parse(await waitAgent.execute({ agent_id: designSpawn.agentId, timeout_ms: 2000 }, ctx));
      expect(designWait).toMatchObject({
        status: STATUS.IDLE,
        persona: 'designer',
        scene: 'frontend',
        model: 'openai/gpt-5.4',
        effort: 'xhigh',
      });
      expect(recorded[0].model).toBe('openai/gpt-5.4');
      expect(recorded[0].effort).toBe('xhigh');
      expect(recorded[0].effortConstraint).toMatchObject({ targetEffort: 'xhigh' });
      expect(recorded[0].system).toContain('design system');
      expect(recorded[0].system).not.toContain('Talk like a trusted senior adviser');
      expect(recorded[0].tools.map(t => t.name)).toContain('GitRead');
      expect(recorded[0].tools.map(t => t.name)).not.toContain('FileWrite');

      // Output log records resolved model/effort/scene/persona metadata.
      const logEntries = readOutputLog(designSpawn.agentId, dir);
      expect(logEntries.find(e => e.type === 'sub_agent_spawned')).toMatchObject({
        persona: 'designer',
        scene: 'frontend',
        model: 'openai/gpt-5.4',
        modelSource: 'explicit',
        effort: 'xhigh',
        effortSource: 'persona-default',
      });

      // 2. Same mission with different effort/model must NOT reuse the prior delegation.
      const maxSpawn = JSON.parse(await agentTool.execute({
        name: 'arch-designer-max',
        mission: 'Design the storage contract',
        persona: 'designer',
        scene: 'frontend',
        model: 'openai/gpt-5.4',
        effort: 'max',
      }, ctx));
      expect(maxSpawn.success).toBe(true);
      expect(maxSpawn.reused).toBeUndefined();
      expect(maxSpawn.agentId).not.toBe(designSpawn.agentId);
      expect(maxSpawn.effort).toBe('max');
      spawnedIds.push(maxSpawn.agentId);
      await waitAgent.execute({ agent_id: maxSpawn.agentId, timeout_ms: 2000 }, ctx);
      expect(recorded[1].effort).toBe('max');
      expect(recorded[1].effortConstraint).toMatchObject({ targetEffort: 'max' });

      // 3. ListAgents exposes persona/scene/model/effort on active agents.
      const listed = JSON.parse(await listAgents.execute({}, ctx));
      expect(listed.agents).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: designSpawn.agentId, persona: 'designer', scene: 'frontend', model: 'openai/gpt-5.4', effort: 'xhigh' }),
        expect.objectContaining({ id: maxSpawn.agentId, persona: 'designer', scene: 'frontend', model: 'openai/gpt-5.4', effort: 'max' }),
      ]));

      // 4. Invalid model / effort fail closed without registering an agent.
      const badModel = JSON.parse(await agentTool.execute({ name: 'bad-model', mission: 'test', model: 'nope/bad' }, ctx));
      expect(badModel.error).toMatch(/not available/i);
      const badEffort = JSON.parse(await agentTool.execute({ name: 'bad-effort', mission: 'test', model: 'proxy/plain-no-effort', effort: 'xhigh' }, ctx));
      expect(badEffort.error).toMatch(/does not support reasoning effort/i);

      // 5. Parent Engine injects compact model catalog notice when SpawnAgent is active and >1 model exists.
      let parentSystemPrompt = '';
      const parentEngine = new Engine({
        adapter: {
          async *stream(params) {
            parentSystemPrompt = params.system;
            yield { type: 'text_delta', text: 'ok' };
            yield { type: 'stop', stopReason: 'end_turn' };
          },
        },
        trace: new NullTrace(),
        config,
        toolRegistry: mkParentRegistry(),
      });
      for await (const _evt of parentEngine.query({
        prompt: 'Please spawn a sub-agent to review this architecture.',
        vpPersona: { sceneId: 'software', vpId: 'omni' },
      })) { /* drain */ }
      expect(parentSystemPrompt).toContain('SpawnAgent available models and efforts');
      expect(parentSystemPrompt).toContain('openai/gpt-5.4 [medium,xhigh,max,ultra]');

      // 6. Real AdapterRouter + OpenAIResponsesAdapter enforces sub-agent xhigh over the wire.
      let wirePayload = null;
      vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
        wirePayload = JSON.parse(init.body);
        const sse = [
          'data: {"type":"response.output_text.delta","delta":"status: done\\nconclusion: wired"}',
          'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":10,"output_tokens":5}}}',
          '',
        ].join('\n\n');
        return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
      }));
      const router = new AdapterRouter({
        providers: [{
          name: 'openai',
          protocol: 'openai-responses',
          baseUrl: 'https://api.openai.invalid/v1',
          apiKey: 'fixture',
          models: ['gpt-5.4'],
        }],
      });
      const wireCtx = { ...ctx, parentEngineDeps: { ...deps, adapter: router,
        config: { ...config, subAgentSceneModels: { software: 'openai/gpt-5.4' } },
      } };
      const wireSpawn = JSON.parse(await agentTool.execute({
        name: 'wire-designer',
        mission: 'Verify the mapped model and effort on the wire',
        persona: 'designer',
        model: 'anthropic/claude-sonnet-4.6',
      }, wireCtx));
      expect(wireSpawn).toMatchObject({ success: true, model: 'openai/gpt-5.4', scene: 'software', effort: 'xhigh' });
      spawnedIds.push(wireSpawn.agentId);
      const wireWait = JSON.parse(await waitAgent.execute({ agent_id: wireSpawn.agentId, timeout_ms: 2000 }, { ...ctx, parentEngineDeps: { ...deps, adapter: router } }));
      expect(wireWait.status).toBe(STATUS.IDLE);
      expect(wirePayload.model).toBe('gpt-5.4');
      expect(wirePayload.reasoning).toEqual({ effort: 'xhigh' });

      // 7. PromptAgent follow-up preserves explicit targetEffort and model across turns.
      wirePayload = null;
      expect(JSON.parse(await sendMessage.execute({
        agent_id: wireSpawn.agentId,
        message: 'Check edge case 2',
      }, { ...ctx, parentEngineDeps: { ...deps, adapter: router } })).success).toBe(true);
      const followUpWait = JSON.parse(await waitAgent.execute({ agent_id: wireSpawn.agentId, timeout_ms: 2000 }, { ...ctx, parentEngineDeps: { ...deps, adapter: router } }));
      expect(followUpWait.status).toBe(STATUS.IDLE);
      expect(wirePayload.model).toBe('gpt-5.4');
      expect(wirePayload.reasoning).toEqual({ effort: 'xhigh' });

      // 8. Explicit model override clears parent fallbackModel and respects an explicit lower output cap;
      //    ordinary sub-agents do not inherit parent modelEffort='max' (avoiding Anthropic manual max_tokens inflation).
      let anthropicBody = null;
      vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
        anthropicBody = JSON.parse(init.body);
        return new Response(JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-3-7-sonnet',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'status: done\nconclusion: ok' }],
          usage: { input_tokens: 10, output_tokens: 5 },
        }), { headers: { 'content-type': 'application/json' } });
      }));
      const manualAnthropicRouter = new AdapterRouter({
        providers: [{
          name: 'anthropic',
          protocol: 'anthropic',
          baseUrl: 'https://api.anthropic.invalid',
          apiKey: 'fixture',
          models: [{ id: 'claude-3-7-sonnet', thinkingProtocol: 'anthropic' }],
        }],
      });
      const manualConfig = mkCatalogConfig({
        model: 'anthropic/claude-3-7-sonnet',
        primaryModel: 'anthropic/claude-3-7-sonnet',
        modelEffort: 'max',
        fallbackModel: 'openai/gpt-5.4-mini',
        maxOutputTokens: 10000,
        availableModels: [
          {
            id: 'claude-3-7-sonnet',
            ref: 'anthropic/claude-3-7-sonnet',
            provider: 'anthropic',
            protocol: 'anthropic',
            thinkingProtocol: 'anthropic',
            supportsEffort: true,
            effortOptions: ['medium', 'xhigh', 'max'],
            contextWindow: 200000,
            maxOutput: 64000,
          },
          ...config.availableModels,
        ],
      });
      const ordinaryCtx = {
        ...ctx,
        queryTurnId: 'turn-manual-check',
        parentEngineDeps: {
          ...deps,
          adapter: manualAnthropicRouter,
          config: manualConfig,
          parentModel: 'anthropic/claude-3-7-sonnet',
        },
      };
      const ordinarySpawn = JSON.parse(await agentTool.execute({
        name: 'ordinary-worker',
        mission: 'Verify no max_tokens inflation',
        persona: 'implementer',
      }, ordinaryCtx));
      expect(ordinarySpawn.success).toBe(true);
      spawnedIds.push(ordinarySpawn.agentId);
      await waitAgent.execute({ agent_id: ordinarySpawn.agentId, timeout_ms: 2000 }, ordinaryCtx);
      expect(anthropicBody.max_tokens).toBe(10000);
      expect(anthropicBody.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 });

      // Explicit model override clears fallbackModel and preserves explicit lower output cap.
      const cappedChild = JSON.parse(await agentTool.execute({
        name: 'explicit-capped',
        mission: 'Check cap and fallback clearing',
        model: 'openai/gpt-5.4',
      }, { ...ctx, queryTurnId: 'turn-cap-check', parentEngineDeps: { ...deps, config: manualConfig, parentModel: manualConfig.model } }));
      expect(cappedChild.success).toBe(true);
      spawnedIds.push(cappedChild.agentId);
      await waitAgent.execute({ agent_id: cappedChild.agentId, timeout_ms: 2000 }, ctx);
      expect(recorded.at(-1).maxTokens).toBe(10000);
      expect(getAgentRegistry().get(cappedChild.agentId).modelSource).toBe('explicit');

      // 9. Bare vs qualified parentModel produces identical delegation identity (dedupes retries).
      const bareCtx = {
        ...ctx,
        queryTurnId: 'turn-canonical-id',
        parentEngineDeps: { ...deps, config: { ...config, model: 'claude-sonnet-4.6', primaryModel: 'anthropic/claude-sonnet-4.6' }, parentModel: 'claude-sonnet-4.6' },
      };
      const firstBare = JSON.parse(await agentTool.execute({ name: 'canon-1', mission: 'Same mission' }, bareCtx));
      expect(firstBare).toMatchObject({ success: true, model: 'anthropic/claude-sonnet-4.6' });
      spawnedIds.push(firstBare.agentId);
      const retryQualified = JSON.parse(await agentTool.execute({ name: 'canon-2', mission: 'Same mission', model: 'anthropic/claude-sonnet-4.6' }, bareCtx));
      expect(retryQualified).toMatchObject({ success: true, reused: true, agentId: firstBare.agentId });

      // 10. Person createPersonChildProvider guard keeps working with persona='designer' without crashing.
      const personSeen = [];
      const personChild = createPersonChildProvider({
        adapter: {
          async *stream(params) {
            personSeen.push(params);
            yield { type: 'text_delta', text: 'status: done\nconclusion: person ok' };
            yield { type: 'stop', stopReason: 'end_turn' };
          },
        },
        catalog: [{ id: 'openai/gpt-5.4', contextWindow: 128000, maxOutput: 4096, efforts: ['medium', 'xhigh'] }],
        defaultSelection: { model: 'openai/gpt-5.4', effort: 'xhigh' },
      }, null, config);
      const personCtx = {
        ...ctx,
        queryTurnId: 'turn-person-designer',
        parentEngineDeps: { ...deps, adapter: personChild.adapter, config: personChild.config, parentModel: personChild.config.model },
      };
      const personSpawn = JSON.parse(await agentTool.execute({
        name: 'person-designer',
        mission: 'Verify person guard compatibility',
        persona: 'designer',
      }, personCtx));
      expect(personSpawn.success).toBe(true);
      spawnedIds.push(personSpawn.agentId);
      const personWait = JSON.parse(await waitAgent.execute({ agent_id: personSpawn.agentId, timeout_ms: 2000 }, personCtx));
      expect(personWait.status).toBe(STATUS.IDLE);
      expect(personSeen[0].model).toBe('openai/gpt-5.4');
      // Person's guard still enforces its own medium child ceiling.
      expect(personSeen[0].effort).toBe('medium');
    } finally {
      for (const id of spawnedIds) {
        const record = getAgentRegistry().get(id);
        await closeAgent.execute({ agent_id: id }, ctx);
        if (record?.driverPromise) await record.driverPromise;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
