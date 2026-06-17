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
import { getModelEffortOptions, getThinkingCapability, normalizeEffort, parseModelRef } from '../models.js';
import {
  GITHUB_COPILOT_BASE_URL,
  GITHUB_COPILOT_CREDENTIAL_PROVIDER,
  GITHUB_COPILOT_PROVIDER_NAME,
  normalizeKnownProviderForRuntime,
} from './known-providers.js';
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
  return process.env.YEAFT_THINKING_V1 === '1';
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
    if (params.effortSource !== 'user') {
      const { effort: _drop, effortSource: _source, ...rest } = params;
      return rest;
    }
  }
  const norm = normalizeEffort(params.effort);
  if (!norm) {
    const { effort: _drop, effortSource: _source, ...rest } = params;
    return rest;
  }
  const modelId = parseModelRef(params.model).modelId;
  const cap = getThinkingCapability(modelId);
  if (!cap.supportsThinking || cap.thinkingProtocol === 'none') {
    const { effort: _drop, effortSource: _source, ...rest } = params;
    return rest;
  }
  if (!getModelEffortOptions(modelId).includes(norm)) {
    const { effort: _drop, effortSource: _source, ...rest } = params;
    return rest;
  }
  return { ...params, effort: norm, effortSource: params.effortSource };
}

/**
 * task-715: last-line-of-defense pair sanitize at the wire.
 *
 * `pairSanitize` already runs in two upstream paths
 * (`conversation/persist.js#loadRecentBySession` and
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

function normalizedOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/**
 * Anthropic native uses x-api-key. Copilot's Anthropic-compatible endpoint uses
 * a bearer token, and dynamic credential providers generally hand back bearer
 * tokens unless explicitly overridden.
 *
 * @param {object} provider
 * @returns {'x-api-key'|'bearer'}
 */
export function anthropicAuthHeaderModeForProvider(provider) {
  const explicit = provider?.anthropicAuthHeaderMode || provider?.authHeaderMode;
  if (explicit === 'bearer' || explicit === 'x-api-key') return explicit;
  if (provider?.credentialProvider) return 'bearer';
  if (provider?.name === GITHUB_COPILOT_PROVIDER_NAME) return 'bearer';
  if (normalizedOrigin(provider?.baseUrl) === GITHUB_COPILOT_BASE_URL) return 'bearer';
  return 'x-api-key';
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
    this.#providers = [];
    this.#modelToProvider = new Map();
    this.#adapterCache = new Map();
    this.refreshProviders(providers);
  }

  /**
   * Replace the provider/model index after config.json changes. Existing
   * provider adapters are dropped because credentials, baseUrl, protocol,
   * or model ownership may have changed along with the list.
   *
   * @param {object[]} providers
   */
  refreshProviders(providers) {
    this.#providers = (Array.isArray(providers) ? providers : [])
      .map(provider => normalizeKnownProviderForRuntime(provider));
    this.#modelToProvider = new Map();
    this.#adapterCache = new Map();

    // Build model id → { provider, entry } index. First provider wins if a
    // model id appears in multiple providers. Each model entry may declare
    // its own `protocol`; we keep the normalized entry so #effectiveProtocol
    // can consult it later without re-parsing.
    for (const provider of this.#providers) {
      if (!Array.isArray(provider.models)) continue;
      for (const raw of provider.models) {
        const entry = normalizeModelEntry(raw);
        if (!entry) continue;
        const ref = provider.name ? `${provider.name}/${entry.id}` : entry.id;
        if (!this.#modelToProvider.has(ref)) {
          this.#modelToProvider.set(ref, { provider, entry });
        }
        if (!this.#modelToProvider.has(entry.id)) {
          this.#modelToProvider.set(entry.id, { provider, entry });
        }
      }
    }
  }

  /**
   * Resolve an explicit provider/model ref against a provider row even when
   * the local model catalog is stale. The provider name still must exist; the
   * fallback only skips the per-provider models[] membership check.
   *
   * @param {string} modelRef
   * @returns {{provider: object, entry: {id: string, protocol?: string}} | null}
   */
  #resolveProviderQualifiedFallback(modelRef) {
    const parsed = parseModelRef(modelRef);
    if (!parsed.providerName || !parsed.modelId) return null;

    const candidates = this.#providers.filter(p => p && p.name === parsed.providerName);
    if (candidates.length === 0) return null;

    const inferred = inferProtocolFromModelId(parsed.modelId);
    if (!inferred) return null;
    const entry = { id: parsed.modelId, protocol: inferred };

    // Provider-qualified refs are explicit enough to tolerate a stale
    // providers[].models catalog. Prefer a provider row that already serves
    // this protocol through at least one model entry. That covers the common
    // Copilot shape: provider.protocol=openai-responses plus per-model
    // protocol='anthropic' for Claude entries.
    for (const provider of candidates) {
      const models = Array.isArray(provider.models) ? provider.models : [];
      for (const raw of models) {
        const existing = normalizeModelEntry(raw);
        if (!existing) continue;
        try {
          if (this.#effectiveProtocol(provider, existing) === inferred) {
            return { provider, entry };
          }
        } catch {
          // Ignore invalid existing entries while looking for a compatible row.
        }
      }
    }

    // If no existing entry proves mixed-protocol support, fall back to rows
    // whose provider-level protocol is absent or directly compatible.
    for (const provider of candidates) {
      if (!provider.protocol || provider.protocol === inferred) {
        return { provider, entry };
      }
    }

    return null;
  }

  #unknownModelError(modelRef) {
    const parsed = parseModelRef(modelRef);
    if (parsed.providerName) {
      const providerModels = [];
      let sawProvider = false;
      for (const provider of this.#providers) {
        if (!provider || provider.name !== parsed.providerName) continue;
        sawProvider = true;
        for (const raw of Array.isArray(provider.models) ? provider.models : []) {
          const entry = normalizeModelEntry(raw);
          if (entry) providerModels.push(entry.id);
        }
      }
      if (sawProvider) {
        return new Error(
          `Model "${modelRef}" is not listed under provider "${parsed.providerName}" and no compatible protocol row could be inferred. ` +
          `Available models for this provider: ${providerModels.join(', ') || '(none)'}. ` +
          `Add "${parsed.modelId}" to config.json providers[].models or refresh the model catalog.`
        );
      }
    }
    return new Error(
      `Model "${modelRef}" not found in any provider. ` +
      `Available models: ${[...this.#modelToProvider.keys()].join(', ') || '(none)'}. ` +
      `Check your config.json providers[].models arrays.`
    );
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

    // Use the SAME predicate as inferProtocolFromModelId so the guard never
    // disagrees with the inference (e.g. "my-claude-proxy" → infer=null →
    // guard wouldn't fire either; "claude-opus-*" → infer=anthropic →
    // guard enforces anthropic). Prevents confusing "resolved openai-responses
    // for claude-*" errors on ids the heuristic didn't actually match.
    if (inferred === 'anthropic') {
      if (resolved !== 'anthropic') {
        const parts = [];
        if (perModel) parts.push(`per-model="${perModel}"`);
        if (providerLevel) parts.push(`provider-level="${providerLevel}"`);
        const detail = parts.length ? ` (${parts.join(', ')})` : '';
        throw new Error(
          `Claude models require protocol="anthropic"; ` +
          `chat-completions fallback removed in Phase 7. ` +
          `Provider "${provider.name}" resolved protocol="${resolved}" for model "${modelId}"${detail}.`
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
   * @returns {Promise<{adapter: LLMAdapter, modelId: string}>}
   */
  async #resolveAdapter(modelRef) {
    const hit = this.#modelToProvider.get(modelRef) || this.#resolveProviderQualifiedFallback(modelRef);
    if (!hit) {
      throw this.#unknownModelError(modelRef);
    }
    const { provider, entry } = hit;

    // Compute the effective protocol per model — a single provider may need
    // two adapters (e.g. mixed config: openai-responses for gpt-5*, anthropic
    // for claude-*). Cache key includes the protocol.
    const protocol = this.#effectiveProtocol(provider, entry);

    // Resolve apiKey. Default path: provider.apiKey (static string from
    // config.json) — completely unchanged from before. Opt-in path: when
    // provider.credentialProvider is set, ask the credential registry for
    // a live token. Throws with a clear hint if no token is available.
    const apiKey = await this.#resolveApiKey(provider);

    // Cache key includes a short fingerprint of the apiKey so that when a
    // credential provider rotates the token (e.g. Copilot 30-min refresh)
    // we rebuild the adapter rather than reuse one with a stale Authorization
    // header. For static providers the apiKey never changes so this stays
    // a one-time-build cache exactly like before.
    const apiKeyFp = apiKey ? this.#shortFingerprint(apiKey) : 'none';
    const anthropicAuthHeaderMode = protocol === 'anthropic'
      ? anthropicAuthHeaderModeForProvider(provider)
      : null;
    const authModeKey = anthropicAuthHeaderMode || 'default';
    const cacheKey = `${provider.name}::${protocol}::${authModeKey}::${apiKeyFp}`;
    const cached = this.#adapterCache.get(cacheKey);
    if (cached) return { adapter: cached, modelId: entry.id };

    // Token rotation eviction: when a credential provider hands us a NEW
    // fingerprint for the same (provider, protocol) pair, drop the stale
    // entry so the cache doesn't grow unboundedly over a long-lived process
    // (Copilot tokens rotate every ~30 min). Static-apiKey providers never
    // change fingerprint, so this loop never finds anything to evict for
    // them — back-compat preserved.
    const prefix = `${provider.name}::${protocol}::${authModeKey}::`;
    for (const key of this.#adapterCache.keys()) {
      if (key.startsWith(prefix)) this.#adapterCache.delete(key);
    }

    let adapter;

    if (protocol === 'anthropic') {
      const { AnthropicAdapter } = await import('./anthropic.js');
      adapter = new AnthropicAdapter({
        apiKey,
        baseUrl: provider.baseUrl,
        authHeaderMode: anthropicAuthHeaderMode,
      });
    } else if (protocol === 'openai-responses') {
      // OpenAI Responses API (/v1/responses) — canonical OpenAI-compatible path.
      const { OpenAIResponsesAdapter } = await import('./openai-responses.js');
      adapter = new OpenAIResponsesAdapter({
        apiKey,
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
    return { adapter, modelId: entry.id };
  }

  /**
   * Resolve the apiKey for a provider. If `credentialProvider` is set,
   * delegate to the registry; otherwise return the static `apiKey` from
   * config (unchanged from before this feature).
   *
   * Kept as a separate method so the credential registry is imported
   * lazily — providers that don't use a credential provider never pay
   * the import cost or touch `child_process` / disk.
   *
   * @param {object} provider
   * @returns {Promise<string>}
   */
  async #resolveApiKey(provider) {
    const name = provider && provider.credentialProvider;
    if (name === 'github-copilot' && provider?.githubToken) {
      const { exchangeToken } = await import('./credentials/github-copilot.js');
      const exchanged = await exchangeToken(provider.githubToken);
      return exchanged.token;
    }
    if (!name) return provider?.apiKey || '';
    const { getCredentialProvider, CREDENTIAL_PROVIDER_NAMES } = await import('./credentials/index.js');
    const cp = getCredentialProvider(name);
    if (!cp) {
      throw new Error(
        `Unknown credentialProvider "${name}" on provider "${provider.name}". ` +
        `Known providers: ${CREDENTIAL_PROVIDER_NAMES.join(', ')}. ` +
        `Remove the field to use the static apiKey.`
      );
    }
    return cp.getApiKey();
  }

  /**
   * Short stable fingerprint of an apiKey for use in the adapter cache key.
   * Never log the apiKey itself. 8 hex chars is plenty for in-process
   * uniqueness — we only need to distinguish "same token" vs "rotated".
   */
  #shortFingerprint(s) {
    // Tiny non-crypto FNV-1a 32-bit hash — avoids loading `crypto` on the
    // hot path. Collisions don't matter for security (the apiKey is still
    // sent verbatim in the request); they only matter for cache freshness
    // and FNV is more than enough.
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
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
    const { adapter, modelId } = await this.#resolveAdapter(sanitized.model);
    yield* adapter.stream({ ...sanitized, model: modelId });
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
    const { adapter, modelId } = await this.#resolveAdapter(sanitized.model);
    return adapter.call({ ...sanitized, model: modelId });
  }

  /**
   * Get the provider config for a given model.
   *
   * @param {string} modelId
   * @returns {object|null} — Provider config or null
   */
  getProviderForModel(modelId) {
    const hit = this.#modelToProvider.get(modelId) || this.#resolveProviderQualifiedFallback(modelId);
    return hit ? hit.provider : null;
  }

  /**
   * List all available models across all providers.
   *
   * @returns {{ modelId: string, providerName: string }[]}
   */
  listAvailableModels() {
    const result = [];
    const seen = new Set();
    for (const provider of this.#providers) {
      if (!Array.isArray(provider.models)) continue;
      for (const raw of provider.models) {
        const entry = normalizeModelEntry(raw);
        if (!entry) continue;
        const key = `${provider.name}/${entry.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ modelId: entry.id, providerName: provider.name });
      }
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
