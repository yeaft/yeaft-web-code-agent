/**
 * router.js — AdapterRouter: routes LLM calls to the correct provider adapter
 *
 * Given a providers array from config.json:
 *   [{ name, baseUrl, apiKey, protocol?, models[] }, ...]
 *
 * `models[]` accepts two shapes (mixable in the same provider):
 *   - bare string id: "gpt-5"                          ← legacy, still supported
 *   - object:         { id: "gpt-5", protocol?: "..." } ← per-model override
 *
 * Effective protocol for each (provider, model) is resolved in this order:
 *   1. per-model `protocol` override on the model entry
 *   2. provider-level `protocol` (explicit config wins over inference)
 *   3. heuristic by model id (claude-* → anthropic, gpt-/o1-/o3-/o4-/chatgpt-* → openai-responses)
 *   4. default `openai-responses`
 *
 * This lets a single provider (e.g. GitHub Copilot, a unified proxy) serve
 * both Anthropic and OpenAI families without splitting into two provider
 * entries.
 *
 * Phase 7 removed the legacy "openai" (Chat Completions) protocol entirely.
 */

import { LLMAdapter } from './adapter.js';
import { getThinkingCapability, normalizeEffort } from '../models.js';
import { pairSanitize } from '../pair-sanitize.js';

/**
 * Normalize a model entry to its `{id, protocol?}` object form. Accepts
 * either a bare string or an object so legacy `models: ["gpt-5"]` configs
 * keep working unchanged.
 *
 * @param {string|object} entry
 * @returns {{id: string, protocol?: string} | null}
 */
export function normalizeModelEntry(entry) {
  if (typeof entry === 'string') {
    return entry ? { id: entry } : null;
  }
  if (entry && typeof entry === 'object' && typeof entry.id === 'string' && entry.id) {
    const out = { id: entry.id };
    if (typeof entry.protocol === 'string' && entry.protocol) {
      out.protocol = entry.protocol;
    }
    return out;
  }
  return null;
}

/**
 * Infer the wire protocol from a model id when neither the model entry
 * nor the provider declared one. Centralized so the LlmTab preview and
 * the router agree on the same rule.
 *
 * Returns null when the id doesn't match a known family — the caller
 * falls back to the provider-level protocol (or the global default).
 */
export function inferProtocolFromModelId(modelId) {
  if (typeof modelId !== 'string' || !modelId) return null;
  const id = modelId.toLowerCase();
  // Anthropic family: claude-*, claude (bare), or anything starting with
  // "claude" so vendor-prefixed ids like "anthropic.claude-..." also match.
  if (id.startsWith('claude') || id.includes('/claude') || id.includes('.claude')) {
    return 'anthropic';
  }
  // OpenAI Responses-API family. Models that route through /v1/responses:
  //   gpt-*, o1*, o3*, o4*, chatgpt-*, codex-*, omni-*.
  // Note: Chat-Completions-only models are intentionally NOT matched here —
  // they fall through to the provider-level protocol and the router will
  // refuse if that doesn't resolve to a supported value.
  if (/^(gpt-|o1|o3|o4|chatgpt-|codex-|omni-)/.test(id)) {
    return 'openai-responses';
  }
  return null;
}

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
  /** @type {Map<string, {provider: object, entry: {id: string, protocol?: string}}>} */
  #modelToProvider;

  /** @type {Map<string, LLMAdapter>} providerName::protocol → cached adapter */
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

    // Build model id → { provider, entry } index. First provider wins if a
    // model id appears in multiple providers. Each model entry may declare
    // its own `protocol`; we keep the normalized entry so #effectiveProtocol
    // can consult it later without re-parsing.
    for (const provider of providers) {
      if (!Array.isArray(provider.models)) continue;
      for (const raw of provider.models) {
        const entry = normalizeModelEntry(raw);
        if (!entry) continue;
        if (!this.#modelToProvider.has(entry.id)) {
          this.#modelToProvider.set(entry.id, { provider, entry });
        }
      }
    }
  }

  /**
   * Resolve the effective wire protocol for a (provider, model) pair.
   *
   * Resolution order:
   *   1. Per-model entry override (provider.models[i].protocol)
   *   2. Provider-level protocol (explicit config wins over inference)
   *   3. Heuristic from model id (claude-* → anthropic, gpt-* → openai-responses)
   *   4. Default "openai-responses"
   *
   * Claude model ids without an anthropic-compatible resolution still throw
   * — chat-completions fallback was removed in Phase 7.
   *
   * @param {object} provider — Provider config
   * @param {{id: string, protocol?: string}} entry — Normalized model entry
   * @returns {'anthropic' | 'openai-responses'}
   */
  #effectiveProtocol(provider, entry) {
    const modelId = entry.id;
    const perModel = entry.protocol;
    const inferred = inferProtocolFromModelId(modelId);
    const providerLevel = provider.protocol;
    const resolved = perModel || providerLevel || inferred || 'openai-responses';

    if (typeof modelId === 'string' && modelId.toLowerCase().includes('claude')) {
      if (resolved !== 'anthropic') {
        throw new Error(
          `Claude models require protocol="anthropic"; ` +
          `chat-completions fallback removed in Phase 7. ` +
          `Provider "${provider.name}" resolved protocol="${resolved}" for model "${modelId}" ` +
          `(per-model="${perModel || ''}", provider-level="${providerLevel || ''}").`
        );
      }
      return 'anthropic';
    }
    return resolved;
  }

  /**
   * Resolve a model ID to its provider's adapter (lazy-created, cached).
   *
   * @param {string} modelId
   * @returns {Promise<LLMAdapter>}
   */
  async #resolveAdapter(modelId) {
    const hit = this.#modelToProvider.get(modelId);
    if (!hit) {
      throw new Error(
        `Model "${modelId}" not found in any provider. ` +
        `Available models: ${[...this.#modelToProvider.keys()].join(', ') || '(none)'}. ` +
        `Check your config.json providers[].models arrays.`
      );
    }
    const { provider, entry } = hit;

    // Compute the effective protocol per model — a single provider may need
    // two adapters (e.g. mixed config: openai-responses for gpt-5*, anthropic
    // for claude-*). Cache key includes the protocol.
    const protocol = this.#effectiveProtocol(provider, entry);
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
    const hit = this.#modelToProvider.get(modelId);
    return hit ? hit.provider : null;
  }

  /**
   * List all available models across all providers.
   *
   * @returns {{ modelId: string, providerName: string }[]}
   */
  listAvailableModels() {
    const result = [];
    for (const [modelId, hit] of this.#modelToProvider) {
      result.push({ modelId, providerName: hit.provider.name });
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
