import {
  THREAD_SUPPLEMENT_PROMPT,
  THREAD_SUPPLEMENT_SCENARIO_ID,
  buildThreadSupplementUserPrompt,
  fallbackShortTitle,
  fallbackThreadSupplement,
  parseDecisionJsonObject,
  runDecision,
  validateThreadSupplementOutput,
} from '../decision/index.js';

export const THREAD_CLASSIFIER_SYSTEM_PROMPT = THREAD_SUPPLEMENT_PROMPT;

export function fallbackTitle(query) {
  return fallbackShortTitle(query);
}

export function parseThreadClassification(text, runningThreads = [], query = '') {
  const parsed = parseDecisionJsonObject(text);
  if (!parsed) {
    return fallbackClassification(runningThreads, query, 'invalid_json');
  }
  return validateThreadClassification(parsed, runningThreads, query);
}

export function validateThreadClassification(value, runningThreads = [], query = '') {
  const validated = validateThreadSupplementOutput(value, { runningThreads, newQuery: query });
  if (validated) return validated;
  return fallbackClassification(runningThreads, query, 'invalid_decision');
}

export function fallbackClassification(runningThreads = [], query = '', reason = 'fallback') {
  return fallbackThreadSupplement({ runningThreads, newQuery: query }, reason);
}

export function buildThreadClassificationPrompt({ vp = {}, runningThreads = [], newQuery = '' } = {}) {
  return buildThreadSupplementUserPrompt({ vp, runningThreads, newQuery });
}

export async function classifyThread({ adapter, model, config, vp, runningThreads, newQuery, signal, timeoutMs, traceId, sessionId } = {}) {
  const { result } = await runDecision({
    scenario: THREAD_SUPPLEMENT_SCENARIO_ID,
    input: { vp, runningThreads, newQuery },
    adapter,
    config,
    model,
    timeoutMs,
    signal,
    traceId,
    sessionId,
  });
  return result;
}
