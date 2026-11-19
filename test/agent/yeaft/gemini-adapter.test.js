import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiAdapter } from '../../../agent/yeaft/llm/gemini.js';
import { createLLMAdapter, LLMToolInputError } from '../../../agent/yeaft/llm/adapter.js';
import { AdapterRouter } from '../../../agent/yeaft/llm/router.js';
import { loadConfig } from '../../../agent/yeaft/config.js';
import { buildModelSelectionRows, getSessionEffortDisplay } from '../../../web/utils/modelRefs.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSessionConfig, resolveSessionConfig, saveSessionConfig } from '../../../agent/yeaft/sessions/session-config.js';

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

  it('rejects invalid, malformed, truncated or unfinished batches, runs complete filtered calls and withholds invalid ones', async () => {
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
    // A response filter verdict alone does not withhold a complete call: it runs and the verdict is recorded.
    global.fetch = vi.fn(async () => sse([candidate([{ functionCall: { id: 'call-safe', name: 'read', args: { path: 'a' } } }], 'SAFETY')]));
    const ran = await collect(adapter().stream(params));
    expect(ran.filter(e => e.type === 'tool_call')).toEqual([{ type: 'tool_call', id: 'call-safe', name: 'read', input: { path: 'a' } }]);
    expect(ran.at(-1)).toEqual({ type: 'stop', stopReason: 'tool_use', stopDetails: { type: 'content_filter', reason: 'SAFETY',
      blocked: 'response', withheldToolCalls: 0 } });
    // An invalid filtered batch is withheld whole, never echoing provider-chosen names or arguments of undeclared functions.
    global.fetch = vi.fn(async () => sse([candidate([valid, { functionCall: { name: '<img src=x>', args: ['filtered'] } }], 'SAFETY')]));
    const filtered = await collect(adapter().stream(params));
    expect(filtered.some(e => e.type === 'tool_call')).toBe(false);
    expect(filtered.at(-1)).toEqual({ type: 'stop', stopReason: 'refusal', stopDetails: { type: 'content_filter', reason: 'SAFETY',
      blocked: 'response', withheldToolCalls: 2, withheldTools: ['undeclared tool'] } });
    global.fetch = vi.fn(async () => sse([{ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }]));
    expect((await collect(adapter().stream(params))).at(-1)).toEqual({ type: 'stop', stopReason: 'refusal',
      stopDetails: { type: 'content_filter', reason: 'PROHIBITED_CONTENT', blocked: 'prompt', withheldToolCalls: 0 } });
    // A later candidate verdict describes the response, not the prompt.
    global.fetch = vi.fn(async () => sse([{ promptFeedback: { blockReason: 'SAFETY' } }, candidate([{ text: 'partial' }], 'RECITATION')]));
    expect((await collect(adapter().stream(params))).at(-1)).toMatchObject({ stopReason: 'refusal',
      stopDetails: { reason: 'RECITATION', blocked: 'response', withheldToolCalls: 0 } });
  });

  it('preserves actual Gemini levels from the catalog through saved sessions and REST unary/SSE', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-gemini-v1-'));
    try {
      const families = {
        'gemini-4-hydrogen': ['low', 'medium', 'high', 'xhigh'],
        'gemini-4-carbon': ['low', 'medium', 'high'],
        'gemini-4-argon': ['low', 'medium', 'high'],
        'gemini-3.8-flash': ['low', 'medium', 'high'],
        'gemini-3.1-pro-preview': ['low', 'medium', 'high'],
        'gemini-3-pro-preview': ['low', 'high'],
        'gemini-3.6-flash': ['minimal', 'low', 'medium', 'high'],
      };
      const providers = [{ name: 'google', protocol: 'gemini', apiKey: 'fixture', models: [...Object.keys(families), 'gemini-4-unverified', { id: 'gemini-2.5-flash', maxBudgetTokens: 16384 }] },
        { name: 'restricted', protocol: 'gemini', apiKey: 'fixture', models: [{ id: 'gemini-4-hydrogen', effortOptions: ['medium', 'xhigh'] }] },
        { name: 'strict', protocol: 'gemini', apiKey: 'fixture', models: [{ id: 'gemini-4-hydrogen', effortOptions: ['xhigh'] }] }];
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ providers }));
      mkdirSync(join(dir, 'sessions', 'gemini'), { recursive: true });
      const config = loadConfig({ dir });
      const router = new AdapterRouter({ providers: config.providers });
      global.fetch = vi.fn(async url => url.includes(':streamGenerateContent') ? sse([candidate([{ text: 'ok' }])]) : json(candidate([{ text: 'ok' }])));
      for (const [model, levels] of Object.entries(families)) {
        const row = buildModelSelectionRows(config.availableModels).find(row => row.modelRef === `google/${model}`);
        expect(row.model.effortOptions).toEqual(levels);
        const visible = levels.includes('xhigh') ? ['medium', 'xhigh'] : levels.filter(level => ['medium', 'high'].includes(level));
        expect(row.efforts).toEqual(visible);
        const expectedDefault = levels.includes('xhigh') ? 'xhigh' : levels.includes('medium') ? 'medium' : 'high';
        expect(row.defaultEffort).toBe(expectedDefault);
        expect(row.model.defaultEffort).toBe(expectedDefault);
        for (const effort of levels) {
          saveSessionConfig(dir, 'gemini', { model: row.modelRef, modelEffort: effort });
          const selection = resolveSessionConfig(config, loadSessionConfig(dir, 'gemini'));
          expect(selection.modelEffort).toBe(effort);
          const request = { ...params, model: selection.model, effort: selection.modelEffort, effortSource: 'user' };
          await router.call(request);
          await collect(router.stream(request));
          for (const [url, options] of global.fetch.mock.calls.slice(-2)) {
            expect(url).toContain(`/v1/models/${model}:`);
            expect(JSON.parse(options.body).generationConfig.thinkingConfig).toEqual({ thinkingLevel: effort.toUpperCase(), includeThoughts: true });
          }
        }
      }
      const rows = buildModelSelectionRows(config.availableModels);
      expect(rows.find(row => row.modelRef === 'google/gemini-4-unverified').efforts).toEqual([]);
      const capped = rows.find(row => row.modelRef === 'google/gemini-2.5-flash');
      expect(capped).toMatchObject({ efforts: ['medium', 'xhigh'], defaultEffort: 'xhigh' });
      expect(capped.model.effortOptions).toContain('max');
      for (const effort of ['xhigh', 'max']) {
        await router.call({ ...params, model: capped.modelRef, effort, effortSource: 'user' });
        expect(JSON.parse(global.fetch.mock.calls.at(-1)[1].body).generationConfig.thinkingConfig.thinkingBudget).toBe(16384);
      }
      const narrowed = rows.find(row => row.modelRef === 'restricted/gemini-4-hydrogen');
      expect(narrowed.model).toMatchObject({ geminiThinkingMode: 'level', effortOptions: ['medium', 'xhigh'] });
      const saved = { config: { modelEffort: 'high' } };
      expect(getSessionEffortDisplay(saved, '', narrowed.model)).toBe('medium');
      await router.call({ ...params, model: narrowed.modelRef, effort: 'high', effortSource: 'user' });
      expect(JSON.parse(global.fetch.mock.calls.at(-1)[1].body).generationConfig.thinkingConfig.thinkingLevel).toBe('MEDIUM');
      const strict = rows.find(row => row.modelRef === 'strict/gemini-4-hydrogen');
      expect(getSessionEffortDisplay({}, '', strict.model)).toBe('xhigh');
      expect(getSessionEffortDisplay(saved, '', strict.model)).toBe('unavailable');
      expect(saved.config.modelEffort).toBe('high');
      await router.call({ ...params, model: strict.modelRef, effort: 'high', effortSource: 'user' });
      expect(JSON.parse(global.fetch.mock.calls.at(-1)[1].body).generationConfig).not.toHaveProperty('thinkingConfig');
      await router.call({ ...params, model: 'google/gemini-3-pro-preview', effort: 'max', effortSource: 'user' });
      expect(JSON.parse(global.fetch.mock.calls.at(-1)[1].body).generationConfig.thinkingConfig.thinkingLevel).toBe('HIGH');
      await router.call({ ...params, model: 'google/gemini-4-hydrogen', effort: 'xhigh', effortSource: 'model-default' });
      expect(JSON.parse(global.fetch.mock.calls.at(-1)[1].body).generationConfig.thinkingConfig.thinkingLevel).toBe('XHIGH');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('reports implicit cache hits without a cache request field and fences explicit references by endpoint', async () => {
    global.fetch = vi.fn(async () => json({ ...candidate([{ text: 'ok' }]),
      usageMetadata: { promptTokenCount: 4097, cachedContentTokenCount: 4096, candidatesTokenCount: 3 } }));
    const diagnostics = vi.fn();
    const stable = new GeminiAdapter({ apiKey: 'secret', baseUrl: 'https://generativelanguage.googleapis.com' });
    const request = { ...params, onProviderDiagnostics: diagnostics };
    expect((await stable.call(request)).usage).toMatchObject({ inputTokens: 4097, cacheReadTokens: 4096, cacheTokensAreIncludedInInput: true });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).not.toHaveProperty('cachedContent');
    expect(diagnostics).toHaveBeenLastCalledWith(expect.objectContaining({ promptCaching: 'implicit' }));
    const extraBody = { cachedContent: 'cachedContents/existing-key' };
    await expect(stable.call({ ...request, extraBody })).rejects.toThrow('requires a supported v1beta');
    const beta = new GeminiAdapter({ apiKey: 'secret', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' });
    await expect(beta.call({ ...request, extraBody, system: 'do not omit' })).rejects.toThrow('inline system instructions');
    await expect(beta.call({ ...request, extraBody, model: 'gemini-4-hydrogen' })).rejects.toThrow('requires a supported v1beta');
    for (const baseUrl of ['https://proxy.invalid/v1', 'https://proxy.invalid/v1beta']) {
      await expect(new GeminiAdapter({ apiKey: 'fixture', baseUrl }).call({ ...request, extraBody })).rejects.toThrow('requires a supported v1beta');
    }
    expect(global.fetch).toHaveBeenCalledTimes(1);
    await beta.call({ ...request, extraBody });
    expect(global.fetch.mock.calls.at(-1)[0]).toContain('/v1beta/models/');
    expect(JSON.parse(global.fetch.mock.calls.at(-1)[1].body)).toMatchObject(extraBody);
    expect(diagnostics).toHaveBeenLastCalledWith(expect.objectContaining({ promptCaching: 'explicit-reference' }));
  });

  it('validates conflicting v1 options before unary or streaming dispatch and owns runtime fields', async () => {
    global.fetch = vi.fn(async () => json(candidate([{ text: 'ok' }])));
    const tool = { name: 'read', parameters: { type: 'object' } };
    for (const [extraBody, error] of [
      [{ generationConfig: { responseLogprobs: false, logprobs: 2 } }, 'requires responseLogprobs'],
      [{ generationConfig: { responseSchema: {}, responseJsonSchema: {}, responseMimeType: 'application/json' } }, 'cannot be combined'],
      [{ toolConfig: { functionCallingConfig: { mode: 'AUTO', allowedFunctionNames: ['read'] } } }, 'requires ANY or VALIDATED'],
      [{ toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['missing'] } } }, 'available in the current request'],
    ]) {
      const request = { ...params, tools: [tool], extraBody };
      await expect(adapter().call(request)).rejects.toThrow(error);
      await expect(collect(adapter().stream(request))).rejects.toThrow(error);
    }
    expect(global.fetch).not.toHaveBeenCalled();
    await adapter().call({ ...params, maxTokens: 321, extraBody: { tools: [tool], generationConfig: { maxOutputTokens: 9999, candidateCount: 2 } } });
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('tools');
    expect(body.generationConfig).toMatchObject({ maxOutputTokens: 321, candidateCount: 1 });
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

});
