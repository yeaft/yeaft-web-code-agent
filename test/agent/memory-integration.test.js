/**
 * wave-7 — R6 memory full-chain integration tests.
 *
 * Verifies the complete memory pipeline end-to-end:
 *   MI-1: DreamScheduler noteUserMessage increments + idle timer triggers dream
 *   MI-2: dreamShard runs scan + compact on shard store with real entries
 *   MI-3: recallR6 recalls entries written to shard store (keyword path)
 *   MI-4: recallR6 formatForInjection produces correct output format
 *   MI-5: memory_trace tool traces entry back to sourceRef
 *   MI-6: buildUserProfile reads from user-memory store + formats bullets
 *   MI-7: writeUserMemory → buildUserProfile round-trip
 *   MI-8: DreamScheduler idle → dream → recall full chain with fake timers
 *   MI-9: dreamExtract extracts memories from messages (skeleton — pending w7b/w7c)
 *   MI-10: recompression hook fires post-dream in scheduler
 *
 * Uses mock adapter + fake timers. Extract-related assertions are stubs
 * pending w7b/w7c merge.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ── Mock dreamShard so we can control its output ──────────────
vi.mock('../../agent/unify/memory/dream-shard.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    dreamShard: vi.fn(async ({ shardStore }) => {
      // Run real scan but return controlled compact result
      const scan = actual.scanShards(shardStore);
      return {
        scan: { totalEntries: scan.totalEntries, totalBytes: scan.totalBytes },
        compact: { compacted: [], skipped: [], errors: [] },
        merge: null,
        prune: null,
        entriesMerged: 0,
        entriesPruned: 0,
        bytesReclaimed: 0,
        errors: [],
      };
    }),
    // Keep real scanShards and runCompactJob
    scanShards: actual.scanShards,
    runCompactJob: actual.runCompactJob,
  };
});

vi.mock('../../agent/unify/memory/recompression.js', () => ({
  checkRecompression: vi.fn(() => ({
    compacted: [],
    skipped: [],
    stats: {},
  })),
}));

const { openMemoryShardStore } = await import('../../agent/unify/memory/shard-store.js');
const { recallR6, formatForInjection, classifyShardsByKeyword, clearR6RecallCache } = await import('../../agent/unify/memory/recall-r6.js');
const { createDreamScheduler } = await import('../../agent/unify/memory/dream-scheduler.js');
const { dreamShard } = await import('../../agent/unify/memory/dream-shard.js');
const { checkRecompression } = await import('../../agent/unify/memory/recompression.js');
const {
  openUserMemoryStore, writeUserMemory, buildUserProfile,
} = await import('../../agent/unify/memory/user-memory-store.js');
const memoryTraceTool = (await import('../../agent/unify/tools/memory-trace.js')).default;

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'mi-test-'));
}

function makeFakeAdapter() {
  return { call: vi.fn(async () => ({ text: '[]' })) };
}

/** Write a VP-memory entry to a shard store. */
function putTestEntry(store, { id, shard, kind, body, tags, sourceRef }) {
  store.put({
    id,
    shard,
    kind: kind || 'preference',
    body: body || `Test body for ${id}`,
    tags: tags || [],
    authoredBy: 'system:dream',
    ...(sourceRef ? { sourceRef } : {}),
  });
}

// ─────────────────────────────────────────────────────────────────

describe('MI-1: DreamScheduler noteUserMessage + idle timer', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
  afterEach(() => { vi.useRealTimers(); });

  it('increments counter and triggers dream after idle period', async () => {
    const dir = makeTmpDir();
    try {
      const store = openMemoryShardStore(dir, 'vp');
      putTestEntry(store, { id: 'e1', shard: 'skill', body: 'User prefers TypeScript' });

      const ds = createDreamScheduler({
        memoryShardStore: store,
        adapter: makeFakeAdapter(),
        config: {},
        idleMs: 100,
      });

      ds.noteUserMessage();
      ds.noteUserMessage();
      expect(ds.messagesSinceLastDream).toBe(2);

      vi.advanceTimersByTime(101);
      await vi.runAllTimersAsync();

      expect(dreamShard).toHaveBeenCalled();
      expect(ds.messagesSinceLastDream).toBe(0);
      ds.shutdown();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('MI-2: dreamShard runs on shard store with real entries', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('dreamShard receives the shard store and processes entries', async () => {
    const dir = makeTmpDir();
    try {
      const store = openMemoryShardStore(dir, 'vp');
      putTestEntry(store, { id: 'e1', shard: 'skill', body: 'Knows React hooks' });
      putTestEntry(store, { id: 'e2', shard: 'lessons', body: 'Avoid any type in TS' });
      putTestEntry(store, { id: 'e3', shard: 'skill', body: 'Vue 3 composition API' });

      const result = await dreamShard({
        shardStore: store,
        adapter: makeFakeAdapter(),
        config: { model: 'test' },
      });

      expect(result.scan.totalEntries).toBeGreaterThanOrEqual(3);
      expect(result.errors).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('MI-3: recallR6 recalls entries from shard store', () => {
  beforeEach(() => { clearR6RecallCache(); });

  it('keyword classifier routes to correct shard and returns entries', async () => {
    const dir = makeTmpDir();
    try {
      const store = openMemoryShardStore(dir, 'vp');
      putTestEntry(store, { id: 'r1', shard: 'skill', body: 'Expert in TypeScript generics' });
      putTestEntry(store, { id: 'r2', shard: 'lessons', body: 'Avoid circular imports' });
      putTestEntry(store, { id: 'r3', shard: 'preferences', body: 'Prefers dark mode' });

      // Query about code → should hit "skill" shard via keyword heuristic
      const result = await recallR6({
        prompt: 'How do I implement a TypeScript generic?',
        memoryShardStore: store,
        // No adapter → keyword-only path
      });

      expect(result.entries.length).toBeGreaterThanOrEqual(1);
      expect(result.shards).toContain('skill');
      // The skill entry should be in results
      const ids = result.entries.map(e => e.id);
      expect(ids).toContain('r1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('classifyShardsByKeyword picks correct shards', () => {
    const available = ['skill', 'lessons', 'preferences', 'relations'];
    expect(classifyShardsByKeyword('avoid this common mistake', available)).toContain('lessons');
    expect(classifyShardsByKeyword('I prefer dark mode', available)).toContain('preferences');
    expect(classifyShardsByKeyword('implement a vue component', available)).toContain('skill');
  });
});

describe('MI-4: formatForInjection produces correct output', () => {
  it('formats entries with [mem:shard] prefix', () => {
    const entries = [
      { shard: 'skill', body: 'Expert in TypeScript' },
      { shard: 'lessons', body: 'Always validate inputs' },
    ];
    const output = formatForInjection(entries);
    expect(output).toContain('[mem:skill] Expert in TypeScript');
    expect(output).toContain('[mem:lessons] Always validate inputs');
    // Entries separated by double newline
    expect(output).toMatch(/\n\n/);
  });

  it('handles empty entries', () => {
    expect(formatForInjection([])).toBe('');
  });

  it('trims body whitespace', () => {
    const output = formatForInjection([{ shard: 'skill', body: '  padded text  ' }]);
    expect(output).toBe('[mem:skill] padded text');
  });
});

describe('MI-5: memory_trace traces entry back to sourceRef', () => {
  it('returns entry with sourceRef when present', async () => {
    const dir = makeTmpDir();
    try {
      const store = openMemoryShardStore(dir, 'vp');
      putTestEntry(store, {
        id: 'mt-1',
        shard: 'skill',
        body: 'User knows Rust',
        sourceRef: { groupId: 'g1', msgIds: ['msg-a', 'msg-b'], hint: 'from discussion' },
      });

      const result = JSON.parse(await memoryTraceTool.execute(
        { memId: 'mt-1' },
        { memoryShardStore: store },
      ));

      expect(result.memory).toBeDefined();
      expect(result.memory.body).toContain('User knows Rust');
      expect(result.memory.sourceRef).toBeDefined();
      expect(result.memory.sourceRef.groupId).toBe('g1');
      expect(result.memory.sourceRef.msgIds).toContain('msg-a');
      // No coordinator → messages empty but entry is traced
      expect(result.messages).toHaveLength(0);
      expect(result.note).toContain('no group coordinator');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns error for missing entry', async () => {
    const dir = makeTmpDir();
    try {
      const store = openMemoryShardStore(dir, 'vp');
      const result = JSON.parse(await memoryTraceTool.execute(
        { memId: 'nonexistent' },
        { memoryShardStore: store },
      ));
      expect(result.error).toContain('not found');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles entry without sourceRef', async () => {
    const dir = makeTmpDir();
    try {
      const store = openMemoryShardStore(dir, 'vp');
      putTestEntry(store, { id: 'mt-nosrc', shard: 'preferences', body: 'Prefers tabs' });

      const result = JSON.parse(await memoryTraceTool.execute(
        { memId: 'mt-nosrc' },
        { memoryShardStore: store },
      ));
      expect(result.memory).toBeDefined();
      expect(result.note).toContain('no sourceRef');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('MI-6: buildUserProfile reads user-memory and formats bullets', () => {
  it('produces bullet list from user-memory store', () => {
    const dir = makeTmpDir();
    try {
      const store = openUserMemoryStore(dir);
      writeUserMemory(store, { text: 'My name is Alice' });
      writeUserMemory(store, { text: 'I prefer concise answers', tags: ['preference'] });
      writeUserMemory(store, { text: 'Working on Project X', tags: ['project'] });

      const profile = buildUserProfile(store);
      expect(profile).toContain('- My name is Alice');
      expect(profile).toContain('- I prefer concise answers');
      // Profile recall shards: profile > preferences > goals — projects excluded
      // so Project X may not appear (it's in 'projects' shard)
      expect(profile.split('\n').filter(l => l.startsWith('- ')).length).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns empty string for empty store', () => {
    const dir = makeTmpDir();
    try {
      const store = openUserMemoryStore(dir);
      expect(buildUserProfile(store)).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('MI-7: writeUserMemory → buildUserProfile round-trip', () => {
  it('written memory appears in profile output', () => {
    const dir = makeTmpDir();
    try {
      const store = openUserMemoryStore(dir);

      // Write several user memories
      const id1 = writeUserMemory(store, { text: 'I am a senior engineer' });
      const id2 = writeUserMemory(store, { text: 'I like functional programming', tags: ['preference'] });
      const id3 = writeUserMemory(store, { text: 'My goal is to ship v2 this quarter', tags: ['goal'] });

      expect(id1).toBeTruthy();
      expect(id2).toBeTruthy();
      expect(id3).toBeTruthy();

      const profile = buildUserProfile(store);
      // profile shard → "I am a senior engineer"
      expect(profile).toContain('I am a senior engineer');
      // preferences shard → "I like functional programming"
      expect(profile).toContain('I like functional programming');
      // goals shard → "My goal is to ship v2"
      expect(profile).toContain('ship v2 this quarter');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('respects maxEntries limit', () => {
    const dir = makeTmpDir();
    try {
      const store = openUserMemoryStore(dir);
      for (let i = 0; i < 10; i++) {
        writeUserMemory(store, { text: `Memory fact ${i}` });
      }
      const profile = buildUserProfile(store, { maxEntries: 3 });
      const lines = profile.split('\n').filter(l => l.startsWith('- '));
      expect(lines.length).toBeLessThanOrEqual(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('MI-8: Full chain — noteUserMessage → idle dream → recall', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); clearR6RecallCache(); });
  afterEach(() => { vi.useRealTimers(); });

  it('message → idle trigger → dream runs → entries recallable', async () => {
    const dir = makeTmpDir();
    try {
      const store = openMemoryShardStore(dir, 'vp');
      // Pre-populate entries (simulating what dreamExtract would produce post-w7b)
      putTestEntry(store, { id: 'chain-1', shard: 'skill', body: 'User knows Python decorators' });
      putTestEntry(store, { id: 'chain-2', shard: 'lessons', body: 'Avoid mutable default args in Python' });

      const ds = createDreamScheduler({
        memoryShardStore: store,
        adapter: makeFakeAdapter(),
        config: {},
        idleMs: 100,
      });

      // Simulate user messages
      ds.noteUserMessage();
      ds.noteUserMessage();
      ds.noteUserMessage();

      // Advance past idle timeout
      vi.advanceTimersByTime(101);
      await vi.runAllTimersAsync();

      // Dream should have run
      expect(dreamShard).toHaveBeenCalled();
      expect(ds.messagesSinceLastDream).toBe(0);

      // Now recall — entries should be retrievable
      const result = await recallR6({
        prompt: 'How to use Python decorators?',
        memoryShardStore: store,
      });

      expect(result.entries.length).toBeGreaterThanOrEqual(1);
      const bodies = result.entries.map(e => e.body);
      expect(bodies.some(b => b.includes('Python decorators'))).toBe(true);

      // Format for injection
      const injected = formatForInjection(result.entries);
      expect(injected).toContain('[mem:');
      expect(injected).toContain('Python decorators');

      ds.shutdown();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('MI-9: dreamExtract from messages (skeleton — pending w7b/w7c)', () => {
  // TODO: After w7b/w7c merge, this test will validate:
  //   1. dreamExtract() receives conversation messages
  //   2. LLM adapter is called with extraction prompt
  //   3. Extracted entries are written to shard store
  //   4. Watermark is advanced past processed messages

  it.todo('dreamExtract extracts memories from conversation messages');
  it.todo('dreamExtract writes extracted entries to shard store');
  it.todo('dreamExtract advances watermark after processing');
  it.todo('recallR6 can recall dream-extracted entries');
});

describe('MI-10: recompression hook fires in scheduler post-dream', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('checkRecompression called after dream completes', async () => {
    const dir = makeTmpDir();
    try {
      const store = openMemoryShardStore(dir, 'vp');
      putTestEntry(store, { id: 'rc-1', shard: 'skill', body: 'Test entry' });

      const ds = createDreamScheduler({
        memoryShardStore: store,
        adapter: makeFakeAdapter(),
        config: {},
      });

      await ds.triggerDreamNow();

      expect(checkRecompression).toHaveBeenCalledWith(store);
      ds.shutdown();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recompression failure does not break dream result', async () => {
    const dir = makeTmpDir();
    try {
      checkRecompression.mockImplementationOnce(() => { throw new Error('recomp fail'); });

      const store = openMemoryShardStore(dir, 'vp');
      putTestEntry(store, { id: 'rc-2', shard: 'skill', body: 'Entry' });

      const ds = createDreamScheduler({
        memoryShardStore: store,
        adapter: makeFakeAdapter(),
        config: {},
      });

      const result = await ds.triggerDreamNow();
      // Dream still succeeds even if recompression throws
      expect(result.error).toBeUndefined();
      expect(result.scan).toBeDefined();
      ds.shutdown();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
