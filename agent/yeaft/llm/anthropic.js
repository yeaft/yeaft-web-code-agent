/**
 * anthropic.js — Anthropic Messages API adapter
 *
 * POST /v1/messages with SSE streaming.
 * tool_use.input is already a parsed object (no JSON.parse needed).
 * Tool definitions use `input_schema` (not `parameters`).
 */

import {
  LLMAdapter,
  LLMRateLimitError,
  classifyFetchError,
  retryAfterFromResponse,
  LLMAuthError,
  classifyAuthError,
  classifyPolicyError,
  LLMContextError,
  LLMServerError,
  LLMAbortError,
  readStreamChunkWithIdleTimeout,
  redactRawRequest,
  safeHeaders,
  SseLineBuffer,
  createBoundedTextAccumulator,
  toWellFormedJson,
} from './adapter.js';
import { enforceSubAgentEffortPayload, captureEffortDecision } from '../effort.js';
import {
  normalizeEffort,
  thinkingBudgetForEffort,
  getThinkingCapability,
  getModelEffortOptions,
} from '../models.js';

/**
 * task-327a: feature-flag accessor. thinkingV1 is OFF by default; set
 * env YEAFT_THINKING_V1=1 to enable. Read lazily so tests can flip.
 */
function thinkingV1Enabled() {
  return process.env.YEAFT_THINKING_V1 === '1';
}

function applyAnthropicThinking(body, model, effort, effortContext = {}) {
  const cap = getThinkingCapability(model, effortContext);
  if (!cap.supportsThinking) return;
  if (!getModelEffortOptions(model, effortContext).includes(effort)) return;

  if (cap.thinkingProtocol === 'anthropic-adaptive') {
    body.thinking = { type: 'adaptive' };
    body.output_config = { ...(body.output_config || {}), effort };
    return;
  }

  if (cap.thinkingProtocol === 'anthropic') {
    const budget = thinkingBudgetForEffort(model, effort);
    if (budget && budget > 0) {
      // Anthropic manual thinking requires max_tokens > budget_tokens.
      const minMax = budget + 1024;
      if (body.max_tokens < minMax) body.max_tokens = minMax;
      body.thinking = { type: 'enabled', budget_tokens: budget };
    }
  }
}

import { ProviderStateError, createProviderContext, createProviderState, replayProviderState, providerStateBytes, applyAnthropicCaching, reasoningUsage } from './provider-state.js';

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';

function hasNonEmptyText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function translateUserContent(content) {
  if (hasNonEmptyText(content)) return content;

  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (!part || typeof part !== 'object') {
        if (hasNonEmptyText(part)) parts.push({ type: 'text', text: String(part) });
        continue;
      }
      if (part.type === 'text') {
        if (hasNonEmptyText(part.text)) parts.push(part);
        continue;
      }
      // Non-text blocks (image/document/tool_result-like compatible payloads)
      // are meaningful even without a text field. Preserve them verbatim.
      parts.push(part);
    }
    return parts.length > 0 ? parts : null;
  }

  return null;
}

/**
 * AnthropicAdapter — Talks to Anthropic Messages API.
 */
export class AnthropicAdapter extends LLMAdapter {
  #apiKey;
  #baseUrl;
  #authHeaderMode;
  #streamIdleTimeoutMs;

  /**
   * @param {{ apiKey: string, baseUrl?: string, authHeaderMode?: 'x-api-key'|'bearer', streamIdleTimeoutMs?: number }} config
   */
  constructor({ apiKey, baseUrl = DEFAULT_BASE_URL, authHeaderMode = 'x-api-key', streamIdleTimeoutMs = 0 }) {
    super({ apiKey, baseUrl, streamIdleTimeoutMs });
    this.#apiKey = apiKey;
    this.#baseUrl = baseUrl;
    this.#authHeaderMode = authHeaderMode === 'bearer' ? 'bearer' : 'x-api-key';
    this.#streamIdleTimeoutMs = Number.isFinite(streamIdleTimeoutMs) ? Math.max(0, Math.floor(streamIdleTimeoutMs)) : 0;
  }

  #headers() {
    const headers = {
      'Content-Type': 'application/json',
      'anthropic-version': API_VERSION,
    };
    if (this.#authHeaderMode === 'bearer') {
      headers.Authorization = `Bearer ${this.#apiKey}`;
    } else {
      headers['x-api-key'] = this.#apiKey;
    }
    return headers;
  }

  /**
   * Translate UnifiedToolDef[] → Anthropic tool format.
   * @param {import('./adapter.js').UnifiedToolDef[]} tools
   * @returns {object[]}
   */
  #translateTools(tools) {
    if (!tools || tools.length === 0) return undefined;
    return tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }

  /**
   * Translate UnifiedMessage[] → Anthropic message format.
   * @param {import('./adapter.js').UnifiedMessage[]} messages
   * @returns {object[]}
   */
  #translateMessages(messages, context, identity) {
    const result = [];
    for (const msg of messages) {
      if (msg.role === 'system') continue; // system goes separately
      if (msg.role === 'user') {
        const content = translateUserContent(msg.content);
        if (content) result.push({ role: 'user', content });
      } else if (msg.role === 'assistant') {
        const native = replayProviderState(msg, context, identity);
        if (native) { result.push({ role: 'assistant', content: native }); continue; }
        const content = [];
        // Legacy records remain readable, but have no trustworthy wire origin.
        // Never replay their signatures into an arbitrary current account/model.
        if (!msg.providerState && msg.thinkingBlocks?.length && msg.toolCalls?.length) {
          throw new ProviderStateError('legacy signed tool history has no origin; start a new context');
        }
        if (hasNonEmptyText(msg.content)) {
          content.push({ type: 'text', text: msg.content });
        }
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: tc.input,
            });
          }
        }
        if (content.length > 0) result.push({ role: 'assistant', content });
      } else if (msg.role === 'tool') {
        // Anthropic requires all tool_results from the same turn in a single
        // user message. Merge consecutive tool messages into one.
        const toolResult = {
          type: 'tool_result',
          tool_use_id: msg.toolCallId,
          content: msg.content,
          is_error: msg.isError || false,
        };
        const prev = result[result.length - 1];
        if (prev && prev.role === 'user' && Array.isArray(prev.content) &&
            prev.content.length > 0 && prev.content[0].type === 'tool_result') {
          // Append to existing tool_result user message
          prev.content.push(toolResult);
        } else {
          result.push({
            role: 'user',
            content: [toolResult],
          });
        }
      }
    }
    return result;
  }

  /**
   * Classify HTTP errors into our typed errors.
   * @param {number} status
   * @param {string} body
   * @param {Response | { headers?: Record<string, string> } | null} [response] -
   *   When provided, reads the `retry-after` header so the engine can honor
   *   the server hint instead of guessing a backoff delay.
   */
  #classifyError(status, body, response = null) {
    const authHint = `auth=${this.#authHeaderMode}`;
    if (status === 401 || status === 403) {
      return classifyAuthError(status, body);
    }
    if (status === 429) {
      const retryAfter = retryAfterFromResponse(response);
      return new LLMRateLimitError(`Anthropic rate limit (${authHint}): ${body}`, status, retryAfter);
    }
    if (status === 529) {
      const retryAfter = retryAfterFromResponse(response);
      return new LLMRateLimitError(`Anthropic overloaded (${authHint}): ${body}`, status, retryAfter);
    }
    const policyError = classifyPolicyError(status, body);
    if (policyError) return policyError;
    if (body.includes('prompt is too long') || body.includes('max_tokens')) {
      return new LLMContextError(`Anthropic context error (${authHint}): ${body}`);
    }
    if (status >= 500) {
      return new LLMServerError(`Anthropic server error (${authHint}): ${body}`, status);
    }
    return new Error(`Anthropic API error ${status} (${authHint}): ${body}`);
  }

  /**
   * @param {{ model: string, system: string, messages: import('./adapter.js').UnifiedMessage[], tools?: import('./adapter.js').UnifiedToolDef[], maxTokens?: number, effort?: 'low'|'medium'|'high'|'xhigh'|'max', effortSource?: 'user'|'auto', effortContext?: object, signal?: AbortSignal, onRawExchange?: ({rawRequest, rawResponse}) => void }} params
   * @returns {AsyncGenerator<import('./adapter.js').StreamEvent>}
   */
  async *stream({ model, system, messages, tools, maxTokens = 16384, effort, effortSource, effortContext, extraBody, providerContext, requestIdentity, onProviderDiagnostics, effortConstraint = null, onEffortDecision = null, signal, onRawExchange, rawExchangeMaxBytes = 512 * 1024, onRequestStart }) {
    if (signal?.aborted) throw new LLMAbortError();

    const context = providerContext || createProviderContext({ protocol: 'anthropic', baseUrl: this.#baseUrl, model });
    const translatedMessages = this.#translateMessages(messages, context, requestIdentity);
    const body = {
      model,
      max_tokens: maxTokens,
      system,
      messages: translatedMessages,
      stream: true,
    };

    // Inject Anthropic thinking only for model-supported effort values.
    // Adaptive Claude 4.7/4.8 uses output_config.effort; older manual-thinking
    // models use budget_tokens. Unsupported combinations silently drop effort.
    const normEffort = normalizeEffort(effort);
    if ((thinkingV1Enabled() || effortSource === 'user') && normEffort) {
      applyAnthropicThinking(body, model, normEffort, effortContext);
    }

    const translatedTools = this.#translateTools(tools);
    if (translatedTools) body.tools = translatedTools;
    if (extraBody) Object.assign(body, extraBody);
    body.model = model; // Do not let extraBody bypass origin/model ownership.
    body.messages = translatedMessages;
    body.system = system;
    applyAnthropicCaching(body, context, onProviderDiagnostics);
    const effortDecision = effortConstraint
      ? enforceSubAgentEffortPayload(body, { model, protocol: 'anthropic', effortContext, effortConstraint })
      : captureEffortDecision({ body, model, protocol: 'anthropic', effortContext, requested: effort, source: effortSource || 'scenario' });
    onEffortDecision?.(effortDecision);
    const wireBody = toWellFormedJson(body);

    const url = `${this.#baseUrl}/v1/messages`;
    const headers = this.#headers();

    // Expose the raw request (auth-redacted) for the debug panel. The body
    // is captured verbatim — never truncated — so "copy request" matches
    // exactly what we POST to the LLM.
    const rawRequest = redactRawRequest({ url, method: 'POST', headers, body: wireBody });

    let response;
    try {
      onRequestStart?.();
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(wireBody),
        signal,
      });
    } catch (err) {
      throw classifyFetchError(err, { providerLabel: 'Anthropic', signal });
    }

    if (!response.ok) {
      const errorBody = await response.text();
      // Capture error response too, then throw.
      if (onRawExchange) {
        try {
          onRawExchange({
            rawRequest,
            rawResponse: {
              status: response.status,
              headers: safeHeaders(response),
              body: errorBody,
            },
          });
        } catch { /* ignore */ }
      }
      throw this.#classifyError(response.status, errorBody, response);
    }

    // Some native-compatible gateways return a complete JSON response even
    // when streaming was requested. Seal exactly the same native blocks.
    if ((response.headers?.get('content-type') || '').includes('application/json')) {
      const result = await response.json();
      const state = createProviderState({ context, identity: requestIdentity, items: result.content, responseId: result.id });
      for (const block of result.content || []) {
        if (block.type === 'text') yield { type: 'text_delta', text: block.text };
        if (block.type === 'tool_use') yield { type: 'tool_call', id: block.id, name: block.name, input: block.input };
        if (block.type === 'thinking') yield { type: 'thinking_block_end', thinking: block.thinking, signature: block.signature };
        if (block.type === 'redacted_thinking') yield { type: 'thinking_block_end', redacted: true, data: block.data };
      }
      if (state) yield { type: 'provider_state', providerState: state, providerStateBytes: providerStateBytes(state) };
      yield { type: 'usage', inputTokens: result.usage?.input_tokens || 0, outputTokens: result.usage?.output_tokens || 0,
        cacheReadTokens: result.usage?.cache_read_input_tokens || 0, cacheWriteTokens: result.usage?.cache_creation_input_tokens || 0,
        ...reasoningUsage(result.usage, 'anthropic') };
      yield { type: 'stop', stopReason: this.#mapStopReason(result.stop_reason) };
      if (onRawExchange) {
        try { onRawExchange({ rawRequest, rawResponse: { status: response.status, headers: safeHeaders(response), body: result } }); } catch { /* diagnostic only */ }
      }
      return;
    }

    // Parse SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    // Incremental O(n) line splitter (see SseLineBuffer): the old
    // `buffer += chunk; buffer.split('\n')` pattern went quadratic on a
    // multi-MiB un-terminated line and froze the event loop long enough to
    // starve the WS heartbeat. The buffer also caps a single newline-less
    // line and throws a retryable error on a malformed stream.
    const sseLines = new SseLineBuffer();
    // task-327d: index-keyed per-block state. Anthropic streams content
    // blocks sequentially today, but the protocol exposes `event.index`
    // precisely because that's not guaranteed. Dispatch in
    // content_block_stop must look up by index, never "whichever scalar
    // happens to still be set." States by kind: 'tool_use', 'thinking',
    // 'redacted_thinking'. Redacted blocks carry opaque `data` instead
    // of `thinking` text but share the same echo-back rule (drop without
    // signature → next turn 400s identically).
    /** @type {Map<number, { kind: string, [k: string]: any }>} */
    const blockByIndex = new Map();
    const completedBlocks = new Map();
    let responseId;
    let stateFailed = false;
    let cumulativeReasoningTokens = 0;
    // Keep raw SSE chunks only until the engine receives the bounded exchange
    // callback. The engine owns the configured byte budget; the adapter avoids
    // quadratic string concatenation by storing chunks separately.
    const rawSseBody = createBoundedTextAccumulator(rawExchangeMaxBytes);
    const responseHeaders = safeHeaders(response);
    const responseStatus = response.status;
    let sawStop = false;
    let sawMessageStart = false;
    let cumulativeOutputTokens = 0;

    try {
      while (true) {
        const { done, value } = await readStreamChunkWithIdleTimeout(reader, {
          signal,
          idleMs: this.#streamIdleTimeoutMs,
          providerLabel: 'Anthropic',
        });
        if (done) break;

        const chunkText = decoder.decode(value, { stream: true });
        rawSseBody.push(chunkText);
        const lines = sseLines.push(chunkText);

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            sawStop = true;
            continue;
          }

          let event;
          try {
            event = JSON.parse(data);
          } catch {
            continue;
          }

          const type = event.type;

          if (type === 'content_block_start') {
            const block = event.content_block;
            const idx = event.index;
            if (block?.type === 'text') {
              blockByIndex.set(idx, { kind: 'text', text: block.text || '', native: block });
              if (block.text) yield { type: 'text_delta', text: block.text };
            } else if (block?.type === 'tool_use') {
              blockByIndex.set(idx, {
                kind: 'tool_use',
                native: block,
                id: block.id,
                name: block.name,
                input: '',
              });
            } else if (block?.type === 'thinking') {
              blockByIndex.set(idx, {
                kind: 'thinking',
                native: block,
                thinking: typeof block.thinking === 'string' ? block.thinking : '',
                signature: typeof block.signature === 'string' ? block.signature : '',
              });
            } else if (block?.type === 'redacted_thinking') {
              // task-327d: API-redacted thinking. Body is opaque `data`
              // (server-encrypted, not user-readable); we still need to
              // echo it back with signature on the next turn or the API
              // 400s with the same "must be passed back" error.
              blockByIndex.set(idx, {
                kind: 'redacted_thinking',
                native: block,
                data: typeof block.data === 'string' ? block.data : '',
                signature: typeof block.signature === 'string' ? block.signature : '',
              });
            }
          } else if (type === 'content_block_delta') {
            const delta = event.delta;
            const idx = event.index;
            const st = blockByIndex.get(idx);
            if (delta?.type === 'text_delta') {
              if (st?.kind === 'text') st.text += delta.text || '';
              yield { type: 'text_delta', text: delta.text };
            } else if (delta?.type === 'thinking_delta') {
              // Forward delta for live UI; ALSO accumulate for round-trip.
              if (st && st.kind === 'thinking') st.thinking += delta.thinking || '';
              yield { type: 'thinking_delta', text: delta.thinking };
            } else if (delta?.type === 'signature_delta') {
              // Anthropic typically sends signature in one delta near the
              // end of the (redacted_)thinking block. Accumulate defensively.
              if (st && (st.kind === 'thinking' || st.kind === 'redacted_thinking')) {
                st.signature += delta.signature || '';
              }
            } else if (delta?.type === 'input_json_delta') {
              if (st && st.kind === 'tool_use') st.input += delta.partial_json;
            }
          } else if (type === 'content_block_stop') {
            const idx = event.index;
            const st = blockByIndex.get(idx);
            if (!st) {
              // Unknown / unhandled block kind (e.g. text — we don't track
              // text state because text_delta is forwarded immediately).
            } else if (st.kind === 'tool_use') {
              let parsedInput = {};
              try {
                parsedInput = st.input ? JSON.parse(st.input) : st.native.input || {};
              } catch {
                parsedInput = {};
                stateFailed = true;
              }
              completedBlocks.set(idx, { ...st.native, input: parsedInput });
              yield {
                type: 'tool_call',
                id: st.id,
                name: st.name,
                input: parsedInput,
              };
            } else if (st.kind === 'thinking' || st.kind === 'redacted_thinking') {
              // task-327d: emit ONE end-of-block event with the assembled
              // payload + signature. Engine collects these for replay.
              // We emit even when signature is empty so engine can
              // warn-and-drop; replaying without signature would 400.
              if (st.kind === 'thinking') {
                yield {
                  type: 'thinking_block_end',
                  thinking: st.thinking,
                  signature: st.signature,
                };
              } else {
                yield {
                  type: 'thinking_block_end',
                  redacted: true,
                  data: st.data,
                  signature: st.signature,
                };
              }
            }
            if (st?.kind === 'text') completedBlocks.set(idx, { ...st.native, text: st.text });
            if (st?.kind === 'thinking') completedBlocks.set(idx, { ...st.native, thinking: st.thinking, signature: st.signature });
            if (st?.kind === 'redacted_thinking') completedBlocks.set(idx, { type: 'redacted_thinking', data: st.data });
            blockByIndex.delete(idx);
          } else if (type === 'message_delta') {
            const stopReason = event.delta?.stop_reason;
            if (stopReason) {
              // Only message_stop seals native state. EOF after message_delta
              // must not silently complete a signed tool turn without its state.
              yield {
                type: 'stop',
                stopReason: this.#mapStopReason(stopReason),
              };
            }
            // Anthropic message_delta usage is cumulative across the response.
            // Expose only the newly consumed output tokens so shared accounting
            // can safely add events from message_start and multiple deltas.
            if (event.usage) {
              const nextOutputTokens = Math.max(0, Number(event.usage.output_tokens) || 0);
              const outputTokens = Math.max(0, nextOutputTokens - cumulativeOutputTokens);
              cumulativeOutputTokens = Math.max(cumulativeOutputTokens, nextOutputTokens);
              const reasoning = reasoningUsage(event.usage, 'anthropic');
              if (reasoning.reasoningTokens !== undefined) {
                const next = reasoning.reasoningTokens;
                reasoning.reasoningTokens = Math.max(0, next - cumulativeReasoningTokens);
                cumulativeReasoningTokens = Math.max(cumulativeReasoningTokens, next);
              }
              yield {
                type: 'usage',
                ...reasoning,
                inputTokens: 0, // Only in message_start
                outputTokens,
              };
            }
          } else if (type === 'message_stop') {
            sawStop = true;
            if (!stateFailed && blockByIndex.size === 0) {
              const state = createProviderState({ context, identity: requestIdentity, responseId,
                items: [...completedBlocks].sort(([a], [b]) => a - b).map(([, block]) => block) });
              if (state) yield { type: 'provider_state', providerState: state, providerStateBytes: providerStateBytes(state) };
            }
          } else if (type === 'message_start') {
            sawMessageStart = true;
            responseId = event.message?.id;
            // Usage from message_start
            if (event.message?.usage) {
              cumulativeOutputTokens = Math.max(
                cumulativeOutputTokens,
                Math.max(0, Number(event.message.usage.output_tokens) || 0),
              );
              const reasoning = reasoningUsage(event.message.usage, 'anthropic');
              cumulativeReasoningTokens = reasoning.reasoningTokens || 0;
              yield {
                type: 'usage',
                ...reasoning,
                inputTokens: event.message.usage.input_tokens || 0,
                outputTokens: cumulativeOutputTokens,
                cacheReadTokens: event.message.usage.cache_read_input_tokens || 0,
                cacheWriteTokens: event.message.usage.cache_creation_input_tokens || 0,
              };
            }
          } else if (type === 'error') {
            stateFailed = true;
            yield {
              type: 'error',
              error: new Error(event.error?.message || 'Unknown streaming error'),
              retryable: event.error?.type === 'overloaded_error',
            };
          }
        }
      }
      if (sawMessageStart && !sawStop) {
        throw new LLMServerError('Anthropic stream ended before stop event', 0);
      }
    } catch (err) {
      throw classifyFetchError(err, { providerLabel: 'Anthropic', signal });
    } finally {
      reader.releaseLock();
      // Emit raw exchange after stream completes (or errors). Body is the
      // verbatim SSE — never truncated.
      if (onRawExchange) {
        try {
          onRawExchange({
            rawRequest,
            rawResponse: {
              status: responseStatus,
              headers: responseHeaders,
              body: rawSseBody.text(),
              format: 'sse',
              truncated: rawSseBody.truncated,
              originalBytes: rawSseBody.totalBytes,
              maxBytes: rawSseBody.maxBytes,
            },
          });
        } catch { /* ignore */ }
      }
    }
  }

  /**
   * Non-streaming call for side queries.
   *
   * task-327c: accepts `effort` for internal scenario-tagged calls
   * (dream/recall/light). Guards mirror stream() — unsupported
   * models silently drop the param. max_tokens auto-widens to budget+1024
   * when needed.
   */
  async call({ model, system, messages, maxTokens = 4096, effort, effortSource, effortContext, extraBody, providerContext, requestIdentity, onProviderDiagnostics, effortConstraint = null, onEffortDecision = null, signal, onRequestStart }) {
    if (signal?.aborted) throw new LLMAbortError();

    const context = providerContext || createProviderContext({ protocol: 'anthropic', baseUrl: this.#baseUrl, model });
    const translatedMessages = this.#translateMessages(messages, context, requestIdentity);
    const body = {
      model,
      max_tokens: maxTokens,
      system,
      messages: translatedMessages,
    };

    // task-327c: mirror stream()'s thinking injection for side queries.
    const normEffort = normalizeEffort(effort);
    if ((thinkingV1Enabled() || effortSource === 'user') && normEffort) {
      applyAnthropicThinking(body, model, normEffort, effortContext);
    }
    if (extraBody) Object.assign(body, extraBody);
    body.model = model; // Do not let extraBody bypass origin/model ownership.
    body.messages = translatedMessages;
    body.system = system;
    applyAnthropicCaching(body, context, onProviderDiagnostics);
    const effortDecision = effortConstraint
      ? enforceSubAgentEffortPayload(body, { model, protocol: 'anthropic', effortContext, effortConstraint })
      : captureEffortDecision({ body, model, protocol: 'anthropic', effortContext, requested: effort, source: effortSource || 'scenario' });
    onEffortDecision?.(effortDecision);
    const wireBody = toWellFormedJson(body);

    let response;
    try {
      onRequestStart?.();
      response = await fetch(`${this.#baseUrl}/v1/messages`, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify(wireBody),
        signal,
      });
    } catch (err) {
      throw classifyFetchError(err, { providerLabel: 'Anthropic', signal });
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw this.#classifyError(response.status, errorBody, response);
    }

    const result = await response.json();
    const text = result.content
      ?.filter(b => b.type === 'text')
      .map(b => b.text)
      .join('') || '';

    return {
      text,
      providerState: createProviderState({ context, identity: requestIdentity, items: result.content, responseId: result.id }),
      stopReason: this.#mapStopReason(result.stop_reason),
      usage: {
        ...reasoningUsage(result.usage, 'anthropic'),
        inputTokens: result.usage?.input_tokens || 0,
        outputTokens: result.usage?.output_tokens || 0,
        cacheReadTokens: result.usage?.cache_read_input_tokens || 0,
        cacheWriteTokens: result.usage?.cache_creation_input_tokens || 0,
      },
    };
  }

  /**
   * Map Anthropic stop_reason to unified format.
   * @param {string} reason
   * @returns {'end_turn' | 'tool_use' | 'max_tokens'}
   */
  #mapStopReason(reason) {
    switch (reason) {
      case 'end_turn': return 'end_turn';
      case 'tool_use': return 'tool_use';
      case 'max_tokens': return 'max_tokens';
      default: return 'end_turn';
    }
  }
}
