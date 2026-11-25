/**
 * openai-chat-completions.js — OpenAI Chat Completions API adapter (/v1/chat/completions)
 *
 * Implements the modern OpenAI Chat Completions wire specification along with
 * standard gateway reasoning-state extensions (`reasoning_opaque`, `reasoning_text`,
 * `reasoning_content`, `reasoning`) so gateways such as GitHub Copilot Proxy and
 * OpenAI-compatible endpoints can run multi-turn tool loops natively without
 * lossy protocol translation.
 *
 * Wire contract:
 *   - Endpoint: `${baseUrl}/chat/completions`
 *   - Auth: `Authorization: Bearer ${apiKey}`
 *   - System prompt: leading `{ role: 'system', content }` message (or `developer`
 *     when explicitly preserved via messages/extraBody)
 *   - Messages: `system` / `developer` / `user` / `assistant` / `tool`
 *   - Multimodal tool results: Chat Completions `role: 'tool'` only supports text
 *     content; images/documents attached to tool results are sent in an adjacent
 *     follow-up `role: 'user'` message immediately after the tool result batch,
 *     identifying the originating `toolCallId` so ordering and tool pairing stay valid.
 *   - Tools: `{ type: 'function', function: { name, description, parameters } }`
 *   - Token cap: `max_completion_tokens` (latest OpenAI specification; callers may
 *     override via `extraBody.max_tokens` when targeting legacy gateways)
 *   - Reasoning effort: top-level `reasoning_effort` (`medium` | `high` | `xhigh` | `max` | `ultra` ...)
 *   - Streaming: `stream: true`, `stream_options: { include_usage: true }`
 *   - Prompt caching: `prompt_cache_key` (owner/origin-fenced, automatic single retry
 *     without hint if an upstream rejects the optional field)
 *   - Native reasoning state (`providerState` protocol `openai-chat-completions`):
 *     preserves `reasoning_opaque` and `reasoning_text` / `reasoning_content` on
 *     assistant turns and replays them verbatim on matching owner/origin/projection.
 */

import {
  enforceSubAgentEffortPayload,
  captureEffortDecision,
} from '../effort.js';
import {
  LLMAdapter,
  LLMRateLimitError,
  LLMContextError,
  LLMServerError,
  LLMToolInputError,
  LLMAbortError,
  classifyAuthError,
  classifyPolicyError,
  classifyFetchError,
  classifyUpstreamHeadersTimeout,
  retryAfterFromResponse,
  readStreamChunkWithIdleTimeout,
  resolveStreamIdleTimeoutMs,
  redactRawRequest,
  safeHeaders,
  SseLineBuffer,
  createBoundedTextAccumulator,
  toWellFormedJson,
  contentFilterStopDetails,
} from './adapter.js';
import {
  getModelEffortOptions,
  resolveChatEffort,
} from '../models.js';
import {
  createProviderContext,
  createProviderState,
  replayProviderState,
  providerStateBytes,
  hasSignedProviderState,
  ProviderStateError,
  applyChatCompletionsContinuity,
  reasoningUsage,
  reportedUsageFields,
  hasUsageCounts,
} from './provider-state.js';
import { fetchWithPromptCacheFallback } from './prompt-cache.js';
import { imageMimeFromBase64 } from '../image-dimensions.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

const RATE_LIMIT_CODES = new Set(['rate_limit_exceeded', 'rate_limit_error', 'slow_down']);
const TRANSIENT_FAILURE_CODES = new Set([
  'server_error', 'internal_server_error', 'server_is_overloaded', 'overloaded_error',
  'policy_capacity_unavailable', 'service_unavailable', 'upstream_headers_timeout',
]);

function thinkingV1Enabled() {
  return process.env.YEAFT_THINKING_V1 === '1';
}

function validateToolCallId(id) {
  if (typeof id !== 'string' || !id.trim() || id.length > 256) {
    throw new LLMToolInputError('Chat Completions returned invalid tool call identity');
  }
  return id;
}

function parseToolInput(argumentsJson) {
  let input;
  try {
    if (typeof argumentsJson !== 'string') throw new Error();
    const trimmed = argumentsJson.trim();
    if (!trimmed) throw new Error();
    input = JSON.parse(trimmed);
  } catch {
    throw new LLMToolInputError('Chat Completions returned invalid or incomplete tool input');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new LLMToolInputError('Chat Completions returned non-object tool input');
  }
  return input;
}

function classifyStreamErrorPayload(payload, response) {
  const providerError = payload?.error && typeof payload.error === 'object' ? payload.error : payload;
  const code = [providerError?.code, providerError?.type]
    .find(value => typeof value === 'string' && value.trim())?.trim();
  const message = [providerError?.message, typeof payload?.error === 'string' ? payload.error : null]
    .find(value => typeof value === 'string' && value.trim())
    || `Chat Completions stream error${code ? `: ${code}` : ''}`;
  const limited = RATE_LIMIT_CODES.has(code);
  let error;
  if (code === 'context_length_exceeded') {
    error = new LLMContextError(message);
  } else if (limited || TRANSIENT_FAILURE_CODES.has(code)) {
    const retryAfterMs = [
      retryAfterFromResponse(providerError),
      retryAfterFromResponse(payload),
      retryAfterFromResponse(response),
    ].find(delay => Number.isFinite(delay) && delay > 0) ?? null;
    error = limited
      ? new LLMRateLimitError(message, 0, retryAfterMs)
      : new LLMServerError(message, 0, retryAfterMs);
  } else {
    error = new Error(message);
  }
  if (code) error.code = code;
  return error;
}

function projectChatToolCalls(rawToolCalls, truncated = false) {
  const calls = [];
  const ids = new Set();
  for (const tc of rawToolCalls || []) {
    if (!tc || typeof tc !== 'object') throw new LLMToolInputError('Chat Completions returned invalid tool call');
    if (tc.type && tc.type !== 'function') throw new LLMToolInputError('Chat Completions returned unsupported tool call type');
    const id = validateToolCallId(tc.id);
    if (ids.has(id)) throw new LLMToolInputError('Chat Completions returned duplicate tool call identity');
    ids.add(id);
    const name = tc.function?.name;
    if (typeof name !== 'string' || !name.trim()) {
      throw new LLMToolInputError('Chat Completions returned missing tool name');
    }
    if (truncated) throw new LLMToolInputError('Chat Completions tool response was truncated');
    calls.push({
      type: 'tool_call',
      id,
      name,
      input: parseToolInput(tc.function?.arguments),
    });
  }
  return calls;
}

function buildUsageEvent(usage) {
  const u = usage || {};
  const inputTokens = u.prompt_tokens ?? u.input_tokens ?? 0;
  const outputTokens = u.completion_tokens ?? u.output_tokens ?? 0;
  const cacheReadTokens = u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens ?? 0;
  const reportedTokenFields = reportedUsageFields(usage, 'openai-chat-completions');
  const usageIncomplete = !hasUsageCounts(usage, ['prompt_tokens', 'completion_tokens']);
  return {
    type: 'usage',
    reportedTokenFields,
    usageIncomplete,
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    cacheReadTokens: Number.isFinite(cacheReadTokens) ? cacheReadTokens : 0,
    cacheWriteTokens: 0,
    cacheTokensAreIncludedInInput: true,
    ...reasoningUsage(u, 'openai-chat-completions'),
  };
}

function buildNativeMessageItem({ content, toolCalls, reasoningText, reasoningField, reasoningOpaque }) {
  const item = {
    type: 'assistant_message',
    content: content || '',
  };
  if (toolCalls.length > 0) {
    item.tool_calls = toolCalls.map(tc => ({
      id: tc.id,
      type: 'function',
      function: {
        name: tc.name,
        arguments: tc.arguments,
      },
    }));
  }
  if (typeof reasoningOpaque === 'string' && reasoningOpaque.length > 0) {
    item.reasoning_opaque = reasoningOpaque;
  }
  if (typeof reasoningText === 'string' && reasoningText.length > 0) {
    item[reasoningField || 'reasoning_text'] = reasoningText;
  }
  return item;
}

function extractReasoningFields(obj) {
  if (!obj || typeof obj !== 'object') return { text: '', field: null, opaque: '' };
  let text = '';
  let field = null;
  if (typeof obj.reasoning_text === 'string' && obj.reasoning_text.length > 0) {
    text = obj.reasoning_text;
    field = 'reasoning_text';
  } else if (typeof obj.reasoning_content === 'string' && obj.reasoning_content.length > 0) {
    text = obj.reasoning_content;
    field = 'reasoning_content';
  } else if (typeof obj.reasoning === 'string' && obj.reasoning.length > 0) {
    text = obj.reasoning;
    field = 'reasoning';
  }
  const opaque = typeof obj.reasoning_opaque === 'string' && obj.reasoning_opaque.length > 0
    ? obj.reasoning_opaque
    : '';
  return { text, field, opaque };
}

function classifyProviderHostedTools(tools) {
  return Array.isArray(tools) && tools.some(tool => tool && typeof tool === 'object' && tool.type !== 'function');
}

function mapFinishReason(finishReason, hasToolCalls) {
  if (finishReason === 'content_filter') return 'refusal';
  if (finishReason === 'length') return 'max_tokens';
  if (finishReason === 'tool_calls' || finishReason === 'function_call') return 'tool_use';
  if (finishReason === 'stop') return hasToolCalls ? 'tool_use' : 'end_turn';
  return hasToolCalls ? 'tool_use' : 'unknown';
}

function declaredToolNames(tools) {
  return (Array.isArray(tools) ? tools : [])
    .map(tool => tool?.function?.name || tool?.name)
    .filter(Boolean);
}

export class OpenAIChatCompletionsAdapter extends LLMAdapter {
  #apiKey;
  #baseUrl;
  #headers;
  #streamIdlePolicy;

  /**
   * @param {{ apiKey: string, baseUrl?: string, headers?: Record<string, string>, extraHeaders?: Record<string, string>, streamIdleTimeoutMs?: number, highEffortStreamIdleTimeoutMs?: number }} config
   */
  constructor({ apiKey, baseUrl = DEFAULT_BASE_URL, headers = {}, extraHeaders = {}, streamIdleTimeoutMs = 0, highEffortStreamIdleTimeoutMs } = {}) {
    super({ apiKey, baseUrl, headers: { ...headers, ...extraHeaders }, streamIdleTimeoutMs, highEffortStreamIdleTimeoutMs });
    this.#apiKey = apiKey;
    this.#baseUrl = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#headers = { ...headers, ...extraHeaders };
    this.#streamIdlePolicy = { streamIdleTimeoutMs, highEffortStreamIdleTimeoutMs };
  }

  /** Expose baseUrl for testing. */
  get baseUrl() { return this.#baseUrl; }

  #endpointUrl() {
    if (/\/chat\/completions$/i.test(this.#baseUrl)) return this.#baseUrl;
    return `${this.#baseUrl}/chat/completions`;
  }

  #translateTools(tools) {
    if (!Array.isArray(tools) || tools.length === 0) return undefined;
    return tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.parameters || { type: 'object', properties: {} },
      },
    }));
  }

  #translatePart(part) {
    if (!part || typeof part !== 'object') {
      return { type: 'text', text: String(part ?? '') };
    }
    if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
      return { type: 'text', text: typeof part.text === 'string' ? part.text : '' };
    }
    if (part.type === 'image') {
      const src = part.source || {};
      let url = '';
      if (src.url) {
        url = src.url;
      } else if (src.data) {
        const mime = imageMimeFromBase64(src.data) || src.media_type || src.mediaType || 'image/png';
        url = `data:${mime};base64,${src.data}`;
      }
      return {
        type: 'image_url',
        image_url: {
          url,
          ...(part.detail ? { detail: part.detail } : {}),
        },
      };
    }
    if (part.type === 'image_url') {
      if (typeof part.image_url === 'string') {
        return { type: 'image_url', image_url: { url: part.image_url, ...(part.detail ? { detail: part.detail } : {}) } };
      }
      return structuredClone(part);
    }
    if (part.type === 'input_image') {
      return {
        type: 'image_url',
        image_url: {
          url: part.image_url || '',
          ...(part.detail ? { detail: part.detail } : {}),
        },
      };
    }
    if (part.type === 'document') {
      const src = part.source || {};
      const mediaType = src.media_type || src.mediaType;
      if (src.type === 'base64' && mediaType === 'application/pdf' && src.data) {
        return {
          type: 'file',
          file: {
            filename: part.title || 'attachment.pdf',
            file_data: `data:application/pdf;base64,${src.data}`,
          },
        };
      }
    }
    if (part.type === 'file') return structuredClone(part);
    return { type: 'text', text: String(part.text ?? '') };
  }

  #translateUserContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const parts = content.map(part => this.#translatePart(part));
      if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
      return parts;
    }
    return String(content ?? '');
  }

  #translateMessages(system, messages, context, identity, controlReentry = false) {
    const wire = [];
    if (typeof system === 'string' && system.length > 0) {
      wire.push({ role: 'system', content: system });
    }

    let pendingToolAttachments = [];
    const flushToolAttachments = () => {
      if (pendingToolAttachments.length === 0) return;
      const parts = [];
      for (const entry of pendingToolAttachments) {
        parts.push({ type: 'text', text: `[Attached media from tool result ${entry.toolCallId}]` });
        parts.push(...entry.mediaParts);
      }
      wire.push({ role: 'user', content: parts });
      pendingToolAttachments = [];
    };

    const openToolCallIds = new Set();
    const resolvedToolCallIds = new Set();

    for (const msg of messages || []) {
      if (!msg || typeof msg !== 'object') continue;
      if (msg.role !== 'tool') flushToolAttachments();

      if (msg.role === 'system' || msg.role === 'developer') {
        wire.push({
          role: msg.role,
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? ''),
        });
        continue;
      }

      if (msg.role === 'user') {
        wire.push({
          role: 'user',
          content: this.#translateUserContent(msg.content),
        });
        continue;
      }

      if (msg.role === 'assistant') {
        const native = replayProviderState(msg, context, identity);
        if (hasSignedProviderState(msg.providerState) && !native) {
          throw new ProviderStateError('Chat Completions signed assistant state cannot be safely replayed');
        }
        if (native && native.length > 0) {
          const item = native[0];
          const assistantMsg = {
            role: 'assistant',
            content: item.content || (item.tool_calls?.length ? null : ''),
          };
          if (item.tool_calls?.length) {
            assistantMsg.tool_calls = structuredClone(item.tool_calls);
            for (const tc of assistantMsg.tool_calls) openToolCallIds.add(tc.id);
          }
          if (typeof item.reasoning_opaque === 'string' && item.reasoning_opaque.length > 0) {
            assistantMsg.reasoning_opaque = item.reasoning_opaque;
          }
          for (const key of ['reasoning_text', 'reasoning_content', 'reasoning']) {
            if (typeof item[key] === 'string' && item[key].length > 0) {
              assistantMsg[key] = item[key];
            }
          }
          wire.push(assistantMsg);
          continue;
        }

        const text = typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('')
            : '';
        const toolCalls = Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0
          ? msg.toolCalls.map(tc => {
              openToolCallIds.add(tc.id);
              return {
                id: tc.id,
                type: 'function',
                function: {
                  name: tc.name,
                  arguments: JSON.stringify(toWellFormedJson(tc.input ?? {})),
                },
              };
            })
          : null;
        const assistantMsg = {
          role: 'assistant',
          content: text || (toolCalls ? null : ''),
        };
        if (toolCalls) assistantMsg.tool_calls = toolCalls;
        wire.push(assistantMsg);
        continue;
      }

      if (msg.role === 'tool') {
        if (msg.toolCallId) resolvedToolCallIds.add(msg.toolCallId);
        if (Array.isArray(msg.content)) {
          const textParts = [];
          const mediaParts = [];
          for (const part of msg.content) {
            const translated = this.#translatePart(part);
            if (translated.type === 'text') {
              if (translated.text) textParts.push(translated.text);
            } else {
              mediaParts.push(translated);
            }
          }
          const textBody = textParts.join('\n') || (mediaParts.length > 0 ? '[Image attached in following user message]' : '');
          wire.push({
            role: 'tool',
            tool_call_id: msg.toolCallId,
            content: textBody,
          });
          if (mediaParts.length > 0) {
            pendingToolAttachments.push({ toolCallId: msg.toolCallId, mediaParts });
          }
        } else {
          wire.push({
            role: 'tool',
            tool_call_id: msg.toolCallId,
            content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? ''),
          });
        }
      }
    }

    flushToolAttachments();

    // Control reentry (e.g., sub-agent/async completion appended to an earlier tool
    // result while the conversation still ends on an assistant message): some
    // Chat Completions upstreams (including Copilot Gemini) reject a trailing
    // assistant turn with HTTP 400 invalid_message_role.
    const allOpenCallsResolved = [...openToolCallIds].every(id => resolvedToolCallIds.has(id));
    if (controlReentry === true && wire.at(-1)?.role === 'assistant' && allOpenCallsResolved) {
      wire.push({
        role: 'user',
        content: '[system note] Continue the pending task using the updated context above.',
      });
    }

    return wire;
  }

  #buildRequestBody({ model, system, messages, tools, maxTokens, contextOutputLimit, effort, effortSource, effortContext = {}, extraBody, providerContext, requestIdentity, onProviderDiagnostics, effortConstraint = null, onEffortDecision = null, controlReentry = false, stream }) {
    const context = providerContext || createProviderContext({
      protocol: 'openai-chat-completions',
      baseUrl: this.#baseUrl,
      staticApiKey: this.#apiKey,
      model,
    });
    const effectiveMaxTokens = Number.isFinite(contextOutputLimit) && maxTokens > contextOutputLimit
      ? Math.max(1, Math.floor(contextOutputLimit))
      : maxTokens;

    const body = {
      model,
      max_completion_tokens: effectiveMaxTokens,
    };
    if (stream) {
      body.stream = true;
      body.stream_options = { include_usage: true };
    }
    const translatedTools = this.#translateTools(tools);
    if (translatedTools) body.tools = translatedTools;

    const capContext = { ...effortContext, protocol: 'openai-chat-completions' };
    if (effort && (thinkingV1Enabled() || effortSource === 'user')) {
      const effective = resolveChatEffort(model, effort, getModelEffortOptions(model, capContext));
      if (effective) body.reasoning_effort = effective;
    }

    if (extraBody && typeof extraBody === 'object') {
      Object.assign(body, extraBody);
      // If caller explicitly opted into legacy `max_tokens` via extraBody without
      // `max_completion_tokens`, avoid sending both conflicting parameters.
      if (Object.hasOwn(extraBody, 'max_tokens') && !Object.hasOwn(extraBody, 'max_completion_tokens')) {
        delete body.max_completion_tokens;
      }
    }

    const wireMessages = this.#translateMessages(system, messages, context, requestIdentity, controlReentry);
    body.model = model;
    if (stream) {
      body.stream = true;
      if (body.stream_options === undefined) body.stream_options = { include_usage: true };
    } else {
      delete body.stream;
      delete body.stream_options;
    }

    const cacheKeySent = applyChatCompletionsContinuity(body, {
      context,
      identity: requestIdentity,
      messages: wireMessages,
      onProviderDiagnostics,
    });

    // extraBody is an explicit raw wire override; only child constraints override it.
    const effortDecision = effortConstraint
      ? enforceSubAgentEffortPayload(body, { model, protocol: 'openai-chat-completions', effortContext: capContext, effortConstraint })
      : captureEffortDecision({ body, model, protocol: 'openai-chat-completions', effortContext: capContext, requested: effort, source: effortSource || 'scenario' });
    onEffortDecision?.(effortDecision);

    return {
      context,
      requestBody: toWellFormedJson(body),
      cacheKeySent,
      effortDecision,
    };
  }

  #dispatch({ url, headers, requestBody, signal, getHeadersTimeoutMs, onResponseHeaders, cacheKeySent, context, onProviderDiagnostics, onRequestStart, maxRequestBodyBytes }) {
    return fetchWithPromptCacheFallback({
      url,
      headers,
      body: requestBody,
      signal,
      getHeadersTimeoutMs,
      onResponseHeaders,
      providerLabel: 'Chat Completions',
      field: 'prompt_cache_key',
      maxRequestBodyBytes,
      withoutCache: cacheKeySent ? ({ prompt_cache_key, ...uncached }) => uncached : undefined,
      onRequestStart,
      onCacheFallback: () => onProviderDiagnostics?.({
        ...context.diagnostics,
        nativeReasoningState: Boolean(context.capabilities.nativeReasoningState),
        promptCaching: 'rejected-fallback',
      }),
    });
  }

  #classifyError(status, body, response = null) {
    if (status === 401 || status === 403) {
      return classifyAuthError(status, body);
    }
    if (status === 429) {
      const retryAfter = retryAfterFromResponse(response);
      return new LLMRateLimitError(`Rate limit: ${body}`, status, retryAfter);
    }
    if (status === 529) {
      const retryAfter = retryAfterFromResponse(response);
      return new LLMRateLimitError(`Overloaded: ${body}`, status, retryAfter);
    }
    const policyError = classifyPolicyError(status, body);
    if (policyError) return policyError;
    if (body.includes('context_length_exceeded')
      || body.includes('maximum context length')
      || /(?:input|prompt|context)[^\n]{0,80}(?:too (?:long|large)|exceed|token limit)/i.test(body)) {
      return new LLMContextError(`Context too long: ${body}`);
    }
    if (status >= 500) {
      return classifyUpstreamHeadersTimeout(status, body) || new LLMServerError(`Server error: ${body}`, status);
    }
    return new Error(`API error ${status}: ${body}`);
  }

  #headersForRequest() {
    return {
      'Content-Type': 'application/json',
      ...(this.#apiKey ? { Authorization: `Bearer ${this.#apiKey}` } : {}),
      ...this.#headers,
    };
  }

  async *stream(params) {
    const {
      model,
      maxTokens = 16384,
      requestIdentity,
      signal,
      onRawExchange,
      rawExchangeMaxBytes = 512 * 1024,
      onRequestStart,
      getHeadersTimeoutMs,
      onResponseHeaders,
      streamIdleTimeoutMs,
      minStreamIdleTimeoutMs,
      maxRequestBodyBytes,
    } = params;

    if (signal?.aborted) throw new LLMAbortError();

    const { context, requestBody, cacheKeySent, effortDecision } = this.#buildRequestBody({
      ...params,
      maxTokens,
      stream: true,
    });
    const idleMs = resolveStreamIdleTimeoutMs(this.#streamIdlePolicy, effortDecision.effective, streamIdleTimeoutMs, minStreamIdleTimeoutMs);
    const url = this.#endpointUrl();
    const headers = this.#headersForRequest();

    const { response, errorBody, body: wireBody } = await this.#dispatch({
      url,
      headers,
      requestBody,
      signal,
      getHeadersTimeoutMs,
      onResponseHeaders,
      maxRequestBodyBytes,
      cacheKeySent,
      context,
      onProviderDiagnostics: params.onProviderDiagnostics,
      onRequestStart: headersTimeoutMs => onRequestStart?.({
        effort: effortDecision.effective,
        streamIdleTimeoutMs: idleMs,
        headersTimeoutMs,
      }),
    });

    const rawRequest = redactRawRequest({ url, method: 'POST', headers, body: wireBody });
    const responseHeaders = safeHeaders(response);
    const responseStatus = response.status;
    const replayUnsafe = classifyProviderHostedTools(wireBody.tools) || Boolean(wireBody.web_search_options);
    const unusable = event => (replayUnsafe ? { ...event, replayUnsafe: true } : event);

    if (!response.ok) {
      if (onRawExchange) {
        try {
          onRawExchange({
            rawRequest,
            rawResponse: { status: responseStatus, headers: responseHeaders, body: errorBody },
          });
        } catch { /* ignore */ }
      }
      throw this.#classifyError(responseStatus, errorBody, response);
    }

    // Non-streaming JSON response fallback (some gateways return JSON even with stream:true)
    if ((response.headers?.get('content-type') || '').includes('application/json')) {
      try {
        const result = await response.json();
        if (onRawExchange) {
          try {
            onRawExchange({
              rawRequest,
              rawResponse: { status: responseStatus, headers: responseHeaders, body: result },
            });
          } catch { /* ignore */ }
        }
        yield* this.#emitJsonCompletion(result, { context, requestIdentity, wireBody, signal, replayUnsafe });
        return;
      } catch (err) {
        const classified = classifyFetchError(err, { providerLabel: 'Chat Completions', signal });
        if (replayUnsafe && classified && typeof classified === 'object' && !(classified instanceof LLMAbortError)) {
          classified.replayUnsafe = true;
        }
        throw classified;
      }
    }

    if (!response.body) {
      const err = new LLMServerError('Chat Completions returned no response body', 0);
      if (replayUnsafe) err.replayUnsafe = true;
      throw err;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const sseLines = new SseLineBuffer();
    const rawSseBody = createBoundedTextAccumulator(rawExchangeMaxBytes);

    let responseId;
    let responseModel;
    let finishReason = null;
    let sawDone = false;
    let usage = null;
    let textContent = '';
    let refusalText = '';
    let reasoningText = '';
    let reasoningField = null;
    let reasoningOpaque = '';
    let malformedStream = false;
    let streamError = null;
    let toolInputError = null;
    const toolSlots = new Map();
    let lastToolSlotIndex = null;

    const hasAnyTools = () => toolSlots.size > 0;

    const processSseLine = function* (rawLine) {
      const line = rawLine.trimEnd();
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data) return;
      if (data === '[DONE]') {
        sawDone = true;
        return;
      }
      if (signal?.aborted) throw new LLMAbortError();

      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        malformedStream = true;
        return;
      }

      if (chunk?.error) {
        streamError = classifyStreamErrorPayload(chunk, response);
        return;
      }
      if (chunk?.id) responseId = chunk.id;
      if (chunk?.model) responseModel = chunk.model;
      if (chunk?.usage) usage = chunk.usage;

      const choices = Array.isArray(chunk?.choices) ? chunk.choices : [];
      if (choices.length === 0) return;
      const choice = choices.find(c => c?.index === 0) || choices[0];
      if (!choice) return;

      if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
        finishReason = choice.finish_reason;
      }

      const delta = choice.delta || {};

      // Reasoning text deltas (Copilot: reasoning_text; DeepSeek/OpenRouter: reasoning_content / reasoning)
      const reasoning = extractReasoningFields(delta);
      if (reasoning.text) {
        if (!reasoningField) reasoningField = reasoning.field;
        reasoningText += reasoning.text;
        yield { type: 'thinking_delta', text: reasoning.text };
      }
      if (reasoning.opaque) {
        reasoningOpaque = reasoning.opaque;
        yield { type: 'provider_activity' };
      }

      // Visible text content & refusal
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        textContent += delta.content;
        yield { type: 'text_delta', text: delta.content };
      }
      if (typeof delta.refusal === 'string' && delta.refusal.length > 0) {
        refusalText += delta.refusal;
        yield { type: 'provider_activity' };
      }

      // Streaming tool call deltas
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
        for (const tcDelta of delta.tool_calls) {
          if (!tcDelta || typeof tcDelta !== 'object') {
            toolInputError = new LLMToolInputError('Chat Completions returned invalid tool call delta');
            continue;
          }
          if (tcDelta.type && tcDelta.type !== 'function') {
            toolInputError = new LLMToolInputError('Chat Completions returned unsupported tool call type');
            continue;
          }
          const hasExplicitIndex = Number.isSafeInteger(tcDelta.index) && tcDelta.index >= 0;
          const idx = hasExplicitIndex
            ? tcDelta.index
            : (!tcDelta.id && lastToolSlotIndex !== null && toolSlots.has(lastToolSlotIndex)
              ? lastToolSlotIndex
              : toolSlots.size);
          let slot = toolSlots.get(idx);
          if (!slot) {
            slot = { index: idx, id: '', name: '', arguments: '' };
            toolSlots.set(idx, slot);
          }
          lastToolSlotIndex = idx;
          let emittedToolActivity = false;
          if (typeof tcDelta.id === 'string' && tcDelta.id) {
            if (slot.id && slot.id !== tcDelta.id) {
              toolInputError = new LLMToolInputError('Chat Completions returned inconsistent tool call identity');
            } else {
              slot.id = tcDelta.id;
              emittedToolActivity = true;
            }
          }
          if (tcDelta.function && typeof tcDelta.function === 'object') {
            if (typeof tcDelta.function.name === 'string' && tcDelta.function.name) {
              slot.name += tcDelta.function.name;
              emittedToolActivity = true;
            }
            if (typeof tcDelta.function.arguments === 'string' && tcDelta.function.arguments.length > 0) {
              slot.arguments += tcDelta.function.arguments;
              emittedToolActivity = true;
            }
          }
          if (emittedToolActivity) yield { type: 'provider_activity' };
        }
      }
    };

    try {
      while (true) {
        const { done, value } = await readStreamChunkWithIdleTimeout(reader, {
          signal,
          idleMs,
          providerLabel: 'Chat Completions',
        });
        if (signal?.aborted) throw new LLMAbortError();
        if (done) break;
        const chunkText = decoder.decode(value, { stream: true });
        rawSseBody.push(chunkText);

        for (const rawLine of sseLines.push(chunkText)) {
          yield* processSseLine(rawLine);
          if (streamError) break;
        }
        if (streamError) break;
      }

      // Flush decoder / trailing partial SSE line
      if (!streamError) {
        const tail = decoder.decode();
        const remaining = [...sseLines.push(tail)];
        if (sseLines.pending) remaining.push(sseLines.pending);
        for (const rawLine of remaining) {
          yield* processSseLine(rawLine);
          if (streamError) break;
        }
      }

      if (signal?.aborted) throw new LLMAbortError();

      if (streamError) {
        if (usage) yield buildUsageEvent(usage);
        const retryable = !replayUnsafe && (streamError instanceof LLMRateLimitError || streamError instanceof LLMServerError);
        yield unusable({ type: 'error', error: streamError, retryable });
        return;
      }

      yield buildUsageEvent(usage);
      yield {
        type: 'provider_metadata',
        metadata: {
          protocol: 'openai-chat-completions',
          responseId,
          model: responseModel || model,
          stopReason: finishReason,
        },
      };

      if (malformedStream) {
        if (toolInputError || hasAnyTools()) {
          yield unusable({ type: 'error', error: new LLMToolInputError('Chat Completions returned a malformed tool stream'), retryable: false });
          return;
        }
        throw new LLMServerError('Chat Completions returned a malformed stream event', 0);
      }

      if (!finishReason) {
        if (sawDone && !hasAnyTools() && textContent) {
          finishReason = 'stop';
        } else {
          throw new LLMServerError(
            hasAnyTools()
              ? 'Chat Completions tool stream ended before finish_reason'
              : 'Chat Completions stream ended before finish_reason',
            0,
          );
        }
      }

      const orderedSlots = [...toolSlots.values()].sort((a, b) => a.index - b.index);
      const rawCalls = orderedSlots.map(slot => ({
        id: slot.id,
        type: 'function',
        function: { name: slot.name, arguments: slot.arguments },
      }));

      const filtered = finishReason === 'content_filter';
      if (filtered) {
        let calls = [];
        let runnable = !toolInputError && orderedSlots.length > 0;
        if (runnable) {
          try { calls = projectChatToolCalls(rawCalls, false); } catch (err) {
            if (!(err instanceof LLMToolInputError)) throw err;
            runnable = false;
          }
        }
        if (runnable) {
          for (const call of calls) yield call;
          yield {
            type: 'stop',
            stopReason: 'tool_use',
            stopDetails: contentFilterStopDetails({
              reason: 'content_filter',
              calledNames: [],
              declaredNames: declaredToolNames(wireBody.tools),
            }),
          };
          return;
        }
        yield unusable({
          type: 'stop',
          stopReason: 'refusal',
          stopDetails: contentFilterStopDetails({
            reason: 'content_filter',
            calledNames: orderedSlots.map(slot => slot.name),
            declaredNames: declaredToolNames(wireBody.tools),
          }),
        });
        return;
      }

      if (toolInputError) {
        yield unusable({ type: 'error', error: toolInputError, retryable: false });
        return;
      }

      let toolCalls = [];
      try {
        toolCalls = projectChatToolCalls(rawCalls, finishReason === 'length');
      } catch (err) {
        if (!(err instanceof LLMToolInputError)) throw err;
        yield unusable({ type: 'error', error: err, retryable: false });
        return;
      }

      const hasNativeReasoning = Boolean(reasoningOpaque || reasoningText);
      if (hasNativeReasoning) {
        const nativeItem = buildNativeMessageItem({
          content: textContent,
          toolCalls: orderedSlots,
          reasoningText,
          reasoningField,
          reasoningOpaque,
        });
        const state = createProviderState({
          context,
          identity: requestIdentity,
          items: [nativeItem],
          responseId,
          requestBody: wireBody,
        });
        if (state) {
          yield { type: 'provider_state', providerState: state, providerStateBytes: providerStateBytes(state) };
        }
      }

      for (const call of toolCalls) {
        if (signal?.aborted) throw new LLMAbortError();
        yield call;
      }

      if (refusalText && !textContent && toolCalls.length === 0 && finishReason === 'stop') {
        yield unusable({ type: 'stop', stopReason: 'refusal' });
        return;
      }

      yield unusable({ type: 'stop', stopReason: mapFinishReason(finishReason, toolCalls.length > 0) });
    } catch (err) {
      if (err instanceof LLMToolInputError) {
        yield unusable({ type: 'error', error: err, retryable: false });
      } else {
        const classified = classifyFetchError(err, { providerLabel: 'Chat Completions', signal });
        if (replayUnsafe && classified && typeof classified === 'object' && !(classified instanceof LLMAbortError)) {
          classified.replayUnsafe = true;
        }
        throw classified;
      }
    } finally {
      try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* best-effort */ }
      try { reader.releaseLock(); } catch { /* noop */ }
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

  async *#emitJsonCompletion(result, { context, requestIdentity, wireBody, signal, replayUnsafe = false }) {
    const unusable = event => (replayUnsafe ? { ...event, replayUnsafe: true } : event);
    if (result?.error) {
      const err = classifyStreamErrorPayload(result, null);
      if (replayUnsafe && err && typeof err === 'object') err.replayUnsafe = true;
      throw err;
    }
    const choices = Array.isArray(result?.choices) ? result.choices : [];
    const choice = choices.find(c => c?.index === 0) || choices[0];
    if (!choice) {
      throw new LLMServerError('Chat Completions returned no choices', 0);
    }
    const message = choice.message || {};
    const finishReason = choice.finish_reason || null;
    const content = typeof message.content === 'string' ? message.content : '';
    const refusal = typeof message.refusal === 'string' ? message.refusal : '';
    const reasoning = extractReasoningFields(message);
    const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

    if (reasoning.text) yield { type: 'thinking_delta', text: reasoning.text };
    else if (reasoning.opaque) yield { type: 'provider_activity' };
    if (content) yield { type: 'text_delta', text: content };
    else if (refusal) yield { type: 'provider_activity' };

    yield buildUsageEvent(result.usage);
    yield {
      type: 'provider_metadata',
      metadata: {
        protocol: 'openai-chat-completions',
        responseId: result.id,
        model: result.model || wireBody.model,
        stopReason: finishReason,
      },
    };

    if (finishReason === 'content_filter') {
      let calls = [];
      let runnable = rawToolCalls.length > 0;
      if (runnable) {
        try { calls = projectChatToolCalls(rawToolCalls, false); } catch (err) {
          if (!(err instanceof LLMToolInputError)) throw err;
          runnable = false;
        }
      }
      if (runnable) {
        for (const call of calls) yield call;
        yield {
          type: 'stop',
          stopReason: 'tool_use',
          stopDetails: contentFilterStopDetails({
            reason: 'content_filter',
            calledNames: [],
            declaredNames: declaredToolNames(wireBody.tools),
          }),
        };
        return;
      }
      yield unusable({
        type: 'stop',
        stopReason: 'refusal',
        stopDetails: contentFilterStopDetails({
          reason: 'content_filter',
          calledNames: rawToolCalls.map(tc => tc?.function?.name),
          declaredNames: declaredToolNames(wireBody.tools),
        }),
      });
      return;
    }

    let toolCalls = [];
    try {
      toolCalls = projectChatToolCalls(rawToolCalls, finishReason === 'length');
    } catch (err) {
      if (!(err instanceof LLMToolInputError)) throw err;
      yield unusable({ type: 'error', error: err, retryable: false });
      return;
    }

    if (reasoning.opaque || reasoning.text) {
      const nativeItem = buildNativeMessageItem({
        content,
        toolCalls: rawToolCalls.map(tc => ({
          id: tc.id,
          name: tc.function?.name || '',
          arguments: tc.function?.arguments || '',
        })),
        reasoningText: reasoning.text,
        reasoningField: reasoning.field,
        reasoningOpaque: reasoning.opaque,
      });
      const state = createProviderState({
        context,
        identity: requestIdentity,
        items: [nativeItem],
        responseId: result.id,
        requestBody: wireBody,
      });
      if (state) {
        yield { type: 'provider_state', providerState: state, providerStateBytes: providerStateBytes(state) };
      }
    }

    for (const call of toolCalls) {
      if (signal?.aborted) throw new LLMAbortError();
      yield call;
    }
    if (refusal && !content && toolCalls.length === 0 && finishReason === 'stop') {
      yield unusable({ type: 'stop', stopReason: 'refusal' });
      return;
    }
    yield unusable({ type: 'stop', stopReason: mapFinishReason(finishReason, toolCalls.length > 0) });
  }

  async call(params) {
    const {
      maxTokens = 4096,
      requestIdentity,
      signal,
      onRequestStart,
      getHeadersTimeoutMs,
      onResponseHeaders,
      maxRequestBodyBytes,
    } = params;
    if (signal?.aborted) throw new LLMAbortError();

    const { context, requestBody, cacheKeySent } = this.#buildRequestBody({
      ...params,
      maxTokens,
      stream: false,
    });
    const url = this.#endpointUrl();
    const headers = this.#headersForRequest();

    const { response, errorBody, body: wireBody } = await this.#dispatch({
      url,
      headers,
      requestBody,
      signal,
      getHeadersTimeoutMs,
      onResponseHeaders,
      maxRequestBodyBytes,
      cacheKeySent,
      context,
      onProviderDiagnostics: params.onProviderDiagnostics,
      onRequestStart,
    });

    if (!response.ok) {
      throw this.#classifyError(response.status, errorBody, response);
    }

    const result = await response.json();
    if (result?.error) {
      throw classifyStreamErrorPayload(result, response);
    }
    const choices = Array.isArray(result?.choices) ? result.choices : [];
    const choice = choices.find(c => c?.index === 0) || choices[0];
    if (!choice) {
      throw new LLMServerError('Chat Completions returned no choices', 0);
    }
    const message = choice.message || {};
    const finishReason = choice.finish_reason || null;
    const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const filtered = finishReason === 'content_filter';
    if (!filtered) {
      projectChatToolCalls(rawToolCalls, finishReason === 'length');
    }

    const content = typeof message.content === 'string' ? message.content : '';
    const refusal = typeof message.refusal === 'string' ? message.refusal : '';
    const reasoning = extractReasoningFields(message);
    let providerState = null;
    if (!filtered && (reasoning.opaque || reasoning.text)) {
      const nativeItem = buildNativeMessageItem({
        content,
        toolCalls: rawToolCalls.map(tc => ({
          id: tc.id,
          name: tc.function?.name || '',
          arguments: tc.function?.arguments || '',
        })),
        reasoningText: reasoning.text,
        reasoningField: reasoning.field,
        reasoningOpaque: reasoning.opaque,
      });
      providerState = createProviderState({
        context,
        identity: requestIdentity,
        items: [nativeItem],
        responseId: result.id,
        requestBody: wireBody,
      });
    }

    const usage = buildUsageEvent(result.usage);
    const { type: _usageType, ...usageBody } = usage;
    const stopReason = refusal && !content && rawToolCalls.length === 0 && finishReason === 'stop'
      ? 'refusal'
      : mapFinishReason(finishReason, rawToolCalls.length > 0);
    return {
      text: content,
      providerState,
      stopReason,
      usage: usageBody,
    };
  }
}
