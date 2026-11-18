/** Native Gemini GenerateContent transport (no SDK or OpenAI translation). */
import { randomUUID } from 'node:crypto';
import { getThinkingCapability, getModelEffortOptions, normalizeEffort, geminiThinkingBudgetForEffort } from '../models.js';
import {
  LLMAdapter, LLMRateLimitError, LLMServerError, LLMToolInputError, LLMContextError,
  LLMAbortError, classifyAuthError, classifyFetchError, retryAfterFromResponse,
  readStreamChunkWithIdleTimeout, resolveStreamIdleTimeoutMs, SseLineBuffer,
  createBoundedTextAccumulator, redactRawRequest, safeHeaders, toWellFormedJson,
} from './adapter.js';
import {
  createProviderContext, createProviderState, replayProviderState, providerStateBytes, hasSignedProviderState, ProviderStateError,
} from './provider-state.js';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const refusalReasons = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII',
  'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION', 'ESCALATION', 'PUP_LIMITED_DISABLED']);

/** Synthetic IDs are local projection only: NEVER insert them into signed native parts.
 * Persist the resulting toolCallId on the state wrapper, outside its native part.
 */
export function projectGeminiToolCalls(items) {
  const prefix = randomUUID();
  const ids = new Set();
  return items.flatMap((part, index) => {
    if (!part?.functionCall) return [];
    const fc = part.functionCall;
    if (typeof fc.name !== 'string' || !fc.name.trim() || (fc.args !== undefined && !record(fc.args))
        || (fc.id !== undefined && (typeof fc.id !== 'string' || !fc.id))) {
      throw new LLMToolInputError('Gemini returned invalid or incomplete function arguments');
    }
    const id = fc.id || `gemini-${prefix}-${index}`;
    if (ids.has(id)) throw new LLMToolInputError('Gemini returned duplicate function call IDs');
    ids.add(id);
    return [{ id, name: fc.name, input: structuredClone(fc.args ?? {}) }];
  });
}

function imagePart(part) {
  if (part.type === 'image' && part.source?.type === 'base64') {
    return { inlineData: { mimeType: part.source.media_type, data: part.source.data } };
  }
  const url = part.image_url?.url || (part.source?.type === 'url' ? part.source.url : null);
  if (url) {
    const inline = /^data:([^;,]+);base64,([\s\S]+)$/.exec(url);
    if (inline) return { inlineData: { mimeType: inline[1], data: inline[2] } };
    return { fileData: { fileUri: url, ...(part.mimeType ? { mimeType: part.mimeType } : {}) } };
  }
  if (part.inlineData || part.fileData) return structuredClone(part);
  return null;
}

function contentParts(content) {
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  return (Array.isArray(content) ? content : []).flatMap(part => {
    if (part?.type === 'text' && typeof part.text === 'string') return [{ text: part.text }];
    const image = part && imagePart(part);
    if (image) return [image];
    throw new Error('Unsupported Gemini input content part');
  });
}

/** Gemini prompt/cache counts include cache, but candidate counts EXCLUDE thoughts.
 * Unified outputTokens includes thoughts (reasoningTokens is its subset).
 */
function usageEvent(usage = {}) {
  const valid = value => Number.isSafeInteger(value) && value >= 0;
  const counts = {
    inputTokens: usage.promptTokenCount,
    outputTokens: valid(usage.candidatesTokenCount) ? usage.candidatesTokenCount + (usage.thoughtsTokenCount || 0) : undefined,
    reasoningTokens: usage.thoughtsTokenCount,
    cacheReadTokens: usage.cachedContentTokenCount,
  };
  return { type: 'usage', inputTokens: counts.inputTokens || 0, outputTokens: counts.outputTokens || 0,
    ...(valid(counts.reasoningTokens) ? { reasoningTokens: counts.reasoningTokens } : {}),
    cacheReadTokens: counts.cacheReadTokens || 0, cacheWriteTokens: 0, cacheTokensAreIncludedInInput: true,
    reportedTokenFields: Object.keys(counts).filter(key => valid(counts[key])),
    usageIncomplete: !valid(counts.inputTokens) || !valid(counts.outputTokens) };
}

function stopReason(reason, hasTools) {
  if (reason === 'STOP') return hasTools ? 'tool_use' : 'end_turn';
  if (reason === 'MAX_TOKENS' || reason === 'CONTINUATION') return 'max_tokens';
  if (refusalReasons.has(reason)) return 'refusal';
  return 'unknown';
}

export class GeminiAdapter extends LLMAdapter {
  constructor({ apiKey, baseUrl = DEFAULT_BASE_URL, headers = {}, extraHeaders = {},
    streamIdleTimeoutMs = 0, highEffortStreamIdleTimeoutMs } = {}) {
    super({ apiKey, baseUrl, headers: { ...headers, ...extraHeaders }, streamIdleTimeoutMs, highEffortStreamIdleTimeoutMs });
  }

  #url(model, streaming) {
    const url = new URL(this.config.baseUrl);
    const resource = `models/${encodeURIComponent(String(model).replace(/^models\//, ''))}`;
    let path = url.pathname.replace(/\/+$/, '');
    if (!path) path = '/v1beta';
    // Also accept a full custom endpoint or a base ending in /models.
    if (/\/models\/[^/]+:(?:streamGenerateContent|generateContent)$/.test(path)) {
      path = path.replace(/\/models\/[^/]+:(?:streamGenerateContent|generateContent)$/, `/${resource}:${streaming ? 'streamGenerateContent' : 'generateContent'}`);
    } else path += `${path.endsWith('/models') ? `/${resource.slice(7)}` : `/${resource}`}:${streaming ? 'streamGenerateContent' : 'generateContent'}`;
    url.pathname = path;
    url.searchParams.delete('key'); // API keys belong in the header, never trace URLs.
    if (streaming) url.searchParams.set('alt', 'sse');
    else url.searchParams.delete('alt');
    return url.toString();
  }

  #request(params) {
    const { model, system, messages = [], tools, requestIdentity, extraBody = {}, maxTokens = 16384 } = params;
    const context = params.providerContext || createProviderContext({ protocol: 'gemini',
      baseUrl: this.config.baseUrl, staticApiKey: this.config.apiKey, model });
    const contents = [];
    const systems = system ? contentParts(system) : [];
    const calls = new Map();
    const resolved = new Set();
    const append = (role, parts, merge = false) => {
      if (!parts.length) return;
      if (merge && contents.at(-1)?.role === role) contents.at(-1).parts.push(...parts);
      else contents.push({ role, parts });
    };
    for (const msg of messages) {
      if (msg.role === 'system') { systems.push(...contentParts(msg.content)); continue; }
      if (msg.role === 'assistant') {
        const native = replayProviderState(msg, context, requestIdentity);
        if (hasSignedProviderState(msg.providerState) && !native) {
          throw new ProviderStateError('Gemini native parts cannot be safely replayed');
        }
        const projected = msg.toolCalls || [];
        let parts = native?.map(item => structuredClone(item.part));
        if (!parts) {
          parts = contentParts(msg.content);
          for (const tc of projected) parts.push({ functionCall: { id: tc.id, name: tc.name, args: tc.input } });
        }
        const nativeCalls = parts.filter(part => part.functionCall).map(part => part.functionCall);
        for (let i = 0; i < projected.length; i++) {
          const tc = projected[i];
          calls.set(tc.id, { name: tc.name, nativeId: nativeCalls[i]?.id });
        }
        append('model', parts);
      } else if (msg.role === 'tool') {
        const call = calls.get(msg.toolCallId);
        if (!call || resolved.has(msg.toolCallId)) throw new ProviderStateError('orphan or duplicate Gemini function response');
        resolved.add(msg.toolCallId);
        const parts = contentParts(msg.content);
        const text = parts.filter(part => typeof part.text === 'string').map(part => part.text).join('\n');
        const images = parts.filter(part => part.inlineData || part.fileData);
        const functionResponse = { name: call.name, ...(call.nativeId ? { id: call.nativeId } : {}),
          response: msg.isError ? { error: text } : { output: text },
          ...(images.length ? { parts: images } : {}) };
        append('user', [{ functionResponse }], true);
      } else if (msg.role === 'user') append('user', contentParts(msg.content), true);
    }
    const generationConfig = { maxOutputTokens: maxTokens };
    for (const key of ['temperature', 'topP', 'topK', 'seed', 'stopSequences', 'responseMimeType', 'responseJsonSchema']) {
      if (params[key] !== undefined) generationConfig[key] = params[key];
    }
    if (params.jsonMode) generationConfig.responseMimeType = 'application/json';
    const lowDetailImages = messages.some(msg => Array.isArray(msg.content)
      && msg.content.some(part => (part?.type === 'image' || part?.type === 'image_url') && part.detail === 'low'));
    if (lowDetailImages) generationConfig.mediaResolution = 'MEDIA_RESOLUTION_LOW';
    const effortContext = { ...params.effortContext, protocol: 'gemini' };
    const capability = getThinkingCapability(model, effortContext);
    const supportedEfforts = getModelEffortOptions(model, effortContext);
    const requestedEffort = normalizeEffort(params.effort);
    const effort = params.effortConstraint ? 'medium' : requestedEffort;
    if (effort && capability.supportsThinking && supportedEfforts.includes(effort)) {
      if (capability.maxBudgetTokens !== null) {
        let budget = geminiThinkingBudgetForEffort(model, effort);
        if (Number.isFinite(capability.maxBudgetTokens)) budget = Math.min(budget, capability.maxBudgetTokens);
        if (budget) generationConfig.thinkingConfig = { thinkingBudget: budget, includeThoughts: true };
      } else if (/gemini-3(?:[.-]|$)/i.test(model)) {
        const levels = { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high', ultra: 'high' };
        if (levels[effort]) generationConfig.thinkingConfig = { thinkingLevel: /gemini-3(?:\.0)?-pro/i.test(model) ? (['minimal', 'low', 'medium'].includes(effort) ? 'low' : 'high') : levels[effort], includeThoughts: true };
      }
    }
    const body = { ...extraBody, contents, generationConfig: { ...generationConfig, ...extraBody.generationConfig } };
    // These are ownership-bearing fields; extraBody cannot replace them.
    delete body.model;
    delete body.systemInstruction;
    if (systems.length) body.systemInstruction = { parts: systems };
    if (tools?.length) body.tools = [{ functionDeclarations: tools.map(tool => ({ name: tool.name,
      description: tool.description || '', parametersJsonSchema: tool.parameters })) }];
    body.generationConfig.candidateCount = 1;
    if (lowDetailImages) body.generationConfig.mediaResolution = 'MEDIA_RESOLUTION_LOW';
    if (Number.isFinite(params.contextOutputLimit) && body.generationConfig.maxOutputTokens > params.contextOutputLimit) {
      body.generationConfig.maxOutputTokens = Math.max(1, Math.floor(params.contextOutputLimit));
    }
    if (params.effortConstraint && !capability.supportsThinking) delete body.generationConfig.thinkingConfig;
    if (params.effortConstraint) {
      const config = body.generationConfig.thinkingConfig;
      if (config?.thinkingBudget > 8192 || config?.thinkingBudget === -1) body.generationConfig.thinkingConfig = { ...config, thinkingBudget: 8192 };
      if (config?.thinkingLevel && !['minimal', 'low', 'medium'].includes(config.thinkingLevel)) {
        body.generationConfig.thinkingConfig = { ...config, thinkingLevel: /gemini-3(?:\.0)?-pro/i.test(model) ? 'low' : 'medium' };
      }
    }
    const thinking = body.generationConfig.thinkingConfig;
    if (thinking?.thinkingLevel !== undefined && thinking?.thinkingBudget !== undefined) {
      throw new Error('Gemini thinkingLevel and thinkingBudget are mutually exclusive');
    }
    const effectiveEffort = thinking?.thinkingLevel
      ? ({ minimal: 'medium', low: 'medium', medium: 'medium', high: 'max' })[thinking.thinkingLevel]
      : thinking?.thinkingBudget > 0
        ? ['medium', 'xhigh', 'max'].find(level => thinking.thinkingBudget <= geminiThinkingBudgetForEffort(model, level)) || 'ultra' : null;
    params.onEffortDecision?.({ requested: params.effort || null, effective: effectiveEffort || null, source: params.effortSource || 'scenario', model, cap: params.effortConstraint ? 'medium' : null, thinkingEnabled: Boolean(thinking), wireMode: thinking?.thinkingLevel ? 'thinking-level' : thinking ? 'manual' : 'omitted', ...(thinking?.thinkingBudget !== undefined ? { budgetTokens: thinking.thinkingBudget } : {}) });
    // Implicit caching has no client toggle or cache ID. Only claim the
    // documented provider policy for native Google routes, not custom proxies.
    const promptCaching = context.diagnostics?.capabilitySource === 'native-endpoint' && context.capabilities.promptCaching
      ? 'implicit' : 'provider-managed-unverified';
    params.onProviderDiagnostics?.({ ...context.diagnostics, nativeReasoningState: Boolean(context.capabilities.nativeReasoningState), promptCaching });
    return { body: toWellFormedJson(body), context };
  }

  #error(status, body, response) {
    if (status === 400 && /API_KEY_INVALID|API key not valid/i.test(body)) return classifyAuthError(401, body, { provider: 'gemini' });
    if (status === 401 || status === 403) return classifyAuthError(status, body, { provider: 'gemini' });
    if (status === 429 || status === 529) return new LLMRateLimitError(`Gemini rate limited (HTTP ${status})`, status, retryAfterFromResponse(response));
    if (status === 413 || /(?:input|prompt|context)[^\n]{0,80}(?:too (?:long|large)|exceed|token limit)/i.test(body)) return new LLMContextError('Gemini context limit exceeded');
    if (status >= 500) return new LLMServerError(`Gemini server error (HTTP ${status})`, status);
    return new Error(`Gemini API error (HTTP ${status})`);
  }

  async *#events(params, streaming) {
    const { signal, onRawExchange, rawExchangeMaxBytes = 512 * 1024 } = params;
    if (signal?.aborted) throw new LLMAbortError();
    const { body, context } = this.#request(params);
    const url = this.#url(params.model, streaming);
    const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': this.config.apiKey, ...this.config.headers };
    const rawRequest = redactRawRequest({ url, method: 'POST', headers, body });
    const raw = createBoundedTextAccumulator(rawExchangeMaxBytes);
    let response;
    let reader;
    const parts = [];
    let finish;
    let responseId;
    let modelVersion;
    let usage = {};
    const idleMs = resolveStreamIdleTimeoutMs(this.config, params.effort, params.streamIdleTimeoutMs);
    const consume = function* (result) {
      if (signal?.aborted) throw new LLMAbortError();
      if (result.error) throw this.#error(Number(result.error.code) || 500, JSON.stringify(result.error));
      if (result.responseId) responseId = result.responseId;
      if (result.modelVersion) modelVersion = result.modelVersion;
      if (result.usageMetadata) usage = { ...usage, ...result.usageMetadata };
      if (result.promptFeedback?.blockReason && result.promptFeedback.blockReason !== 'BLOCK_REASON_UNSPECIFIED') {
        finish = refusalReasons.has(result.promptFeedback.blockReason) ? result.promptFeedback.blockReason : 'SAFETY';
      }
      const candidates = result.candidates || [];
      if (candidates.length > 1 || (candidates[0]?.index !== undefined && candidates[0].index !== 0)) throw new LLMServerError('Gemini returned unexpected multiple candidates', 0);
      const candidate = candidates[0];
      if (candidate?.finishReason) finish = candidate.finishReason;
      for (const part of candidate?.content?.parts || []) {
        parts.push(structuredClone(part));
        if (typeof part.text === 'string' && part.text) yield { type: part.thought ? 'thinking_delta' : 'text_delta', text: part.text };
        else if (part.thoughtSignature || part.functionCall) yield { type: 'provider_activity' };
      }
    }.bind(this);
    try {
      params.onRequestStart?.({ effort: params.effort, streamIdleTimeoutMs: idleMs });
      response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
      if (!response.ok) {
        const text = await response.text(); raw.push(text);
        throw this.#error(response.status, text, response);
      }
      if (!streaming || (response.headers?.get('content-type') || '').includes('application/json')) {
        const result = await response.json(); raw.push(JSON.stringify(result));
        yield* consume(result);
      } else {
        if (!response.body) throw new LLMServerError('Gemini returned no response body', 0);
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        const lines = new SseLineBuffer();
        let data = [];
        const lineEvents = function* (line) {
          if (line.endsWith('\r')) line = line.slice(0, -1);
          if (!line) {
            if (!data.length) return;
            const payload = data.join('\n'); data = [];
            if (payload === '[DONE]') return;
            let result;
            try { result = JSON.parse(payload); }
            catch { throw new LLMToolInputError('Gemini returned malformed stream JSON; tool batch rejected'); }
            yield* consume(result);
          } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        };
        while (true) {
          const chunk = await readStreamChunkWithIdleTimeout(reader, { signal, idleMs, providerLabel: 'Gemini' });
          if (signal?.aborted) throw new LLMAbortError();
          if (chunk.done) break;
          const text = decoder.decode(chunk.value, { stream: true }); raw.push(text);
          for (const line of lines.push(text)) yield* lineEvents(line);
        }
        const tail = decoder.decode();
        for (const line of lines.push(tail)) yield* lineEvents(line);
        const pending = lines.pending;
        if (pending) yield* lineEvents(pending);
        yield* lineEvents('');
      }
      yield usageEvent(usage);
      if (signal?.aborted) throw new LLMAbortError();
      const hasTools = parts.some(part => part.functionCall);
      const reason = stopReason(finish, hasTools);
      yield { type: 'provider_metadata', metadata: { protocol: 'gemini', responseId, model: modelVersion || params.model, stopReason: finish || null } };
      if (!finish) throw hasTools ? new LLMToolInputError('Gemini stream ended before function batch completed') : new LLMServerError('Gemini stream ended without finishReason', 0);
      if (['MALFORMED_FUNCTION_CALL', 'UNEXPECTED_TOOL_CALL', 'TOO_MANY_TOOL_CALLS', 'MALFORMED_RESPONSE', 'MISSING_THOUGHT_SIGNATURE'].includes(finish)) {
        throw new LLMToolInputError(`Gemini rejected function batch (${finish})`);
      }
      if (hasTools && reason !== 'tool_use') {
        if (reason === 'max_tokens') throw new LLMToolInputError('Gemini function batch was truncated');
      } else if (reason === 'end_turn' || reason === 'tool_use' || reason === 'max_tokens') {
        const toolCalls = projectGeminiToolCalls(parts); // Validate the ENTIRE batch before publishing any call.
        let callIndex = 0;
        const items = parts.map(part => ({ type: 'part', part, ...(part.functionCall ? { toolCallId: toolCalls[callIndex++].id } : {}) }));
        const state = createProviderState({ context, identity: params.requestIdentity, items, responseId, requestBody: body });
        if (parts.some(part => part.thoughtSignature) && hasTools && !state) {
          throw new ProviderStateError('signed Gemini function calls require native state ownership');
        }
        if (state) yield { type: 'provider_state', providerState: state, providerStateBytes: providerStateBytes(state) };
        for (const tc of toolCalls) {
          if (signal?.aborted) throw new LLMAbortError();
          yield { type: 'tool_call', ...tc };
        }
      }
      yield { type: 'stop', stopReason: reason };
    } catch (error) {
      const classified = classifyFetchError(error, { providerLabel: 'Gemini', signal });
      if (classified instanceof LLMToolInputError) yield { type: 'error', error: classified, retryable: false };
      else throw classified;
    } finally {
      if (reader) {
        try { await reader.cancel(); } catch { /* best effort */ }
        reader.releaseLock();
      }
      if (response && onRawExchange) {
        try { onRawExchange({ rawRequest, rawResponse: { status: response.status, headers: safeHeaders(response), body: raw.text(), truncated: raw.truncated, totalBytes: raw.totalBytes } }); } catch { /* diagnostics only */ }
      }
    }
  }

  async *stream(params) { yield* this.#events(params, true); }

  async call(params) {
    const result = { text: '', stopReason: 'unknown', usage: { inputTokens: 0, outputTokens: 0 } };
    for await (const event of this.#events({ maxTokens: 4096, ...params }, false)) {
      if (event.type === 'text_delta') result.text += event.text;
      else if (event.type === 'usage') { const { type, ...usage } = event; result.usage = usage; }
      else if (event.type === 'provider_state') result.providerState = event.providerState;
      else if (event.type === 'stop') result.stopReason = event.stopReason;
      else if (event.type === 'error') throw event.error;
    }
    return result;
  }
}
