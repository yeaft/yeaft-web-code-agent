import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAIResponsesAdapter } from '../../../agent/yeaft/llm/openai-responses.js';
import { AnthropicAdapter } from '../../../agent/yeaft/llm/anthropic.js';
import { AdapterRouter } from '../../../agent/yeaft/llm/router.js';
import { createProviderContext, createProviderState, bindProviderState, replayProviderState,
  createPromptCacheKey, applyAnthropicCaching, MAX_PROVIDER_STATE_BYTES } from '../../../agent/yeaft/llm/provider-state.js';
import { normalizeTokenUsage } from '../../../agent/yeaft/llm/usage-accounting.js';
import { updateLlmConfig } from '../../../agent/yeaft/config-api.js';
import { normalizeProviderModels } from '../../../agent/yeaft/models.js';
import { ConversationStore, projectVisibleSessionMessages, parseMessage } from '../../../agent/yeaft/conversation/persist.js';
import { searchMessages } from '../../../agent/yeaft/conversation/search.js';
import { estimateMessageTokens, buildHistoryBuckets } from '../../../agent/yeaft/history-window.js';

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
afterEach(() => vi.unstubAllGlobals());

describe('provider continuation ownership and projection', () => {
  it('preserves native ordering and exact arguments; scopes and digests fail closed', () => {
    for (const protocol of ['anthropic', 'openai-responses']) {
      const msg = assistant(protocol);
      expect(replayProviderState(msg, context(protocol), identity)).toEqual(protocol === 'anthropic' ? anthropicItems : responsesItems);
      const invalid = [
        () => replayProviderState(msg, context(protocol), { ...identity, vpId: 'other' }),
        () => replayProviderState(msg, { ...context(protocol), origin: { ...context(protocol).origin, credentialScopeId: 'other' } }, identity),
        () => replayProviderState({ ...msg, content: 'changed' }, context(protocol), identity),
      ];
      for (const invoke of invalid) {
        if (protocol === 'anthropic') expect(invoke).toThrow(/cannot be replayed safely/);
        else expect(invoke()).toBeNull();
      }
      const replay = replayProviderState(msg, context(protocol), identity);
      replay[0].id = 'mutation';
      expect(msg.providerState.items[0].id).not.toBe('mutation');
    }
  });

  it('binds cache keys only to stable scoped identity and endpoint, not content', () => {
    const key = createPromptCacheKey(identity, context('openai-responses'));
    expect(key).toMatch(/^yeaft:[a-f0-9]+$/);
    expect(key).not.toContain('fixture');
    expect(createPromptCacheKey({ ...identity }, context('openai-responses'))).toBe(key);
    for (const field of Object.keys(identity)) expect(createPromptCacheKey({ ...identity, [field]: 'different' }, context('openai-responses'))).not.toBe(key);
    expect(createPromptCacheKey({}, context('openai-responses'))).toBeNull();
    const custom = createProviderContext({ protocol: 'anthropic', baseUrl: 'https://proxy.invalid', model: 'claude-sonnet-4' });
    expect(custom.capabilities).toEqual({ nativeReasoningState: false, promptCaching: false, parallelToolCalls: false });
    expect(createProviderContext({ protocol: 'anthropic', capabilities: { translation: true, nativeReasoningState: true, promptCaching: true } }).capabilities.nativeReasoningState).toBe(false);
  });

  it('persists JSONL/restart, strips public/search/cross-VP state and supports legacy reader', () => {
    const dir = mkdtempSync(join(tmpdir(), 'provider-continuity-'));
    try {
      const store = new ConversationStore(dir);
      const msg = assistant('anthropic');
      store.append({ ...msg, sessionId: identity.sessionId, speakerVpId: identity.vpId, threadId: identity.threadId });
      store.append({ role: 'tool', content: 'result', toolCallId: 'call1', sessionId: identity.sessionId, speakerVpId: identity.vpId });
      const restarted = new ConversationStore(dir);
      const own = restarted.loadSessionHistoryForVp(identity.sessionId, identity.vpId)[0];
      expect(own.providerState).toEqual(msg.providerState);
      expect(replayProviderState(own, context('anthropic'), identity)).toEqual(anthropicItems);
      expect(restarted.loadSessionHistoryForVp(identity.sessionId, 'other')[0].providerState).toBeUndefined();
      expect(JSON.stringify(projectVisibleSessionMessages([own]))).not.toContain('PRIVATE');
      expect(searchMessages(dir, 'PRIVATE')).toEqual([]);
      const hits = searchMessages(dir, 'visible answer');
      expect(hits.length).toBe(1);
      expect(hits[0].providerState).toBeUndefined();
      const encoded = Buffer.from(JSON.stringify(msg.providerState)).toString('base64');
      expect(parseMessage(`---\nid: m0001\nrole: assistant\nproviderStateB64: ${encoded}\n---\n\nvisible answer`).providerState).toEqual(msg.providerState);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('treats opaque bytes separately and does not resurrect window-trimmed text', () => {
    const msg = assistant('openai-responses');
    const large = structuredClone(msg);
    large.providerState.items[0].encrypted_content = 'x'.repeat(100000);
    expect(estimateMessageTokens(large)).toBe(estimateMessageTokens(msg));
    large.providerState.items[0].encrypted_content = 'x'.repeat(MAX_PROVIDER_STATE_BYTES);
    expect(() => estimateMessageTokens(large)).toThrow(/byte budget/);
    const snapshot = [{ role: 'user', content: 'active' }, msg, { role: 'tool', toolCallId: 'call1', content: 'result' }];
    const fitted = buildHistoryBuckets(snapshot, { messageTokenBudget: 20, maxMessageCount: 10 }).messages;
    for (const row of fitted) if (row.providerState) expect(replayProviderState(row, context('openai-responses'), identity)).toEqual(responsesItems);
    expect(msg.providerState).toBeDefined();
    const items = [{ type: 'reasoning', encrypted_content: 'x' }];
    const small = createProviderState({ context: context('openai-responses'), identity, items });
    const overhead = Buffer.byteLength(JSON.stringify(small)) - 1;
    items[0].encrypted_content = 'x'.repeat(MAX_PROVIDER_STATE_BYTES - overhead);
    expect(Buffer.byteLength(JSON.stringify(createProviderState({ context: context('openai-responses'), identity, items })))).toBe(MAX_PROVIDER_STATE_BYTES);
    items[0].encrypted_content += 'x';
    expect(() => createProviderState({ context: context('openai-responses'), identity, items })).toThrow(/byte budget/);
  });
});

describe('native provider wire contracts', () => {
  it('Responses JSON fallback captures state; next request emits originals once after final normalization', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(json({ id: 'response1', status: 'completed', output: responsesItems,
      usage: { input_tokens: 10, output_tokens: 8, output_tokens_details: { reasoning_tokens: 5 } } })));
    vi.stubGlobal('fetch', fetch);
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'synthetic' });
    const params = { model: 'gpt-5', system: 'system', messages: [{ role: 'user', content: 'question' }], requestIdentity: identity, providerContext: context('openai-responses') };
    const events = await collect(adapter.stream(params));
    const state = events.find(event => event.type === 'provider_state').providerState;
    expect(state.items).toEqual(responsesItems);
    expect(events.filter(event => event.type === 'tool_call')).toHaveLength(1);
    expect(events.find(event => event.type === 'usage').reasoningTokens).toBe(5);
    await adapter.call({ ...params, messages: [assistant('openai-responses'), { role: 'tool', toolCallId: 'call1', content: 'result' }],
      extraBody: { input: [], store: true, previous_response_id: 'remote', include: ['reasoning.encrypted_content', 'message.output_text.logprobs'], prompt_cache_key: 'unsafe' } });
    const body = JSON.parse(fetch.mock.calls[1][1].body);
    expect(body.input.slice(0, 3)).toEqual(responsesItems);
    expect(body.input).toHaveLength(4);
    expect(body.store).toBe(false);
    expect(body.previous_response_id).toBeUndefined();
    expect(body.include).toEqual(['reasoning.encrypted_content', 'message.output_text.logprobs']);
    expect(body.prompt_cache_key).toBe(createPromptCacheKey(identity, context('openai-responses')));
    expect(body.parallel_tool_calls).toBe(true);
    for (const method of ['stream', 'call']) {
      const request = { ...params, extraBody: { parallel_tool_calls: false } };
      if (method === 'stream') await collect(adapter.stream(request));
      else await adapter.call(request);
      expect(JSON.parse(fetch.mock.calls.at(-1)[1].body).parallel_tool_calls).toBe(false);
    }
  });

  it('Responses terminal output wins over done slots and incomplete/reasoning-only is sealed', async () => {
    const reasoning = responsesItems[0];
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(sse([
      { type: 'response.output_item.done', output_index: 0, item: reasoning },
      { type: 'response.incomplete', response: { id: 'r', status: 'incomplete', output: [reasoning], usage: { output_tokens: 3 } } },
    ])));
    vi.stubGlobal('fetch', fetch);
    const events = await collect(new OpenAIResponsesAdapter({ apiKey: 'synthetic' }).stream({ model: 'gpt-5', messages: [], requestIdentity: identity, providerContext: context('openai-responses') }));
    expect(events.filter(e => e.type === 'provider_state')).toHaveLength(1);
    expect(events.find(e => e.type === 'provider_state').providerState.items).toEqual([reasoning]);
    expect(events.filter(e => e.type === 'text_delta')).toHaveLength(0);
  });

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

  it('does not reuse disconnected partial state and supports Anthropic JSON fallback', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(sse([
      { type: 'message_start', message: { id: 'partial', usage: {} } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'half', signature: '' } },
    ])).mockResolvedValueOnce(json({ id: 'complete', content: anthropicItems, stop_reason: 'tool_use', usage: { output_tokens: 3 } }));
    vi.stubGlobal('fetch', fetch);
    const adapter = new AnthropicAdapter({ apiKey: 'synthetic' });
    const params = { model: 'claude-sonnet-4', messages: [], requestIdentity: identity, providerContext: context('anthropic') };
    const partial = [];
    await expect((async () => { for await (const e of adapter.stream(params)) partial.push(e); })()).rejects.toThrow();
    expect(partial.some(e => e.type === 'provider_state')).toBe(false);
    const complete = await collect(adapter.stream(params));
    expect(complete.find(e => e.type === 'provider_state').providerState.items).toEqual(anthropicItems);
  });

  it('does not send cache without account scope or replay unowned legacy signatures', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(json({ id: 'plain', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' })));
    vi.stubGlobal('fetch', fetch);
    const adapter = new AnthropicAdapter({ apiKey: 'synthetic' });
    const params = { model: 'claude-sonnet-4', system: 'fixed', messages: [{ role: 'user', content: 'question' }], requestIdentity: identity };
    await adapter.call(params);
    await collect(adapter.stream(params));
    for (const [, init] of fetch.mock.calls) expect(init.body).not.toContain('cache_control');
    const legacy = { role: 'assistant', content: 'visible', thinkingBlocks: [{ thinking: 'PRIVATE', signature: 'PRIVATE-SIGNATURE' }] };
    await adapter.call({ ...params, messages: [legacy], providerContext: context('anthropic') });
    expect(fetch.mock.calls.at(-1)[1].body).not.toContain('PRIVATE');
    const signedTool = { ...legacy, toolCalls: [{ id: 'call1', name: 'Read', input: {} }] };
    for (const providerContext of [context('anthropic'), { ...context('anthropic'), origin: { ...context('anthropic').origin, credentialScopeId: 'different-account' } }]) {
      await expect(adapter.call({ ...params, providerContext, messages: [signedTool] })).rejects.toThrow(/legacy signed tool history/);
    }
    const missingScope = createProviderContext({ protocol: 'anthropic', model: params.model });
    expect(() => createProviderState({ context: missingScope, identity, items: anthropicItems })).toThrow(/credentialScopeId/);
    fetch.mockImplementation(() => Promise.resolve(json({ id: 'signed', content: anthropicItems, stop_reason: 'tool_use' })));
    await expect(adapter.call(params)).rejects.toThrow(/credentialScopeId/);
    await expect(collect(adapter.stream(params))).rejects.toThrow(/credentialScopeId/);
  });

  it('supports legacy official static-key configs across router restart without weakening account fences', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(json({ id: 'signed', content: anthropicItems, stop_reason: 'tool_use' })));
    vi.stubGlobal('fetch', fetch);
    const makeRouter = apiKey => new AdapterRouter({ providers: [{ name: 'fixture', apiKey, protocol: 'anthropic', models: ['claude-sonnet-4'] }] });
    const params = { model: 'fixture/claude-sonnet-4', messages: [{ role: 'user', content: 'question' }], requestIdentity: identity };
    const output = await collect(makeRouter('synthetic-secret').stream(params));
    const providerState = output.find(e => e.type === 'provider_state').providerState;
    expect(JSON.stringify(providerState)).not.toContain('synthetic-secret');
    const messages = [{ ...assistant('anthropic'), providerState }, { role: 'tool', toolCallId: 'call1', content: 'result' }];
    await makeRouter('synthetic-secret').call({ ...params, messages });
    expect(JSON.parse(fetch.mock.calls.at(-1)[1].body).messages[0].content).toEqual(anthropicItems);
    await expect(makeRouter('different-secret').call({ ...params, messages })).rejects.toThrow(/origin changed/);
    const proxy = createProviderContext({ protocol: 'anthropic', baseUrl: 'https://proxy.invalid', staticApiKey: 'synthetic-secret', model: params.model, capabilities: { nativeReasoningState: true } });
    expect(proxy.origin.credentialScopeId).toBeUndefined();
  });

  it('rejects EOF after stop_reason but before signed state is sealed by message_stop', async () => {
    const events = [{ type: 'message_start', message: { id: 'partial', usage: {} } }];
    anthropicItems.forEach((content_block, index) => events.push({ type: 'content_block_start', index, content_block }, { type: 'content_block_stop', index }));
    events.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' } });
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(sse(events))));
    await expect(collect(new AnthropicAdapter({ apiKey: 'synthetic' }).stream({ model: 'claude-sonnet-4', messages: [], requestIdentity: identity, providerContext: context('anthropic') }))).rejects.toThrow(/before stop event/);
  });

  it('preserves model capability overrides through config API persistence and normalization', () => {
    const dir = mkdtempSync(join(tmpdir(), 'provider-capabilities-'));
    try {
      const capabilities = { nativeReasoningState: true, promptCaching: false, translation: false };
      const saved = updateLlmConfig({ providers: [{ name: 'fixture', baseUrl: 'https://proxy.invalid', apiKey: 'synthetic',
        credentialScopeId: 'fixture-account', capabilities: { promptCaching: true }, models: [{ id: 'gpt-5', capabilities }] }] }, dir);
      expect(saved.error).toBeUndefined();
      expect(saved.providers[0].models[0]).toEqual({ id: 'gpt-5', capabilities });
      expect(normalizeProviderModels(saved.providers[0])[0].capabilities).toEqual(capabilities);
      expect(saved.providers[0].credentialScopeId).toBe('fixture-account');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('limits cache breakpoints and keeps reasoning usage a subset rather than extra cost', () => {
    const body = { system: 'fixed', tools: [{ name: 'a' }, { name: 'b' }], messages: [
      { role: 'user', content: 'old' }, { role: 'assistant', content: anthropicItems }, { role: 'user', content: 'latest' },
    ] };
    applyAnthropicCaching(body, context('anthropic'));
    expect(JSON.stringify(body).match(/cache_control/g)).toHaveLength(3);
    expect(body.messages[1].content).toEqual(anthropicItems);
    expect(normalizeTokenUsage({ inputTokens: 10, outputTokens: 8, reasoningTokens: 5 }).totalTokens).toBe(18);
    expect(normalizeTokenUsage({ inputTokens: 10, outputTokens: 8 }).reasoningTokens).toBeUndefined();
    applyAnthropicCaching(body, { capabilities: { promptCaching: false } });
    expect(JSON.stringify(body)).not.toContain('cache_control');
  });
});
