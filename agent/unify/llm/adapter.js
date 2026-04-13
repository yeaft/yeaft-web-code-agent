/**
 * adapter.js — LLM Adapter base class, unified types, and factory
 *
 * Design decision (2026-04-10): Only two adapters needed:
 *   1. AnthropicAdapter — Anthropic Messages API
 *   2. ChatCompletionsAdapter — OpenAI Chat Completions API (covers GPT, DeepSeek, CopilotProxy, etc.)
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
  // Normalize adapter name — accept 'chat-completions' as alias for 'openai'
  const adapter = config.adapter === 'chat-completions' ? 'openai' : config.adapter;

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

  if (adapter === 'openai' || (!adapter && config.openaiApiKey)) {
    if (!config.openaiApiKey && !config.apiKey) {
      throw new Error('OpenAI adapter requires YEAFT_OPENAI_API_KEY (or YEAFT_API_KEY as fallback)');
    }
    const { ChatCompletionsAdapter } = await import('./chat-completions.js');
    return new ChatCompletionsAdapter({
      apiKey: config.openaiApiKey || config.apiKey,
      baseUrl: config.baseUrl || 'https://api.openai.com/v1',
    });
  }

  if (adapter === 'proxy' || (!adapter && config.proxyUrl)) {
    const { ChatCompletionsAdapter } = await import('./chat-completions.js');
    return new ChatCompletionsAdapter({
      apiKey: 'proxy', // CopilotProxy handles auth
      baseUrl: `${config.proxyUrl}/v1`,
    });
  }

  throw new Error(
    'No LLM adapter configured. Set YEAFT_API_KEY (Anthropic), YEAFT_OPENAI_API_KEY (OpenAI), or YEAFT_PROXY_URL (CopilotProxy).',
  );
}
