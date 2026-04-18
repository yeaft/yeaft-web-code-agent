/**
 * router.js — AdapterRouter: routes LLM calls to the correct provider adapter
 *
 * Given a providers array from config.json:
 *   [{ name, baseUrl, apiKey, protocol?, models[] }, ...]
 *
 * The router resolves model → provider, lazy-creates the right adapter
 * (AnthropicAdapter or ChatCompletionsAdapter based on protocol), caches it,
 * and forwards stream()/call() to the resolved adapter.
 *
 * protocol defaults to "openai" (Chat Completions API).
 * Set protocol: "anthropic" only for direct Anthropic API connections.
 */

import { LLMAdapter } from './adapter.js';
import { getThinkingCapability, normalizeEffort } from '../models.js';

/**
 * task-327a: feature-flag accessor. Read lazily so tests can flip.
 */
function thinkingV1Enabled() {
  return process.env.UNIFY_THINKING_V1 === '1';
}

/**
 * task-327a: router-level effort filter.
 *
 * Strips `effort` from the outgoing params when:
 *   - feature flag is off (thinkingV1 == off)
 *   - effort value is unknown
 *   - model capability is `thinkingProtocol: 'none'` (silently drop)
 *
 * Adapter-level guards also enforce these rules; this is defense in depth
 * so a no-op path stays consistently a no-op regardless of adapter.
 *
 * @param {object} params
 * @returns {object} new params object with effort possibly removed
 */
export function filterEffortForModel(params) {
  if (!params || !('effort' in params)) return params;
  if (!thinkingV1Enabled()) {
    const { effort: _drop, ...rest } = params;
    return rest;
  }
  const norm = normalizeEffort(params.effort);
  if (!norm) {
    const { effort: _drop, ...rest } = params;
    return rest;
  }
  const cap = getThinkingCapability(params.model);
  if (!cap.supportsThinking || cap.thinkingProtocol === 'none') {
    const { effort: _drop, ...rest } = params;
    return rest;
  }
  return { ...params, effort: norm };
}

/**
 * AdapterRouter — Implements LLMAdapter, routes by model → provider.
 */
export class AdapterRouter extends LLMAdapter {
  /** @type {Map<string, object>} modelId → provider config */
  #modelToProvider;

  /** @type {Map<string, LLMAdapter>} providerName → cached adapter */
  #adapterCache;

  /** @type {object[]} raw providers array */
  #providers;

  /**
   * @param {{ providers: object[], config?: object }} params
   * @param {object[]} params.providers — Array of { name, baseUrl, apiKey, protocol?, models[] }
   */
  constructor({ providers }) {
    super();
    this.#providers = providers;
    this.#modelToProvider = new Map();
    this.#adapterCache = new Map();

    // Build model → provider index
    // First provider wins if model appears in multiple providers
    for (const provider of providers) {
      if (!Array.isArray(provider.models)) continue;
      for (const modelId of provider.models) {
        if (!this.#modelToProvider.has(modelId)) {
          this.#modelToProvider.set(modelId, provider);
        }
      }
    }
  }

  /**
   * Resolve a model ID to its provider's adapter (lazy-created, cached).
   *
   * @param {string} modelId
   * @returns {Promise<LLMAdapter>}
   */
  async #resolveAdapter(modelId) {
    const provider = this.#modelToProvider.get(modelId);
    if (!provider) {
      throw new Error(
        `Model "${modelId}" not found in any provider. ` +
        `Available models: ${[...this.#modelToProvider.keys()].join(', ') || '(none)'}. ` +
        `Check your config.json providers[].models arrays.`
      );
    }

    // Check cache
    const cached = this.#adapterCache.get(provider.name);
    if (cached) return cached;

    // Create adapter based on protocol
    const protocol = provider.protocol || 'openai';
    let adapter;

    if (protocol === 'anthropic') {
      const { AnthropicAdapter } = await import('./anthropic.js');
      adapter = new AnthropicAdapter({
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
      });
    } else if (protocol === 'openai-responses') {
      // OpenAI Responses API (/v1/responses) — next-gen, recommended for GPT-5+
      const { OpenAIResponsesAdapter } = await import('./openai-responses.js');
      adapter = new OpenAIResponsesAdapter({
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
      });
    } else {
      // Default: openai (Chat Completions API) — covers proxy, OpenAI, DeepSeek, Gemini, etc.
      const { ChatCompletionsAdapter } = await import('./chat-completions.js');
      adapter = new ChatCompletionsAdapter({
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
      });
    }

    this.#adapterCache.set(provider.name, adapter);
    return adapter;
  }

  /**
   * Stream a model response — routes to the correct provider adapter.
   *
   * @param {import('./adapter.js').StreamParams} params
   * @returns {AsyncGenerator<import('./adapter.js').StreamEvent>}
   */
  async *stream(params) {
    const filtered = filterEffortForModel(params);
    const adapter = await this.#resolveAdapter(filtered.model);
    yield* adapter.stream(filtered);
  }

  /**
   * Make a single model call — routes to the correct provider adapter.
   *
   * @param {import('./adapter.js').CallParams} params
   * @returns {Promise<{ text: string, usage: { inputTokens: number, outputTokens: number } }>}
   */
  async call(params) {
    const filtered = filterEffortForModel(params);
    const adapter = await this.#resolveAdapter(filtered.model);
    return adapter.call(filtered);
  }

  /**
   * Get the provider config for a given model.
   *
   * @param {string} modelId
   * @returns {object|null} — Provider config or null
   */
  getProviderForModel(modelId) {
    return this.#modelToProvider.get(modelId) || null;
  }

  /**
   * List all available models across all providers.
   *
   * @returns {{ modelId: string, providerName: string }[]}
   */
  listAvailableModels() {
    const result = [];
    for (const [modelId, provider] of this.#modelToProvider) {
      result.push({ modelId, providerName: provider.name });
    }
    return result;
  }

  /**
   * Get the raw providers config.
   *
   * @returns {object[]}
   */
  get providers() {
    return this.#providers;
  }
}
