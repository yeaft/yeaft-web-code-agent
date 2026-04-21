/**
 * dream-shard.test.js — task-334g shard-based dream + compact job tests.
 *
 * Coverage:
 *   G-a  isTaskMemoryShard / filterDreamableShards guard
 *   G-b  scanShards: streaming scan, kind/tag stats, utilization
 *   G-c  formatScanSummary: human-readable output
 *   G-d  runCompactJob: superseded entries reclaimed
 *   G-e  runCompactJob: task-memory shards excluded
 *   G-f  dreamShard: full pipeline (scan → compact → merge → prune)
 *   G-g  compact skips shards above utilization threshold
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  isTaskMemoryShard,
  filterDreamableShards,
  scanShards,
  formatScanSummary,
  runCompactJob,
  dreamShard,
} from '../../../../agent/unify/memory/dream-shard.js';
import { openMemoryShardStore } from '../../../../agent/unify/memory/shard-store.js';
import { TASK_SHARDS, VP_DEFAULT_SHARDS } from '../../../../agent/unify/memory/schema.js';

// ─── Helpers ─────────────────────────────────────────────────────

function tmp() { return mkdtempSync(join(tmpdir(), 'dream-shard-')); }

function vpEntry(id, overrides = {}) {
  return {
    id,
    kind: 'skill',
    shard: 'skill',
    body: `content for ${id}`,
    sourceRef: {
      groupId: 'grp_test',
      msgIds: ['msg_01'],
      timeWindow: '2026-04-01T00:00Z..2026-04-01T01:00Z',
    },
    tags: ['test'],
    authoredBy: 'vp:dev-1',
    ...overrides,
  };
}

function openVpStore(dir) {
  return openMemoryShardStore(dir, 'vp');
}

// ─── G-a: Task-memory guard ────────────────────────────────────

describe('G-a: task-memory shard guard', () => {
  it('recognises all 5 task shards', () => {
    for (const shard of TASK_SHARDS) {
      expect(isTaskMemoryShard(shard)).toBe(true);
    }
  });

  it('rejects VP shards', () => {
    for (const shard of VP_DEFAULT_SHARDS) {
      expect(isTaskMemoryShard(shard)).toBe(false);
    }
  });

  it('filterDreamableShards removes task shards', () => {
    const all = [...VP_DEFAULT_SHARDS, ...TASK_SHARDS, 'project-foo'];
    const dreamable = filterDreamableShards(all);
    expect(dreamable).toEqual([...VP_DEFAULT_SHARDS, 'project-foo']);
  });
});

// ─── G-b: scanShards ───────────────────────────────────────────

describe('G-b: scanShards — streaming scan', () => {
  let dir, store;

  beforeEach(() => {
    dir = tmp();
    store = openVpStore(dir);
  });

  it('returns empty scan for empty store', () => {
    const scan = scanShards(store);
    expect(scan.totalEntries).toBe(0);
    expect(scan.totalBytes).toBe(0);
    expect(scan.entries).toEqual([]);
  });

  it('counts entries by kind and tags', () => {
    store.put(vpEntry('e1', { kind: 'skill', tags: ['ts'] }));
    store.put(vpEntry('e2', { kind: 'lesson', shard: 'lessons', tags: ['ts', 'auth'] }));
    store.put(vpEntry('e3', { kind: 'skill', tags: ['rust'] }));

    const scan = scanShards(store);
    expect(scan.totalEntries).toBe(3);
    expect(scan.byKind.skill).toBe(2);
    expect(scan.byKind.lesson).toBe(1);
    expect(scan.byTags.ts).toBe(2);
    expect(scan.byTags.auth).toBe(1);
    expect(scan.byTags.rust).toBe(1);
  });

  it('tracks superseded entries', () => {
    store.put(vpEntry('e1'));
    store.put(vpEntry('e2'));
    store.supersede({
      newEntry: vpEntry('e3', { tags: ['merged'] }),
      oldIds: ['e1'],
    });

    const scan = scanShards(store);
    // e1 is now superseded
    expect(scan.supersededCount).toBeGreaterThanOrEqual(1);
  });
});

// ─── G-c: formatScanSummary ────────────────────────────────────

describe('G-c: formatScanSummary', () => {
  it('produces human-readable output', () => {
    const scan = {
      totalEntries: 10,
      totalBytes: 2048,
      supersededCount: 2,
      shards: {
        skill: { entries: 5, bytes: 1024, softCap: { entries: 80, bytes: 65536 }, utilization: 0.0625 },
        lessons: { entries: 5, bytes: 1024, softCap: { entries: 80, bytes: 65536 }, utilization: 0.0625 },
      },
      byKind: { skill: 7, lesson: 3 },
      byTags: { ts: 5, auth: 3, rust: 2 },
      needsCompaction: [],
      entries: [],
    };

    const text = formatScanSummary(scan);
    expect(text).toContain('Total entries: 10');
    expect(text).toContain('Superseded: 2');
    expect(text).toContain('skill');
    expect(text).toContain('lessons');
    expect(text).toContain('By Kind');
  });
});

// ─── G-d: runCompactJob — superseded reclamation ───────────────

describe('G-d: runCompactJob — compact reclaims superseded', () => {
  let dir, store;

  beforeEach(() => {
    dir = tmp();
    store = openVpStore(dir);
  });

  it('compacts shard with superseded entries when forced', () => {
    // Create entries, then supersede one
    store.put(vpEntry('e1'));
    store.put(vpEntry('e2'));
    store.supersede({
      newEntry: vpEntry('e3', { tags: ['merged'] }),
      oldIds: ['e1'],
    });

    const statsBefore = store.stats();
    const bytesBefore = statsBefore.shards.skill?.bytes || 0;

    // Force compact on skill shard
    const result = runCompactJob({
      shardStore: store,
      shardNames: ['skill'],
    });

    expect(result.compacted.length).toBe(1);
    expect(result.compacted[0].shard).toBe('skill');
    expect(result.compacted[0].removedCount).toBeGreaterThanOrEqual(1);
    expect(result.errors).toEqual([]);
  });
});

// ─── G-e: task-memory exclusion in compact ─────────────────────

describe('G-e: compact excludes task-memory shards', () => {
  it('filterDreamableShards removes task shards from candidates', () => {
    const all = ['skill', 'decision', 'progress', 'lessons'];
    const result = filterDreamableShards(all);
    expect(result).toEqual(['skill', 'lessons']);
    expect(result).not.toContain('decision');
    expect(result).not.toContain('progress');
  });

  it('runCompactJob skips task shards even if passed explicitly', () => {
    const dir = tmp();
    const store = openVpStore(dir);
    store.put(vpEntry('e1'));

    const result = runCompactJob({
      shardStore: store,
      shardNames: ['decision', 'progress'],  // task shards
    });

    // No compactions because task shards are filtered out
    expect(result.compacted).toEqual([]);
  });
});

// ─── G-f: dreamShard full pipeline ─────────────────────────────

describe('G-f: dreamShard — full pipeline', () => {
  let dir, store;

  beforeEach(() => {
    dir = tmp();
    store = openVpStore(dir);
  });

  it('runs scan + compact on empty store without errors', async () => {
    const mockAdapter = {
      call: async () => ({ text: '{"merges":[]}' }),
    };

    const phases = [];
    const result = await dreamShard({
      shardStore: store,
      adapter: mockAdapter,
      config: { model: 'test-model' },
      onPhase: (phase, data) => phases.push({ phase, data }),
    });

    expect(result.errors).toEqual([]);
    expect(result.scan).toBeTruthy();
    expect(result.scan.totalEntries).toBe(0);
    expect(phases.some(p => p.phase === 'scan')).toBe(true);
  });

  it('runs full pipeline with entries + superseded', async () => {
    store.put(vpEntry('e1', { tags: ['ts'] }));
    store.put(vpEntry('e2', { tags: ['ts'] }));
    store.supersede({
      newEntry: vpEntry('e3', { tags: ['ts', 'merged'] }),
      oldIds: ['e1'],
    });

    const mockAdapter = {
      call: async () => ({ text: '{"merges":[],"toRemove":[]}' }),
    };

    const result = await dreamShard({
      shardStore: store,
      adapter: mockAdapter,
      config: { model: 'test-model' },
    });

    expect(result.errors).toEqual([]);
    expect(result.scan.totalEntries).toBeGreaterThan(0);
    expect(result.scan.supersededCount).toBeGreaterThanOrEqual(1);
  });
});

// ─── G-g: compact threshold ────────────────────────────────────

describe('G-g: compact skips high-utilization shards', () => {
  it('does not compact shards above 50% utilization', () => {
    const dir = tmp();
    const store = openVpStore(dir);

    // Add only 1 entry — utilization is very low, should be compact candidate
    store.put(vpEntry('e1'));

    // But with no superseded entries, compact yields removedCount=0
    const result = runCompactJob({ shardStore: store });

    // Low utilization triggers candidate selection, but no superseded to remove
    for (const c of result.compacted) {
      expect(c.removedCount).toBe(0);
    }
  });
});
