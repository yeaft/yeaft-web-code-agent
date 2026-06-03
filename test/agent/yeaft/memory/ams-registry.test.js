/**
 * ams-registry.test.js — group-keyed AMS lifecycle.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openAmsRegistry, AMS_FILE_VERSION, DEFAULT_GROUP_KEY }
  from '../../../../agent/yeaft/memory/ams-registry.js';
import { openSegmentIndex } from '../../../../agent/yeaft/memory/index-db.js';
import { makeSegment } from '../../../../agent/yeaft/memory/segment.js';

let YEAFT_DIR;
let memoryIndex;

beforeEach(() => {
  YEAFT_DIR = mkdtempSync(join(tmpdir(), 'ams-reg-'));
  memoryIndex = openSegmentIndex(join(YEAFT_DIR, 'index.db'));
});
afterEach(() => {
  try { memoryIndex?.close(); } catch {}
  try { rmSync(YEAFT_DIR, { recursive: true, force: true }); } catch {}
});

function seedSegment(scope, body) {
  const seg = makeSegment({ scope, body, kind: 'context', tags: [] });
  memoryIndex.upsert(seg);
  return seg;
}

describe('AmsRegistry — basic lifecycle', () => {
  it('returns a fresh AMS on cold start', () => {
    const reg = openAmsRegistry({
      yeaftDir: YEAFT_DIR, memoryIndex,
      config: { maxContextTokens: 200_000 },
    });
    const ams = reg.getOrCreate('g1', { ownVpId: 'alice' });
    expect(ams).toBeDefined();
    expect(ams.onDemandIds()).toEqual([]);
    expect(ams.recentIds()).toEqual([]);
  });

  it('caches the AMS so repeat getOrCreate returns the same instance', () => {
    const reg = openAmsRegistry({ yeaftDir: YEAFT_DIR, memoryIndex, config: {} });
    const a = reg.getOrCreate('g1');
    const b = reg.getOrCreate('g1');
    expect(a).toBe(b);
  });

  it('uses DEFAULT_GROUP_KEY when sessionId is missing', () => {
    const reg = openAmsRegistry({ yeaftDir: YEAFT_DIR, memoryIndex, config: {} });
    const a = reg.getOrCreate(null);
    const b = reg.getOrCreate(undefined);
    expect(a).toBe(b);
    expect(reg.amsPath(null)).toContain(`/${DEFAULT_GROUP_KEY}/ams.json`);
  });
});

describe('AmsRegistry — persist + hydrate round-trip', () => {
  it('persist writes ams.json with the expected shape', () => {
    const seg = seedSegment('group/g1', 'segment body about coffee');

    const reg = openAmsRegistry({
      yeaftDir: YEAFT_DIR, memoryIndex,
      config: { maxContextTokens: 200_000 },
    });
    const ams = reg.getOrCreate('g1', { ownVpId: 'alice' });
    ams.setOnDemand([seg]);
    ams.touchRecent(seg);
    reg.markDirty('g1');
    const wrote = reg.persist('g1', { adjustRanThisSession: true });

    expect(wrote).toBe(true);
    const path = reg.amsPath('g1');
    expect(existsSync(path)).toBe(true);
    const payload = JSON.parse(readFileSync(path, 'utf8'));
    expect(payload.version).toBe(AMS_FILE_VERSION);
    expect(payload.ownVpId).toBe('alice');
    expect(payload.onDemandIds).toEqual([seg.id]);
    expect(payload.recentIds).toEqual([seg.id]);
    expect(payload.adjustRanThisSession).toBe(true);
    expect(typeof payload.savedAt).toBe('string');
  });

  it('persist is a no-op when not dirty (unless force)', () => {
    const reg = openAmsRegistry({ yeaftDir: YEAFT_DIR, memoryIndex, config: {} });
    reg.getOrCreate('g1');
    expect(reg.persist('g1')).toBe(false);
    expect(reg.persist('g1', { force: true })).toBe(true);
  });

  it('hydrate restores onDemand + recent from ams.json via SegmentIndex', () => {
    const seg1 = seedSegment('group/g2', 'first body');
    const seg2 = seedSegment('group/g2', 'second body');

    // First registry — populate + persist.
    {
      const reg = openAmsRegistry({ yeaftDir: YEAFT_DIR, memoryIndex, config: {} });
      const ams = reg.getOrCreate('g2');
      ams.setOnDemand([seg1, seg2]);
      ams.touchRecent(seg1);
      reg.markDirty('g2');
      reg.persist('g2');
    }

    // Second registry — fresh cache, must hydrate from disk.
    const reg2 = openAmsRegistry({ yeaftDir: YEAFT_DIR, memoryIndex, config: {} });
    const ams2 = reg2.getOrCreate('g2');
    expect(ams2.onDemandIds().sort()).toEqual([seg1.id, seg2.id].sort());
    expect(ams2.recentIds()).toEqual([seg1.id]);
  });

  it('hydrate restores adjustRanThisSession across registry reloads', () => {
    const seg = seedSegment('group/g7', 'still here');

    {
      const reg = openAmsRegistry({ yeaftDir: YEAFT_DIR, memoryIndex, config: {} });
      const ams = reg.getOrCreate('g7');
      ams.setOnDemand([seg]);
      reg.markDirty('g7');
      // First persist with the flag set true — the engine flips this
      // after runAdjust succeeds.
      expect(reg.persist('g7', { adjustRanThisSession: true })).toBe(true);
      expect(reg.adjustRanThisSession('g7')).toBe(true);
    }

    // Fresh registry: must read the flag back from disk so the engine
    // doesn't burn a redundant adjust on the first turn after reload.
    const reg2 = openAmsRegistry({ yeaftDir: YEAFT_DIR, memoryIndex, config: {} });
    reg2.getOrCreate('g7');
    expect(reg2.adjustRanThisSession('g7')).toBe(true);
  });

  it('hydrate skips ids that no longer exist in the index', () => {
    const seg = seedSegment('group/g3', 'still here');

    {
      const reg = openAmsRegistry({ yeaftDir: YEAFT_DIR, memoryIndex, config: {} });
      const ams = reg.getOrCreate('g3');
      ams.setOnDemand([seg, { id: 'seg_gone', scope: 'group/g3', body: '', kind: 'context', tags: [] }]);
      reg.markDirty('g3');
      reg.persist('g3');
    }

    const reg2 = openAmsRegistry({ yeaftDir: YEAFT_DIR, memoryIndex, config: {} });
    const ams2 = reg2.getOrCreate('g3');
    expect(ams2.onDemandIds()).toEqual([seg.id]);
  });

  it('persistAll writes every dirty group', () => {
    const reg = openAmsRegistry({ yeaftDir: YEAFT_DIR, memoryIndex, config: {} });
    reg.getOrCreate('g4');
    reg.getOrCreate('g5');
    reg.markDirty('g4');
    reg.markDirty('g5');
    expect(reg.persistAll()).toBe(2);
    expect(existsSync(reg.amsPath('g4'))).toBe(true);
    expect(existsSync(reg.amsPath('g5'))).toBe(true);
  });

  it('hydrate is silent on a corrupt ams.json', async () => {
    // Write a malformed file.
    const reg = openAmsRegistry({ yeaftDir: YEAFT_DIR, memoryIndex, config: {} });
    const path = reg.amsPath('g6');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '{not json', 'utf8');

    const ams = reg.getOrCreate('g6');
    expect(ams.onDemandIds()).toEqual([]);
  });
});
