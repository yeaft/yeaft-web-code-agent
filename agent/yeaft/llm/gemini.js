/** Native Gemini GenerateContent transport (no SDK or OpenAI translation). */
import { randomUUID } from 'node:crypto';
import { getThinkingCapability, getGeminiThinkingProfile, resolveGeminiEffort, geminiThinkingBudgetForEffort } from '../models.js';
import { GEMINI_BASE_URL, geminiModelsUrl } from './gemini-endpoint.js';
import { EFFORT_LEVELS, resolveSubAgentEffort } from '../effort.js';
import { imageMimeFromBase64 } from '../image-dimensions.js';
import {
  LLMAdapter, LLMRateLimitError, LLMServerError, LLMToolInputError, LLMContextError,
  LLMAbortError, LLMRequestTooLargeError, serializeModelRequestBody, classifyAuthError, classifyFetchError, retryAfterFromResponse,
  readStreamChunkWithIdleTimeout, resolveStreamIdleTimeoutMs, SseLineBuffer,
  createBoundedTextAccumulator, redactRawRequest, safeHeaders, toWellFormedJson, contentFilterStopDetails,
} from './adapter.js';
import {
  createProviderContext, createProviderState, replayProviderState, providerStateBytes, hasSignedProviderState, ProviderStateError,
} from './provider-state.js';

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

/** True when a function batch passes the same validation as a normal tool_use response. */
function isCompleteGeminiBatch(parts) {
  try {
    return projectGeminiToolCalls(parts).length > 0;
  } catch (error) {
    if (error instanceof LLMToolInputError) return false;
    throw error;
  }
}

function imagePart(part) {
  // The bytes decide: extensions and upload types can be wrong.
  if (part.type === 'image' && part.source?.type === 'base64') {
    return { inlineData: { mimeType: imageMimeFromBase64(part.source.data) || part.source.media_type, data: part.source.data } };
  }
  const url = part.image_url?.url || (part.source?.type === 'url' ? part.source.url : null);
  if (url) {
    const inline = /^data:([^;,]+);base64,([\s\S]+)$/.exec(url);
    if (inline) return { inlineData: { mimeType: imageMimeFromBase64(inline[2]) || inline[1], data: inline[2] } };
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

/** Validate mutually constrained fields after runtime parameters are applied. */
function validateGeminiBody(body, tools = []) {
  const config = body.generationConfig;
  if (config.logprobs !== undefined && config.responseLogprobs !== true) {
    throw new Error('Gemini generationConfig.logprobs requires responseLogprobs: true');
  }
  const legacySchemas = ['responseSchema', 'responseJsonSchema', '_responseJsonSchema'].filter(key => config[key] !== undefined);
  if (legacySchemas.length > 1 || (config.responseFormat && (legacySchemas.length || config.responseMimeType))) {
    throw new Error('Gemini responseFormat and legacy response schema/MIME fields cannot be combined');
  }
  if (legacySchemas.length && !['application/json', 'text/x.enum'].includes(config.responseMimeType)) {
    throw new Error('Gemini response schema requires a compatible generationConfig.responseMimeType');
  }
  if (config.responseFormat?.text?.schema && config.responseFormat.text.mimeType !== 'APPLICATION_JSON') {
    throw new Error('Gemini responseFormat.text.schema requires APPLICATION_JSON');
  }
  const calling = body.toolConfig?.functionCallingConfig;
  if (calling?.allowedFunctionNames?.length) {
    if (!['ANY', 'VALIDATED'].includes(calling.mode)) {
      throw new Error('Gemini allowedFunctionNames requires ANY or VALIDATED mode');
    }
    const names = new Set(tools.map(tool => tool.name));
    if (calling.allowedFunctionNames.some(name => !names.has(name))) {
      throw new Error('Gemini allowedFunctionNames names must be available in the current request');
    }
  }
}

export class GeminiAdapter extends LLMAdapter {
  constructor({ apiKey, baseUrl = GEMINI_BASE_URL, headers = {}, extraHeaders = {},
    streamIdleTimeoutMs = 0, highEffortStreamIdleTimeoutMs } = {}) {
    super({ apiKey, baseUrl, headers: { ...headers, ...extraHeaders }, streamIdleTimeoutMs, highEffortStreamIdleTimeoutMs });
  }

  #url(model, streaming) {
    const url = geminiModelsUrl(this.config.baseUrl);
    const id = encodeURIComponent(String(model).replace(/^models\//, ''));
    url.pathname += `/${id}:${streaming ? 'streamGenerateContent' : 'generateContent'}`;
    url.searchParams.delete('key'); // API keys belong in the header, never trace URLs.
    if (streaming) url.searchParams.set('alt', 'sse');
    else url.searchParams.delete('alt');
    return url.toString();
  }

  #request(params) {
    const { model, system, messages = [], tools, requestIdentity, geminiOptions = {}, extraBody = {}, maxTokens = 16384 } = params;
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
          response: { [msg.isError ? 'error' : 'output']: text,
            ...(images.length && /(?:^|\/)gemini-2\.5-/.test(model) ? { attachmentNotice: 'Image tool output is not available on this model.' } : {}) },
          ...(images.length && !/(?:^|\/)gemini-2\.5-/.test(model) ? { parts: images } : {}) };
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
    const profile = getGeminiThinkingProfile(model, effortContext);
    const effort = resolveGeminiEffort(model, params.effort, capability.effortOptions);
    const body = { ...geminiOptions, ...extraBody, contents,
      generationConfig: { ...geminiOptions.generationConfig, ...generationConfig, ...extraBody.generationConfig } };
    // These are ownership-bearing fields; extraBody cannot replace them.
    delete body.model;
    delete body.systemInstruction;
    delete body.tools;
    if (systems.length) body.systemInstruction = { parts: systems };
    if (tools?.length) body.tools = [{ functionDeclarations: tools.map(tool => ({ name: tool.name,
      description: tool.description || '', parametersJsonSchema: tool.parameters })) }];
    body.generationConfig.maxOutputTokens = maxTokens;
    body.generationConfig.candidateCount = 1;
    if (lowDetailImages) body.generationConfig.mediaResolution = 'MEDIA_RESOLUTION_LOW';
    if (Number.isFinite(params.contextOutputLimit) && body.generationConfig.maxOutputTokens > params.contextOutputLimit) {
      body.generationConfig.maxOutputTokens = Math.max(1, Math.floor(params.contextOutputLimit));
    }
    const endpoint = geminiModelsUrl(this.config.baseUrl);
    const google = endpoint.hostname === 'generativelanguage.googleapis.com';
    const beta = endpoint.pathname === '/v1beta/models';
    // These fields would transfer Session/logging ownership outside the runtime.
    delete body.store;
    delete body.continuationToken;
    if (body.cachedContent !== undefined) {
      if (!google || !beta || /(?:^|\/)gemini-4-/.test(model) || typeof body.cachedContent !== 'string' || !/^cachedContents\/[^/\s]+$/.test(body.cachedContent)) {
        throw new Error('Gemini explicit cachedContent requires a supported v1beta GenerateContent model and a cachedContents resource name');
      }
      if (body.systemInstruction || body.tools?.length || body.toolConfig) {
        throw new Error('Gemini explicit cachedContent cannot be combined with inline system instructions, tools or tool configuration');
      }
    }
    if (!body.tools?.length) delete body.toolConfig;
    if (google && !beta) {
      delete body.labels;
      for (const key of ['speechConfig', 'audioTranscriptionConfig', 'translationConfig', 'enableAffectiveDialog']) delete body.generationConfig[key];
    }
    const child = params.effortConstraint && resolveSubAgentEffort({ model, protocol: 'gemini', effortContext,
      parentDecision: params.effortConstraint.parentDecision });
    let thinking = body.generationConfig.thinkingConfig;
    if (!capability.supportsThinking) thinking = undefined;
    else if (child || effort) {
      const lower = (left, right) => left && EFFORT_LEVELS.indexOf(left) <= EFFORT_LEVELS.indexOf(right) ? left : right;
      const configured = typeof thinking?.thinkingLevel === 'string' && thinking.thinkingLevel.toLowerCase();
      const constrained = child
        ? lower(effort || (capability.effortOptions.includes(configured) ? configured : null), child.effective)
        : effort;
      const includeThoughts = typeof thinking?.includeThoughts === 'boolean' ? thinking.includeThoughts : true;
      if (profile.levels) thinking = { thinkingLevel: constrained.toUpperCase(), includeThoughts };
      else {
        const budget = Math.min(capability.maxBudgetTokens, geminiThinkingBudgetForEffort(model, constrained),
          ...(params.effortConstraint && thinking?.thinkingBudget >= 0 ? [thinking.thinkingBudget] : []));
        thinking = { thinkingBudget: budget === 0 && profile.off ? 0 : Math.max(profile.minBudget, budget), includeThoughts };
      }
    } else if (thinking) {
      thinking = { ...thinking };
      if (thinking.thinkingLevel !== undefined && thinking.thinkingBudget !== undefined) {
        throw new Error('Gemini thinkingLevel and thinkingBudget are mutually exclusive');
      }
      if (thinking.thinkingLevel !== undefined) {
        const value = typeof thinking.thinkingLevel === 'string' ? thinking.thinkingLevel.toLowerCase() : '';
        if (!profile.levels?.includes(value) || !capability.effortOptions.includes(value)) throw new Error('Gemini thinkingLevel is not supported by this model');
        thinking.thinkingLevel = value.toUpperCase();
      }
      if (thinking.thinkingBudget !== undefined) {
        const budget = thinking.thinkingBudget;
        if (profile.levels || !Number.isSafeInteger(budget) || (budget !== -1 && !(budget === 0 && profile.off)
          && (budget < profile.minBudget || budget > capability.maxBudgetTokens))) throw new Error('Gemini thinkingBudget is not supported by this model');
      }
    }
    if (thinking) body.generationConfig.thinkingConfig = thinking;
    else delete body.generationConfig.thinkingConfig;
    validateGeminiBody(body, tools);
    const effectiveEffort = thinking?.thinkingLevel?.toLowerCase() || (thinking?.thinkingBudget > 0
      ? ['medium', 'xhigh', 'max'].find(level => thinking.thinkingBudget <= geminiThinkingBudgetForEffort(model, level)) : null);
    params.onEffortDecision?.({ requested: params.effort || null, effective: effectiveEffort || null, source: params.effortSource || 'scenario', model,
      cap: child?.cap ?? null, ...(child?.nativeEffortCap ? { nativeEffortCap: true } : {}), thinkingEnabled: Boolean(thinking && thinking.thinkingBudget !== 0),
      wireMode: thinking?.thinkingLevel ? 'thinking-level' : thinking ? 'manual' : child?.wireMode || 'omitted',
      ...(thinking?.thinkingLevel ? { thinkingLevel: thinking.thinkingLevel } : {}),
      ...(thinking?.thinkingBudget !== undefined ? { budgetTokens: thinking.thinkingBudget } : {}) });
    params.onProviderDiagnostics?.({ ...context.diagnostics, nativeReasoningState: Boolean(context.capabilities.nativeReasoningState),
      promptCaching: body.cachedContent ? 'explicit-reference'
        : google && context.capabilities.promptCaching ? 'implicit' : 'provider-managed-unverified' });
    return { body: toWellFormedJson(body), context };
  }

  #error(status, body, response) {
    if (status === 400 && /API_KEY_INVALID|API key not valid/i.test(body)) return classifyAuthError(401, body, { provider: 'gemini' });
    if (status === 401 || status === 403) return classifyAuthError(status, body, { provider: 'gemini' });
    if (status === 429 || status === 529) return new LLMRateLimitError(`Gemini rate limited (HTTP ${status})`, status, retryAfterFromResponse(response));
    if (/(?:input|prompt|context)[^\n]{0,80}(?:too (?:long|large)|exceed|token limit)/i.test(body)) return new LLMContextError('Gemini context limit exceeded');
    if (status >= 500) return new LLMServerError(`Gemini server error (HTTP ${status})`, status);
    return new Error(`Gemini API error (HTTP ${status})`);
  }

  async *#events(params, streaming) {
    const { signal, onRawExchange, rawExchangeMaxBytes = 512 * 1024 } = params;
    if (signal?.aborted) throw new LLMAbortError();
    const { body, context } = this.#request(params);
    const url = this.#url(params.model, streaming);
    // Inline requests on the public Gemini API are limited to 20 MB.
    const requestBodyLimit = Math.min(params.maxRequestBodyBytes ?? Infinity, 19_000_000);
    const { body: serialized, requestBytes } = serializeModelRequestBody(body, requestBodyLimit);
    const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': this.config.apiKey, ...this.config.headers };
    const rawRequest = redactRawRequest({ url, method: 'POST', headers, body });
    const raw = createBoundedTextAccumulator(rawExchangeMaxBytes);
    let response;
    let reader;
    const parts = [];
    let finish;
    let promptBlocked = false;
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
        promptBlocked = true;
      }
      const candidates = result.candidates || [];
      if (candidates.length > 1 || (candidates[0]?.index !== undefined && candidates[0].index !== 0)) throw new LLMServerError('Gemini returned unexpected multiple candidates', 0);
      const candidate = candidates[0];
      if (candidate?.finishReason) { finish = candidate.finishReason; promptBlocked = false; }
      for (const part of candidate?.content?.parts || []) {
        parts.push(structuredClone(part));
        if (typeof part.text === 'string' && part.text) yield { type: part.thought ? 'thinking_delta' : 'text_delta', text: part.text };
        else if (part.thoughtSignature || part.functionCall) yield { type: 'provider_activity' };
      }
    }.bind(this);
    try {
      params.onRequestStart?.({ effort: params.effort, streamIdleTimeoutMs: idleMs });
      response = await fetch(url, { method: 'POST', headers, body: serialized, signal });
      if (response.status === 413) {
        await response.body?.cancel().catch(() => {});
        throw new LLMRequestTooLargeError(requestBytes, { limitBytes: requestBodyLimit, received413: true });
      }
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
      // A response filter verdict judges generated content, not whether a delivered call may run:
      // complete calls stay under local tool permissions (relays such as llm-proxy drop cut-off
      // arguments). Prompt blocks and invalid batches are still withheld as a refusal.
      const runFiltered = reason === 'refusal' && hasTools && !promptBlocked && isCompleteGeminiBatch(parts);
      if (hasTools && reason !== 'tool_use' && !runFiltered) {
        if (reason === 'max_tokens') throw new LLMToolInputError('Gemini function batch was truncated');
      } else if (reason === 'end_turn' || reason === 'tool_use' || reason === 'max_tokens' || runFiltered) {
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
      // The filter verdict stays in stopDetails either way; only calls that did not run count as withheld.
      yield { type: 'stop', stopReason: runFiltered ? 'tool_use' : reason, ...(reason === 'refusal' ? { stopDetails: contentFilterStopDetails({ reason: finish,
        blocked: promptBlocked ? 'prompt' : 'response', calledNames: runFiltered ? [] : parts.filter(part => part.functionCall).map(part => part.functionCall.name),
        declaredNames: (params.tools || []).map(tool => tool.name) }) } : {}) };
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
