/**
 * t1-reflector.js — V7 in-turn (synchronous) reflection (PR-L).
 *
 * Triggered after each interval of 30 completed tool loops, immediately before
 * the engine loops back into adapter.stream(). Parallel calls returned in one
 * assistant tool-use batch count as one loop. Calls
 * the PRIMARY model — never the fast model — to generate a markdown
 * reflection over the batch.
 *
 * On success: returns { content, durationMs }.
 * On failure: throws (engine catches and leaves history unchanged).
 *
 * The `language` param is forwarded to buildReflectionPrompt so the prompt
 * (and therefore the model's response) renders in the user's language. The
 * engine reads this from config.language and passes it through.
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
export async function runT1Reflection({ adapter, model, originalUserMsg, toolPairs, assistantText, language, signal, onComplete }) {
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
      throw new Error('T1 reflection returned empty content');
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
