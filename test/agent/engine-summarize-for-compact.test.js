/**
 * engine-summarize-for-compact.test.js
 *
 * The web bridge's in-memory history compactor calls
 * `session.engine.summarizeForCompact()` to produce a fold summary. This
 * test verifies that method exists, routes to the fast model, and
 * returns trimmed text on success / empty string on failure.
 */
import { describe, it, expect } from 'vitest';
import { Engine } from '../../agent/unify/engine.js';

class FakeAdapter {
  constructor() {
    this.calls = [];
    this.shouldThrow = false;
    this.responseText = '  hello, world  '; // padded to verify trim
  }
  async call(args) {
    this.calls.push(args);
    if (this.shouldThrow) throw new Error('llm down');
    return { text: this.responseText, usage: { inputTokens: 1, outputTokens: 1 } };
  }
  async *stream() { yield { type: 'stop', stopReason: 'end_turn' }; }
}

function makeEngine(adapter) {
  return new Engine({
    adapter,
    config: {
      model: 'primary-model',
      fastModelId: 'fast-model',
      maxContextTokens: 200000,
      messageTokenBudget: 8192,
      _readOnly: true,
    },
    yeaftDir: null,
  });
}

describe('engine.summarizeForCompact', () => {
  it('uses the fast model and returns trimmed text', async () => {
    const adapter = new FakeAdapter();
    const engine = makeEngine(adapter);
    const out = await engine.summarizeForCompact({
      system: 'You are a summarizer.',
      prompt: 'Summarize: foo bar',
    });
    expect(out).toBe('hello, world');
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0].model).toBe('fast-model');
    expect(adapter.calls[0].system).toBe('You are a summarizer.');
    expect(adapter.calls[0].messages).toEqual([
      { role: 'user', content: 'Summarize: foo bar' },
    ]);
    expect(adapter.calls[0].maxTokens).toBe(1024);
  });

  it('returns empty string on adapter failure (does not throw)', async () => {
    const adapter = new FakeAdapter();
    adapter.shouldThrow = true;
    const engine = makeEngine(adapter);
    const out = await engine.summarizeForCompact({
      system: 'sys',
      prompt: 'pmt',
    });
    expect(out).toBe('');
  });

  it('returns empty string on missing system or prompt', async () => {
    const adapter = new FakeAdapter();
    const engine = makeEngine(adapter);
    expect(await engine.summarizeForCompact({})).toBe('');
    expect(await engine.summarizeForCompact({ system: 'x' })).toBe('');
    expect(await engine.summarizeForCompact({ prompt: 'x' })).toBe('');
    expect(adapter.calls).toHaveLength(0);
  });

  it('honours custom maxTokens', async () => {
    const adapter = new FakeAdapter();
    const engine = makeEngine(adapter);
    await engine.summarizeForCompact({ system: 's', prompt: 'p', maxTokens: 256 });
    expect(adapter.calls[0].maxTokens).toBe(256);
  });
});
