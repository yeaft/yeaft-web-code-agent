/**
 * task-331 — Debug turn must preserve function_call metadata.
 *
 * §A. mapDebugMessage (pure) — assistant.toolCalls / tool.toolCallId / tool.isError
 *     pass through; content is truncated; oversized tool_call input is sliced.
 *
 * §B. Engine debug_turn integration — a pure tool_use turn (no text) followed
 *     by a text turn must surface the prior turn's toolCalls in the SECOND
 *     debug_turn's `messages[prevAssistantIdx].toolCalls`.
 *
 * Red line: don't change `debug_turn` event shape; only grow `messages[i]`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Engine, mapDebugMessage } from '../../../agent/unify/engine.js';
import { NullTrace } from '../../../agent/unify/debug-trace.js';

class MockAdapter {
  constructor() { this.responses = []; }
  pushResponse(events) { this.responses.push(events); }
  async *stream() {
    const events = this.responses.shift();
    if (!events) throw new Error('MockAdapter: no more responses');
    for (const e of events) yield e;
  }
  async call() { return { text: '', usage: { inputTokens: 0, outputTokens: 0 } }; }
}

// ─── §A. mapDebugMessage (pure) ─────────────────────────────────

describe('task-331 §A — mapDebugMessage', () => {
  it('preserves role + content on plain user messages', () => {
    const out = mapDebugMessage({ role: 'user', content: 'hello' });
    expect(out).toEqual({ role: 'user', content: 'hello' });
  });

  it('preserves assistant.toolCalls (id + name + input)', () => {
    const out = mapDebugMessage({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'tc_1', name: 'Bash', input: { command: 'ls' } }],
    });
    expect(out.toolCalls).toEqual([
      { id: 'tc_1', name: 'Bash', input: { command: 'ls' } },
    ]);
  });

  it('preserves tool.toolCallId + isError', () => {
    const out = mapDebugMessage({
      role: 'tool',
      toolCallId: 'tc_1',
      content: 'output',
      isError: true,
    });
    expect(out.toolCallId).toBe('tc_1');
    expect(out.isError).toBe(true);
    expect(out.content).toBe('output');
  });

  it('omits isError when false/undefined to keep snapshot compact', () => {
    const out = mapDebugMessage({ role: 'tool', toolCallId: 'x', content: 'ok', isError: false });
    // false is a valid value, but !=null so it survives — spec: preserve when set.
    expect(out.isError).toBe(false);
    const noFlag = mapDebugMessage({ role: 'tool', toolCallId: 'x', content: 'ok' });
    expect('isError' in noFlag).toBe(false);
  });

  it('truncates string content past 50000 chars', () => {
    const big = 'x'.repeat(60000);
    const out = mapDebugMessage({ role: 'user', content: big });
    expect(out.content.length).toBe(50000);
  });

  it('truncates oversized tool_call input to preview', () => {
    const bigInput = { data: 'y'.repeat(20000) };
    const out = mapDebugMessage({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 't1', name: 'X', input: bigInput }],
    });
    expect(out.toolCalls[0].input.__truncated).toBe(true);
    expect(typeof out.toolCalls[0].input.preview).toBe('string');
    expect(out.toolCalls[0].input.preview.length).toBe(10000);
  });

  it('does not add toolCalls key when absent', () => {
    const out = mapDebugMessage({ role: 'assistant', content: 'text' });
    expect('toolCalls' in out).toBe(false);
  });
});

// ─── §B. Engine debug_turn integration ──────────────────────────

describe('task-331 §B — Engine debug_turn preserves function_call history', () => {
  let adapter;
  let engine;

  beforeEach(() => {
    adapter = new MockAdapter();
    engine = new Engine({
      adapter,
      trace: new NullTrace(),
      config: { model: 'mock', maxOutputTokens: 1024 },
    });
    engine.registerTool({
      name: 'EchoTool',
      description: 'Echo input',
      inputSchema: { type: 'object' },
      async execute(input) { return `echoed:${JSON.stringify(input)}`; },
    });
  });

  it('debug_turn in turn-1 carries toolCalls for the model request', async () => {
    adapter.pushResponse([
      { type: 'tool_call', id: 'call_1', name: 'EchoTool', input: { n: 1 } },
      { type: 'stop', stopReason: 'tool_use' },
      { type: 'usage', inputTokens: 5, outputTokens: 3 },
    ]);
    adapter.pushResponse([
      { type: 'text_delta', text: 'done' },
      { type: 'stop', stopReason: 'end_turn' },
      { type: 'usage', inputTokens: 2, outputTokens: 1 },
    ]);

    const events = [];
    for await (const ev of engine.query({ prompt: 'hi' })) events.push(ev);

    const debugTurns = events.filter(e => e.type === 'debug_turn');
    expect(debugTurns.length).toBe(2);

    // Turn 1: the request was the tool_call; debug_turn.toolCalls captures it.
    expect(debugTurns[0].toolCalls).toEqual([
      { id: 'call_1', name: 'EchoTool', input: { n: 1 } },
    ]);

    // Turn 2: previous assistant's toolCalls must be visible via messages[].
    const t2Messages = debugTurns[1].messages;
    const assistantWithCalls = t2Messages.find(
      m => m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0
    );
    expect(assistantWithCalls).toBeDefined();
    expect(assistantWithCalls.toolCalls[0].id).toBe('call_1');
    expect(assistantWithCalls.toolCalls[0].name).toBe('EchoTool');
    expect(assistantWithCalls.toolCalls[0].input).toEqual({ n: 1 });

    // And the paired tool_result must carry toolCallId for front-end pairing.
    const toolMsg = t2Messages.find(m => m.role === 'tool' && m.toolCallId === 'call_1');
    expect(toolMsg).toBeDefined();
    expect(typeof toolMsg.content).toBe('string');
    expect(toolMsg.content).toContain('echoed:');
  });
});
