import { loadConfig } from '../config.js';
import { createLLMAdapter } from '../llm/adapter.js';
import { applyAnthropicThinking } from '../llm/anthropic.js';
import { normalizeEffort, resolveContextWindow, resolveMaxOutputTokens } from '../models.js';
import { utf8PrefixWithinBytes } from '../utf8.js';
import { bytes, digest, fail, LIMITS, PersonError } from './contracts.js';

/** Only configured native API models; no Session initialization or implicit credential fallback. */
export async function createPersonProvider({ yeaftDir, config: suppliedConfig, adapter: suppliedAdapter, allowedModels, effortEnabled = process.env.YEAFT_THINKING_V1 === '1' }) {
  const config = suppliedConfig || loadConfig({ dir: yeaftDir });
  if (!config.providers?.length && !suppliedAdapter) fail('MODEL_UNAVAILABLE');
  const models = config.availableModels || [];
  const requestedDefault = config.primaryModel || config.model;
  // Match router ownership: exact qualified ref first; bare IDs use the first
  // configured provider. Resolve before allowlisting, sorting or truncating.
  const defaultModel = models.find(m => (m.ref || m.id) === requestedDefault)
    || models.find(m => m.id === requestedDefault);
  const defaultRef = defaultModel?.ref || defaultModel?.id;
  const available = models.filter(m => !allowedModels || allowedModels.includes(m.ref || m.id));
  const catalog = available.map(m => {
    const maxOutput = Math.min(4096, Math.floor(resolveMaxOutputTokens(m.id, { ...config, modelInfo: m })));
    const effortContext = { ...m, thinkingProtocol: m.effortProtocol || m.thinkingProtocol };
    const efforts = effortEnabled ? (m.effortOptions || []).filter(e => {
      if (!normalizeEffort(e)) return false;
      // Manual thinking can silently expand native max_tokens. Use the exact
      // adapter rules to admit only combinations that fit this fixed reserve;
      // adaptive and Responses effort do not require a larger output budget.
      const body = { max_tokens: maxOutput };
      applyAnthropicThinking(body, m.id, e, effortContext);
      return body.max_tokens === maxOutput;
    }) : [];
    return { id: m.ref || m.id, efforts, maxOutput,
      contextWindow: Math.floor(resolveContextWindow(m.id, { ...config, modelInfo: m })) };
  }).filter(m => typeof m.id === 'string' && m.id.length <= 256 && m.contextWindow > m.maxOutput + 1024 && m.maxOutput >= 256);
  catalog.sort((a, b) => Number(b.id === defaultRef) - Number(a.id === defaultRef));
  catalog.splice(8);
  if (!catalog.length) fail('MODEL_UNAVAILABLE');
  const adapter = suppliedAdapter || await createLLMAdapter(config);
  return { adapter, catalog, catalogRevision: digest(catalog), defaultSelection: { model: catalog[0].id, effort: null }, effortEnabled };
}

export function abortable(promise, signal) {
  if (signal.aborted) {
    // The operation may already have started while the signal was being aborted.
    // Observe its eventual rejection even though the caller has already cancelled.
    Promise.resolve(promise).catch(() => {});
    return Promise.reject(signal.reason || new PersonError('CANCELLED'));
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new PersonError('CANCELLED'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Consume only public text and usage. Bound accumulation before accepting any proposal. */
export async function collectOutput(adapter, params, onEffort) {
  const iterator = adapter.stream({ ...params, tools: [], onEffortDecision: decision => onEffort({
    effective: typeof decision.effective === 'string' ? decision.effective : null,
    wireMode: typeof decision.wireMode === 'string' ? decision.wireMode : null,
    thinkingEnabled: decision.thinkingEnabled === true,
  }) })[Symbol.asyncIterator]();
  let output = '', size = 0, stopReason = null, usage = null;
  try {
    while (true) {
      const item = await abortable(iterator.next(), params.signal);
      if (item.done) break;
      const event = item.value;
      if (event.type === 'text_delta') {
        size += bytes(event.text);
        if (size > LIMITS.outputBytes) {
          const room = LIMITS.outputBytes - bytes(output);
          // Keep a valid UTF-8 prefix, explicitly marked incomplete in the error below.
          output += utf8PrefixWithinBytes(event.text, room).text;
          fail('OUTPUT_LIMIT');
        }
        output += event.text;
      } else if (event.type === 'stop') stopReason = event.stopReason;
      else if (event.type === 'error') fail('PROVIDER_FAILED');
      else if (event.type === 'tool_call') fail('INVALID_PROPOSAL');
      else if (event.type === 'usage') {
        usage = {};
        for (const key of ['inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens']) if (Number.isFinite(event[key]) && event[key] >= 0) usage[key] = event[key];
      }
      // Hidden thinking, signatures, opaque provider state and raw HTTP exchanges are deliberately not archived.
    }
    if (stopReason !== 'end_turn') fail('INVALID_PROPOSAL');
    return { text: output, bytes: size, usage, stopReason };
  } catch (error) {
    const safe = error instanceof PersonError ? error : new PersonError('PROVIDER_FAILED');
    // This prefix is explicitly incomplete/rejected, never a full accepted record.
    safe.partialOutput = { text: output, retainedBytes: bytes(output), observedBytes: size, complete: false, accepted: false, usage, stopReason };
    throw safe;
  } finally {
    // Do not let a provider ignoring AbortSignal indefinitely block cancellation/close.
    try { Promise.resolve(iterator.return?.()).catch(() => {}); } catch { /* No raw provider errors. */ }
  }
}
