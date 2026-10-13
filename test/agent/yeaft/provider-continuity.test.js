import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAIResponsesAdapter } from '../../../agent/yeaft/llm/openai-responses.js';
import { AnthropicAdapter } from '../../../agent/yeaft/llm/anthropic.js';
import { createProviderContext, createProviderState, bindProviderState, replayProviderState, createPromptCacheKey } from '../../../agent/yeaft/llm/provider-state.js';
import { ConversationStore, projectVisibleSessionMessages, parseMessage } from '../../../agent/yeaft/conversation/persist.js';
import { searchMessages } from '../../../agent/yeaft/conversation/search.js';

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
});
