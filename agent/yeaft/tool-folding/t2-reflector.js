/**
 * t2-reflector.js — V7 end-of-turn (asynchronous) reflection (PR-L).
 *
 * Same prompt and primary-model call as T1, but kicked off without await.
 * The engine stores the resulting promise on the instance; on the next
 * query() it checks (non-blocking) whether the promise has resolved and
 * either rewrites history with the reflection or falls back to the
 * exec-log stub.
 */

import { buildReflectionPrompt } from './reflection-prompt.js';
import { normalizeTokenUsage } from '../llm/usage-accounting.js';

/**
 * @param {{
 *   adapter: { call: Function },
 *   model: string,
 *   originalUserMsg: string,
 *   toolPairs: Array<{ name: string, input: any, output: string, isError: boolean }>,
 *   assistantText?: string,
 *   language?: string,
 *   signal?: AbortSignal,
 *   onComplete?: (diagnostic: object) => void,
 * }} p
 * @returns {Promise<{ content: string, durationMs: number, usage: object }>}
 */
export async function runT2Reflection({ adapter, model, originalUserMsg, toolPairs, assistantText, language, signal, onComplete }) {
  const t0 = Date.now();
  const prompt = buildReflectionPrompt({ originalUserMsg, toolPairs, assistantText, language });
  let result;
  let failure;
  try {
    result = await adapter.call({
      model,
      system: prompt,
      messages: [{ role: 'user', content: 'Produce the reflection now.' }],
      maxTokens: 2048,
      signal,
    });
    const content = (result && typeof result.text === 'string') ? result.text.trim() : '';
    if (!content) {
      throw new Error('T2 reflection returned empty content');
    }
    return { content, durationMs: Date.now() - t0, usage: normalizeTokenUsage(result?.usage) };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    // Diagnostic only; the adapter owns billing/usage accounting. Never
    // double-charge it or fail a completed reflection on a logging error.
    try {
      onComplete?.({
        status: failure ? 'error' : 'ready',
        durationMs: Date.now() - t0,
        usage: normalizeTokenUsage(result?.usage),
        usageReported: !!result?.usage,
        ...(failure ? { error: String(failure.message || failure).slice(0, 512) } : {}),
      });
    } catch { /* best-effort diagnostics */ }
  }
}
