/**
 * openai-responses.js — OpenAI Responses API adapter (/v1/responses)
 *
 * Next-gen OpenAI API recommended for GPT-5+. Differences from Chat Completions:
 *   - Endpoint: /v1/responses instead of /v1/chat/completions
 *   - Input: `input[]` array of typed items (message / function_call / function_call_output)
 *     instead of `messages[]` with role/content
 *   - System prompt: passed as `instructions` field (not as a message)
 *   - Content parts: `input_text` / `input_image` (image_url string) / `output_text`
 *   - Tool definitions: flat `{type:"function", name, description, parameters}`
 *     (no nested `function` object)
 *   - Tool call id: uses `call_id` (separate from the internal item `id`)
 *   - Stream: semantic SSE events
 *     - response.created
 *     - response.output_item.added
 *     - response.output_text.delta
 *     - response.function_call_arguments.delta / .done
 *     - response.completed  (contains final response.usage)
 *     - response.incomplete (e.g. max_output_tokens)
 *     - response.error
 *   - Usage: only in terminal completed/incomplete events
 *
 * Id contract (agreed with PM):
 *   - Responses `function_call.call_id` ← → internal UnifiedToolCall.id (direct passthrough)
 *   - tool_result.toolCallId ← → function_call_output.call_id (direct passthrough)
 */

import {
  LLMAdapter,
  LLMRateLimitError,
  LLMAuthError,
  LLMContextError,
  LLMServerError,
  LLMAbortError,
  redactRawRequest,
  safeHeaders,
} from './adapter.js';
import {
  normalizeEffort,
  getThinkingCapability,
} from '../models.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/**
 * Feature-flag accessor mirroring anthropic.js. YEAFT_THINKING_V1 is OFF by
 * default; set env to '1' to enable thinking-mode field translation. Read
 * lazily so tests can flip the flag between calls.
 */
function thinkingV1Enabled() {
  return process.env.YEAFT_THINKING_V1 === '1';
}

/**
 * Translate a normalised effort ('low'|'medium'|'high'|'max') into the value
 * accepted by the OpenAI Responses `reasoning.effort` field. Responses today
 * accepts 'low'|'medium'|'high' — 'max' degrades to 'high' to match the
 * registry's normaliseEffort downgrade rule.
 */
function effortForResponses(effort) {
  if (!effort) return null;
  if (effort === 'max') return 'high';
  return effort;
}

export class OpenAIResponsesAdapter extends LLMAdapter {
  #apiKey;
  #baseUrl;

  /**
   * @param {{ apiKey: string, baseUrl?: string }} config
   */
  constructor({ apiKey, baseUrl = DEFAULT_BASE_URL }) {
    super({ apiKey, baseUrl });
    this.#apiKey = apiKey;
    this.#baseUrl = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  /** Expose baseUrl for testing. */
  get baseUrl() { return this.#baseUrl; }

  // ─── Request translation ────────────────────────────────

  /**
   * Translate unified tool defs → Responses API tool format (flat).
   * @param {import('./adapter.js').UnifiedToolDef[]} tools
   */
  #translateTools(tools) {
    if (!tools || tools.length === 0) return undefined;
    return tools.map(t => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  /**
   * Translate a user message's content into Responses API content parts.
   * Accepts either a string or an array of parts (text / image).
   */
  #translateUserContent(content) {
    if (typeof content === 'string') {
      return [{ type: 'input_text', text: content }];
    }
    if (Array.isArray(content)) {
      return content.map(part => {
        if (!part || typeof part !== 'object') {
          return { type: 'input_text', text: String(part ?? '') };
        }
        if (part.type === 'text') {
          return { type: 'input_text', text: part.text || '' };
        }
        if (part.type === 'image') {
          // part.source may be { url } or { data, media_type } (base64).
          // We accept the legacy `mediaType` (camelCase) for backward
          // compatibility with any caller still on the pre-fix shape;
          // the canonical wire form is now `media_type` per Anthropic.
          const src = part.source || {};
          let imageUrl;
          if (src.url) {
            imageUrl = src.url;
          } else if (src.data) {
            const mt = src.media_type || src.mediaType || 'image/png';
            imageUrl = `data:${mt};base64,${src.data}`;
          } else {
            imageUrl = '';
          }
          return { type: 'input_image', image_url: imageUrl };
        }
        // Passthrough for already-shaped parts
        if (part.type === 'input_text' || part.type === 'input_image') return part;
        return { type: 'input_text', text: String(part.text || '') };
      });
    }
    return [{ type: 'input_text', text: String(content ?? '') }];
  }

  /**
   * Translate UnifiedMessage[] → Responses API `input[]` array.
   *
   * Message → { type:'message', role, content: parts[] }
   * Assistant tool_calls → separate { type:'function_call', call_id, name, arguments } items
   * Tool message → { type:'function_call_output', call_id, output }
   */
  #translateInput(messages) {
    const input = [];
    for (const msg of messages) {
      if (msg.role === 'system') {
        // System is handled as `instructions` at the top-level; skip here.
        continue;
      }
      if (msg.role === 'user') {
        input.push({
          type: 'message',
          role: 'user',
          content: this.#translateUserContent(msg.content),
        });
      } else if (msg.role === 'assistant') {
        // Emit a message item if there is text content
        if (msg.content && typeof msg.content === 'string' && msg.content.trim()) {
          input.push({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: msg.content }],
          });
        }
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          for (const tc of msg.toolCalls) {
            input.push({
              type: 'function_call',
              call_id: tc.id,
              name: tc.name,
              arguments: JSON.stringify(tc.input ?? {}),
            });
          }
        }
      } else if (msg.role === 'tool') {
        input.push({
          type: 'function_call_output',
          call_id: msg.toolCallId,
          output: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        });
      }
    }
    return input;
  }

  // ─── Error classification ───────────────────────────────

  #classifyError(status, body) {
    if (status === 401 || status === 403) {
      return new LLMAuthError(`Auth error: ${body}`, status);
    }
    if (status === 429) {
      return new LLMRateLimitError(`Rate limit: ${body}`, status);
    }
    if (status === 529) {
      return new LLMRateLimitError(`Overloaded: ${body}`, status);
    }
    if (status === 413 || body.includes('context_length_exceeded') || body.includes('maximum context length')) {
      return new LLMContextError(`Context too long: ${body}`);
    }
    if (status >= 500) {
      return new LLMServerError(`Server error: ${body}`, status);
    }
    return new Error(`API error ${status}: ${body}`);
  }

  // ─── Stop reason mapping ────────────────────────────────

  /**
   * Map a terminal response object to a unified stop reason.
   * @param {object} response — response.completed or response.incomplete payload
   * @param {boolean} sawToolCall
   */
  #mapStopReason(response, sawToolCall) {
    if (response?.status === 'incomplete') {
      const r = response.incomplete_details?.reason;
      if (r === 'max_output_tokens') return 'max_tokens';
      return 'end_turn';
    }
    if (sawToolCall) return 'tool_use';
    // Inspect the final output: if the last item is a function_call, it's tool_use
    const out = Array.isArray(response?.output) ? response.output : [];
    if (out.some(item => item?.type === 'function_call')) return 'tool_use';
    return 'end_turn';
  }


  /**
   * @param {{ model: string, system: string, messages: import('./adapter.js').UnifiedMessage[], tools?: import('./adapter.js').UnifiedToolDef[], maxTokens?: number, effort?: 'low'|'medium'|'high'|'max', effortSource?: 'user'|'auto', extraBody?: object, signal?: AbortSignal, onRawExchange?: ({rawRequest, rawResponse}) => void }} params
  async *stream({ model, system, messages, tools, maxTokens = 16384, effort, effortSource, extraBody, signal, onRawExchange }) {
    if ((thinkingV1Enabled() || effortSource === 'user') && normEffort) {
  async call({ model, system, messages, maxTokens = 4096, effort, effortSource, extraBody, signal }) {
    if ((thinkingV1Enabled() || effortSource === 'user') && normEffort) {
   */
  async *stream({ model, system, messages, tools, maxTokens = 16384, effort, extraBody, signal, onRawExchange }) {
    if (signal?.aborted) throw new LLMAbortError();

    const body = {
      model,
      input: this.#translateInput(messages),
      stream: true,
      max_output_tokens: maxTokens,
    };
    if (system) body.instructions = system;
    const translatedTools = this.#translateTools(tools);
    if (translatedTools) body.tools = translatedTools;

    // Inject Responses-API thinking-mode field. Mirrors anthropic.js gating:
    // feature flag must be on, effort must be a known value, and the model's
    // registry entry must declare thinkingProtocol === 'openai-reasoning'.
    // Unknown / unsupported models silently drop the field.
    const normEffort = normalizeEffort(effort);
    if (thinkingV1Enabled() && normEffort) {
      const cap = getThinkingCapability(model);
      if (cap.supportsThinking && cap.thinkingProtocol === 'openai-reasoning') {
        const wireEffort = effortForResponses(normEffort);
        if (wireEffort) body.reasoning = { effort: wireEffort };
      }
    }

    if (extraBody) Object.assign(body, extraBody);

    const url = `${this.#baseUrl}/responses`;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.#apiKey}`,
    };

    // Expose the raw request (auth-redacted) for the debug panel. See
    // `redactRawRequest` in adapter.js for the verbatim-design rationale.
    const rawRequest = redactRawRequest({ url, method: 'POST', headers, body });

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') throw new LLMAbortError();
      throw err;
    }

    if (!response.ok) {
      const errorBody = await response.text();
      // Capture error response too, then throw. Parity with anthropic.js.
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
      throw this.#classifyError(response.status, errorBody);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    /** Accumulate tool call arguments by output_index.
     *  Value: { callId, name, arguments } */
    const toolCallAccum = new Map();
    /** call_ids already emitted as tool_call events (to avoid duplicating on completed fallback). */
    const emittedToolCallIds = new Set();
    let sawToolCall = false;

    // Accumulate raw SSE body verbatim for the debug panel. No truncation:
    // see `redactRawRequest` in adapter.js for the verbatim-design rationale.
    // Push-then-join keeps allocation bounded for multi-MiB payloads (avoids
    // O(n²) string concat).
    const rawSseBodyChunks = [];
    const responseHeaders = safeHeaders(response);
    const responseStatus = response.status;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunkText = decoder.decode(value, { stream: true });
        buffer += chunkText;
        rawSseBodyChunks.push(chunkText);

        // SSE events are separated by blank lines; split on \n
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const rawLine of lines) {
          const line = rawLine.trimEnd();
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;

          let event;
          try {
            event = JSON.parse(data);
          } catch {
            continue;
          }

          const type = event.type;

          if (type === 'response.output_item.added') {
            const item = event.item;
            const idx = event.output_index;
            if (item?.type === 'function_call') {
              toolCallAccum.set(idx, {
                callId: item.call_id || item.id || '',
                name: item.name || '',
                arguments: '',
              });
            }
          } else if (type === 'response.output_text.delta') {
            if (typeof event.delta === 'string' && event.delta.length > 0) {
              yield { type: 'text_delta', text: event.delta };
            }
          } else if (type === 'response.function_call_arguments.delta') {
            const idx = event.output_index;
            const accum = toolCallAccum.get(idx);
            if (accum) {
              accum.arguments += event.delta || '';
            }
          } else if (type === 'response.function_call_arguments.done') {
            const idx = event.output_index;
            const accum = toolCallAccum.get(idx);
            if (accum) {
              // Prefer the .done event's authoritative arguments string if present
              const argsStr = typeof event.arguments === 'string' ? event.arguments : accum.arguments;
              let parsed = {};
              try {
                parsed = argsStr ? JSON.parse(argsStr) : {};
              } catch {
                parsed = {};
              }
              if (accum.callId && !emittedToolCallIds.has(accum.callId)) {
                emittedToolCallIds.add(accum.callId);
                sawToolCall = true;
                yield {
                  type: 'tool_call',
                  id: accum.callId,
                  name: accum.name,
                  input: parsed,
                };
              }
              toolCallAccum.delete(idx);
            }
          } else if (type === 'response.completed' || type === 'response.incomplete') {
            const respObj = event.response || {};

            // Fallback: flush any function_call items in the final output that we
            // didn't see a .done event for (defensive against partial streams).
            const outputArr = Array.isArray(respObj.output) ? respObj.output : [];
            for (const item of outputArr) {
              if (item?.type !== 'function_call') continue;
              const cid = item.call_id || item.id || '';
              if (!cid || emittedToolCallIds.has(cid)) continue;
              let parsed = {};
              try {
                parsed = item.arguments ? JSON.parse(item.arguments) : {};
              } catch {
                parsed = {};
              }
              emittedToolCallIds.add(cid);
              sawToolCall = true;
              yield {
                type: 'tool_call',
                id: cid,
                name: item.name || '',
                input: parsed,
              };
            }

            // Usage
            const usage = respObj.usage || {};
            yield {
              type: 'usage',
              inputTokens: usage.input_tokens || 0,
              outputTokens: usage.output_tokens || 0,
              cacheReadTokens: usage.input_tokens_details?.cached_tokens || 0,
              cacheWriteTokens: 0,
            };

            yield {
              type: 'stop',
              stopReason: this.#mapStopReason(respObj, sawToolCall),
            };
          } else if (type === 'response.error') {
            // Let the engine decide; emit error event
            const message = event.error?.message || event.message || 'response.error';
            yield { type: 'error', error: new Error(message), retryable: false };
          }
          // Other semantic events (output_item.done, content_part.added, etc.) are ignored.
        }
      }
    } catch (err) {
      if (err?.name === 'AbortError') throw new LLMAbortError();
      throw err;
    } finally {
      try { reader.releaseLock(); } catch { /* noop */ }
      // Emit raw exchange after stream completes (or errors). Body is the
      // verbatim SSE — never truncated. Parity with anthropic.js.
      if (onRawExchange) {
        try {
          onRawExchange({
            rawRequest,
            rawResponse: {
              status: responseStatus,
              headers: responseHeaders,
              body: rawSseBodyChunks.join(''),
              format: 'sse',
            },
          });
        } catch { /* ignore */ }
      }
    }
  }

  // ─── Non-streaming call() ───────────────────────────────

  /**
   * Side-query (consolidate / dream / recall / light) entry point. Does
   * NOT accept `onRawExchange` — these calls intentionally don't surface
   * in the user-facing debug panel. If a future product change wants to
   * expose them, mirror the stream() instrumentation. Parity with
   * anthropic.js's `call()`.
   */
  async call({ model, system, messages, maxTokens = 4096, effort, extraBody, signal }) {
    if (signal?.aborted) throw new LLMAbortError();

    const body = {
      model,
      input: this.#translateInput(messages),
      max_output_tokens: maxTokens,
    };
    if (system) body.instructions = system;

    // Mirror stream()'s thinking injection for non-streaming side queries.
    const normEffort = normalizeEffort(effort);
    if (thinkingV1Enabled() && normEffort) {
      const cap = getThinkingCapability(model);
      if (cap.supportsThinking && cap.thinkingProtocol === 'openai-reasoning') {
        const wireEffort = effortForResponses(normEffort);
        if (wireEffort) body.reasoning = { effort: wireEffort };
      }
    }

    if (extraBody) Object.assign(body, extraBody);

    let response;
    try {
      response = await fetch(`${this.#baseUrl}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.#apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') throw new LLMAbortError();
      throw err;
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw this.#classifyError(response.status, errorBody);
    }

    const result = await response.json();

    // Prefer the `output_text` convenience field; fall back to output[].content[].text
    let text = '';
    if (typeof result.output_text === 'string' && result.output_text.length > 0) {
      text = result.output_text;
    } else {
      const out = Array.isArray(result.output) ? result.output : [];
      for (const item of out) {
        if (item?.type === 'message' && Array.isArray(item.content)) {
          for (const part of item.content) {
            if (part?.type === 'output_text' && typeof part.text === 'string') {
              text += part.text;
            }
          }
        }
      }
    }

    const usage = result.usage || {};
    return {
      text,
      usage: {
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
      },
    };
  }
}
