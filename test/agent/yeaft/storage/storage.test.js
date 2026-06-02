import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  writeAtomic, sweepTmp, isTmpPath,
  openLog,
  loadIndex, saveIndex,
  openShardStore,
  loadShardIndex,
  START_MARK, END_MARK,
  runCompact,
} from '../../../../agent/yeaft/storage/index.js';

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), '334o-')); });
afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch {} });

// ─── atomic.js ───────────────────────────────────────────────

describe('atomic.writeAtomic', () => {
  it('writes payload to target path', () => {
    const p = join(root, 'foo.json');
    writeAtomic(p, '{"a":1}');
    expect(readFileSync(p, 'utf8')).toBe('{"a":1}');
  });

  it('does not leave tmp sidecar on success', () => {
    const p = join(root, 'foo.json');
    writeAtomic(p, 'hello');
    const leftover = readdirSync(root).filter((n) => /\.tmp\./.test(n));
    expect(leftover).toEqual([]);
  });

  it('overwrites existing file atomically — crash half-way leaves old content', () => {
    // Simulate crash-halfway: we write a tmp sidecar ourselves but never
    // rename it. The original file must still be readable & intact.
    const p = join(root, 'foo.json');
    writeAtomic(p, 'v1');
    writeFileSync(`${p}.tmp.99999.1`, 'v2-TRUNCATED'); // orphan tmp
    expect(readFileSync(p, 'utf8')).toBe('v1');
    // Boot cleanup should sweep it.
    const swept = sweepTmp(root);
    expect(swept).toBeGreaterThanOrEqual(1);
  });

  it('isTmpPath recognises sidecar shape only', () => {
    expect(isTmpPath('/x/foo.json.tmp.123.1')).toBe(true);
    expect(isTmpPath('/x/user.tmp')).toBe(false);
  });
});

// ─── jsonl-log.js ────────────────────────────────────────────

describe('jsonl-log', () => {
  it('roundtrips append → streamAll', () => {
    const log = openLog(root);
    log.append({ id: 'msg_001', ts: '2026-04-19T10:00:00Z', body: 'a' });
    log.append({ id: 'msg_002', ts: '2026-04-19T10:00:01Z', body: 'b' });
    log.close();

    const reopened = openLog(root);
    const all = Array.from(reopened.streamAll());
    expect(all).toHaveLength(2);
    expect(all[0].id).toBe('msg_001');
    expect(all[1].body).toBe('b');
  });

  it('rotates at maxSegmentLines', () => {
    const log = openLog(root, { maxSegmentLines: 3, maxSegmentBytes: 10_000_000 });
    for (let i = 1; i <= 7; i++) {
      log.append({ id: `msg_${String(i).padStart(3, '0')}`, ts: `t${i}`, body: 'x' });
    }
    log.close();
    const idx = loadIndex(root);
    expect(idx.segments.length).toBeGreaterThanOrEqual(3);
    const totalCount = idx.segments.reduce((s, seg) => s + seg.count, 0);
    expect(totalCount).toBe(7);
  });

  it('rotates at maxSegmentBytes', () => {
    const log = openLog(root, { maxSegmentBytes: 200, maxSegmentLines: 100_000 });
    const payload = 'x'.repeat(50);
    for (let i = 1; i <= 10; i++) {
      log.append({ id: `msg_${String(i).padStart(3, '0')}`, ts: `t${i}`, body: payload });
    }
    log.close();
    const idx = loadIndex(root);
    expect(idx.segments.length).toBeGreaterThanOrEqual(2);
  });

  it('readRange filters by id range', () => {
    const log = openLog(root, { maxSegmentLines: 2 });
    for (let i = 1; i <= 6; i++) {
      log.append({ id: `msg_${String(i).padStart(3, '0')}`, ts: `t${i}`, body: 'x' });
    }
    log.close();
    const log2 = openLog(root);
    const got = Array.from(log2.readRange('msg_002', 'msg_004')).map((o) => o.id);
    expect(got).toEqual(['msg_002', 'msg_003', 'msg_004']);
  });

  it('rebuilds index.json when it is missing', () => {
    const log = openLog(root, { maxSegmentLines: 2 });
    for (let i = 1; i <= 5; i++) log.append({ id: `msg_${i}`, ts: `t${i}`, body: 'x' });
    log.close();

    // Wipe the index.
    rmSync(join(root, 'index.json'));
    // Reopen: must rebuild without crash.
    const log2 = openLog(root);
    const all = Array.from(log2.streamAll());
    expect(all).toHaveLength(5);
    expect(existsSync(join(root, 'index.json'))).toBe(true);
  });

  it('rebuilds index.json when it is corrupt', () => {
    const log = openLog(root);
    log.append({ id: 'msg_1', ts: 't1', body: 'a' });
    log.append({ id: 'msg_2', ts: 't2', body: 'b' });
    log.close();
    writeFileSync(join(root, 'index.json'), '{this is not json'); // corrupt
    const log2 = openLog(root);
    const all = Array.from(log2.streamAll());
    expect(all.map((o) => o.id)).toEqual(['msg_1', 'msg_2']);
  });

  it('meets <2ms average append target on local SSD', () => {
    // Acceptance #1 budget. We give headroom (5ms per op avg) because CI is
    // noisy; the point is to assert the hot path doesn't regress into seconds.
    const log = openLog(root);
    const N = 200;
    const start = process.hrtime.bigint();
    for (let i = 0; i < N; i++) {
      log.append({ id: `msg_${i}`, ts: `t${i}`, body: 'benchmark-line' });
    }
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    log.close();
    expect(elapsedMs / N).toBeLessThan(5);
  });
});

// ─── shard-store.js ──────────────────────────────────────────

const MEM_SCHEMA = {
  shards: ['skill', 'lessons', 'preferences'],
  softCap: {
    skill: { entries: 3, bytes: 10 * 1024 },
    lessons: { entries: 80, bytes: 64 * 1024 },
  },
  defaultSoftCap: { entries: 150, bytes: 128 * 1024 },
};

describe('shard-store', () => {
  it('put → get roundtrip', () => {
    const store = openShardStore(root, MEM_SCHEMA);
    store.put({ id: 'mem_1', shard: 'skill', body: 'ts generics notes',
      meta: { kind: 'skill', tags: ['ts'] } });
    const got = store.get('mem_1');
    expect(got.body).toBe('ts generics notes');
    expect(got.shard).toBe('skill');
    expect(got.meta.kind).toBe('skill');
  });

  it('query filters by shard, kind, tags, pinned', () => {
    const s = openShardStore(root, MEM_SCHEMA);
    s.put({ id: 'mem_1', shard: 'skill', body: 'a', meta: { kind: 'skill', tags: ['ts'] }});
    s.put({ id: 'mem_2', shard: 'skill', body: 'b', meta: { kind: 'skill', tags: ['ts', 'generics'], pinned: true }});
    s.put({ id: 'mem_3', shard: 'lessons', body: 'c', meta: { kind: 'lesson', tags: ['auth'] }});

    expect(s.query({ shard: 'skill' }).results).toHaveLength(2);
    expect(s.query({ tags: ['ts', 'generics'] }).results.map((r) => r.id)).toEqual(['mem_2']);
    expect(s.query({ pinned: true }).results.map((r) => r.id)).toEqual(['mem_2']);
    expect(s.query({ kind: 'lesson' }).results.map((r) => r.id)).toEqual(['mem_3']);
  });

  it('remove deletes the entry and its slot in the file', () => {
    const s = openShardStore(root, MEM_SCHEMA);
    s.put({ id: 'mem_1', shard: 'skill', body: 'a', meta: {} });
    s.put({ id: 'mem_2', shard: 'skill', body: 'b', meta: {} });
    expect(s.remove('mem_1')).toBe(true);
    expect(s.get('mem_1')).toBeNull();
    expect(s.get('mem_2').body).toBe('b');

    const file = readFileSync(join(root, 'memory-skill.md'), 'utf8');
    expect(file).not.toContain(START_MARK('mem_1'));
    expect(file).toContain(START_MARK('mem_2'));
    expect(file).toContain(END_MARK('mem_2'));
  });

  it('compact on all shards is a no-op content-wise', () => {
    const s = openShardStore(root, MEM_SCHEMA);
    s.put({ id: 'mem_1', shard: 'skill', body: 'alpha', meta: {} });
    s.put({ id: 'mem_2', shard: 'skill', body: 'beta', meta: {} });
    s.compact();
    expect(s.get('mem_1').body).toBe('alpha');
    expect(s.get('mem_2').body).toBe('beta');
  });

  it('query surfaces needsRecompression for shards over softCap', () => {
    const s = openShardStore(root, MEM_SCHEMA);
    for (let i = 0; i < 4; i++) {
      s.put({ id: `mem_${i}`, shard: 'skill', body: `x${i}`, meta: {} });
    }
    const r = s.query({ shard: 'skill' });
    expect(r.needsRecompression).toContain('skill');
    // Soft cap does NOT auto-compact — all entries still readable.
    for (let i = 0; i < 4; i++) expect(s.get(`mem_${i}`)).not.toBeNull();
  });

  it('put returns needsRecompression flag when shard over cap', () => {
    const s = openShardStore(root, MEM_SCHEMA);
    for (let i = 0; i < 3; i++) s.put({ id: `mem_${i}`, shard: 'skill', body: 'x', meta: {} });
    const res = s.put({ id: 'mem_over', shard: 'skill', body: 'x', meta: {} });
    expect(res.needsRecompression).toBe(true);
  });

  it('rejects unknown shard', () => {
    const s = openShardStore(root, MEM_SCHEMA);
    expect(() => s.put({ id: 'x', shard: 'bogus', body: '' })).toThrow(/bogus/);
  });

  it('rejects bad entry id shape', () => {
    const s = openShardStore(root, MEM_SCHEMA);
    expect(() => s.put({ id: 'has spaces', shard: 'skill', body: '' })).toThrow(/id/);
  });

  it('rebuilds shard-index from shard files when index.json is missing', () => {
    const s1 = openShardStore(root, MEM_SCHEMA);
    s1.put({ id: 'mem_1', shard: 'skill', body: 'alpha', meta: { kind: 'skill' } });
    s1.put({ id: 'mem_2', shard: 'lessons', body: 'beta', meta: { kind: 'lesson' } });

    rmSync(join(root, 'index.json'));
    const s2 = openShardStore(root, MEM_SCHEMA);
    const ids = s2.query({}).results.map((r) => r.id).sort();
    expect(ids).toEqual(['mem_1', 'mem_2']);
    // Meta was lost in rebuild (expected — caller re-hydrates through setMeta)
    // but body is intact via get().
    expect(s2.get('mem_1').body).toBe('alpha');
    expect(s2.get('mem_2').body).toBe('beta');
  });

  it('rebuilds shard-index from shard files when index.json is corrupt', () => {
    const s1 = openShardStore(root, MEM_SCHEMA);
    s1.put({ id: 'mem_1', shard: 'skill', body: 'alpha', meta: {} });
    writeFileSync(join(root, 'index.json'), '{corrupt'); // not JSON
    const s2 = openShardStore(root, MEM_SCHEMA);
    expect(s2.get('mem_1').body).toBe('alpha');
  });

  it('crash-halfway during shard-index rewrite leaves previous index readable', () => {
    // Simulate a crash where the tmp file for a new index.json was written
    // but never renamed. The existing index.json must still be intact.
    const s = openShardStore(root, MEM_SCHEMA);
    s.put({ id: 'mem_1', shard: 'skill', body: 'alpha', meta: {} });
    const indexPath = join(root, 'index.json');
    const before = readFileSync(indexPath, 'utf8');
    writeFileSync(`${indexPath}.tmp.99999.1`, '{partial');
    const after = readFileSync(indexPath, 'utf8');
    expect(after).toBe(before);
    // After sweep, the orphan is gone and the index is still valid.
    sweepTmp(root);
    const s2 = openShardStore(root, MEM_SCHEMA);
    expect(s2.get('mem_1').body).toBe('alpha');
  });

  it('setMeta re-hydrates meta after rebuild', () => {
    const s1 = openShardStore(root, MEM_SCHEMA);
    s1.put({ id: 'mem_1', shard: 'skill', body: 'x', meta: { kind: 'skill', tags: ['a'] } });
    rmSync(join(root, 'index.json'));
    const s2 = openShardStore(root, MEM_SCHEMA);
    s2.setMeta('mem_1', { kind: 'skill', tags: ['a'] });
    expect(s2.query({ tags: ['a'] }).results.map((r) => r.id)).toEqual(['mem_1']);
  });

  it('put upserts (same id replaces prior body)', () => {
    const s = openShardStore(root, MEM_SCHEMA);
    s.put({ id: 'mem_1', shard: 'skill', body: 'v1', meta: {} });
    s.put({ id: 'mem_1', shard: 'skill', body: 'v2', meta: {} });
    expect(s.get('mem_1').body).toBe('v2');
    expect(s.query({ shard: 'skill' }).results).toHaveLength(1);
  });

  it('has no knowledge of VP/task/message — schema-only abstraction', () => {
    // Acceptance #6: schema-agnostic. We open the store with an entirely
    // foreign schema (not even memory shards) and it still works.
    const s = openShardStore(root, {
      shards: ['foo', 'bar'],
      defaultSoftCap: { entries: 10, bytes: 1024 },
    });
    s.put({ id: 'x_1', shard: 'foo', body: '<html>?', meta: { any: 'field' } });
    expect(s.get('x_1').body).toBe('<html>?');
  });
});

// ─── compact.js (runCompact for dream) ───────────────────────

describe('runCompact', () => {
  it('defrags over-cap shards and reports', async () => {
    const store = openShardStore(root, MEM_SCHEMA);
    for (let i = 0; i < 5; i++) store.put({ id: `mem_${i}`, shard: 'skill', body: 'x', meta: {} });
    const res = await runCompact({ dir: root, schema: MEM_SCHEMA });
    expect(res.compacted).toContain('skill');
  });

  it('honours deleteIds hitlist', async () => {
    const store = openShardStore(root, MEM_SCHEMA);
    store.put({ id: 'mem_1', shard: 'skill', body: 'keep', meta: {} });
    store.put({ id: 'mem_2', shard: 'skill', body: 'drop', meta: {} });
    const res = await runCompact({ dir: root, schema: MEM_SCHEMA, deleteIds: ['mem_2'] });
    expect(res.deleted).toEqual(['mem_2']);
    const s2 = openShardStore(root, MEM_SCHEMA);
    expect(s2.get('mem_2')).toBeNull();
    expect(s2.get('mem_1').body).toBe('keep');
  });

  it('is a no-op when every shard is under cap', async () => {
    const store = openShardStore(root, MEM_SCHEMA);
    store.put({ id: 'mem_1', shard: 'lessons', body: 'x', meta: {} });
    const res = await runCompact({ dir: root, schema: MEM_SCHEMA });
    expect(res.compacted).toEqual([]);
    expect(res.deleted).toEqual([]);
  });

  it('throws when dir is missing', async () => {
    await expect(runCompact({})).rejects.toThrow(/dir required/);
  });
});

// ─── integration: crash resilience ───────────────────────────

describe('crash resilience', () => {
  it('sweepTmp cleans orphan tmp files from both log dir and shard dir', () => {
    writeFileSync(join(root, 'index.json.tmp.1.1'), 'orphan');
    writeFileSync(join(root, '000001.jsonl.tmp.1.2'), 'orphan');
    expect(sweepTmp(root)).toBe(2);
  });

  it('jsonl-log survives corrupt last line (partial append before crash)', () => {
    const log = openLog(root);
    log.append({ id: 'msg_1', ts: 't1', body: 'good' });
    log.close();
    // Simulate torn write: append a partial JSON line.
    const seg = join(root, '000001.jsonl');
    const txt = readFileSync(seg, 'utf8');
    writeFileSync(seg, txt + '{"id":"msg_2","ts":"t2","bod'); // no newline, no closing brace

    const log2 = openLog(root);
    const all = Array.from(log2.streamAll());
    // Only the valid line survives; the garbled one is dropped silently.
    expect(all.map((o) => o.id)).toEqual(['msg_1']);
  });
});

// ─── jsonl-index direct API ──────────────────────────────────

describe('jsonl-index direct', () => {
  it('saveIndex + loadIndex roundtrip', () => {
    const idx = { version: 1, nextId: 5, segments: [
      { file: '000001.jsonl', firstId: 'a', lastId: 'c', firstTs: 't1', lastTs: 't3', count: 3, bytes: 42 },
    ]};
    saveIndex(root, idx);
    const got = loadIndex(root);
    expect(got.segments).toEqual(idx.segments);
    expect(got.nextId).toBe(5);
  });

  it('loadIndex returns null on missing or corrupt file', () => {
    expect(loadIndex(root)).toBeNull();
    writeFileSync(join(root, 'index.json'), 'not json');
    expect(loadIndex(root)).toBeNull();
  });
});

// ─── shard-index direct API ──────────────────────────────────

describe('shard-index direct', () => {
  it('loadShardIndex tolerates corrupt file', () => {
    writeFileSync(join(root, 'index.json'), '{broken');
    expect(loadShardIndex(root)).toBeNull();
  });
});
