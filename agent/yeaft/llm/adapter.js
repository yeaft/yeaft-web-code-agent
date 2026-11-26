/**
 * adapter.js — LLM Adapter base class, unified types, and factory
 *
 * Native adapters:
 *   1. AnthropicAdapter              — Anthropic Messages API
 *   2. OpenAIResponsesAdapter        — OpenAI Responses API (/v1/responses)
 *   3. OpenAIChatCompletionsAdapter  — OpenAI Chat Completions API (/v1/chat/completions)
 *   4. GeminiAdapter                 — Gemini GenerateContent API
 *
 * The engine sees only unified types — it never knows which API is underneath.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { Agent, EnvHttpProxyAgent } from 'undici';
import { utf8PrefixWithinBytes } from '../utf8.js';

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
 * @typedef {{ type: 'provider_activity' }} ProviderActivityEvent Content-free progress on a non-empty hidden delta; watchdog only, never UI/history.
 * @typedef {{ type: 'provider_state', providerState: object, providerStateBytes: number }} ProviderStateEvent Internal only; never forward to UI/search.
 * @typedef {{ type: 'usage', inputTokens: number, outputTokens: number, reasoningTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number, cacheTokensAreIncludedInInput?: boolean, reportedTokenFields?: string[], usageIncomplete?: boolean }} UsageEvent
 * @typedef {'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'refusal' | 'pause_turn' | 'model_context_window_exceeded' | 'unknown'} StopReason
 * @typedef {{ protocol?: string, responseId?: string, model?: string, stopReason?: string|null, stopDetails?: object|null, stopSequence?: string|null, inputTransformations?: object|Array<object>, container?: object|null, contentBlocks?: Array<object> }} ProviderMetadata Safe protocol bookkeeping only; no private reasoning, signatures or native response items.
 * @typedef {{ type: 'provider_metadata', metadata: ProviderMetadata }} ProviderMetadataEvent Internal metadata updates merged on the assistant history row and trace, not forwarded as visible content.
 * @typedef {{ type: 'content_filter', reason: string, blocked: 'prompt'|'response', withheldToolCalls: number, withheldTools?: string[] }} ContentFilterStopDetails Provider-neutral record of a provider safety/content filter stop.
 * @typedef {{ type: 'stop', stopReason: StopReason, stopDetails?: ContentFilterStopDetails|object|null, stopSequence?: string|null }} StopEvent pause_turn requests bounded continuation of the exact assistant response; refusal/context overflow/unknown are not successful completions.
 * @typedef {{ type: 'error', error: Error, retryable: boolean }} ErrorEvent
 *
 * @typedef {TextDeltaEvent | ThinkingDeltaEvent | ThinkingBlockEndEvent | ProviderActivityEvent | ProviderStateEvent | ProviderMetadataEvent | ToolCallEvent | UsageEvent | StopEvent | ErrorEvent} StreamEvent
 */

const MAX_WITHHELD_TOOL_NAMES = 8;
const FILTER_REASON_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const TOOL_NAME_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const UNDECLARED_TOOL = 'undeclared tool';

/**
 * Describe a provider content filter stop without echoing filtered content.
 * Calls in a filtered response are withheld from execution; only names of
 * functions declared by this request are reported, never provider arguments.
 * @param {{ reason: string, blocked?: 'prompt'|'response', calledNames?: Array<unknown>, declaredNames?: Iterable<unknown> }} input
 * @returns {ContentFilterStopDetails}
 */
export function contentFilterStopDetails({ reason, blocked = 'response', calledNames = [], declaredNames = [] }) {
  const declared = new Set(declaredNames);
  const names = [...new Set(calledNames.map(name => (typeof name === 'string' && declared.has(name) && TOOL_NAME_RE.test(name)
    ? name : UNDECLARED_TOOL)))];
  return { type: 'content_filter', reason, blocked, withheldToolCalls: calledNames.length,
    ...(names.length ? { withheldTools: names.slice(0, MAX_WITHHELD_TOOL_NAMES) } : {}) };
}

/**
 * Accept only the bounded shape built by contentFilterStopDetails(). Native
 * stop details forwarded by a provider or proxy are untrusted text.
 * @param {unknown} details
 * @returns {details is ContentFilterStopDetails}
 */
export function isContentFilterStopDetails(details) {
  if (details?.type !== 'content_filter' || typeof details.reason !== 'string' || !FILTER_REASON_RE.test(details.reason)) return false;
  if (!['prompt', 'response'].includes(details.blocked)
    || !Number.isSafeInteger(details.withheldToolCalls) || details.withheldToolCalls < 0) return false;
  const names = details.withheldTools;
  return names === undefined || (Array.isArray(names) && names.length <= MAX_WITHHELD_TOOL_NAMES
    && names.every(name => name === UNDECLARED_TOOL || (typeof name === 'string' && TOOL_NAME_RE.test(name))));
}

// contextOutputLimit is the remaining context space for output (not the configured
// maxTokens target). Anthropic uses it to preflight signed continuations after
// thinking and extraBody normalization; omitted callers retain native widening.

// ─── Unified Message Types ─────────────────────────────────────

/**
 * @typedef {{ thinking: string, signature: string }} ThinkingBlock
 *
 * @typedef {{ role: 'system', content: string }} SystemMessage
 * @typedef {{ role: 'user', content: string|Array<object> }} UserMessage
 * @typedef {{ role: 'assistant', content: string, toolCalls?: UnifiedToolCall[], thinkingBlocks?: ThinkingBlock[], providerState?: object, providerMetadata?: ProviderMetadata }} AssistantMessage
 * @typedef {{ role: 'tool', toolCallId: string, content: string|Array<object>, isError?: boolean }} ToolMessage
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

/** Authentication / authorization error (401, 403). */
export class LLMAuthError extends Error {
  constructor(message, statusCode, details = {}) {
    super(message);
    this.name = 'LLMAuthError';
    this.statusCode = statusCode;
    this.reasonCode = details.reasonCode || (statusCode === 401 ? 'invalid_credentials' : 'permission_denied');
    this.temporary = details.temporary === true;
    this.provider = details.provider || null;
    this.model = details.model || null;
    this.credentialRefreshable = details.credentialRefreshable === true;
  }
}

const PERMANENT_FORBIDDEN_RE = /(?:access[_ -]?denied|not[_ -]?authorized|unauthori[sz]ed|authorization[_ -]?denied|policy|safety|content[_ -]?filter|entitle(?:ment|d)|subscription[_ -]?(?:required|inactive|expired)|plan[_ -]?(?:required|does[_ -]?not[_ -]?include)|model[^\n]{0,60}(?:access|permission|unavailable|not[_ -]?available|plan)|permission[^\n]{0,40}model|account[^\n]{0,40}(?:disabled|suspended)|organization[^\n]{0,40}(?:disabled|suspended)|insufficient[_ -]?(?:permission|scope))/i;
const PERMANENT_FORBIDDEN_CODE_RE = /(?:access_denied|permission_denied|unauthorized|not_authorized|insufficient_(?:scope|permission)|model_(?:access_denied|not_available)|subscription_required|not_entitled|policy_violation|content_filter)/i;

function parseProviderErrorBody(responseBody) {
  if (typeof responseBody !== 'string') return responseBody && typeof responseBody === 'object' ? responseBody : null;
  try {
    const parsed = JSON.parse(responseBody);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function providerErrorSignals(responseBody) {
  const parsed = parseProviderErrorBody(responseBody);
  const error = parsed?.error && typeof parsed.error === 'object' ? parsed.error : parsed;
  const code = [error?.code, error?.type, error?.reason, parsed?.code, parsed?.type]
    .filter(value => typeof value === 'string')
    .join(' ');
  const message = [error?.message, parsed?.message, typeof responseBody === 'string' ? responseBody : '']
    .filter(value => typeof value === 'string')
    .join(' ');
  return { code, message };
}

/**
 * Build a user-safe auth error. The provider response body is used only for
 * classification and is deliberately excluded from the message; raw response
 * capture remains available in the bounded debug trace.
 */
export function classifyAuthError(statusCode, responseBody = '', details = {}) {
  const status = Number(statusCode) || 0;
  if (status === 401) {
    return new LLMAuthError('LLM provider returned HTTP 401 (invalid credentials)', status, {
      ...details,
      reasonCode: 'invalid_credentials',
      temporary: false,
    });
  }
  const signals = providerErrorSignals(responseBody);
  const permanent = PERMANENT_FORBIDDEN_CODE_RE.test(signals.code)
    || PERMANENT_FORBIDDEN_RE.test(signals.message);
  const reasonCode = permanent ? 'permission_denied' : 'unknown_forbidden';
  return new LLMAuthError(`LLM provider returned HTTP 403 (${reasonCode})`, status, {
    ...details,
    reasonCode,
    temporary: !permanent,
  });
}

/** Provider content-safety rejection (commonly 422) — eligible for one sanitized recovery. */
export class LLMPolicyError extends Error {
  constructor(_providerMessage, statusCode = 422, details = {}) {
    super('The LLM provider blocked this request under its content-safety policy. Continue and avoid repeating sensitive payloads or credential-like examples.');
    this.name = 'LLMPolicyError';
    this.statusCode = statusCode;
    this.reasonCode = 'content_policy_denied';
    this.provider = details.provider || null;
    this.model = details.model || null;
  }
}

const CONTENT_POLICY_RE = /(?:content (?:was )?flagged|content[-_ ]?safety|cybersecurity risk|safety policy|safety system|content[_ -]?filter|policy[_ -]?violation)/i;

export function classifyPolicyError(statusCode, responseBody = '', details = {}) {
  const status = Number(statusCode) || 0;
  const signals = providerErrorSignals(responseBody);
  if (status !== 422 || (!CONTENT_POLICY_RE.test(signals.code) && !CONTENT_POLICY_RE.test(signals.message))) {
    return null;
  }
  return new LLMPolicyError(signals.message, status, details);
}

/** Model token window rejected the request. HTTP body limits are separate. */
export class LLMContextError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LLMContextError';
  }
}

/** Final serialized HTTP body exceeds a local budget or was rejected with HTTP 413. */
export class LLMRequestTooLargeError extends Error {
  constructor(requestBytes, { limitBytes, received413 = false } = {}) {
    super(received413
      ? `Provider rejected the ${requestBytes}-byte request body (HTTP 413).`
      : `Request body is ${requestBytes} bytes, above the ${limitBytes}-byte limit.`);
    this.name = 'LLMRequestTooLargeError';
    this.reasonCode = 'request_body_too_large';
    this.requestBytes = requestBytes;
    this.limitBytes = limitBytes;
    if (received413) this.statusCode = 413;
  }
}

/** Measure the exact UTF-8 string that will be handed to fetch. */
export function serializeModelRequestBody(payload, limitBytes) {
  const body = JSON.stringify(payload);
  const requestBytes = Buffer.byteLength(body, 'utf8');
  if (limitBytes != null && requestBytes > limitBytes) throw new LLMRequestTooLargeError(requestBytes, { limitBytes });
  return { body, requestBytes };
}

/** Server error (500, 502, 503) — retryable. */
export class LLMServerError extends Error {
  constructor(message, statusCode, retryAfterMs = null) {
    super(message);
    this.name = 'LLMServerError';
    this.statusCode = statusCode;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Invalid/incomplete provider tool batch (e.g. Gemini MALFORMED_FUNCTION_CALL).
 * stream() publishes this as an error event with retryable:false — it is not a
 * transport failure — and call() throws it. No tool_call may be published from
 * the rejected batch, so the Engine may request a fresh response that asks for
 * complete arguments; an adapter that knows the provider itself ran tools in
 * this response adds `replayUnsafe: true` to the event instead.
 */
export class LLMToolInputError extends LLMServerError {
  constructor(message) {
    super(message, 0);
    this.name = 'LLMToolInputError';
    this.toolInputRejected = true;
    this.retryable = false;
  }
}

/** Distinguish missing upstream headers from a stalled response body. */
export class LLMHeadersTimeoutError extends LLMServerError {
  constructor(upstream = false) {
    super(upstream ? 'The gateway timed out waiting for upstream model response headers.'
      : 'Timed out waiting for model response headers.', upstream ? 504 : 0);
    this.name = 'LLMHeadersTimeoutError';
    this.reasonCode = upstream ? 'upstream_headers_timeout' : 'response_headers_timeout';
  }
}

export function classifyUpstreamHeadersTimeout(status, responseBody) {
  if (status !== 504) return null;
  const body = parseProviderErrorBody(responseBody);
  return (body?.error?.code ?? body?.code) === 'upstream_headers_timeout' ? new LLMHeadersTimeoutError(true) : null;
}

const UPSTREAM_STREAM_TIMEOUT_MESSAGE_RE = /^(?:terminated)$|\b(?:body\s+timeout|stream\s+timed?\s*out|UND_ERR_BODY_TIMEOUT|upstream_stream_timeout)\b/i;

/**
 * Classify gateway-injected streaming error frames (such as Copilot Proxy's
 * `upstream_stream_timeout` or legacy `{ type: 'upstream_error', code: null,
 * message: 'terminated' }`) into the matching retryable timeout or server error.
 *
 * Never overrides a specific non-gateway error code (e.g. `context_length_exceeded`,
 * `rate_limit_exceeded`, `invalid_request_error`).
 *
 * @param {{ code?: string|null, type?: string|null, message?: string, retryAfterMs?: number|null }} [input]
 * @returns {LLMHeadersTimeoutError | LLMStreamIdleTimeoutError | LLMServerError | null}
 */
export function classifyUpstreamStreamError({ code = null, type = null, message = '', retryAfterMs = null } = {}) {
  const cleanCode = typeof code === 'string' && code.trim() ? code.trim() : null;
  const cleanType = typeof type === 'string' && type.trim() ? type.trim() : null;
  if (cleanCode === 'upstream_headers_timeout') {
    return new LLMHeadersTimeoutError(true);
  }
  if (cleanCode === 'upstream_stream_timeout') {
    return new LLMStreamIdleTimeoutError(
      message || 'The gateway timed out waiting for upstream model stream data.',
      0,
      { upstream: true },
    );
  }
  if (cleanType === 'upstream_error' && (!cleanCode || cleanCode === 'upstream_error')) {
    if (typeof message === 'string' && UPSTREAM_STREAM_TIMEOUT_MESSAGE_RE.test(message.trim())) {
      return new LLMStreamIdleTimeoutError(message.trim(), 0, { upstream: true });
    }
    return new LLMServerError(message || 'Upstream model stream failed.', 0, retryAfterMs);
  }
  return null;
}

let cachedModelFetchDispatcher = null;
let cachedModelFetchEnvProxyKey = null;

function isEnvProxyEnabled() {
  if (process.env.NODE_USE_ENV_PROXY === '1') return true;
  if (process.execArgv.includes('--use-env-proxy')) return true;
  const nodeOptions = process.env.NODE_OPTIONS;
  return typeof nodeOptions === 'string' && /(?:^|\s)--use-env-proxy(?=\s|$)/.test(nodeOptions);
}

function modelFetchEnvProxyKey() {
  if (!isEnvProxyEnabled()) return 'direct';
  return [
    'env',
    process.env.http_proxy ?? '',
    process.env.HTTP_PROXY ?? '',
    process.env.https_proxy ?? '',
    process.env.HTTPS_PROXY ?? '',
    process.env.no_proxy ?? '',
    process.env.NO_PROXY ?? '',
  ].join('\0');
}

/**
 * Create an Undici dispatcher for LLM HTTP calls.
 *
 * Node's global `fetch()` defaults to Undici's 300s `headersTimeout` and 300s
 * `bodyTimeout`, which silently aborts healthy long-running streams (such as
 * models buffering large `FileWrite` arguments before emitting a chunk) even
 * when Yeaft's configured stream silence budget is 600s–900s. Disabling both
 * Undici timers here makes `fetchWithHeadersTimeout()` and
 * `readStreamChunkWithIdleTimeout()` the single source of truth.
 *
 * @param {{ headersTimeout?: number, bodyTimeout?: number }} [opts]
 */
export function createModelFetchDispatcher(opts = {}) {
  const dispatcherOpts = {
    headersTimeout: 0,
    bodyTimeout: 0,
    ...opts,
  };
  return isEnvProxyEnabled() ? new EnvHttpProxyAgent(dispatcherOpts) : new Agent(dispatcherOpts);
}

function getModelFetchDispatcher() {
  const key = modelFetchEnvProxyKey();
  if (cachedModelFetchDispatcher && cachedModelFetchEnvProxyKey === key) {
    return cachedModelFetchDispatcher;
  }
  const previous = cachedModelFetchDispatcher;
  cachedModelFetchDispatcher = createModelFetchDispatcher();
  cachedModelFetchEnvProxyKey = key;
  if (previous) {
    Promise.resolve(previous.close()).catch(() => {});
  }
  return cachedModelFetchDispatcher;
}

const modelFetchAdmission = new AsyncLocalStorage();

/** Request-local admission for callers sending revocable data; retries inherit it. */
export function withModelFetchAdmission(admit, run) {
  return modelFetchAdmission.run(admit, run);
}

/** Stop the retry clock from interrupting healthy body streaming once headers arrive. */
export async function fetchWithHeadersTimeout(url, init = {}, timeoutMs) {
  let requestInit = init && typeof init === 'object' ? init : {};
  if (requestInit.signal?.aborted) throw new LLMAbortError();
  const admit = modelFetchAdmission.getStore();
  if (admit) {
    await admit();
    if (requestInit.signal?.aborted) throw new LLMAbortError();
    // A 307/308 can otherwise replay the same body inside fetch without
    // reentering this admission boundary.
    requestInit = { ...requestInit, redirect: 'error' };
  }
  if (Number.isFinite(timeoutMs) && timeoutMs <= 0) throw new LLMHeadersTimeoutError();
  const dispatcher = requestInit.dispatcher ?? getModelFetchDispatcher();
  if (!Number.isFinite(timeoutMs)) return fetch(url, { ...requestInit, dispatcher });
  const deadline = new AbortController();
  const signal = requestInit.signal ? AbortSignal.any([requestInit.signal, deadline.signal]) : deadline.signal;
  const timer = setTimeout(() => deadline.abort(new LLMHeadersTimeoutError()), timeoutMs);
  try {
    return await fetch(url, { ...requestInit, signal, dispatcher });
  } catch (error) {
    if (requestInit.signal?.aborted) throw new LLMAbortError();
    if (deadline.signal.aborted) throw deadline.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Streaming response went idle after the server accepted the request. Retryable. */
export class LLMStreamIdleTimeoutError extends LLMServerError {
  constructor(message, idleMs = 0, details = {}) {
    super(message, 0);
    this.name = 'LLMStreamIdleTimeoutError';
    this.idleMs = idleMs;
    this.upstream = details?.upstream === true;
    this.reasonCode = details?.reasonCode || (this.upstream ? 'upstream_stream_timeout' : 'stream_idle_timeout');
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

/** Hard upper bound (ms) for any enabled per-chunk stream silence budget (15 minutes). */
export const MAX_STREAM_IDLE_TIMEOUT_MS = 900_000;

/**
 * Resolve one request's transport silence budget after final effort enforcement.
 * Provider/model overrides are absolute (including 0); the shared adapter is
 * never mutated. Explicit legacy timeouts apply to every effort unless a high
 * budget was also configured. High-effort budgets never shrink below the normal
 * budget (unless explicitly disabled with 0), and an optional `minTimeoutMs`
 * floor (preserved across same-model retries such as effort step-down) prevents
 * a retry from shrinking the silence budget without re-enabling a disabled (`0`)
 * guard. All enabled budgets remain bounded at {@link MAX_STREAM_IDLE_TIMEOUT_MS}.
 *
 * @param {{ streamIdleTimeoutMs?: number, highEffortStreamIdleTimeoutMs?: number }} policy
 * @param {string|null} effort — effective wire effort, not the requested value
 * @param {number|undefined} overrideMs — model > provider override
 * @param {number|undefined} [minTimeoutMs] — non-shrinking retry floor (positive ms, or `Infinity` when a prior attempt had the guard disabled)
 * @returns {number}
 */
export function resolveStreamIdleTimeoutMs(policy = {}, effort = null, overrideMs, minTimeoutMs) {
  const valid = value => Number.isFinite(value) && value >= 0;
  const clamp = value => Math.min(MAX_STREAM_IDLE_TIMEOUT_MS, Math.floor(value));
  if (valid(overrideMs)) return clamp(overrideMs);
  const normal = valid(policy.streamIdleTimeoutMs) ? clamp(policy.streamIdleTimeoutMs) : 0;
  if (normal === 0) return 0;
  const high = ['high', 'xhigh', 'max', 'ultra'].includes(effort);
  let resolved = normal;
  if (high && valid(policy.highEffortStreamIdleTimeoutMs)) {
    const highBudget = clamp(policy.highEffortStreamIdleTimeoutMs);
    resolved = highBudget === 0 ? 0 : Math.max(normal, highBudget);
  }
  if (resolved === 0) return 0;
  if (minTimeoutMs === Infinity) return 0;
  return valid(minTimeoutMs) && minTimeoutMs > 0
    ? Math.max(resolved, clamp(minTimeoutMs))
    : resolved;
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

const HTTP_DATE_PATTERNS = [
  /^(?<weekday>[A-Z][a-z]{2}), (?<day>\d{2}) (?<month>[A-Z][a-z]{2}) (?<year>\d{4}) (?<time>\d{2}:\d{2}:\d{2}) GMT$/,
  /^(?<weekday>Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (?<day>\d{2})-(?<month>[A-Z][a-z]{2})-(?<year>\d{2}) (?<time>\d{2}:\d{2}:\d{2}) GMT$/,
  /^(?<weekday>[A-Z][a-z]{2}) (?<month>[A-Z][a-z]{2}) (?<day> \d|\d{2}) (?<time>\d{2}:\d{2}:\d{2}) (?<year>\d{4})$/,
];
const HTTP_MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
const HTTP_WEEKDAYS = 'Sun Mon Tue Wed Thu Fri Sat'.split(' ');

function parseHttpDate(value, now) {
  const parts = HTTP_DATE_PATTERNS.map(pattern => pattern.exec(value)?.groups).find(Boolean);
  if (!parts) return null;
  const month = HTTP_MONTHS.indexOf(parts.month);
  const day = Number(parts.day);
  const [hour, minute, second] = parts.time.split(':').map(Number);
  if (month < 0 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60
    || (second === 60 && (hour !== 23 || minute !== 59))) return null;

  const date = new Date(0);
  const leapSecondMs = second === 60 ? 1000 : 0;
  date.setUTCHours(hour, minute, Math.min(second, 59));
  let year = Number(parts.year);
  if (parts.year.length === 2) {
    // RFC 9110: use the most recent matching year no more than 50 years ahead.
    const cutoff = new Date(now);
    const cutoffYear = cutoff.getUTCFullYear() + 50;
    cutoff.setUTCFullYear(cutoffYear);
    year += Math.floor(cutoffYear / 100) * 100;
    if (date.setUTCFullYear(year, month, day) + leapSecondMs > cutoff.getTime()) year -= 100;
  }
  date.setUTCFullYear(year, month, day);
  // UTC setters normalize impossible dates; don't accept a rolled-over day.
  if (date.getUTCMonth() !== month || date.getUTCDate() !== day
    || HTTP_WEEKDAYS[date.getUTCDay()] !== parts.weekday.slice(0, 3)) return null;
  return date.getTime() + leapSecondMs;
}

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
 * @param {string | number | null | undefined} headerValue
 * @returns {number | null} milliseconds to wait, or null
 */
export function parseRetryAfterMs(headerValue) {
  if (typeof headerValue !== 'string' && typeof headerValue !== 'number') return null;
  const trimmed = String(headerValue).trim();
  if (!trimmed) return null;
  // Some providers use fractional seconds, although HTTP specifies integers.
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const delay = Math.round(Number(trimmed) * 1000);
    return Number.isFinite(delay) && delay > 0 ? delay : null;
  }
  const now = Date.now();
  const ts = parseHttpDate(trimmed, now);
  return ts !== null && ts > now ? ts - now : null;
}

/**
 * Read the `retry-after` header case-insensitively from a fetch Response or
 * a provider event with JSON headers.
 *
 * @param {Response | { headers?: Record<string, string|number> | Headers } | null | undefined} response
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
function extractFetchErrorCode(err) {
  let current = err;
  const seen = new Set();
  let fallbackName = null;
  for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth++) {
    if (seen.has(current)) break;
    seen.add(current);
    if (typeof current.code === 'string' && current.code) return current.code;
    if (!fallbackName && (current.name === 'BodyTimeoutError' || current.name === 'HeadersTimeoutError')) {
      fallbackName = current.name;
    }
    current = current.cause;
  }
  return fallbackName;
}

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
    || err instanceof LLMRequestTooLargeError
    || err instanceof LLMServerError
    || err instanceof LLMAbortError) {
    return err;
  }
  const code = extractFetchErrorCode(err);
  if (code === 'UND_ERR_BODY_TIMEOUT' || code === 'BodyTimeoutError') {
    return new LLMStreamIdleTimeoutError(`${label}stream body timeout (${code}): ${err.message}`, 0);
  }
  if (code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'HeadersTimeoutError') {
    return new LLMHeadersTimeoutError(false);
  }
  const transientCodes = new Set([
    'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT',
    'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
    'UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'UND_ERR_CONNECT_TIMEOUT',
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
 * what the model saw. Full payloads therefore stay in the Agent's bounded,
 * file-backed debug trace and are fetched for one Turn on demand; live browser
 * events carry summary metadata only.
 *
 * @param {{ url: string, method: string, headers: object, body: any }} req
 * @returns {{ url: string, method: string, headers: object, body: any }}
 */

export function createBoundedTextAccumulator(maxBytes = 512 * 1024) {
  const limit = Number.isFinite(Number(maxBytes)) ? Math.max(0, Math.floor(Number(maxBytes))) : 512 * 1024;
  const chunks = [];
  let retainedBytes = 0;
  let totalBytes = 0;
  let truncated = false;
  return {
    push(value) {
      const text = String(value ?? '');
      const bytes = Buffer.byteLength(text, 'utf8');
      totalBytes += bytes;
      if (retainedBytes >= limit || bytes === 0) {
        if (bytes > 0) truncated = true;
        return;
      }
      const available = limit - retainedBytes;
      if (bytes <= available) {
        chunks.push(text);
        retainedBytes += bytes;
        return;
      }
      // Walk UTF-16 code points once. The old slice(0, -1) loop repeatedly
      // rescanned an oversized SSE chunk and went quadratic in its length.
      const retained = utf8PrefixWithinBytes(text, available);
      if (retained.text) chunks.push(retained.text);
      retainedBytes += retained.bytes;
      truncated = true;
    },
    text() { return chunks.join(''); },
    get totalBytes() { return totalBytes; },
    get truncated() { return truncated; },
    get maxBytes() { return limit; },
  };
}

export function redactRawRequest(req) {
  if (!req || typeof req !== 'object') return req;
  const headers = { ...(req.headers || {}) };
  // Common auth headers
  for (const k of Object.keys(headers)) {
    const lower = k.toLowerCase();
    if (lower === 'x-api-key' || lower === 'authorization' || lower === 'api-key' || lower === 'x-goog-api-key') {
      headers[k] = '***';
    }
  }
  return { url: req.url, method: req.method, headers, body: req.body };
}

/**
 * Return a wire-safe copy of a JSON-compatible value.
 *
 * JavaScript strings may contain lone UTF-16 surrogates. JSON.stringify keeps
 * them as `\\ud800`-style escapes, but strict API servers reject them because
 * they cannot represent Unicode scalar values in UTF-8. Replace only malformed
 * code units with U+FFFD; valid surrogate pairs (including emoji) are kept.
 *
 * @param {any} value
 * @returns {any}
 */
export function toWellFormedJson(value) {
  // Let the native serializer retain its complete semantics first: toJSON,
  // boxed primitives, non-finite numbers, array holes, and omitted values.
  const serialized = JSON.stringify(value, (_key, child) => {
    if (typeof child === 'string') return child.toWellFormed();
    // JSON.stringify invokes the replacer before unboxing String objects.
    // String#valueOf checks the real [[StringData]] internal slot across realms;
    // unlike instanceof or Object#toString, it cannot be spoofed by a caller.
    if (child && typeof child === 'object') {
      try {
        return String.prototype.valueOf.call(child).toWellFormed();
      } catch (err) {
        if (!(err instanceof TypeError)) throw err;
      }
    }
    return child;
  });
  if (serialized === undefined) return undefined;

  // The replacer cannot rename object keys. Rebuild only the already-serialized
  // plain JSON tree so malformed keys are fixed too. Null-prototype containers
  // keep an own "__proto__" key as data rather than invoking the legacy setter.
  const normalizeKeys = child => {
    if (Array.isArray(child)) return child.map(normalizeKeys);
    if (!child || typeof child !== 'object') return child;
    const out = Object.create(null);
    for (const [key, nested] of Object.entries(child)) {
      Object.defineProperty(out, key.toWellFormed(), {
        value: normalizeKeys(nested),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return out;
  };
  return normalizeKeys(JSON.parse(serialized));
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
   * @param {{ model: string, system: string, messages: UnifiedMessage[], tools?: UnifiedToolDef[], maxTokens?: number, contextOutputLimit?: number, signal?: AbortSignal }} params
   * @returns {AsyncGenerator<StreamEvent>}
   */
  async *stream(params) { // eslint-disable-line no-unused-vars
    throw new Error('stream() must be implemented by subclass');
  }

  /**
   * Capture a stream request before a caller crosses an async boundary.
   *
   * Implementations with mutable runtime routing should override this to freeze
   * their dispatch table at capture time. The base implementation retains
   * compatibility with legacy adapters by calling stream() without advancing
   * its async iterator.
   *
   * @param {object} params
   * @returns {AsyncGenerator<StreamEvent>}
   */
  captureStream(params) {
    return this.stream(params);
  }

  /**
   * Make a single model call without tools (for side queries like summarization).
   *
   * @param {{ model: string, system: string, messages: UnifiedMessage[], maxTokens?: number, contextOutputLimit?: number, signal?: AbortSignal }} params
   * @returns {Promise<{ text: string, stopReason?: 'end_turn'|'tool_use'|'max_tokens', usage: { inputTokens: number, outputTokens: number } }>}
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

  if (adapter === 'gemini') {
    if (!config.apiKey) throw new Error('Gemini adapter requires YEAFT_API_KEY');
    const { GeminiAdapter } = await import('./gemini.js');
    return new GeminiAdapter({
      apiKey: config.apiKey, baseUrl: config.baseUrl || undefined,
      headers: config.headers,
      streamIdleTimeoutMs: config.llmRetry?.streamIdleTimeoutMs,
      highEffortStreamIdleTimeoutMs: config.llmRetry?.highEffortStreamIdleTimeoutMs,
    });
  }

  if (adapter === 'anthropic' || (!adapter && config.apiKey)) {
    if (!config.apiKey) {
      throw new Error('Anthropic adapter requires YEAFT_API_KEY');
    }
    const { AnthropicAdapter } = await import('./anthropic.js');
    return new AnthropicAdapter({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl || undefined, // AnthropicAdapter has its own default
      streamIdleTimeoutMs: config.llmRetry?.streamIdleTimeoutMs,
      highEffortStreamIdleTimeoutMs: config.llmRetry?.highEffortStreamIdleTimeoutMs,
    });
  }

  if (adapter === 'openai-chat-completions' || adapter === 'chat-completions') {
    const { OpenAIChatCompletionsAdapter } = await import('./openai-chat-completions.js');
    return new OpenAIChatCompletionsAdapter({
      apiKey: config.apiKey || config.openaiApiKey || '',
      baseUrl: config.baseUrl || config.proxyUrl || undefined,
      headers: config.headers,
      streamIdleTimeoutMs: config.llmRetry?.streamIdleTimeoutMs,
      highEffortStreamIdleTimeoutMs: config.llmRetry?.highEffortStreamIdleTimeoutMs,
    });
  }

  if (adapter === 'openai-responses') {
    const { OpenAIResponsesAdapter } = await import('./openai-responses.js');
    return new OpenAIResponsesAdapter({
      apiKey: config.apiKey || config.openaiApiKey || '',
      baseUrl: config.baseUrl || config.proxyUrl || undefined,
      streamIdleTimeoutMs: config.llmRetry?.streamIdleTimeoutMs,
      highEffortStreamIdleTimeoutMs: config.llmRetry?.highEffortStreamIdleTimeoutMs,
    });
  }

  if (
    adapter === 'openai' ||
    adapter === 'proxy' ||
    (!adapter && (config.openaiApiKey || config.proxyUrl))
  ) {
    throw new Error(
      'Legacy "openai"/"proxy" env-var adapters are unsupported. ' +
      'Configure providers via ~/.yeaft/config.json with protocol: "openai-chat-completions", ' +
      '"openai-responses", "anthropic", or "gemini".'
    );
  }

  throw new Error(
    'No LLM adapter configured. Set YEAFT_API_KEY (Anthropic) or configure ' +
    'providers in ~/.yeaft/config.json with protocol: "openai-chat-completions", ' +
    '"openai-responses", "anthropic", or "gemini".',
  );
}
