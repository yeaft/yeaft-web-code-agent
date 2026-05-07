/**
 * router.js — AdapterRouter: routes LLM calls to the correct provider adapter
 *
 * Given a providers array from config.json:
 *   [{ name, baseUrl, apiKey, protocol?, models[] }, ...]
 *
 * The router resolves model → provider, lazy-creates the right adapter
 * (AnthropicAdapter or OpenAIResponsesAdapter based on protocol), caches it,
 * and forwards stream()/call() to the resolved adapter.
 *
 * protocol must be one of:
 *   - "anthropic"        — Anthropic Messages API (required for claude-* models)
 *   - "openai-responses" — OpenAI Responses API (default for everything else)
 *
 * Phase 7 removed the legacy "openai" (Chat Completions) protocol entirely.
 */

import { LLMAdapter } from './adapter.js';
import { getThinkingCapability, normalizeEffort } from '../models.js';
import { pairSanitize } from '../pair-sanitize.js';

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
 * task-715: last-line-of-defense pair sanitize at the wire.
 *
 * `pairSanitize` already runs in two upstream paths
 * (`conversation/persist.js#loadRecentByGroup` and
 * `history-compact.js#compactHistory`), but the engine's main loop
 * mutates `conversationMessages` AFTER those — appending tool results
 * mid-loop, archiving bulky tool results into stubs, and (in failure
 * paths) potentially leaving an assistant `tool_use` whose matching
 * `role:'tool'` was dropped or never produced. Anthropic's Messages
 * API rejects either shape with HTTP 400 ("Each tool_use block must
 * have a corresponding tool_result block in the next message").
 *
 * The router is the SINGLE choke point through which every
 * adapter.stream() / adapter.call() flows. Sanitizing here means no
 * caller can accidentally bypass the guard — including the per-VP
 * group-mode path that surfaced the bug.
 *
 * Implementation: call `pairSanitize` exactly once and compare the
 * result to the input. If nothing changed (length matches AND each
 * assistant kept its toolCalls count), return the original `params`
 * reference so the happy path is one O(n) walk + one comparison
 * walk, no allocation downstream. If something WAS dropped, return
 * `{ ...params, messages: cleaned }` and log a diagnostic so a
 * recurrence stays traceable in agent logs.
 *
 * @param {object} params
 * @returns {object}
 */
export function sanitizeMessagesForWire(params) {
  if (!params || !Array.isArray(params.messages)) return params;
  const cleaned = pairSanitize(params.messages);
  if (sliceUnchanged(params.messages, cleaned)) return params;
  console.warn(
    `[router] dropped tool_use/tool_result orphans before wire send: ` +
    `${params.messages.length} → ${cleaned.length} messages`
  );
  return { ...params, messages: cleaned };
}

/**
 * Cheap structural equality between the original messages array and
 * the post-sanitize result. Same length AND every assistant kept its
 * toolCalls count = no orphans were dropped. We do NOT compare full
 * deep equality — `pairSanitize` only ever shrinks, never reorders or
 * mutates payloads.
 */
function sliceUnchanged(original, cleaned) {
  if (original.length !== cleaned.length) return false;
  for (let i = 0; i < original.length; i += 1) {
    const a = original[i];
    const b = cleaned[i];
    if (!a || !b) continue;
    const aCalls = Array.isArray(a.toolCalls) ? a.toolCalls.length : 0;
    const bCalls = Array.isArray(b.toolCalls) ? b.toolCalls.length : 0;
    if (aCalls !== bCalls) return false;
  }
  return true;
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
   * Resolve the effective wire protocol for a (provider, model) pair.
   *
   * Phase 7: only "anthropic" and "openai-responses" are supported. Claude
   * model IDs require provider.protocol === "anthropic" — there is no
   * chat-completions fallback any more.
   *
   * @param {object} provider — Provider config
   * @param {string} modelId
   * @returns {'anthropic' | 'openai-responses'}
   */
  #effectiveProtocol(provider, modelId) {
    const declared = provider.protocol || 'openai-responses';
    if (typeof modelId === 'string' && modelId.startsWith('claude-')) {
      if (declared !== 'anthropic') {
        throw new Error(
          `Claude models require provider.protocol="anthropic"; ` +
          `chat-completions fallback removed in Phase 7. ` +
          `Provider "${provider.name}" declares protocol="${declared}" for model "${modelId}".`
        );
      }
      return 'anthropic';
    }
    return declared;
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

    // Compute the effective protocol per model — a single provider may need
    // two adapters (e.g. mixed config: openai-responses for gpt-5*, anthropic
    // for claude-*). Cache key includes the protocol.
    const protocol = this.#effectiveProtocol(provider, modelId);
    const cacheKey = `${provider.name}::${protocol}`;
    const cached = this.#adapterCache.get(cacheKey);
    if (cached) return cached;

    let adapter;

    if (protocol === 'anthropic') {
      const { AnthropicAdapter } = await import('./anthropic.js');
      adapter = new AnthropicAdapter({
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
      });
    } else if (protocol === 'openai-responses') {
      // OpenAI Responses API (/v1/responses) — canonical OpenAI-compatible path.
      const { OpenAIResponsesAdapter } = await import('./openai-responses.js');
      adapter = new OpenAIResponsesAdapter({
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
      });
    } else {
      throw new Error(
        `Unsupported protocol "${protocol}" for provider "${provider.name}". ` +
        `Use protocol: "anthropic" or "openai-responses". ` +
        `The chat-completions adapter was removed in Phase 7.`
      );
    }

    this.#adapterCache.set(cacheKey, adapter);
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
    const sanitized = sanitizeMessagesForWire(filtered);
    const adapter = await this.#resolveAdapter(sanitized.model);
    yield* adapter.stream(sanitized);
  }

  /**
   * Make a single model call — routes to the correct provider adapter.
   *
   * @param {import('./adapter.js').CallParams} params
   * @returns {Promise<{ text: string, usage: { inputTokens: number, outputTokens: number } }>}
   */
  async call(params) {
    const filtered = filterEffortForModel(params);
    const sanitized = sanitizeMessagesForWire(filtered);
    const adapter = await this.#resolveAdapter(sanitized.model);
    return adapter.call(sanitized);
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
