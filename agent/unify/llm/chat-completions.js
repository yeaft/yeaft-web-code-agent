/**
 * chat-completions.js — OpenAI Chat Completions API adapter
 *
 * Covers ALL OpenAI-compatible backends via baseUrl:
 *   - https://api.openai.com/v1           → OpenAI direct
 *   - https://api.deepseek.com            → DeepSeek
 *   - http://localhost:6628/v1            → CopilotProxy
 *   - Azure, Ollama, LMStudio, etc.
 *
 * Key translation responsibilities:
 *   Request:  UnifiedToolDef → { type: "function", function: { name, description, parameters } }
 *   Response: delta.tool_calls[i].function.arguments (JSON string) → accumulate → JSON.parse → UnifiedToolCall
 *   Result:   UnifiedToolResult → { role: "tool", tool_call_id, content }
 *   Finish:   "tool_calls" → "tool_use", "stop" → "end_turn", "length" → "max_tokens"
 *
 * max_tokens strategy (based on model ID):
 *   OpenAI models (gpt-*, o1*, o3*, o4*) use "max_completion_tokens" (new standard).
 *   All other models (DeepSeek, Gemini, etc.) use "max_tokens" (legacy/compat).
 *   CopilotProxy transparently forwards whatever the client sends.
 *   Callers can override via extraBody to pass any parameter directly.
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
  mapEffortToOpenAIReasoning,
  getThinkingCapability,
} from '../models.js';

/**
 * task-327a: feature-flag accessor. Read lazily so tests can flip.
 */
function thinkingV1Enabled() {
  return process.env.UNIFY_THINKING_V1 === '1';
}

/**
 * task-DESIGN-v4: Chat Completions adapter is deprecated in favour of
 * `openai-responses.js` (Responses API) for OpenAI-protocol providers and
 * `anthropic.js` for Anthropic. This warning fires once per process the
 * first time the adapter is instantiated, unless UNIFY_SUPPRESS_DEPRECATION=1.
 * Removal is scheduled for Phase 7 of the multi-VP redesign — see
 * `agent/unify/DESIGN.md` § "Migration Plan".
 */
let _chatCompletionsDeprecationWarned = false;
function warnChatCompletionsDeprecated() {
  if (_chatCompletionsDeprecationWarned) return;
  if (process.env.UNIFY_SUPPRESS_DEPRECATION === '1') {
    _chatCompletionsDeprecationWarned = true;
    return;
  }
  _chatCompletionsDeprecationWarned = true;
  // eslint-disable-next-line no-console
  console.warn(
    '[unify] ChatCompletionsAdapter is deprecated. Migrate OpenAI-protocol '
    + 'providers to the Responses API (set provider.protocol="openai-responses"). '
    + 'This adapter will be removed in a future release. Set '
    + 'UNIFY_SUPPRESS_DEPRECATION=1 to silence this warning.'
  );
}

/**
 * Check if a model ID is an OpenAI model that supports max_completion_tokens.
 * OpenAI introduced max_completion_tokens with o1 and made it standard for
 * GPT-4.1+, o-series, and GPT-5+. Other OpenAI-compatible APIs (DeepSeek,
 * Gemini, Ollama) still only understand max_tokens.
 *
 * @param {string} model — The model ID (e.g. "gpt-5", "deepseek-chat", "o3")
 * @returns {boolean} true = use max_completion_tokens
 */
export function useNewMaxTokensParam(model) {
  if (!model) return false;
  const m = model.toLowerCase();
  // GPT-4.1+ and GPT-5+
  if (m.startsWith('gpt-')) return true;
  // o-series reasoning models (o1, o3, o4-mini, etc.)
  if (/^o\d/.test(m)) return true;
  // Everything else (deepseek-*, gemini-*, claude-*, custom models): legacy
  return false;
}

/**
 * ChatCompletionsAdapter — Talks to OpenAI Chat Completions API and compatibles.
 */
export class ChatCompletionsAdapter extends LLMAdapter {
  #apiKey;
  #baseUrl;

  /**
   * @param {{ apiKey: string, baseUrl: string }} config
   */
  constructor({ apiKey, baseUrl }) {
    super({ apiKey, baseUrl });
    this.#apiKey = apiKey;
    this.#baseUrl = baseUrl.replace(/\/+$/, ''); // strip trailing slash
    warnChatCompletionsDeprecated();
  }

  /** Expose baseUrl for testing. */
  get baseUrl() { return this.#baseUrl; }

  /**
   * Build the max-tokens portion of the request body.
   * Uses max_completion_tokens for OpenAI models, max_tokens for others.
   *
   * @param {string} model
   * @param {number} maxTokens
   * @returns {object}
   */
  #maxTokensBody(model, maxTokens) {
    if (useNewMaxTokensParam(model)) {
      return { max_completion_tokens: maxTokens };
    }
    return { max_tokens: maxTokens };
  }

  /**
   * Translate UnifiedToolDef[] → Chat Completions tool format.
   * @param {import('./adapter.js').UnifiedToolDef[]} tools
   * @returns {object[]|undefined}
   */
  #translateTools(tools) {
    if (!tools || tools.length === 0) return undefined;
    return tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  /**
   * Translate UnifiedMessage[] → Chat Completions message format.
   * @param {string} system — System prompt
   * @param {import('./adapter.js').UnifiedMessage[]} messages
   * @returns {object[]}
   */
  #translateMessages(system, messages) {
    const result = [];

    // System message first
    if (system) {
      result.push({ role: 'system', content: system });
    }

    for (const msg of messages) {
      if (msg.role === 'system') {
        result.push({ role: 'system', content: msg.content });
      } else if (msg.role === 'user') {
        result.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        const entry = { role: 'assistant' };
        // Some OpenAI-compatible APIs require `content: null` when tool_calls are present
        entry.content = msg.content || null;
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          entry.tool_calls = msg.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.input),
            },
          }));
        }
        result.push(entry);
      } else if (msg.role === 'tool') {
        result.push({
          role: 'tool',
          tool_call_id: msg.toolCallId,
          content: msg.content,
        });
      }
    }
    return result;
  }

  /**
   * Classify HTTP errors.
   * @param {number} status
   * @param {string} body
   */
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

  /**
   * Map Chat Completions finish_reason → unified stop reason.
   * @param {string|null} reason
   * @returns {'end_turn' | 'tool_use' | 'max_tokens'}
   */
  #mapFinishReason(reason) {
    switch (reason) {
      case 'tool_calls': return 'tool_use';
      case 'stop': return 'end_turn';
      case 'length': return 'max_tokens';
      default: return 'end_turn';
    }
  }

  /**
   * @param {{ model: string, system: string, messages: import('./adapter.js').UnifiedMessage[], tools?: import('./adapter.js').UnifiedToolDef[], maxTokens?: number, effort?: 'low'|'medium'|'high'|'max', extraBody?: object, signal?: AbortSignal }} params
   * @returns {AsyncGenerator<import('./adapter.js').StreamEvent>}
   */
  async *stream({ model, system, messages, tools, maxTokens = 16384, effort, extraBody, signal, onRawExchange }) {
    if (signal?.aborted) throw new LLMAbortError();

    const body = {
      model,
      messages: this.#translateMessages(system, messages),
      ...this.#maxTokensBody(model, maxTokens),
      stream: true,
      stream_options: { include_usage: true },
    };

    // task-327a: inject OpenAI reasoning.effort when feature flag on, effort is
    // valid, and model's registry entry flags openai-reasoning protocol.
    // 'max' downgrades to 'high' (OpenAI has no 'max' enum). Unknown / unsupported
    // models silently drop the parameter.
    const normEffort = normalizeEffort(effort);
    if (thinkingV1Enabled() && normEffort) {
      const cap = getThinkingCapability(model);
      if (cap.supportsThinking && cap.thinkingProtocol === 'openai-reasoning') {
        const reasoningEffort = mapEffortToOpenAIReasoning(normEffort);
        if (reasoningEffort) {
          body.reasoning = { effort: reasoningEffort };
        }
      }
    }

    const translatedTools = this.#translateTools(tools);
    if (translatedTools) body.tools = translatedTools;

    // extraBody allows callers to pass through any additional/override parameters
    if (extraBody) Object.assign(body, extraBody);

    const url = `${this.#baseUrl}/chat/completions`;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.#apiKey}`,
    };

    // task-344: expose raw request (redacted) for debug panel.
    // task-344 follow-up (N2): cap body size.
    const rawRequest = capRawRequest(redactRawRequest({ url, method: 'POST', headers, body }));

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
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
    // task-344: accumulate raw SSE body + headers/status for debug exposure.
    // task-344 follow-up (N2): cap growth at RAW_PAYLOAD_CAP_BYTES.
    let rawSseBody = '';
    let rawSseTotalBytes = 0;
    let rawSseCapped = false;
    const responseHeaders = response.headers && typeof response.headers.entries === 'function'
      ? Object.fromEntries(response.headers.entries())
      : {};
    const responseStatus = response.status;

    // Tool call accumulation — Chat Completions sends tool args as fragments
    // keyed by index within the delta.tool_calls array
    /** @type {Map<number, { id: string, name: string, arguments: string }>} */
    const toolCallAccum = new Map();

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
            const remaining = RAW_PAYLOAD_CAP_BYTES - (rawSseTotalBytes - value.byteLength);
            if (remaining > 0) {
              rawSseBody += chunkText.slice(0, remaining);
            }
            rawSseCapped = true;
          }
        }
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

          let chunk;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }

          // Usage (from stream_options: include_usage)
          if (chunk.usage) {
            yield {
              type: 'usage',
              inputTokens: chunk.usage.prompt_tokens || 0,
              outputTokens: chunk.usage.completion_tokens || 0,
              cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens || 0,
              cacheWriteTokens: 0,
            };
          }

          const choice = chunk.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta;
          if (!delta) continue;

          // Text content
          if (delta.content) {
            yield { type: 'text_delta', text: delta.content };
          }

          // Tool calls (streamed as fragments)
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!toolCallAccum.has(idx)) {
                toolCallAccum.set(idx, {
                  id: tc.id || '',
                  name: tc.function?.name || '',
                  arguments: '',
                });
              }
              const accum = toolCallAccum.get(idx);
              if (tc.id) accum.id = tc.id;
              if (tc.function?.name) accum.name = tc.function.name;
              if (tc.function?.arguments) accum.arguments += tc.function.arguments;
            }
          }

          // Finish reason
          if (choice.finish_reason) {
            // Emit accumulated tool calls before stop
            for (const [, accum] of toolCallAccum) {
              let parsedInput = {};
              try {
                parsedInput = accum.arguments ? JSON.parse(accum.arguments) : {};
              } catch {
                parsedInput = {};
              }
              yield {
                type: 'tool_call',
                id: accum.id,
                name: accum.name,
                input: parsedInput,
              };
            }
            toolCallAccum.clear();

            yield {
              type: 'stop',
              stopReason: this.#mapFinishReason(choice.finish_reason),
            };
          }
        }
      }
    } finally {
      reader.releaseLock();
      // task-344: emit raw exchange after stream completes.
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
   * (consolidate/dream/recall/light). Feature-flag + capability guards
   * mirror stream() exactly; unsupported models silently drop the param.
   */
  async call({ model, system, messages, maxTokens = 4096, effort, extraBody, signal }) {
    if (signal?.aborted) throw new LLMAbortError();

    const body = {
      model,
      messages: this.#translateMessages(system, messages),
      ...this.#maxTokensBody(model, maxTokens),
    };

    // task-327c: mirror stream()'s reasoning.effort injection for side queries.
    const normEffort = normalizeEffort(effort);
    if (thinkingV1Enabled() && normEffort) {
      const cap = getThinkingCapability(model);
      if (cap.supportsThinking && cap.thinkingProtocol === 'openai-reasoning') {
        const reasoningEffort = mapEffortToOpenAIReasoning(normEffort);
        if (reasoningEffort) {
          body.reasoning = { effort: reasoningEffort };
        }
      }
    }

    // extraBody allows callers to pass through any additional/override parameters
    if (extraBody) Object.assign(body, extraBody);

    const response = await fetch(`${this.#baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.#apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw this.#classifyError(response.status, errorBody);
    }

    const result = await response.json();
    const text = result.choices?.[0]?.message?.content || '';

    return {
      text,
      usage: {
        inputTokens: result.usage?.prompt_tokens || 0,
        outputTokens: result.usage?.completion_tokens || 0,
      },
    };
  }
}
