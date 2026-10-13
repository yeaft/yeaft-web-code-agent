import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Engine } from '../../../agent/yeaft/engine.js';
import { AdapterRouter } from '../../../agent/yeaft/llm/router.js';
import { ConversationStore } from '../../../agent/yeaft/conversation/persist.js';
import { closeConversationHistoryIndexes } from '../../../agent/yeaft/conversation/history-index.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { buildMcpFlattenedTools } from '../../../agent/yeaft/tools/mcp-tools.js';
import { defineTool } from '../../../agent/yeaft/tools/types.js';
import { createFullRegistry } from '../../../agent/yeaft/tools/index.js';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';
import { AnthropicAdapter } from '../../../agent/yeaft/llm/anthropic.js';

/**
 * MockAdapter — emits pre-configured events for testing.
 * Each call to stream() pops the next response from the queue.
 */
class MockAdapter {
  constructor() {
    this.responses = []; // Array of arrays of StreamEvent
    this.callLog = [];   // Records what was passed to stream()
  }

  /** Push a pre-configured response (array of StreamEvent). */
  pushResponse(events) {
    this.responses.push(events);
  }

  async *stream(params) {
    this.callLog.push(params);
    const events = this.responses.shift();
    if (!events) {
      throw new Error('MockAdapter: no more responses queued');
    }
    for (const event of events) {
      yield event;
    }
  }

  async call(params) {
    this.callLog.push(params);
    return { text: 'mock call response', usage: { inputTokens: 10, outputTokens: 5 } };
  }
}

let trace;
let mockAdapter;

beforeEach(() => {
  trace = new NullTrace();
  mockAdapter = new MockAdapter();
});

describe('Engine', () => {
  describe('simple query (no tools)', () => {
    it('persists a normal turn once without end-of-turn duplicates', async () => {
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-no-persist-duplicates-'));
      try {
        const conversationStore = new ConversationStore(yeaftDir);
        mockAdapter.pushResponse([
          { type: 'text_delta', text: 'one reply' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);
        const engine = new Engine({
          adapter: mockAdapter,
          trace,
          config: { model: 'test-model', maxOutputTokens: 1024 },
          conversationStore,
          yeaftDir,
        });

        const events = [];
        for await (const event of engine.query({
          prompt: 'one prompt',
          sessionId: 'session-no-duplicates',
        })) events.push(event);
        expect(events.filter(event => event.type === 'turn_end')).toEqual([
          expect.objectContaining({ stopReason: 'end_turn', terminal: true }),
        ]);
        expect(events.at(-1)).toMatchObject({ type: 'turn_close' });

        expect(conversationStore.loadRecentBySession('session-no-duplicates', 10).map(message => ({
          role: message.role,
          content: message.content,
        }))).toEqual([
          { role: 'user', content: 'one prompt' },
          { role: 'assistant', content: 'one reply' },
        ]);
      } finally {
        await closeConversationHistoryIndexes();
        rmSync(yeaftDir, { recursive: true, force: true });
      }
    });

    it('persists the max-token continuation boundary before the next request fails', async () => {
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-continue-persist-'));
      try {
        const conversationStore = new ConversationStore(yeaftDir);
        mockAdapter.pushResponse([
          { type: 'text_delta', text: 'first part' },
          { type: 'stop', stopReason: 'max_tokens' },
        ]);
        mockAdapter.pushResponse([
          { type: 'error', error: new Error('continuation request failed'), retryable: false },
        ]);
        const engine = new Engine({
          adapter: mockAdapter,
          trace,
          config: { model: 'test-model', maxOutputTokens: 1024 },
          conversationStore,
          yeaftDir,
        });

        for await (const _event of engine.query({
          prompt: 'write a long answer',
          sessionId: 'session-continue-persist',
          causalRootId: 'root-max-token',
        })) {
          // consume
        }

        expect(conversationStore.loadRecentBySession('session-continue-persist', 10).map(message => ({
          role: message.role,
          content: message.content,
          userAuthored: message.userAuthored,
          causalRootId: message.causalRootId,
        }))).toEqual([
          { role: 'user', content: 'write a long answer', userAuthored: true, causalRootId: 'root-max-token' },
          { role: 'assistant', content: 'first part', userAuthored: undefined, causalRootId: 'root-max-token' },
          { role: 'user', content: 'Continue', userAuthored: false, causalRootId: 'root-max-token' },
        ]);
        expect(conversationStore.loadVisibleBySession('session-continue-persist', null, 10).messages).toEqual([
          expect.objectContaining({ role: 'user', content: 'write a long answer', userAuthored: true }),
          expect.objectContaining({ role: 'assistant', content: 'first part' }),
        ]);
      } finally {
        await closeConversationHistoryIndexes();
        rmSync(yeaftDir, { recursive: true, force: true });
      }
    });
  });

  describe('tool execution loop', () => {
    it('ends a tool handoff with one terminal event and no additional provider request', async () => {
      mockAdapter.pushResponse([
        { type: 'tool_call', id: 'handoff-call', name: 'handoff', input: {} },
        { type: 'stop', stopReason: 'tool_use' },
      ]);
      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });
      engine.registerTool({
        name: 'handoff', description: 'Yield control', parameters: {},
        execute: async (_input, ctx) => {
          ctx.requestEndTurn({ kind: 'test_handoff' });
          return 'Control transferred';
        },
      });
      const events = [];
      for await (const event of engine.query({ prompt: 'hand off this work' })) events.push(event);
      expect(mockAdapter.callLog).toHaveLength(1);
      expect(events.filter(event => event.type === 'tool_end')).toHaveLength(1);
      expect(events.filter(event => event.type === 'turn_end')).toEqual([
        expect.objectContaining({ terminal: true, stopReason: 'tool_handoff', detail: { kind: 'test_handoff' } }),
      ]);
      expect(events.at(-1)).toMatchObject({ type: 'turn_close' });
    });

    it('should execute tools and loop until end_turn', async () => {
      // First response: model wants to use a tool
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'Let me search.' },
        { type: 'tool_call', id: 'call_1', name: 'search', input: { q: 'test query' } },
        { type: 'usage', inputTokens: 50, outputTokens: 20 },
        { type: 'stop', stopReason: 'tool_use' },
      ]);

      // Second response: model has the answer
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'Found results for test query.' },
        { type: 'usage', inputTokens: 80, outputTokens: 15 },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      engine.registerTool({
        name: 'search',
        description: 'Search the web',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
        execute: async (input) => `Search results for: ${input.q}`,
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'search for test query' })) {
        events.push(event);
      }

      // Check we got 2 loops under one stable parent-turn identity.
      const turnStarts = events.filter(e => e.type === 'turn_start');
      expect(turnStarts).toHaveLength(2);
      expect(turnStarts.map(event => event.turnNumber)).toEqual([1, 2]);
      expect(turnStarts[0].turnId).toEqual(expect.any(String));
      expect(turnStarts[0].turnId).not.toBe('');
      expect(turnStarts[1].turnId).toBe(turnStarts[0].turnId);
      expect(events.find(event => event.type === 'turn_close')?.turnId).toBe(turnStarts[0].turnId);

      // Check tool execution events
      const toolStarts = events.filter(e => e.type === 'tool_start');
      expect(toolStarts).toHaveLength(1);
      expect(toolStarts[0].name).toBe('search');
      expect(toolStarts[0].input).toEqual({ q: 'test query' });

      const toolEnds = events.filter(e => e.type === 'tool_end');
      expect(toolEnds).toHaveLength(1);
      expect(toolEnds[0].output).toBe('Search results for: test query');
      expect(toolEnds[0].isError).toBe(false);

      // Check second adapter call has tool results in messages
      expect(mockAdapter.callLog).toHaveLength(2);
      const secondCall = mockAdapter.callLog[1];
      // Messages: user, assistant (with toolCalls), tool result
      expect(secondCall.messages).toHaveLength(3);
      expect(secondCall.messages[0].role).toBe('user');
      expect(secondCall.messages[1].role).toBe('assistant');
      expect(secondCall.messages[1].toolCalls).toHaveLength(1);
      expect(secondCall.messages[2].role).toBe('tool');
      expect(secondCall.messages[2].toolCallId).toBe('call_1');
      expect(events.filter(event => event.type === 'turn_end' && event.terminal)).toEqual([
        expect.objectContaining({ stopReason: 'end_turn', terminal: true }),
      ]);
    });

    it('feeds the accepted AskUser answer into the next provider loop and durable history', async () => {
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-ask-user-loop-'));
      try {
        mockAdapter.pushResponse([
          { type: 'tool_call', id: 'call_ask_loop', name: 'ask_test', input: { question: 'Continue?' } },
          { type: 'stop', stopReason: 'tool_use' },
        ]);
        mockAdapter.pushResponse([
          { type: 'text_delta', text: 'Continuing with the answer.' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);

        const conversationStore = new ConversationStore(yeaftDir);
        const engine = new Engine({
          adapter: mockAdapter,
          trace,
          config: { model: 'test-model', maxOutputTokens: 1024 },
          conversationStore,
          yeaftDir,
        });
        engine.registerTool({
          name: 'ask_test',
          description: 'Ask through the host',
          parameters: { type: 'object' },
          execute: async (input, ctx) => ctx.askUser(input),
        });

        const events = [];
        for await (const event of engine.query({
          prompt: 'ask me',
          sessionId: 'session-ask-loop',
          vpTurnId: 'turn-ask-loop',
          askUser: async (_input, toolCall) => {
            expect(toolCall).toMatchObject({ id: 'call_ask_loop', name: 'ask_test' });
            return { Continue: 'Yes' };
          },
        })) events.push(event);

        expect(events.find(event => event.type === 'tool_end')).toMatchObject({
          id: 'call_ask_loop',
          output: '{"Continue":"Yes"}',
          isError: false,
        });
        expect(mockAdapter.callLog).toHaveLength(2);
        expect(mockAdapter.callLog[1].messages).toEqual(expect.arrayContaining([
          expect.objectContaining({
            role: 'tool',
            toolCallId: 'call_ask_loop',
            content: '{"Continue":"Yes"}',
          }),
        ]));
        expect(conversationStore.loadRecentBySession('session-ask-loop', 20)).toEqual(expect.arrayContaining([
          expect.objectContaining({
            role: 'tool',
            toolCallId: 'call_ask_loop',
            content: '{"Continue":"Yes"}',
            sessionId: 'session-ask-loop',
            turnId: 'turn-ask-loop',
          }),
        ]));
      } finally {
        await closeConversationHistoryIndexes();
        rmSync(yeaftDir, { recursive: true, force: true });
      }
    });

    it('propagates resolved MCP isError results through events, model messages, and stats', async () => {
      mockAdapter.pushResponse([
        { type: 'tool_call', id: 'call_mcp_error', name: 'mcp__secure__read', input: {} },
        { type: 'stop', stopReason: 'tool_use' },
      ]);
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'The MCP tool failed.' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const records = [];
      const mcpManager = {
        listTools: () => [{
          name: 'secure__read',
          server: 'secure',
          description: 'Read protected data',
          inputSchema: { type: 'object', properties: {} },
        }],
        callTool: async () => ({
          isError: true,
          content: [{ type: 'text', text: 'permission denied' }],
        }),
      };
      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
        toolStats: { record: entry => records.push(entry) },
      });
      for (const tool of buildMcpFlattenedTools(mcpManager)) engine.registerTool(tool);

      const events = [];
      for await (const event of engine.query({ prompt: 'read protected data' })) events.push(event);

      expect(events.find(event => event.type === 'tool_end')).toMatchObject({
        output: 'Error: permission denied',
        isError: true,
      });
      expect(events.find(event => event.type === 'tool_exec')).toMatchObject({ isError: true });
      expect(mockAdapter.callLog[1].messages.find(message => message.role === 'tool')).toMatchObject({
        content: 'Error: permission denied',
        isError: true,
      });
      expect(records).toEqual([
        expect.objectContaining({
          name: 'mcp__secure__read',
          isError: true,
          errorMessage: 'Error: permission denied',
        }),
      ]);
    });
  });

  describe('multiple tool calls in one turn', () => {
    it('does not dispatch later parallel reads after abort during segment startup', async () => {
      mockAdapter.pushResponse([
        { type: 'tool_call', id: 'abort-read-1', name: 'parallel_read', input: { index: 1 } },
        { type: 'tool_call', id: 'abort-read-2', name: 'parallel_read', input: { index: 2 } },
        { type: 'stop', stopReason: 'tool_use' },
      ]);

      const controller = new AbortController();
      const executions = [];
      const registry = new ToolRegistry();
      registry.register(defineTool({
        name: 'parallel_read',
        description: 'Read independently.',
        parameters: { type: 'object' },
        isReadOnly: () => true,
        isConcurrencySafe: () => true,
        async execute({ index }, { signal }) {
          executions.push({ index, aborted: signal.aborted });
          return `result-${index}`;
        },
      }));
      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
        toolRegistry: registry,
      });

      const events = [];
      for await (const event of engine.query({
        prompt: 'read two independent inputs',
        signal: controller.signal,
      })) {
        events.push(event);
        if (event.type === 'tool_start' && event.id === 'abort-read-1') controller.abort('user');
      }

      expect(executions).toEqual([]);
      expect(events.filter(event => event.type === 'tool_start').map(event => event.id))
        .toEqual(['abort-read-1']);
      expect(events.filter(event => event.type === 'tool_end').map(event => ({
        id: event.id,
        skipped: event.skipped,
        aborted: event.aborted,
      }))).toEqual([
        { id: 'abort-read-1', skipped: true, aborted: true },
        { id: 'abort-read-2', skipped: true, aborted: true },
      ]);
      expect(events.filter(event => event.type === 'aborted')).toHaveLength(1);
      expect(events.filter(event => event.type === 'turn_end').at(-1)).toMatchObject({
        stopReason: 'aborted',
        terminal: true,
      });
    });
  });

  describe('adapter errors', () => {
    it('shrinks and retries provider context overflow without a compact LLM call', async () => {
      const { LLMContextError } = await import('../../../agent/yeaft/llm/adapter.js');
      let streamCalls = 0;
      let summaryCalls = 0;
      const adapter = {
        async *stream() {
          streamCalls += 1;
          if (streamCalls === 1) throw new LLMContextError('context window exceeded');
          yield { type: 'text_delta', text: 'recovered' };
          yield { type: 'stop', stopReason: 'end_turn' };
        },
        async call() {
          summaryCalls += 1;
          throw new Error('summary call must not happen');
        },
      };
      const engine = new Engine({
        adapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
        conversationStore: {
          append() { return null; },
        },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello' })) events.push(event);

      expect(streamCalls).toBe(2);
      expect(summaryCalls).toBe(0);
      expect(events.some(event => event.type === 'consolidate')).toBe(false);
      expect(events.filter(event => event.type === 'error')).toHaveLength(0);
      expect(events).toContainEqual(expect.objectContaining({
        type: 'llm_retry', reason: 'context_overflow_recovery',
      }));
      expect(events.filter(event => event.type === 'turn_end' && event.terminal)).toHaveLength(1);
    });

    it('continues after partial output on context overflow without redisplaying it', async () => {
      const { LLMContextError } = await import('../../../agent/yeaft/llm/adapter.js');
      const requests = [];
      const adapter = {
        async *stream(params) {
          requests.push(params);
          if (requests.length === 1) {
            yield { type: 'text_delta', text: 'partial answer' };
            throw new LLMContextError('context window exceeded after output');
          }
          yield { type: 'text_delta', text: ' resumed answer' };
          yield { type: 'stop', stopReason: 'end_turn' };
        },
      };
      const engine = new Engine({
        adapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
        conversationStore: { append() { return null; } },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello' })) events.push(event);

      expect(requests).toHaveLength(2);
      expect(events.filter(event => event.type === 'text_delta').map(event => event.text))
        .toEqual(['partial answer', ' resumed answer']);
      expect(requests[1].messages.filter(message =>
        message.role === 'assistant' && message.content === 'partial answer')).toHaveLength(1);
      expect(requests[1].messages.at(-1).role).toBe('user');
      expect(requests[1].messages.at(-1).content).not.toBe('hello');
      expect(events.filter(event => event.type === 'error')).toHaveLength(0);
    });
  });

  describe('LLM retry policy', () => {
    it('honours server Retry-After on LLMRateLimitError and recovers', async () => {
      const { LLMRateLimitError } = await import('../../../agent/yeaft/llm/adapter.js');
      let attempts = 0;
      const engine = new Engine({
        adapter: {
          async *stream() {
            attempts += 1;
            if (attempts === 1) {
              throw new LLMRateLimitError('Too fast', 429, 50);
            }
            yield { type: 'text_delta', text: 'ok' };
            yield { type: 'usage', inputTokens: 1, outputTokens: 1 };
            yield { type: 'stop', stopReason: 'end_turn' };
          },
        },
        trace,
        config: {
          model: 'test-model',
          maxOutputTokens: 1024,
          llmRetry: { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 100, jitterRatio: 0 },
        },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello' })) {
        events.push(event);
      }

      expect(attempts).toBe(2);
      const retryEvents = events.filter(e => e.type === 'llm_retry');
      expect(retryEvents).toHaveLength(1);
      expect(retryEvents[0].attempt).toBe(1);
      expect(retryEvents[0].reason).toBe('rate_limit_retry_after');
      expect(retryEvents[0].recoveryMode).toBe('restart');
      expect(retryEvents[0].delayMs).toBeLessThanOrEqual(50);
      const errorEvents = events.filter(e => e.type === 'error');
      expect(errorEvents).toHaveLength(0);
    });

    it('never executes, persists or retries rejected Anthropic tool batches and executes a complete batch in order', async () => {
      const { AnthropicAdapter } = await import('../../../agent/yeaft/llm/anthropic.js');
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-anthropic-tool-boundary-'));
      const originalFetch = global.fetch;
      const conversationStore = new ConversationStore(yeaftDir);
      const execute = vi.fn(async input => JSON.stringify(input));
      const registry = new ToolRegistry();
      registry.register(defineTool({ name: 'echo', description: 'echo', parameters: { type: 'object' }, execute }));
      const start = index => ({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `call-${index}`, name: 'echo', input: {} } });
      const delta = (index, partial_json) => ({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } });
      const blockStop = index => ({ type: 'content_block_stop', index });
      const messageStop = { type: 'message_stop' };
      const stop = stop_reason => ({ type: 'message_delta', delta: { stop_reason } });
      const firstTool = [start(0), delta(0, '{"value":1}'), blockStop(0)];
      const complete = [...firstTool, start(1), delta(1, '{"value":2}'), blockStop(1), stop('tool_use'), messageStop];
      const partial = [...firstTool, start(1), delta(1, '{"value":')];
      // Mix both legal SSE field forms, including no-space input/stop deltas.
      const encode = events => new TextEncoder().encode(events.map(e => `data:${e.type === 'content_block_delta' || e.type === 'message_delta' ? '' : ' '}${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join(''));
      const sse = events => new Response(encode(events));
      try {
        for (const [name, events] of [
          ['invalid-json', [...partial, blockStop(1), stop('tool_use'), messageStop]],
          ['open-sibling', [...partial, stop('tool_use'), messageStop]],
          ['done', [...partial, '[DONE]']],
          ['eof', partial],
          ['max-tokens', [...firstTool, stop('max_tokens'), messageStop]],
          ['idle', partial],
          ['abort', partial],
          ['complete', complete],
          ['no-retry', [...partial, blockStop(1), stop('tool_use'), messageStop]],
        ]) {
          execute.mockClear();
          const sessionId = `session-stream-${name}`;
          const ctrl = new AbortController();
          let requests = 0;
          const cancel = vi.fn();
          global.fetch = vi.fn(async () => {
            requests += 1;
            if (name === 'complete' && requests > 1) return sse([stop('end_turn'), messageStop]);
            if (name === 'no-retry' && requests > 1) return sse(complete);
            if (name === 'idle' || name === 'abort') return new Response(new ReadableStream({ start(controller) {
              controller.enqueue(encode(events));
            }, cancel }));
            return sse(events);
          });
          const policies = [];
          const engine = new Engine({ adapter: new AnthropicAdapter({ apiKey: 'synthetic', baseUrl: 'https://proxy.invalid', streamIdleTimeoutMs: 10 }), trace,
            toolRegistry: registry, conversationStore, yeaftDir,
            config: { model: 'claude-opus-4.8', modelEffort: 'high', projectDocMaxBytes: 0, maxOutputTokens: 1024,
              llmRetry: { maxRetries: name === 'no-retry' ? 1 : 0, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 } } });
          const output = [];
          for await (const event of engine.query({ prompt: 'echo values', sessionId, signal: ctrl.signal, onProviderRequestStart: policy => policies.push(policy) })) {
            output.push(event);
            if (name === 'abort' && event.type === 'provider_activity') ctrl.abort();
          }
          expect(policies[0]).toEqual({ effort: 'high', streamIdleTimeoutMs: 10 });
          const persisted = conversationStore.loadRecentBySession(sessionId, 50);
          if (name === 'complete') {
            expect(requests).toBe(2); // one tool batch and one tool-result continuation
            expect(execute.mock.calls.map(([input]) => input)).toEqual([{ value: 1 }, { value: 2 }]);
            expect(output.filter(e => e.type === 'llm_retry')).toHaveLength(0);
            expect(output.filter(e => e.type === 'tool_call')).toHaveLength(2);
            expect(persisted.flatMap(row => row.toolCalls || [])).toHaveLength(2);
            expect(persisted.filter(row => row.role === 'tool')).toHaveLength(2);
          } else {
            expect(requests).toBe(1);
            expect(execute).not.toHaveBeenCalled();
            expect(output.filter(e => e.type === 'tool_call' || e.type === 'tool_start')).toEqual([]);
            expect(persisted.flatMap(row => row.toolCalls || [])).toEqual([]);
            expect(persisted.filter(row => row.role === 'tool')).toEqual([]);
            expect(output.some(e => e.type === (name === 'abort' ? 'aborted' : 'error'))).toBe(true);
            expect(output.filter(e => e.type === 'llm_retry')).toHaveLength(0);
          }
          // Tool-loop boundaries are nonterminal; query owns exactly one terminal boundary.
          expect(output.filter(e => e.type === 'turn_end' && e.terminal)).toEqual([
            expect.objectContaining({ terminal: true, stopReason: name === 'complete' ? 'end_turn' : name === 'abort' ? 'aborted' : 'error' }),
          ]);
          if (name === 'idle' || name === 'abort') expect(cancel).toHaveBeenCalledTimes(1);
        }
      } finally {
        global.fetch = originalFetch;
        await closeConversationHistoryIndexes();
        rmSync(yeaftDir, { recursive: true, force: true });
      }
    });

    it('stops after one content-policy recovery and exposes a safe actionable error', async () => {
      const { LLMPolicyError } = await import('../../../agent/yeaft/llm/adapter.js');
      let attempts = 0;
      const engine = new Engine({
        adapter: {
          async *stream() {
            attempts += 1;
            throw new LLMPolicyError('raw provider body containing credential-like sample SECRET', 422);
          },
        },
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'review the security boundary' })) events.push(event);

      expect(attempts).toBe(2);
      expect(events.filter(event => event.type === 'llm_retry')).toHaveLength(1);
      const errorEvent = events.find(event => event.type === 'error');
      expect(errorEvent).toMatchObject({
        retryable: false,
        reason: 'content_policy_denied',
        retryExhausted: true,
        retryAttempts: 1,
        maxRetries: 1,
        error: expect.objectContaining({
          name: 'LLMPolicyError',
          statusCode: 422,
          reasonCode: 'content_policy_denied',
          message: expect.stringContaining('Continue and avoid repeating sensitive payloads'),
        }),
      });
      expect(errorEvent.error.message).not.toContain('SECRET');
      expect(events.filter(event => event.type === 'turn_end').at(-1)).toMatchObject({
        stopReason: 'error',
        terminal: true,
        detail: expect.objectContaining({
          reason: 'content_policy_denied',
          statusCode: 422,
        }),
      });
    });

    it('terminates on non-retryable in-band adapter error instead of normal end_turn', async () => {
      const failed = new Error('bad request body');
      failed.code = 'invalid_request_error';
      const engine = new Engine({
        adapter: {
          async *stream() {
            yield { type: 'error', error: failed, retryable: false };
          },
        },
        trace,
        config: {
          model: 'test-model',
          maxOutputTokens: 1024,
          llmRetry: { maxRetries: 5, baseDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 },
        },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello' })) {
        events.push(event);
      }

      expect(events.filter(e => e.type === 'llm_retry')).toHaveLength(0);
      const errorEvents = events.filter(e => e.type === 'error');
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].error.message).toBe('bad request body');
      expect(errorEvents[0].retryable).toBe(false);
      const loops = events.filter(e => e.type === 'loop');
      expect(loops).toHaveLength(1);
      expect(loops[0].stopReason).toBe('error');
      expect(loops[0].response).toBe('Error: bad request body');
      expect(events).toContainEqual(expect.objectContaining({ type: 'turn_end', stopReason: 'error' }));
      expect(events).not.toContainEqual(expect.objectContaining({ type: 'turn_end', stopReason: 'end_turn' }));
    });

    it('settles retry persistence at dispatch, close, and terminal failure boundaries', async () => {
      const { LLMServerError } = await import('../../../agent/yeaft/llm/adapter.js');
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-retry-turn-start-close-'));
      try {
        const conversationStore = new ConversationStore(yeaftDir);
        let attempts = 0;
        const engine = new Engine({
          adapter: {
            async *stream() {
              attempts += 1;
              if (attempts === 1) {
                yield { type: 'text_delta', text: 'visible partial before retry' };
                throw new LLMServerError('temporary upstream failure', 503);
              }
              yield { type: 'stop', stopReason: 'end_turn' };
            },
          },
          trace,
          conversationStore,
          yeaftDir,
          config: {
            model: 'test-model',
            maxOutputTokens: 1024,
            llmRetry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
          },
        });

        const iterator = engine.query({
          prompt: 'hi',
          sessionId: 'session-retry-turn-start-close',
          vpTurnId: 'turn-retry-turn-start-close',
        })[Symbol.asyncIterator]();
        let secondTurnStart = false;
        while (true) {
          const step = await iterator.next();
          if (step.done) throw new Error('retry ended before its next turn_start');
          if (step.value.type === 'turn_start' && step.value.turnNumber === 2) {
            secondTurnStart = true;
            break;
          }
        }
        expect(secondTurnStart).toBe(true);
        expect(attempts).toBe(1);
        await iterator.return();

        expect(attempts).toBe(1);
        expect(conversationStore.loadRecentBySession('session-retry-turn-start-close', Infinity)).toEqual([
          expect.objectContaining({ role: 'user', content: 'hi' }),
          expect.objectContaining({
            role: 'assistant',
            content: 'visible partial before retry',
            incomplete: true,
            stopReason: 'aborted',
            turnId: 'turn-retry-turn-start-close',
          }),
        ]);
      } finally {
        await closeConversationHistoryIndexes();
        rmSync(yeaftDir, { recursive: true, force: true });
      }

      const routerDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-router-retry-close-'));
      const routerFetch = globalThis.fetch;
      try {
        const conversationStore = new ConversationStore(routerDir);
        let fetches = 0;
        globalThis.fetch = async () => {
          fetches += 1;
          return new Response(
            'event: response.output_text.delta\n' +
            'data: {"type":"response.output_text.delta","delta":"visible router partial"}\n\n',
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          );
        };
        const router = new AdapterRouter({
          providers: [{
            name: 'retry-router',
            baseUrl: 'https://retry-router.example/v1',
            apiKey: 'retry-router-key',
            protocol: 'openai-responses',
            models: ['retry-router-model'],
          }],
        });
        const routerEngine = new Engine({
          adapter: router,
          trace,
          conversationStore,
          yeaftDir: routerDir,
          config: {
            model: 'retry-router/retry-router-model',
            maxOutputTokens: 1024,
            llmRetry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
          },
        });
        const iterator = routerEngine.query({
          prompt: 'router retry',
          sessionId: 'session-router-retry-close',
          vpTurnId: 'turn-router-retry-close',
        })[Symbol.asyncIterator]();
        while (true) {
          const step = await iterator.next();
          if (step.done) throw new Error('retry ended before second turn_start');
          if (step.value.type === 'turn_start' && step.value.turnNumber === 2) break;
        }
        expect(fetches).toBe(1);
        await iterator.return();
        expect(fetches).toBe(1);
        expect(conversationStore.loadRecentBySession('session-router-retry-close', Infinity))
          .not.toContainEqual(expect.objectContaining({
            role: 'user',
            content: expect.stringContaining('Continue from the exact point'),
          }));
      } finally {
        globalThis.fetch = routerFetch;
        rmSync(routerDir, { recursive: true, force: true });
      }

      const boundaryDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-retry-abort-partial-'));
      try {
        const conversationStore = new ConversationStore(boundaryDir);
        let attempts = 0;
        const engine = new Engine({
          adapter: {
            async *stream() {
              attempts += 1;
              yield { type: 'text_delta', text: 'visible partial before retry' };
              throw new LLMServerError('temporary upstream failure', 503);
            },
          },
          trace,
          conversationStore,
          yeaftDir: boundaryDir,
          config: {
            model: 'test-model',
            maxOutputTokens: 1024,
            llmRetry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
          },
        });

        const iterator = engine.query({
          prompt: 'hi',
          sessionId: 'session-retry-abort',
          vpTurnId: 'turn-retry-abort',
        })[Symbol.asyncIterator]();
        const events = [];
        while (true) {
          const step = await iterator.next();
          if (step.done) break;
          events.push(step.value);
          if (step.value.type === 'turn_end' && step.value.stopReason === 'llm_retry') break;
        }
        await iterator.return();

        expect(attempts).toBe(1);
        expect(events.some(e => e.type === 'llm_retry')).toBe(true);
        expect(events).toContainEqual(expect.objectContaining({ type: 'turn_end', stopReason: 'llm_retry' }));
        expect(conversationStore.loadRecentBySession('session-retry-abort', Infinity)).toEqual([
          expect.objectContaining({ role: 'user', content: 'hi' }),
          expect.objectContaining({
            role: 'assistant',
            content: 'visible partial before retry',
            incomplete: true,
            stopReason: 'aborted',
            turnId: 'turn-retry-abort',
          }),
        ]);
      } finally {
        rmSync(boundaryDir, { recursive: true, force: true });
      }
      const errorDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-retry-final-partial-'));
      try {
        const conversationStore = new ConversationStore(errorDir);
        let attempts = 0;
        const engine = new Engine({
          adapter: {
            async *stream() {
              attempts += 1;
              if (attempts === 1) yield { type: 'text_delta', text: 'visible partial before failure' };
              throw new LLMServerError('temporary upstream failure', 503);
            },
          },
          trace,
          conversationStore,
          yeaftDir: errorDir,
          config: {
            model: 'test-model',
            maxOutputTokens: 1024,
            llmRetry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
          },
        });

        const events = [];
        for await (const event of engine.query({
          prompt: 'hi',
          sessionId: 'session-retry-final-partial',
          vpTurnId: 'turn-retry-final-partial',
        })) events.push(event);

        expect(attempts).toBe(3);
        expect(events).toContainEqual(expect.objectContaining({ type: 'error', retryable: true }));
        expect(conversationStore.loadRecentBySession('session-retry-final-partial', Infinity)).toEqual([
          expect.objectContaining({ role: 'user', content: 'hi' }),
          expect.objectContaining({
            role: 'assistant',
            content: 'visible partial before failure',
            incomplete: true,
            stopReason: 'error',
            turnId: 'turn-retry-final-partial',
          }),
          expect.objectContaining({
            role: 'user',
            userAuthored: false,
            content: expect.stringContaining('Continue from the exact point'),
          }),
        ]);
      } finally {
        rmSync(errorDir, { recursive: true, force: true });
      }
    });
  });

  describe('abort signal', () => {
    it('links normal signals and handles pre-aborted signals', async () => {
      const ac = new AbortController();
      let receivedSignal = null;

      const abortAdapter = {
        async *stream(params) {
          receivedSignal = params.signal;
          // Simulate checking the signal
          if (params.signal?.aborted) {
            throw new Error('Request aborted');
          }
          yield { type: 'text_delta', text: 'Hello' };
          yield { type: 'stop', stopReason: 'end_turn' };
        },
      };

      const engine = new Engine({
        adapter: abortAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello', signal: ac.signal })) {
        events.push(event);
      }

      // task-325a: the engine now owns an internal AbortController that
      // mirrors the caller-provided signal, so the adapter receives the
      // engine's linked signal (not the caller's identity). Verify that
      // a valid AbortSignal was propagated rather than identity.
      expect(receivedSignal).toBeInstanceOf(AbortSignal);
      // Verify normal completion when signal is not aborted
      const textEvents = events.filter(e => e.type === 'text_delta');
      expect(textEvents).toHaveLength(1);

      const preAbortedController = new AbortController();
      preAbortedController.abort(); // Pre-abort

      const preAbortedAdapter = {
        async *stream(params) {
          if (params.signal?.aborted) {
            throw new Error('Request aborted');
          }
          yield { type: 'text_delta', text: 'Should not reach' };
          yield { type: 'stop', stopReason: 'end_turn' };
        },
      };

      const preAbortedEngine = new Engine({
        adapter: preAbortedAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      const preAbortedEvents = [];
      for await (const event of preAbortedEngine.query({ prompt: 'hello', signal: preAbortedController.signal })) {
        preAbortedEvents.push(event);
      }

      // task-325a: pre-aborted external signal now converges on the
      // typed `aborted` event (not a generic `error`), and the turn
      // ends with stopReason 'aborted'.
      const abortedEvents = preAbortedEvents.filter(e => e.type === 'aborted');
      expect(abortedEvents).toHaveLength(1);
      expect(abortedEvents[0].reason).toBe('external');
      const turnEnds = preAbortedEvents.filter(e => e.type === 'turn_end');
      expect(turnEnds).toEqual([expect.objectContaining({ stopReason: 'aborted', terminal: true })]);
    });

    // Regression: per-VP Stop in Yeaft Session was not interrupting the
    // current turn promptly. The wire frame reached the agent, the
    // controller fired, but the upstream LLM stream had already buffered
    // a batch of SSE chunks at the network/proxy layer. The adapter
    // continued reading them (reader.read() doesn't observe the signal
    // synchronously when chunks are already in the kernel buffer), and
    // the engine for-await loop happily yielded each chunk to the
    // web-bridge, which pushed yeaft_output frames to the browser for
    // 1–2s after Stop. The fix: engine must check signal.aborted before
    // yielding each adapter event so already-buffered chunks are
    // dropped — not forwarded — once the user has requested abort.

    it('treats a clean stream end after abort as aborted', async () => {
      let abortFn = null;
      const noncoopAdapter = {
        async *stream() {
          yield { type: 'text_delta', text: 'partial ' };
          if (abortFn) abortFn();
          // Some proxies close the body cleanly on abort instead of throwing.
          // No more events are yielded, so only the post-stream guard can
          // prevent this truncated response from reaching persistence.
        },
      };

      const ac = new AbortController();
      abortFn = () => ac.abort('user');
      const engine = new Engine({
        adapter: noncoopAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hi', signal: ac.signal })) {
        events.push(event);
      }

      expect(events.filter(e => e.type === 'text_delta')).toHaveLength(1);
      expect(events.filter(e => e.type === 'aborted')).toHaveLength(1);
      expect(events.filter(e => e.type === 'turn_end')).toEqual([expect.objectContaining({ stopReason: 'aborted', terminal: true })]);
    });

    it('drops adapter chunks emitted after abort fires mid-stream', async () => {
      // Same as above but abort fires AFTER a few chunks were already
      // legitimately delivered. Everything emitted post-abort must be
      // dropped; pre-abort chunks must still flow.
      let abortFn = null;
      const noncoopAdapter = {
        async *stream(_params) {
          for (let i = 0; i < 5; i += 1) {
            yield { type: 'text_delta', text: `pre-${i} ` };
          }
          // Trigger abort mid-stream. The remaining 25 chunks are the
          // "already in network buffer" payload the engine must drop.
          if (abortFn) abortFn();
          for (let i = 0; i < 25; i += 1) {
            yield { type: 'text_delta', text: `post-${i} ` };
          }
          yield { type: 'stop', stopReason: 'end_turn' };
        },
      };

      const ac = new AbortController();
      abortFn = () => ac.abort('user');

      const engine = new Engine({
        adapter: noncoopAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hi', signal: ac.signal })) {
        events.push(event);
      }

      const textDeltas = events.filter(e => e.type === 'text_delta');
      const preChunks = textDeltas.filter(e => e.text.startsWith('pre-'));
      const postChunks = textDeltas.filter(e => e.text.startsWith('post-'));

      expect(preChunks).toHaveLength(5);
      // With the bug: postChunks.length === 25. With the fix: 0.
      expect(postChunks).toHaveLength(0);
      const aborted = events.filter(e => e.type === 'aborted');
      const turnEnds = events.filter(e => e.type === 'turn_end');
      expect(aborted).toHaveLength(1);
      expect(turnEnds).toEqual([expect.objectContaining({ stopReason: 'aborted', terminal: true })]);
    });
  });

  describe('tools passed to adapter', () => {
    it('fails closed for an invalid persisted policy across tools and skills', async () => {
      const registry = new ToolRegistry();
      let executions = 0;
      registry.register(defineTool({
        name: 'SensitiveTool',
        description: 'Must not run under a deny-all policy',
        parameters: { type: 'object', properties: {} },
        execute: async () => { executions += 1; return 'unexpected'; },
      }));
      const skillManager = {
        has: () => true,
        list: () => [{ name: 'sensitive-skill', description: 'Sensitive skill' }],
        get: name => ({ name }),
        resolve: name => ({ name }),
        view: name => ({ name }),
        findRelevant: () => [{ name: 'sensitive-skill', description: 'Sensitive skill' }],
        getPromptContent: () => 'SENSITIVE SKILL CONTENT',
      };
      mockAdapter.pushResponse([
        { type: 'tool_call', id: 'deny-all-tool', name: 'SensitiveTool', input: {} },
        { type: 'stop', stopReason: 'tool_use' },
      ]);
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'done' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);
      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: {
          model: 'test-model',
          maxOutputTokens: 1024,
          plugins: { tools: [], skills: [], mcpServers: [] },
          pluginConfigError: 'plugins.tools must be an array',
        },
        toolRegistry: registry,
        skillManager,
      });
      const events = [];
      for await (const event of engine.query({ prompt: 'run sensitive capability' })) events.push(event);
      expect(mockAdapter.callLog.at(-2).tools).toBeUndefined();
      expect(mockAdapter.callLog.at(-2).system).not.toContain('SENSITIVE SKILL CONTENT');
      expect(executions).toBe(0);
      expect(events.find(event => event.type === 'tool_end')).toMatchObject({
        name: 'SensitiveTool',
        isError: true,
      });
    });
  });
});

describe('native Session response publication', () => {
  const input = { title: 'Verified result', summary: 'All three checks passed.', phase: 'final', blocks: [{ type: 'metrics', items: [{ label: 'Checks', value: '3' }] }] };
  const dirs = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeConversationHistoryIndexes();
    dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
  });
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-presentation-')); dirs.push(dir);
    const store = new ConversationStore(dir);
    const requests = [];
    const responses = [];
    const adapter = { async *stream(params) {
      requests.push({ ...params, messages: structuredClone(params.messages), tools: structuredClone(params.tools) });
      const events = responses.shift();
      if (events instanceof Error) throw events;
      if (!events) throw new Error('Unexpected provider request');
      yield* events;
    } };
    const engine = new Engine({ adapter, trace: new NullTrace(), config: { model: 'test-model', maxOutputTokens: 1024, maxRetries: 0 }, conversationStore: store, yeaftDir: dir, vpId: 'vp-a', toolRegistry: createFullRegistry() });
    return { engine, store, dir, requests, responses };
  }
  const query = { prompt: 'Show the verified result', sessionId: 'session-a', vpTurnId: 'turn-a', threadId: 'main' };
  const call = (id = 'publish-a', payload = input) => ({ type: 'tool_call', id, name: 'PresentResponse', input: payload });
  const stop = stopReason => ({ type: 'stop', stopReason });
  async function collect(engine, params = query, callback = () => {}) { const events = []; for await (const event of engine.query(params)) { events.push(event); callback(event); } return events; }

  it('fences cancellation before publication and keeps delivered snapshots as progress on failed turns', async () => {
    const f = fixture(); const controller = new AbortController();
    f.responses.push([call(), stop('tool_use')]);
    const events = await collect(f.engine, { ...query, signal: controller.signal }, event => { if (event.type === 'tool_exec') controller.abort(); });
    expect(events.filter(event => event.type === 'response_presentation')).toEqual([]);
    expect(f.store.loadAllBySession('session-a').filter(row => row.presentation)).toEqual([]);
    const g = fixture(); g.responses.push([call(), stop('tool_use')], [stop('error')]);
    const failed = await collect(g.engine);
    expect(failed.filter(event => event.type === 'response_presentation')).toHaveLength(1);
    expect(g.store.loadAllBySession('session-a').find(row => row.presentation)).toMatchObject({ incomplete: true, stopReason: 'error', responseKind: 'progress' });
  });
});
