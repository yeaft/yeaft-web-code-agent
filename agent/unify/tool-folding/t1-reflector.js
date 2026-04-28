/**
 * t1-reflector.js — V7 in-turn (synchronous) reflection (PR-L).
 *
 * Triggered when the current turn has accumulated TOOL_BATCH_SIZE (13) tool
 * results and the engine is about to loop back into adapter.stream(). Calls
 * the PRIMARY model — never the fast model — to generate a markdown
 * reflection over the batch.
 *
 * On success: returns { content, durationMs }.
 * On failure: throws (engine catches and leaves history unchanged).
 */

import { buildReflectionPrompt } from './reflection-prompt.js';

/**
 * @param {{
 *   adapter: { call: Function },
 *   model: string,
 *   originalUserMsg: string,
 *   toolPairs: Array<{ name: string, input: any, output: string, isError: boolean }>,
 *   assistantText?: string,
 *   signal?: AbortSignal,
 * }} p
 * @returns {Promise<{ content: string, durationMs: number }>}
 */
export async function runT1Reflection({ adapter, model, originalUserMsg, toolPairs, assistantText, signal }) {
  const t0 = Date.now();
  const prompt = buildReflectionPrompt({ originalUserMsg, toolPairs, assistantText });
  const result = await adapter.call({
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
  return { content, durationMs: Date.now() - t0 };
}
