import { describe, it, expect } from 'vitest';
import { EngineInstance } from '../../agent/unify/threads/engine-instance.js';

/**
 * Regression: Unify tool_call_id pairing violation on turn 2.
 *
 * Bug: EngineInstance.query() used to append only
 *   [user, assistant(text+toolCalls)]
 * to #messages after each query. The `role:'tool'` result messages were
 * dropped entirely. On turn 2 the OpenAI adapter re-serialised
 * history and sent an assistant message with `tool_calls` that had no
 * matching `role:'tool'` entries → OpenAI returned 400:
 *   "No tool output found for function call call_xyz"
 *
 * Fix: mirror engine.js's internal conversationMessages structure —
 * flush assistant turn on `turn_end` boundary, append tool results on
 * `tool_end` events, synthesise placeholder tool results for any
 * orphaned tool_call ids (abort / error paths).
 */

// Build a fake Engine whose query() yields a preprogrammed event sequence.
function fakeEngine(events) {
  return {
    async *query(_params) {
      for (const e of events) yield e;
    },
  };
}

async function drain(asyncIter) {
  const out = [];
  for await (const v of asyncIter) out.push(v);
  return out;
}

describe('EngineInstance: tool_call ↔ tool result pairing', () => {
  it('single tool-use iteration: appends paired role:tool after assistant', async () => {
    const events = [
      { type: 'turn_start' },
      { type: 'text_delta', text: 'Checking...' },
      { type: 'tool_call', id: 'call_A', name: 'bash', input: { cmd: 'ls' } },
      { type: 'tool_start', id: 'call_A', name: 'bash' },
      { type: 'tool_end', id: 'call_A', output: 'file.txt\n' },
      { type: 'turn_end', stopReason: 'tool_use' },
      { type: 'turn_start' },
      { type: 'text_delta', text: 'Done.' },
      { type: 'turn_end', stopReason: 'end_turn' },
    ];
    const inst = new EngineInstance({ threadId: 't1', engine: fakeEngine(events) });
    await drain(inst.query({ prompt: 'hi' }));

    const msgs = inst.messages;
    // [user, assistant(text1, tools), tool(A), assistant(text2)]
    expect(msgs).toHaveLength(4);
    expect(msgs[0]).toEqual({ role: 'user', content: 'hi' });
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[1].content).toBe('Checking...');
    expect(msgs[1].toolCalls).toEqual([{ id: 'call_A', name: 'bash', input: { cmd: 'ls' } }]);
    expect(msgs[2]).toEqual({ role: 'tool', toolCallId: 'call_A', content: 'file.txt\n' });
    expect(msgs[3]).toEqual({ role: 'assistant', content: 'Done.' });
  });

  it('multiple tool_calls in one iteration: each gets a paired role:tool', async () => {
    const events = [
      { type: 'turn_start' },
      { type: 'tool_call', id: 'c1', name: 'bash', input: {} },
      { type: 'tool_call', id: 'c2', name: 'grep', input: {} },
      { type: 'tool_end', id: 'c1', output: 'r1' },
      { type: 'tool_end', id: 'c2', output: 'r2' },
      { type: 'turn_end', stopReason: 'tool_use' },
      { type: 'turn_start' },
      { type: 'text_delta', text: 'ok' },
      { type: 'turn_end', stopReason: 'end_turn' },
    ];
    const inst = new EngineInstance({ threadId: 't1', engine: fakeEngine(events) });
    await drain(inst.query({ prompt: 'go' }));

    const msgs = inst.messages;
    expect(msgs[1].toolCalls.map(t => t.id)).toEqual(['c1', 'c2']);
    // Both tool results must come before the next assistant message.
    expect(msgs[2]).toMatchObject({ role: 'tool', toolCallId: 'c1' });
    expect(msgs[3]).toMatchObject({ role: 'tool', toolCallId: 'c2' });
    expect(msgs[4].role).toBe('assistant');
  });

  it('multi-iteration turn: interleaves assistant/tool across iterations', async () => {
    const events = [
      // iter 1
      { type: 'turn_start' },
      { type: 'text_delta', text: 'step1 ' },
      { type: 'tool_call', id: 'c1', name: 'bash', input: {} },
      { type: 'tool_end', id: 'c1', output: 'out1' },
      { type: 'turn_end', stopReason: 'tool_use' },
      // iter 2
      { type: 'turn_start' },
      { type: 'text_delta', text: 'step2 ' },
      { type: 'tool_call', id: 'c2', name: 'bash', input: {} },
      { type: 'tool_end', id: 'c2', output: 'out2' },
      { type: 'turn_end', stopReason: 'tool_use' },
      // iter 3 (final)
      { type: 'turn_start' },
      { type: 'text_delta', text: 'done' },
      { type: 'turn_end', stopReason: 'end_turn' },
    ];
    const inst = new EngineInstance({ threadId: 't1', engine: fakeEngine(events) });
    await drain(inst.query({ prompt: 'multi' }));

    const msgs = inst.messages;
    // [user, A1(tools:c1), T(c1), A2(tools:c2), T(c2), A3(final)]
    expect(msgs).toHaveLength(6);
    expect(msgs[0].role).toBe('user');
    expect(msgs[1].toolCalls[0].id).toBe('c1');
    expect(msgs[2]).toMatchObject({ role: 'tool', toolCallId: 'c1', content: 'out1' });
    expect(msgs[3].toolCalls[0].id).toBe('c2');
    expect(msgs[4]).toMatchObject({ role: 'tool', toolCallId: 'c2', content: 'out2' });
    expect(msgs[5]).toEqual({ role: 'assistant', content: 'done' });
  });

  it('synthesises placeholder tool result for orphan tool_call (abort)', async () => {
    // tool_call emitted, but tool_end never arrives (engine aborted mid-exec).
    const events = [
      { type: 'turn_start' },
      { type: 'tool_call', id: 'c_orphan', name: 'bash', input: {} },
      { type: 'turn_end', stopReason: 'tool_use' },
    ];
    const inst = new EngineInstance({ threadId: 't1', engine: fakeEngine(events) });
    await drain(inst.query({ prompt: 'abort me' }));

    const msgs = inst.messages;
    // [user, assistant(tools:c_orphan), tool(placeholder)]
    expect(msgs).toHaveLength(3);
    expect(msgs[1].toolCalls[0].id).toBe('c_orphan');
    expect(msgs[2].role).toBe('tool');
    expect(msgs[2].toolCallId).toBe('c_orphan');
    expect(msgs[2].isError).toBe(true);
    expect(msgs[2].content).toMatch(/tool call did not produce a result/);
  });

  it('partial pairing: one result present, one missing → placeholder only for missing', async () => {
    const events = [
      { type: 'turn_start' },
      { type: 'tool_call', id: 'c_ok', name: 'bash', input: {} },
      { type: 'tool_call', id: 'c_miss', name: 'bash', input: {} },
      { type: 'tool_end', id: 'c_ok', output: 'fine' },
      { type: 'turn_end', stopReason: 'tool_use' },
    ];
    const inst = new EngineInstance({ threadId: 't1', engine: fakeEngine(events) });
    await drain(inst.query({ prompt: 'half' }));

    const msgs = inst.messages;
    // [user, assistant(tools), tool(c_ok), tool(placeholder c_miss)]
    expect(msgs).toHaveLength(4);
    expect(msgs[2]).toMatchObject({ role: 'tool', toolCallId: 'c_ok', content: 'fine' });
    expect(msgs[3]).toMatchObject({ role: 'tool', toolCallId: 'c_miss', isError: true });
  });

  it('isError on tool_end is forwarded to the role:tool entry', async () => {
    const events = [
      { type: 'turn_start' },
      { type: 'tool_call', id: 'c1', name: 'bash', input: {} },
      { type: 'tool_end', id: 'c1', output: 'failed', isError: true },
      { type: 'turn_end', stopReason: 'tool_use' },
    ];
    const inst = new EngineInstance({ threadId: 't1', engine: fakeEngine(events) });
    await drain(inst.query({ prompt: 'err' }));

    const msgs = inst.messages;
    expect(msgs[2]).toMatchObject({
      role: 'tool',
      toolCallId: 'c1',
      content: 'failed',
      isError: true,
    });
  });

  it('non-string tool output is coerced to string', async () => {
    const events = [
      { type: 'turn_start' },
      { type: 'tool_call', id: 'c1', name: 'bash', input: {} },
      { type: 'tool_end', id: 'c1', output: { foo: 1 } },
      { type: 'turn_end', stopReason: 'tool_use' },
    ];
    const inst = new EngineInstance({ threadId: 't1', engine: fakeEngine(events) });
    await drain(inst.query({ prompt: 'obj' }));

    const toolMsg = inst.messages[2];
    expect(toolMsg.role).toBe('tool');
    expect(typeof toolMsg.content).toBe('string');
  });

  it('turn 2: snapshot handed to engine contains paired tool history', async () => {
    // Turn 1 produces a tool-use round.
    const turn1 = [
      { type: 'turn_start' },
      { type: 'tool_call', id: 'c1', name: 'bash', input: {} },
      { type: 'tool_end', id: 'c1', output: 'out1' },
      { type: 'turn_end', stopReason: 'tool_use' },
      { type: 'turn_start' },
      { type: 'text_delta', text: 'ok' },
      { type: 'turn_end', stopReason: 'end_turn' },
    ];
    const inst = new EngineInstance({
      threadId: 't1',
      engine: {
        events: null,
        async *query({ messages }) {
          this.lastSnapshot = messages;
          for (const e of this.events) yield e;
        },
      },
    });
    inst.engine.events = turn1;
    await drain(inst.query({ prompt: 'turn1' }));

    // Turn 2: capture snapshot before any events. Engine sees paired history.
    inst.engine.events = [
      { type: 'turn_start' },
      { type: 'text_delta', text: 'bye' },
      { type: 'turn_end', stopReason: 'end_turn' },
    ];
    await drain(inst.query({ prompt: 'turn2' }));

    const snap = inst.engine.lastSnapshot;
    // Must include user turn1, assistant(toolCalls:c1), role:tool c1, assistant(ok).
    // NO orphan tool_calls.
    const asstIdx = snap.findIndex(m => m.role === 'assistant' && Array.isArray(m.toolCalls));
    expect(asstIdx).toBeGreaterThanOrEqual(0);
    const next = snap[asstIdx + 1];
    expect(next).toMatchObject({ role: 'tool', toolCallId: 'c1' });
  });
});
