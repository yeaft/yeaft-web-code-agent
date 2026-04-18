/**
 * engine-abort.test.js — task-325a coverage for Engine.abort().
 *
 * Verifies the agent-side abort通路:
 *   1. `engine.abort()` as a first-class public surface.
 *   2. State machine convergence on `{type:'aborted'} + turn_end('aborted')`.
 *   3. Adapter signal propagation (engine.abort → adapter.stream signal).
 *   4. Tool-loop mid-batch abort halts dispatch but reports cleanly.
 *   5. Backward compat with caller-provided external AbortSignal.
 *   6. Idempotence: abort() on idle engine is a no-op.
 *   7. LLMAbortError thrown from adapter converges on `aborted` (not error).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Engine } from '../../../agent/unify/engine.js';
import { NullTrace } from '../../../agent/unify/debug-trace.js';
import { LLMAbortError } from '../../../agent/unify/llm/adapter.js';

let trace;

beforeEach(() => {
  trace = new NullTrace();
});

// ─── Helpers ─────────────────────────────────────────────────────

/** Drain an async iterator into an array, with optional per-event side effect. */
async function drain(gen, onEvent) {
  const events = [];
  for await (const ev of gen) {
    events.push(ev);
    if (onEvent) await onEvent(ev);
  }
  return events;
}

/** Adapter whose stream can be aborted mid-flight via the passed signal. */
function makeAbortableAdapter({ throwsOnAbort = true, preText = '' } = {}) {
  return {
    lastSignal: null,
    async *stream(params) {
      this.lastSignal = params.signal;
      if (preText) yield { type: 'text_delta', text: preText };
      // Hang until aborted (or up to 2s fail-safe).
      await new Promise((resolve, reject) => {
        const to = setTimeout(() => resolve(), 2000);
        if (params.signal) {
          params.signal.addEventListener('abort', () => {
            clearTimeout(to);
            if (throwsOnAbort) reject(new LLMAbortError());
            else resolve();
          });
        }
      });
      yield { type: 'text_delta', text: 'late' };
      yield { type: 'stop', stopReason: 'end_turn' };
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────

describe('Engine.abort() — task-325a', () => {
  it('abort() during stream converges on aborted + turn_end("aborted")', async () => {
    const adapter = makeAbortableAdapter();
    const engine = new Engine({
      adapter,
      trace,
      config: { model: 'test-model', maxOutputTokens: 1024 },
    });

    // Kick off query, then abort after the first text_delta arrives.
    const iter = engine.query({ prompt: 'hi' });
    const events = [];
    for await (const ev of iter) {
      events.push(ev);
      if (ev.type === 'turn_start') {
        // Schedule abort for the next microtask so the adapter is hanging.
        setTimeout(() => engine.abort('user'), 10);
      }
    }

    const aborted = events.filter(e => e.type === 'aborted');
    expect(aborted).toHaveLength(1);
    expect(aborted[0].reason).toBe('user');

    const lastTurnEnd = [...events].reverse().find(e => e.type === 'turn_end');
    expect(lastTurnEnd.stopReason).toBe('aborted');
  });

  it('abort() propagates the engine signal into adapter.stream params', async () => {
    const adapter = makeAbortableAdapter();
    const engine = new Engine({
      adapter,
      trace,
      config: { model: 'test-model', maxOutputTokens: 1024 },
    });

    const iter = engine.query({ prompt: 'hi' });
    setTimeout(() => engine.abort('user'), 20);
    await drain(iter);

    expect(adapter.lastSignal).toBeDefined();
    expect(adapter.lastSignal.aborted).toBe(true);
  });

  it('pre-aborted external signal yields aborted with reason "external"', async () => {
    const adapter = makeAbortableAdapter();
    const engine = new Engine({
      adapter,
      trace,
      config: { model: 'test-model', maxOutputTokens: 1024 },
    });
    const ac = new AbortController();
    ac.abort();

    const events = await drain(engine.query({ prompt: 'hi', signal: ac.signal }));

    const aborted = events.filter(e => e.type === 'aborted');
    expect(aborted).toHaveLength(1);
    expect(aborted[0].reason).toBe('external');
  });

  it('external signal firing mid-stream is surfaced as aborted (not error)', async () => {
    const adapter = makeAbortableAdapter();
    const engine = new Engine({
      adapter,
      trace,
      config: { model: 'test-model', maxOutputTokens: 1024 },
    });
    const ac = new AbortController();

    const iter = engine.query({ prompt: 'hi', signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    const events = await drain(iter);

    expect(events.some(e => e.type === 'aborted')).toBe(true);
    // No `error` terminal event — abort is not an error.
    const terminalError = events.find(e => e.type === 'error');
    expect(terminalError).toBeUndefined();
  });

  it('abort() is idempotent and a no-op when engine is idle', () => {
    const adapter = { async *stream() {} };
    const engine = new Engine({
      adapter,
      trace,
      config: { model: 'test-model' },
    });

    expect(engine.isRunning).toBe(false);
    expect(engine.abort('user')).toBe(false);
    // Second call still safe.
    expect(engine.abort('user')).toBe(false);
  });

  it('isRunning flips true during query and back to false after abort', async () => {
    const adapter = makeAbortableAdapter();
    const engine = new Engine({
      adapter,
      trace,
      config: { model: 'test-model' },
    });

    const states = [];
    const iter = engine.query({ prompt: 'hi' });
    states.push({ stage: 'pre-drain', running: engine.isRunning });

    setTimeout(() => {
      states.push({ stage: 'pre-abort', running: engine.isRunning });
      engine.abort('user');
    }, 10);

    await drain(iter);
    states.push({ stage: 'post-drain', running: engine.isRunning });

    // Pre-drain: we haven't pulled the first value yet, so the try{} hasn't
    // run — isRunning may be false. Pre-abort (mid-stream) MUST be true.
    expect(states.find(s => s.stage === 'pre-abort').running).toBe(true);
    // Post-drain: finally block has cleared state.
    expect(states.find(s => s.stage === 'post-drain').running).toBe(false);
  });

  it('abort between tool executions halts dispatch of remaining tools', async () => {
    // Stream returns three tool calls; abort fires after the first runs so
    // tools 2 and 3 should NOT be invoked. Engine converges on aborted.
    const adapter = {
      async *stream() {
        yield { type: 'tool_call', id: 't1', name: 'noop', input: {} };
        yield { type: 'tool_call', id: 't2', name: 'noop', input: {} };
        yield { type: 'tool_call', id: 't3', name: 'noop', input: {} };
        yield { type: 'stop', stopReason: 'tool_use' };
      },
    };
    const engine = new Engine({
      adapter,
      trace,
      config: { model: 'test-model' },
    });

    const execCounts = { n: 0 };
    engine.registerTool({
      name: 'noop',
      description: '',
      parameters: {},
      execute: async () => {
        execCounts.n++;
        if (execCounts.n === 1) {
          // Abort as soon as tool 1 runs; tools 2/3 must be skipped.
          engine.abort('user');
        }
        return 'ok';
      },
    });

    const events = await drain(engine.query({ prompt: 'hi' }));

    expect(execCounts.n).toBe(1);
    const aborted = events.filter(e => e.type === 'aborted');
    expect(aborted).toHaveLength(1);
    expect(aborted[0].reason).toBe('user');
    const lastTurnEnd = [...events].reverse().find(e => e.type === 'turn_end');
    expect(lastTurnEnd.stopReason).toBe('aborted');
  });

  it('LLMAbortError from adapter converges on aborted (not generic error)', async () => {
    // Adapter throws LLMAbortError directly (as a provider SDK would when
    // fetch's abort path manifests as a typed error).
    const adapter = {
      async *stream() {
        // eslint-disable-next-line require-yield
        throw new LLMAbortError();
      },
    };
    const engine = new Engine({
      adapter,
      trace,
      config: { model: 'test-model' },
    });

    // Trigger via engine.abort after an immediate next-tick so the reason
    // tag is 'user' (not the generic 'external').
    setTimeout(() => engine.abort('user'), 0);
    const events = await drain(engine.query({ prompt: 'hi' }));

    const aborted = events.filter(e => e.type === 'aborted');
    expect(aborted).toHaveLength(1);
    // No terminal error event for abort path.
    expect(events.find(e => e.type === 'error')).toBeUndefined();
  });

  it('subsequent query() works after an aborted one (state is fully reset)', async () => {
    const adapter = {
      callCount: 0,
      async *stream() {
        this.callCount++;
        if (this.callCount === 1) {
          // First call hangs until aborted.
          await new Promise((resolve, reject) => {
            // Use AbortController.signal captured via arguments.
            setTimeout(() => reject(new LLMAbortError()), 1000);
          });
        }
        yield { type: 'text_delta', text: 'second OK' };
        yield { type: 'stop', stopReason: 'end_turn' };
      },
    };
    const engine = new Engine({
      adapter,
      trace,
      config: { model: 'test-model' },
    });

    // Run 1: abort early.
    const iter1 = engine.query({ prompt: 'first' });
    setTimeout(() => engine.abort('user'), 5);
    await drain(iter1);
    expect(engine.isRunning).toBe(false);

    // Run 2: fresh query, should complete normally.
    const events2 = await drain(engine.query({ prompt: 'second' }));
    expect(events2.some(e => e.type === 'text_delta' && e.text === 'second OK')).toBe(true);
    const last2 = [...events2].reverse().find(e => e.type === 'turn_end');
    expect(last2.stopReason).toBe('end_turn');
  });
});
