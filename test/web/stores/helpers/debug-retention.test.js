/**
 * debug-retention.test.js — feat-openai-raw-exchange-parity follow-up.
 *
 * Pinpoints the count-based GC that bounds Yeaft's debug retention. The
 * companion fix (PR #702 + the 76bae660 follow-up) removed every
 * per-payload truncation path; the only thing keeping memory bounded now
 * is this trim. If it regresses — or worse, evicts open turns under
 * multi-VP race conditions — the entire "verbatim copy request" feature
 * silently corrupts itself. Hence: a regression test.
 */

import { describe, it, expect } from 'vitest';
import { trimDebugRetention } from '../../../../web/stores/helpers/debug-retention.js';

function mkLoop(turnId, n) {
  return { turnId, loopNumber: n };
}

function mkTurn(closedAt) {
  return { closedAt: closedAt ?? null };
}

describe('trimDebugRetention', () => {
  it('returns input unchanged when below cap', () => {
    const loops = [mkLoop('t1', 1), mkLoop('t1', 2)];
    const turnsById = { t1: mkTurn(123) };
    const turnOrder = ['t1'];
    const next = trimDebugRetention({ loops, turnsById, turnOrder, maxLoops: 50 });
    expect(next.loops).toBe(loops);
    expect(next.turnsById).toBe(turnsById);
    expect(next.turnOrder).toBe(turnOrder);
  });

  it('drops oldest loops past the cap', () => {
    const loops = [];
    const turnsById = {};
    const turnOrder = [];
    for (let i = 1; i <= 60; i++) {
      const tid = `t${i}`;
      loops.push(mkLoop(tid, i));
      turnsById[tid] = mkTurn(i);
      turnOrder.push(tid);
    }
    const next = trimDebugRetention({ loops, turnsById, turnOrder, maxLoops: 50 });
    expect(next.loops.length).toBe(50);
    // The OLDEST 10 turn-ids should be gone; the newest 50 should remain.
    expect(next.loops[0].turnId).toBe('t11');
    expect(next.loops[49].turnId).toBe('t60');
  });

  it('GC prunes turnsById and turnOrder in lockstep with surviving loops', () => {
    const loops = [];
    const turnsById = {};
    const turnOrder = [];
    for (let i = 1; i <= 60; i++) {
      const tid = `t${i}`;
      loops.push(mkLoop(tid, i));
      turnsById[tid] = mkTurn(i);
      turnOrder.push(tid);
    }
    const next = trimDebugRetention({ loops, turnsById, turnOrder, maxLoops: 50 });
    // Turn order shrinks to the 50 surviving loop turn-ids.
    expect(next.turnOrder.length).toBe(50);
    expect(next.turnOrder[0]).toBe('t11');
    expect(next.turnOrder[49]).toBe('t60');
    // turnsById should not contain any of the dropped turn-ids.
    for (let i = 1; i <= 10; i++) {
      expect(next.turnsById[`t${i}`]).toBeUndefined();
    }
    for (let i = 11; i <= 60; i++) {
      expect(next.turnsById[`t${i}`]).toBeDefined();
    }
  });

  it('protects still-open turns under multi-VP parallel ingest', () => {
    // Setup: VP-B has 50 closed turns, VP-A just opened a turn whose first
    // loop hasn't arrived yet. Adding one more VP-B loop trips the cap; we
    // must not evict VP-A's open turn.
    const loops = [];
    const turnsById = {};
    const turnOrder = [];
    for (let i = 1; i <= 51; i++) {
      const tid = `vpB-${i}`;
      loops.push(mkLoop(tid, i));
      turnsById[tid] = mkTurn(i); // closedAt set
      turnOrder.push(tid);
    }
    // VP-A's turn_open: present in turnsById/turnOrder, no loop yet, closedAt=null.
    turnsById['vpA-open'] = mkTurn(null);
    turnOrder.push('vpA-open');

    const next = trimDebugRetention({ loops, turnsById, turnOrder, maxLoops: 50 });

    // VP-A's open turn must survive the GC even though no surviving loop
    // references it.
    expect(next.turnsById['vpA-open']).toBeDefined();
    expect(next.turnOrder).toContain('vpA-open');
    // Oldest VP-B turn (vpB-1) was dropped along with its loop.
    expect(next.turnsById['vpB-1']).toBeUndefined();
    expect(next.turnOrder).not.toContain('vpB-1');
  });

  it('still evicts CLOSED turns whose loops were all dropped', () => {
    // Variant: a turn record explicitly closedAt set (turn_close arrived)
    // but with no surviving loop — should be GC'd.
    const loops = [];
    const turnsById = {};
    const turnOrder = [];
    for (let i = 1; i <= 60; i++) {
      const tid = `t${i}`;
      loops.push(mkLoop(tid, i));
      turnsById[tid] = mkTurn(i);
      turnOrder.push(tid);
    }
    // t1..t10 will be evicted (their loops dropped); they have closedAt set.
    const next = trimDebugRetention({ loops, turnsById, turnOrder, maxLoops: 50 });
    for (let i = 1; i <= 10; i++) {
      expect(next.turnsById[`t${i}`]).toBeUndefined();
      expect(next.turnOrder).not.toContain(`t${i}`);
    }
  });

  it('handles loops with null/missing turnId gracefully (no orphan crash)', () => {
    // Defensive: a malformed event with no turnId shouldn't blow up the GC.
    const loops = [
      { turnId: null, loopNumber: 1 },
      { loopNumber: 2 },
    ];
    for (let i = 1; i <= 50; i++) {
      loops.push(mkLoop(`t${i}`, i + 2));
    }
    const turnsById = {};
    const turnOrder = [];
    for (let i = 1; i <= 50; i++) {
      turnsById[`t${i}`] = mkTurn(i);
      turnOrder.push(`t${i}`);
    }
    const next = trimDebugRetention({ loops, turnsById, turnOrder, maxLoops: 50 });
    expect(next.loops.length).toBe(50);
    // No exception, no orphan turnsById entries.
    for (const tid of next.turnOrder) {
      expect(next.turnsById[tid]).toBeDefined();
    }
  });
});
