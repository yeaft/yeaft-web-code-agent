import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAIResponsesAdapter } from '../../../agent/yeaft/llm/openai-responses.js';
import { AnthropicAdapter } from '../../../agent/yeaft/llm/anthropic.js';
import { createProviderContext, createProviderState, bindProviderState, replayProviderState, createPromptCacheKey, validateAnthropicRequestPrefixes } from '../../../agent/yeaft/llm/provider-state.js';
import { AdapterRouter } from '../../../agent/yeaft/llm/router.js';
import { _resetCacheForTests } from '../../../agent/yeaft/llm/credentials/github-copilot.js';
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
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  _resetCacheForTests();
});

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

  it('retains known opaque Anthropic blocks without projecting server calls or accepting unsigned thinking', () => {
    const opaque = [
      { type: 'fallback', model: 'claude-sonnet-5-5' },
      { type: 'server_tool_use', id: 'server1', name: 'web_search', input: { query: 'question' } },
      { type: 'mcp_tool_use', id: 'mcp1', name: 'lookup', server_name: 'fixture', input: {} },
      ...['web_search', 'web_fetch', 'code_execution', 'bash_code_execution', 'text_editor_code_execution', 'tool_search', 'mcp']
        .map(name => ({ type: `${name}_tool_result`, tool_use_id: name === 'mcp' ? 'mcp1' : 'server1', content: [] })),
      { type: 'container_upload', file_id: 'file-fixture' },
    ];
    const items = [{ type: 'text', text: 'claim', citations: [{ type: 'char_location', cited_text: 'claim' }] }, ...opaque];
    const state = createProviderState({ context: context('anthropic'), identity, items });
    const message = { role: 'assistant', content: 'claim', toolCalls: [], providerState: state };
    expect(state).not.toBeNull();
    expect(bindProviderState(state, message)).toBe(state);
    expect(replayProviderState(message, context('anthropic'), identity)).toEqual(items);
    const signedItems = [...items, anthropicItems[1]];
    const signed = { ...message, providerState: createProviderState({ context: context('anthropic'), identity, items: signedItems }) };
    expect(replayProviderState(signed, context('anthropic'), identity)).toEqual(signedItems);
    expect(() => replayProviderState(signed, context('anthropic'), { ...identity, ownerScope: 'other' })).toThrow(/owner changed/);
    expect(() => createProviderState({ context: context('anthropic'), items: signedItems })).toThrow(/request identity/);
    // Opaque types do not confer permission to persist incomplete reasoning or
    // unknown future blocks, including arbitrary names ending in _tool_result.
    for (const invalid of [
      { type: 'thinking', thinking: 'unsigned' }, { type: 'redacted_thinking', data: '' },
      { type: 'future_tool_result', tool_use_id: 'server1', content: [] },
      { type: 'fallback' }, { type: 'server_tool_use', id: 'server1', name: 'web_search', input: [] },
      { type: 'mcp_tool_result', content: [] },
    ]) {
      const sealInvalid = () => createProviderState({ context: context('anthropic'), identity, items: [...items, invalid] });
      if (['thinking', 'redacted_thinking'].includes(invalid.type)) expect(sealInvalid).toThrow(/unsupported or unsigned Anthropic block/);
      else expect(sealInvalid()).toBeNull();
      expect(() => createProviderState({ context: context('anthropic'), identity, items: [...anthropicItems, ...opaque, invalid] }))
        .toThrow(/unsupported or unsigned Anthropic block/);
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

describe('Anthropic gateway compatibility and prefix binding', () => {
  it('continues custom static routes without flags and retains every origin/owner fence', async () => {
    const provider = { name: 'gateway', baseUrl: 'https://proxy.invalid/anthropic', apiKey: 'PRIVATE-GATEWAY-KEY',
      protocol: 'anthropic', models: ['claude-opus-4.8', 'claude-sonnet-4.6'] };
    const fetch = vi.fn(async () => json({ id: 'tool-response', content: anthropicItems, stop_reason: 'tool_use' }));
    vi.stubGlobal('fetch', fetch);
    const router = new AdapterRouter({ providers: [provider] });
    const params = { model: 'gateway/claude-opus-4.8', system: 'fixed', messages: [{ role: 'user', content: 'question' }], requestIdentity: identity };
    const events = await collect(router.stream(params));
    const state = events.find(event => event.type === 'provider_state').providerState;
    expect(state.origin.credentialScopeId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(state)).not.toContain(provider.apiKey);
    const msg = { role: 'assistant', content: 'visible answer', toolCalls: [{ id: 'call1', name: 'Read', input: { path: 'file' } }], providerState: state };
    const next = { ...params, messages: [...params.messages, msg, { role: 'tool', toolCallId: 'call1', content: 'result' }] };
    await router.call(next);
    expect(JSON.parse(fetch.mock.calls.at(-1)[1].body).messages[1].content).toEqual(anthropicItems);
    expect(fetch.mock.calls.at(-1)[1].body).not.toContain('cache_control');
    expect(fetch.mock.calls.at(-1)[1].body).not.toContain('eager_input_streaming');
    await expect(router.call({ ...next, messages: [msg] })).rejects.toThrow(/pair repair/);
    await expect(router.call({ ...next, messages: [{ ...msg, content: '', providerState: undefined,
      thinkingBlocks: [{ thinking: 'PRIVATE', signature: 'legacy-signature' }] }] })).rejects.toThrow(/pair repair/);
    expect(() => replayProviderState({ ...msg, toolCalls: [] }, createProviderContext({ protocol: 'anthropic',
      baseUrl: provider.baseUrl, providerId: provider.name, staticApiKey: provider.apiKey, model: 'claude-opus-4.8' }), identity)).toThrow(/projection changed/);
    const ctx = createProviderContext({ protocol: 'anthropic', ...provider, providerId: provider.name, staticApiKey: provider.apiKey, model: 'claude-opus-4.8' });
    for (const changes of [{ model: 'claude-sonnet-4.6' }, { baseUrl: 'https://other.invalid' }, { staticApiKey: 'other-key' }, { providerId: 'other-provider' }]) {
      const changed = createProviderContext({ protocol: 'anthropic', baseUrl: provider.baseUrl, providerId: provider.name,
        staticApiKey: provider.apiKey, model: 'claude-opus-4.8', ...changes });
      expect(() => replayProviderState(msg, changed, identity)).toThrow(/origin changed/);
    }
    for (const key of Object.keys(identity)) {
      expect(() => replayProviderState(msg, ctx, { ...identity, [key]: 'other' })).toThrow(/owner changed/);
    }
    for (const capabilities of [{ translation: true }, { nativeReasoningState: false }]) {
      expect(() => createProviderState({ context: { ...ctx, capabilities }, identity, items: anthropicItems })).toThrow(/nativeReasoningState/);
    }
    expect(() => createProviderState({ context: ctx, items: anthropicItems })).toThrow(/request identity/);
    expect(createProviderContext({ protocol: 'openai-responses', baseUrl: provider.baseUrl, model: 'gpt-5', staticApiKey: provider.apiKey })
      .capabilities.nativeReasoningState).toBe(false);
  });

  it('binds dynamic scope to source credentials across refresh and fences an account switch', async () => {
    for (const explicit of [true, false]) {
      _resetCacheForTests();
      vi.stubEnv('COPILOT_GITHUB_TOKEN', 'PRIVATE-SOURCE-ACCOUNT-A');
      let exchanges = 0;
      const fetch = vi.fn(async (url) => {
        if (String(url).includes('/copilot_internal/v2/token')) return json({ token: `api-token-${++exchanges}`, expires_at: Math.floor(Date.now() / 1000) + 3600 });
        return json({ id: 'signed', content: anthropicItems, stop_reason: 'tool_use' });
      });
      vi.stubGlobal('fetch', fetch);
      const provider = { name: 'github-copilot', credentialProvider: 'github-copilot',
        ...(explicit ? { githubToken: 'PRIVATE-SOURCE-ACCOUNT-A' } : {}), models: ['claude-opus-4.8'] };
      const router = new AdapterRouter({ providers: [provider] });
      const params = { model: 'github-copilot/claude-opus-4.8', system: 'fixed', messages: [], requestIdentity: identity };
      const response = await router.call(params);
      expect(fetch.mock.calls.at(-1)[1].headers.Authorization).toBe('Bearer api-token-1');
      expect(JSON.stringify(response.providerState)).not.toContain('PRIVATE-SOURCE');
      const msg = { role: 'assistant', content: response.text, toolCalls: [{ id: 'call1', name: 'Read', input: { path: 'file' } }], providerState: response.providerState };
      const next = { ...params, messages: [msg, { role: 'tool', toolCallId: 'call1', content: 'result' }] };
      _resetCacheForTests(); // An expiring transport token changes, the account scope does not.
      const events = await collect(router.stream(next));
      expect(events.find(event => event.type === 'provider_state').providerState.origin).toEqual(response.providerState.origin);
      expect(fetch.mock.calls.at(-1)[1].headers.Authorization).toBe('Bearer api-token-2');
      if (explicit) router.refreshProviders([{ ...provider, githubToken: 'PRIVATE-SOURCE-ACCOUNT-B' }]);
      else vi.stubEnv('COPILOT_GITHUB_TOKEN', 'PRIVATE-SOURCE-ACCOUNT-B');
      const before = fetch.mock.calls.filter(([url]) => !String(url).includes('/copilot_internal/')).length;
      await expect(router.call(next)).rejects.toThrow(/origin changed/);
      expect(fetch.mock.calls.filter(([url]) => !String(url).includes('/copilot_internal/'))).toHaveLength(before);
    }
  });

  it('validates final system/tools/message prefixes while ignoring only real cache markers', () => {
    const requestBody = { model: 'claude-opus-4.8', system: [{ type: 'text', text: 'fixed' }],
      tools: [{ name: 'Read', input_schema: { type: 'object' } }], messages: [{ role: 'user', content: 'question' }] };
    const seal = (body, items = anthropicItems) => createProviderState({ context: context('anthropic'), identity, items, requestBody: body });
    const state = seal(requestBody);
    const body = { ...structuredClone(requestBody), messages: [...requestBody.messages, { role: 'assistant', content: anthropicItems },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call1', content: 'result' }] }] };
    const entries = [{ state, messageIndex: 1 }];
    expect(() => validateAnthropicRequestPrefixes(body, entries)).not.toThrow();
    const cacheOnly = structuredClone(body);
    cacheOnly.system[0].cache_control = { type: 'ephemeral' };
    cacheOnly.tools[0].cache_control = { type: 'ephemeral' };
    cacheOnly.effort = 'high'; cacheOnly.max_tokens = 20;
    expect(() => validateAnthropicRequestPrefixes(cacheOnly, entries)).not.toThrow();
    for (const mutate of [b => { b.system[0].text = 'changed'; }, b => { b.tools[0].name = 'Other'; },
      b => { b.messages[0].content = 'changed'; }, b => { b.messages.shift(); }]) {
      const changed = structuredClone(body); mutate(changed);
      expect(() => validateAnthropicRequestPrefixes(changed, entries)).toThrow(/prefix/);
    }
    const second = seal(body);
    const extended = { ...structuredClone(body), messages: [...structuredClone(body.messages), { role: 'assistant', content: anthropicItems }] };
    expect(() => validateAnthropicRequestPrefixes(extended, [...entries, { state: second, messageIndex: 3 }])).not.toThrow();
    extended.messages[2].content[0].content = 'shortened old result';
    expect(() => validateAnthropicRequestPrefixes(extended, [{ state: second, messageIndex: 3 }])).toThrow(/prefix changed/);
    const keyBody = structuredClone(body);
    keyBody.messages[1].content.at(-1).input.cache_control = 'application-data';
    const third = seal(keyBody);
    const keyNext = { ...structuredClone(keyBody), messages: [...structuredClone(keyBody.messages), { role: 'assistant', content: anthropicItems }] };
    keyNext.messages[1].content.at(-1).input.cache_control = 'changed-data';
    expect(() => validateAnthropicRequestPrefixes(keyNext, [{ state: third, messageIndex: 3 }])).toThrow(/prefix changed/);
    // A changed/missing middle thinking block must not leave a later signature valid.
    const chainBody = { ...structuredClone(body), messages: [...structuredClone(body.messages), { role: 'assistant', content: anthropicItems }] };
    const chainState = seal(chainBody);
    const chainNext = { ...structuredClone(chainBody), messages: [...structuredClone(chainBody.messages), { role: 'assistant', content: anthropicItems }] };
    chainNext.messages[3].content = chainNext.messages[3].content.filter(block => block.type !== 'thinking');
    expect(() => validateAnthropicRequestPrefixes(chainNext, [{ state: chainState, messageIndex: 4 }])).toThrow(/prefix changed/);
    const removedOldest = structuredClone(chainBody);
    removedOldest.messages[1].content = removedOldest.messages[1].content.filter(block => !['thinking', 'redacted_thinking'].includes(block.type));
    removedOldest.messages.push({ role: 'assistant', content: anthropicItems });
    expect(() => validateAnthropicRequestPrefixes(removedOldest, [{ state: chainState, messageIndex: 4 }])).not.toThrow();
    expect(JSON.stringify(state.requestPrefix)).not.toContain('question');
    expect(() => validateAnthropicRequestPrefixes(body, [{ state: assistant('anthropic').providerState, messageIndex: 1 }])).not.toThrow();
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
