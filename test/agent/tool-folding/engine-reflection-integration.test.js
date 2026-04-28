/**
 * engine-reflection-integration.test.js — PR-L V7 end-to-end.
 *
 * Drives the Engine with a scripted adapter that emits 13 tool_use stops
 * in a row and asserts:
 *   • T1 reflection fires exactly once.
 *   • The conversationMessages history seen by adapter.stream after
 *     the rewrite contains the reflection placeholder, not the raw
 *     assistant+tool arc.
 *   • The exec-log accumulates 13 entries.
 *   • A `reflection` event with trigger='t1' is yielded.
 */
import { describe, it, expect, vi } from 'vitest';
import { Engine } from '../../../agent/unify/engine.js';
import { NullTrace } from '../../../agent/unify/debug-trace.js';

vi.mock('../../../agent/unify/memory/recall-r6.js', async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    recallR6: vi.fn(async () => ({ entries: [], shards: [], fingerprint: 't', cached: false })),
    formatForInjection: vi.fn(() => ''),
  };
});

/**
 * Scripted adapter:
 *   - First N adapter.stream calls each yield one tool_use stop
 *     with a fresh tool call id.
 *   - The (N+1)-th call yields end_turn with text 'all done'.
 *   - adapter.call (used by the reflector) returns a canonical reflection
 *     markdown immediately.
 */
class ScriptedAdapter {
  constructor({ toolUseTurns = 13 } = {}) {
    this.toolUseTurns = toolUseTurns;
    this.streamCalls = [];
    this.callCalls = [];
    this._counter = 0;
  }
  async *stream(params) {
    this.streamCalls.push({
      // Snapshot the messages array at call time so later mutations
      // don't leak into our assertions.
      messages: JSON.parse(JSON.stringify(params.messages || [])),
    });
    if (this._counter < this.toolUseTurns) {
      this._counter += 1;
      const id = `tc-${this._counter}`;
      yield { type: 'tool_call', id, name: 'echo', input: { i: this._counter } };
      yield { type: 'stop', stopReason: 'tool_use' };
    } else {
      yield { type: 'text_delta', text: 'all done' };
      yield { type: 'stop', stopReason: 'end_turn' };
    }
  }
  async call(params) {
    this.callCalls.push(params);
    return {
      text: '## What was attempted\nbatched\n## Key findings\nnone\n## Direction check\nok\n## Suggested next direction\ncontinue\n## Tool execution log\necho × 13',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

class EchoTool {
  constructor() {
    this.name = 'echo';
    this.description = 'echo';
    this.parameters = { type: 'object', properties: {} };
  }
  async execute(input) {
    return `echo:${JSON.stringify(input)}`;
  }
}

function mkEngine(adapter) {
  const engine = new Engine({
    adapter,
    trace: new NullTrace(),
    config: {
      model: 'test-model',
      maxOutputTokens: 1024,
      _readOnly: true,
      language: 'en',
    },
  });
  engine.registerTool(new EchoTool());
  return engine;
}

describe('PR-L T1 in-turn reflection — integration', () => {
  it('fires exactly once and rewrites history when 13 tool_results accumulate', async () => {
    const adapter = new ScriptedAdapter({ toolUseTurns: 13 });
    const engine = mkEngine(adapter);

    const events = [];
    for await (const e of engine.query({ prompt: 'go', messages: [] })) {
      events.push(e);
    }

    // T1 was reached: exactly one pending+ready pair for trigger='t1'.
    const reflectionPending = events.filter(e => e.type === 'reflection' && e.trigger === 't1' && e.status === 'pending');
    const reflectionReady = events.filter(e => e.type === 'reflection' && e.trigger === 't1' && e.status === 'ready');
    expect(reflectionPending).toHaveLength(1);
    expect(reflectionReady).toHaveLength(1);
    expect(reflectionReady[0].content).toContain('## What was attempted');
    expect(reflectionReady[0].toolCount).toBe(13);

    // adapter.call was invoked exactly once for the reflection.
    expect(adapter.callCalls).toHaveLength(1);

    // Exec-log contains 13 entries total across the turns of this query
    // (one per tool execution; persisted under the iter's turnNumber).
    let totalEntries = 0;
    for (let t = 1; t <= 13; t += 1) totalEntries += engine._execLog.readTurn(t).length;
    expect(totalEntries).toBe(13);

    // The 14th adapter.stream invocation (the one that produced 'end_turn')
    // saw a REWRITTEN history: the user message + ONE assistant reflection
    // message (no tool messages remaining from the collapsed arc).
    const lastStream = adapter.streamCalls[adapter.streamCalls.length - 1];
    const finalMessages = lastStream.messages;
    const userMsgs = finalMessages.filter(m => m.role === 'user');
    const toolMsgs = finalMessages.filter(m => m.role === 'tool');
    const assistantMsgs = finalMessages.filter(m => m.role === 'assistant');
    expect(userMsgs.length).toBe(1);
    expect(toolMsgs.length).toBe(0);
    // After collapse there's one assistant reflection (the original 13
    // assistant turns are gone).
    expect(assistantMsgs.length).toBe(1);
    expect(assistantMsgs[0].content).toContain('## What was attempted');
  });
});

describe('PR-L T1 — adapter.call failure leaves history unchanged', () => {
  it('emits a reflection error event and continues the loop', async () => {
    class FailingAdapter extends ScriptedAdapter {
      async call() { throw new Error('reflector down'); }
    }
    const adapter = new FailingAdapter({ toolUseTurns: 13 });
    const engine = mkEngine(adapter);

    const events = [];
    for await (const e of engine.query({ prompt: 'go', messages: [] })) events.push(e);

    const errEvents = events.filter(e => e.type === 'reflection' && e.status === 'error');
    expect(errEvents).toHaveLength(1);
    // History was NOT rewritten — the final stream call still saw
    // 13 assistant + 13 tool messages.
    const finalMessages = adapter.streamCalls[adapter.streamCalls.length - 1].messages;
    const tools = finalMessages.filter(m => m.role === 'tool');
    expect(tools.length).toBe(13);
  });
});

describe('PR-L T2 end-of-turn — fires when tool count > 5 and < 13', () => {
  it('schedules an async reflection without blocking the turn', async () => {
    const adapter = new ScriptedAdapter({ toolUseTurns: 6 });
    const engine = mkEngine(adapter);

    const events = [];
    for await (const e of engine.query({ prompt: 'go', messages: [] })) events.push(e);

    const t2Pending = events.filter(e => e.type === 'reflection' && e.trigger === 't2' && e.status === 'pending');
    expect(t2Pending).toHaveLength(1);
    expect(t2Pending[0].toolCount).toBe(6);
    // No T1 since count never reached 13.
    expect(events.filter(e => e.type === 'reflection' && e.trigger === 't1')).toHaveLength(0);
  });

  it('does NOT fire when tool count <= 5', async () => {
    const adapter = new ScriptedAdapter({ toolUseTurns: 4 });
    const engine = mkEngine(adapter);

    const events = [];
    for await (const e of engine.query({ prompt: 'go', messages: [] })) events.push(e);

    expect(events.filter(e => e.type === 'reflection')).toHaveLength(0);
  });
});

describe('PR-L duplicate-call reminder', () => {
  it('appends a system reminder after the 3rd identical (toolName,args) call', async () => {
    // Adapter that issues the SAME tool call 3 times, then ends.
    class DupAdapter {
      constructor() { this.streamCalls = []; this._n = 0; }
      async *stream(params) {
        this.streamCalls.push({ messages: JSON.parse(JSON.stringify(params.messages || [])) });
        if (this._n < 3) {
          this._n += 1;
          yield { type: 'tool_call', id: `dup-${this._n}`, name: 'echo', input: { same: 1 } };
          yield { type: 'stop', stopReason: 'tool_use' };
        } else {
          yield { type: 'stop', stopReason: 'end_turn' };
        }
      }
      async call() { return { text: '...', usage: { inputTokens: 0, outputTokens: 0 } }; }
    }
    const adapter = new DupAdapter();
    const engine = mkEngine(adapter);
    for await (const _ of engine.query({ prompt: 'go', messages: [] })) { /* drain */ }

    // Last stream call (the one that produced end_turn) saw the reminder.
    const lastMsgs = adapter.streamCalls[adapter.streamCalls.length - 1].messages;
    const reminderMsg = lastMsgs.find(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[system note]'));
    expect(reminderMsg).toBeTruthy();
    expect(reminderMsg.content).toContain('echo');
  });
});
