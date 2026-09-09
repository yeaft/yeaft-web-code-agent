import { LLMAdapter } from './adapter.js';

function tokenCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/**
 * Normalize one provider usage payload without double-counting cached input.
 * OpenAI includes cached tokens in input_tokens; Anthropic reports cache input
 * separately. Adapters expose that distinction through
 * `cacheTokensAreIncludedInInput`.
 */
export function normalizeTokenUsage(usage = {}) {
  const inputTokens = tokenCount(usage.inputTokens ?? usage.input_tokens);
  const outputTokens = tokenCount(usage.outputTokens ?? usage.output_tokens);
  const cacheReadTokens = tokenCount(
    usage.cacheReadTokens ?? usage.cache_read_tokens ?? usage.cache_read_input_tokens
  );
  const cacheWriteTokens = tokenCount(
    usage.cacheWriteTokens ?? usage.cache_write_tokens ?? usage.cache_creation_input_tokens
  );
  const explicitTotal = tokenCount(usage.totalTokens ?? usage.total_tokens);
  const cacheInputTokens = usage.cacheTokensAreIncludedInInput === true
    ? 0
    : cacheReadTokens + cacheWriteTokens;

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    ...(typeof usage.reasoningTokens === 'number' && Number.isFinite(usage.reasoningTokens) && usage.reasoningTokens >= 0
      ? { reasoningTokens: usage.reasoningTokens } : {}),
    totalTokens: explicitTotal || inputTokens + outputTokens + cacheInputTokens,
  };
}

function addUsage(total, usage) {
  const normalized = normalizeTokenUsage(usage);
  total.inputTokens += normalized.inputTokens;
  total.outputTokens += normalized.outputTokens;
  total.cacheReadTokens += normalized.cacheReadTokens;
  total.cacheWriteTokens += normalized.cacheWriteTokens;
  total.totalTokens += normalized.totalTokens;
  if (normalized.reasoningTokens !== undefined) total.reasoningTokens = (total.reasoningTokens || 0) + normalized.reasoningTokens;
}

/**
 * Wrap the shared adapter at the provider-call boundary. Every stream request
 * reports once after its event stream finishes or aborts, and every
 * non-streaming side call reports once whether it succeeds or fails.
 *
 * Parent VP engines, sub-agent engines, Dream, reflection, AMS, and classifiers
 * all reuse this adapter, so none need their own accounting hook.
 */
export class UsageAccountingAdapter extends LLMAdapter {
  #adapter;
  #onUsage;
  #onRequest;

  constructor(adapter, onUsage, onRequest = null) {
    super(adapter?.config || {});
    this.#adapter = adapter;
    this.#onUsage = onUsage;
    this.#onRequest = onRequest;
  }

  #requestParams(params) {
    if (typeof this.#onRequest !== 'function') return params;
    const upstream = params?.onRequestStart;
    return {
      ...params,
      onRequestStart: () => {
        try {
          upstream?.();
        } finally {
          try {
            this.#onRequest();
          } catch (error) {
            console.warn(`[llm-usage] request callback failed: ${error?.message || error}`);
          }
        }
      },
    };
  }

  #report(usage) {
    try {
      this.#onUsage(usage);
    } catch (error) {
      console.warn(`[llm-usage] accounting callback failed: ${error?.message || error}`);
    }
  }

  captureRequest() {
    const captured = typeof this.#adapter.captureRequest === 'function'
      ? this.#adapter.captureRequest()
      : null;
    return {
      captureStream: params => {
        const requestParams = this.#requestParams(params);
        const capture = captured?.captureStream
          || (typeof this.#adapter.captureStream === 'function'
            ? this.#adapter.captureStream.bind(this.#adapter)
            : this.#adapter.stream.bind(this.#adapter));
        return this.#streamWithAccounting(capture(requestParams));
      },
    };
  }

  captureStream(params) {
    // Preserve the wrapped adapter's request-capture boundary. In particular,
    // AdapterRouter freezes its provider catalog before the stream is iterated.
    return this.captureRequest().captureStream(params);
  }

  stream(params) {
    return this.captureStream(params);
  }

  async *#streamWithAccounting(upstreamStream) {
    const total = normalizeTokenUsage();
    try {
      for await (const event of upstreamStream) {
        if (event?.type === 'usage') addUsage(total, event);
        yield event;
      }
    } finally {
      this.#report(total);
    }
  }

  async call(params) {
    let usage = normalizeTokenUsage();
    try {
      const result = await this.#adapter.call(this.#requestParams(params));
      usage = normalizeTokenUsage(result?.usage || {});
      return result;
    } finally {
      this.#report(usage);
    }
  }

  refreshProviders(providers) {
    return this.#adapter.refreshProviders?.(providers);
  }

  getProviderForModel(modelId) {
    return this.#adapter.getProviderForModel?.(modelId) || null;
  }

  listAvailableModels() {
    return this.#adapter.listAvailableModels?.() || [];
  }
}

export function withUsageAccounting(adapter, onUsage, onRequest = null) {
  return typeof onUsage === 'function'
    ? new UsageAccountingAdapter(adapter, onUsage, onRequest)
    : adapter;
}
