/**
 * engine-recall-r6.test.js — Verify engine.js uses recallR6 from recall-r6.js
 * instead of the legacy recall() from recall.js.
 *
 * Tests:
 *   R-a  recallR6 is called during query when memoryShardStore is wired
 *   R-b  recall event reports correct entryCount from R6 results
 *   R-c  engine still works when memoryShardStore is null (graceful fallback)
 */

import { describe, it, expect, vi } from 'vitest';
import { Engine } from '../../agent/unify/engine.js';
import { NullTrace } from '../../agent/unify/debug-trace.js';

// Mock recallR6 at module level
vi.mock('../../agent/unify/memory/recall-r6.js', async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    recallR6: vi.fn(async () => ({
      entries: [
        { id: 'mA', shard: 'skill', body: 'typescript helper' },
        { id: 'mB', shard: 'lessons', body: 'avoid any casts' },
      ],
      shards: ['skill', 'lessons'],
      fingerprint: 'test-fp',
      cached: false,
    })),
    formatForInjection: vi.fn((entries) =>
      entries.map(e => `[mem:${e.shard}] ${e.body}`).join('\n')
    ),
  };
});

// Re-import to get the mocked versions
const { recallR6, formatForInjection } = await import('../../agent/unify/memory/recall-r6.js');

class MockAdapter {
  constructor() { this.callLog = []; }
  async *stream(params) {
    this.callLog.push(params);
    yield { type: 'text_delta', text: 'ok' };
    yield { type: 'stop', stopReason: 'end_turn' };
  }
  async call() { return { text: '', usage: { inputTokens: 0, outputTokens: 0 } }; }
}

function mkEngine(adapter, opts = {}) {
  return new Engine({
    adapter,
    trace: new NullTrace(),
    config: { model: 'test-model', maxOutputTokens: 1024, _readOnly: true },
    memoryShardStore: opts.memoryShardStore,
  });
}

async function drainQuery(engine, prompt) {
  const out = [];
  for await (const ev of engine.query({ prompt, messages: [] })) out.push(ev);
  return out;
}

describe('R-a recallR6 is called during query', () => {
  it('calls recallR6 when memoryShardStore is provided', async () => {
    const adapter = new MockAdapter();
    const fakeStore = { stats: () => ({ shards: { skill: { entries: 2, bytes: 100 } }, count: 2 }) };
    const engine = mkEngine(adapter, { memoryShardStore: fakeStore });

    recallR6.mockClear();
    formatForInjection.mockClear();

    await drainQuery(engine, 'how do I debug typescript');

    expect(recallR6).toHaveBeenCalledTimes(1);
    expect(recallR6).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'how do I debug typescript',
      memoryShardStore: fakeStore,
    }));
    expect(formatForInjection).toHaveBeenCalledTimes(1);
  });
});

describe('R-b recall event reports entryCount from R6', () => {
  it('yields recall event with entryCount matching R6 result', async () => {
    const adapter = new MockAdapter();
    const fakeStore = { stats: () => ({ shards: {}, count: 0 }) };
    const engine = mkEngine(adapter, { memoryShardStore: fakeStore });

    recallR6.mockClear();

    const events = await drainQuery(engine, 'test query');
    const recallEvents = events.filter(e => e.type === 'recall');

    expect(recallEvents.length).toBe(1);
    expect(recallEvents[0].entryCount).toBe(2); // from mock returning 2 entries
  });
});

describe('R-c graceful fallback without memoryShardStore', () => {
  it('does not call recallR6 when memoryShardStore is null', async () => {
    const adapter = new MockAdapter();
    const engine = mkEngine(adapter, { memoryShardStore: null });

    recallR6.mockClear();

    const events = await drainQuery(engine, 'test query');

    expect(recallR6).not.toHaveBeenCalled();
    // Should still complete without error
    const textEvents = events.filter(e => e.type === 'text_delta');
    expect(textEvents.length).toBeGreaterThan(0);
  });
});
