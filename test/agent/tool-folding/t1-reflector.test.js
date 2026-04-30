/**
 * t1-reflector.test.js — PR-L
 *
 * T1 happy path + adapter-throws path. The reflector itself is just a
 * thin wrapper around adapter.call(); the engine is responsible for
 * rewriting history. We assert the wrapper behaviour here and the
 * end-to-end rewrite in engine-reflection-integration.test.js.
 */
import { describe, it, expect } from 'vitest';
import { runT1Reflection } from '../../../agent/unify/tool-folding/t1-reflector.js';
import { collapseRangeToReflection } from '../../../agent/unify/tool-folding/index.js';

const fakeAdapter = (textOrError) => ({
  async call(params) {
    if (textOrError instanceof Error) throw textOrError;
    return { text: textOrError, usage: { inputTokens: 10, outputTokens: 20 } };
  },
});

describe('runT1Reflection — happy path', () => {
  it('returns markdown content + durationMs', async () => {
    const adapter = fakeAdapter('## What was attempted\nstuff');
    const r = await runT1Reflection({
      adapter,
      model: 'm',
      originalUserMsg: 'q',
      toolPairs: [{ name: 'a', input: {}, output: 'ok', isError: false }],
    });
    expect(r.content).toContain('## What was attempted');
    expect(typeof r.durationMs).toBe('number');
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('runT1Reflection — adapter throws', () => {
  it('propagates the error so engine can catch and skip the rewrite', async () => {
    const adapter = fakeAdapter(new Error('boom'));
    await expect(runT1Reflection({
      adapter, model: 'm', originalUserMsg: 'q',
      toolPairs: [{ name: 'a', input: {}, output: 'ok', isError: false }],
    })).rejects.toThrow('boom');
  });

  it('rejects empty content', async () => {
    const adapter = fakeAdapter('   ');
    await expect(runT1Reflection({
      adapter, model: 'm', originalUserMsg: 'q',
      toolPairs: [{ name: 'a', input: {}, output: 'ok', isError: false }],
    })).rejects.toThrow(/empty/);
  });
});

describe('collapseRangeToReflection (used by T1 to rewrite history)', () => {
  it('collapses assistant+tool arc into ONE synthetic user message', () => {
    const before = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 't', input: {} }] },
      { role: 'tool', toolCallId: '1', content: 'r1' },
      { role: 'assistant', content: '', toolCalls: [{ id: '2', name: 't', input: {} }] },
      { role: 'tool', toolCallId: '2', content: 'r2' },
    ];
    const after = collapseRangeToReflection(before, 1, 4, '## reflection\nbody');
    expect(after).toHaveLength(2);
    // Original user prompt stays first.
    expect(after[0].role).toBe('user');
    // Folded arc becomes a synthetic user message — required so the
    // Anthropic Messages API does not see the array end on assistant.
    expect(after[1].role).toBe('user');
    expect(after[1]._reflection).toBe(true);
    // Body wraps the reflection text with header + footer so the model
    // recognises this as a context-recovery directive, not a fresh prompt.
    expect(after[1].content).toContain('## reflection\nbody');
    expect(after[1].content).toMatch(/folded for context efficiency/);
    expect(after[1].content).toMatch(/Continue from here\.$/);
    expect(after[1].content).toMatch(/2 tool calls/);
    // Original is untouched
    expect(before).toHaveLength(5);
  });
});
