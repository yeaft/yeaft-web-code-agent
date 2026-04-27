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
 * @typedef {{ type: 'tool_call', id: string, name: string, input: object }} ToolCallEvent
 * @typedef {{ type: 'usage', inputTokens: number, outputTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number }} UsageEvent
 * @typedef {{ type: 'stop', stopReason: 'end_turn' | 'tool_use' | 'max_tokens' }} StopEvent
 * @typedef {{ type: 'error', error: Error, retryable: boolean }} ErrorEvent
 *
 * @typedef {TextDeltaEvent | ThinkingDeltaEvent | ToolCallEvent | UsageEvent | StopEvent | ErrorEvent} StreamEvent
 */

// ─── Unified Message Types ─────────────────────────────────────

/**
 * @typedef {{ role: 'system', content: string }} SystemMessage
 * @typedef {{ role: 'user', content: string }} UserMessage
 * @typedef {{ role: 'assistant', content: string, toolCalls?: UnifiedToolCall[] }} AssistantMessage
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

// ─── task-344: Raw payload redaction helper ────────────────────

/**
 * task-344 follow-up (N2): cap raw payload size exposed via onRawExchange.
 * Prevents the web debug store from linear-growing when a single turn
 * sends / receives megabytes of content. 256 KiB per field per turn.
 */
export const RAW_PAYLOAD_CAP_BYTES = 256 * 1024;

/**
 * Truncate a string to at most `cap` bytes (UTF-8). When within cap the
 * original is returned; otherwise a prefix with a trailing
 * `…[truncated, original N bytes]` marker. Non-string inputs pass through.
 *
 * @param {string} s
 * @param {number} [cap=RAW_PAYLOAD_CAP_BYTES]
 * @returns {string}
 */
export function capRawString(s, cap = RAW_PAYLOAD_CAP_BYTES) {
  if (typeof s !== 'string') return s;
  const encoder = new TextEncoder();
  const fullBytes = encoder.encode(s);
  if (fullBytes.length <= cap) return s;
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const prefix = decoder.decode(fullBytes.slice(0, cap));
  return `${prefix}…[truncated, original ${fullBytes.length} bytes]`;
}

/**
 * Cap the `body` field of a rawRequest envelope. JSON-stringifies objects
 * before sizing so an oversized `messages` array does not escape the cap.
 * When truncation fires, body becomes a string (JSON prefix + marker);
 * objects under cap stay objects.
 *
 * @param {{ url: string, method: string, headers: object, body: any }} req
 * @param {number} [cap=RAW_PAYLOAD_CAP_BYTES]
 * @returns {{ url: string, method: string, headers: object, body: any }}
 */
export function capRawRequest(req, cap = RAW_PAYLOAD_CAP_BYTES) {
  if (!req || typeof req !== 'object') return req;
  let body = req.body;
  if (body != null && typeof body !== 'string') {
    let serialized;
    try { serialized = JSON.stringify(body); }
    catch { serialized = String(body); }
    if (typeof serialized === 'string' && new TextEncoder().encode(serialized).length > cap) {
      body = capRawString(serialized, cap);
    }
  } else if (typeof body === 'string') {
    body = capRawString(body, cap);
  }
  return { url: req.url, method: req.method, headers: req.headers, body };
}

/**
 * Redact sensitive headers (API keys / bearer tokens) from a raw request
 * shape before exposing it to debug UI. Always returns a NEW object — never
 * mutates the input.
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
