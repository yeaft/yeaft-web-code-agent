/**
 * persist-load-older-by-group.test.js — pagination cursor for Unify
 * "Load older messages".
 *
 * Covers the contract documented on `ConversationStore.loadOlderByGroup`:
 *   - cursor walks turn-by-turn through hot history
 *   - hot↔cold transition is transparent (cold ids are strictly < hot ids
 *     because #getNextSeq is global and moveToCold is renameSync)
 *   - groupId filter excludes other groups
 *   - hasMore is computed in TURNS, not raw messages
 *   - empty / pathological inputs return `{ messages: [], oldestSeq: null,
 *     hasMore: false }` instead of throwing
 *
 * Integration with sliceLastNTurns / pairSanitize is exercised via the
 * concrete on-disk store rather than mocked, so any future reshape of the
 * private slicing pipeline that breaks the cursor surface here.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ConversationStore,
  parseSeqFromId,
} from '../../../../agent/unify/conversation/persist.js';

const TEST_DIR = join(tmpdir(), `yeaft-test-load-older-${Date.now()}-${Math.random().toString(36).slice(2)}`);

let store;

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  store = new ConversationStore(TEST_DIR);
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

/** Build N turns into `groupId`. Each turn = user + assistant. */
function seedTurns(groupId, n, prefix = 'q') {
  const batch = [];
  for (let i = 1; i <= n; i++) {
    batch.push({ role: 'user',      content: `${prefix}${i}`, groupId });
    batch.push({ role: 'assistant', content: `a${prefix}${i}`, groupId });
  }
  store.appendBatch(batch);
}

describe('parseSeqFromId', () => {
  it('extracts the numeric portion of a well-formed id', () => {
    expect(parseSeqFromId('m0001')).toBe(1);
    expect(parseSeqFromId('m12345')).toBe(12345);
  });

  it('returns NaN for malformed ids', () => {
    expect(parseSeqFromId(null)).toBeNaN();
    expect(parseSeqFromId('')).toBeNaN();
    expect(parseSeqFromId('not-an-id')).toBeNaN();
    expect(parseSeqFromId('m')).toBeNaN();
  });
});

describe('loadOlderByGroup — empty / defensive paths', () => {
  it('returns empty result for missing/empty groupId', () => {
    seedTurns('g1', 5);
    expect(store.loadOlderByGroup(null, null, 5))
      .toEqual({ messages: [], oldestSeq: null, hasMore: false });
    expect(store.loadOlderByGroup('', null, 5))
      .toEqual({ messages: [], oldestSeq: null, hasMore: false });
    expect(store.loadOlderByGroup(undefined, null, 5))
      .toEqual({ messages: [], oldestSeq: null, hasMore: false });
  });

  it('returns empty result when group has no messages', () => {
    seedTurns('g-other', 3);
    const r = store.loadOlderByGroup('g-empty', null, 5);
    expect(r.messages).toEqual([]);
    expect(r.oldestSeq).toBeNull();
    expect(r.hasMore).toBe(false);
  });

  it('treats beforeSeq=0 as "nothing older than seq 0"', () => {
    seedTurns('g1', 3);
    const r = store.loadOlderByGroup('g1', 0, 5);
    expect(r.messages).toEqual([]);
    expect(r.oldestSeq).toBeNull();
    expect(r.hasMore).toBe(false);
  });

  it('treats beforeSeq=null/undefined/Infinity as "from newest"', () => {
    seedTurns('g1', 2);
    const fromNewestNull   = store.loadOlderByGroup('g1', null, 50);
    const fromNewestUndef  = store.loadOlderByGroup('g1', undefined, 50);
    const fromNewestInf    = store.loadOlderByGroup('g1', Infinity, 50);
    expect(fromNewestNull.messages.map(m => m.content))
      .toEqual(['q1', 'aq1', 'q2', 'aq2']);
    expect(fromNewestUndef.messages.map(m => m.content))
      .toEqual(fromNewestNull.messages.map(m => m.content));
    expect(fromNewestInf.messages.map(m => m.content))
      .toEqual(fromNewestNull.messages.map(m => m.content));
  });
});

describe('loadOlderByGroup — hot-only history', () => {
  it('returns the last N turns when called with no cursor', () => {
    seedTurns('g1', 5);
    const r = store.loadOlderByGroup('g1', null, 2);
    expect(r.messages.map(m => m.content)).toEqual(['q4', 'aq4', 'q5', 'aq5']);
    // 5 - 2 = 3 turns left → has more.
    expect(r.hasMore).toBe(true);
    // oldestSeq is the seq of the first message in the slice.
    expect(r.oldestSeq).toBe(parseSeqFromId(r.messages[0].id));
  });

  it('walks backwards turn-by-turn until exhausted', () => {
    seedTurns('g1', 5);
    // Page 1 — newest 2 turns.
    const p1 = store.loadOlderByGroup('g1', null, 2);
    expect(p1.messages.map(m => m.content)).toEqual(['q4', 'aq4', 'q5', 'aq5']);
    expect(p1.hasMore).toBe(true);

    // Page 2 — next 2 older turns, cursor = oldestSeq of p1.
    const p2 = store.loadOlderByGroup('g1', p1.oldestSeq, 2);
    expect(p2.messages.map(m => m.content)).toEqual(['q2', 'aq2', 'q3', 'aq3']);
    expect(p2.hasMore).toBe(true);

    // Page 3 — final, only 1 turn left.
    const p3 = store.loadOlderByGroup('g1', p2.oldestSeq, 2);
    expect(p3.messages.map(m => m.content)).toEqual(['q1', 'aq1']);
    expect(p3.hasMore).toBe(false);

    // Page 4 — nothing older.
    const p4 = store.loadOlderByGroup('g1', p3.oldestSeq, 2);
    expect(p4.messages).toEqual([]);
    expect(p4.oldestSeq).toBeNull();
    expect(p4.hasMore).toBe(false);
  });

  it('hasMore=false when the slice covers the whole prefix exactly', () => {
    seedTurns('g1', 3);
    const r = store.loadOlderByGroup('g1', null, 3);
    expect(r.messages.map(m => m.content)).toEqual([
      'q1', 'aq1', 'q2', 'aq2', 'q3', 'aq3',
    ]);
    expect(r.hasMore).toBe(false);
  });

  it('hasMore=false when turnsLimit > available turns', () => {
    seedTurns('g1', 2);
    const r = store.loadOlderByGroup('g1', null, 10);
    expect(r.messages.map(m => m.content)).toEqual([
      'q1', 'aq1', 'q2', 'aq2',
    ]);
    expect(r.hasMore).toBe(false);
  });
});

describe('loadOlderByGroup — turn-boundary correctness', () => {
  it('21-turn group with turns=10 splits cleanly across 3 pages', () => {
    seedTurns('g1', 21);
    // Page 1 — newest 10 turns: q12..q21.
    const p1 = store.loadOlderByGroup('g1', null, 10);
    const p1Qs = p1.messages.filter(m => m.role === 'user').map(m => m.content);
    expect(p1Qs).toEqual(['q12','q13','q14','q15','q16','q17','q18','q19','q20','q21']);
    // The page's first message is "q12" (seq corresponding to turn 12, raw msg #23).
    expect(p1.oldestSeq).toBe(parseSeqFromId(p1.messages[0].id));
    expect(p1.messages[0].content).toBe('q12');
    expect(p1.hasMore).toBe(true);

    // Page 2 — next 10 turns: q2..q11.
    const p2 = store.loadOlderByGroup('g1', p1.oldestSeq, 10);
    const p2Qs = p2.messages.filter(m => m.role === 'user').map(m => m.content);
    expect(p2Qs).toEqual(['q2','q3','q4','q5','q6','q7','q8','q9','q10','q11']);
    expect(p2.messages[0].content).toBe('q2');
    expect(p2.hasMore).toBe(true);

    // Page 3 — final 1 turn: q1.
    const p3 = store.loadOlderByGroup('g1', p2.oldestSeq, 10);
    const p3Qs = p3.messages.filter(m => m.role === 'user').map(m => m.content);
    expect(p3Qs).toEqual(['q1']);
    expect(p3.hasMore).toBe(false);
  });
});

describe('loadOlderByGroup — groupId isolation', () => {
  it('ignores messages from other groups', () => {
    // Interleave 3 turns each across two groups.
    store.appendBatch([
      { role: 'user',      content: 'A1', groupId: 'g_a' },
      { role: 'assistant', content: 'aA1', groupId: 'g_a' },
      { role: 'user',      content: 'B1', groupId: 'g_b' },
      { role: 'assistant', content: 'aB1', groupId: 'g_b' },
      { role: 'user',      content: 'A2', groupId: 'g_a' },
      { role: 'assistant', content: 'aA2', groupId: 'g_a' },
      { role: 'user',      content: 'B2', groupId: 'g_b' },
      { role: 'assistant', content: 'aB2', groupId: 'g_b' },
      { role: 'user',      content: 'A3', groupId: 'g_a' },
      { role: 'assistant', content: 'aA3', groupId: 'g_a' },
    ]);
    const a = store.loadOlderByGroup('g_a', null, 10);
    expect(a.messages.map(m => m.content)).toEqual([
      'A1', 'aA1', 'A2', 'aA2', 'A3', 'aA3',
    ]);
    expect(a.hasMore).toBe(false);

    const b = store.loadOlderByGroup('g_b', null, 10);
    expect(b.messages.map(m => m.content)).toEqual([
      'B1', 'aB1', 'B2', 'aB2',
    ]);
    expect(b.hasMore).toBe(false);
  });

  it('ignores untagged (legacy / pre-grouping) messages', () => {
    store.appendBatch([
      { role: 'user',      content: 'orphan' }, // no groupId
      { role: 'user',      content: 'A1',     groupId: 'g1' },
      { role: 'assistant', content: 'aA1',    groupId: 'g1' },
    ]);
    const r = store.loadOlderByGroup('g1', null, 10);
    expect(r.messages.map(m => m.content)).toEqual(['A1', 'aA1']);
    expect(r.hasMore).toBe(false);
  });
});

describe('loadOlderByGroup — hot/cold tier crossing', () => {
  it('reads transparently across cold and hot tiers', () => {
    seedTurns('g1', 5);
    // Archive the oldest 2 turns (m0001..m0004) into cold.
    store.moveToColdBatch(['m0001', 'm0002', 'm0003', 'm0004']);
    expect(store.countCold()).toBe(4);
    expect(store.countHot()).toBe(6);

    // Total still 5 turns. Page through 2 turns at a time.
    const p1 = store.loadOlderByGroup('g1', null, 2);
    expect(p1.messages.map(m => m.content)).toEqual(['q4', 'aq4', 'q5', 'aq5']);
    expect(p1.hasMore).toBe(true);

    // Page 2 spans cold (q2/aq2 lives at m0003/m0004 → cold) and hot.
    const p2 = store.loadOlderByGroup('g1', p1.oldestSeq, 2);
    expect(p2.messages.map(m => m.content)).toEqual(['q2', 'aq2', 'q3', 'aq3']);
    expect(p2.hasMore).toBe(true);

    // Page 3 — last cold turn.
    const p3 = store.loadOlderByGroup('g1', p2.oldestSeq, 2);
    expect(p3.messages.map(m => m.content)).toEqual(['q1', 'aq1']);
    expect(p3.hasMore).toBe(false);
  });

  it('cold ids are strictly less than hot ids (chronology invariant)', () => {
    seedTurns('g1', 3);
    store.moveToCold('m0001');
    store.moveToCold('m0002');
    // After moveToCold, append more — new hot ids must be > cold ids.
    store.append({ role: 'user', content: 'q4', groupId: 'g1' });
    const all = store.loadOlderByGroup('g1', null, 10);
    const ids = all.messages.map(m => parseSeqFromId(m.id));
    // Strictly increasing.
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1]);
    }
  });
});

describe('loadOlderByGroup — race-with-streaming safety', () => {
  it('cursor remains stable when newer messages are appended after read', () => {
    seedTurns('g1', 3);
    const p1 = store.loadOlderByGroup('g1', null, 1);
    expect(p1.messages.map(m => m.content)).toEqual(['q3', 'aq3']);

    // Simulate concurrent streaming: a new turn lands AFTER our cursor.
    store.append({ role: 'user',      content: 'q4', groupId: 'g1' });
    store.append({ role: 'assistant', content: 'aq4', groupId: 'g1' });

    // Page 2 with the original cursor must NOT include the newly arrived
    // q4/aq4 — they're seq > p1.oldestSeq.
    const p2 = store.loadOlderByGroup('g1', p1.oldestSeq, 1);
    expect(p2.messages.map(m => m.content)).toEqual(['q2', 'aq2']);
  });
});
