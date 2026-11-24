/**
 * runner.js — Unified execution kernel for system-owned Decision scenarios.
 *
 * All lightweight internal decisions (in-Session thread supplement routing,
 * cross-Session running/recent routing, new-Session folder & scene planning,
 * and future routing/triage tasks) flow through `runDecision`:
 *   1. Model resolution: explicit `model` -> `config.decisionModel` ->
 *      `config.fastModel` -> `config.primaryModel` -> `config.model`
 *   2. Scenario-specific system prompt + untrusted-data security preamble
 *   3. Hard deadline + caller AbortSignal propagation
 *   4. Strict JSON parsing + scenario allowlist/schema validation
 *   5. Conservative scenario-defined fallback on any error/timeout/invalid JSON
 *   6. Bounded local perf-trace telemetry
 */

import { perfNowMs, recordAgentPerfTrace } from '../perf-trace.js';
import { parseDecisionJsonObject } from './prompts/shared.js';
import { threadSupplementScenario } from './prompts/thread-supplement.js';
import { routeRunningSessionScenario } from './prompts/route-running-session.js';
import { routeRecentSessionScenario } from './prompts/route-recent-session.js';
import { planNewSessionScenario } from './prompts/plan-new-session.js';

const BUILTIN_SCENARIOS = new Map([
  [threadSupplementScenario.id, threadSupplementScenario],
  [routeRunningSessionScenario.id, routeRunningSessionScenario],
  [routeRecentSessionScenario.id, routeRecentSessionScenario],
  [planNewSessionScenario.id, planNewSessionScenario],
]);

/**
 * Resolve the effective model reference for Decision calls.
 * Fallback chain: decisionModel -> fastModel -> primaryModel -> model.
 *
 * @param {object | null | undefined} config
 * @param {string | null | undefined} [explicitModel]
 * @returns {string | null}
 */
export function resolveDecisionModel(config, explicitModel = null) {
  for (const candidate of [
    explicitModel,
    config?.decisionModel,
    config?.fastModel,
    config?.primaryModel,
    config?.model,
  ]) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

/**
 * Look up a registered system-owned Decision scenario definition.
 *
 * @param {string | object} scenarioOrId
 * @returns {object}
 */
export function getDecisionScenario(scenarioOrId) {
  if (scenarioOrId && typeof scenarioOrId === 'object' && typeof scenarioOrId.id === 'string') {
    return scenarioOrId;
  }
  const hit = BUILTIN_SCENARIOS.get(String(scenarioOrId || ''));
  if (!hit) {
    throw new Error(`Unknown decision scenario: ${String(scenarioOrId)}`);
  }
  return hit;
}

export function listDecisionScenarioIds() {
  return [...BUILTIN_SCENARIOS.keys()];
}

function clampTimeoutMs(timeoutMs, defaultTimeoutMs = 4_000) {
  const num = Number(timeoutMs);
  if (!Number.isFinite(num) || num <= 0) return defaultTimeoutMs;
  return Math.min(30_000, Math.max(20, Math.floor(num)));
}

/**
 * Execute a Decision scenario with bounded latency, strict output validation,
 * and guaranteed non-throwing fallback.
 *
 * @param {object} options
 * @param {string | object} options.scenario — Built-in scenario id or scenario spec
 * @param {object} [options.input={}] — Scenario input data
 * @param {object | null} [options.adapter] — LLMAdapter / AdapterRouter with `.call()`
 * @param {object | null} [options.config] — Agent/Session runtime config
 * @param {string | null} [options.model] — Optional explicit model override
 * @param {number} [options.timeoutMs] — Hard deadline in ms
 * @param {AbortSignal} [options.signal] — Caller cancellation signal
 * @param {string | null} [options.traceId] — Optional perfTraceId for telemetry
 * @param {string | null} [options.sessionId] — Optional sessionId for telemetry
 * @returns {Promise<{ result: any, meta: { scenario: string, model: string|null, durationMs: number, usedFallback: boolean, fallbackReason: string|null, usage: object|null } }>}
 */
export async function runDecision({
  scenario: scenarioOrId,
  input = {},
  adapter = null,
  config = null,
  model: explicitModel = null,
  timeoutMs,
  signal,
  traceId = null,
  sessionId = null,
} = {}) {
  const spec = getDecisionScenario(scenarioOrId);
  const startedAt = perfNowMs();
  const resolvedModel = resolveDecisionModel(config, explicitModel);

  const finish = (result, usedFallback, fallbackReason = null, usage = null) => {
    const durationMs = Math.max(0, Math.round((perfNowMs() - startedAt) * 100) / 100);
    if (traceId && config) {
      recordAgentPerfTrace(config, {
        traceId,
        phase: `decision:${spec.id}`,
        durationMs,
        sessionId,
        ok: !usedFallback,
        detail: {
          scenario: spec.id,
          model: resolvedModel,
          usedFallback,
          ...(fallbackReason ? { fallbackReason } : {}),
          ...(usage ? {
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
          } : {}),
        },
      });
    }
    return {
      result,
      meta: {
        scenario: spec.id,
        model: resolvedModel,
        durationMs,
        usedFallback,
        fallbackReason,
        usage,
      },
    };
  };

  if (!adapter || typeof adapter.call !== 'function') {
    return finish(spec.fallback(input, 'no_adapter'), true, 'no_adapter');
  }
  if (!resolvedModel) {
    return finish(spec.fallback(input, 'no_model'), true, 'no_model');
  }
  if (signal?.aborted) {
    return finish(spec.fallback(input, 'aborted'), true, 'aborted');
  }

  const effectiveTimeoutMs = clampTimeoutMs(timeoutMs, spec.defaultTimeoutMs || 4_000);
  const ctrl = new AbortController();
  let timer = null;
  let timedOut = false;
  const onCallerAbort = () => ctrl.abort();
  if (signal) signal.addEventListener('abort', onCallerAbort, { once: true });

  try {
    const systemPrompt = spec.buildSystemPrompt(input);
    const userPrompt = spec.buildUserPrompt(input);

    const response = await Promise.race([
      adapter.call({
        model: resolvedModel,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        maxTokens: spec.maxTokens || 256,
        signal: ctrl.signal,
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          ctrl.abort();
          reject(new Error(`decision_timeout:${effectiveTimeoutMs}ms`));
        }, effectiveTimeoutMs);
        if (typeof timer?.unref === 'function') timer.unref();
      }),
    ]);

    const parsed = parseDecisionJsonObject(response?.text);
    if (!parsed) {
      return finish(spec.fallback(input, 'invalid_json'), true, 'invalid_json', response?.usage || null);
    }
    const validated = spec.validate(parsed, input);
    if (!validated) {
      return finish(spec.fallback(input, 'invalid_decision'), true, 'invalid_decision', response?.usage || null);
    }
    return finish(validated, false, null, response?.usage || null);
  } catch (err) {
    const reason = timedOut
      ? 'timeout'
      : signal?.aborted
        ? 'aborted'
        : `decision_error:${String(err?.message || err).slice(0, 160)}`;
    return finish(spec.fallback(input, reason), true, reason);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onCallerAbort);
  }
}
