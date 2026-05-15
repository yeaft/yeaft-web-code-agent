/**
 * engine-reflection-periodic.test.js — T1 must fire every TOOL_BATCH_SIZE tool calls.
 *
 * Regression test for the bug where T1 reflection fired at most ONCE per
 * query() lifetime (the original `t1Fired` boolean was set true and never
 * reset). The fix replaces it with a `lastT1AtToolCount` cursor so the
 * second batch (toolCount 2×BATCH), the third (3×BATCH), etc. all fire too.
 *
 * The contract being tested:
 *   - 2×BATCH tool_use stops in a single query() ⇒ T1 fires TWICE.
 *   - 3×BATCH tool_use stops ⇒ T1 fires THREE times.
 *   - The boundary is "every BATCH since last T1", NOT "every BATCH since
 *     turnStartIdx" — once the arc is collapsed by the first T1, the
 *     second batch is measured from the new arc start, not from 0.
 *
 * BATCH was 13 in the original V7 spec; raised to 30 on 2026-05-15 after
 * user feedback that 13 fragmented a single task arc into too many
 * reflections. The test imports TOOL_BATCH_SIZE rather than hard-coding the
 * number so the contract follows the constant.
 */
import { describe, it, expect } from 'vitest';
import { Engine } from '../../../agent/unify/engine.js';
import { NullTrace } from '../../../agent/unify/debug-trace.js';
import { TOOL_BATCH_SIZE } from '../../../agent/unify/tool-folding/index.js';

class ScriptedAdapter {
  constructor({ toolUseTurns = TOOL_BATCH_SIZE * 2 } = {}) {
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
  it('TOOL_BATCH_SIZE is pinned to 30 (guard against accidental flip)', () => {
    // The behaviour tests in this file follow the constant, so they would
    // still pass if someone silently changed it. This one assertion exists
    // purely to catch an accidental change to the numeric value — bump it
    // intentionally if 30 is being revised, and write down why in the
    // TOOL_BATCH_SIZE doc comment.
    expect(TOOL_BATCH_SIZE).toBe(30);
  });

  it('fires TWICE when 2×BATCH tool_use stops accumulate in a single query', async () => {
    const adapter = new ScriptedAdapter({ toolUseTurns: TOOL_BATCH_SIZE * 2 });
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

    // Each batch covers TOOL_BATCH_SIZE tool calls.
    expect(t1Ready[0].toolCount).toBe(TOOL_BATCH_SIZE);
    expect(t1Ready[1].toolCount).toBe(TOOL_BATCH_SIZE);
  });

  it('fires THREE times when 3×BATCH tool_use stops accumulate', async () => {
    const adapter = new ScriptedAdapter({ toolUseTurns: TOOL_BATCH_SIZE * 3 });
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
    for (const e of t1Ready) expect(e.toolCount).toBe(TOOL_BATCH_SIZE);
  });

  it('still fires exactly once when exactly BATCH tool_use stops accumulate (back-compat with original test)', async () => {
    const adapter = new ScriptedAdapter({ toolUseTurns: TOOL_BATCH_SIZE });
    const engine = mkEngine(adapter);

    const events = [];
    for await (const e of engine.query({ prompt: 'go', messages: [] })) {
      events.push(e);
    }

    const t1Ready = events.filter(
      e => e.type === 'reflection' && e.trigger === 't1' && e.status === 'ready',
    );
    expect(t1Ready).toHaveLength(1);
    expect(t1Ready[0].toolCount).toBe(TOOL_BATCH_SIZE);
  });

  it('does NOT fire when fewer than BATCH tool_use stops accumulate', async () => {
    const adapter = new ScriptedAdapter({ toolUseTurns: TOOL_BATCH_SIZE - 1 });
    const engine = mkEngine(adapter);

    const events = [];
    for await (const e of engine.query({ prompt: 'go', messages: [] })) {
      events.push(e);
    }

    const t1Events = events.filter(e => e.type === 'reflection' && e.trigger === 't1');
    expect(t1Events).toHaveLength(0);
  });

  it('after second T1 firing, history shows the first reflection collapsed plus the second batch arc', async () => {
    // 2×BATCH tool calls. After first T1 fires at toolCount=BATCH, the arc
    // 1..BATCH is collapsed into one synthetic user reflection. After the
    // second T1 fires at toolCount=2×BATCH, the arc that came AFTER the
    // first reflection (BATCH more assistant+tool pairs) is also collapsed.
    // The final adapter.stream call (which produced end_turn) should see:
    //   - the original user prompt
    //   - reflection #1 (synthetic user)
    //   - reflection #2 (synthetic user)
    //   - NO assistant or tool messages from either batch.
    const adapter = new ScriptedAdapter({ toolUseTurns: TOOL_BATCH_SIZE * 2 });
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

  it('on T1 reflector error, does not retry on the very next tool — waits for the next BATCH', async () => {
    // Regression for the cursor-bump-on-error behaviour. When the reflector
    // throws, we MUST still bump lastT1AtToolCount so we don't re-fire on
    // every subsequent tool_use stop (which would hammer a broken reflector
    // BATCH times in a row).
    //
    // Expected behaviour:
    //   - toolCount=BATCH: first call, throws → cursor bumped to BATCH, but
    //     arcStartIdx is NOT bumped (history wasn't rewritten).
    //   - toolCount=BATCH+1..2×BATCH-1: no calls (delta < BATCH since cursor).
    //   - toolCount=2×BATCH: second call, succeeds. Because arcStartIdx never
    //     advanced, this batch's pairs.length covers ALL 2×BATCH tools (the
    //     errored batch's tools are still in history and get folded into
    //     the next reflection — see engine.js catch-block comment).
    // Total adapter.call invocations = 2.
    const adapter = new ScriptedAdapter({ toolUseTurns: TOOL_BATCH_SIZE * 2 });
    let calls = 0;
    adapter.call = async () => {
      calls += 1;
      if (calls === 1) throw new Error('reflector boom');
      return {
        text: '## What was attempted\nbatched\n## Key findings\nnone\n## Direction check\nok\n## Suggested next direction\ncontinue\n## Tool execution log\necho × many',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    };
    const engine = mkEngine(adapter);

    const events = [];
    for await (const e of engine.query({ prompt: 'go', messages: [] })) {
      events.push(e);
    }

    // Two reflector invocations total: one error at toolCount=BATCH, one
    // success at toolCount=2×BATCH. NOT (BATCH+1) (one per tool if the
    // cursor wasn't bumped) and NOT 1 (if the error suppressed retry).
    expect(calls).toBe(2);

    const errEvents = events.filter(e => e.type === 'reflection' && e.status === 'error');
    const pendingEvents = events.filter(e => e.type === 'reflection' && e.trigger === 't1' && e.status === 'pending');
    const readyEvents = events.filter(e => e.type === 'reflection' && e.trigger === 't1' && e.status === 'ready');

    // First attempt: pending → error. Second attempt: pending → ready.
    expect(pendingEvents).toHaveLength(2);
    expect(errEvents).toHaveLength(1);
    expect(readyEvents).toHaveLength(1);
    // First pending was for the BATCH-tool batch. Second pending+ready
    // covers all 2×BATCH because arcStartIdx wasn't advanced after the error.
    expect(pendingEvents[0].toolCount).toBe(TOOL_BATCH_SIZE);
    expect(pendingEvents[1].toolCount).toBe(TOOL_BATCH_SIZE * 2);
    expect(readyEvents[0].toolCount).toBe(TOOL_BATCH_SIZE * 2);
  });
});
