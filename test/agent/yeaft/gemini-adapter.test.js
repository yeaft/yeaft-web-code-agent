import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiAdapter, projectGeminiToolCalls } from '../../../agent/yeaft/llm/gemini.js';
import { createLLMAdapter, LLMAbortError, LLMRateLimitError, LLMServerError, LLMToolInputError } from '../../../agent/yeaft/llm/adapter.js';
import { createProviderContext } from '../../../agent/yeaft/llm/provider-state.js';

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; vi.useRealTimers(); });
const params = { model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'hello' }] };
const adapter = () => new GeminiAdapter({ apiKey: 'secret' });
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const candidate = (parts, finishReason = 'STOP') => ({ candidates: [{ index: 0, content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) }] });
const collect = async iterator => { const out = []; for await (const event of iterator) out.push(event); return out; };
function sse(events, tail = '') {
  const text = events.map(event => `data:${JSON.stringify(event)}\r\n\r\n`).join('') + tail;
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 13) c.enqueue(bytes.slice(i, i + 13)); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
}

describe('native Gemini adapter', () => {
  it('uses generateContent, native parameters, system instructions, schemas, images and redacted key', async () => {
    global.fetch = vi.fn(async () => json(candidate([{ text: 'ok' }])));
    const exchange = vi.fn(), onProviderDiagnostics = vi.fn();
    const instance = await createLLMAdapter({ adapter: 'gemini', apiKey: 'secret', baseUrl: 'https://gateway.test/custom?tenant=a', headers: { 'X-Route': 'local' } });
    const result = await instance.call({ ...params, system: 'system', messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: [{ type: 'text', text: 'image' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } }] }],
      tools: [{ name: 'read', description: 'Read', parameters: { type: 'object', additionalProperties: false } }],
      maxTokens: 123, temperature: 0, stopSequences: ['STOP'], jsonMode: true, effort: 'medium', onRawExchange: exchange, onProviderDiagnostics });
    const [url, req] = global.fetch.mock.calls[0];
    const body = JSON.parse(req.body);
    expect(url).toBe('https://gateway.test/custom/models/gemini-2.5-flash:generateContent?tenant=a');
    expect(req.headers['x-goog-api-key']).toBe('secret');
    expect(req.headers['X-Route']).toBe('local');
    expect(body).not.toHaveProperty('cachedContent');
    expect(onProviderDiagnostics.mock.lastCall[0]).toMatchObject({ promptCaching: 'provider-managed-unverified' });
    expect(body.systemInstruction.parts).toEqual([{ text: 'system' }, { text: 'rules' }]);
    expect(body.contents[0].parts[1]).toEqual({ inlineData: { mimeType: 'image/png', data: 'YWJj' } });
    expect(body.tools[0].functionDeclarations[0].parametersJsonSchema.additionalProperties).toBe(false);
    expect(body.generationConfig).toMatchObject({ maxOutputTokens: 123, temperature: 0, stopSequences: ['STOP'], responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 8192 } });
    expect(exchange.mock.calls[0][0].rawRequest.headers['x-goog-api-key']).toBe('***');
    expect(result).toMatchObject({ text: 'ok', stopReason: 'end_turn' });
  });

  it('streams incremental public thought summaries/text and reports cumulative usage only once including thought cost', async () => {
    global.fetch = vi.fn(async () => sse([
      candidate([{ thought: true, text: 'plan' }], null),
      { ...candidate([{ text: 'hé' }], null), usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 1, thoughtsTokenCount: 3 } },
      { ...candidate([{ text: 'llo' }]), usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 2, thoughtsTokenCount: 4, cachedContentTokenCount: 10 } },
    ]));
    const onProviderDiagnostics = vi.fn();
    const events = await collect(adapter().stream({ ...params, onProviderDiagnostics }));
    expect(global.fetch.mock.calls[0][0]).toContain(':streamGenerateContent?alt=sse');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).not.toHaveProperty('cachedContent');
    expect(onProviderDiagnostics.mock.lastCall[0]).toMatchObject({ promptCaching: 'implicit' });
    expect(events.filter(e => e.type === 'text_delta').map(e => e.text)).toEqual(['hé', 'llo']);
    expect(events.find(e => e.type === 'thinking_delta').text).toBe('plan');
    expect(events.filter(e => e.type === 'usage')).toEqual([expect.objectContaining({ inputTokens: 20, outputTokens: 6, reasoningTokens: 4, cacheReadTokens: 10, cacheTokensAreIncludedInInput: true })]);
    expect(events.at(-1)).toEqual({ type: 'stop', stopReason: 'end_turn' });
  });

  it('projects native and missing parallel IDs without editing parts and matches function responses including images', async () => {
    const parts = [{ functionCall: { name: 'read', args: { path: 'a' } } }, { functionCall: { id: 'native', name: 'read', args: { path: 'b' } } }];
    const calls = projectGeminiToolCalls(parts);
    expect(parts[0].functionCall.id).toBeUndefined();
    global.fetch = vi.fn(async () => json(candidate([{ text: 'done' }])));
    await adapter().call({ ...params, messages: [params.messages[0], { role: 'assistant', content: '', toolCalls: calls },
      { role: 'tool', toolCallId: calls[0].id, content: 'first' },
      { role: 'tool', toolCallId: calls[1].id, isError: true, content: [{ type: 'text', text: 'bad' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } }] }] });
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.contents.at(-1).parts).toEqual([
      { functionResponse: { name: 'read', id: calls[0].id, response: { output: 'first' } } },
      { functionResponse: { name: 'read', id: 'native', response: { error: 'bad' }, parts: [{ inlineData: { mimeType: 'image/png', data: 'YWJj' } }] } },
    ]);
    global.fetch = vi.fn(async () => sse([candidate(parts)]));
    const emitted = (await collect(adapter().stream(params))).filter(e => e.type === 'tool_call');
    expect(emitted.map(({ id, type, ...call }) => call)).toEqual(calls.map(({ id, ...call }) => call));
    expect(emitted[0].id).not.toBe(calls[0].id);
    expect(emitted[1].id).toBe('native');
  });

  it('rejects complete invalid batches, malformed JSON, truncated calls and unfinished EOF without publishing tools', async () => {
    const valid = { functionCall: { name: 'read', args: {} } };
    const responses = [
      () => sse([candidate([valid, { functionCall: { name: 'read', args: '{bad' } }])]),
      () => sse([candidate([valid], null)], 'data:{bad}\n\n'),
      () => sse([candidate([valid], 'MAX_TOKENS')]),
      () => sse([candidate([valid], null)]),
      () => sse([candidate([valid], 'MALFORMED_FUNCTION_CALL')]),
    ];
    for (const response of responses) {
      global.fetch = vi.fn(async () => response());
      const events = await collect(adapter().stream(params));
      expect(events.some(e => e.type === 'tool_call')).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: 'error', retryable: false, error: expect.any(LLMToolInputError) });
    }
    global.fetch = vi.fn(async () => json(candidate([{ functionCall: { name: 'read', args: [] } }])));
    await expect(adapter().call(params)).rejects.toBeInstanceOf(LLMToolInputError);
  });

  it('preserves refusal/truncation/unknown completion and rejects incomplete text EOF', async () => {
    for (const [wire, reason] of [['SAFETY', 'refusal'], ['MAX_TOKENS', 'max_tokens'], ['OTHER', 'unknown']]) {
      global.fetch = vi.fn(async () => json(candidate([{ text: 'partial' }], wire)));
      expect(await adapter().call(params)).toMatchObject({ text: 'partial', stopReason: reason });
    }
    global.fetch = vi.fn(async () => json({ promptFeedback: { blockReason: 'SAFETY' } }));
    expect(await adapter().call(params)).toMatchObject({ stopReason: 'refusal' });
    global.fetch = vi.fn(async () => sse([candidate([{ text: 'partial' }], null)]));
    await expect(collect(adapter().stream(params))).rejects.toBeInstanceOf(LLMServerError);
  });

  it('maps HTTP retry/auth/context errors, embedded errors and abort without leaking provider bodies', async () => {
    global.fetch = vi.fn(async () => new Response('private', { status: 429, headers: { 'retry-after': '2' } }));
    await expect(adapter().call(params)).rejects.toMatchObject({ name: 'LLMRateLimitError', retryAfterMs: 2000 });
    for (const [status, name] of [[401, 'LLMAuthError'], [403, 'LLMAuthError'], [413, 'LLMContextError'], [503, 'LLMServerError']]) {
      global.fetch = vi.fn(async () => new Response('private', { status }));
      await expect(adapter().call(params)).rejects.toMatchObject({ name });
    }
    global.fetch = vi.fn(async () => sse([{ error: { code: 429, message: 'private' } }]));
    await expect(collect(adapter().stream(params))).rejects.toBeInstanceOf(LLMRateLimitError);
    const controller = new AbortController(); controller.abort();
    await expect(adapter().call({ ...params, signal: controller.signal })).rejects.toBeInstanceOf(LLMAbortError);
  });

  it('enforces stream silence timeout and Gemini 3 thinking levels / subagent ceiling after extraBody', async () => {
    global.fetch = vi.fn(async () => json(candidate([{ text: 'ok' }])));
    await adapter().call({ ...params, model: 'gemini-3-flash-preview', effort: 'max', effortConstraint: {}, extraBody: { generationConfig: { thinkingConfig: { thinkingLevel: 'high' } } } });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).generationConfig.thinkingConfig.thinkingLevel).toBe('medium');
    global.fetch = vi.fn(async () => new Response(new ReadableStream({ start() {}, cancel() {} }), { headers: { 'content-type': 'text/event-stream' } }));
    vi.useFakeTimers();
    const pending = collect(adapter().stream({ ...params, streamIdleTimeoutMs: 1000 }));
    const rejection = expect(pending).rejects.toMatchObject({ name: 'LLMStreamIdleTimeoutError' });
    await vi.advanceTimersByTimeAsync(1001);
    await rejection;
  });

  it('assigns unique response-local IDs for repeated no-arg tool calls without changing signed parts', async () => {
    const identity = { instanceScope: 'i', ownerScope: 'o', sessionId: 's', vpId: 'v', threadId: 't' };
    const parts = [{ functionCall: { name: 'ListTasks' }, thoughtSignature: 'signed-empty-args' }];
    global.fetch = vi.fn(async () => sse([candidate(parts)]));
    const history = [...params.messages];
    const ids = [];
    for (let i = 0; i < 2; i++) {
      const events = await collect(adapter().stream({ ...params, messages: history, requestIdentity: identity }));
      const tool = events.find(event => event.type === 'tool_call');
      expect(tool).toMatchObject({ name: 'ListTasks', input: {} });
      ids.push(tool.id);
      const state = events.find(event => event.type === 'provider_state').providerState;
      expect(state.items[0].part).toEqual(parts[0]);
      history.push({ role: 'assistant', content: '', toolCalls: [{ id: tool.id, name: tool.name, input: tool.input }], providerState: state },
        { role: 'tool', toolCallId: tool.id, content: `result-${i}` });
    }
    expect(ids[0]).not.toBe(ids[1]);
    global.fetch = vi.fn(async () => json(candidate([{ text: 'done' }])));
    expect((await adapter().call({ ...params, messages: history, requestIdentity: identity })).text).toBe('done');
    const contents = JSON.parse(global.fetch.mock.calls[0][1].body).contents;
    expect(contents.filter(row => row.role === 'model').map(row => row.parts)).toEqual([parts, parts]);
    expect(contents.filter(row => row.role === 'user').flatMap(row => row.parts).filter(part => part.functionResponse).map(part => part.functionResponse.response.output)).toEqual(['result-0', 'result-1']);
  });

  it('replays signed raw parts exactly and fences changed ownership or projection', async () => {
    const identity = { instanceScope: 'i', ownerScope: 'o', sessionId: 's', vpId: 'v', threadId: 't' };
    const context = createProviderContext({ protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', staticApiKey: 'secret', model: params.model });
    const parts = [{ text: 'summary', thought: true }, { functionCall: { name: 'read', args: { path: 'a' } }, thoughtSignature: 'opaque-signature' }];
    global.fetch = vi.fn(async () => sse([candidate(parts)]));
    const events = await collect(adapter().stream({ ...params, requestIdentity: identity, providerContext: context }));
    const state = events.find(e => e.type === 'provider_state')?.providerState;
    expect(state?.items.map(item => item.part)).toEqual(parts);
    const calls = events.filter(e => e.type === 'tool_call').map(({ type, ...tc }) => tc);
    const assistant = { role: 'assistant', content: '', toolCalls: calls, providerState: state };
    global.fetch = vi.fn(async () => json(candidate([{ text: 'done' }])));
    await adapter().call({ ...params, providerContext: context, requestIdentity: identity, messages: [params.messages[0], assistant, { role: 'tool', toolCallId: calls[0].id, content: 'result' }] });
    const contents = JSON.parse(global.fetch.mock.calls[0][1].body).contents;
    expect(contents[1].parts).toEqual(parts);
    expect(contents[2].parts[0].functionResponse.id).toBeUndefined();
    await expect(adapter().call({ ...params, providerContext: context, requestIdentity: { ...identity, ownerScope: 'other' }, messages: [assistant] })).rejects.toMatchObject({ name: 'ProviderStateError' });
    await expect(adapter().call({ ...params, providerContext: context, requestIdentity: identity, messages: [{ ...assistant, content: 'edited' }] })).rejects.toMatchObject({ name: 'ProviderStateError' });
    const before = global.fetch.mock.calls.length;
    for (const protocol of ['unknown', undefined, 'anthropic', 'openai-responses']) {
      await expect(adapter().call({ ...params, providerContext: context, requestIdentity: identity,
        messages: [{ ...assistant, providerState: { ...state, protocol } }] })).rejects.toMatchObject({ name: 'ProviderStateError' });
    }
    expect(global.fetch.mock.calls.length).toBe(before);
  });
});
