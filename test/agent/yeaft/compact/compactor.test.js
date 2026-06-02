/**
 * Tests for the per-group history Compactor.
 *
 * Compactor lives at `agent/yeaft/compact/compactor.js` and replaces the
 * old `getCompactState` / `scheduleCompactAfterTurn` / `runCompactNow`
 * trio that used to live inline in `web-bridge.js`. It owns:
 *   - per-group single-flight (one compact in flight at a time per group)
 *   - anti-starvation `pending` chain (multiple turns during an in-flight
 *     compact collapse to ONE follow-up)
 *   - race-guard (snapshot reference + length comparison after the LLM
 *     await — bail if the live history was reassigned or push-mutated)
 *   - the call into `compactHistory` via the supplied `summarize`
 *     injectable
 *
 * History ownership stays in the bridge — Compactor only sees a per-call
 * `historyHandle = { get, set }`. The WS sink (`onCompacted`) is wired
 * from the bridge after `installYeaftRuntimeBridge`.
 */

import { describe, it, expect, vi } from 'vitest';
import { Compactor } from '../../../../agent/yeaft/compact/compactor.js';

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Build a deferred promise / resolver pair so a test can hold a compact
 * in flight while it makes assertions. Pattern lifted from the
 * single-flight tests elsewhere in the suite.
 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * Build a history big enough to trigger the default thresholds
 * (>30K minTokenFloor + >40 % of 200K context = 80K). With ~4 chars per
 * token, ~360K characters spread across enough turns gives us plenty of
 * headroom AND >2 user→assistant arcs so `findCutIndex` can fold while
 * preserving the recent-2 tail.
 *
 * Returns a fresh array each call so tests can mutate without
 * cross-contamination.
 */
function makeLargeHistory() {
  const out = [];
  // 12 turns × ~30K chars per turn ≈ 360K chars / ~90K tokens. Over the
  // 80K fractional threshold, well above the 30K soft floor.
  const big = 'x'.repeat(30_000);
  for (let i = 0; i < 12; i += 1) {
    out.push({ role: 'user',      content: `Q${i}: ${big}` });
    out.push({ role: 'assistant', content: `A${i}: ${big}` });
  }
  return out;
}

/** Tiny history that should never trigger compaction. */
function makeTinyHistory() {
  return [
    { role: 'user',      content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ];
}

/** Make a `historyHandle` over a mutable cell. Reassignment via `set`. */
function makeHandle(initial) {
  const cell = { value: initial };
  return {
    handle: {
      get: () => cell.value,
      set: (next) => { cell.value = next; },
    },
    cell,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('Compactor', () => {
  describe('constructor validation', () => {
    it('throws when summarize is missing', () => {
      expect(() => new Compactor({})).toThrow(/summarize is required/);
      expect(() => new Compactor({ summarize: null })).toThrow(/summarize is required/);
    });
  });

  describe('precheck path', () => {
    it('is a no-op when shouldCompactHistory returns false', async () => {
      const summarize = vi.fn(async () => 'never called');
      const onCompacted = vi.fn();
      const c = new Compactor({ summarize, onCompacted });
      const { handle, cell } = makeHandle(makeTinyHistory());
      const before = cell.value;

      c.scheduleAfterTurn('grp', handle);
      // Wait for the in-flight (if any) to settle. Below the floor the
      // precheck short-circuits before scheduling the LLM.
      await c.awaitInFlight('grp');

      expect(summarize).not.toHaveBeenCalled();
      expect(onCompacted).not.toHaveBeenCalled();
      expect(cell.value).toBe(before);
    });

    it('is a no-op when historyHandle.get returns empty / non-array', async () => {
      const summarize = vi.fn(async () => 'never called');
      const c = new Compactor({ summarize });
      const handle = { get: () => [], set: vi.fn() };

      c.scheduleAfterTurn('grp', handle);
      await c.awaitInFlight('grp');

      expect(summarize).not.toHaveBeenCalled();
      expect(handle.set).not.toHaveBeenCalled();
    });
  });

  describe('happy path', () => {
    it('summarizes, swaps, and calls onCompacted', async () => {
      const summarize = vi.fn(async () => 'TEST_SUMMARY');
      const onCompacted = vi.fn();
      const c = new Compactor({ summarize, onCompacted });
      const { handle, cell } = makeHandle(makeLargeHistory());
      const before = cell.value;

      c.scheduleAfterTurn('grp', handle);
      await c.awaitInFlight('grp');

      // Summarize was called exactly once with system + prompt.
      expect(summarize).toHaveBeenCalledTimes(1);
      const call0 = summarize.mock.calls[0][0];
      expect(typeof call0.system).toBe('string');
      expect(typeof call0.prompt).toBe('string');
      expect(call0.maxTokens).toBe(1024);

      // History was reassigned to the compacted form.
      expect(cell.value).not.toBe(before);
      expect(Array.isArray(cell.value)).toBe(true);
      // First message of the compacted history is the synthesized
      // user-role summary message (canonical Claude-Code phrase
      // wrapper); a quick regex sanity-check is enough — full shape is
      // tested in history-compact.test.js.
      expect(cell.value[0].role).toBe('user');
      expect(String(cell.value[0].content)).toMatch(/TEST_SUMMARY/);

      // Sink fired with the expected fields.
      expect(onCompacted).toHaveBeenCalledTimes(1);
      const [groupId, result] = onCompacted.mock.calls[0];
      expect(groupId).toBe('grp');
      expect(result).toMatchObject({
        beforeTurns: expect.any(Number),
        afterTurns: expect.any(Number),
        beforeTokens: expect.any(Number),
        afterTokens: expect.any(Number),
        archivedCount: expect.any(Number),
      });
      expect(result.afterTurns).toBeLessThan(result.beforeTurns);
    });
  });

  describe('single-flight + anti-starvation', () => {
    it('two back-to-back schedules → one in-flight, one pending → ONE chained re-run', async () => {
      const d1 = deferred();
      const summarize = vi.fn(async () => { await d1.promise; return 'FIRST_SUMMARY'; });
      const c = new Compactor({ summarize });
      const { handle } = makeHandle(makeLargeHistory());

      // Spy on _runOnce so we can count chained invocations independent
      // of whether the chained run actually triggers a summarize call
      // (post-compact the history drops below the floor and the
      // follow-up correctly triages out — that's the right behaviour,
      // but it means counting summarize calls would mis-measure the
      // "did we re-arm exactly once?" invariant).
      const origRunOnce = c._runOnce.bind(c);
      const runOnceSpy = vi.fn((gid, h) => origRunOnce(gid, h));
      c._runOnce = runOnceSpy;

      c.scheduleAfterTurn('grp', handle);   // starts run 1 (hangs on d1)
      // Yield once so run 1 is actually in flight.
      await Promise.resolve();
      // While run 1 is hung, fire 5 more — they must collapse to ONE
      // pending follow-up.
      c.scheduleAfterTurn('grp', handle);
      c.scheduleAfterTurn('grp', handle);
      c.scheduleAfterTurn('grp', handle);
      c.scheduleAfterTurn('grp', handle);
      c.scheduleAfterTurn('grp', handle);

      // Pending must be set, and only run 1 has been invoked so far.
      expect(c._state('grp').pending).toBe(true);
      expect(runOnceSpy).toHaveBeenCalledTimes(1);

      // Resolve run 1 → .finally fires → microtask schedules run 2.
      d1.resolve();
      // Drain microtasks + macrotasks until the chained re-run has
      // entered _runOnce.
      for (let i = 0; i < 50 && runOnceSpy.mock.calls.length < 2; i += 1) {
        await new Promise((r) => setImmediate(r));
      }
      // Exactly one chained re-run, regardless of whether it itself
      // triggered the LLM (post-compact may be below the floor).
      expect(runOnceSpy).toHaveBeenCalledTimes(2);
      expect(c._state('grp').pending).toBe(false);

      // Settle everything and confirm no further chains.
      await c.awaitInFlight('grp');
      expect(runOnceSpy).toHaveBeenCalledTimes(2);
      // The chained re-run must respect the precheck. After the first
      // compact, history is below the threshold, so the follow-up
      // _runOnce should triage out without engaging the LLM. Asserting
      // exactly ONE summarize call across both runs proves the
      // anti-starvation chain didn't accidentally double-summarize.
      expect(summarize).toHaveBeenCalledTimes(1);
    });

    it('awaitInFlight blocks until the running compact resolves', async () => {
      const d = deferred();
      const summarize = vi.fn(async () => { await d.promise; return 'SUMMARY'; });
      const c = new Compactor({ summarize });
      const { handle } = makeHandle(makeLargeHistory());

      c.scheduleAfterTurn('grp', handle);
      // Yield once so the in-flight is registered.
      await Promise.resolve();

      let resolved = false;
      const waiter = c.awaitInFlight('grp').then(() => { resolved = true; });
      await Promise.resolve();
      expect(resolved).toBe(false);

      d.resolve();
      await waiter;
      expect(resolved).toBe(true);
    });
  });

  describe('race-guard', () => {
    it('bails (no set) when live history reference differs from snapshot', async () => {
      const d = deferred();
      const summarize = vi.fn(async () => { await d.promise; return 'STALE_SUMMARY'; });
      const c = new Compactor({ summarize });
      const { handle, cell } = makeHandle(makeLargeHistory());

      c.scheduleAfterTurn('grp', handle);
      await Promise.resolve();
      // Mid-compact: simulate a `consolidate` event swapping the array.
      cell.value = [{ role: 'user', content: 'fresh start' }];
      const replacement = cell.value;

      d.resolve();
      await c.awaitInFlight('grp');

      // Compactor must NOT have overwritten the swapped-in fresh state
      // with the stale summary.
      expect(cell.value).toBe(replacement);
      expect(cell.value[0].content).toBe('fresh start');
    });

    it('bails (no set) when live history length differs from snapshot', async () => {
      const d = deferred();
      const summarize = vi.fn(async () => { await d.promise; return 'STALE_SUMMARY'; });
      const c = new Compactor({ summarize });
      const initial = makeLargeHistory();
      const { handle, cell } = makeHandle(initial);

      c.scheduleAfterTurn('grp', handle);
      await Promise.resolve();
      // Mid-compact: a route_forward driver path push-mutates a new
      // message into the same array (reference unchanged, length grew).
      cell.value.push({ role: 'user', content: 'urgent follow-up' });
      const refBeforeFinish = cell.value;
      const lengthBeforeFinish = cell.value.length;

      d.resolve();
      await c.awaitInFlight('grp');

      // Same reference, same length — Compactor recognised the push
      // and refused to clobber.
      expect(cell.value).toBe(refBeforeFinish);
      expect(cell.value.length).toBe(lengthBeforeFinish);
      expect(cell.value[cell.value.length - 1].content).toBe('urgent follow-up');
    });
  });

  describe('error swallowing', () => {
    it('swallows onCompacted sink failures', async () => {
      const summarize = vi.fn(async () => 'OK_SUMMARY');
      const onCompacted = vi.fn(() => { throw new Error('sink boom'); });
      const c = new Compactor({ summarize, onCompacted });
      const { handle, cell } = makeHandle(makeLargeHistory());

      c.scheduleAfterTurn('grp', handle);
      // Must not reject — sink failure cannot abort the orchestrator.
      await expect(c.awaitInFlight('grp')).resolves.toBeUndefined();

      // History was still swapped (set ran before sink).
      expect(cell.value[0].role).toBe('user');
      expect(String(cell.value[0].content)).toMatch(/OK_SUMMARY/);
      // Sink was attempted exactly once.
      expect(onCompacted).toHaveBeenCalledTimes(1);
    });

    it('swallows summarize failures and leaves history untouched', async () => {
      const summarize = vi.fn(async () => { throw new Error('llm 500'); });
      const onCompacted = vi.fn();
      const c = new Compactor({ summarize, onCompacted });
      const { handle, cell } = makeHandle(makeLargeHistory());
      const before = cell.value;

      c.scheduleAfterTurn('grp', handle);
      await expect(c.awaitInFlight('grp')).resolves.toBeUndefined();

      // History reference unchanged. compactHistory turns the LLM error
      // into `compacted: false`, so we never reach `set` or
      // `onCompacted`.
      expect(cell.value).toBe(before);
      expect(onCompacted).not.toHaveBeenCalled();
    });
  });

  describe('per-group isolation', () => {
    it('a compact in flight for grp-A does not block a schedule for grp-B', async () => {
      const dA = deferred();
      let calls = 0;
      const summarize = vi.fn(async () => {
        calls += 1;
        if (calls === 1) { await dA.promise; return 'A_SUMMARY'; }
        return 'B_SUMMARY';
      });
      const c = new Compactor({ summarize });

      const a = makeHandle(makeLargeHistory());
      const b = makeHandle(makeLargeHistory());

      c.scheduleAfterTurn('grp-A', a.handle);  // hangs on dA
      await Promise.resolve();
      c.scheduleAfterTurn('grp-B', b.handle);  // independent

      // grp-B should resolve without waiting for grp-A.
      await c.awaitInFlight('grp-B');
      expect(b.cell.value[0].content).toMatch(/B_SUMMARY/);

      // grp-A is still in flight.
      dA.resolve();
      await c.awaitInFlight('grp-A');
      expect(a.cell.value[0].content).toMatch(/A_SUMMARY/);
    });
  });

  describe('setOnCompacted', () => {
    it('replaces the post-success sink', async () => {
      const summarize = vi.fn(async () => 'S');
      const sinkA = vi.fn();
      const sinkB = vi.fn();
      const c = new Compactor({ summarize, onCompacted: sinkA });
      c.setOnCompacted(sinkB);

      const { handle } = makeHandle(makeLargeHistory());
      c.scheduleAfterTurn('grp', handle);
      await c.awaitInFlight('grp');

      expect(sinkA).not.toHaveBeenCalled();
      expect(sinkB).toHaveBeenCalledTimes(1);
    });

    it('passing non-function falls back to a no-op (and ACTUALLY replaces the previous sink)', async () => {
      const summarize = vi.fn(async () => 'S');
      // The initial sink would throw if invoked; if `setOnCompacted(null)`
      // failed to replace it, the orchestrator's outer try/catch would
      // still swallow the throw and the test would pass under the wrong
      // invariant. Use a counter so we can prove the throwing sink was
      // never even called.
      const initial = vi.fn(() => { throw new Error('initial'); });
      const c = new Compactor({ summarize, onCompacted: initial });
      c.setOnCompacted(null);

      const { handle } = makeHandle(makeLargeHistory());
      c.scheduleAfterTurn('grp', handle);
      // Must not reject.
      await expect(c.awaitInFlight('grp')).resolves.toBeUndefined();
      // Critical: the throwing sink must have been REPLACED, not merely
      // swallowed. If it ever ran, this assertion would catch the
      // regression.
      expect(initial).not.toHaveBeenCalled();
    });
  });

  describe('__testReset', () => {
    it('clears all per-group state', async () => {
      const summarize = vi.fn(async () => 'S');
      const c = new Compactor({ summarize });
      const { handle } = makeHandle(makeLargeHistory());

      c.scheduleAfterTurn('grp', handle);
      await c.awaitInFlight('grp');
      expect(c._states.size).toBeGreaterThan(0);

      c.__testReset();
      expect(c._states.size).toBe(0);
    });
  });
});
