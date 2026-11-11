import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicAdapter } from '../../../agent/yeaft/llm/anthropic.js';
import { createProviderContext } from '../../../agent/yeaft/llm/provider-state.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DebugTrace } from '../../../agent/yeaft/debug-trace.js';
import { parseMessage } from '../../../agent/yeaft/conversation/persist.js';

const identity = { instanceScope: 'instance', ownerScope: 'owner', sessionId: 'session', vpId: 'vp', threadId: 'main' };
const context = createProviderContext({ protocol: 'anthropic', providerId: 'test', credentialScopeId: 'account', model: 'claude-opus-5-5' });
const params = { model: 'claude-opus-5-5', system: 'fixed', messages: [{ role: 'user', content: 'question' }], requestIdentity: identity, providerContext: context };
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const sse = events => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const collect = async generator => { const events = []; for await (const event of generator) events.push(event); return events; };
afterEach(() => vi.unstubAllGlobals());

describe('Anthropic evolving Messages protocol', () => {
  it('persists metadata and reasoning usage in real debug trace and legacy readers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'anthropic-trace-'));
    const trace = new DebugTrace(dir);
    const metadata = { protocol: 'anthropic', stopReason: 'refusal', stopDetails: { category: 'test' },
      inputTransformations: [{ type: 'thinking_dropped', reason: 'prefix_binding_mismatch' }] };
    try {
      const turn = trace.startTurn({ traceId: 'trace', sessionId: 'session', turnNumber: 1 });
      trace.endTurn(turn, { responseText: 'no', stopReason: 'refusal', providerMetadata: metadata,
        usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 3 } });
      trace.finalizeQuery('trace', { sessionId: 'session', stopReason: 'refusal' });
      await trace.close();
      const restarted = new DebugTrace(dir);
      try {
        const detail = await restarted.fetchTurnDebug({ sessionId: 'session', turnId: 'trace' });
        expect(detail.loops[0]).toMatchObject({ providerMetadata: metadata, usage: { reasoningTokens: 3 } });
      } finally { await restarted.close(); }
      const encoded = Buffer.from(JSON.stringify(metadata)).toString('base64');
      expect(parseMessage(`---\nid: m0001\nrole: assistant\nproviderMetadataB64: ${encoded}\n---\n\nno`).providerMetadata).toEqual(metadata);
    } finally { await trace.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('retains all stop reasons and structured metadata in SSE, JSON fallback and side calls', async () => {
    const adapter = new AnthropicAdapter({ apiKey: 'synthetic' });
    for (const reason of ['end_turn', 'stop_sequence', 'tool_use', 'max_tokens', 'pause_turn', 'refusal', 'model_context_window_exceeded', 'future_stop']) {
      const message = { id: 'msg', model: params.model, content: [{ type: 'text', text: 'answer' }], stop_reason: reason,
        stop_sequence: reason === 'stop_sequence' ? 'STOP' : null, stop_details: { category: 'test' },
        input_transformations: [{ type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' }], usage: { input_tokens: 10, output_tokens: 2 } };
      const fetch = vi.fn().mockImplementation(() => Promise.resolve(json(message)));
      vi.stubGlobal('fetch', fetch);
      const expected = { protocol: 'anthropic', responseId: 'msg', model: params.model, stopReason: reason,
        stopSequence: message.stop_sequence, stopDetails: message.stop_details, inputTransformations: message.input_transformations };
      const rawExchange = vi.fn();
      const output = await collect(adapter.stream({ ...params, onRawExchange: rawExchange }));
      expect(rawExchange).toHaveBeenCalledOnce();
      expect(rawExchange.mock.calls[0][0].rawResponse.body).toEqual(message);
      expect(output.find(event => event.type === 'stop')).toMatchObject({ stopReason: reason, stopDetails: message.stop_details });
      expect(output.find(event => event.type === 'provider_metadata')?.metadata).toMatchObject(expected);
      expect(await adapter.call(params)).toMatchObject({ stopReason: reason, providerMetadata: expected });
      fetch.mockImplementation(() => Promise.resolve(sse([
        { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
        { type: 'content_block_start', index: 0, content_block: message.content[0] },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: reason, stop_sequence: message.stop_sequence, stop_details: message.stop_details }, usage: message.usage },
        { type: 'message_stop' },
      ])));
      const stream = await collect(adapter.stream(params));
      expect(stream.filter(event => event.type === 'stop')).toHaveLength(1);
      expect(stream.find(event => event.type === 'stop')).toMatchObject({ stopReason: reason });
      const combined = Object.assign({}, ...stream.filter(event => event.type === 'provider_metadata').map(event => event.metadata));
      expect(combined).toMatchObject(expected);
    }
  });

  it('keeps citation deltas and fallback boundaries in exact native order for replay', async () => {
    const citation = { type: 'char_location', cited_text: 'claim', document_index: 0, document_title: 'doc', start_char_index: 0, end_char_index: 5 };
    const fallback = { type: 'fallback', model: 'claude-sonnet-5-5' };
    vi.stubGlobal('fetch', vi.fn(async () => sse([
      { type: 'message_start', message: { id: 'msg', model: params.model, usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: [] } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'claim' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'citations_delta', citation } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: fallback },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', model: fallback.model }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ])));
    const output = await collect(new AnthropicAdapter({ apiKey: 'synthetic' }).stream(params));
    const state = output.find(event => event.type === 'provider_state')?.providerState;
    expect(state?.items).toEqual([{ type: 'text', text: 'claim', citations: [citation] }, fallback]);
    expect(output.some(event => event.type === 'provider_metadata' && event.metadata.contentBlocks?.some(block => block.type === 'fallback'))).toBe(true);
    expect(output.filter(event => event.type === 'text_delta').map(event => event.text).join('')).toBe('claim');
  });

  it('validates actual wire prefixes and appends supported instruction/tool changes without dropping signatures', async () => {
    const signed = [{ type: 'thinking', thinking: '', signature: 'opaque-signature' },
      { type: 'tool_use', id: 'read', name: 'Read', input: {} }];
    const fetch = vi.fn().mockResolvedValueOnce(json({ id: 'signed', content: signed, stop_reason: 'tool_use' }))
      .mockImplementation(() => Promise.resolve(json({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' })));
    vi.stubGlobal('fetch', fetch);
    const adapter = new AnthropicAdapter({ apiKey: 'synthetic' });
    const initial = await collect(adapter.stream(params));
    const providerState = initial.find(event => event.type === 'provider_state').providerState;
    expect(providerState.requestPrefix?.digest).toMatch(/^sha256:/);
    const next = { ...params, messages: [...params.messages, { role: 'assistant', content: '',
      toolCalls: [{ id: 'read', name: 'Read', input: {} }], providerState }, { role: 'tool', toolCallId: 'read', content: 'result' },
    { role: 'system', content: [{ type: 'text', text: 'New runtime instruction.' },
      { type: 'tool_addition', tool: { type: 'tool_definition', definition: { name: 'Grep', input_schema: { type: 'object' } } } }] }] };
    await collect(adapter.stream(next));
    const wire = JSON.parse(fetch.mock.calls[1][1].body);
    expect(wire.messages[1].content).toEqual(signed);
    expect(wire.messages.at(-1)).toEqual(next.messages.at(-1));
    expect(fetch.mock.calls[1][1].headers['anthropic-beta']).toBe('inline-tools-2026-09-15');
    await expect(adapter.call({ ...next, system: 'changed prefix' })).rejects.toThrow(/prefix changed/);
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(adapter.call({ ...params, model: 'claude-sonnet-4', messages: [{ role: 'system', content: 'new' }] })).rejects.toThrow(/does not support mid-conversation/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('never publishes client tools cut off by a full context window', async () => {
    const adapter = new AnthropicAdapter({ apiKey: 'synthetic' });
    const tool = { type: 'tool_use', id: 'call', name: 'Write', input: { path: 'file' } };
    for (const response of [
      () => json({ content: [tool], stop_reason: 'model_context_window_exceeded', usage: { input_tokens: 10, output_tokens: 2 } }),
      () => sse([{ type: 'content_block_start', index: 0, content_block: tool }, { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'model_context_window_exceeded' }, usage: { output_tokens: 2 } }, { type: 'message_stop' }]),
    ]) {
      vi.stubGlobal('fetch', vi.fn(async () => response()));
      const events = await collect(adapter.stream(params));
      expect(events.some(event => event.type === 'tool_call')).toBe(false);
      expect(events.find(event => event.type === 'stop')?.stopReason).toBe('model_context_window_exceeded');
      expect(events.some(event => event.type === 'usage')).toBe(true);
    }
  });
});
