import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIResponsesAdapter } from '../../../agent/yeaft/llm/openai-responses.js';
import { AnthropicAdapter } from '../../../agent/yeaft/llm/anthropic.js';
import { createProviderContext, createProviderState, bindProviderState } from '../../../agent/yeaft/llm/provider-state.js';
import { AdapterRouter } from '../../../agent/yeaft/llm/router.js';
import { _resetCacheForTests } from '../../../agent/yeaft/llm/credentials/github-copilot.js';

const identity = { instanceScope: '/synthetic/instance', ownerScope: 'owner', sessionId: 'session_fixture', vpId: 'vp', threadId: 'main' };
const context = protocol => createProviderContext({ protocol, model: protocol === 'anthropic' ? 'claude-sonnet-4' : 'gpt-5',
  providerId: 'fixture', credentialScopeId: 'account-fixture' });
const responsesItems = [
  { type: 'reasoning', id: 'r1', encrypted_content: 'PRIVATE-ENCRYPTED', summary: [] },
  { type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'visible answer', annotations: [] }] },
  { type: 'function_call', id: 'f1', call_id: 'call1', name: 'Read', arguments: '{ "path": "file" }', status: 'completed' },
];
const anthropicItems = [
  { type: 'text', text: 'visible answer' },
  { type: 'thinking', thinking: 'PRIVATE-THINKING', signature: 'signed-prefix-suffix' },
  { type: 'redacted_thinking', data: 'PRIVATE-REDACTED' },
  { type: 'tool_use', id: 'call1', name: 'Read', input: { path: 'file' } },
];
function assistant(protocol, items = protocol === 'anthropic' ? anthropicItems : responsesItems) {
  const msg = { role: 'assistant', content: 'visible answer', toolCalls: [{ id: 'call1', name: 'Read', input: { path: 'file' } }] };
  msg.providerState = bindProviderState(createProviderState({ context: context(protocol), identity, items, responseId: 'response1' }), msg);
  return msg;
}
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const sse = events => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
async function collect(generator) { const out = []; for await (const event of generator) out.push(event); return out; }
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  _resetCacheForTests();
});

describe('native provider wire contracts', () => {
  it('Anthropic preserves interleaved blocks and signature fragments through tools + caching', async () => {
    const events = [{ type: 'message_start', message: { id: 'a', usage: { input_tokens: 10, output_tokens: 0 } } }];
    anthropicItems.forEach((block, index) => {
      const start = block.type === 'thinking' ? { ...block, signature: '' } : block;
      events.push({ type: 'content_block_start', index, content_block: start });
      if (block.type === 'thinking') events.push(
        { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'signed-prefix-' } },
        { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'suffix' } });
      events.push({ type: 'content_block_stop', index });
    });
    events.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8, output_tokens_details: { thinking_tokens: 5 } } },
      { type: 'message_stop' });
    const fetch = vi.fn().mockResolvedValueOnce(sse(events)).mockResolvedValueOnce(json({ id: 'a2', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' }));
    vi.stubGlobal('fetch', fetch);
    const adapter = new AnthropicAdapter({ apiKey: 'synthetic' });
    const params = { model: 'claude-sonnet-4', system: 'fixed system', messages: [], requestIdentity: identity, providerContext: context('anthropic') };
    const output = await collect(adapter.stream(params));
    expect(output.find(e => e.type === 'provider_state').providerState.items).toEqual(anthropicItems);
    expect(output.filter(e => e.type === 'tool_call')).toHaveLength(1);
    expect(output.find(e => e.type === 'usage' && e.reasoningTokens !== undefined).reasoningTokens).toBe(5);
    await adapter.call({ ...params, messages: [assistant('anthropic'), { role: 'tool', toolCallId: 'call1', content: 'result' }] });
    const body = JSON.parse(fetch.mock.calls[1][1].body);
    expect(body.messages[0].content).toEqual(anthropicItems);
    expect(body.messages[1].content[0]).toMatchObject({ type: 'tool_result', cache_control: { type: 'ephemeral' } });
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
  });

});

describe('default prompt caching on native and compatible routes', () => {
  const exercise = (adapter, method, params) => method === 'stream' ? collect(adapter.stream(params)) : adapter.call(params);
  const readWire = init => JSON.parse(init.body);
  const messages = [{ role: 'user', content: 'question' }];
  const anthropicDone = () => json({ id: 'plain', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 8, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 } });
  const responsesDone = () => json({ id: 'plain', status: 'completed', output_text: 'done', output: [],
    usage: { input_tokens: 10, output_tokens: 8, input_tokens_details: { cached_tokens: 5 } } });
  const rejecting = (error, status = 400) => new Response(JSON.stringify(error), { status });

  it('uses the Anthropic breakpoints on legacy stream and call, and honors model-over-provider overrides', async () => {
    const fetch = vi.fn(async () => anthropicDone());
    vi.stubGlobal('fetch', fetch);
    const direct = new AnthropicAdapter({ apiKey: 'fixture' });
    const router = new AdapterRouter({ providers: [
      { name: 'proxy', baseUrl: 'https://proxy.invalid', apiKey: 'fixture', protocol: 'anthropic',
        capabilities: { promptCaching: false }, models: ['skip', { id: 'use-cache', capabilities: { promptCaching: true } }] },
      { name: 'translator', baseUrl: 'https://translator.invalid', apiKey: 'fixture', protocol: 'anthropic',
        capabilities: { translation: true }, models: [{ id: 'translated', capabilities: { promptCaching: true } }] },
    ] });
    for (const method of ['stream', 'call']) {
      for (const [adapter, model, expected] of [[direct, 'claude-sonnet-4', true], [router, 'proxy/skip', false],
        [router, 'proxy/use-cache', true], [router, 'translator/translated', false]]) {
        const result = await exercise(adapter, method, { model, system: 'fixed', messages });
        const body = readWire(fetch.mock.lastCall[1]);
        expect(body.system).toEqual(expected ? [{ type: 'text', text: 'fixed', cache_control: { type: 'ephemeral' } }] : 'fixed');
        const usage = method === 'stream' ? result.find(event => event.type === 'usage') : result.usage;
        expect(usage).toMatchObject({ cacheReadTokens: 5, cacheWriteTokens: 3 });
      }
    }
  });

  it('defaults the Responses hint on for a gateway and keeps it stable and owner-fenced on both request paths', async () => {
    const fetch = vi.fn(async () => responsesDone());
    vi.stubGlobal('fetch', fetch);
    const provider = { name: 'proxy', baseUrl: 'https://proxy.invalid/v1', apiKey: 'PRIVATE-FIXTURE', models: ['gpt-5'] };
    const router = new AdapterRouter({ providers: [provider] });
    const params = { model: 'proxy/gpt-5', system: 'PRIVATE-FIXTURE-SYSTEM', messages, requestIdentity: identity };
    const getKey = () => readWire(fetch.mock.lastCall[1]).prompt_cache_key;
    const stream = await collect(router.stream(params));
    const first = getKey();
    expect(first).toMatch(/^yeaft:[a-f0-9]{48}$/);
    expect(stream.find(event => event.type === 'usage')).toMatchObject({ cacheReadTokens: 5 });
    expect(readWire(fetch.mock.lastCall[1])).toMatchObject({ store: false });
    expect(readWire(fetch.mock.lastCall[1])).not.toHaveProperty('include');
    await router.call({ ...params, messages: [...messages, { role: 'user', content: 'new input' }] });
    expect(getKey()).toBe(first);
    await router.call({ ...params, requestIdentity: { ...identity, sessionId: 'other' } });
    expect(getKey()).not.toBe(first);
    router.refreshProviders([{ ...provider, apiKey: 'ROTATED-FIXTURE' }]);
    await router.call(params);
    expect(getKey()).not.toBe(first);
    await router.call({ ...params, requestIdentity: undefined, extraBody: { prompt_cache_key: 'caller-value' } });
    expect(getKey()).toBeUndefined();
  });

  it('retries once for validated cache-only errors on both protocols without changing signed inputs or dispatch ownership', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    for (const protocol of ['anthropic', 'openai-responses']) {
      const anthropic = protocol === 'anthropic';
      const model = anthropic ? 'claude-opus-4.8' : 'gpt-5';
      const adapter = anthropic ? new AnthropicAdapter({ apiKey: 'fixture' }) : new OpenAIResponsesAdapter({ apiKey: 'fixture' });
      const initialContext = createProviderContext({ protocol, model, staticApiKey: 'fixture' });
      const signed = { role: 'assistant', content: 'visible answer', toolCalls: [{ id: 'call1', name: 'Read', input: { path: 'file' } }] };
      signed.providerState = bindProviderState(createProviderState({ context: initialContext, identity,
        items: anthropic ? anthropicItems : responsesItems, requestBody: { model, system: 'fixed', messages } }), signed);
      const cacheError = () => anthropic
        ? rejecting({ detail: [{ type: 'extra_forbidden', loc: ['body', 'messages', 2, 'content', 0, 'tool_result', 'cache_control'] }] }, 422)
        : rejecting({ error: { message: 'Unrecognized request argument supplied: prompt_cache_key', code: 'unknown_parameter', param: 'prompt_cache_key' } });
      for (const method of ['stream', 'call']) {
        fetch.mockReset().mockImplementationOnce(async () => cacheError())
          .mockImplementationOnce(async () => anthropic ? anthropicDone() : method === 'stream'
            ? sse([{ type: 'response.completed', response: { id: 'plain', status: 'completed', output: [] } }]) : responsesDone());
        const onProviderDiagnostics = vi.fn(), onRequestStart = vi.fn(), onRawExchange = vi.fn();
        await exercise(adapter, method, { model, system: 'fixed', requestIdentity: identity, onProviderDiagnostics, onRequestStart, onRawExchange,
          messages: [...messages, signed, { role: 'tool', toolCallId: 'call1', content: 'result' }] });
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(onRequestStart).toHaveBeenCalledTimes(2);
        expect(onProviderDiagnostics.mock.calls.map(([info]) => info.promptCaching)).toEqual(['sent-unverified', 'rejected-fallback']);
        const [first, second] = fetch.mock.calls.map(([, req]) => readWire(req));
        if (anthropic) {
          expect(first.system[0].cache_control).toEqual({ type: 'ephemeral' });
          expect(second.system).toBe('fixed');
          expect(second.messages[0]).toEqual(messages[0]);
          expect(first.messages[2].content[0]).toHaveProperty('cache_control');
          expect(second.messages[1].content).toEqual(anthropicItems);
          expect(second.messages[2].content[0]).toEqual({ type: 'tool_result', tool_use_id: 'call1', content: 'result', is_error: false });
          expect(JSON.stringify(second)).not.toContain('cache_control');
        } else {
          const { prompt_cache_key, ...withoutHint } = first;
          expect(prompt_cache_key).toBeTruthy();
          expect(second).toEqual(withoutHint);
          expect(second.input.slice(1, 4)).toEqual(responsesItems);
        }
        if (method === 'stream') expect(onRawExchange.mock.lastCall[0].rawRequest.body).toEqual(second);
      }
      fetch.mockReset().mockImplementation(async () => cacheError());
      await expect(adapter.call({ model, system: 'fixed', messages, requestIdentity: identity })).rejects.toThrow(/API error/);
      expect(fetch).toHaveBeenCalledTimes(2);
    }
  });

  it('does not retry unrelated failures and respects abort or a denied dispatch during fallback', async () => {
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'fixture' });
    const params = { model: 'gpt-5', messages, requestIdentity: identity };
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const cacheError = { error: { message: 'Unknown parameter: prompt_cache_key' } };
    for (const [error, status] of [[cacheError, 401], [cacheError, 429], [cacheError, 500],
      [{ error: { message: 'Unknown parameter: prompt_cache_key.mode' } }, 400],
      [{ error: { message: 'Unknown parameter: prompt_cache_key', param: 'input' } }, 400],
      [{ error: { message: 'Invalid input: mentions prompt_cache_key' } }, 400],
      [{ detail: [{ type: 'extra_forbidden', loc: ['body', 'prompt_cache_key'] },
        { type: 'missing', loc: ['body', 'input'] }] }, 422]]) {
      fetch.mockReset().mockImplementation(async () => rejecting(error, status));
      await expect(collect(adapter.stream(params))).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
    }
    const anthropic = new AnthropicAdapter({ apiKey: 'fixture' });
    fetch.mockReset().mockImplementation(async () => rejecting({ error: {
      message: 'system.0.text.cache_control: Extra inputs are not permitted\nmax_tokens: field required',
    } }));
    await expect(anthropic.call({ ...params, model: 'claude-sonnet-4', system: 'fixed' })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    const lostLease = new Error('lease lost before dispatch');
    const onRequestStart = vi.fn().mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw lostLease; });
    fetch.mockReset().mockImplementation(async () => rejecting(cacheError));
    await expect(adapter.call({ ...params, onRequestStart })).rejects.toBe(lostLease);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onRequestStart).toHaveBeenCalledTimes(2);
    const controller = new AbortController();
    fetch.mockReset().mockImplementation(async () => { controller.abort(); return rejecting(cacheError); });
    await expect(adapter.call({ ...params, signal: controller.signal })).rejects.toMatchObject({ name: 'LLMAbortError' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
