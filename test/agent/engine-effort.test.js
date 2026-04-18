/**
 * task-327b: engine wiring — verify query() threads the resolved
 * effort through to adapter.stream(params.effort), honours the
 * `/max` prefix, and bumps on long tool loops.
 *
 * Red lines:
 *   - Tests MUST NOT require the feature flag; the engine always
 *     computes effort, the adapter/router drops it when the flag is
 *     off. So we assert on `callLog[].effort` directly.
 *   - No filesystem, no memory store — pure in-memory mock adapter,
 *     same pattern as engine.test.js.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Engine } from '../../agent/unify/engine.js';
import { NullTrace } from '../../agent/unify/debug-trace.js';
import { LONG_LOOP_TURN_THRESHOLD } from '../../agent/unify/effort.js';

class MockAdapter {
  constructor() {
    this.responses = [];
    this.callLog = [];
  }
  pushResponse(events) { this.responses.push(events); }
  async *stream(params) {
    this.callLog.push(params);
    const events = this.responses.shift();
    if (!events) throw new Error('no more responses');
    for (const ev of events) yield ev;
  }
  async call() { return { text: '', usage: { inputTokens: 0, outputTokens: 0 } }; }
}

// Minimal end-turn response.
function endTurn(text = 'ok') {
  return [
    { type: 'text_delta', text },
    { type: 'stop', stopReason: 'end_turn' },
  ];
}

// Tool-use turn that calls a single 'nop' tool.
function toolUseTurn() {
  return [
    { type: 'tool_call', id: 'tc_' + Math.random().toString(36).slice(2, 8), name: 'nop', input: {} },
    { type: 'stop', stopReason: 'tool_use' },
  ];
}

function mkEngine(adapter, { tools } = {}) {
  return new Engine({
    adapter,
    trace: new NullTrace(),
    config: { model: 'test-model', maxOutputTokens: 1024, _readOnly: true },
    tools, // may be undefined — engine falls back to #getToolDefs on internal registry
  });
}

async function drainQuery(engine, params) {
  const out = [];
  for await (const ev of engine.query(params)) out.push(ev);
  return out;
}

describe('task-327b: engine → adapter.stream effort threading', () => {
  let adapter;
  beforeEach(() => { adapter = new MockAdapter(); });

  it('default scenario (chat) passes effort=high to adapter', async () => {
    adapter.pushResponse(endTurn());
    const engine = mkEngine(adapter);
    await drainQuery(engine, { prompt: 'hello' });
    expect(adapter.callLog).toHaveLength(1);
    expect(adapter.callLog[0].effort).toBe('high');
  });

  it('scenario=consolidate → effort=max', async () => {
    adapter.pushResponse(endTurn());
    const engine = mkEngine(adapter);
    await drainQuery(engine, { prompt: 'summarize', scenario: 'consolidate' });
    expect(adapter.callLog[0].effort).toBe('max');
  });

  it('scenario=recall → effort=low', async () => {
    adapter.pushResponse(endTurn());
    const engine = mkEngine(adapter);
    await drainQuery(engine, { prompt: 'pick memories', scenario: 'recall' });
    expect(adapter.callLog[0].effort).toBe('low');
  });

  it('userEffort=low overrides the chat default of high', async () => {
    adapter.pushResponse(endTurn());
    const engine = mkEngine(adapter);
    await drainQuery(engine, { prompt: 'hi', userEffort: 'low' });
    expect(adapter.callLog[0].effort).toBe('low');
  });

  it('/max prefix strips from prompt AND sets effort=max', async () => {
    adapter.pushResponse(endTurn());
    const engine = mkEngine(adapter);
    await drainQuery(engine, { prompt: '/max refactor the world' });
    expect(adapter.callLog[0].effort).toBe('max');
    // The prompt actually sent to the LLM must not have the prefix.
    const lastMsg = adapter.callLog[0].messages.at(-1);
    expect(lastMsg.role).toBe('user');
    expect(lastMsg.content).toBe('refactor the world');
  });

  it('explicit userEffort wins over /max prefix', async () => {
    adapter.pushResponse(endTurn());
    const engine = mkEngine(adapter);
    await drainQuery(engine, { prompt: '/max go', userEffort: 'low' });
    expect(adapter.callLog[0].effort).toBe('low');
  });

  it('long tool-use loop auto-bumps effort on turn N+1 after threshold', async () => {
    // Queue: (THRESHOLD + 1) tool-use turns, then one end_turn.
    //
    // Engine behaviour: tool_call events with no registered tool produce
    // a tool-error result but still count as stopReason='tool_use'. We
    // don't care about tool output — just that stopReason='tool_use'
    // bumps toolLoopTurns and the next stream() call gets effort=max.
    for (let i = 0; i < LONG_LOOP_TURN_THRESHOLD + 1; i++) {
      adapter.pushResponse(toolUseTurn());
    }
    adapter.pushResponse(endTurn());
    const engine = mkEngine(adapter);

    const events = await drainQuery(engine, { prompt: 'loop forever' });
    // Sanity: we should have at least THRESHOLD+2 stream calls.
    expect(adapter.callLog.length).toBeGreaterThanOrEqual(LONG_LOOP_TURN_THRESHOLD + 1);

    // Pre-threshold turns get 'high' (chat default, not yet bumped).
    expect(adapter.callLog[0].effort).toBe('high');
    expect(adapter.callLog[LONG_LOOP_TURN_THRESHOLD - 1].effort).toBe('high');

    // At turn with index === LONG_LOOP_TURN_THRESHOLD, toolLoopTurns
    // counter has crossed and the resolved effort is 'max'.
    const bumped = adapter.callLog[LONG_LOOP_TURN_THRESHOLD];
    expect(bumped.effort).toBe('max');

    // The engine terminated (there was at least one turn_end event).
    expect(events.some(e => e.type === 'turn_end')).toBe(true);
  });

  it('cheap scenario (recall) does NOT bump on long loops', async () => {
    for (let i = 0; i < LONG_LOOP_TURN_THRESHOLD + 2; i++) {
      adapter.pushResponse(toolUseTurn());
    }
    adapter.pushResponse(endTurn());
    const engine = mkEngine(adapter);
    await drainQuery(engine, { prompt: 'loop', scenario: 'recall' });
    // Every single call should still be low.
    for (const call of adapter.callLog) {
      expect(call.effort).toBe('low');
    }
  });
});
