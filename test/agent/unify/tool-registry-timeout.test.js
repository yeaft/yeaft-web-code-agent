/**
 * Tests for the per-tool execution timeout in ToolRegistry.execute.
 *
 * Motivating bug: a tool whose `execute()` ignored the AbortSignal and
 * never resolved (e.g. a hung network call) blocked the engine
 * generator's `await this.#toolRegistry.execute(...)` indefinitely. The
 * for-await in the bridge driver never advanced → no further events
 * emitted → no `turn_end` → typing dots hung. The bridge's 120s watchdog
 * called `vpAbort.abort()` but a tool that ignores signal also ignores
 * the abort, so the watchdog had no leverage.
 *
 * Fix: ToolRegistry.execute races the tool's promise against a timer.
 * On timeout it throws ToolExecutionTimeoutError; the engine's catch
 * path turns that into `tool_end{isError:true}` and the loop continues
 * cleanly.
 */
import { describe, it, expect } from 'vitest';
import {
  ToolRegistry,
  ToolExecutionTimeoutError,
  DEFAULT_TOOL_TIMEOUT_MS,
} from '../../../agent/unify/tools/registry.js';
import { defineTool } from '../../../agent/unify/tools/types.js';

describe('ToolRegistry.execute — per-tool timeout', () => {
  it('exports DEFAULT_TOOL_TIMEOUT_MS and ToolExecutionTimeoutError', () => {
    expect(typeof DEFAULT_TOOL_TIMEOUT_MS).toBe('number');
    expect(DEFAULT_TOOL_TIMEOUT_MS).toBeGreaterThan(0);
    expect(typeof ToolExecutionTimeoutError).toBe('function');
    const err = new ToolExecutionTimeoutError('foo', 1234);
    expect(err.name).toBe('ToolExecutionTimeoutError');
    expect(err.toolName).toBe('foo');
    expect(err.timeoutMs).toBe(1234);
    expect(err.message).toContain('foo');
    expect(err.message).toContain('1234');
  });

  it('completes promptly when tool resolves before timeout', async () => {
    const reg = new ToolRegistry();
    reg.register(defineTool({
      name: 'fast_tool',
      description: '',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'ok',
    }));

    const out = await reg.execute('fast_tool', {});
    expect(out).toBe('ok');
  });

  it('throws ToolExecutionTimeoutError when tool exceeds its timeout', async () => {
    const reg = new ToolRegistry();
    reg.register(defineTool({
      name: 'slow_tool',
      description: '',
      parameters: { type: 'object', properties: {} },
      // Per-tool override: 50ms. The promise never resolves, so the
      // timer wins.
      timeoutMs: 50,
      execute: () => new Promise(() => { /* never resolves */ }),
    }));

    const start = Date.now();
    let caught = null;
    try {
      await reg.execute('slow_tool', {});
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - start;

    expect(caught).toBeInstanceOf(ToolExecutionTimeoutError);
    expect(caught.toolName).toBe('slow_tool');
    expect(caught.timeoutMs).toBe(50);
    // Should fire close to the deadline (50ms), not after the 90s default.
    expect(elapsed).toBeLessThan(2000);
  });

  it('honors per-tool timeoutMs override (longer than default)', async () => {
    const reg = new ToolRegistry();
    reg.register(defineTool({
      name: 'patient_tool',
      description: '',
      parameters: { type: 'object', properties: {} },
      // Allow 500ms, resolve at ~80ms — well within budget.
      timeoutMs: 500,
      execute: async () => {
        await new Promise((r) => setTimeout(r, 80));
        return 'done';
      },
    }));

    const out = await reg.execute('patient_tool', {});
    expect(out).toBe('done');
  });

  it('disables the timeout when tool sets timeoutMs <= 0', async () => {
    const reg = new ToolRegistry();
    let resolveFn;
    reg.register(defineTool({
      name: 'unbounded_tool',
      description: '',
      parameters: { type: 'object', properties: {} },
      timeoutMs: 0, // disabled
      execute: () => new Promise((r) => { resolveFn = r; }),
    }));

    const promise = reg.execute('unbounded_tool', {});
    // Settle after a short delay — well past anything that would have
    // expired the default; this proves the timer is OFF.
    setTimeout(() => resolveFn('late'), 100);
    const out = await promise;
    expect(out).toBe('late');
  });

  it('error from tool execute() still propagates (no false-timeout)', async () => {
    const reg = new ToolRegistry();
    reg.register(defineTool({
      name: 'angry_tool',
      description: '',
      parameters: { type: 'object', properties: {} },
      execute: async () => { throw new Error('boom'); },
    }));

    let caught = null;
    try {
      await reg.execute('angry_tool', {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(ToolExecutionTimeoutError);
    expect(caught.message).toBe('boom');
  });

  it('still applies result truncation when timeout does not fire', async () => {
    const reg = new ToolRegistry();
    const big = 'x'.repeat(64 * 1024);
    reg.register(defineTool({
      name: 'big_tool',
      description: '',
      parameters: { type: 'object', properties: {} },
      execute: async () => big,
    }));

    const out = await reg.execute('big_tool', {}, { contextWindow: 8000 });
    // 8000 * 0.10 = 800; floor is 8KB. So cap is 8KB. Result is 64KB → truncated.
    expect(out.length).toBeLessThan(big.length);
    expect(out).toContain('[truncated:');
  });
});
