import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterRouter, inferProtocolFromModelId, sanitizeMessagesForWire } from '../../../agent/yeaft/llm/router.js';
import { createProviderContext, createProviderState, replayProviderState, bindProviderState } from '../../../agent/yeaft/llm/provider-state.js';
import { trimSnapshotForBudget } from '../../../agent/yeaft/history-window.js';
import { ConversationStore, projectVisibleSessionMessages } from '../../../agent/yeaft/conversation/persist.js';
import { searchMessages } from '../../../agent/yeaft/conversation/search.js';
import { loadConfig } from '../../../agent/yeaft/config.js';
import { Engine } from '../../../agent/yeaft/engine.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';
import { defineTool } from '../../../agent/yeaft/tools/types.js';
import { createPersonProvider } from '../../../agent/yeaft/person/provider.js';
import { closeConversationHistoryIndexes } from '../../../agent/yeaft/conversation/history-index.js';

const identity = { instanceScope: 'fixture-instance', ownerScope: 'fixture-owner', sessionId: 'session_gemini', vpId: 'vp', threadId: 'main' };
const provider = { name: 'google', protocol: 'gemini', apiKey: 'PRIVATE-KEY', models: ['gemini-2.5-pro'] };
const context = (overrides = {}) => createProviderContext({ protocol: 'gemini', providerId: provider.name, staticApiKey: provider.apiKey, model: 'gemini-2.5-pro', ...overrides });
const items = [
  { type: 'part', part: { text: 'PRIVATE-THOUGHT', thought: true } },
  { type: 'part', part: { text: 'visible answer' } },
  { type: 'part', part: { functionCall: { name: 'Read', args: { path: 'a' } }, thoughtSignature: 'PRIVATE-SIGNATURE' }, toolCallId: 'call1' },
  { type: 'part', part: { functionCall: { id: 'call2', name: 'Read', args: { path: 'b' } } }, toolCallId: 'call2' },
];
function assistant() {
  const msg = { role: 'assistant', content: 'visible answer', toolCalls: [
    { id: 'call1', name: 'Read', input: { path: 'a' } }, { id: 'call2', name: 'Read', input: { path: 'b' } },
  ] };
  msg.providerState = bindProviderState(createProviderState({ context: context(), identity, items }), msg);
  return msg;
}
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const collect = async stream => { const out = []; for await (const event of stream) out.push(event); return out; };
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('Gemini routing and private continuation integration', () => {
  it('executes a signed native Engine tool loop once and admits bounded Person image input', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gemini-engine-'));
    try {
      const requests = [];
      const execute = vi.fn(async () => 'tool evidence');
      const registry = new ToolRegistry();
      registry.register(defineTool({ name: 'echo', description: 'Read evidence', parameters: { type: 'object' }, readOnly: true, execute }));
      const signed = [{ text: 'checking' }, { functionCall: { name: 'echo', args: {} }, thoughtSignature: 'PRIVATE-ENGINE-SIGNATURE' }];
      vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
        requests.push(JSON.parse(init.body));
        return json({ candidates: [{ content: { role: 'model', parts: requests.length === 1 ? signed : [{ text: 'complete' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 2, thoughtsTokenCount: 1 } });
      }));
      const store = new ConversationStore(dir);
      const engine = new Engine({ adapter: new AdapterRouter({ providers: [provider] }), trace: new NullTrace(),
        toolRegistry: registry, conversationStore: store, yeaftDir: dir, vpId: 'vp',
        config: { model: 'google/gemini-2.5-pro', providers: [provider], maxOutputTokens: 1024, maxRetries: 0 } });
      const events = await collect(engine.query({ prompt: 'check evidence', sessionId: 'session_gemini', workDir: dir }));
      expect(events.filter(event => event.type === 'error')).toEqual([]);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(requests).toHaveLength(2);
      expect(requests[1].contents.find(row => row.role === 'model').parts).toEqual(signed);
      expect(requests[1].contents.at(-1).parts[0].functionResponse).toMatchObject({ name: 'echo', response: { output: expect.stringContaining('tool evidence') } });
      expect(events).toContainEqual(expect.objectContaining({ type: 'turn_end', terminal: true, stopReason: 'end_turn' }));
      expect(store.loadSessionHistoryForVp('session_gemini', 'vp').some(row => row.providerState?.protocol === 'gemini')).toBe(true);
      const nativeConfig = { providers: [provider], primaryModel: 'google/gemini-2.5-pro',
        availableModels: [{ id: 'gemini-2.5-pro', ref: 'google/gemini-2.5-pro', contextWindow: 1048576, maxOutput: 65536, effortOptions: ['medium', 'xhigh', 'max'] }] };
      const person = await createPersonProvider({ config: nativeConfig, adapter: {}, minimumRequestBytes: 1, effortEnabled: true });
      expect(person.catalog[0]).toMatchObject({ id: 'google/gemini-2.5-pro', supportsImages: true, imageBudget: { detail: 'low', tokensPerImage: 8192 }, efforts: ['medium', 'xhigh', 'max'] });
      const router = new AdapterRouter({ providers: [provider] });
      await router.call({ model: 'google/gemini-2.5-pro', messages: [{ role: 'user', content: [{ type: 'image', detail: 'low', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } }] }],
        extraBody: { generationConfig: { mediaResolution: 'MEDIA_RESOLUTION_HIGH' } } });
      expect(requests.at(-1).generationConfig.mediaResolution).toBe('MEDIA_RESOLUTION_LOW');
    } finally { await closeConversationHistoryIndexes(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('infers Gemini without overriding an explicitly configured proxy protocol', async () => {
    for (const id of ['gemini-2.5-pro', 'models/gemini-2.5-flash', 'google/gemini-3-pro-preview']) expect(inferProtocolFromModelId(id)).toBe('gemini');
    expect(inferProtocolFromModelId('not-gemini-route')).toBeNull();
    const fetch = vi.fn(async url => String(url).includes('/responses')
      ? json({ id: 'r', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'proxy' }] }], usage: { input_tokens: 1, output_tokens: 1 } })
      : json({ candidates: [{ content: { parts: [{ text: 'native' }] }, finishReason: 'STOP' }] }));
    vi.stubGlobal('fetch', fetch);
    const router = new AdapterRouter({ providers: [
      { ...provider, protocol: undefined },
      { name: 'proxy', apiKey: 'key', baseUrl: 'https://proxy.invalid/v1', protocol: 'openai-responses', models: ['gemini-2.5-pro'] },
    ] });
    expect((await router.call({ model: 'google/gemini-2.5-pro', messages: [] })).text).toBe('native');
    expect(fetch.mock.calls[0][0]).toBe('https://generativelanguage.googleapis.com/v1/models/gemini-2.5-pro:generateContent');
    expect((await router.call({ model: 'proxy/gemini-2.5-pro', messages: [] })).text).toBe('proxy');
    expect(fetch.mock.calls.at(-1)[0]).toContain('/responses');
  });

  it('applies the routed default, explicit VP policy, and slash effort on the actual Engine wire', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gemini-engine-effort-'));
    try {
      vi.stubEnv('YEAFT_THINKING_V1', '0');
      const modelId = 'gemini-4-hydrogen';
      const native = `google/${modelId}`;
      const providers = [
        { name: 'proxy', protocol: 'openai-responses', apiKey: 'fixture', baseUrl: 'https://proxy.invalid/v1', models: [modelId] },
        { ...provider, models: [modelId] },
      ];
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ providers }));
      const config = loadConfig({ dir });
      const requests = [];
      vi.stubGlobal('fetch', vi.fn(async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(init.body) });
        return String(url).endsWith('/responses')
          ? json({ id: 'r', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }] })
          : json({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] });
      }));
      const vpPersona = { vpId: 'vp' };
      async function query(model, options = {}) {
        const engine = new Engine({ adapter: new AdapterRouter({ providers }), trace: new NullTrace(),
          toolRegistry: new ToolRegistry(), conversationStore: new ConversationStore(dir), yeaftDir: dir, vpId: 'vp',
          // The adapter routes the bare ID to the first provider; UI catalog
          // order must not override that if the duplicate appears first there.
          config: { ...config, model, availableModels: [...config.availableModels].reverse() } });
        const before = requests.length;
        const events = await collect(engine.query({ prompt: 'Question', vpPersona, workDir: dir, ...options }));
        expect(events.filter(event => event.type === 'error')).toEqual([]);
        expect(requests).toHaveLength(before + 1);
        return requests.at(-1);
      }
      const thinking = request => request.body.generationConfig?.thinkingConfig?.thinkingLevel;
      expect(thinking(await query(native))).toBe('XHIGH');
      expect(thinking(await query(native, { vpPersona: { ...vpPersona, thinking: 'high' } }))).toBe('HIGH');
      vi.stubEnv('YEAFT_THINKING_V1', '1');
      const bare = await query(modelId);
      expect(bare.url).toBe('https://proxy.invalid/v1/responses');
      expect(bare.body.reasoning?.effort).toBe('max');
      vi.stubEnv('YEAFT_THINKING_V1', '0');
      for (const [effort, legacy] of [['low', 'medium'], ['high', 'xhigh']]) {
        expect(thinking(await query(native, { prompt: `/${effort} Question` }))).toBe(effort.toUpperCase());
        expect((await query(modelId, { prompt: `/${effort} Question` })).body.reasoning?.effort).toBe(legacy);
      }
    } finally { await closeConversationHistoryIndexes(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('routes stream state and replays its exact parts through a native gateway', async () => {
    const gateway = { ...provider, baseUrl: 'https://gateway.invalid/google/v1beta' };
    const fetch = vi.fn(async () => json({ responseId: 'r', candidates: [{ content: { role: 'model', parts: items.map(item => item.part) }, finishReason: 'STOP' }] }));
    vi.stubGlobal('fetch', fetch);
    const router = new AdapterRouter({ providers: [gateway] });
    const params = { model: 'google/gemini-2.5-pro', requestIdentity: identity, messages: [{ role: 'user', content: 'question' }] };
    const events = await collect(router.stream(params));
    const state = events.find(event => event.type === 'provider_state').providerState;
    expect(state.items.map(item => item.part)).toEqual(items.map(item => item.part));
    const calls = events.filter(event => event.type === 'tool_call').map(({ type, ...call }) => call);
    const msg = { role: 'assistant', content: 'visible answer', toolCalls: calls, providerState: state };
    await router.call({ ...params, messages: [...params.messages, msg, ...calls.map(call => ({ role: 'tool', toolCallId: call.id, content: 'done' }))] });
    expect(JSON.parse(fetch.mock.calls.at(-1)[1].body).contents[1].parts).toEqual(items.map(item => item.part));
    expect(JSON.stringify(state)).not.toContain(provider.apiKey);
    const before = fetch.mock.calls.length;
    await expect(router.call({ ...params, messages: [msg] })).rejects.toThrow(/pair repair/);
    expect(fetch.mock.calls.length).toBe(before);
  });

  it('fences signed state by complete owner, model, route, credential and projection', () => {
    const msg = assistant();
    expect(replayProviderState(msg, context(), identity)).toEqual(items);
    for (const key of Object.keys(identity)) expect(() => replayProviderState(msg, context(), { ...identity, [key]: 'other' })).toThrow(/owner changed/);
    for (const changes of [{ model: 'gemini-2.5-flash' }, { baseUrl: 'https://other.invalid' }, { staticApiKey: 'other' }, { providerId: 'other' }]) {
      expect(() => replayProviderState(msg, context(changes), identity)).toThrow(/origin changed/);
    }
    expect(() => replayProviderState({ ...msg, content: 'edited' }, context(), identity)).toThrow(/projection changed/);
    expect(() => bindProviderState(msg.providerState, { ...msg, toolCalls: msg.toolCalls.slice(0, 1) })).toThrow(/projection changed/);
    expect(() => createProviderState({ context: context(), items })).toThrow(/request identity/);
    expect(() => createProviderState({ context: context({ capabilities: { translation: true } }), identity, items })).toThrow(/nativeReasoningState/);
    expect(() => sanitizeMessagesForWire({ messages: [msg] })).toThrow(/pair repair/);
    const replay = replayProviderState(msg, context(), identity);
    replay[0].part.text = 'mutated';
    expect(msg.providerState.items[0].part.text).toBe('PRIVATE-THOUGHT');
  });

  it('retains the complete signed tool group or none when fitting history', () => {
    const msg = assistant();
    const history = [{ role: 'user', content: 'question' }, msg,
      { role: 'tool', toolCallId: 'call1', content: 'first' }, { role: 'tool', toolCallId: 'call2', content: 'second' }];
    const fitted = trimSnapshotForBudget(history, { messageTokenBudget: 10000, keepToolTurns: 1 });
    expect(fitted.find(row => row.providerState)?.providerState).toEqual(msg.providerState);
    for (const budget of [10, 30, 50, 100]) {
      const small = trimSnapshotForBudget(history, { messageTokenBudget: budget, keepToolTurns: 1 });
      const owner = small.find(row => row.toolCalls?.length);
      if (owner) {
        expect(owner.toolCalls).toHaveLength(2);
        expect(owner.providerState).toEqual(msg.providerState);
      }
    }
    const incomplete = trimSnapshotForBudget(history.slice(0, -1), { messageTokenBudget: 10000, keepToolTurns: 1 });
    expect(incomplete.some(row => row.toolCalls?.length || row.role === 'tool')).toBe(false);
  });

  it('persists for restart but never exposes native parts in UI, search or peer VP history', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gemini-continuity-'));
    try {
      const msg = assistant();
      const store = new ConversationStore(dir);
      store.append({ ...msg, sessionId: identity.sessionId, speakerVpId: identity.vpId, threadId: identity.threadId });
      for (const call of msg.toolCalls) store.append({ role: 'tool', toolCallId: call.id, content: 'result', sessionId: identity.sessionId, speakerVpId: identity.vpId });
      const restarted = new ConversationStore(dir);
      const own = restarted.loadSessionHistoryForVp(identity.sessionId, identity.vpId)[0];
      expect(replayProviderState(own, context(), identity)).toEqual(items);
      expect(restarted.loadSessionHistoryForVp(identity.sessionId, 'other')[0].providerState).toBeUndefined();
      expect(JSON.stringify(projectVisibleSessionMessages([own]))).not.toContain('PRIVATE');
      expect(searchMessages(dir, 'PRIVATE')).toEqual([]);
      expect(searchMessages(dir, 'visible answer')[0].providerState).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
