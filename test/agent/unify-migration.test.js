/**
 * unify-migration.test.js — task-334i tests
 *
 * Spec: .crew/context/task-334i-migration-spec.md §M6.2
 *
 * Scenarios (minimum per spec):
 *   1. empty home → noop
 *   2. gen1-only dry-run → preview only, no new tree
 *   3. gen1-only real → new tree created, state marker completed, .backup/
 *   4. gen1+gen2 → threads used only for task linking, no threads/ in new tree
 *   5. partial-migration → resume cursor, no duplicates
 *   6. corrupted entry → reported to state.errors, other entries succeed
 *   7. idempotent re-run → status=already-done
 *   8. rollback → throw clears new tree, legacy untouched
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { runMigration } from '../../agent/unify/migration/v0-to-v1.js';
import { detect } from '../../agent/unify/migration/detect.js';
import {
  parseFrontmatter,
  mapMessageMdToJsonl,
  mapMemoryEntry,
  mapTaskMeta,
  splitCoordinatorTurns,
  shardForMemoryKind,
  LEGACY_GROUP_ID,
  LEGACY_VP_ID,
} from '../../agent/unify/migration/map-fields.js';

// ═══════════════ helpers ═══════════════

function mkTmpYeaft() {
  const dir = join(tmpdir(), `yeaft-mig-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(dir, rel, content) {
  const path = join(dir, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function readJsonlIds(dir) {
  if (!existsSync(dir)) return [];
  const ids = [];
  for (const name of readdirSync(dir).sort()) {
    if (!/\.jsonl$/.test(name)) continue;
    const raw = readFileSync(join(dir, name), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try { ids.push(JSON.parse(line).id); } catch { /* skip */ }
    }
  }
  return ids;
}

function seedGen1(root) {
  writeFile(root, 'conversation/messages/m0001.md',
    `---
id: m0001
role: user
time: 2026-04-19T10:00:00Z
---
hello`);
  writeFile(root, 'conversation/messages/m0002.md',
    `---
id: m0002
role: assistant
time: 2026-04-19T10:00:01Z
---
hi back`);
  writeFile(root, 'conversation/cold/m0003.md',
    `---
id: m0003
role: user
time: 2026-04-19T09:00:00Z
---
older cold message`);
  writeFile(root, 'memory/entries/skill-a.md',
    `---
name: skill-a
kind: skill
tags: [foo, bar]
importance: high
created_at: 2026-04-18T00:00:00Z
updated_at: 2026-04-18T00:00:00Z
---
skill body`);
  writeFile(root, 'memory/entries/fact-b.md',
    `---
name: fact-b
kind: fact
tags: []
importance: normal
created_at: 2026-04-18T01:00:00Z
updated_at: 2026-04-18T01:00:00Z
---
fact body`);
  writeFile(root, 'memory/MEMORY.md', '# Prefs\nuses zh-CN');
  writeFile(root, 'tasks/task-abc/meta.md',
    `---
id: abc
status: archived
description: legacy task
created_at: 2026-04-17T00:00:00Z
---`);
  writeFile(root, 'tasks/task-abc/coordinator.md',
    `## user @ 2026-04-17T00:00:01Z
first turn

## assistant @ 2026-04-17T00:00:02Z
response turn`);
}

function seedGen2Extras(root) {
  writeFile(root, 'threads/main.md',
    `---
id: main
name: Main
taskId: null
---`);
  writeFile(root, 'threads/thr-xyz.md',
    `---
id: thr-xyz
name: XYZ
taskId: abc
---`);
  writeFile(root, 'threads/index.md', '# threads');
}

// ═══════════════ tests ═══════════════

describe('map-fields (pure)', () => {
  it('parseFrontmatter extracts scalars + arrays', () => {
    const r = parseFrontmatter('---\nkind: skill\ntags: [a, b]\npinned: true\ncount: 3\n---\nbody');
    expect(r.meta).toEqual({ kind: 'skill', tags: ['a', 'b'], pinned: true, count: 3 });
    expect(r.body).toBe('body');
  });

  it('parseFrontmatter returns meta:null on malformed input', () => {
    const r = parseFrontmatter('no frontmatter here');
    expect(r.meta).toBeNull();
  });

  it('mapMessageMdToJsonl user role', () => {
    const row = mapMessageMdToJsonl({
      meta: { role: 'user', time: '2026-04-19T10:00:00Z' },
      body: 'hi',
      originalId: 'm0001',
    });
    expect(row.id).toBe('msg_legacy_m0001');
    expect(row.authorKind).toBe('user');
    expect(row.authorId).toBe('user:self');
    expect(row.groupId).toBe(LEGACY_GROUP_ID);
  });

  it('mapMessageMdToJsonl assistant → unify-legacy VP', () => {
    const row = mapMessageMdToJsonl({
      meta: { role: 'assistant', time: '2026-04-19T10:00:01Z' },
      body: 'hello',
      originalId: 'm0002',
    });
    expect(row.authorKind).toBe('vp');
    expect(row.authorId).toBe(LEGACY_VP_ID);
  });

  it('mapMessageMdToJsonl handles corrupted (no meta) with _corrupted flag', () => {
    const row = mapMessageMdToJsonl({ meta: null, body: 'x', originalId: 'm9' });
    expect(row._corrupted).toBe(true);
    expect(row.id).toBe('msg_legacy_m9');
  });

  it('shardForMemoryKind routes known kinds', () => {
    expect(shardForMemoryKind('skill')).toBe('skill');
    expect(shardForMemoryKind('preference')).toBe('preferences');
    expect(shardForMemoryKind('unknown-kind')).toBe('project-legacy');
  });

  it('mapMemoryEntry: importance:high → pinned:true, skill → skill shard', () => {
    const r = mapMemoryEntry({
      meta: { name: 'x', kind: 'skill', tags: ['t'], importance: 'high' },
      body: 'body',
      id: 'mem_legacy_x',
      now: '2026-04-20T00:00:00Z',
    });
    expect(r.shard).toBe('skill');
    expect(r.entry.meta.pinned).toBe(true);
    expect(r.entry.meta.kind).toBe('skill');
    expect(r.entry.body).toContain('id: mem_legacy_x');
    expect(r.entry.body).toContain('body');
  });

  it('mapTaskMeta injects legacy group + initiator', () => {
    const t = mapTaskMeta({ meta: { status: 'archived', description: 'x' }, taskId: 'abc' });
    expect(t.groupId).toBe(LEGACY_GROUP_ID);
    expect(t.initiatorVpId).toBe(LEGACY_VP_ID);
    expect(t.members).toEqual([LEGACY_VP_ID]);
    expect(t._legacy).toBe(true);
  });

  it('splitCoordinatorTurns splits on H2 headings with role + ts', () => {
    const turns = splitCoordinatorTurns(
      '## user @ 2026-04-17T00:00:01Z\nhello\n\n## assistant @ 2026-04-17T00:00:02Z\nhi'
    );
    expect(turns).toHaveLength(2);
    expect(turns[0].role).toBe('user');
    expect(turns[0].ts).toBe('2026-04-17T00:00:01Z');
    expect(turns[0].body).toBe('hello');
    expect(turns[1].role).toBe('assistant');
  });
});

describe('detect()', () => {
  let root;
  beforeEach(() => { root = mkTmpYeaft(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('returns empty for a bare directory', () => {
    const r = detect(root);
    expect(r.empty).toBe(true);
    expect(r.hasGen1).toBe(false);
    expect(r.hasGen2).toBe(false);
  });

  it('detects Gen-1 messages + memory entries', () => {
    seedGen1(root);
    const r = detect(root);
    expect(r.hasGen1).toBe(true);
    expect(r.counts.messages).toBe(2);
    expect(r.counts.cold).toBe(1);
    expect(r.counts.memoryEntries).toBe(2);
    expect(r.counts.tasks).toBe(1);
  });

  it('detects Gen-2 threads alongside Gen-1', () => {
    seedGen1(root);
    seedGen2Extras(root);
    const r = detect(root);
    expect(r.hasGen1).toBe(true);
    expect(r.hasGen2).toBe(true);
    expect(r.counts.threads).toBe(2);
  });

  it('detects existing new tree', () => {
    mkdirSync(join(root, 'groups', 'legacy-main'), { recursive: true });
    const r = detect(root);
    expect(r.hasNewTree).toBe(true);
  });
});

describe('runMigration', () => {
  let root;
  beforeEach(() => { root = mkTmpYeaft(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('scenario 1: empty home → noop', async () => {
    const r = await runMigration({ yeaftDir: root });
    expect(r.status).toBe('noop');
    expect(existsSync(join(root, '.migration-state.json'))).toBe(false);
    expect(existsSync(join(root, 'groups'))).toBe(false);
  });

  it('scenario 2: gen1-only dry-run → preview, no writes', async () => {
    seedGen1(root);
    const r = await runMigration({ yeaftDir: root, dryRun: true });
    expect(r.status).toBe('dry-run');
    expect(r.preview.wouldMigrate.messages).toBe(3);
    expect(r.preview.wouldMigrate.memoryEntries).toBe(2);
    expect(r.preview.wouldMigrate.tasks).toBe(1);
    expect(existsSync(join(root, 'groups'))).toBe(false);
    expect(existsSync(join(root, 'virtual-persons'))).toBe(false);
    expect(existsSync(join(root, '.migration-state.json'))).toBe(false);
  });

  it('scenario 3: gen1-only real run → full new tree + state done + backup', async () => {
    seedGen1(root);
    const r = await runMigration({ yeaftDir: root });
    expect(r.status).toBe('done');

    // seed
    expect(existsSync(join(root, 'virtual-persons/unify-legacy/role.md'))).toBe(true);
    expect(existsSync(join(root, 'groups/legacy-main/group.json'))).toBe(true);

    // messages migrated into jsonl (sorted by ts: m0003 first since 09:00)
    const ids = readJsonlIds(join(root, 'groups/legacy-main/messages'));
    expect(ids).toContain('msg_legacy_m0001');
    expect(ids).toContain('msg_legacy_m0002');
    expect(ids).toContain('msg_legacy_m0003');

    // memory shards written
    expect(existsSync(join(root, 'virtual-persons/unify-legacy/memory/memory-skill.md'))).toBe(true);

    // task migrated
    const taskJson = JSON.parse(readFileSync(join(root, 'groups/legacy-main/tasks/abc/task.json'), 'utf8'));
    expect(taskJson.groupId).toBe('legacy-main');
    expect(taskJson.members).toEqual(['unify-legacy']);
    const taskIds = readJsonlIds(join(root, 'groups/legacy-main/tasks/abc/messages'));
    expect(taskIds.length).toBeGreaterThanOrEqual(2);

    // user memory
    expect(existsSync(join(root, 'user/profile.json'))).toBe(true);

    // state
    const state = JSON.parse(readFileSync(join(root, '.migration-state.json'), 'utf8'));
    expect(state.completedAt).toBeTruthy();

    // backup
    const backupDir = join(root, '.backup');
    expect(existsSync(backupDir)).toBe(true);
    const backupKids = readdirSync(backupDir);
    expect(backupKids.length).toBe(1);
    expect(backupKids[0]).toMatch(/^v0-/);

    // legacy untouched
    expect(existsSync(join(root, 'conversation/messages/m0001.md'))).toBe(true);
    expect(existsSync(join(root, 'memory/entries/skill-a.md'))).toBe(true);
  });

  it('scenario 4: gen1+gen2 — threads not persisted as new tree, only used for taskId linking', async () => {
    seedGen1(root);
    seedGen2Extras(root);
    // Add a message that references thr-xyz (bound to task abc)
    writeFile(root, 'conversation/messages/m0004.md',
      `---
id: m0004
role: user
time: 2026-04-19T10:00:05Z
threadId: thr-xyz
---
bound`);
    await runMigration({ yeaftDir: root });
    // No `threads/` created in the new tree root positions
    // (the legacy threads/ dir is still there — never deleted — but
    //  the new tree does NOT contain a re-materialised threads hierarchy)
    expect(existsSync(join(root, 'groups/legacy-main/threads'))).toBe(false);

    // m0004 should be associated with taskId abc in its jsonl row
    const dir = join(root, 'groups/legacy-main/messages');
    const raw = readFileSync(join(dir, readdirSync(dir).find((f) => f.endsWith('.jsonl'))), 'utf8');
    const bound = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .find((r) => r.id === 'msg_legacy_m0004');
    expect(bound).toBeTruthy();
    expect(bound.taskId).toBe('abc');
  });

  it('scenario 5: partial-migration resume from cursor — no duplicates', async () => {
    seedGen1(root);
    // First run (normal) completes — then we forcibly clear the completedAt
    // to simulate crash after some messages and re-run.
    await runMigration({ yeaftDir: root });
    const statePath = join(root, '.migration-state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.completedAt = null;
    state.steps.finalize = { status: 'pending' };
    state.steps.migrateMessages.status = 'in_progress';
    writeFileSync(statePath, JSON.stringify(state, null, 2));

    await runMigration({ yeaftDir: root });
    // No duplicates in the message log
    const ids = readJsonlIds(join(root, 'groups/legacy-main/messages'));
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
    // Sanity: all three legacy messages present once
    expect(ids.filter((x) => x === 'msg_legacy_m0001').length).toBe(1);
    expect(ids.filter((x) => x === 'msg_legacy_m0002').length).toBe(1);
    expect(ids.filter((x) => x === 'msg_legacy_m0003').length).toBe(1);
  });

  it('scenario 6: corrupted memory entry → error recorded, other entries still migrated', async () => {
    seedGen1(root);
    // Corrupted frontmatter (no closing ---)
    writeFile(root, 'memory/entries/bad.md', '---\nkind: skill\nname: bad');
    const r = await runMigration({ yeaftDir: root });
    expect(r.status).toBe('done');
    expect(r.state.steps.migrateMemory.errors.length).toBeGreaterThanOrEqual(1);
    expect(r.state.steps.migrateMemory.errors[0].file).toMatch(/bad\.md/);
    // Good entries still migrated
    expect(existsSync(join(root, 'virtual-persons/unify-legacy/memory/memory-skill.md'))).toBe(true);
  });

  it('scenario 7: idempotent re-run → already-done', async () => {
    seedGen1(root);
    const first = await runMigration({ yeaftDir: root });
    expect(first.status).toBe('done');
    const second = await runMigration({ yeaftDir: root });
    expect(second.status).toBe('already-done');
  });

  it('scenario 8: failure mid-run → rollback clears new tree, legacy untouched', async () => {
    seedGen1(root);
    // Pre-create an unwritable groups/legacy-main/tasks/abc/task.json to provoke
    // a downstream throw. Simplest: we stub onStep to throw when seedGroup step completes.
    let threw = false;
    await expect(runMigration({
      yeaftDir: root,
      onStep: (step) => {
        if (step === 'seedGroup') {
          threw = true;
          throw new Error('injected test failure');
        }
      },
    })).rejects.toThrow(/injected test failure/);
    expect(threw).toBe(true);

    // New tree should be rolled back
    expect(existsSync(join(root, 'groups'))).toBe(false);
    expect(existsSync(join(root, 'virtual-persons'))).toBe(false);
    expect(existsSync(join(root, 'user', 'memory'))).toBe(false);

    // Legacy untouched
    expect(existsSync(join(root, 'conversation/messages/m0001.md'))).toBe(true);
    expect(existsSync(join(root, 'memory/entries/skill-a.md'))).toBe(true);

    // State file records the failure reason
    const state = JSON.parse(readFileSync(join(root, '.migration-state.json'), 'utf8'));
    expect(state.cleanedAt).toBeTruthy();
    expect(state.reason).toMatch(/injected test failure/);
  });
});
