/**
 * models.js — Model ID registry for Yeaft Unify
 *
 * Maps model IDs (e.g. "gpt-5", "claude-sonnet-4-20250514") to their
 * adapter type, API base URL, and capabilities.
 *
 * Yeaft does not provide its own models. The "model" field is always a
 * model ID from an external provider. This registry lets Yeaft auto-detect
 * the correct adapter and endpoint from just the model ID, so users only
 * need to set YEAFT_MODEL=gpt-5 without configuring adapter/baseUrl separately.
 *
 * Unknown model IDs return null — caller falls back to env-based detection.
 */

/**
 * @typedef {Object} ModelInfo
 * @property {'anthropic' | 'openai' | 'deepseek' | 'google'} provider — Which provider this model belongs to
 * @property {'anthropic' | 'chat-completions'} adapter — Which wire protocol to use
 * @property {string} baseUrl — Official API endpoint base URL
 * @property {number} contextWindow — Max context tokens
 * @property {number} maxOutputTokens — Max output tokens
 * @property {string} displayName — Human-readable model name
 * @property {boolean} [supportsThinking] — task-327a: model supports thinking/reasoning effort.
 * @property {'anthropic' | 'openai-reasoning' | 'none'} [thinkingProtocol] — task-327a:
 *   'anthropic' → thinking:{type:'enabled', budget_tokens:N}
 *   'openai-reasoning' → reasoning:{effort:'low'|'medium'|'high'}
 *   'none' (default) → parameter silently dropped by router
 * @property {'low' | 'medium' | 'high' | 'max' | null} [defaultEffort] — task-327a: adapter-level default
 *   when caller doesn't specify effort (null = no default / decision-tree decides).
 * @property {number} [maxBudgetTokens] — task-327a: for anthropic protocol, the cap used when
 *   effort='max' (e.g. Opus 4 = 64K, Sonnet 4 = 32K). For openai-reasoning this field is unused
 *   because the provider only exposes 3 enum levels.
 */

/** @type {Map<string, ModelInfo>} */
export const MODEL_REGISTRY = new Map([
  // ── Anthropic ──────────────────────────────────────────────────
  ['claude-sonnet-4-20250514', {
    provider: 'anthropic',
    adapter: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    contextWindow: 200000,
    maxOutputTokens: 16384,
    displayName: 'Claude Sonnet 4',
    // task-327a: extended thinking supported; budget caps at 32K on Sonnet.
    supportsThinking: true,
    thinkingProtocol: 'anthropic',
    defaultEffort: null,
    maxBudgetTokens: 32000,
  }],
  ['claude-opus-4-20250514', {
    provider: 'anthropic',
    adapter: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    contextWindow: 200000,
    maxOutputTokens: 16384,
    displayName: 'Claude Opus 4',
    // task-327a: PM decision — Opus max budget = 64K.
    supportsThinking: true,
    thinkingProtocol: 'anthropic',
    defaultEffort: null,
    maxBudgetTokens: 64000,
  }],
  ['claude-haiku-3-20250414', {
    provider: 'anthropic',
    adapter: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    contextWindow: 200000,
    maxOutputTokens: 8192,
    displayName: 'Claude Haiku 3',
    // task-327a: Haiku 3 does not support extended thinking — effort is dropped.
    supportsThinking: false,
    thinkingProtocol: 'none',
  }],

  // ── OpenAI ─────────────────────────────────────────────────────
  ['gpt-5', {
    provider: 'openai',
    adapter: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    contextWindow: 256000,
    maxOutputTokens: 16384,
    displayName: 'GPT-5',
    // task-327a: GPT-5 supports reasoning.effort (low/medium/high). No 'max'.
    supportsThinking: true,
    thinkingProtocol: 'openai-reasoning',
    defaultEffort: null,
  }],
  // gpt-5-mini/-nano/-pro: keep id + family/protocol metadata so they appear
  // as known models, but do NOT hardcode context/maxOutput — the real limits
  // should come from provider config (user-supplied) instead of guesses.
  ['gpt-5-mini', {
    provider: 'openai',
    adapter: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    displayName: 'GPT-5 Mini',
  }],
  ['gpt-5-nano', {
    provider: 'openai',
    adapter: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    displayName: 'GPT-5 Nano',
  }],
  ['gpt-5-pro', {
    provider: 'openai',
    adapter: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    displayName: 'GPT-5 Pro',
  }],
  ['gpt-5.4', {
    provider: 'openai',
    adapter: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    contextWindow: 272000,
    maxOutputTokens: 16384,
    displayName: 'GPT-5.4',
  }],
  ['gpt-4.1', {
    provider: 'openai',
    adapter: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    contextWindow: 1047576,
    maxOutputTokens: 32768,
    displayName: 'GPT-4.1',
  }],
  ['gpt-4.1-mini', {
    provider: 'openai',
    adapter: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    contextWindow: 1047576,
    maxOutputTokens: 16384,
    displayName: 'GPT-4.1 Mini',
  }],
  ['gpt-4.1-nano', {
    provider: 'openai',
    adapter: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    contextWindow: 1047576,
    maxOutputTokens: 16384,
    displayName: 'GPT-4.1 Nano',
  }],
  ['o3', {
    provider: 'openai',
    adapter: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    contextWindow: 200000,
    maxOutputTokens: 100000,
    displayName: 'o3',
    // task-327a: o-series reasoning models use reasoning.effort.
    supportsThinking: true,
    thinkingProtocol: 'openai-reasoning',
    defaultEffort: null,
  }],
  ['o4-mini', {
    provider: 'openai',
    adapter: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    contextWindow: 200000,
    maxOutputTokens: 100000,
    displayName: 'o4-mini',
    supportsThinking: true,
    thinkingProtocol: 'openai-reasoning',
    defaultEffort: null,
  }],

  // ── DeepSeek ───────────────────────────────────────────────────
  ['deepseek-chat', {
    provider: 'deepseek',
    adapter: 'openai-responses',
    baseUrl: 'https://api.deepseek.com',
    contextWindow: 131072,
    maxOutputTokens: 8192,
    displayName: 'DeepSeek Chat',
  }],
  ['deepseek-reasoner', {
    provider: 'deepseek',
    adapter: 'openai-responses',
    baseUrl: 'https://api.deepseek.com',
    contextWindow: 131072,
    maxOutputTokens: 8192,
    displayName: 'DeepSeek Reasoner',
  }],

  // ── Google (via OpenAI-compatible API) ─────────────────────────
  ['gemini-2.5-pro', {
    provider: 'google',
    adapter: 'openai-responses',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    displayName: 'Gemini 2.5 Pro',
  }],
  ['gemini-2.5-flash', {
    provider: 'google',
    adapter: 'openai-responses',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    displayName: 'Gemini 2.5 Flash',
  }],
]);

/**
 * Resolve a model name to its registry info.
 *
 * @param {string} modelName — The model name (e.g., 'gpt-5', 'claude-sonnet-4-20250514')
 * @returns {ModelInfo | null} — Model info, or null if not in registry
 */
export function resolveModel(modelName) {
  if (!modelName) return null;
  const info = MODEL_REGISTRY.get(modelName);
  // Return a shallow copy so callers can't mutate the registry
  return info ? { ...info } : null;
}

/**
 * Default context window when neither the model registry nor the engine
 * config has a value. 200K is a conservative middle-ground — most modern
 * production models (Claude, GPT-5, Gemini) have ≥ 128K.
 *
 * Single source of truth: callers (engine.js pre-flight guard,
 * tools/registry.js per-result cap) MUST use this constant or
 * {@link resolveContextWindow} instead of hardcoding 200_000.
 */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Resolve the live context window for a model, with an explicit fallback
 * ladder:
 *   1. MODEL_REGISTRY entry's `contextWindow` (most accurate)
 *   2. caller-supplied config override (e.g. `config.maxContextTokens`)
 *   3. {@link DEFAULT_CONTEXT_WINDOW}
 *
 * Used by the per-tool-result cap and the pre-flight token guard so the
 * defense layers always see the same number, regardless of which seam
 * resolves it first.
 *
 * @param {string} modelName
 * @param {{ maxContextTokens?: number }} [config]
 * @returns {number}
 */
export function resolveContextWindow(modelName, config) {
  const info = resolveModel(modelName);
  if (info && Number.isFinite(info.contextWindow) && info.contextWindow > 0) {
    return info.contextWindow;
  }
  const cfg = config && Number.isFinite(config.maxContextTokens) && config.maxContextTokens > 0
    ? config.maxContextTokens : null;
  if (cfg !== null) return cfg;
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * List all known models.
 *
 * @returns {{ name: string, adapter: string, baseUrl: string, contextWindow: number, maxOutputTokens: number, displayName: string }[]}
 */
export function listModels() {
  const result = [];
  for (const [name, info] of MODEL_REGISTRY) {
    result.push({ name, ...info });
  }
  return result;
}

/**
 * Check if a model name is in the registry.
 *
 * @param {string} modelName
 * @returns {boolean}
 */
export function isKnownModel(modelName) {
  return MODEL_REGISTRY.has(modelName);
}

/**
 * Get the provider name for a model.
 *
 * @param {string} modelName
 * @returns {string|null} — Provider name ('anthropic', 'openai', 'deepseek', 'google') or null
 */
export function getProviderForModel(modelName) {
  const info = MODEL_REGISTRY.get(modelName);
  return info ? info.provider : null;
}

/**
 * Parse a model reference in "providerName/modelId" format.
 *
 * @param {string} ref — e.g. "my-proxy/claude-sonnet-4-20250514" or "claude-sonnet-4-20250514"
 * @returns {{ providerName: string|null, modelId: string }}
 */
export function parseModelRef(ref) {
  if (!ref) return { providerName: null, modelId: '' };
  const slashIdx = ref.indexOf('/');
  if (slashIdx === -1) {
    return { providerName: null, modelId: ref };
  }
  return {
    providerName: ref.slice(0, slashIdx),
    modelId: ref.slice(slashIdx + 1),
  };
}

// ─── task-327a: thinking / reasoning capability ─────────────────

/**
 * Valid effort levels accepted by Unify adapters.
 * @typedef {'low' | 'medium' | 'high' | 'max'} Effort
 */

/**
 * Budget-token map for the Anthropic extended-thinking protocol.
 * 'max' is model-specific (override via ModelInfo.maxBudgetTokens).
 *
 * These numbers are adapter defaults — `thinkingBudgetForEffort()` below
 * consults the registry entry first before falling back to this table.
 */
export const ANTHROPIC_THINKING_BUDGETS = {
  low: 4096,
  medium: 8192,
  high: 16384,
  // 'max' resolves per-model; default fallback if model has no maxBudgetTokens.
  max: 32000,
};

/**
 * Map a Unify effort level to the OpenAI reasoning.effort enum. OpenAI does
 * not expose a 'max' level — callers that pass 'max' get 'high' (the highest
 * available on that protocol). The router/engine should log this downgrade
 * but the adapter MUST NOT error.
 *
 * @param {Effort} effort
 * @returns {'low' | 'medium' | 'high' | null}
 */
export function mapEffortToOpenAIReasoning(effort) {
  if (!effort) return null;
  switch (effort) {
    case 'low': return 'low';
    case 'medium': return 'medium';
    case 'high': return 'high';
    // OpenAI doesn't support 'max'; degrade to 'high'. Engine may emit a
    // debug line noting the downgrade — adapter level stays silent.
    case 'max': return 'high';
    default: return null;
  }
}

/**
 * Resolve the Anthropic thinking budget_tokens value for a given (model, effort).
 *
 * Priority:
 *   1. Registry ModelInfo.maxBudgetTokens when effort === 'max'
 *   2. ANTHROPIC_THINKING_BUDGETS[effort]
 *
 * @param {string} model
 * @param {Effort} effort
 * @returns {number | null} Null when effort is unknown/falsy.
 */
export function thinkingBudgetForEffort(model, effort) {
  if (!effort) return null;
  if (effort === 'max') {
    const info = MODEL_REGISTRY.get(model);
    if (info?.maxBudgetTokens) return info.maxBudgetTokens;
    return ANTHROPIC_THINKING_BUDGETS.max;
  }
  return ANTHROPIC_THINKING_BUDGETS[effort] ?? null;
}

/**
 * Get the thinking capability for a model. Models not in the registry or
 * explicitly marked supportsThinking:false return a noop capability — the
 * router uses this to silently drop the `effort` parameter for unsupported
 * models (red line: never error on unsupported).
 *
 * @param {string} model
 * @returns {{ supportsThinking: boolean, thinkingProtocol: 'anthropic' | 'openai-reasoning' | 'none', defaultEffort: Effort | null, maxBudgetTokens: number | null }}
 */
export function getThinkingCapability(model) {
  const info = MODEL_REGISTRY.get(model);
  if (!info || !info.supportsThinking) {
    return {
      supportsThinking: false,
      thinkingProtocol: 'none',
      defaultEffort: null,
      maxBudgetTokens: null,
    };
  }
  return {
    supportsThinking: true,
    thinkingProtocol: info.thinkingProtocol || 'none',
    defaultEffort: info.defaultEffort ?? null,
    maxBudgetTokens: info.maxBudgetTokens ?? null,
  };
}

/**
 * Valid-effort guard. Unknown values → null (caller should treat as "no effort").
 *
 * @param {unknown} effort
 * @returns {Effort | null}
 */
export function normalizeEffort(effort) {
  if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'max') {
    return effort;
  }
  return null;
}

/**
 * Coerce a possibly-stringy numeric value to a positive integer, or
 * `undefined` if it's empty / zero / NaN / negative / non-finite.
 *
 * @param {*} v
 * @returns {number | undefined}
 */
function coercePositiveInt(v) {
  if (v === null || v === undefined || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

/**
 * Normalize a provider's `models` field into an in-memory array of
 * `{ id, contextWindow?, maxOutput? }` objects.
 *
 * Accepts legacy `string[]` and new object form `{id, contextWindow, maxOutput}`.
 * Empty / 0 / NaN / negative context/max values are treated as unset (dropped).
 *
 * @param {{ models?: Array<string | object> } | null | undefined} provider
 * @returns {Array<{ id: string, contextWindow?: number, maxOutput?: number }>}
 */
export function normalizeProviderModels(provider) {
  if (!provider || !Array.isArray(provider.models)) return [];
  const out = [];
  for (const entry of provider.models) {
    if (typeof entry === 'string') {
      const id = entry.trim();
      if (id) out.push({ id });
      continue;
    }
    if (entry && typeof entry === 'object' && typeof entry.id === 'string' && entry.id.trim()) {
      const norm = { id: entry.id.trim() };
      const ctx = coercePositiveInt(entry.contextWindow);
      const max = coercePositiveInt(entry.maxOutput);
      if (ctx !== undefined) norm.contextWindow = ctx;
      if (max !== undefined) norm.maxOutput = max;
      out.push(norm);
    }
    // silently skip anything else (null / missing id / numbers)
  }
  return out;
}

/**
 * Serialize a normalized model entry back for persistence.
 * - id-only → plain string (back-compat with existing configs)
 * - with ctx or max → object with only the fields that are set
 *
 * @param {{ id: string, contextWindow?: number, maxOutput?: number }} entry
 * @returns {string | object}
 */
export function serializeModelForPersistence(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const ctx = coercePositiveInt(entry.contextWindow);
  const max = coercePositiveInt(entry.maxOutput);
  if (ctx === undefined && max === undefined) return entry.id;
  const obj = { id: entry.id };
  if (ctx !== undefined) obj.contextWindow = ctx;
  if (max !== undefined) obj.maxOutput = max;
  return obj;
}

/**
 * Resolve model info with per-provider override.
 *
 * Lookup order:
 *   1. provider-config fields (contextWindow / maxOutput) — highest priority
 *   2. MODEL_REGISTRY entry (contextWindow / maxOutputTokens)
 *   3. undefined if neither has any info
 *
 * Returns a normalized shape: `{ id, contextWindow?, maxOutput?, provider?, adapter?, baseUrl?, displayName? }`.
 *
 * @param {string} model
 * @param {{ id?: string, contextWindow?: number, maxOutput?: number } | null} [providerConfig]
 * @returns {object | undefined}
 */
export function getModelInfo(model, providerConfig) {
  if (!model) return undefined;
  const reg = MODEL_REGISTRY.get(model);
  const overrideCtx = coercePositiveInt(providerConfig?.contextWindow);
  const overrideMax = coercePositiveInt(providerConfig?.maxOutput);

  const ctx = overrideCtx ?? reg?.contextWindow;
  const max = overrideMax ?? reg?.maxOutputTokens;

  // If we have literally no information, return undefined
  if (!reg && ctx === undefined && max === undefined) return undefined;

  const info = { id: model };
  if (reg) {
    if (reg.provider) info.provider = reg.provider;
    if (reg.adapter) info.adapter = reg.adapter;
    if (reg.baseUrl) info.baseUrl = reg.baseUrl;
    if (reg.displayName) info.displayName = reg.displayName;
  }
  if (ctx !== undefined) info.contextWindow = ctx;
  if (max !== undefined) info.maxOutput = max;
  return info;
}
