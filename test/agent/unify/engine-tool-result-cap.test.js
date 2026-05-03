/**
 * engine-tool-result-cap.test.js — task-704b.
 *
 * Two layered defenses against runaway tool results:
 *
 *   1. **Per-tool-result hard cap** at the ToolRegistry.execute boundary.
 *      A single tool can never return more than `max(8KB, contextWindow*10%)`
 *      characters into the wire messages.
 *
 *   2. **Pre-flight total-token guard** before adapter.stream().
 *      If approxTokens(system+messages) > contextWindow*85%, run an
 *      emergency archiveToolResults({turnAgeMin:0}) sweep.
 *
 * Together: a runaway grep gets capped to one window-fraction (defense
 * 1), and N capped results that still total too much trigger an emergency
 * sweep (defense 2). Compaction (#maybeConsolidate) remains the third
 * tier for "even after sweep, still too big" via LLMContextError.
 */

import { describe, it, expect, vi } from 'vitest';
import { Engine } from '../../../agent/unify/engine.js';
import { NullTrace } from '../../../agent/unify/debug-trace.js';
import { ToolRegistry } from '../../../agent/unify/tools/registry.js';
import { defineTool } from '../../../agent/unify/tools/types.js';

vi.mock('../../../agent/unify/archive/tool-results.js', async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    archiveToolResults: vi.fn(async ({ messages }) => ({
      nextMessages: messages,
      archivedCount: 0,
      archivedBytes: 0,
    })),
  };
});

const { archiveToolResults } = await import('../../../agent/unify/archive/tool-results.js');

/**
 * Adapter stub: the FIRST stream() call emits one tool_call (so the engine
 * runs the tool and feeds the result back), the SECOND call emits text
 * + end_turn so the loop terminates. Captures every params object.
 */
class ToolThenStopAdapter {
  constructor() {
    this.calls = [];
    this.iter = 0;
  }
  async *stream(params) {
    this.calls.push(params);
    this.iter += 1;
    if (this.iter === 1) {
      yield { type: 'tool_call', id: 'tc-1', name: 'big_grep', input: { q: 'x' } };
      yield { type: 'stop', stopReason: 'tool_use' };
      return;
    }
    yield { type: 'text_delta', text: 'done' };
    yield { type: 'stop', stopReason: 'end_turn' };
  }
  async call() { return { text: '', usage: { inputTokens: 0, outputTokens: 0 } }; }
}

class JustStopAdapter {
  constructor() { this.calls = []; }
  async *stream(params) {
    this.calls.push(params);
    yield { type: 'text_delta', text: 'ok' };
    yield { type: 'stop', stopReason: 'end_turn' };
  }
  async call() { return { text: '', usage: { inputTokens: 0, outputTokens: 0 } }; }
}

function mkRegistryWithBigGrep(payload) {
  const reg = new ToolRegistry();
  reg.register(defineTool({
    name: 'big_grep',
    description: 'returns a fixed huge string',
    parameters: { type: 'object', properties: {} },
    execute: async () => payload,
  }));
  return reg;
}

function mkEngine({ adapter, model, registry, yeaftDir, archive, maxContextTokens }) {
  return new Engine({
    adapter,
    trace: new NullTrace(),
    config: {
      model,
      maxOutputTokens: 1024,
      _readOnly: true,
      language: 'en',
      maxContextTokens,
      archive,
    },
    yeaftDir,
    toolRegistry: registry,
  });
}

describe('per-tool-result hard cap (registry boundary)', () => {
  it('caps at floor(contextWindow * 0.10) for normal-sized contexts', async () => {
    // gpt-5 has contextWindow 256000 → cap = 25600 chars.
    const huge = 'X'.repeat(50_000);
    const adapter = new ToolThenStopAdapter();
    const registry = mkRegistryWithBigGrep(huge);
    const engine = mkEngine({ adapter, model: 'gpt-5', registry });

    for await (const _ of engine.query({ prompt: 'go', messages: [] })) { /* drain */ }

    // Second adapter.stream() call carries the tool result in messages.
    expect(adapter.calls.length).toBeGreaterThanOrEqual(2);
    const second = adapter.calls[1];
    const toolMsg = second.messages.find(m => m.role === 'tool' && m.toolCallId === 'tc-1');
    expect(toolMsg).toBeTruthy();
    // The cap is 25600; the marker adds < 200 extra chars.
    expect(toolMsg.content.length).toBeGreaterThan(25_000);
    expect(toolMsg.content.length).toBeLessThan(26_000);
    expect(toolMsg.content).toContain('[truncated: big_grep returned');
    expect(toolMsg.content).toContain('capped at');
  });

  it('respects the 8KB floor for tiny-context test models', async () => {
    // No registry entry → resolveModel returns null → fall back to
    // config.maxContextTokens (here 4096). 10% of 4096 = 409, so the floor
    // bites: cap = max(8192, 409) = 8192.
    const huge = 'X'.repeat(20_000);
    const adapter = new ToolThenStopAdapter();
    const registry = mkRegistryWithBigGrep(huge);
    const engine = mkEngine({
      adapter,
      model: 'unknown-tiny-test-model',
      maxContextTokens: 4096,
      registry,
    });

    for await (const _ of engine.query({ prompt: 'go', messages: [] })) { /* drain */ }

    const toolMsg = adapter.calls[1].messages.find(m => m.role === 'tool' && m.toolCallId === 'tc-1');
    expect(toolMsg).toBeTruthy();
    expect(toolMsg.content.length).toBeGreaterThan(8000);
    expect(toolMsg.content.length).toBeLessThan(8500);
    expect(toolMsg.content).toContain('[truncated:');
  });

  it('truncation marker reports both the original size and the cap', async () => {
    const huge = 'X'.repeat(60_000);
    const adapter = new ToolThenStopAdapter();
    const registry = mkRegistryWithBigGrep(huge);
    const engine = mkEngine({ adapter, model: 'gpt-5', registry });

    for await (const _ of engine.query({ prompt: 'go', messages: [] })) { /* drain */ }

    const toolMsg = adapter.calls[1].messages.find(m => m.role === 'tool' && m.toolCallId === 'tc-1');
    // Source size 60_000 chars ≈ 58.6KB; cap 25_600 chars ≈ 25.0KB.
    expect(toolMsg.content).toMatch(/\[truncated: big_grep returned [\d.]+KB, capped at [\d.]+KB; the model will not see the rest of this output\]/);
  });
});

describe('pre-flight total-token sweep', () => {
  it('triggers emergency archiveToolResults({turnAgeMin: 0}) when total > 85%', async () => {
    archiveToolResults.mockClear();

    // gpt-5 → 256000 ctx → threshold = 217600 tokens. Each tool message
    // ~30000 chars ≈ 7500 tokens (char/4). 30 such messages ≈ 225K — past
    // threshold. We seed many large stale tool messages so the pre-flight
    // estimator trips.
    const adapter = new JustStopAdapter();
    const big = 'X'.repeat(30_000);
    const seeded = [];
    for (let i = 0; i < 30; i += 1) {
      seeded.push({ role: 'user', content: 'q' });
      seeded.push({ role: 'assistant', content: '', toolCalls: [{ id: `tc-${i}`, name: 't', input: {} }] });
      seeded.push({ role: 'tool', toolCallId: `tc-${i}`, content: big });
    }
    const engine = mkEngine({
      adapter,
      model: 'gpt-5',
      registry: new ToolRegistry(),
      yeaftDir: '/tmp/fake-yeaft-704b',
    });

    for await (const _ of engine.query({ prompt: 'go', messages: seeded })) { /* drain */ }

    // First call: standard sweep (turnAgeMin from config, undefined → default 5).
    // Second call: pre-flight emergency sweep (turnAgeMin: 0). Both happen.
    expect(archiveToolResults).toHaveBeenCalledTimes(2);
    const second = archiveToolResults.mock.calls[1][0];
    expect(second.turnAgeMin).toBe(0);
    expect(second.lengthMin).toBe(2000);
  });

  it('does NOT trigger emergency sweep when total < 85%', async () => {
    archiveToolResults.mockClear();

    const adapter = new JustStopAdapter();
    // Small messages — well under 85% of 256K context.
    const seeded = [
      { role: 'user', content: 'small q' },
      { role: 'assistant', content: 'small a' },
    ];
    const engine = mkEngine({
      adapter,
      model: 'gpt-5',
      registry: new ToolRegistry(),
      yeaftDir: '/tmp/fake-yeaft-704b',
    });

    for await (const _ of engine.query({ prompt: 'go', messages: seeded })) { /* drain */ }

    // Only the standard archive sweep — NOT the pre-flight emergency one.
    expect(archiveToolResults).toHaveBeenCalledTimes(1);
    const only = archiveToolResults.mock.calls[0][0];
    // Standard sweep uses config.archive.turnAgeMin (undefined here →
    // archiveToolResults internal default 5). The pre-flight branch is
    // distinguishable by `turnAgeMin: 0`.
    expect(only.turnAgeMin).toBeUndefined();
  });
});
