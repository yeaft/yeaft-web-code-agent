/**
 * engine-debug-events.test.js — feat-6af5f9f1 PR B.
 *
 * Asserts the new debug protocol shape:
 *   - turn_open at the top of every query() with a fresh turnId (uuid)
 *   - every loop / tool_exec / reflection / memory_used / memory_adjust
 *     event in this query carries the SAME turnId
 *   - turn_close fires once at the end with totals
 *   - the legacy `debug_turn` event no longer appears (renamed to `loop`)
 *   - the legacy `ams_adjust` event no longer appears (renamed to `memory_adjust`)
 */

import { describe, it, expect } from 'vitest';
import { Engine } from '../../agent/unify/engine.js';

class TextOnlyAdapter {
  async *stream() {
    yield { type: 'text_delta', text: 'hello' };
    yield { type: 'usage', inputTokens: 10, outputTokens: 5 };
    yield { type: 'stop', stopReason: 'end_turn' };
  }
  async call() { return { text: 'sum', usage: { inputTokens: 0, outputTokens: 0 } }; }
}

class NoopStore {
  loadAll() { return []; }
  hotTokens() { return 0; }
  countHot() { return 0; }
  moveToColdBatch() {}
  updateCompactSummary() {}
  updateIndex() {}
  append() {}
  readCompactSummary() { return ''; }
}

class NoopTrace {
  startTurn() { return 't'; }
  endTurn() {}
  logTool() { return 't'; }
  logEvent() {}
}

function mkEngine() {
  return new Engine({
    adapter: new TextOnlyAdapter(),
    trace: new NoopTrace(),
    config: {
      model: 'test-model',
      maxOutputTokens: 1024,
      messageTokenBudget: 4000,
      maxContextTokens: 20000,
    },
    conversationStore: new NoopStore(),
  });
}

async function collect(engine, prompt) {
  const out = [];
  for await (const ev of engine.query({ prompt })) out.push(ev);
  return out;
}

describe('turn_open / loop / turn_close lifecycle', () => {
  it('emits exactly one turn_open with a fresh turnId', async () => {
    const events = await collect(mkEngine(), 'hello');
    const opens = events.filter(e => e.type === 'turn_open');
    expect(opens).toHaveLength(1);
    expect(typeof opens[0].turnId).toBe('string');
    expect(opens[0].turnId.length).toBeGreaterThan(8);
  });

  it('every loop event carries the same turnId as turn_open', async () => {
    const events = await collect(mkEngine(), 'hi');
    const opens = events.filter(e => e.type === 'turn_open');
    const loops = events.filter(e => e.type === 'loop');
    expect(loops.length).toBeGreaterThan(0);
    for (const lp of loops) expect(lp.turnId).toBe(opens[0].turnId);
  });

  it('loop event has loopNumber starting at 1 and usage.totalTokens', async () => {
    const events = await collect(mkEngine(), 'hi');
    const loops = events.filter(e => e.type === 'loop');
    expect(loops[0].loopNumber).toBe(1);
    const u = loops[0].usage;
    expect(u.inputTokens).toBe(10);
    expect(u.outputTokens).toBe(5);
    expect(u.totalTokens).toBe(15);
  });

  it('turn_close fires once with loopCount + totals', async () => {
    const events = await collect(mkEngine(), 'hi');
    const closes = events.filter(e => e.type === 'turn_close');
    expect(closes).toHaveLength(1);
    expect(closes[0].loopCount).toBeGreaterThanOrEqual(1);
    expect(typeof closes[0].totalMs).toBe('number');
    expect(typeof closes[0].totalTokens).toBe('number');
    // turnId matches the open event
    const opens = events.filter(e => e.type === 'turn_open');
    expect(closes[0].turnId).toBe(opens[0].turnId);
  });

  it('two back-to-back queries get distinct turnIds', async () => {
    const engine = mkEngine();
    const e1 = [];
    for await (const ev of engine.query({ prompt: 'first' })) e1.push(ev);
    const e2 = [];
    for await (const ev of engine.query({ prompt: 'second' })) e2.push(ev);
    const open1 = e1.find(e => e.type === 'turn_open');
    const open2 = e2.find(e => e.type === 'turn_open');
    expect(open1.turnId).not.toBe(open2.turnId);
  });
});

describe('renamed events', () => {
  it('does not emit legacy `debug_turn`', async () => {
    const events = await collect(mkEngine(), 'hi');
    expect(events.some(e => e.type === 'debug_turn')).toBe(false);
  });

  it('does not emit legacy `ams_adjust`', async () => {
    const events = await collect(mkEngine(), 'hi');
    expect(events.some(e => e.type === 'ams_adjust')).toBe(false);
  });
});

describe('turn_open metadata', () => {
  it('truncates very long user prompts', async () => {
    const longPrompt = 'a'.repeat(500);
    const events = await collect(mkEngine(), longPrompt);
    const open = events.find(e => e.type === 'turn_open');
    expect(open.userPrompt.length).toBeLessThanOrEqual(200);
  });
});
