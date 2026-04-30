/**
 * dream-v2/session-wiring.test.js wiring smoke tests.
 *
 * Runs runDream against a stubbed groups directory and adapter; verifies
 * the session-wiring closures route data correctly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildRunDreamOpts, createV2DreamScheduler } from '../../../../agent/unify/dream-v2/session-wiring.js';

let yeaftDir;
beforeEach(() => { yeaftDir = mkdtempSync(join(tmpdir(), 'session-wiring-')); });
afterEach(() => { rmSync(yeaftDir, { recursive: true, force: true }); });

function seedGroup(id, messages) {
  const dir = join(yeaftDir, 'groups', id);
  mkdirSync(join(dir, 'messages'), { recursive: true });
  writeFileSync(join(dir, 'group.json'), JSON.stringify({
    id, name: id, roster: [], defaultVpId: null, createdAt: '2026-04-28T00:00:00Z',
  }));
  // Append messages via the openGroup API later; here just write a NDJSON-ish
  // log to satisfy any reader. We rely on openGroup to use its log impl.
  const logPath = join(dir, 'messages', '0001.jsonl');
  const lines = messages.map(m => JSON.stringify(m)).join('\n');
  writeFileSync(logPath, lines + (lines ? '\n' : ''));
}

describe('buildRunDreamOpts', () => {
  it('returns the expected hook shape', () => {
    const opts = buildRunDreamOpts({ yeaftDir, adapter: {}, config: {} });
    expect(typeof opts.listGroups).toBe('function');
    expect(typeof opts.countMessages).toBe('function');
    expect(typeof opts.loadGroupDiff).toBe('function');
    expect(typeof opts.loadOverlapPreamble).toBe('function');
    expect(typeof opts.llm).toBe('function');
    expect(opts.root).toBe(join(yeaftDir, 'memory'));
  });

  it('listGroups returns empty when no groups dir', async () => {
    const opts = buildRunDreamOpts({ yeaftDir, adapter: {}, config: {} });
    expect(await opts.listGroups()).toEqual([]);
  });

  it('countMessages returns 0 for unknown group', async () => {
    const opts = buildRunDreamOpts({ yeaftDir, adapter: {}, config: {} });
    expect(await opts.countMessages('nope')).toBe(0);
  });

  it('loadGroupDiff tolerates missing groups', async () => {
    const opts = buildRunDreamOpts({ yeaftDir, adapter: {}, config: {} });
    expect(await opts.loadGroupDiff('missing', null)).toEqual([]);
  });
});

describe('createV2DreamScheduler', () => {
  it('exposes the legacy-compatible API surface', () => {
    const sched = createV2DreamScheduler({
      yeaftDir,
      adapter: { call: async () => ({ text: '{}' }) },
      config: { debug: false, fastModelId: 'm', model: 'm' },
    });
    try {
      expect(typeof sched.noteUserMessage).toBe('function');
      expect(typeof sched.triggerDreamNow).toBe('function');
      expect(typeof sched.shutdown).toBe('function');
      expect(typeof sched._v2).toBe('object');
    } finally {
      sched.shutdown();
    }
  });

  it('triggerDreamNow runs without throwing on an empty session', async () => {
    const sched = createV2DreamScheduler({
      yeaftDir,
      adapter: { call: async () => ({ text: '{}' }) },
      config: { debug: false, fastModelId: 'm', model: 'm' },
    });
    try {
      const r = await sched.triggerDreamNow();
      expect(r).toBeTruthy();
      // No groups → no targets → done event still emitted.
      expect(r.groups).toEqual([]);
    } finally {
      sched.shutdown();
    }
  });

  it('forwards dream progress events to session._dreamProgressSink', async () => {
    const events = [];
    const session = {
      yeaftDir,
      adapter: { call: async () => ({ text: '{}' }) },
      config: { debug: false, fastModelId: 'm', model: 'm' },
      _dreamProgressSink: e => events.push(e),
    };
    const sched = createV2DreamScheduler(session);
    try {
      await sched.triggerDreamNow();
    } finally {
      sched.shutdown();
    }
    expect(events.length).toBeGreaterThan(0);
    expect(events.some(e => e.phase === 'start')).toBe(true);
    expect(events.some(e => e.phase === 'done')).toBe(true);
  });
});
