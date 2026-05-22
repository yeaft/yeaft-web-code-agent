/**
 * adapter.js — LLM Adapter base class, unified types, and factory
 *
 * Design decision (Phase 7, 2026-04-27): Only two adapters remain:
 *   1. AnthropicAdapter        — Anthropic Messages API
 *   2. OpenAIResponsesAdapter  — OpenAI Responses API (covers GPT, DeepSeek, CopilotProxy, etc.)
 *
 * The legacy ChatCompletionsAdapter (OpenAI Chat Completions API) was deleted in
 * Phase 7. Configurations using protocol "openai" or alias "chat-completions"
 * must migrate to "openai-responses" or "anthropic".
 *
 * The engine sees only unified types — it never knows which API is underneath.
 */

// ─── Unified Types ─────────────────────────────────────────────

/**
 * @typedef {Object} UnifiedToolDef
 * @property {string} name
 * @property {string} description
 * @property {object} parameters — JSON Schema
 */

/**
 * @typedef {Object} UnifiedToolCall
 * @property {string} id
 * @property {string} name
 * @property {object} input — Parsed object (not JSON string)
 */

/**
 * @typedef {Object} UnifiedToolResult
 * @property {string} toolCallId
 * @property {string} output
 * @property {boolean} [isError]
 */

// ─── Unified Event Stream ──────────────────────────────────────

/**
 * @typedef {{ type: 'text_delta', text: string }} TextDeltaEvent
 * @typedef {{ type: 'thinking_delta', text: string }} ThinkingDeltaEvent
 * @typedef {{ type: 'thinking_block_end', thinking: string, signature: string }} ThinkingBlockEndEvent
 * @typedef {{ type: 'tool_call', id: string, name: string, input: object }} ToolCallEvent
 * @typedef {{ type: 'usage', inputTokens: number, outputTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number }} UsageEvent
 * @typedef {{ type: 'stop', stopReason: 'end_turn' | 'tool_use' | 'max_tokens' }} StopEvent
 * @typedef {{ type: 'error', error: Error, retryable: boolean }} ErrorEvent
 *
 * @typedef {TextDeltaEvent | ThinkingDeltaEvent | ThinkingBlockEndEvent | ToolCallEvent | UsageEvent | StopEvent | ErrorEvent} StreamEvent
 */

// ─── Unified Message Types ─────────────────────────────────────

/**
 * @typedef {{ thinking: string, signature: string }} ThinkingBlock
 *
 * @typedef {{ role: 'system', content: string }} SystemMessage
 * @typedef {{ role: 'user', content: string }} UserMessage
 * @typedef {{ role: 'assistant', content: string, toolCalls?: UnifiedToolCall[], thinkingBlocks?: ThinkingBlock[] }} AssistantMessage
 * @typedef {{ role: 'tool', toolCallId: string, content: string, isError?: boolean }} ToolMessage
 *
 * @typedef {SystemMessage | UserMessage | AssistantMessage | ToolMessage} UnifiedMessage
 */

// ─── Error Types ───────────────────────────────────────────────

/** Rate limit error (429, 529) — retryable with backoff. */
export class LLMRateLimitError extends Error {
  constructor(message, statusCode, retryAfterMs = null) {
    super(message);
    this.name = 'LLMRateLimitError';
    this.statusCode = statusCode;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Authentication error (401, 403) — need to re-authenticate. */
export class LLMAuthError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'LLMAuthError';
    this.statusCode = statusCode;
  }
}

/** Context too long error (413 or API-specific) — need compaction. */
export class LLMContextError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LLMContextError';
  }
}

/** Server error (500, 502, 503) — retryable. */
export class LLMServerError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'LLMServerError';
    this.statusCode = statusCode;
  }
}

/** Abort error — signal was aborted. */
export class LLMAbortError extends Error {
  constructor() {
    super('Request aborted');
    this.name = 'LLMAbortError';
  }
}

// ─── Raw payload redaction helper ──────────────────────────────

/**
 * Redact sensitive headers (API keys / bearer tokens) from a raw request
 * shape before exposing it to debug UI. Always returns a NEW object — never
 * mutates the input.
 *
 * NOTE: there is intentionally NO body / response truncation here. The whole
 * point of the "copy request" debug feature is to capture EXACTLY what we
 * sent to the LLM. A truncated copy is worse than useless — it lies about
 * what the model saw. If the resulting payload is too large for the debug
 * store, the fix is to bound retention (drop oldest turns), not to mutilate
 * individual payloads. See `MAX_UNIFY_DEBUG_LOOPS` in `web/stores/chat.js`.
 *
 * @param {{ url: string, method: string, headers: object, body: any }} req
 * @returns {{ url: string, method: string, headers: object, body: any }}
 */
export function redactRawRequest(req) {
  if (!req || typeof req !== 'object') return req;
  const headers = { ...(req.headers || {}) };
  // Common auth headers
  for (const k of Object.keys(headers)) {
    const lower = k.toLowerCase();
    if (lower === 'x-api-key' || lower === 'authorization' || lower === 'api-key') {
      headers[k] = '***';
    }
  }
  return { url: req.url, method: req.method, headers, body: req.body };
}

/**
 * Snapshot a Fetch Response's headers into a plain object for the debug
 * panel. Defensive against polyfilled / mocked Response shapes that don't
 * implement `Headers#entries()` — falls back to `{}` rather than throwing.
 *
 * NOTE: multi-valued headers (e.g. `Set-Cookie`) collapse to the last value
 * because `Object.fromEntries` can't represent duplicates. For LLM debug
 * traffic this is fine; if a future use case needs multi-valued capture,
 * switch the return to an array of [k, v] pairs.
 *
 * @param {Response | { headers?: { entries?: () => Iterable<[string, string]> } }} response
 * @returns {Record<string, string>}
 */
export function safeHeaders(response) {
  const h = response && response.headers;
  if (h && typeof h.entries === 'function') {
    return Object.fromEntries(h.entries());
  }
  return {};
}

// ─── Base Class ────────────────────────────────────────────────

/**
 * LLMAdapter — Abstract base class for LLM API adapters.
 *
 * Subclasses implement stream() and call() to talk to a specific API,
 * translating between the unified types and the wire format.
 */
export class LLMAdapter {
  /**
   * @param {object} config — Adapter-specific configuration
   */
  constructor(config = {}) {
    this.config = config;
  }

  /**
   * Stream a model response with tool support (the query loop call).
   *
   * @param {{ model: string, system: string, messages: UnifiedMessage[], tools?: UnifiedToolDef[], maxTokens?: number, signal?: AbortSignal }} params
   * @returns {AsyncGenerator<StreamEvent>}
   */
  async *stream(params) { // eslint-disable-line no-unused-vars
    throw new Error('stream() must be implemented by subclass');
  }

  /**
   * Make a single model call without tools (for side queries like summarization).
   *
   * @param {{ model: string, system: string, messages: UnifiedMessage[], maxTokens?: number, signal?: AbortSignal }} params
   * @returns {Promise<{ text: string, usage: { inputTokens: number, outputTokens: number } }>}
   */
  async call(params) { // eslint-disable-line no-unused-vars
    throw new Error('call() must be implemented by subclass');
  }
}

// ─── Factory ───────────────────────────────────────────────────

/**
 * Create an LLM adapter based on configuration.
 *
 * If config.providers exists (config.json path), creates an AdapterRouter
 * that routes requests to the correct provider based on model ID.
 *
 * Otherwise falls back to legacy single-adapter creation from env vars.
 *
 * @param {object} config — From loadConfig()
 * @returns {Promise<LLMAdapter>}
 */
export async function createLLMAdapter(config) {
  // ─── New path: config.json with providers ─────────────
  if (config.providers && config.providers.length > 0) {
    const { AdapterRouter } = await import('./router.js');
    return new AdapterRouter({ providers: config.providers });
  }

  // ─── Legacy path: single adapter from env vars ────────
  const adapter = config.adapter;

  if (adapter === 'anthropic' || (!adapter && config.apiKey)) {
    if (!config.apiKey) {
      throw new Error('Anthropic adapter requires YEAFT_API_KEY');
    }
    const { AnthropicAdapter } = await import('./anthropic.js');
    return new AnthropicAdapter({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl || undefined, // AnthropicAdapter has its own default
    });
  }

  if (
    adapter === 'chat-completions' ||
    adapter === 'openai' ||
    adapter === 'proxy' ||
    (!adapter && (config.openaiApiKey || config.proxyUrl))
  ) {
    throw new Error(
      'The chat-completions adapter was removed in Phase 7. ' +
      'Configure providers via ~/.yeaft/config.json with protocol: "anthropic" ' +
      'or protocol: "openai-responses" instead of using the legacy ' +
      '"openai"/"proxy"/"chat-completions" adapter env-var path.'
    );
  }

  throw new Error(
    'No LLM adapter configured. Set YEAFT_API_KEY (Anthropic) or configure ' +
    'providers in ~/.yeaft/config.json. The chat-completions/openai/proxy ' +
    'env-var paths were removed in Phase 7 — use protocol: "openai-responses" ' +
    'in a provider entry instead.',
  );
}
