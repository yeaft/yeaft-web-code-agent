/**
 * Tests for the bridge-level watchdog escalation helper.
 *
 * Motivating bug: a tool that ignores `signal` and never resolves leaves
 * `runVpTurn` blocked forever even after the in-turn watchdog fires
 * `vpAbort.abort()`. The driver's `await runVpTurn(...)` never returns,
 * the inbox doesn't drain, the typing dot stays on, the user sees a
 * "halt with no turn_end".
 *
 * Fix: `raceWithEscalation` races `runVpTurn` against a hard deadline.
 * If `runVpTurn` doesn't resolve in time, `onEscalate` runs (the bridge
 * uses it to emit a synthetic `result{stopped:true}`) and the wrapper
 * resolves so the driver loop advances to the next envelope. The hung
 * promise leaks, but the user-facing turn is closed.
 *
 * Tested via `__testRaceWithEscalation` exported from web-bridge.js — pure
 * helper, no session bootstrapping required.
 */
import { describe, it, expect } from 'vitest';
import { __testRaceWithEscalation as raceWithEscalation }
  from '../../../agent/unify/web-bridge.js';

describe('raceWithEscalation — bridge-level watchdog', () => {
  it('returns the inner result when it resolves before the deadline', async () => {
    let escalated = false;
    const inner = (async () => {
      await new Promise((r) => setTimeout(r, 20));
      return 'inner-done';
    })();

    const out = await raceWithEscalation(inner, {
      deadlineMs: 500,
      onEscalate: () => { escalated = true; },
    });

    expect(out).toBe('inner-done');
    expect(escalated).toBe(false);
  });

  it('fires onEscalate and resolves when inner hangs past the deadline', async () => {
    let escalated = false;
    // Inner promise never settles — simulates a tool that ignores signal.
    const inner = new Promise(() => { /* never */ });

    const start = Date.now();
    await raceWithEscalation(inner, {
      deadlineMs: 50,
      onEscalate: () => { escalated = true; },
    });
    const elapsed = Date.now() - start;

    expect(escalated).toBe(true);
    // Should fire close to the deadline (50ms), not after some larger budget.
    expect(elapsed).toBeLessThan(2000);
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  it('propagates inner errors without firing onEscalate', async () => {
    let escalated = false;
    const inner = (async () => { throw new Error('inner-boom'); })();

    let caught = null;
    try {
      await raceWithEscalation(inner, {
        deadlineMs: 500,
        onEscalate: () => { escalated = true; },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).toBe('inner-boom');
    expect(escalated).toBe(false);
  });

  it('swallows errors thrown by onEscalate (never crashes the driver)', async () => {
    const inner = new Promise(() => { /* never */ });

    // The bridge's real onEscalate calls sendUnifyOutput which can throw on
    // a torn-down WS. The wrapper must not surface that.
    let resolved = false;
    await raceWithEscalation(inner, {
      deadlineMs: 30,
      onEscalate: () => { throw new Error('ws gone'); },
    }).then(() => { resolved = true; });

    expect(resolved).toBe(true);
  });

  it('clears the timer when inner resolves first (no late escalate)', async () => {
    let escalateCalls = 0;
    const inner = (async () => {
      await new Promise((r) => setTimeout(r, 5));
      return 'fast';
    })();

    await raceWithEscalation(inner, {
      deadlineMs: 50,
      onEscalate: () => { escalateCalls++; },
    });
    // Wait well past the deadline to be sure no late timer fires.
    await new Promise((r) => setTimeout(r, 80));
    expect(escalateCalls).toBe(0);
  });
});
