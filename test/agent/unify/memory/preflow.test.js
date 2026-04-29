/**
 * preflow.test.js — H2.c pre-flow FTS recall.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openSegmentIndex } from '../../../../agent/unify/memory/index-db.js';
import { makeSegment } from '../../../../agent/unify/memory/segment.js';
import {
  runPreflow, buildFtsQuery, filterScopes, rerank,
} from '../../../../agent/unify/memory/preflow.js';

let TEST_DIR;
let DB_PATH;
let idx;

beforeEach(() => {
  TEST_DIR = mkdtempSync(join(tmpdir(), 'h2c-'));
  DB_PATH = join(TEST_DIR, 'idx.db');
  idx = openSegmentIndex(DB_PATH);
});

afterEach(() => {
  try { idx.close(); } catch {}
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
});

describe('buildFtsQuery', () => {
  it('returns empty for no keywords', () => {
    expect(buildFtsQuery([])).toBe('');
  });
  it('joins with OR + prefix wildcard + quotes', () => {
    const q = buildFtsQuery(['jwt', 'auth']);
    expect(q).toContain('"jwt"*');
    expect(q).toContain('"auth"*');
    expect(q).toContain(' OR ');
  });
  it('caps at 8 keywords', () => {
    const kws = ['aa','bb','cc','dd','ee','ff','gg','hh','ii','jj'];
    const q = buildFtsQuery(kws);
    expect((q.match(/OR/g) || []).length).toBe(7);
  });
  it('drops short tokens', () => {
    const q = buildFtsQuery(['x', 'jwt']);
    expect(q).toBe('"jwt"*');
  });
});

describe('filterScopes', () => {
  it('keeps non-vp scopes unchanged', () => {
    const r = filterScopes(['user', 'group/g1', 'topic/lang'], 'alice');
    expect(r).toEqual(['user', 'group/g1', 'topic/lang']);
  });
  it('keeps own vp', () => {
    const r = filterScopes(['vp/alice', 'vp/bob'], 'alice');
    expect(r).toEqual(['vp/alice']);
  });
  it('keeps all vp scopes when no ownVpId', () => {
    const r = filterScopes(['vp/alice', 'vp/bob'], null);
    expect(r).toEqual(['vp/alice', 'vp/bob']);
  });
});

describe('rerank', () => {
  it('boosts tag overlap (lower score)', () => {
    const hits = [
      { id: 'a', tags: ['x'], rank: -1, updatedAt: new Date().toISOString() },
      { id: 'b', tags: ['auth'], rank: -1, updatedAt: new Date().toISOString() },
    ];
    const r = rerank(hits, { currentTags: ['auth'] });
    expect(r[0].id).toBe('b');
  });
  it('preserves order when no signal differs', () => {
    const hits = [
      { id: 'a', tags: [], rank: -2, updatedAt: new Date().toISOString() },
      { id: 'b', tags: [], rank: -1, updatedAt: new Date().toISOString() },
    ];
    const r = rerank(hits, { currentTags: [] });
    expect(r.map(h => h.id)).toEqual(['a', 'b']);
  });
});

describe('runPreflow end-to-end', () => {
  it('returns empty result for empty input', () => {
    const r = runPreflow(idx, { userMsg: '', relevantScopes: ['user'] });
    expect(r.picked).toEqual([]);
    expect(r.keywords).toEqual([]);
  });

  it('returns empty when no relevant scopes', () => {
    idx.upsert(makeSegment({ scope: 'user', kind: 'fact', body: 'JWT auth' }));
    const r = runPreflow(idx, { userMsg: 'jwt auth', relevantScopes: [] });
    expect(r.picked).toEqual([]);
  });

  it('finds matching segments via FTS', () => {
    idx.upsert(makeSegment({ scope: 'user', kind: 'fact', body: 'Use JWT for auth' }));
    idx.upsert(makeSegment({ scope: 'user', kind: 'fact', body: 'Unrelated note about pets' }));
    const r = runPreflow(idx, { userMsg: 'how to do jwt auth?', relevantScopes: ['user'] });
    expect(r.picked.length).toBeGreaterThanOrEqual(1);
    expect(r.picked[0].body).toContain('JWT');
  });

  it('respects budget — drops overflow', () => {
    for (let i = 0; i < 5; i += 1) {
      idx.upsert(makeSegment({
        scope: 'user', kind: 'fact',
        body: 'JWT '.repeat(50) + ` v${i}`,         // ~50 tokens each
      }));
    }
    const r = runPreflow(idx, {
      userMsg: 'jwt',
      relevantScopes: ['user'],
      budgetTokens: 60,                               // fits ~1 segment
    });
    expect(r.picked.length).toBeLessThanOrEqual(2);
    expect(r.droppedCount).toBeGreaterThan(0);
  });

  it('filters foreign VP scopes', () => {
    idx.upsert(makeSegment({ scope: 'vp/alice', kind: 'fact', body: 'JWT alice' }));
    idx.upsert(makeSegment({ scope: 'vp/bob',   kind: 'fact', body: 'JWT bob' }));
    const r = runPreflow(idx, {
      userMsg: 'jwt',
      relevantScopes: ['vp/alice', 'vp/bob'],
      ownVpId: 'alice',
    });
    expect(r.picked.every(s => s.scope === 'vp/alice')).toBe(true);
  });

  it('tag overlap reranks results', () => {
    const a = makeSegment({
      scope: 'user', kind: 'fact', body: 'JWT auth notes A', tags: ['auth'],
    });
    const b = makeSegment({
      scope: 'user', kind: 'fact', body: 'JWT auth notes B', tags: ['unrelated'],
    });
    idx.upsert(a);
    idx.upsert(b);
    const r = runPreflow(idx, {
      userMsg: 'jwt auth',
      relevantScopes: ['user'],
      currentTags: ['auth'],
    });
    // A (with overlapping tag) should rank ahead of B
    expect(r.picked[0].id).toBe(a.id);
  });
});
