import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicAdapter } from '../../../agent/yeaft/llm/anthropic.js';
import { OpenAIResponsesAdapter } from '../../../agent/yeaft/llm/openai-responses.js';
import { GeminiAdapter } from '../../../agent/yeaft/llm/gemini.js';
import { LLMRequestTooLargeError } from '../../../agent/yeaft/llm/adapter.js';
import { createProviderContext } from '../../../agent/yeaft/llm/provider-state.js';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrace, DebugTrace } from '../../../agent/yeaft/debug-trace.js';
import { commitSessionTurnDeletion } from '../../../agent/yeaft/conversation/turn-deletion-journal.js';

const identity = { instanceScope: 'instance', ownerScope: 'owner', sessionId: 'session', vpId: 'vp', threadId: 'main' };
const context = createProviderContext({ protocol: 'anthropic', providerId: 'test', credentialScopeId: 'account', model: 'claude-opus-5-5' });
const params = { model: 'claude-opus-5-5', system: 'fixed', messages: [{ role: 'user', content: 'question' }], requestIdentity: identity, providerContext: context };
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

const collect = async generator => { const events = []; for await (const event of generator) events.push(event); return events; };
afterEach(() => vi.unstubAllGlobals());

describe('Anthropic evolving Messages protocol', () => {
  it('validates actual byte limits and signed prefixes before dispatch, and appends supported instruction/tool changes', async () => {
    const signed = [{ type: 'thinking', thinking: '', signature: 'opaque-signature' },
      { type: 'tool_use', id: 'read', name: 'Read', input: {} }];
    const fetch = vi.fn().mockResolvedValueOnce(json({ id: 'signed', content: signed, stop_reason: 'tool_use' }))
      .mockImplementation(() => Promise.resolve(json({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' })));
    vi.stubGlobal('fetch', fetch);
    const adapter = new AnthropicAdapter({ apiKey: 'synthetic' });
    const request = { ...params, tools: [{ name: 'Read', description: 'Read evidence', parameters: { type: 'object' } }] };
    const initial = await collect(adapter.stream(request));
    const providerState = initial.find(event => event.type === 'provider_state').providerState;
    expect(providerState.requestPrefix?.digest).toMatch(/^sha256:/);
    const next = { ...request, messages: [...request.messages, { role: 'assistant', content: '',
      toolCalls: [{ id: 'read', name: 'Read', input: {} }], providerState }, { role: 'tool', toolCallId: 'read', content: 'result' },
    { role: 'system', content: [{ type: 'text', text: 'New runtime instruction.' },
      { type: 'tool_addition', tool: { type: 'tool_definition', definition: { name: 'Grep', input_schema: { type: 'object' } } } }] }] };
    // A lower output ceiling is not signed; changing only max_tokens is safe.
    await collect(adapter.stream({ ...next, maxTokens: 2048 }));
    const wire = JSON.parse(fetch.mock.calls[1][1].body);
    expect(wire.max_tokens).toBe(2048);
    expect(wire.messages[1].content).toEqual(signed);
    expect(wire.messages.at(-1)).toEqual(next.messages.at(-1));
    expect(fetch.mock.calls[1][1].headers['anthropic-beta']).toBe('inline-tools-2026-09-15');
    await expect(adapter.call({ ...next, maxTokens: 2048, contextOutputLimit: 2048, effort: 'xhigh', effortSource: 'user',
      effortContext: { thinkingProtocol: 'anthropic' } })).rejects.toThrow(/output settings exceed/);
    await expect(adapter.call({ ...next, maxTokens: 2048, contextOutputLimit: 2048, extraBody: { max_tokens: 3000 } })).rejects.toThrow(/output settings exceed/);
    await expect(adapter.call({ ...next, system: 'changed prefix' })).rejects.toThrow(/prefix changed/);
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(adapter.call({ ...params, model: 'claude-sonnet-4', messages: [{ role: 'system', content: 'new' }] })).rejects.toThrow(/does not support mid-conversation/);
    expect(fetch).toHaveBeenCalledTimes(2);

    const admission = vi.fn();
    const requestBody = { ...params, messages: [{ role: 'user', content: '中文 🙂 \u0000' }], onRequestStart: admission };
    for (const [native, model] of [[adapter, params.model],
      [new OpenAIResponsesAdapter({ apiKey: 'synthetic' }), 'gpt-5'],
      [new GeminiAdapter({ apiKey: 'synthetic' }), 'gemini-3-flash-preview']]) {
      for (const mode of ['unary', 'stream']) {
        fetch.mockReset().mockImplementation(async () => new Response(null, { status: 413 }));
        admission.mockClear();
        const call = overrides => {
          const args = { ...requestBody, ...overrides, model, providerContext: undefined };
          return mode === 'unary' ? native.call(args) : collect(native.stream(args));
        };
        await expect(call({})).rejects.toBeInstanceOf(LLMRequestTooLargeError);
        const serialized = fetch.mock.lastCall[1].body;
        const bytes = Buffer.byteLength(serialized);
        expect(bytes).toBeGreaterThan(serialized.length);
        await expect(call({ maxRequestBodyBytes: bytes - 1 })).rejects.toMatchObject({ requestBytes: bytes, limitBytes: bytes - 1 });
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(admission).toHaveBeenCalledTimes(1);
        await expect(call({ maxRequestBodyBytes: bytes })).rejects.toMatchObject({ requestBytes: bytes, statusCode: 413 });
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(fetch.mock.lastCall[1].body).toBe(serialized);
      }
    }
  });

});

describe('Session debug trace deletion', () => {
  function record(trace, sessionId, traceId, messageId) {
    const loop = trace.startTurn({ sessionId, traceId, messageId, turnNumber: 1, userPrompt: 'same prompt' });
    trace.endTurn(loop, {
      stopReason: 'tool_use',
      rawRequest: { messages: [{ role: 'user', content: 'raw request body' }] },
      rawResponse: { text: 'raw response body' },
      toolCalls: [{ id: 'tool-call', name: 'test-tool' }],
    });
    trace.logTool(loop, { toolName: 'test-tool', toolCallId: 'tool-call', toolInput: 'tool input', toolOutput: 'tool output' });
    return loop;
  }

  it('removes full persisted request directories and live/queued payloads without touching neighboring traces', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'debug-delete-'));
    const trace = new DebugTrace(dir);
    try {
      const target = record(trace, 'session-a', 'target', 'client-id');
      record(trace, 'session-a', 'another-target', 'persistent-id');
      trace.finalizeQuery('another-target', { sessionId: 'session-a' });
      record(trace, 'session-a', 'keep', 'different-id');
      record(trace, 'session-b', 'target', 'client-id');
      await trace.flush();
      const debug = join(dir, 'sessions', 'session-a', 'debug');
      const paths = readdirSync(join(debug, 'requests'));
      expect(paths).toHaveLength(3);
      expect(readdirSync(join(debug, 'turns'))).toHaveLength(3);
      const detail = await trace.fetchTurnDebug({ sessionId: 'session-a', turnId: 'target' });
      expect(detail.loops[0]).toMatchObject({ rawRequest: { messages: [{ content: 'raw request body' }] },
        rawResponse: { text: 'raw response body' }, toolCalls: [{ id: 'tool-call' }] });
      expect(detail.turns[0].tools[0]).toMatchObject({ toolInput: 'tool input', toolOutput: 'tool output' });
      expect(await trace.queryTools()).toHaveLength(4); // Hydrate the cached index.

      const queued = record(trace, 'session-a', 'queued', 'queued-message');
      const flush = trace.flush();
      const ids = { sessionId: 'session-a', turnIds: ['target', 'queued', 'same prompt'], messageIds: ['persistent-id'] };
      const deletion = trace.deleteSessionTurns(ids);
      trace.endTurn(target, { rawResponse: 'late append' });
      trace.logTool(queued, { toolOutput: 'late queued tool' });
      expect(trace.startTurn({ sessionId: 'session-a', traceId: 'queued' })).toBe('null');
      expect(await deletion).toEqual({ deletedRequests: 2 });
      await flush;
      trace.finalizeQuery('target', { sessionId: 'session-a' });
      expect(await trace.deleteSessionTurns(ids)).toEqual({ deletedRequests: 0 });
      expect(await trace.deleteSessionTurns({ turnIds: ['target'] })).toEqual({ deletedRequests: 0 });
      expect(await trace.deleteSessionTurns({ sessionId: 'absent', messageIds: ['client-id'] })).toEqual({ deletedRequests: 0 });
      expect((await trace.fetchTurnDebug({ sessionId: 'session-a', turnId: 'target' })).loops).toEqual([]);
      expect(await trace.queryTools()).toHaveLength(2);
      expect((await trace.stats()).requestCount).toBe(2);
      for (const path of paths.filter(path => !path.includes('-keep-'))) {
        expect(existsSync(join(debug, 'requests', path))).toBe(false);
      }
      expect(readdirSync(join(debug, 'turns'))).toHaveLength(1);
      await trace.close();
      const restarted = new DebugTrace(dir);
      try {
        expect(await restarted.resumeTrace({ sessionId: 'session-a', turnId: 'target' })).toBe(false);
        expect((await restarted.fetchTurnDebug({ sessionId: 'session-b', turnId: 'target' })).loops).toHaveLength(1);
      } finally { await restarted.close(); }
      const disabled = createTrace({ enabled: false, dirPath: dir });
      expect(await disabled.deleteSessionTurns({ sessionId: 'session-b', messageIds: ['client-id'] })).toEqual({ deletedRequests: 1 });
    } finally { await trace.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('filters surviving trace data using canonical Session tombstones loaded after restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'debug-delete-tombstones-'));
    const writer = new DebugTrace(dir);
    const reader = new DebugTrace(dir);
    try {
      record(writer, 'session-a', 'by-execution'); // Historical traces have no messageId.
      record(writer, 'session-a', 'by-client', 'client-id');
      record(writer, 'session-a', 'by-durable', 'durable-id');
      record(writer, 'session-b', 'by-execution', 'client-id');
      await writer.close();
      expect(await reader.queryTools()).toHaveLength(4); // Journal absent; cache hydrated.
      commitSessionTurnDeletion(dir, 'session-a', [], {
        version: 1, sessionId: 'session-a', turnId: 'user-turn',
        anchorMessageIds: ['durable-id'], messageIds: ['durable-id'], clientMessageIds: ['client-id'],
        executionIds: ['by-execution'], referenceIds: ['durable-id', 'client-id', 'user-turn'],
      });
      const request = { sessionId: 'session-a', turnId: 'by-execution' };
      expect((await reader.fetchTurnDebug(request)).loops).toEqual([]);
      expect((await reader.fetchRecentDebugHistory({ sessionId: 'session-a', indexOnly: true })).turns).toEqual([]);
      expect((await reader.fetchRecentDebugHistory({ sessionId: 'session-a', search: 'same prompt' })).turns).toEqual([]);
      expect((await reader.fetchRecentDebugHistory({ detailTurnId: 'by-execution' })).turns[0].sessionId).toBe('session-b');
      expect(await reader.resumeTrace(request)).toBe(false);
      expect((await reader.queryByMessage('client-id')).turns).toHaveLength(1);
      expect((await reader.queryByMessage('durable-id')).turns).toEqual([]);
      expect((await reader.queryByTrace('by-execution')).turns).toHaveLength(1);
      expect(await reader.queryRecent()).toHaveLength(1);
      expect(await reader.queryTools()).toHaveLength(1);
      expect(await reader.search('raw response body')).toHaveLength(1);
      expect((await reader.stats()).requestCount).toBe(1);
      expect(readdirSync(join(dir, 'sessions', 'session-a', 'debug', 'requests'))).toHaveLength(3);
    } finally {
      await writer.close();
      await reader.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
