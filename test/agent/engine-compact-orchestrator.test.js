/**
 * engine-compact-orchestrator.test.js — Phase 8 PR-D wire-up.
 *
 * Asserts:
 *   D-a  config.compact.useOrchestrator=true routes #maybeConsolidate
 *        through compact/orchestrator (runCompact), not the legacy
 *        consolidate path.
 *   D-b  default config keeps the legacy consolidate path live.
 *   D-c  evaluateCompactTriggers is invoked on the default path
 *        (observability) — the trace receives a compact_triggers_eval
 *        event regardless of which path runs.
 */

import { describe, it, expect, vi } from 'vitest';
import { Engine } from '../../agent/unify/engine.js';

vi.mock('../../agent/unify/memory/recall-r6.js', async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    recallR6: vi.fn(async () => ({ entries: [], shards: [], fingerprint: 't', cached: false })),
    formatForInjection: vi.fn(() => ''),
  };
});

vi.mock('../../agent/unify/memory/consolidate.js', async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    consolidate: vi.fn(async () => ({
      compactSummary: 'legacy', extractedEntries: ['e1'], archivedCount: 3,
    })),
    shouldConsolidate: vi.fn(() => true),
    partitionMessages: vi.fn((msgs) => ({
      toArchive: msgs.slice(0, Math.max(0, msgs.length - 3)),
      toKeep: msgs.slice(-3),
    })),
  };
});

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

const { consolidate } = await import('../../agent/unify/memory/consolidate.js');
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

class FakeMemoryStore {
  constructor() { this.entries = []; }
  writeEntry(e) { this.entries.push(e); return 'slug'; }
  rebuildScopes() {}
}

class CapturingTrace {
  constructor() { this.events = []; }
  startTurn() { return 't'; }
  endTurn() {}
  logTool() { return 't'; }
  logEvent(e) { this.events.push(e); }
}

function mkEngine({ legacy } = {}) {
  const adapter = new CapturingAdapter();
  const trace = new CapturingTrace();
  const conversationStore = new FakeStore();
  const memoryStore = new FakeMemoryStore();
  const engine = new Engine({
    adapter,
    trace,
    config: {
      model: 'test-model',
      maxOutputTokens: 1024,
      messageTokenBudget: 4000,
      maxContextTokens: 20000,
      compact: legacy ? { useLegacy: true } : undefined,
    },
    conversationStore,
    memoryStore,
  });
  return { engine, adapter, trace, conversationStore, memoryStore };
}

describe('D-a default config routes through runCompact (PR-H flip)', () => {
  it('runCompact invoked, legacy consolidate not invoked', async () => {
    consolidate.mockClear();
    runCompactOrchestrator.mockClear();
    const { engine } = mkEngine();

    const out = [];
    for await (const ev of engine.query({ prompt: 'hi', messages: [] })) out.push(ev);

    expect(runCompactOrchestrator).toHaveBeenCalled();
    expect(consolidate).not.toHaveBeenCalled();
  });
});

describe('D-b useLegacy=true keeps legacy consolidate', () => {
  it('legacy consolidate invoked, orchestrator not invoked', async () => {
    consolidate.mockClear();
    runCompactOrchestrator.mockClear();
    const { engine } = mkEngine({ legacy: true });

    const out = [];
    for await (const ev of engine.query({ prompt: 'hi', messages: [] })) out.push(ev);

    expect(consolidate).toHaveBeenCalled();
    expect(runCompactOrchestrator).not.toHaveBeenCalled();
  });
});

describe('D-c evaluateCompactTriggers logs to trace', () => {
  it('logEvent receives compact_triggers_eval on legacy path', async () => {
    const { engine, trace } = mkEngine({ legacy: true });
    for await (const _ of engine.query({ prompt: 'hi', messages: [] })) { /* drain */ }
    const found = trace.events.find(e => e.eventType === 'compact_triggers_eval');
    expect(found).toBeTruthy();
    expect(found.eventData).toHaveProperty('trigger');
    expect(found.eventData).toHaveProperty('reasons');
  });
});
