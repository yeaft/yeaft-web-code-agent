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
 */

import {
  LLMAdapter,
  LLMRateLimitError,
  LLMAuthError,
  LLMContextError,
  LLMServerError,
  LLMAbortError,
} from './adapter.js';

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
   * @param {{ model: string, system: string, messages: import('./adapter.js').UnifiedMessage[], tools?: import('./adapter.js').UnifiedToolDef[], maxTokens?: number, signal?: AbortSignal }} params
   * @returns {AsyncGenerator<import('./adapter.js').StreamEvent>}
   */
  async *stream({ model, system, messages, tools, maxTokens = 16384, signal }) {
    if (signal?.aborted) throw new LLMAbortError();

    const body = {
      model,
      messages: this.#translateMessages(system, messages),
      max_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    };

    const translatedTools = this.#translateTools(tools);
    if (translatedTools) body.tools = translatedTools;

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

    // Parse SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Tool call accumulation — Chat Completions sends tool args as fragments
    // keyed by index within the delta.tool_calls array
    /** @type {Map<number, { id: string, name: string, arguments: string }>} */
    const toolCallAccum = new Map();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
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
    }
  }

  /**
   * Non-streaming call for side queries.
   */
  async call({ model, system, messages, maxTokens = 4096, signal }) {
    if (signal?.aborted) throw new LLMAbortError();

    const body = {
      model,
      messages: this.#translateMessages(system, messages),
      max_tokens: maxTokens,
    };

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
