/**
 * memory-r6-shard.test.js — task-334f R6 semantic shard + recall + tools.
 *
 * Coverage matrix:
 *   S-a  schema: VP default 4 shards + task 5 + user 5 + soft cap table
 *   S-b  shard-store: put/get/query/supersede + sourceRef round-trip
 *   S-c  shard-store: soft cap advisory (80 entries / skill)
 *   S-d  shard-store: atomic re-compression stage + commit
 *   S-e  recall-r6: keyword classifier picks the right shard
 *   S-f  recall-r6: 4-step end-to-end returns bodies w/o sourceRef
 *   S-g  memory_trace: returns sourceRef + msgIds from jsonl
 *   S-h  open_source_message: random access by (groupId, msgId)
 *   S-i  migration stub: classifyLegacyEntryToShard + planR5ToR6Migration
 *   S-j  projectDeriveHint: threshold = 30
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  VP_DEFAULT_SHARDS,
  TASK_SHARDS,
  USER_SHARDS,
  softCapFor,
  buildShardSchema,
  validateR6Entry,
  PROJECT_DERIVE_THRESHOLD,
} from '../../agent/unify/memory/schema.js';
import { openMemoryShardStore, classifyLegacyEntryToShard } from '../../agent/unify/memory/shard-store.js';
import {
  recallR6,
  classifyShardsByKeyword,
  formatForInjection,
  clearR6RecallCache,
} from '../../agent/unify/memory/recall-r6.js';
import memoryTraceTool from '../../agent/unify/tools/memory-trace.js';
import openSourceMessageTool from '../../agent/unify/tools/open-source-message.js';
import { planR5ToR6Migration, applyR5ToR6Migration } from '../../agent/unify/memory/migrate-r5-to-r6.js';

// ─── Helpers ─────────────────────────────────────────────────────

function tmp() { return mkdtempSync(join(tmpdir(), 'memr6-')); }

function entry(id, overrides = {}) {
  return {
    id,
    kind: 'skill',
    shard: 'skill',
    body: `content ${id}`,
    sourceRef: {
      groupId: 'grp_a',
      msgIds: ['msg_01', 'msg_02'],
      timeWindow: '2026-04-01T00:00Z..2026-04-01T01:00Z',
    },
    tags: ['typescript'],
    authoredBy: 'vp:dev-1',
    ...overrides,
  };
}

// ─── S-a: schema ────────────────────────────────────────────────

describe('S-a schema — §Δ22 公理 + §Δ25/§Δ26.3', () => {
  it('VP default shard set is exactly [skill, relations, lessons, preferences]', () => {
    expect([...VP_DEFAULT_SHARDS]).toEqual(['skill', 'relations', 'lessons', 'preferences']);
  });
  it('Task memory has 5 fixed shards', () => {
    expect([...TASK_SHARDS]).toEqual(['decision', 'progress', 'context', 'blocker', 'artifact']);
  });
  it('User memory has 5 shards', () => {
    expect([...USER_SHARDS]).toEqual(['profile', 'preferences', 'projects', 'goals', 'relations']);
  });
  it('soft-cap table matches §Δ26.3 (skill=80/64KiB, project=150/128KiB, relations=50/32KiB)', () => {
    expect(softCapFor('skill')).toEqual({ entries: 80, bytes: 64 * 1024 });
    expect(softCapFor('lessons')).toEqual({ entries: 80, bytes: 64 * 1024 });
    expect(softCapFor('preferences')).toEqual({ entries: 80, bytes: 64 * 1024 });
    expect(softCapFor('relations')).toEqual({ entries: 50, bytes: 32 * 1024 });
    expect(softCapFor('project-yeaft')).toEqual({ entries: 150, bytes: 128 * 1024 });
    expect(softCapFor('decision')).toEqual({ entries: 40, bytes: 24 * 1024 });
  });
  it('buildShardSchema extends shards with project-*', () => {
    const s = buildShardSchema('vp', { extraShards: ['project-yeaft'] });
    expect(s.shards).toContain('project-yeaft');
    expect(s.softCap['project-yeaft']).toEqual({ entries: 150, bytes: 128 * 1024 });
  });
  it('validateR6Entry rejects missing sourceRef on non-identity/preference kinds', () => {
    expect(() => validateR6Entry({ id: 'm1', shard: 'skill', kind: 'skill' })).toThrow(/sourceRef/);
    expect(() => validateR6Entry({ id: 'm1', shard: 'preferences', kind: 'preference' })).not.toThrow();
  });
});

// ─── S-b / S-c / S-d: shard store ────────────────────────────────

describe('S-b shard-store put/get/query/supersede', () => {
  it('round-trips sourceRef + tags + supersede chain', () => {
    const store = openMemoryShardStore(tmp(), 'vp');
    store.put(entry('m1'));
    const got = store.get('m1');
    expect(got.id).toBe('m1');
    expect(got.kind).toBe('skill');
    expect(got.sourceRef.msgIds).toEqual(['msg_01', 'msg_02']);
    expect(got.tags).toContain('typescript');

    // Query filters on meta
    const q = store.query({ kind: 'skill' });
    expect(q.results.map(r => r.id)).toContain('m1');

    // Supersede
    store.supersede({
      newEntry: entry('m2', { body: 'new consolidated content' }),
      oldIds: ['m1'],
    });
    const m1After = store.get('m1');
    expect(m1After.supersededBy).toBe('m2');
    const m2 = store.get('m2');
    expect(m2.supersedes).toEqual(['m1']);
  });
});

describe('S-c shard-store — soft cap advisory', () => {
  it('skill shard flags needsRecompression when > 80 entries', () => {
    const store = openMemoryShardStore(tmp(), 'vp');
    let lastNeeds = false;
    for (let i = 0; i < 82; i++) {
      const r = store.put(entry(`m${i}`));
      lastNeeds = r.needsRecompression;
    }
    expect(lastNeeds).toBe(true);
    const q = store.query({ shard: 'skill' });
    expect(q.needsRecompression).toContain('skill');
  });
});

describe('S-d shard-store — atomic re-compression', () => {
  it('stageRecompression writes tmp file, commitRecompression renames it', () => {
    const dir = tmp();
    const store = openMemoryShardStore(dir, 'vp');
    store.put(entry('m1'));
    store.put(entry('m2'));

    // Simulate a dream re-compression: caller builds new body, stages it.
    const NEW_BODY = '\n<!--entry:m_merged:START-->\nmerged\n<!--entry:m_merged:END-->\n';
    const tmpPath = store.stageRecompression('skill', NEW_BODY);
    expect(tmpPath.endsWith('.compacting')).toBe(true);

    // Abort path keeps the original in place.
    store.abortRecompression('skill');
    expect(store.get('m1')).not.toBeNull();

    // Commit path swaps the file atomically.
    store.stageRecompression('skill', NEW_BODY);
    store.commitRecompression('skill');
    // After commit + compact, the new single-entry id should be visible.
    const q = store.query({});
    const ids = q.results.map(r => r.id);
    expect(ids).toContain('m_merged');
  });
});

// ─── S-e / S-f: recall pipeline ─────────────────────────────────

describe('S-e keyword shard classifier', () => {
  it('picks skill for code queries, lessons for pitfall queries', () => {
    expect(classifyShardsByKeyword('how do I debug the Vue syntax', ['skill', 'lessons', 'relations']))
      .toContain('skill');
    expect(classifyShardsByKeyword('what pitfall have I hit with bug regression', ['skill', 'lessons', 'relations']))
      .toContain('lessons');
  });
  it('boosts project-<slug> when the slug appears in the prompt', () => {
    const out = classifyShardsByKeyword('tell me about the yeaft auth work', ['skill', 'project-yeaft'], 2);
    expect(out[0]).toBe('project-yeaft');
  });
});

describe('S-f recall-r6 end-to-end (no LLM adapter)', () => {
  beforeEach(() => clearR6RecallCache());

  it('returns body-only entries with no sourceRef exposed', async () => {
    const store = openMemoryShardStore(tmp(), 'vp');
    store.put(entry('mA', { body: 'A about typescript', tags: ['typescript'] }));
    store.put(entry('mB', { body: 'B about python',     tags: ['python']     }));

    const res = await recallR6({
      prompt: 'need help with typescript code syntax',
      memoryShardStore: store,
      // no adapter — uses keyword classifier
    });
    expect(res.shards).toContain('skill');
    const ids = res.entries.map(e => e.id);
    expect(ids.length).toBeGreaterThan(0);
    // body present, sourceRef stripped per §Δ23
    for (const e of res.entries) {
      expect(e.body).toBeTruthy();
      expect(e.sourceRef).toBeUndefined();
    }
  });

  it('excludes superseded entries from the candidate pool', async () => {
    const store = openMemoryShardStore(tmp(), 'vp');
    store.put(entry('mOld'));
    store.supersede({ newEntry: entry('mNew', { body: 'new body' }), oldIds: ['mOld'] });
    const res = await recallR6({
      prompt: 'typescript code',
      memoryShardStore: store,
    });
    const ids = res.entries.map(e => e.id);
    expect(ids).not.toContain('mOld');
  });

  it('formatForInjection prefixes with [mem:<shard>] and omits ids', () => {
    const txt = formatForInjection([
      { id: 'mA', shard: 'skill', body: 'hello' },
    ]);
    expect(txt).toMatch(/\[mem:skill\]/);
    expect(txt).not.toMatch(/mA/);
  });
});

// ─── S-g / S-h: tools ───────────────────────────────────────────

function makeFakeCoordinator(msgs) {
  return {
    openGroup(gid) {
      if (gid !== 'grp_a') return null;
      return {
        *streamMessages() { for (const m of msgs) yield m; },
        *readMessageRange(first, last) {
          for (const m of msgs) {
            if (m.id >= first && m.id <= last) yield m;
          }
        },
      };
    },
  };
}

describe('S-g memory_trace tool', () => {
  it('returns memory + matching source messages by msgIds', async () => {
    const store = openMemoryShardStore(tmp(), 'vp');
    store.put(entry('mZ'));

    const coordinator = makeFakeCoordinator([
      { id: 'msg_01', ts: '2026-04-01T00:00:00Z', text: 'one' },
      { id: 'msg_02', ts: '2026-04-01T00:00:30Z', text: 'two' },
      { id: 'msg_99', ts: '2026-04-01T00:01:00Z', text: 'unrelated' },
    ]);

    const res = JSON.parse(await memoryTraceTool.execute(
      { memId: 'mZ', expand: 'full' },
      { memoryShardStore: store, coordinator },
    ));
    expect(res.memory.id).toBe('mZ');
    expect(res.messages.map(m => m.id)).toEqual(['msg_01', 'msg_02']);
  });
  it('refuses unknown memId', async () => {
    const store = openMemoryShardStore(tmp(), 'vp');
    const res = JSON.parse(await memoryTraceTool.execute(
      { memId: 'nope' },
      { memoryShardStore: store, coordinator: makeFakeCoordinator([]) },
    ));
    expect(res.error).toMatch(/not found/);
  });
  it('tool is declared read-only (guard against self-feedback loop)', () => {
    expect(memoryTraceTool.isReadOnly()).toBe(true);
  });
});

describe('S-h open_source_message tool', () => {
  it('returns a single message by (groupId, msgId)', async () => {
    const coordinator = makeFakeCoordinator([
      { id: 'msg_01', text: 'hello' },
    ]);
    const res = JSON.parse(await openSourceMessageTool.execute(
      { groupId: 'grp_a', msgId: 'msg_01' },
      { coordinator },
    ));
    expect(res.message.text).toBe('hello');
  });
  it('errors on unknown group', async () => {
    const res = JSON.parse(await openSourceMessageTool.execute(
      { groupId: 'nope', msgId: 'msg_01' },
      { coordinator: makeFakeCoordinator([]) },
    ));
    expect(res.error).toBeTruthy();
  });
});

// ─── S-i: migration stub ────────────────────────────────────────

describe('S-i migration stub — classifier + plan dry run', () => {
  it('classifies legacy kinds into semantic shards', () => {
    expect(classifyLegacyEntryToShard({ kind: 'lesson'     })).toBe('lessons');
    expect(classifyLegacyEntryToShard({ kind: 'preference' })).toBe('preferences');
    expect(classifyLegacyEntryToShard({ kind: 'relation'   })).toBe('relations');
    expect(classifyLegacyEntryToShard({ kind: 'skill'      })).toBe('skill');
    expect(classifyLegacyEntryToShard({ kind: 'fact'       })).toBe('skill'); // fallback
  });
  it('planR5ToR6Migration tolerates missing dir', () => {
    const p = planR5ToR6Migration('/tmp/does-not-exist-r6-test');
    expect(p.totalEntries).toBe(0);
    expect(p.plan).toEqual([]);
  });
  it('applyR5ToR6Migration is a deferred stub — throws until 334i wires it', async () => {
    await expect(applyR5ToR6Migration({})).rejects.toThrow(/334i/);
  });
});

// ─── S-j: projectDeriveHint ─────────────────────────────────────

describe('S-j projectDeriveHint threshold = 30', () => {
  it('returns null below the threshold', () => {
    const store = openMemoryShardStore(tmp(), 'vp');
    for (let i = 0; i < 5; i++) {
      store.put(entry(`m${i}`, { sourceRef: { groupId: 'grp_X', msgIds: ['x'] } }));
    }
    expect(store.projectDeriveHint()).toBeNull();
    expect(PROJECT_DERIVE_THRESHOLD).toBe(30);
  });
  it('surfaces a candidate once ≥ 30 entries share a groupId', () => {
    const store = openMemoryShardStore(tmp(), 'vp');
    for (let i = 0; i < 30; i++) {
      store.put(entry(`m${i}`, { sourceRef: { groupId: 'grp_yeaft', msgIds: ['x'] } }));
    }
    const hint = store.projectDeriveHint();
    expect(hint).toBeTruthy();
    expect(hint.shard).toBe('project-grp-yeaft');
    expect(hint.count).toBeGreaterThanOrEqual(30);
  });
});
