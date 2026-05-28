/**
 * unify-debug-turn-live-aggregates.test.js
 *
 * Pin the in-flight aggregate behavior of `unifyDebugTurnsForActiveGroup`.
 *
 * Before fix-debug-panel-live-aggregates: the getter forwarded
 * `turn.loopCount` / `totalMs` / `totalTokens` verbatim — but those fields
 * are only stamped by `turn_close`. While a turn was in flight the header
 * showed "0L 0ms 0 tok" (or "50L" once the global loop ring cap was hit
 * and the template's `turn.loops.length` fallback kicked in). For SQLite-
 * hydrated turns whose `turn_close` was never persisted the row stayed
 * "0L 0ms 0 tok" forever.
 *
 * Fix: derive header aggregates from the per-turn loops when the turn
 * isn't closed OR when the stamped field is 0 (hydration fallback).
 */
import { describe, it, expect, beforeAll } from 'vitest';

globalThis.Pinia = globalThis.Pinia || {};
let capturedOptions = null;
globalThis.Pinia.defineStore = (_id, options) => {
  capturedOptions = options;
  return () => ({});
};
globalThis.window = globalThis.window || globalThis;
globalThis.window.Pinia = globalThis.Pinia;

let getters;

beforeAll(async () => {
  await import('../../../web/stores/chat.js');
  if (!capturedOptions) throw new Error('chat store defineStore was not captured');
  getters = capturedOptions.getters;
});

function mkState({ turn, loops }) {
  return {
    unifyDebugTurnOrder: [turn.turnId],
    unifyDebugTurnsById: { [turn.turnId]: turn },
    unifyDebugLoops: loops,
    unifyReflectionCards: {},
    unifyDebugGroupFilter: null,
    unifyActiveGroupFilter: null,
    unifyDebugSearch: '',
  };
}

describe('unifyDebugTurnsForActiveGroup — live header aggregates', () => {
  it('open turn: derives loopCount/totalMs/totalTokens from loops', () => {
    const state = mkState({
      turn: {
        turnId: 't1', userPrompt: 'hi', groupId: 'g',
        openedAt: 1000, closedAt: null,
        totalMs: 0, totalTokens: 0, loopCount: 0,
      },
      loops: [
        { turnId: 't1', loopNumber: 1, latencyMs: 120, usage: { totalTokens: 500 } },
        { turnId: 't1', loopNumber: 2, latencyMs: 80, usage: { totalTokens: 300 } },
      ],
    });
    const [row] = getters.unifyDebugTurnsForActiveGroup(state);
    expect(row.loopCount).toBe(2);
    expect(row.totalMs).toBe(200);
    expect(row.totalTokens).toBe(800);
  });

  it('closed turn with stamped totals: trusts the stamped values', () => {
    const state = mkState({
      turn: {
        turnId: 't2', userPrompt: 'hi', groupId: 'g',
        openedAt: 1000, closedAt: 2000,
        totalMs: 999, totalTokens: 1234, loopCount: 7,
      },
      loops: [
        { turnId: 't2', loopNumber: 1, latencyMs: 1, usage: { totalTokens: 1 } },
      ],
    });
    const [row] = getters.unifyDebugTurnsForActiveGroup(state);
    expect(row.loopCount).toBe(7);
    expect(row.totalMs).toBe(999);
    expect(row.totalTokens).toBe(1234);
  });

  it('hydrated turn with closedAt but zero totals: backfills from loops', () => {
    // SQLite hydration path: row has ended_at but the legacy trace never
    // wrote per-turn totals. Without the backfill, the header read 0/0/0.
    const state = mkState({
      turn: {
        turnId: 't3', userPrompt: 'hi', groupId: 'g',
        openedAt: 1000, closedAt: 2000,
        totalMs: 0, totalTokens: 0, loopCount: 0,
      },
      loops: [
        { turnId: 't3', loopNumber: 1, latencyMs: 50, usage: { inputTokens: 100, outputTokens: 50 } },
        { turnId: 't3', loopNumber: 2, latencyMs: 70, usage: { totalTokens: 200 } },
      ],
    });
    const [row] = getters.unifyDebugTurnsForActiveGroup(state);
    expect(row.loopCount).toBe(2);
    expect(row.totalMs).toBe(120);
    expect(row.totalTokens).toBe(350); // 150 + 200
  });

  it('open turn with no loops yet: header is 0/0/0 (not undefined)', () => {
    const state = mkState({
      turn: {
        turnId: 't4', userPrompt: 'hi', groupId: 'g',
        openedAt: 1000, closedAt: null,
        totalMs: 0, totalTokens: 0, loopCount: 0,
      },
      loops: [],
    });
    const [row] = getters.unifyDebugTurnsForActiveGroup(state);
    expect(row.loopCount).toBe(0);
    expect(row.totalMs).toBe(0);
    expect(row.totalTokens).toBe(0);
  });
});
