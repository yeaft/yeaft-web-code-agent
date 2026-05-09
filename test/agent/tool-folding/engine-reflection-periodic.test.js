/**
 * engine-reflection-periodic.test.js — T1 must fire every 13 tool calls.
 *
 * Regression test for the bug where T1 reflection fired at most ONCE per
 * query() lifetime (the original `t1Fired` boolean was set true and never
 * reset). The fix replaces it with a `lastT1AtToolCount` cursor so the
 * second batch of 13 (toolCount 26), the third (39), etc. all fire too.
 *
 * The contract being tested:
 *   - 26 tool_use stops in a single query() ⇒ T1 fires TWICE (at 13, 26).
 *   - 39 tool_use stops ⇒ T1 fires THREE times.
 *   - The boundary is "every 13 since last T1", NOT "every 13 since
 *     turnStartIdx" — once the arc is collapsed by the first T1, the
 *     second batch is measured from the new arc start, not from 0.
 */
import { describe, it, expect } from 'vitest';
import { Engine } from '../../../agent/unify/engine.js';
import { NullTrace } from '../../../agent/unify/debug-trace.js';

class ScriptedAdapter {
  constructor({ toolUseTurns = 26 } = {}) {
    this.toolUseTurns = toolUseTurns;
    this.streamCalls = [];
    this.callCalls = [];
    this._counter = 0;
  }
  async *stream(params) {
    this.streamCalls.push({
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
      text: '## What was attempted\nbatched\n## Key findings\nnone\n## Direction check\nok\n## Suggested next direction\ncontinue\n## Tool execution log\necho × N',
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

describe('T1 in-turn reflection — periodic firing', () => {
  it('fires TWICE when 26 tool_use stops accumulate in a single query', async () => {
    const adapter = new ScriptedAdapter({ toolUseTurns: 26 });
    const engine = mkEngine(adapter);

    const events = [];
    for await (const e of engine.query({ prompt: 'go', messages: [] })) {
      events.push(e);
    }

    const t1Pending = events.filter(
      e => e.type === 'reflection' && e.trigger === 't1' && e.status === 'pending',
    );
    const t1Ready = events.filter(
      e => e.type === 'reflection' && e.trigger === 't1' && e.status === 'ready',
    );
    expect(t1Pending).toHaveLength(2);
    expect(t1Ready).toHaveLength(2);

    // adapter.call (the reflector LLM) was invoked once per T1 firing.
    expect(adapter.callCalls).toHaveLength(2);

    // Each batch covers 13 tool calls.
    expect(t1Ready[0].toolCount).toBe(13);
    expect(t1Ready[1].toolCount).toBe(13);
  });

  it('fires THREE times when 39 tool_use stops accumulate', async () => {
    const adapter = new ScriptedAdapter({ toolUseTurns: 39 });
    const engine = mkEngine(adapter);

    const events = [];
    for await (const e of engine.query({ prompt: 'go', messages: [] })) {
      events.push(e);
    }

    const t1Ready = events.filter(
      e => e.type === 'reflection' && e.trigger === 't1' && e.status === 'ready',
    );
    expect(t1Ready).toHaveLength(3);
    expect(adapter.callCalls).toHaveLength(3);
    for (const e of t1Ready) expect(e.toolCount).toBe(13);
  });

  it('still fires exactly once when 13 tool_use stops accumulate (back-compat with original test)', async () => {
    const adapter = new ScriptedAdapter({ toolUseTurns: 13 });
    const engine = mkEngine(adapter);

    const events = [];
    for await (const e of engine.query({ prompt: 'go', messages: [] })) {
      events.push(e);
    }

    const t1Ready = events.filter(
      e => e.type === 'reflection' && e.trigger === 't1' && e.status === 'ready',
    );
    expect(t1Ready).toHaveLength(1);
    expect(t1Ready[0].toolCount).toBe(13);
  });

  it('does NOT fire when fewer than 13 tool_use stops accumulate', async () => {
    const adapter = new ScriptedAdapter({ toolUseTurns: 12 });
    const engine = mkEngine(adapter);

    const events = [];
    for await (const e of engine.query({ prompt: 'go', messages: [] })) {
      events.push(e);
    }

    const t1Events = events.filter(e => e.type === 'reflection' && e.trigger === 't1');
    expect(t1Events).toHaveLength(0);
  });

  it('after second T1 firing, history shows the first reflection collapsed plus the second batch arc', async () => {
    // 26 tool calls. After first T1 fires at toolCount=13, the arc 1..13
    // is collapsed into one synthetic user reflection. After the second
    // T1 fires at toolCount=26, the arc that came AFTER the first
    // reflection (13 more assistant+tool pairs) is also collapsed. The
    // final adapter.stream call (which produced end_turn) should see:
    //   - the original user prompt
    //   - reflection #1 (synthetic user)
    //   - reflection #2 (synthetic user)
    //   - NO assistant or tool messages from either batch.
    const adapter = new ScriptedAdapter({ toolUseTurns: 26 });
    const engine = mkEngine(adapter);

    for await (const _ of engine.query({ prompt: 'go', messages: [] })) {
      /* drain */
    }

    const lastStream = adapter.streamCalls[adapter.streamCalls.length - 1];
    const finalMessages = lastStream.messages;
    const userMsgs = finalMessages.filter(m => m.role === 'user');
    const toolMsgs = finalMessages.filter(m => m.role === 'tool');
    const assistantMsgs = finalMessages.filter(m => m.role === 'assistant');
    const reflectionMsgs = finalMessages.filter(
      m => m.role === 'user' && m._reflection === true,
    );

    // Original user + 2 reflections = 3 user messages.
    expect(userMsgs).toHaveLength(3);
    expect(reflectionMsgs).toHaveLength(2);
    // Both batches' tool/assistant pairs are gone.
    expect(toolMsgs).toHaveLength(0);
    expect(assistantMsgs).toHaveLength(0);
  });

  it('on T1 reflector error, does not retry on the very next tool — waits for the next 13-batch', async () => {
    // Regression for the cursor-bump-on-error behaviour. When the reflector
    // throws, we MUST still bump lastT1AtToolCount so we don't re-fire on
    // every subsequent tool_use stop (which would hammer a broken reflector
    // 13 times in a row).
    //
    // Expected behaviour:
    //   - toolCount=13: first call, throws → cursor bumped to 13, but
    //     arcStartIdx is NOT bumped (history wasn't rewritten).
    //   - toolCount=14..25: no calls (delta < 13 since cursor).
    //   - toolCount=26: second call, succeeds. Because arcStartIdx never
    //     advanced, this batch's pairs.length covers ALL 26 tools (the
    //     errored batch's tools are still in history and get folded into
    //     the next reflection — see engine.js catch-block comment).
    // Total adapter.call invocations = 2.
    const adapter = new ScriptedAdapter({ toolUseTurns: 26 });
    let calls = 0;
    adapter.call = async () => {
      calls += 1;
      if (calls === 1) throw new Error('reflector boom');
      return {
        text: '## What was attempted\nbatched\n## Key findings\nnone\n## Direction check\nok\n## Suggested next direction\ncontinue\n## Tool execution log\necho × 26',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    };
    const engine = mkEngine(adapter);

    const events = [];
    for await (const e of engine.query({ prompt: 'go', messages: [] })) {
      events.push(e);
    }

    // Two reflector invocations total: one error at toolCount=13, one
    // success at toolCount=26. NOT 14 (one per tool from 13..26 if the
    // cursor wasn't bumped) and NOT 1 (if the error suppressed retry).
    expect(calls).toBe(2);

    const errEvents = events.filter(e => e.type === 'reflection' && e.status === 'error');
    const pendingEvents = events.filter(e => e.type === 'reflection' && e.trigger === 't1' && e.status === 'pending');
    const readyEvents = events.filter(e => e.type === 'reflection' && e.trigger === 't1' && e.status === 'ready');

    // First attempt: pending → error. Second attempt: pending → ready.
    expect(pendingEvents).toHaveLength(2);
    expect(errEvents).toHaveLength(1);
    expect(readyEvents).toHaveLength(1);
    // First pending was for the 13-tool batch. Second pending+ready
    // covers all 26 because arcStartIdx wasn't advanced after the error.
    expect(pendingEvents[0].toolCount).toBe(13);
    expect(pendingEvents[1].toolCount).toBe(26);
    expect(readyEvents[0].toolCount).toBe(26);
  });
});
