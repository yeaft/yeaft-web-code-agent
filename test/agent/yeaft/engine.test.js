import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Engine, extractSessionTopicsFromAmsEntries } from '../../../agent/yeaft/engine.js';
import { AmsRegistry } from '../../../agent/yeaft/memory/ams-registry.js';
import { writeSummary } from '../../../agent/yeaft/memory/store.js';
import { NullTrace, DebugTrace } from '../../../agent/yeaft/debug-trace.js';

// ─── Mock Adapter ─────────────────────────────────────────────

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

// ─── Test Setup ───────────────────────────────────────────────

const TEST_DB = join(tmpdir(), `yeaft-test-engine-${Date.now()}.db`);
let trace;
let mockAdapter;

beforeEach(() => {
  trace = new NullTrace();
  mockAdapter = new MockAdapter();
});

afterEach(() => {
  // Clean up any DB files
  for (const suffix of ['', '-wal', '-shm']) {
    const path = TEST_DB + suffix;
    if (existsSync(path)) rmSync(path);
  }
});

// ─── Tests ────────────────────────────────────────────────────

describe('Engine', () => {
  describe('constructor', () => {
    it('should create an engine with trace ID', () => {
      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });
      expect(engine.traceId).toBeTruthy();
      expect(typeof engine.traceId).toBe('string');
    });
  });

  describe('tool registration', () => {
    it('should register and list tools', () => {
      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model' },
      });

      engine.registerTool({
        name: 'search',
        description: 'Search the web',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
        execute: async (input) => `Results for: ${input.q}`,
      });

      expect(engine.toolNames).toEqual(['search']);
    });

    it('should unregister tools', () => {
      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model' },
      });

      engine.registerTool({
        name: 'search',
        description: 'Search',
        parameters: {},
        execute: async () => 'ok',
      });

      engine.unregisterTool('search');
      expect(engine.toolNames).toEqual([]);
    });
  });

  describe('input validation', () => {
    it('should yield error for empty prompt', async () => {
      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      const events = [];
      for await (const event of engine.query({ prompt: '' })) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('error');
      expect(events[0].error.message).toContain('prompt is required');
      // Should NOT have called adapter
      expect(mockAdapter.callLog).toHaveLength(0);
    });

    it('should yield error for null prompt', async () => {
      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      const events = [];
      for await (const event of engine.query({ prompt: null })) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('error');
    });

    it('should yield error for whitespace-only prompt', async () => {
      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      const events = [];
      for await (const event of engine.query({ prompt: '   ' })) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('error');
    });
  });

  describe('simple query (no tools)', () => {
    it('should yield text events and complete', async () => {
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'Hello' },
        { type: 'text_delta', text: ' world' },
        { type: 'usage', inputTokens: 50, outputTokens: 10 },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello' })) {
        events.push(event);
      }

      // Should have: turn_start, text_delta, text_delta, usage, stop, turn_end
      const types = events.map(e => e.type);
      expect(types).toContain('turn_start');
      expect(types).toContain('text_delta');
      expect(types).toContain('usage');
      expect(types).toContain('stop');
      expect(types).toContain('turn_end');

      // Check text content
      const textEvents = events.filter(e => e.type === 'text_delta');
      expect(textEvents).toHaveLength(2);
      expect(textEvents[0].text).toBe('Hello');
      expect(textEvents[1].text).toBe(' world');

      // Check turn_end
      const turnEnd = events.find(e => e.type === 'turn_end');
      expect(turnEnd.stopReason).toBe('end_turn');
      expect(turnEnd.turnNumber).toBe(1);
    });

    it('loads Dream session summary into the system prompt Memory section and debug event', async () => {
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-dream-load-'));
      await writeSummary(
        { kind: 'session', id: 'g1' },
        'The user prefers concrete execution notes and wants Dream memory loaded into the prompt.',
        { root: join(yeaftDir, 'memory') },
      );
      await writeSummary(
        { kind: 'user' },
        'User-level Dream summary should enter the prompt but not the dream_memory_loaded browser payload.',
        { root: join(yeaftDir, 'memory') },
      );
      await writeSummary(
        { kind: 'session-vp', sessionId: 'g1', id: 'vp1' },
        'VP Dream summary should enter the prompt but not the session prompt-load payload.',
        { root: join(yeaftDir, 'memory') },
      );
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        yeaftDir,
        sessionId: 'g1',
        config: { model: 'claude-test', maxOutputTokens: 2048, language: 'en' },
        amsRegistry: new AmsRegistry({ yeaftDir, config: {} }),
      });

      const events = [];
      for await (const event of engine.query({
        prompt: 'test',
        sessionId: 'g1',
        vpPersona: { vpId: 'vp1', name: 'VP One' },
      })) {
        events.push(event);
      }

      expect(mockAdapter.callLog).toHaveLength(1);
      const system = mockAdapter.callLog[0].system;
      expect(system).toContain('## Active Memory Set');
      expect(system).toContain('### Resident');
      expect(system).toContain('sessions/g1');
      expect(system).toContain('Dream memory loaded into the prompt');
      expect(system).toContain('User-level Dream summary should enter the prompt');
      expect(system).toContain('VP Dream summary should enter the prompt');

      const loaded = events.find(e => e.type === 'dream_memory_loaded');
      expect(loaded).toBeTruthy();
      expect(loaded.loadedInto).toBe('system_prompt.memory');
      expect(loaded.resident).toHaveLength(1);
      expect(loaded.resident).toEqual([expect.objectContaining({
        scope: 'sessions/g1',
        source: 'resident-summary',
      })]);
    });

    it('should pass model and system prompt to adapter', async () => {
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'Hi' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'claude-test', maxOutputTokens: 2048 },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'test' })) {
        events.push(event);
      }

      expect(mockAdapter.callLog).toHaveLength(1);
      const call = mockAdapter.callLog[0];
      expect(call.model).toBe('claude-test');
      expect(call.system).toContain('Yeaft');
      expect(call.system).toContain('work');
      expect(call.maxTokens).toBe(2048);
      expect(call.messages).toHaveLength(1);
      expect(call.messages[0].role).toBe('user');
      expect(call.messages[0].content).toBe('test');
    });
  });

  describe('tool execution loop', () => {
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

      // Check we got 2 turns
      const turnStarts = events.filter(e => e.type === 'turn_start');
      expect(turnStarts).toHaveLength(2);

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
    });

    it('should handle tool execution errors gracefully', async () => {
      mockAdapter.pushResponse([
        { type: 'tool_call', id: 'call_1', name: 'failing_tool', input: {} },
        { type: 'stop', stopReason: 'tool_use' },
      ]);

      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'The tool failed, sorry.' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      engine.registerTool({
        name: 'failing_tool',
        description: 'A tool that fails',
        parameters: {},
        execute: async () => { throw new Error('Tool crashed'); },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'use the tool' })) {
        events.push(event);
      }

      // Tool should have reported error
      const toolEnds = events.filter(e => e.type === 'tool_end');
      expect(toolEnds).toHaveLength(1);
      expect(toolEnds[0].isError).toBe(true);
      expect(toolEnds[0].output).toContain('Tool crashed');

      // Engine should still complete
      const lastTurnEnd = events.filter(e => e.type === 'turn_end').pop();
      expect(lastTurnEnd.stopReason).toBe('end_turn');
    });

    it('should handle unknown tool gracefully', async () => {
      mockAdapter.pushResponse([
        { type: 'tool_call', id: 'call_1', name: 'nonexistent', input: {} },
        { type: 'stop', stopReason: 'tool_use' },
      ]);

      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'I see the tool was not found.' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'use nonexistent' })) {
        events.push(event);
      }

      const toolEnds = events.filter(e => e.type === 'tool_end');
      expect(toolEnds).toHaveLength(1);
      expect(toolEnds[0].isError).toBe(true);
      expect(toolEnds[0].output).toContain('unknown tool');
    });
  });

  describe('multiple tool calls in one turn', () => {
    it('should execute multiple tools from a single response', async () => {
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'Searching both...' },
        { type: 'tool_call', id: 'call_1', name: 'search', input: { q: 'foo' } },
        { type: 'tool_call', id: 'call_2', name: 'search', input: { q: 'bar' } },
        { type: 'stop', stopReason: 'tool_use' },
      ]);

      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'Found both results.' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      engine.registerTool({
        name: 'search',
        description: 'Search',
        parameters: {},
        execute: async (input) => `Results: ${input.q}`,
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'search foo and bar' })) {
        events.push(event);
      }

      const toolEnds = events.filter(e => e.type === 'tool_end');
      expect(toolEnds).toHaveLength(2);
      expect(toolEnds[0].output).toBe('Results: foo');
      expect(toolEnds[1].output).toBe('Results: bar');

      // Second call should have both tool results
      const secondCall = mockAdapter.callLog[1];
      const toolMessages = secondCall.messages.filter(m => m.role === 'tool');
      expect(toolMessages).toHaveLength(2);
    });
  });

  describe('no max turns cap (task-324)', () => {
    it('should run past the old MAX_TURNS=25 cap when tool loop continues', async () => {
      // Push 30 tool_use responses, then a final end_turn — old behavior
      // would error at turn 26, new behavior runs all 30 tool turns + 1
      // final response turn.
      for (let i = 0; i < 30; i++) {
        mockAdapter.pushResponse([
          { type: 'tool_call', id: `call_${i}`, name: 'echo', input: { msg: `${i}` } },
          { type: 'stop', stopReason: 'tool_use' },
        ]);
      }
      // Final turn: end_turn (no tool calls) to let the loop exit cleanly.
      mockAdapter.pushResponse([
        { type: 'text_delta', delta: 'done' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      engine.registerTool({
        name: 'echo',
        description: 'Echo',
        parameters: {},
        execute: async (input) => input.msg,
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'loop past old cap' })) {
        events.push(event);
      }

      // No "Max turns" error event should be emitted.
      const errorEvents = events.filter(e => e.type === 'error');
      const maxTurnsErrors = errorEvents.filter(e =>
        e.error && /Max turns/.test(e.error.message || '')
      );
      expect(maxTurnsErrors).toHaveLength(0);

      // Turns executed should exceed the old cap of 25.
      const turnStarts = events.filter(e => e.type === 'turn_start');
      expect(turnStarts.length).toBeGreaterThan(25);
      // And should include the final end_turn turn (31 total).
      expect(turnStarts.length).toBe(31);
    });
  });

  describe('adapter errors', () => {
    it('should handle adapter throw gracefully', async () => {
      const engine = new Engine({
        adapter: {
          async *stream() {
            throw new Error('Network error');
          },
        },
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello' })) {
        events.push(event);
      }

      const errorEvents = events.filter(e => e.type === 'error');
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].error.message).toBe('Network error');
      expect(errorEvents[0].retryable).toBe(false);

      // Should still emit turn_end
      const turnEnds = events.filter(e => e.type === 'turn_end');
      expect(turnEnds).toHaveLength(1);
      expect(turnEnds[0].stopReason).toBe('error');
    });

    it('should mark LLMRateLimitError as retryable', async () => {
      const { LLMRateLimitError } = await import('../../../agent/yeaft/llm/adapter.js');

      const engine = new Engine({
        adapter: {
          async *stream() {
            throw new LLMRateLimitError('Too fast', 429);
          },
        },
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello' })) {
        events.push(event);
      }

      const errorEvents = events.filter(e => e.type === 'error');
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].retryable).toBe(true);
    });

    it('should mark LLMServerError as retryable', async () => {
      const { LLMServerError } = await import('../../../agent/yeaft/llm/adapter.js');

      const engine = new Engine({
        adapter: {
          async *stream() {
            throw new LLMServerError('Internal error', 500);
          },
        },
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello' })) {
        events.push(event);
      }

      const errorEvents = events.filter(e => e.type === 'error');
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].retryable).toBe(true);
    });
  });

  describe('max_tokens stop reason', () => {
    it('should yield turn_end with max_tokens when output is truncated', async () => {
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'This response was cut short because—' },
        { type: 'usage', inputTokens: 50, outputTokens: 16384 },
        { type: 'stop', stopReason: 'max_tokens' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 16384 },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'write a long essay' })) {
        events.push(event);
      }

      // Should have stop event with max_tokens
      const stopEvents = events.filter(e => e.type === 'stop');
      expect(stopEvents).toHaveLength(1);
      expect(stopEvents[0].stopReason).toBe('max_tokens');

      // turn_end should reflect max_tokens_continue (Phase 2: auto-continue)
      const turnEnd = events.find(e => e.type === 'turn_end');
      expect(turnEnd.stopReason).toBe('max_tokens_continue');
      expect(turnEnd.turnNumber).toBe(1);

      // Phase 2: auto-continue triggers additional turns
      const turnStarts = events.filter(e => e.type === 'turn_start');
      expect(turnStarts.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('abort signal', () => {
    it('should propagate abort signal to adapter', async () => {
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
    });

    it('should handle pre-aborted signal', async () => {
      const ac = new AbortController();
      ac.abort(); // Pre-abort

      const abortAdapter = {
        async *stream(params) {
          if (params.signal?.aborted) {
            throw new Error('Request aborted');
          }
          yield { type: 'text_delta', text: 'Should not reach' };
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

      // task-325a: pre-aborted external signal now converges on the
      // typed `aborted` event (not a generic `error`), and the turn
      // ends with stopReason 'aborted'.
      const abortedEvents = events.filter(e => e.type === 'aborted');
      expect(abortedEvents).toHaveLength(1);
      expect(abortedEvents[0].reason).toBe('external');
      const turnEnds = events.filter(e => e.type === 'turn_end');
      expect(turnEnds.at(-1).stopReason).toBe('aborted');
    });

    it('should pass signal to tool execute function', async () => {
      const ac = new AbortController();
      let toolReceivedSignal = null;

      mockAdapter.pushResponse([
        { type: 'tool_call', id: 'call_1', name: 'slow_tool', input: {} },
        { type: 'stop', stopReason: 'tool_use' },
      ]);

      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'Done.' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      engine.registerTool({
        name: 'slow_tool',
        description: 'A slow tool',
        parameters: {},
        execute: async (input, ctx) => {
          toolReceivedSignal = ctx?.signal;
          return 'done';
        },
      });

      for await (const _event of engine.query({ prompt: 'use tool', signal: ac.signal })) {
        // consume
      }

      // task-325a: engine's internal linked signal is forwarded, so the
      // tool receives an AbortSignal — not the caller's identity.
      expect(toolReceivedSignal).toBeInstanceOf(AbortSignal);
    });
  });

  describe('debug trace integration', () => {
    it('should record turns and tools in debug trace', async () => {
      const dbTrace = new DebugTrace(TEST_DB);

      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'Let me search.' },
        { type: 'tool_call', id: 'call_1', name: 'search', input: { q: 'test' } },
        { type: 'usage', inputTokens: 50, outputTokens: 20 },
        { type: 'stop', stopReason: 'tool_use' },
      ]);

      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'Done.' },
        { type: 'usage', inputTokens: 80, outputTokens: 10 },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace: dbTrace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      engine.registerTool({
        name: 'search',
        description: 'Search',
        parameters: {},
        execute: async () => 'results',
      });

      for await (const _event of engine.query({ prompt: 'search test' })) {
        // consume events
      }

      // Check debug trace recorded the turns
      const stats = dbTrace.stats();
      expect(stats.turnCount).toBe(2);
      expect(stats.toolCount).toBe(1);

      // Check turn details
      const recent = dbTrace.queryRecent(10);
      expect(recent).toHaveLength(2);

      // Check tool details
      const tools = dbTrace.queryTools({ name: 'search' });
      expect(tools).toHaveLength(1);
      expect(tools[0].tool_name).toBe('search');
      expect(tools[0].tool_output).toBe('results');

      dbTrace.close();
    });
  });

  describe('existing messages', () => {
    it('should prepend existing messages to conversation', async () => {
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'I remember.' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      const existingMessages = [
        { role: 'user', content: 'my name is Alice' },
        { role: 'assistant', content: 'Nice to meet you, Alice!' },
      ];

      const events = [];
      for await (const event of engine.query({
        prompt: 'what is my name?',
        messages: existingMessages,
      })) {
        events.push(event);
      }

      // Adapter should have received all messages
      const call = mockAdapter.callLog[0];
      expect(call.messages).toHaveLength(3);
      expect(call.messages[0].content).toBe('my name is Alice');
      expect(call.messages[1].content).toBe('Nice to meet you, Alice!');
      expect(call.messages[2].content).toBe('what is my name?');
    });
  });

  describe('tools passed to adapter', () => {
    it('should pass tool definitions to adapter when tools are registered', async () => {
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      engine.registerTool({
        name: 'calculator',
        description: 'Calculate math',
        parameters: { type: 'object', properties: { expr: { type: 'string' } } },
        execute: async () => '42',
      });

      for await (const _event of engine.query({ prompt: 'test' })) {
        // consume
      }

      const call = mockAdapter.callLog[0];
      expect(call.tools).toHaveLength(1);
      expect(call.tools[0].name).toBe('calculator');
      expect(call.tools[0].description).toBe('Calculate math');
    });

    it('should not pass tools when none are registered', async () => {
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      for await (const _event of engine.query({ prompt: 'test' })) {
        // consume
      }

      const call = mockAdapter.callLog[0];
      expect(call.tools).toBeUndefined();
    });
  });

  describe('active scope in system prompt', () => {
    it('should render session id, session member, session members, and session topics without legacy labels', async () => {
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024, language: 'en' },
      });

      for await (const _event of engine.query({
        prompt: 'test',
        sessionId: 'session_active',
        sessionMembers: ['vp-omni', 'vp-martin', 'vp-linus'],
        sessionTopics: ['dream-trigger', 'active-scope'],
        vpPersona: { vpId: 'vp-linus', displayName: 'Linus' },
      })) {
        // consume
      }

      const call = mockAdapter.callLog[0];
      expect(call.system).toContain('## active_scope');
      expect(call.system).toContain('session_id: session_active');
      expect(call.system).toContain('session_member: vp-linus');
      expect(call.system).toContain('session_members: vp-omni, vp-martin, vp-linus');
      expect(call.system).toContain('session_topics: dream-trigger, active-scope');
      expect(call.system).not.toMatch(/^group:/m);
      expect(call.system).not.toMatch(/^vp:/m);
      expect(call.system).not.toMatch(/^members:/m);
    });

    it('should derive session topics from AMS/recall topic scopes', () => {
      expect(extractSessionTopicsFromAmsEntries('session_active', [
        { scope: 'sessions/session_active/topic/dream/trigger', content: 'Dream trigger notes' },
        { scope: 'sessions/other/topic/ignored', content: 'Wrong session' },
        { scope: 'sessions/session_active/vp/vp-linus', content: 'Not a topic' },
        { scope: 'sessions/session_active/topic/dream/trigger', content: 'Duplicate' },
      ])).toEqual(['dream/trigger']);
    });

  });

  describe('language in system prompt', () => {
    it('should use English system prompt by default', async () => {
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      for await (const _event of engine.query({ prompt: 'test' })) {
        // consume
      }

      const call = mockAdapter.callLog[0];
      expect(call.system).toContain('Yeaft');
      expect(call.system).not.toContain('核心原则');
    });

    it('should use Chinese system prompt when language is zh', async () => {
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024, language: 'zh' },
      });

      for await (const _event of engine.query({ prompt: 'test' })) {
        // consume
      }

      const call = mockAdapter.callLog[0];
      expect(call.system).toContain('Yeaft');
      expect(call.system).toContain('核心原则');
      expect(call.system).toContain('统一模式');
    });

    it('should include tool names in system prompt for configured language', async () => {
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024, language: 'zh' },
      });

      engine.registerTool({
        name: 'search',
        description: 'Search',
        parameters: {},
        execute: async () => 'results',
      });

      for await (const _event of engine.query({ prompt: 'test' })) {
        // consume
      }

      const call = mockAdapter.callLog[0];
      expect(call.system).toContain('可用工具：search');
    });
  });
});
