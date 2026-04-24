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
  LLMAuthError,
  LLMContextError,
  LLMServerError,
  LLMAbortError,
  redactRawRequest,
  capRawRequest,
  capRawString,
  RAW_PAYLOAD_CAP_BYTES,
} from './adapter.js';
import {
  normalizeEffort,
  thinkingBudgetForEffort,
  getThinkingCapability,
} from '../models.js';

/**
 * task-327a: feature-flag accessor. thinkingV1 is OFF by default; set
 * env UNIFY_THINKING_V1=1 to enable. Read lazily so tests can flip.
 */
function thinkingV1Enabled() {
  return process.env.UNIFY_THINKING_V1 === '1';
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';

/**
 * AnthropicAdapter — Talks to Anthropic Messages API.
 */
export class AnthropicAdapter extends LLMAdapter {
  #apiKey;
  #baseUrl;

  constructor({ apiKey, baseUrl = DEFAULT_BASE_URL }) {
    super({ apiKey, baseUrl });
    this.#apiKey = apiKey;
    this.#baseUrl = baseUrl;
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
  #translateMessages(messages) {
    const result = [];
    for (const msg of messages) {
      if (msg.role === 'system') continue; // system goes separately
      if (msg.role === 'user') {
        result.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        const content = [];
        if (msg.content) {
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
        result.push({ role: 'assistant', content });
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
   */
  #classifyError(status, body) {
    if (status === 401 || status === 403) {
      return new LLMAuthError(`Anthropic auth error: ${body}`, status);
    }
    if (status === 429) {
      const retryAfter = null; // Could parse retry-after header
      return new LLMRateLimitError(`Anthropic rate limit: ${body}`, status, retryAfter);
    }
    if (status === 529) {
      return new LLMRateLimitError(`Anthropic overloaded: ${body}`, status);
    }
    if (body.includes('prompt is too long') || body.includes('max_tokens')) {
      return new LLMContextError(`Anthropic context error: ${body}`);
    }
    if (status >= 500) {
      return new LLMServerError(`Anthropic server error: ${body}`, status);
    }
    return new Error(`Anthropic API error ${status}: ${body}`);
  }

  /**
   * @param {{ model: string, system: string, messages: import('./adapter.js').UnifiedMessage[], tools?: import('./adapter.js').UnifiedToolDef[], maxTokens?: number, effort?: 'low'|'medium'|'high'|'max', signal?: AbortSignal }} params
   * @returns {AsyncGenerator<import('./adapter.js').StreamEvent>}
   */
  async *stream({ model, system, messages, tools, maxTokens = 16384, effort, signal, onRawExchange }) {
    if (signal?.aborted) throw new LLMAbortError();

    const body = {
      model,
      max_tokens: maxTokens,
      system,
      messages: this.#translateMessages(messages),
      stream: true,
    };

    // task-327a: inject extended-thinking only when feature flag on, effort is
    // a valid value, and the model's registry entry says it supports the
    // 'anthropic' thinking protocol. Unknown models or non-thinking models
    // silently drop the parameter — red line: never error on unsupported.
    const normEffort = normalizeEffort(effort);
    if (thinkingV1Enabled() && normEffort) {
      const cap = getThinkingCapability(model);
      if (cap.supportsThinking && cap.thinkingProtocol === 'anthropic') {
        const budget = thinkingBudgetForEffort(model, normEffort);
        if (budget && budget > 0) {
          // Anthropic requires max_tokens > budget_tokens. Widen max_tokens
          // if the caller's value is too small to fit the thinking budget
          // plus a sane reply margin (1024 tokens).
          const minMax = budget + 1024;
          if (body.max_tokens < minMax) body.max_tokens = minMax;
          body.thinking = { type: 'enabled', budget_tokens: budget };
        }
      }
    }

    const translatedTools = this.#translateTools(tools);
    if (translatedTools) body.tools = translatedTools;

    const url = `${this.#baseUrl}/v1/messages`;
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': this.#apiKey,
      'anthropic-version': API_VERSION,
    };

    // task-344: expose raw request (redacted) for debug panel.
    // task-344 follow-up (N2): cap body to RAW_PAYLOAD_CAP_BYTES.
    const rawRequest = capRawRequest(redactRawRequest({ url, method: 'POST', headers, body }));

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      // task-344: capture error response too, then throw.
      if (onRawExchange) {
        try {
          onRawExchange({
            rawRequest,
            rawResponse: {
              status: response.status,
              headers: response.headers && typeof response.headers.entries === 'function'
                ? Object.fromEntries(response.headers.entries())
                : {},
              // task-344 follow-up (N2): cap error body.
              body: capRawString(errorBody),
            },
          });
        } catch { /* ignore */ }
      }
      throw this.#classifyError(response.status, errorBody);
    }

    // Parse SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentToolCallId = null;
    let currentToolName = null;
    let currentToolInput = '';
    // task-344: accumulate raw SSE body for debug exposure.
    // task-344 follow-up (N2): cap growth — once past RAW_PAYLOAD_CAP_BYTES
    // we freeze the captured body and record total-bytes-seen separately.
    let rawSseBody = '';
    let rawSseTotalBytes = 0;
    let rawSseCapped = false;
    const responseHeaders = response.headers && typeof response.headers.entries === 'function'
      ? Object.fromEntries(response.headers.entries())
      : {};
    const responseStatus = response.status;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunkText = decoder.decode(value, { stream: true });
        buffer += chunkText;
        // task-344 follow-up (N2): size-capped capture.
        rawSseTotalBytes += value.byteLength;
        if (!rawSseCapped) {
          if (rawSseTotalBytes <= RAW_PAYLOAD_CAP_BYTES) {
            rawSseBody += chunkText;
          } else {
            // Append enough of this chunk to meet the cap, then freeze.
            const remaining = RAW_PAYLOAD_CAP_BYTES - (rawSseTotalBytes - value.byteLength);
            if (remaining > 0) {
              rawSseBody += chunkText.slice(0, remaining);
            }
            rawSseCapped = true;
          }
        }
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

          let event;
          try {
            event = JSON.parse(data);
          } catch {
            continue;
          }

          const type = event.type;

          if (type === 'content_block_start') {
            const block = event.content_block;
            if (block?.type === 'tool_use') {
              currentToolCallId = block.id;
              currentToolName = block.name;
              currentToolInput = '';
            }
          } else if (type === 'content_block_delta') {
            const delta = event.delta;
            if (delta?.type === 'text_delta') {
              yield { type: 'text_delta', text: delta.text };
            } else if (delta?.type === 'thinking_delta') {
              yield { type: 'thinking_delta', text: delta.thinking };
            } else if (delta?.type === 'input_json_delta') {
              currentToolInput += delta.partial_json;
            }
          } else if (type === 'content_block_stop') {
            if (currentToolCallId) {
              let parsedInput = {};
              try {
                parsedInput = currentToolInput ? JSON.parse(currentToolInput) : {};
              } catch {
                parsedInput = {};
              }
              yield {
                type: 'tool_call',
                id: currentToolCallId,
                name: currentToolName,
                input: parsedInput,
              };
              currentToolCallId = null;
              currentToolName = null;
              currentToolInput = '';
            }
          } else if (type === 'message_delta') {
            const stopReason = event.delta?.stop_reason;
            if (stopReason) {
              yield {
                type: 'stop',
                stopReason: this.#mapStopReason(stopReason),
              };
            }
            // Usage from message_delta
            if (event.usage) {
              yield {
                type: 'usage',
                inputTokens: 0, // Only in message_start
                outputTokens: event.usage.output_tokens || 0,
              };
            }
          } else if (type === 'message_start') {
            // Usage from message_start
            if (event.message?.usage) {
              yield {
                type: 'usage',
                inputTokens: event.message.usage.input_tokens || 0,
                outputTokens: event.message.usage.output_tokens || 0,
                cacheReadTokens: event.message.usage.cache_read_input_tokens || 0,
                cacheWriteTokens: event.message.usage.cache_creation_input_tokens || 0,
              };
            }
          } else if (type === 'error') {
            yield {
              type: 'error',
              error: new Error(event.error?.message || 'Unknown streaming error'),
              retryable: event.error?.type === 'overloaded_error',
            };
          }
        }
      }
    } finally {
      reader.releaseLock();
      // task-344: emit raw exchange after stream completes (or errors).
      if (onRawExchange) {
        try {
          // task-344 follow-up (N2): append truncation marker when capped.
          const finalBody = rawSseCapped
            ? `${rawSseBody}…[truncated, original ${rawSseTotalBytes} bytes]`
            : rawSseBody;
          onRawExchange({
            rawRequest,
            rawResponse: {
              status: responseStatus,
              headers: responseHeaders,
              body: finalBody,
              format: 'sse',
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
   * (consolidate/dream/recall/light). Guards mirror stream() — unsupported
   * models silently drop the param. max_tokens auto-widens to budget+1024
   * when needed.
   */
  async call({ model, system, messages, maxTokens = 4096, effort, signal }) {
    if (signal?.aborted) throw new LLMAbortError();

    const body = {
      model,
      max_tokens: maxTokens,
      system,
      messages: this.#translateMessages(messages),
    };

    // task-327c: mirror stream()'s thinking injection for side queries.
    const normEffort = normalizeEffort(effort);
    if (thinkingV1Enabled() && normEffort) {
      const cap = getThinkingCapability(model);
      if (cap.supportsThinking && cap.thinkingProtocol === 'anthropic') {
        const budget = thinkingBudgetForEffort(model, normEffort);
        if (budget && budget > 0) {
          const minMax = budget + 1024;
          if (body.max_tokens < minMax) body.max_tokens = minMax;
          body.thinking = { type: 'enabled', budget_tokens: budget };
        }
      }
    }

    const response = await fetch(`${this.#baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.#apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw this.#classifyError(response.status, errorBody);
    }

    const result = await response.json();
    const text = result.content
      ?.filter(b => b.type === 'text')
      .map(b => b.text)
      .join('') || '';

    return {
      text,
      usage: {
        inputTokens: result.usage?.input_tokens || 0,
        outputTokens: result.usage?.output_tokens || 0,
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
