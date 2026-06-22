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
 * @typedef {{ type: 'usage', inputTokens: number, outputTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number, cacheTokensAreIncludedInInput?: boolean }} UsageEvent
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

/** Streaming response went idle after the server accepted the request. Retryable. */
export class LLMStreamIdleTimeoutError extends LLMServerError {
  constructor(message, idleMs) {
    super(message, 0);
    this.name = 'LLMStreamIdleTimeoutError';
    this.idleMs = idleMs;
  }
}

/** Abort error — signal was aborted. */
export class LLMAbortError extends Error {
  constructor() {
    super('Request aborted');
    this.name = 'LLMAbortError';
  }
}

/**
 * Default cap on a single un-terminated SSE line. A well-formed SSE stream
 * terminates every `data:` line with `\n`, so the live buffer never exceeds
 * one event. A malfunctioning gateway can instead emit a multi-megabyte run
 * with no newline; without a cap, the buffer grows unbounded and (before the
 * incremental scan below) the parse went quadratic, freezing the event loop
 * long enough to starve the WS heartbeat and drop the agent offline. 64 MiB
 * is far above any legitimate single SSE event yet bounds the damage.
 */
export const DEFAULT_SSE_MAX_LINE_BYTES = 64 * 1024 * 1024;

/**
 * Incremental, O(n) line splitter for SSE byte streams.
 *
 * The previous per-adapter pattern was `buffer += chunk; lines =
 * buffer.split('\n'); buffer = lines.pop()`. When a single line spans many
 * chunks (no `\n` yet), each chunk re-scanned and re-split the entire growing
 * buffer — O(n²) total, which on a multi-MiB un-terminated line blocks the
 * main thread for tens of seconds to minutes (measured: ~35 s at 40 MiB),
 * freezing every event-loop task including the heartbeat `setInterval` and the
 * `ws.on('pong')` handler. The agent then sees "No pong" and terminates its
 * own healthy connection.
 *
 * This buffer scans only each newly-arrived chunk for `\n` and holds the
 * still-incomplete trailing line as an array of fragments (joined only when a
 * newline finally completes it), so total work is linear in bytes received
 * regardless of how a line is chunked. It also enforces `maxLineBytes`: a
 * single line that exceeds the cap with no terminator is treated as a
 * malformed stream — `push()` throws a retryable LLMServerError (which the
 * adapter's stream loop propagates through classifyFetchError) rather than
 * accumulating without bound.
 *
 * Note: the cap is measured in JS string `.length` (UTF-16 code units), not
 * exact UTF-8 bytes. It is a coarse upper-bound guard against unbounded
 * growth, not a precise byte accountant.
 */
export class SseLineBuffer {
  /** @param {{ maxLineBytes?: number }} [opts] */
  constructor({ maxLineBytes = DEFAULT_SSE_MAX_LINE_BYTES } = {}) {
    this.maxLineBytes = Number.isFinite(maxLineBytes) && maxLineBytes > 0
      ? Math.floor(maxLineBytes)
      : DEFAULT_SSE_MAX_LINE_BYTES;
    /**
     * Fragments of the current (incomplete) line, in arrival order. Kept as an
     * array — NOT a concatenated string — because `string += chunk` reallocates
     * and copies the whole growing tail every call, which is itself O(n²) on a
     * long un-terminated line even with an incremental newline scan. Pushing a
     * fragment is O(1); we only `join` when a newline actually completes a line.
     * @type {string[]}
     */
    this._frags = [];
    /** Running byte length of `_frags` — avoids re-summing to enforce the cap. */
    this._pendingLen = 0;
  }

  /**
   * Append a chunk and return every newly-completed line (newline stripped),
   * in order. The trailing incomplete line stays buffered for the next call.
   * Lines may be empty strings (SSE uses blank lines as event separators);
   * callers filter as needed.
   *
   * @param {string} chunk
   * @returns {string[]}
   * @throws {LLMServerError} when an un-terminated line exceeds `maxLineBytes`
   */
  push(chunk) {
    if (!chunk) return [];
    const lines = [];
    let start = 0;
    // Scan only THIS chunk for newlines. Bytes before the first newline finish
    // the buffered partial line; bytes between newlines are whole lines; bytes
    // after the last newline become the new partial. Work is linear in chunk
    // length, and the buffered tail is never concatenated until a newline lands.
    let nl;
    while ((nl = chunk.indexOf('\n', start)) !== -1) {
      const segment = chunk.slice(start, nl);
      if (this._frags.length > 0) {
        this._frags.push(segment);
        lines.push(this._frags.join(''));
        this._frags = [];
        this._pendingLen = 0;
      } else {
        lines.push(segment);
      }
      start = nl + 1;
    }
    // Trailing fragment after the last newline (or the whole chunk if none):
    // buffer it as an O(1) push rather than a string concat.
    if (start < chunk.length) {
      const tail = start === 0 ? chunk : chunk.slice(start);
      this._frags.push(tail);
      this._pendingLen += tail.length;
      if (this._pendingLen > this.maxLineBytes) {
        // LLMServerError is retryable by class (engine.js retries on
        // `instanceof LLMServerError`), matching the sibling throws in the
        // adapters — no `.retryable` flag needed on the throw path.
        throw new LLMServerError(
          `SSE line exceeded ${this.maxLineBytes} bytes without a newline — treating as malformed stream`,
          0,
        );
      }
    }
    return lines;
  }

  /** The unconsumed trailing partial line (no newline yet). */
  get pending() {
    return this._frags.length === 1 ? this._frags[0] : this._frags.join('');
  }
}

/**
 * Read one chunk from a Fetch stream with a silence timeout. This is not a
 * total request deadline: every received chunk gets a fresh budget. A caller
 * abort still wins and is classified as LLMAbortError; only an idle stream is
 * converted into a retryable server error.
 *
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader
 * @param {{ signal?: AbortSignal, idleMs?: number, providerLabel?: string }} [opts]
 * @returns {Promise<ReadableStreamReadResult<Uint8Array>>}
 */
export async function readStreamChunkWithIdleTimeout(reader, opts = {}) {
  const idleMs = Number.isFinite(opts.idleMs) ? Math.max(0, Math.floor(opts.idleMs)) : 0;
  if (idleMs <= 0) return reader.read();
  if (opts.signal?.aborted) throw new LLMAbortError();

  let timer = null;
  let abortListener = null;
  let settled = false;
  const clear = () => {
    settled = true;
    if (timer) clearTimeout(timer);
    if (opts.signal && abortListener) opts.signal.removeEventListener('abort', abortListener);
  };
  try {
    return await Promise.race([
      reader.read().finally(clear),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          if (settled) return;
          const err = new LLMStreamIdleTimeoutError(
            `${opts.providerLabel || 'LLM'} stream idle timeout after ${idleMs}ms`,
            idleMs,
          );
          try { Promise.resolve(reader.cancel(err)).catch(() => {}); } catch { /* best-effort: reject below */ }
          reject(err);
        }, idleMs);
        if (timer && typeof timer.unref === 'function') timer.unref();
        if (opts.signal) {
          abortListener = () => {
            if (settled) return;
            reject(new LLMAbortError());
          };
          opts.signal.addEventListener('abort', abortListener, { once: true });
        }
      }),
    ]);
  } finally {
    clear();
  }
}

// ─── Retry helpers ─────────────────────────────────────────────

/**
 * Parse an HTTP `Retry-After` header value into milliseconds.
 *
 * The header may be either:
 *   • An integer number of seconds (delta-seconds) — `"30"`
 *   • An HTTP-date — `"Fri, 31 Dec 1999 23:59:59 GMT"`
 *
 * Returns null when the header is missing, malformed, or yields a non-positive
 * delay. Callers should treat null as "no server hint" and fall back to their
 * own backoff schedule.
 *
 * @param {string | null | undefined} headerValue
 * @returns {number | null} milliseconds to wait, or null
 */
export function parseRetryAfterMs(headerValue) {
  if (!headerValue) return null;
  const trimmed = String(headerValue).trim();
  if (!trimmed) return null;
  // Integer seconds path
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return Math.round(seconds * 1000);
  }
  // HTTP-date path
  const ts = Date.parse(trimmed);
  if (!Number.isFinite(ts)) return null;
  const delta = ts - Date.now();
  return delta > 0 ? delta : null;
}

/**
 * Read the `retry-after` header from a fetch Response in a case-insensitive
 * way that tolerates both real `Headers` instances and the plain object
 * stand-ins our tests sometimes hand us.
 *
 * @param {Response | { headers?: Record<string, string> | Headers } | null | undefined} response
 * @returns {number | null} milliseconds, or null when not present
 */
export function retryAfterFromResponse(response) {
  const headers = response?.headers;
  if (!headers) return null;
  let raw = null;
  if (typeof headers.get === 'function') {
    raw = headers.get('retry-after');
  } else {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'retry-after') {
        raw = headers[key];
        break;
      }
    }
  }
  return parseRetryAfterMs(raw);
}

/**
 * Classify a raw error thrown by `fetch()` (or while reading a streaming
 * body) into one of the unified LLM error types when it represents a
 * retryable transport-level failure (DNS, ECONN*, socket reset, fetch
 * `TypeError`, undici `UND_ERR_*`, …).
 *
 * Returns:
 *   • LLMAbortError      — caller-initiated abort; engine short-circuits.
 *   • LLMServerError     — transient transport failure; engine should retry.
 *   • the original error — anything that doesn't match a known transient
 *                          pattern. We never invent retryability we can't
 *                          prove from the error shape.
 *
 * @param {unknown} err
 * @param {{ providerLabel?: string, signal?: AbortSignal }} [opts]
 * @returns {Error}
 */
export function classifyFetchError(err, opts = {}) {
  if (!(err instanceof Error)) return err instanceof Object ? err : new Error(String(err));
  if (err.name === 'LLMAbortError' || err instanceof LLMAbortError) return new LLMAbortError();
  const label = opts.providerLabel ? `${opts.providerLabel}: ` : '';
  if (err.name === 'AbortError') {
    if (opts.signal?.aborted) return new LLMAbortError();
    return new LLMServerError(`${label}stream aborted unexpectedly: ${err.message || 'AbortError'}`, 0);
  }
  // Anything already classified: keep as-is.
  if (err instanceof LLMRateLimitError
    || err instanceof LLMAuthError
    || err instanceof LLMContextError
    || err instanceof LLMServerError
    || err instanceof LLMAbortError) {
    return err;
  }
  const code = err.cause?.code || err.code || null;
  const transientCodes = new Set([
    'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT',
    'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
    'UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT',
  ]);
  if (code && transientCodes.has(code)) {
    return new LLMServerError(`${label}network error (${code}): ${err.message}`, 0);
  }
  // Node 20+ fetch surfaces network problems as a plain TypeError
  // with `cause` set to the underlying undici error. We treat any
  // such TypeError as transient — abort already returned above.
  if (err.name === 'TypeError' && /fetch failed|terminated|network|socket/i.test(err.message || '')) {
    return new LLMServerError(`${label}fetch failed: ${err.message}`, 0);
  }
  return err;
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
 * individual payloads. See `MAX_YEAFT_DEBUG_LOOPS` in `web/stores/chat.js`.
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
    return new AdapterRouter({ providers: config.providers, llmRetry: config.llmRetry });
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
      streamIdleTimeoutMs: config.llmRetry?.streamIdleTimeoutMs,
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
