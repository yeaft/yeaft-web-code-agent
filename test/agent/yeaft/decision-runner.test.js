import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../agent/yeaft/config.js';
import { getLlmConfig, updateLlmConfig } from '../../../agent/yeaft/config-api.js';
import { removeProvider, setLocalModels } from '../../../agent/llm-config-cli.js';
import { classifyThread } from '../../../agent/yeaft/vp/thread-classifier.js';
import { flushAgentPerfTrace } from '../../../agent/yeaft/perf-trace.js';
import {
  PLAN_NEW_SESSION_PROMPT,
  PLAN_NEW_SESSION_SCENARIO_ID,
  ROUTE_RECENT_SESSION_PROMPT,
  ROUTE_RECENT_SESSION_SCENARIO_ID,
  ROUTE_RUNNING_SESSION_PROMPT,
  ROUTE_RUNNING_SESSION_SCENARIO_ID,
  THREAD_SUPPLEMENT_PROMPT,
  THREAD_SUPPLEMENT_SCENARIO_ID,
  listDecisionScenarioIds,
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
  });

  it('keeps distinct system-owned prompts per scenario and enforces strict allowlists, confidence thresholds, and timeout fallback', async () => {
    expect(listDecisionScenarioIds()).toEqual([
      THREAD_SUPPLEMENT_SCENARIO_ID,
      ROUTE_RUNNING_SESSION_SCENARIO_ID,
      ROUTE_RECENT_SESSION_SCENARIO_ID,
      PLAN_NEW_SESSION_SCENARIO_ID,
    ]);
    const prompts = new Set([
      THREAD_SUPPLEMENT_PROMPT,
      ROUTE_RUNNING_SESSION_PROMPT,
      ROUTE_RECENT_SESSION_PROMPT,
      PLAN_NEW_SESSION_PROMPT,
    ]);
    expect(prompts.size).toBe(4);
    for (const prompt of prompts) {
      expect(prompt).toContain('UNTRUSTED DATA');
    }

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
            text: '```json\n{"decision":"match","sessionId":"sess_live_1","confidence":0.92,"reason":"answers pending AskUser"}\n```',
            usage: { inputTokens: 120, outputTokens: 28 },
          };
        },
      },
      input: {
        newQuery: '选方案 A',
        runningSessions: [{
          sessionId: 'sess_live_1',
          title: 'Refactor router',
          pendingQuestion: { question: '选方案 A 还是 B？', options: ['A', 'B'] },
          recentMessages: [{ role: 'assistant', text: '选方案 A 还是 B？' }],
        }],
      },
    });
    expect(calls[0].model).toBe('proxy/decision-fast');
    expect(calls[0].system).toBe(ROUTE_RUNNING_SESSION_PROMPT);
    expect(runningHit.result).toEqual({
      decision: 'match',
      sessionId: 'sess_live_1',
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
  });
});
