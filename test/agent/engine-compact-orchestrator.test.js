/**
 * engine-compact-orchestrator.test.js — orchestrator-only path.
 *
 * The legacy consolidate path was retired in the H2-AMS rip; only the
 * compact/orchestrator runCompact path remains. This test asserts the
 * engine routes through it on the default config.
 */

import { describe, it, expect, vi } from 'vitest';
import { Engine } from '../../agent/unify/engine.js';

vi.mock('../../agent/unify/compact/orchestrator.js', async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    runCompact: vi.fn(async () => ({
      archivedGroups: 1, archivedMessages: 4, compactSummary: 'orch',
      extractedCount: 2, taskSummaryRefreshed: false, nextMessages: [],
    })),
  };
});

const { runCompact: runCompactOrchestrator } =
  await import('../../agent/unify/compact/orchestrator.js');

class CapturingAdapter {
  async *stream() {
    yield { type: 'text_delta', text: 'ok' };
    yield { type: 'stop', stopReason: 'end_turn' };
  }
  async call() { return { text: 'sum', usage: { inputTokens: 0, outputTokens: 0 } }; }
}

class FakeStore {
  constructor() {
    this._messages = Array.from({ length: 20 }, (_, i) => ({
      id: `m_${i}`, role: i % 2 ? 'assistant' : 'user', content: 'x', tokens_est: 1000,
    }));
    this.movedToCold = [];
    this.compactSummaries = [];
    this.indexUpdates = [];
  }
  loadAll() { return this._messages; }
  hotTokens() { return 20000; }
  countHot() { return this._messages.length; }
  moveToColdBatch(ids) { this.movedToCold.push(...ids); }
  updateCompactSummary(s) { this.compactSummaries.push(s); }
  updateIndex(info) { this.indexUpdates.push(info); }
  append() {}
  readCompactSummary() { return ''; }
}

class CapturingTrace {
  constructor() { this.events = []; }
  startTurn() { return 't'; }
  endTurn() {}
  logTool() { return 't'; }
  logEvent(e) { this.events.push(e); }
}

function mkEngine() {
  const adapter = new CapturingAdapter();
  const trace = new CapturingTrace();
  const conversationStore = new FakeStore();
  const engine = new Engine({
    adapter,
    trace,
    config: {
      model: 'test-model',
      maxOutputTokens: 1024,
      messageTokenBudget: 4000,
      maxContextTokens: 20000,
    },
    conversationStore,
  });
  return { engine, adapter, trace, conversationStore };
}

describe('default config routes through runCompact', () => {
  it('runCompact invoked', async () => {
    runCompactOrchestrator.mockClear();
    const { engine } = mkEngine();

    const out = [];
    for await (const ev of engine.query({ prompt: 'hi', messages: [] })) out.push(ev);

    expect(runCompactOrchestrator).toHaveBeenCalled();
  });
});
