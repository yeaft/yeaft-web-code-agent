import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../agent/yeaft/config.js';
import { getLlmConfig, updateLlmConfig } from '../../../agent/yeaft/config-api.js';
import { removeProvider, setLocalModels } from '../../../agent/llm-config-cli.js';
import { classifyThread } from '../../../agent/yeaft/vp/thread-classifier.js';
import { AdapterRouter } from '../../../agent/yeaft/llm/router.js';
import { flushAgentPerfTrace } from '../../../agent/yeaft/perf-trace.js';
import {
  AUTO_ROUTE_SESSION_PROMPT,
  AUTO_ROUTE_SESSION_SCENARIO_ID,
  DEFAULT_AUTO_ROUTE_MATCH_MIN_CONFIDENCE,
  PLAN_NEW_SESSION_PROMPT,
  PLAN_NEW_SESSION_SCENARIO_ID,
  ROUTE_RECENT_SESSION_PROMPT,
  ROUTE_RECENT_SESSION_SCENARIO_ID,
  ROUTE_RUNNING_SESSION_PROMPT,
  ROUTE_RUNNING_SESSION_SCENARIO_ID,
  THREAD_SUPPLEMENT_PROMPT,
  THREAD_SUPPLEMENT_SCENARIO_ID,
  autoRouteSessionScenario,
  listDecisionScenarioIds,
  parseDecisionJsonObject,
  resolveDecisionModel,
  runDecision,
} from '../../../agent/yeaft/decision/index.js';

let tempRoot = null;
afterEach(() => {
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

function createTempYeaftDir(configObj = null) {
  tempRoot = mkdtempSync(join(tmpdir(), 'yeaft-decision-'));
  if (configObj !== null) {
    writeFileSync(join(tempRoot, 'config.json'), JSON.stringify(configObj, null, 2));
  }
  return tempRoot;
}

describe('protocol-qualified Quick Send configuration', () => {
  it('round-trips inherited Chat High, honors per-model overrides, and repairs old Carbon presets', () => {
    const id = 'gemini-4-carbon';
    const providers = [{ name: 'chat', protocol: 'openai-chat-completions', baseUrl: 'https://chat.invalid/v1', models: [
      id, { id: 'generic', effortOptions: ['high'] }, { id: 'overridden', protocol: 'openai-responses', effortOptions: ['high'] },
    ] }, { name: 'responses', protocol: 'openai-responses', baseUrl: 'https://responses.invalid/v1', models: [id] }];
    const quickSends = [`chat/${id}`, `responses/${id}`, 'chat/generic'].map((model, i) => ({
      id: `preset-${i}`, name: model, model, effort: ['xhigh', 'high', 'high'][i],
    }));
    const dir = createTempYeaftDir({ providers, quickSends });
    expect(getLlmConfig(dir).quickSends.map(item => item.effort)).toEqual(['high', 'xhigh', 'high']);
    const updated = updateLlmConfig({ providers, quickSends }, dir);
    expect(updated.error).toBeUndefined();
    expect(updated.quickSends.map(item => item.effort)).toEqual(['high', 'xhigh', 'high']);
    const expected = [
      { protocol: 'openai-chat-completions', effortOptions: ['medium', 'high'] },
      { protocol: 'openai-chat-completions', effortOptions: ['high'] },
      { protocol: 'openai-responses', effortOptions: ['xhigh'] },
      { protocol: 'openai-responses', effortOptions: ['medium', 'xhigh', 'max', 'ultra'] },
    ];
    expect(updated.availableModels).toMatchObject(expected);
    expect(loadConfig({ dir }).availableModels).toMatchObject(expected);
    expect(getLlmConfig(dir).providers[0].models[1]).toEqual({ id: 'generic', effortOptions: ['high'] });
    expect(updateLlmConfig({ quickSends: [{ ...quickSends[0], model: id }] }, dir).error).toContain('unambiguous');
  });
});

describe('Agent-owned sub-agent scene routes', () => {
  it('round-trips through LLM settings and runtime, rejects invalid writes atomically, and retains unavailable routes for repair', () => {
    const providers = ['p1', 'p2'].map(name => ({ name, baseUrl: `https://${name}.test`, models: ['native', 'router/gpt-small'] }));
    const dir = createTempYeaftDir({ providers, primaryModel: 'p1/native' });
    expect(getLlmConfig(dir).agentConfig.subAgentSceneModels).toEqual({});
    const routes = { software: 'p2/native', frontend: 'p1/router/gpt-small' };
    const updated = updateLlmConfig({ fastModel: 'p1/native', subAgentSceneModels: routes }, dir);
    expect(updated.error).toBeUndefined();
    expect(updated.agentConfig.subAgentSceneModels).toEqual(routes);
    expect(loadConfig({ dir }).subAgentSceneModels).toEqual(routes);
    const before = readFileSync(join(dir, 'config.json'), 'utf8');
    for (const invalid of [[], { notAScene: 'p1/native' }, { general: 'native' }, { general: 'p3/native' }]) {
      expect(updateLlmConfig({ subAgentSceneModels: invalid }, dir).error).toBeTruthy();
      expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe(before);
    }
    expect(updateLlmConfig({ providers: [...providers, providers[0]], subAgentSceneModels: { general: 'p1/native' } }, dir).error)
      .toContain('unambiguous');
    expect(updateLlmConfig({ providers: providers.slice(0, 1), subAgentSceneModels: routes }, dir).error).toBeUndefined();
    expect(getLlmConfig(dir).subAgentSceneModels).toEqual(routes);
    expect(updateLlmConfig({ debug: true }, dir).subAgentSceneModels).toEqual(routes);
    expect(updateLlmConfig({ fastModel: null, subAgentSceneModels: {} }, dir).subAgentSceneModels).toEqual({});
    expect(getLlmConfig(dir).fastModel).toBeNull();
  });
});

describe('legacy Fast Model config', () => {
  it('retains vendor-qualified legacy IDs when saving alongside a managed provider', () => {
    const legacy = { name: 'proxy', baseUrl: 'https://proxy.invalid', models: ['github-copilot/legacy-fast'] };
    const managed = { name: 'github-copilot', credentialProvider: 'github-copilot', models: ['gpt-5.4'] };
    const providers = [legacy, managed];
    const dir = createTempYeaftDir({ providers });
    for (const fastModel of ['github-copilot/legacy-fast', 'global:old/github-copilot/legacy-fast']) {
      expect(updateLlmConfig({ providers, fastModel }, dir).fastModel).toBe(fastModel);
      expect(loadConfig({ dir }).fastModel).toBe('github-copilot/legacy-fast');
    }
    expect(updateLlmConfig({ providers, fastModel: 'github-copilot/removed' }, dir).fastModel).toBe('github-copilot/gpt-5.4');
  });
});

describe('Decision model configuration & scenario-tailored runner', () => {
  it('resolves decisionModel via decisionModel -> fastModel -> primaryModel across config, config-api, and CLI helpers', () => {
    const dir = createTempYeaftDir({
      providers: [{
        name: 'proxy',
        baseUrl: 'http://localhost:6628/v1',
        apiKey: 'sk-test',
        protocol: 'openai-responses',
        models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1-mini'],
      }],
      primaryModel: 'proxy/gpt-5',
      fastModel: 'proxy/gpt-5-mini',
    });

    const inherited = loadConfig({ dir });
    expect(inherited.decisionModel).toBe('proxy/gpt-5-mini');
    expect(inherited.decisionModelId).toBe('gpt-5-mini');
    expect(resolveDecisionModel(inherited)).toBe('proxy/gpt-5-mini');
    expect(getLlmConfig(dir).decisionModel).toBeNull();

    const updated = updateLlmConfig({ decisionModel: 'proxy/gpt-4.1-mini' }, dir);
    expect(updated.error).toBeUndefined();
    expect(updated.decisionModel).toBe('proxy/gpt-4.1-mini');
    expect(updated.agentConfig.decisionModel).toBe('proxy/gpt-4.1-mini');

    const explicit = loadConfig({ dir });
    expect(explicit.decisionModel).toBe('proxy/gpt-4.1-mini');
    expect(explicit.decisionModelId).toBe('gpt-4.1-mini');
    expect(resolveDecisionModel(explicit)).toBe('proxy/gpt-4.1-mini');

    // Clearing decisionModel falls back to fastModel -> primaryModel without touching fastModel.
    const cleared = updateLlmConfig({ decisionModel: null }, dir);
    expect(cleared.decisionModel).toBeNull();
    expect(cleared.fastModel).toBe('proxy/gpt-5-mini');
    expect(loadConfig({ dir }).decisionModel).toBe('proxy/gpt-5-mini');

    // CLI helpers support --decision and clean up orphaned provider refs.
    const cliSet = setLocalModels({ providers: [] }, { decision: 'proxy/gpt-4.1-mini' });
    expect(cliSet.config.decisionModel).toBe('proxy/gpt-4.1-mini');
    const cliRemoved = removeProvider(cliSet.config, { name: 'proxy' });
    expect(cliRemoved.cleared).toContain('decisionModel');
    expect(cliRemoved.config.decisionModel).toBeUndefined();

    // Runtime overrides normalize global: prefix and derive decisionModelId consistently.
    const overridden = loadConfig({ dir, decisionModel: 'global:proxy/gpt-4.1-mini' });
    expect(overridden.decisionModel).toBe('gpt-4.1-mini');
    expect(overridden.decisionModelId).toBe('gpt-4.1-mini');

    // Managed Copilot catalog refresh clears a removed decisionModel to null (Auto) instead of pinning primary.
    const copilotUpdated = updateLlmConfig({
      providers: [
        { name: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-1', protocol: 'openai-responses', models: ['gpt-5'] },
        { name: 'github-copilot', credentialProvider: 'github-copilot', managed: 'github-copilot', models: ['gpt-5.4-mini'] },
      ],
      primaryModel: 'openai/gpt-5',
      decisionModel: 'github-copilot/retired-fast-model',
    }, dir);
    expect(copilotUpdated.decisionModel).toBeNull();
    expect(copilotUpdated.primaryModel).toBe('openai/gpt-5');
  });

  it('keeps distinct system-owned prompts per scenario and enforces strict allowlists, confidence thresholds, and timeout fallback', async () => {
    expect(listDecisionScenarioIds()).toEqual([
      THREAD_SUPPLEMENT_SCENARIO_ID,
      ROUTE_RUNNING_SESSION_SCENARIO_ID,
      ROUTE_RECENT_SESSION_SCENARIO_ID,
      PLAN_NEW_SESSION_SCENARIO_ID,
      AUTO_ROUTE_SESSION_SCENARIO_ID,
    ]);
    const prompts = new Set([
      THREAD_SUPPLEMENT_PROMPT,
      ROUTE_RUNNING_SESSION_PROMPT,
      ROUTE_RECENT_SESSION_PROMPT,
      PLAN_NEW_SESSION_PROMPT,
      AUTO_ROUTE_SESSION_PROMPT,
    ]);
    expect(prompts.size).toBe(5);
    for (const prompt of prompts) {
      expect(prompt).toContain('UNTRUSTED DATA');
    }
    expect(autoRouteSessionScenario.maxTokens).toBeGreaterThanOrEqual(1024);
    expect(autoRouteSessionScenario.defaultTimeoutMs).toBeGreaterThanOrEqual(8_000);

    const dir = createTempYeaftDir({ telemetry: { enabled: true, flushIntervalMs: 60_000 } });
    const calls = [];

    // 1. Running-Session router: accepts high-confidence listed Session, rejects unlisted or low-confidence, never forces single-session match on error.
    const runningHit = await runDecision({
      scenario: ROUTE_RUNNING_SESSION_SCENARIO_ID,
      config: { yeaftDir: dir, decisionModel: 'proxy/decision-fast', fastModel: 'proxy/fast', primaryModel: 'proxy/main' },
      traceId: 'trace-decision-1',
      adapter: {
        async call(params) {
          calls.push(params);
          return {
            text: '```json\n{"decision":"match","sessionId":"sess_live_1","answeredRequestId":"ask_1","confidence":0.92,"reason":"answers pending AskUser"}\n```',
            usage: { inputTokens: 120, outputTokens: 28 },
          };
        },
      },
      input: {
        newQuery: '选方案 A',
        runningSessions: [{
          sessionId: 'sess_live_1',
          title: 'Refactor router',
          pendingQuestions: [{ requestId: 'ask_1', question: '选方案 A 还是 B？', options: ['A', 'B'] }],
          recentMessages: [{ role: 'assistant', text: '选方案 A 还是 B？' }],
        }],
      },
    });
    expect(calls[0].model).toBe('proxy/decision-fast');
    expect(calls[0].system).toBe(ROUTE_RUNNING_SESSION_PROMPT);
    expect(runningHit.result).toEqual({
      decision: 'match',
      sessionId: 'sess_live_1',
      answeredRequestId: 'ask_1',
      confidence: 0.92,
      reason: 'answers pending AskUser',
    });
    expect(runningHit.meta.usedFallback).toBe(false);

    const runningLowConf = await runDecision({
      scenario: ROUTE_RUNNING_SESSION_SCENARIO_ID,
      config: { decisionModel: 'proxy/decision-fast' },
      adapter: {
        async call() {
          return { text: '{"decision":"match","sessionId":"sess_live_1","confidence":0.4,"reason":"weak"}' };
        },
      },
      input: {
        newQuery: '今天天气怎么样',
        runningSessions: [{ sessionId: 'sess_live_1', title: 'Refactor router' }],
      },
    });
    expect(runningLowConf.result.decision).toBe('none');
    expect(runningLowConf.result.sessionId).toBeNull();

    const runningTimeout = await runDecision({
      scenario: ROUTE_RUNNING_SESSION_SCENARIO_ID,
      config: { decisionModel: 'proxy/decision-fast' },
      timeoutMs: 25,
      adapter: {
        call({ signal }) {
          return new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        },
      },
      input: {
        newQuery: '顺便跑一下测试',
        runningSessions: [{ sessionId: 'sess_live_1', title: 'Only running session' }],
      },
    });
    // Cross-Session running route must NOT blindly inject into the sole running Session on timeout.
    expect(runningTimeout.result).toMatchObject({ decision: 'none', sessionId: null });
    expect(runningTimeout.meta).toMatchObject({ usedFallback: true, fallbackReason: 'timeout' });

    // 2. Recent-Session router: rejects hallucinated sessionId and sanitizes searchKeywords.
    const recentUnlisted = await runDecision({
      scenario: ROUTE_RECENT_SESSION_SCENARIO_ID,
      config: { decisionModel: 'proxy/decision-fast' },
      adapter: {
        async call() {
          return {
            text: '{"decision":"match","sessionId":"sess_invented","confidence":0.95,"searchKeywords":["discovery","fts5","discovery","extra"],"reason":"hallucinated"}',
          };
        },
      },
      input: {
        newQuery: '帮我查一下上周那个 FTS5 索引讨论',
        candidateSessions: [{ sessionId: 'sess_recent_1', title: 'UI buttons' }],
      },
    });
    expect(recentUnlisted.result).toEqual({
      decision: 'create',
      sessionId: null,
      confidence: 0,
      searchKeywords: ['discovery', 'fts5', 'extra'],
      reason: 'hallucinated',
    });

    // 3. New-Session planner: enforces exact folder allowlist & supported scene list.
    const plannedBlockedFolder = await runDecision({
      scenario: PLAN_NEW_SESSION_SCENARIO_ID,
      config: { decisionModel: 'proxy/decision-fast' },
      adapter: {
        async call() {
          return {
            text: '{"sceneId":"unsupported-scene","workDir":"/etc/passwd","title":"修复前端样式","reason":"invented path"}',
          };
        },
      },
      input: {
        newQuery: '帮我调一下按钮圆角',
        allowedScenes: ['general', 'software'],
        candidateFolders: [{ path: '/workspace/yeaft-web-code-agent', name: 'yeaft-web-code-agent' }],
      },
    });
    expect(plannedBlockedFolder.result).toEqual({
      sceneId: 'general',
      workDir: '',
      title: '修复前端样式',
      reason: 'invented path',
    });

    const plannedValid = await runDecision({
      scenario: PLAN_NEW_SESSION_SCENARIO_ID,
      config: { decisionModel: 'proxy/decision-fast' },
      adapter: {
        async call() {
          return {
            text: '{"sceneId":"frontend","workDir":"/workspace/yeaft-web-code-agent","title":"调整按钮圆角","reason":"matched repo"}',
          };
        },
      },
      input: {
        newQuery: '把 yeaft 里的按钮圆角调一下',
        allowedScenes: ['general', 'software', 'frontend'],
        candidateFolders: [{ path: '/workspace/yeaft-web-code-agent', name: 'yeaft-web-code-agent' }],
      },
    });
    expect(plannedValid.result).toEqual({
      sceneId: 'frontend',
      workDir: '/workspace/yeaft-web-code-agent',
      title: '调整按钮圆角',
      reason: 'matched repo',
    });

    // 3b. Unified auto-route-session scenario: validates running+idle allowlist, the replay-calibrated
    // 0.5 match floor for every message, and single-shot create allowlists.
    expect(DEFAULT_AUTO_ROUTE_MATCH_MIN_CONFIDENCE).toBe(0.5);
    const unifiedShortCont = await runDecision({
      scenario: AUTO_ROUTE_SESSION_SCENARIO_ID,
      config: { decisionModel: 'proxy/decision-fast' },
      adapter: {
        async call() {
          return { text: '{"decision":"match","sessionId":"sess_idle_1","answeredRequestId":null,"confidence":0.62,"reason":"continues prior plan"}' };
        },
      },
      input: {
        newQuery: '下一步咱们要做什么来着？',
        candidates: [{ sessionId: 'sess_idle_1', title: 'Plan', state: 'idle', ageText: '12m ago', recentMessages: [{ role: 'assistant', text: '准备做第二步' }] }],
        allowedScenes: ['general', 'software'],
        candidateFolders: [{ path: '/workspace/app', name: 'app' }],
      },
    });
    expect(unifiedShortCont.result).toMatchObject({ decision: 'match', sessionId: 'sess_idle_1', confidence: 0.62 });

    const unifiedNormalMidConf = await runDecision({
      scenario: AUTO_ROUTE_SESSION_SCENARIO_ID,
      config: { decisionModel: 'proxy/decision-fast' },
      adapter: {
        async call() {
          return { text: '{"decision":"match","sessionId":"sess_idle_1","confidence":0.62,"reason":"best guess among similar Sessions"}' };
        },
      },
      input: {
        newQuery: '把刚才的方案第二步展开写一下',
        candidates: [{ sessionId: 'sess_idle_1', title: 'Plan', state: 'idle', ageText: '12m ago' }],
        allowedScenes: ['general', 'writing'],
        candidateFolders: [{ path: '/workspace/app', name: 'app' }],
      },
    });
    expect(unifiedNormalMidConf.result).toMatchObject({ decision: 'match', sessionId: 'sess_idle_1', confidence: 0.62 });

    const unifiedNormalLowConf = await runDecision({
      scenario: AUTO_ROUTE_SESSION_SCENARIO_ID,
      config: { decisionModel: 'proxy/decision-fast' },
      adapter: {
        async call() {
          return { text: '{"decision":"match","sessionId":"sess_idle_1","confidence":0.42,"sceneId":"writing","workDir":"/etc/passwd","title":"写产品文档","reason":"weak match"}' };
        },
      },
      input: {
        newQuery: '帮我写一篇全新的技术架构科普文章',
        candidates: [{ sessionId: 'sess_idle_1', title: 'Plan', state: 'idle', ageText: '12m ago' }],
        allowedScenes: ['general', 'writing'],
        candidateFolders: [{ path: '/workspace/app', name: 'app' }],
      },
    });
    expect(unifiedNormalLowConf.result).toMatchObject({
      decision: 'create',
      sessionId: null,
      sceneId: 'writing',
      workDir: '',
      title: '写产品文档',
    });

    // 4. Legacy thread-classifier delegates through Decision runner and honors config.decisionModel.
    let classifiedModel = null;
    const threadDecision = await classifyThread({
      config: { decisionModel: 'proxy/decision-fast', fastModel: 'proxy/fast' },
      adapter: {
        async call(params) {
          classifiedModel = params.model;
          return { text: '{"decision":"related","targetThreadId":"thr_1","title":"补充条件","reason":"continues thread"}' };
        },
      },
      runningThreads: [{ threadId: 'thr_1', title: 'Initial task' }],
      newQuery: '再加一个单测',
    });
    expect(classifiedModel).toBe('proxy/decision-fast');
    expect(threadDecision).toEqual({
      decision: 'related',
      targetThreadId: 'thr_1',
      title: '补充条件',
      reason: 'continues thread',
    });

    expect(flushAgentPerfTrace({ yeaftDir: dir })).toBeGreaterThanOrEqual(1);
    const day = new Date().toISOString().slice(0, 10);
    const traceLog = readFileSync(join(dir, 'perf-traces', `${day}.jsonl`), 'utf8');
    expect(traceLog).toContain('"phase":"decision:route-running-session"');
    expect(traceLog).toContain('"model":"proxy/decision-fast"');

    // 5. String-aware balanced JSON extraction handles leading/trailing braces and braces inside strings.
    expect(parseDecisionJsonObject('Checking {candidateSessions}: {"decision":"match","sessionId":"sess_1","reason":"matched {ok}"} (Note: {done})'))
      .toEqual({ decision: 'match', sessionId: 'sess_1', reason: 'matched {ok}' });

    // 6. Trimmed candidate IDs in allowlists match trimmed prompt IDs.
    const trimmedMatch = await runDecision({
      scenario: ROUTE_RUNNING_SESSION_SCENARIO_ID,
      config: { decisionModel: 'proxy/decision-fast' },
      adapter: {
        async call() {
          return { text: '{"decision":"match","sessionId":"sess_padded","confidence":0.95,"reason":"trimmed"}' };
        },
      },
      input: {
        newQuery: 'yes',
        runningSessions: [{ sessionId: '  sess_padded  ', title: 'Padded ID' }],
      },
    });
    expect(trimmedMatch.result).toMatchObject({ decision: 'match', sessionId: 'sess_padded' });

    // 7. Wire check through real AdapterRouter + OpenAIResponsesAdapter with YEAFT_THINKING_V1=1:
    // runDecision must NOT inject reasoning.effort on tight 220-256 token classification calls.
    const prevThinkingFlag = process.env.YEAFT_THINKING_V1;
    const prevFetch = globalThis.fetch;
    const wireBodies = [];
    process.env.YEAFT_THINKING_V1 = '1';
    globalThis.fetch = async (_url, init) => {
      wireBodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({
        id: 'resp_dec_1',
        status: 'completed',
        output_text: '{"decision":"none","sessionId":null,"confidence":0.1,"reason":"unrelated"}',
        usage: { input_tokens: 90, output_tokens: 20 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
      const router = new AdapterRouter({
        providers: [{
          name: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-wire-test',
          protocol: 'openai-responses',
          models: ['gpt-5-mini'],
        }],
      });
      const wireDecision = await runDecision({
        scenario: ROUTE_RUNNING_SESSION_SCENARIO_ID,
        adapter: router,
        config: { decisionModel: 'openai/gpt-5-mini' },
        input: { newQuery: 'hello', runningSessions: [{ sessionId: 's1', title: 'Task 1' }] },
      });
      expect(wireDecision.meta.usedFallback).toBe(false);
      expect(wireDecision.result).toMatchObject({ decision: 'none', sessionId: null });
      expect(wireBodies).toHaveLength(1);
      expect(wireBodies[0].reasoning).toBeUndefined();
      expect(wireBodies[0].max_output_tokens).toBe(768);
    } finally {
      globalThis.fetch = prevFetch;
      if (prevThinkingFlag === undefined) delete process.env.YEAFT_THINKING_V1;
      else process.env.YEAFT_THINKING_V1 = prevThinkingFlag;
    }
  });
});
