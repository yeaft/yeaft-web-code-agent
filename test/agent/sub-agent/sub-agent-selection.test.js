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
import waitAgent from '../../../agent/yeaft/tools/wait-agent.js';
import listAgents from '../../../agent/yeaft/tools/list-agents.js';
import closeAgent from '../../../agent/yeaft/tools/close-agent.js';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';
import { defineTool } from '../../../agent/yeaft/tools/types.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { Engine } from '../../../agent/yeaft/engine.js';
import { AdapterRouter } from '../../../agent/yeaft/llm/router.js';
import { GeminiAdapter } from '../../../agent/yeaft/llm/gemini.js';

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
      explicitEffortTarget: 'high',
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
    expect(resolveSubAgentSelection({ requestedScene: 'not-a-scene', config })).toMatchObject({ ok: false });

    // Catalog notice omits single-model configs and renders compact multi-model list otherwise.
    expect(formatSubAgentModelCatalogNotice({ availableModels: [config.availableModels[0]] }, 'en')).toBe('');
    const notice = formatSubAgentModelCatalogNotice(config, 'zh');
    expect(notice).toContain('openai/gpt-5.4 [medium,xhigh,max,ultra]');
    expect(notice).toContain('proxy/plain-no-effort [no-effort]');
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

    // Gemini adapter honors targetEffort on native thinkingLevel models.
    let capturedBody = null;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      capturedBody = JSON.parse(init.body);
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
    }).then(() => {
      expect(capturedBody.generationConfig.thinkingConfig.thinkingLevel).toBe('XHIGH');
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
      const wireSpawn = JSON.parse(await agentTool.execute({
        name: 'wire-designer',
        mission: 'Verify wire effort',
        persona: 'designer',
        model: 'openai/gpt-5.4',
      }, { ...ctx, parentEngineDeps: { ...deps, adapter: router } }));
      expect(wireSpawn.success).toBe(true);
      spawnedIds.push(wireSpawn.agentId);
      const wireWait = JSON.parse(await waitAgent.execute({ agent_id: wireSpawn.agentId, timeout_ms: 2000 }, { ...ctx, parentEngineDeps: { ...deps, adapter: router } }));
      expect(wireWait.status).toBe(STATUS.IDLE);
      expect(wirePayload.model).toBe('gpt-5.4');
      expect(wirePayload.reasoning).toEqual({ effort: 'xhigh' });
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
