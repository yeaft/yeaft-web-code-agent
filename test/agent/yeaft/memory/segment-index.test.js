/**
 * segment-index.test.js — H2.a SQLite + FTS5 segment index.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openSegmentIndex } from '../../../../agent/yeaft/memory/index-db.js';
import { makeSegment } from '../../../../agent/yeaft/memory/segment.js';
import {
  readScope, writeScope, listScopes,
} from '../../../../agent/yeaft/memory/segment-store.js';
import { syncAll, syncScope } from '../../../../agent/yeaft/memory/segment-sync.js';

let TEST_DIR;
let DB_PATH;

beforeEach(() => {
  TEST_DIR = mkdtempSync(join(tmpdir(), 'h2a-'));
  DB_PATH = join(TEST_DIR, 'index.db');
});

afterEach(() => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
});

describe('openSegmentIndex', () => {
  it('creates schema idempotently', () => {
    const a = openSegmentIndex(DB_PATH);
    a.close();
    const b = openSegmentIndex(DB_PATH);
    expect(b.count()).toBe(0);
    b.close();
  });

  it('upsert + get', () => {
    const idx = openSegmentIndex(DB_PATH);
    const s = makeSegment({ scope: 'user', kind: 'fact', body: 'sky is blue', tags: ['weather'] });
    idx.upsert(s);
    const got = idx.get(s.id);
    expect(got.body).toBe('sky is blue');
    expect(got.tags).toEqual(['weather']);
    expect(got.kind).toBe('fact');
    idx.close();
  });

  it('upsert overwrites on conflict', () => {
    const idx = openSegmentIndex(DB_PATH);
    const s1 = makeSegment({
      id: 'seg_fixed01', scope: 'user', kind: 'fact', body: 'v1',
    });
    idx.upsert(s1);
    const s2 = makeSegment({
      id: 'seg_fixed01', scope: 'user', kind: 'fact', body: 'v2',
      updatedAt: '2099-01-01T00:00:00.000Z',
    });
    idx.upsert(s2);
    expect(idx.get('seg_fixed01').body).toBe('v2');
    expect(idx.count()).toBe(1);
    idx.close();
  });

  it('listByScope returns only that scope', () => {
    const idx = openSegmentIndex(DB_PATH);
    idx.upsert(makeSegment({ scope: 'user', kind: 'fact', body: 'a' }));
    idx.upsert(makeSegment({ scope: 'user', kind: 'fact', body: 'b' }));
    idx.upsert(makeSegment({ scope: 'session/g1/vp/alice', kind: 'fact', body: 'c' }));
    expect(idx.listByScope('user')).toHaveLength(2);
    expect(idx.listByScope('session/g1/vp/alice')).toHaveLength(1);
    idx.close();
  });

  it('deleteScope removes all under scope', () => {
    const idx = openSegmentIndex(DB_PATH);
    idx.upsert(makeSegment({ scope: 'session/g1/topic/x', kind: 'fact', body: 'a' }));
    idx.upsert(makeSegment({ scope: 'session/g1/topic/x', kind: 'fact', body: 'b' }));
    idx.deleteScope('session/g1/topic/x');
    expect(idx.listByScope('session/g1/topic/x')).toHaveLength(0);
    idx.close();
  });

  it('search hits FTS body match', () => {
    const idx = openSegmentIndex(DB_PATH);
    idx.upsert(makeSegment({ scope: 'user', kind: 'fact', body: 'JWT token authentication' }));
    idx.upsert(makeSegment({ scope: 'user', kind: 'fact', body: 'unrelated note' }));
    const hits = idx.search({ query: 'JWT' });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].body).toContain('JWT');
  });

  it('search respects scopeFilter', () => {
    const idx = openSegmentIndex(DB_PATH);
    idx.upsert(makeSegment({ scope: 'user', kind: 'fact', body: 'JWT note A' }));
    idx.upsert(makeSegment({ scope: 'session/g1/vp/alice', kind: 'fact', body: 'JWT note B' }));
    const hits = idx.search({ query: 'JWT', scopeFilter: ['user'] });
    expect(hits).toHaveLength(1);
    expect(hits[0].scope).toBe('user');
  });

  it('search respects limit', () => {
    const idx = openSegmentIndex(DB_PATH);
    for (let i = 0; i < 10; i += 1) {
      idx.upsert(makeSegment({ scope: 'user', kind: 'fact', body: `JWT entry ${i}` }));
    }
    const hits = idx.search({ query: 'JWT', limit: 3 });
    expect(hits).toHaveLength(3);
  });
});

describe('segment-store disk I/O', () => {
  it('writeScope + readScope round-trips', () => {
    const segs = [
      makeSegment({ scope: 'user', kind: 'fact', body: 'A' }),
      makeSegment({ scope: 'user', kind: 'decision', body: 'B' }),
    ];
    writeScope(TEST_DIR, 'user', segs);
    const back = readScope(TEST_DIR, 'user');
    expect(back).toHaveLength(2);
    expect(back[0].body).toBe('A');
    expect(back[1].kind).toBe('decision');
  });

  it('readScope returns [] when file missing', () => {
    expect(readScope(TEST_DIR, 'user')).toEqual([]);
  });

  it('listScopes finds all memory.md files', () => {
    mkdirSync(join(TEST_DIR, 'user'), { recursive: true });
    writeFileSync(join(TEST_DIR, 'user', 'memory.md'), 'pure body\n');
    mkdirSync(join(TEST_DIR, 'session', 'g1', 'vp', 'alice'), { recursive: true });
    writeFileSync(join(TEST_DIR, 'session', 'g1', 'vp', 'alice', 'memory.md'), 'pure body\n');
    const scopes = listScopes(TEST_DIR);
    expect(scopes.sort()).toEqual(['session/g1/vp/alice', 'user']);
  });
});

describe('syncScope / syncAll', () => {
  it('syncScope upserts disk content into index', () => {
    writeScope(TEST_DIR, 'user', [
      makeSegment({ scope: 'user', kind: 'fact', body: 'A' }),
      makeSegment({ scope: 'user', kind: 'fact', body: 'B' }),
    ]);
    const idx = openSegmentIndex(DB_PATH);
    const r = syncScope(TEST_DIR, idx, 'user');
    expect(r.upserted).toBe(2);
    expect(r.deleted).toBe(0);
    expect(idx.listByScope('user')).toHaveLength(2);
    idx.close();
  });

  it('syncScope deletes segments removed from disk', () => {
    const idx = openSegmentIndex(DB_PATH);
    const a = makeSegment({ scope: 'user', kind: 'fact', body: 'A' });
    const b = makeSegment({ scope: 'user', kind: 'fact', body: 'B' });
    writeScope(TEST_DIR, 'user', [a, b]);
    syncScope(TEST_DIR, idx, 'user');
    // Now remove 'B' from disk
    writeScope(TEST_DIR, 'user', [a]);
    const r = syncScope(TEST_DIR, idx, 'user');
    expect(r.deleted).toBe(1);
    expect(idx.listByScope('user').map(s => s.id)).toEqual([a.id]);
    idx.close();
  });

  it('syncScope is idempotent (no-op on second run)', () => {
    writeScope(TEST_DIR, 'user', [makeSegment({ scope: 'user', kind: 'fact', body: 'A' })]);
    const idx = openSegmentIndex(DB_PATH);
    const r1 = syncScope(TEST_DIR, idx, 'user');
    const r2 = syncScope(TEST_DIR, idx, 'user');
    expect(r1.upserted).toBe(1);
    expect(r2.upserted).toBe(0);
    expect(r2.deleted).toBe(0);
    idx.close();
  });

  it('syncAll handles multiple scopes + drops orphans', () => {
    writeScope(TEST_DIR, 'user', [makeSegment({ scope: 'user', kind: 'fact', body: 'A' })]);
    writeScope(TEST_DIR, 'session/g1/vp/alice', [makeSegment({ scope: 'session/g1/vp/alice', kind: 'fact', body: 'B' })]);
    const idx = openSegmentIndex(DB_PATH);
    syncAll(TEST_DIR, idx);
    expect(idx.count()).toBe(2);

    // remove 'session/g1/vp/alice' file content (write empty file)
    writeScope(TEST_DIR, 'session/g1/vp/alice', []);
    const r = syncAll(TEST_DIR, idx);
    expect(r.deleted).toBe(1);
    expect(idx.listByScope('session/g1/vp/alice')).toHaveLength(0);
    idx.close();
  });

  it('end-to-end: write disk, sync, search', () => {
    writeScope(TEST_DIR, 'session/g1/topic/auth', [
      makeSegment({
        scope: 'session/g1/topic/auth', kind: 'decision',
        body: 'Use JWT tokens for stateless auth',
        tags: ['auth', 'jwt'],
      }),
      makeSegment({
        scope: 'session/g1/topic/auth', kind: 'fact',
        body: 'Refresh tokens stored in HTTP-only cookies',
        tags: ['auth', 'cookies'],
      }),
    ]);
    const idx = openSegmentIndex(DB_PATH);
    syncAll(TEST_DIR, idx);
    const hits = idx.search({ query: 'JWT', scopeFilter: ['session/g1/topic/auth'] });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].body).toContain('JWT');
    idx.close();
  });
});
