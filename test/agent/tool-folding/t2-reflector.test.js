/**
 * t2-reflector.test.js — PR-L
 *
 * T2 has the same shape as T1 but is designed to be called WITHOUT await
 * by the engine. We verify the promise transitions from pending to ready
 * with the resolved markdown.
 */
import { describe, it, expect } from 'vitest';
import { runT2Reflection } from '../../../agent/yeaft/tool-folding/t2-reflector.js';

describe('runT2Reflection — async behaviour', () => {
  it('returns a promise that resolves to { content, durationMs }', async () => {
    let resolveAdapter;
    const gate = new Promise((res) => { resolveAdapter = res; });
    const adapter = {
      async call() {
        await gate;
        return { text: '## What was attempted\nfoo' };
      },
    };
    const p = runT2Reflection({
      adapter, model: 'm', originalUserMsg: 'q',
      toolPairs: [{ name: 'a', input: {}, output: 'ok', isError: false }],
    });
    // Pending phase: race against an immediate resolve to confirm not ready.
    const PEND = Symbol('pending');
    const settled = await Promise.race([p, Promise.resolve(PEND)]);
    expect(settled).toBe(PEND);

    // Now release the adapter.
    resolveAdapter();
    const r = await p;
    expect(r.content).toContain('## What was attempted');
    expect(typeof r.durationMs).toBe('number');
  });

  it('rejects on adapter failure', async () => {
    const adapter = { async call() { throw new Error('x'); } };
    await expect(runT2Reflection({
      adapter, model: 'm', originalUserMsg: 'q',
      toolPairs: [{ name: 'a', input: {}, output: 'ok', isError: false }],
    })).rejects.toThrow('x');
  });
});
