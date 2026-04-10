/**
 * models.js — Model registry for Yeaft Unify
 *
 * Maps model names to their adapter type, API base URL, and capabilities.
 * This allows `YEAFT_MODEL=gpt-5` to automatically resolve the correct
 * adapter and endpoint without setting YEAFT_ADAPTER or YEAFT_BASE_URL.
 *
 * Unknown models return null — caller falls back to env-based detection.
 */

/**
 * @typedef {Object} ModelInfo
 * @property {'anthropic' | 'chat-completions'} adapter — Which adapter to use
 * @property {string} baseUrl — API endpoint base URL
 * @property {number} contextWindow — Max context tokens
 * @property {number} maxOutputTokens — Max output tokens
 * @property {string} displayName — Human-readable model name
 */

/** @type {Map<string, ModelInfo>} */
export const MODEL_REGISTRY = new Map([
  // ── Anthropic ──────────────────────────────────────────────────
  ['claude-sonnet-4-20250514', {
    adapter: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    contextWindow: 200000,
    maxOutputTokens: 16384,
    displayName: 'Claude Sonnet 4',
  }],
  ['claude-opus-4-20250514', {
    adapter: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    contextWindow: 200000,
    maxOutputTokens: 16384,
    displayName: 'Claude Opus 4',
  }],
  ['claude-haiku-3-20250414', {
    adapter: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    contextWindow: 200000,
    maxOutputTokens: 8192,
    displayName: 'Claude Haiku 3',
  }],

  // ── OpenAI ─────────────────────────────────────────────────────
  ['gpt-5', {
    adapter: 'chat-completions',
    baseUrl: 'https://api.openai.com/v1',
    contextWindow: 256000,
    maxOutputTokens: 16384,
    displayName: 'GPT-5',
  }],
  ['gpt-5.4', {
    adapter: 'chat-completions',
    baseUrl: 'https://api.openai.com/v1',
    contextWindow: 272000,
    maxOutputTokens: 16384,
    displayName: 'GPT-5.4',
  }],
  ['gpt-4.1', {
    adapter: 'chat-completions',
    baseUrl: 'https://api.openai.com/v1',
    contextWindow: 1047576,
    maxOutputTokens: 32768,
    displayName: 'GPT-4.1',
  }],
  ['gpt-4.1-mini', {
    adapter: 'chat-completions',
    baseUrl: 'https://api.openai.com/v1',
    contextWindow: 1047576,
    maxOutputTokens: 16384,
    displayName: 'GPT-4.1 Mini',
  }],
  ['gpt-4.1-nano', {
    adapter: 'chat-completions',
    baseUrl: 'https://api.openai.com/v1',
    contextWindow: 1047576,
    maxOutputTokens: 16384,
    displayName: 'GPT-4.1 Nano',
  }],
  ['o3', {
    adapter: 'chat-completions',
    baseUrl: 'https://api.openai.com/v1',
    contextWindow: 200000,
    maxOutputTokens: 100000,
    displayName: 'o3',
  }],
  ['o4-mini', {
    adapter: 'chat-completions',
    baseUrl: 'https://api.openai.com/v1',
    contextWindow: 200000,
    maxOutputTokens: 100000,
    displayName: 'o4-mini',
  }],

  // ── DeepSeek ───────────────────────────────────────────────────
  ['deepseek-chat', {
    adapter: 'chat-completions',
    baseUrl: 'https://api.deepseek.com',
    contextWindow: 131072,
    maxOutputTokens: 8192,
    displayName: 'DeepSeek Chat',
  }],
  ['deepseek-reasoner', {
    adapter: 'chat-completions',
    baseUrl: 'https://api.deepseek.com',
    contextWindow: 131072,
    maxOutputTokens: 8192,
    displayName: 'DeepSeek Reasoner',
  }],

  // ── Google (via OpenAI-compatible API) ─────────────────────────
  ['gemini-2.5-pro', {
    adapter: 'chat-completions',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    displayName: 'Gemini 2.5 Pro',
  }],
  ['gemini-2.5-flash', {
    adapter: 'chat-completions',
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
  return MODEL_REGISTRY.get(modelName) || null;
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
