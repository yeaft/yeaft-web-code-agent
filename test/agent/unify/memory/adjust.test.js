/**
 * adjust.test.js — H2.d adjustMemory post-turn LLM.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openSegmentIndex } from '../../../../agent/unify/memory/index-db.js';
import { makeSegment } from '../../../../agent/unify/memory/segment.js';
import { ActiveMemorySet } from '../../../../agent/unify/memory/ams.js';
import { computeBudget } from '../../../../agent/unify/memory/budget.js';
import {
  shouldRunAdjust, buildVisibleSegments, buildAdjustPrompt,
  parseAdjustReply, applyAdjustment, runAdjust,
} from '../../../../agent/unify/memory/adjust.js';

let TEST_DIR;
let DB_PATH;
let idx;

beforeEach(() => {
  TEST_DIR = mkdtempSync(join(tmpdir(), 'h2d-'));
  DB_PATH = join(TEST_DIR, 'idx.db');
  idx = openSegmentIndex(DB_PATH);
});

afterEach(() => {
  try { idx.close(); } catch {}
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
});

describe('shouldRunAdjust', () => {
  it('first turn always runs', () => {
    expect(shouldRunAdjust({
      newMemoryWritten: false, onDemandSize: 0,
      turnTokenUsage: 0, totalBudget: 100,
      adjustRanThisSession: false,
    }).run).toBe(true);
  });
  it('budget pressure triggers', () => {
    const r = shouldRunAdjust({
      newMemoryWritten: false, onDemandSize: 0,
      turnTokenUsage: 95, totalBudget: 100,
      adjustRanThisSession: true,
    });
    expect(r.run).toBe(true);
    expect(r.reason).toBe('budget-pressure');
  });
  it('new memory + onDemand≥5 triggers', () => {
    expect(shouldRunAdjust({
      newMemoryWritten: true, onDemandSize: 5,
      turnTokenUsage: 0, totalBudget: 100,
      adjustRanThisSession: true,
    }).run).toBe(true);
  });
  it('quiet turn skips', () => {
    expect(shouldRunAdjust({
      newMemoryWritten: false, onDemandSize: 2,
      turnTokenUsage: 10, totalBudget: 100,
      adjustRanThisSession: true,
    }).run).toBe(false);
  });
});

describe('buildVisibleSegments', () => {
  it('lists all segments in given scopes', () => {
    idx.upsert(makeSegment({ scope: 'user', kind: 'fact', body: 'a' }));
    idx.upsert(makeSegment({ scope: 'user', kind: 'fact', body: 'b' }));
    const out = buildVisibleSegments({
      index: idx, scopes: ['user'], ownVpId: null,
      currentAmsIds: new Set(),
    });
    expect(out).toHaveLength(2);
    expect(out.every(s => s.summarised === false)).toBe(true);
  });

  it('marks inAMS correctly', () => {
    const a = makeSegment({ scope: 'user', kind: 'fact', body: 'a' });
    const b = makeSegment({ scope: 'user', kind: 'fact', body: 'b' });
    idx.upsert(a); idx.upsert(b);
    const out = buildVisibleSegments({
      index: idx, scopes: ['user'], ownVpId: null,
      currentAmsIds: new Set([a.id]),
    });
    expect(out.find(s => s.id === a.id).inAMS).toBe(true);
    expect(out.find(s => s.id === b.id).inAMS).toBe(false);
  });

  it('drops foreign vp scopes', () => {
    idx.upsert(makeSegment({ scope: 'vp/alice', kind: 'fact', body: 'a' }));
    idx.upsert(makeSegment({ scope: 'vp/bob',   kind: 'fact', body: 'b' }));
    const out = buildVisibleSegments({
      index: idx, scopes: ['vp/alice', 'vp/bob'], ownVpId: 'alice',
      currentAmsIds: new Set(),
    });
    expect(out).toHaveLength(1);
    expect(out[0].scope).toBe('vp/alice');
  });

  it('summarises when scope exceeds bodyCap', () => {
    for (let i = 0; i < 5; i += 1) {
      idx.upsert(makeSegment({
        scope: 'user', kind: 'fact', body: `Sentence ${i}. More detail follows here.`,
      }));
    }
    const out = buildVisibleSegments({
      index: idx, scopes: ['user'], ownVpId: null,
      currentAmsIds: new Set(),
      bodyCap: 2,
    });
    expect(out.every(s => s.summarised === true)).toBe(true);
    expect(out[0].body.length).toBeLessThan(40);
  });
});

describe('parseAdjustReply', () => {
  it('parses fenced JSON', () => {
    const r = parseAdjustReply('```json\n{ "add": ["seg_1"], "evict": ["seg_2"], "reason": "x" }\n```');
    expect(r.add).toEqual(['seg_1']);
    expect(r.evict).toEqual(['seg_2']);
    expect(r.reason).toBe('x');
  });
  it('parses bare JSON', () => {
    const r = parseAdjustReply('{ "add": [], "evict": [] }');
    expect(r.add).toEqual([]);
    expect(r.evict).toEqual([]);
  });
  it('returns null on garbage', () => {
    expect(parseAdjustReply('hello')).toBeNull();
    expect(parseAdjustReply('')).toBeNull();
  });
  it('coerces missing arrays', () => {
    const r = parseAdjustReply('{}');
    expect(r.add).toEqual([]);
    expect(r.evict).toEqual([]);
  });
  it('drops non-string ids', () => {
    const r = parseAdjustReply('{"add":["seg_1", 123, null], "evict":[]}');
    expect(r.add).toEqual(['seg_1']);
  });
});

describe('applyAdjustment', () => {
  function setupAms() {
    const ams = new ActiveMemorySet({ budget: computeBudget(200_000) });
    return ams;
  }

  it('adds visible+non-onDemand ids; evicts onDemand ids', () => {
    const a = makeSegment({ scope: 'user', kind: 'fact', body: 'A' });
    const b = makeSegment({ scope: 'user', kind: 'fact', body: 'B' });
    const c = makeSegment({ scope: 'user', kind: 'fact', body: 'C' });
    idx.upsert(a); idx.upsert(b); idx.upsert(c);
    const ams = setupAms();
    ams.setOnDemand([a]);

    const r = applyAdjustment({
      ams, index: idx,
      decision: { add: [b.id, c.id], evict: [a.id] },
      visibleIds: new Set([a.id, b.id, c.id]),
    });
    expect(r.added).toBe(2);
    expect(r.evicted).toBe(1);
    expect(ams.onDemandIds().sort()).toEqual([b.id, c.id].sort());
  });

  it('rejects add ids not in visible set', () => {
    const a = makeSegment({ scope: 'user', kind: 'fact', body: 'A' });
    idx.upsert(a);
    const ams = setupAms();
    const r = applyAdjustment({
      ams, index: idx,
      decision: { add: ['seg_unknown'], evict: [] },
      visibleIds: new Set([a.id]),
    });
    expect(r.added).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it('rejects evict ids not currently in onDemand', () => {
    const a = makeSegment({ scope: 'user', kind: 'fact', body: 'A' });
    idx.upsert(a);
    const ams = setupAms();
    ams.setOnDemand([]);   // a not in onDemand
    const r = applyAdjustment({
      ams, index: idx,
      decision: { add: [], evict: [a.id] },
      visibleIds: new Set([a.id]),
    });
    expect(r.evicted).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it('caps add and evict at maxAdd / maxEvict', () => {
    const segs = Array.from({ length: 100 }, (_, i) =>
      makeSegment({ scope: 'user', kind: 'fact', body: `body ${i}` }));
    for (const s of segs) idx.upsert(s);
    const ams = setupAms();
    ams.setOnDemand(segs.slice(0, 50));
    const r = applyAdjustment({
      ams, index: idx,
      decision: {
        add: segs.slice(50).map(s => s.id),
        evict: segs.slice(0, 50).map(s => s.id),
      },
      visibleIds: new Set(segs.map(s => s.id)),
      maxAdd: 5, maxEvict: 5,
    });
    expect(r.added).toBeLessThanOrEqual(5);
    expect(r.evicted).toBeLessThanOrEqual(5);
  });
});

describe('runAdjust', () => {
  it('skips when trigger says no', async () => {
    const ams = new ActiveMemorySet({ budget: computeBudget(200_000) });
    const r = await runAdjust({
      trigger: {
        newMemoryWritten: false, onDemandSize: 0,
        turnTokenUsage: 0, totalBudget: 100,
        adjustRanThisSession: true,
      },
      ams, index: idx,
      scopes: ['user'], ownVpId: null,
      userMsg: 'x', assistantReply: 'y',
      runLLM: async () => '{"add":[],"evict":[]}',
    });
    expect(r.ran).toBe(false);
  });

  it('full round-trip: trigger → prompt → LLM → apply', async () => {
    const a = makeSegment({ scope: 'user', kind: 'fact', body: 'A' });
    const b = makeSegment({ scope: 'user', kind: 'fact', body: 'B' });
    idx.upsert(a); idx.upsert(b);

    const ams = new ActiveMemorySet({ budget: computeBudget(200_000) });
    ams.setOnDemand([a]);

    let receivedPrompt = '';
    const r = await runAdjust({
      trigger: {
        newMemoryWritten: false, onDemandSize: 0,
        turnTokenUsage: 0, totalBudget: 100,
        adjustRanThisSession: false,
      },
      ams, index: idx, scopes: ['user'], ownVpId: null,
      userMsg: 'jwt question', assistantReply: 'jwt answer',
      runLLM: async (p) => {
        receivedPrompt = p;
        return JSON.stringify({ add: [b.id], evict: [a.id], reason: 'swap' });
      },
    });

    expect(r.ran).toBe(true);
    expect(r.added).toBe(1);
    expect(r.evicted).toBe(1);
    expect(ams.onDemandIds()).toEqual([b.id]);
    expect(receivedPrompt).toContain(a.id);
    expect(receivedPrompt).toContain(b.id);
  });

  it('handles parse failure gracefully', async () => {
    const a = makeSegment({ scope: 'user', kind: 'fact', body: 'A' });
    idx.upsert(a);
    const ams = new ActiveMemorySet({ budget: computeBudget(200_000) });
    ams.setOnDemand([a]);
    const r = await runAdjust({
      trigger: {
        newMemoryWritten: false, onDemandSize: 0,
        turnTokenUsage: 0, totalBudget: 100,
        adjustRanThisSession: false,
      },
      ams, index: idx, scopes: ['user'], ownVpId: null,
      userMsg: 'q', assistantReply: 'a',
      runLLM: async () => 'not json at all',
    });
    expect(r.ran).toBe(true);
    expect(r.reason).toContain('parse-fail');
    expect(r.added).toBe(0);
    expect(r.evicted).toBe(0);
  });
});

describe('buildAdjustPrompt', () => {
  it('includes user/assistant/visible ids', () => {
    const p = buildAdjustPrompt({
      userMsg: 'Q', assistantReply: 'A',
      residentScopes: ['user'], recentIds: ['seg_r1'],
      onDemandIds: ['seg_o1'],
      visibleSegments: [
        { id: 'seg_v1', scope: 'user', kind: 'fact', tags: ['t'], body: 'b1', inAMS: false },
      ],
    });
    expect(p).toContain('Q');
    expect(p).toContain('A');
    expect(p).toContain('seg_v1');
    expect(p).toContain('JSON');
  });
});
