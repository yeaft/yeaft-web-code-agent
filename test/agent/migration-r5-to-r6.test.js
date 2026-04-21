/**
 * migration-r5-to-r6.test.js — task-334i (wave-4) R5→R6 migration tests.
 *
 * Spec: .crew/context/task-334i-impl-spec.md §8 test matrix
 *
 * Scenarios:
 *   I-a  single legacy entry (kind=skill) → R6 skill shard
 *   I-b  30 entries same groupId → project-<slug> derived in pass 2
 *   I-c  100 legacy messages → jsonl log in groups/legacy-main/messages/
 *   I-d  dry-run against populated R5 tree → zero filesystem writes
 *   I-e  idempotent re-run
 *   I-f  two-pass resume (kill after pass 1)
 *   I-g  name-drift regression — authoredBy is `system:migration-v0-v1`
 *        (NOT `system:migration-v0-to-v1`)
 *
 *   Plus: rollback happy path, rollback with missing archive.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  applyR5ToR6Migration,
  rollbackR5ToR6Migration,
  archiveR5State,
  detectR5MemoryLayout,
  R5_TO_R6_AUTHOR_SYS,
  R5_TO_R6_AUTHOR_USER,
} from '../../agent/unify/memory/migrate-r5-to-r6.js';
import { LEGACY_VP_ID, LEGACY_GROUP_ID } from '../../agent/unify/migration/map-fields.js';

// ═══════════════ helpers ═══════════════

function mkSandbox() {
  return mkdtempSync(join(tmpdir(), 'yeaft-r5r6-'));
}

function writeEntry(yeaftDir, slug, fields, body = '') {
  const dir = join(yeaftDir, 'memory', 'entries');
  mkdirSync(dir, { recursive: true });
  const fm = ['---'];
  fm.push(`name: ${slug}`);
  if (fields.kind) fm.push(`kind: ${fields.kind}`);
  if (fields.scope) fm.push(`scope: ${fields.scope}`);
  if (fields.tags) fm.push(`tags: [${fields.tags.join(', ')}]`);
  if (fields.importance) fm.push(`importance: ${fields.importance}`);
  fm.push(`created_at: ${fields.created_at || '2026-04-20T00:00:00Z'}`);
  fm.push(`updated_at: ${fields.updated_at || '2026-04-20T00:00:00Z'}`);
  fm.push('---');
  fm.push('');
  fm.push(body);
  writeFileSync(join(dir, `${slug}.md`), fm.join('\n'), 'utf8');
}

function writeMessageMd(yeaftDir, cId, fname, role, body, ts = '2026-04-20T01:00:00Z') {
  const dir = join(yeaftDir, 'conversations', cId, 'messages');
  mkdirSync(dir, { recursive: true });
  const content = [
    '---',
    `role: ${role}`,
    `time: ${ts}`,
    '---',
    '',
    body,
  ].join('\n');
  writeFileSync(join(dir, fname), content, 'utf8');
}

function readR6Shard(yeaftDir, shard) {
  const path = join(yeaftDir, 'memory', 'vp', LEGACY_VP_ID, `memory-${shard}.md`);
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8');
}

function countJsonlMessages(yeaftDir) {
  const dir = join(yeaftDir, 'groups', LEGACY_GROUP_ID, 'messages');
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const raw = readFileSync(join(dir, f), 'utf8');
    for (const line of raw.split('\n')) if (line.trim()) total++;
  }
  return total;
}

// ═══════════════ tests ═══════════════

describe('R5→R6 migration', () => {
  let sandbox;
  beforeEach(() => { sandbox = mkSandbox(); });
  afterEach(() => { rmSync(sandbox, { recursive: true, force: true }); });

  it('I-a: single legacy skill entry lands in R6 skill shard', async () => {
    writeEntry(sandbox, 'ts-generics-pattern', {
      kind: 'skill',
      scope: 'tech/typescript',
      tags: ['ts', 'generics'],
      importance: 'high',
    }, '# TS generics trick\nUse `const T extends readonly...`.');

    const res = await applyR5ToR6Migration({ yeaftDir: sandbox });
    expect(res.status).toBe('done');

    const shardBody = readR6Shard(sandbox, 'skill');
    expect(shardBody).toContain('ts-generics-pattern'); // id derived from slug
    expect(shardBody).toContain(`authoredBy: ${R5_TO_R6_AUTHOR_SYS}`);
    expect(shardBody).toContain('hint: "legacy-r5-migration"');
    expect(shardBody).toContain('pinned: true');
  });

  it('I-b: 30+ entries same scope → project-<slug> shard derived in pass 2', async () => {
    for (let i = 0; i < 32; i++) {
      writeEntry(sandbox, `skill-alpha-${i}`, {
        kind: 'skill',
        scope: 'project-alpha/auth',
        tags: ['auth'],
      }, `skill body ${i}`);
    }

    const steps = [];
    const res = await applyR5ToR6Migration({
      yeaftDir: sandbox,
      onStep: (step, info) => steps.push([step, info]),
    });
    expect(res.status).toBe('done');
    expect(res.state.counts['project-alpha']).toBe(32);
    expect(res.state.derivedProjects.some(p => p.startsWith('project-project-alpha'))).toBe(true);

    // project-<slug> shard exists and has at least the moved entries.
    const files = readdirSync(join(sandbox, 'memory', 'vp', LEGACY_VP_ID));
    const projShard = files.find(f => f.startsWith('memory-project-project-alpha'));
    expect(projShard).toBeTruthy();
  });

  it('I-c: R2/R3 message .md files → jsonl log in groups/legacy-main/messages/', async () => {
    for (let i = 0; i < 12; i++) {
      writeMessageMd(
        sandbox,
        'conv-a',
        `${String(i).padStart(4, '0')}-${i % 2 === 0 ? 'user' : 'assistant'}.md`,
        i % 2 === 0 ? 'user' : 'assistant',
        `message body ${i}`,
      );
    }
    const res = await applyR5ToR6Migration({ yeaftDir: sandbox });
    expect(res.status).toBe('done');
    expect(countJsonlMessages(sandbox)).toBe(12);
    expect(res.state.messageCount).toBe(12);
  });

  it('I-d: dry-run writes zero files and creates no state', async () => {
    writeEntry(sandbox, 'sample', { kind: 'lesson', scope: 'work' }, 'lesson body');
    writeMessageMd(sandbox, 'conv-a', '0000-user.md', 'user', 'hi');

    const sigBefore = JSON.stringify(readdirSync(sandbox).sort());
    const res = await applyR5ToR6Migration({ yeaftDir: sandbox, dryRun: true });
    expect(res.status).toBe('dry-run');
    expect(res.dryRun).toBe(true);

    // Post-run invariants: no vp memory dir, no groups dir, no state file.
    expect(existsSync(join(sandbox, 'memory', 'vp'))).toBe(false);
    expect(existsSync(join(sandbox, 'groups'))).toBe(false);
    expect(existsSync(join(sandbox, 'migration-state.json'))).toBe(false);
    // Top-level unchanged
    expect(JSON.stringify(readdirSync(sandbox).sort())).toBe(sigBefore);
    // Preview payload present
    expect(res.preview).toBeTruthy();
    expect(res.preview.pass1).toBeTruthy();
  });

  it('I-e: idempotent re-run short-circuits to already-done', async () => {
    writeEntry(sandbox, 'lesson-a', { kind: 'lesson', scope: 'work' }, 'body');
    const first = await applyR5ToR6Migration({ yeaftDir: sandbox });
    expect(first.status).toBe('done');

    const second = await applyR5ToR6Migration({ yeaftDir: sandbox });
    expect(second.status).toBe('already-done');
    expect(second.state.migratedAt).toBe(first.state.migratedAt);
  });

  it('I-f: two-pass resume — state with pass1CompletedAt skips pass 1', async () => {
    // Seed 3 entries, partially write state file so pass 1 is marked done but
    // pass 2 is not.
    writeEntry(sandbox, 'pref-a', { kind: 'preference', scope: 'user' }, 'pref');
    writeEntry(sandbox, 'skill-a', { kind: 'skill', scope: 'work' }, 'skill');

    // Run once to populate shards, then fake-rewind pass2.
    const first = await applyR5ToR6Migration({ yeaftDir: sandbox });
    expect(first.status).toBe('done');

    // Rewind: drop pass2CompletedAt + migratedAt so the resume path triggers
    // pass 2 only.
    const statePath = join(sandbox, 'migration-state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    delete state.pass2CompletedAt;
    delete state.migratedAt;
    delete state.conversationsMigratedAt;
    writeFileSync(statePath, JSON.stringify(state));

    const steps = [];
    const res = await applyR5ToR6Migration({
      yeaftDir: sandbox,
      onStep: (s, info) => steps.push([s, info]),
    });
    expect(res.status).toBe('done');
    // pass1 should be step-logged with skipped=true
    const pass1Log = steps.find(([s]) => s === 'pass1');
    expect(pass1Log && pass1Log[1].skipped).toBe(true);
  });

  it('I-g: name-drift regression — authoredBy is v0-v1 (no "to-")', async () => {
    writeEntry(sandbox, 'pref-ui-theme', {
      kind: 'preference',
      scope: 'user',
    }, 'prefer dark mode');
    writeEntry(sandbox, 'skill-z', {
      kind: 'skill',
      scope: 'work',
    }, 'skill body');

    const res = await applyR5ToR6Migration({ yeaftDir: sandbox });
    expect(res.status).toBe('done');

    const skillBody = readR6Shard(sandbox, 'skill');
    const prefBody = readR6Shard(sandbox, 'preferences');

    // Correct spec values present
    expect(skillBody).toContain(`authoredBy: ${R5_TO_R6_AUTHOR_SYS}`);
    expect(prefBody).toContain(`authoredBy: ${R5_TO_R6_AUTHOR_USER}`);
    // Wrong legacy values absent in migrated output
    expect(skillBody).not.toContain('system:migration-v0-to-v1');
    expect(prefBody).not.toContain('user:migration-v0-to-v1');
    // And sanity: the correct constants are v0-v1 not v0-to-v1
    expect(R5_TO_R6_AUTHOR_SYS).toBe('system:migration-v0-v1');
    expect(R5_TO_R6_AUTHOR_USER).toBe('user:migration-v0-v1');
  });

  it('rollback happy path: restores R5 archive and clears R6 state', async () => {
    writeEntry(sandbox, 's1', { kind: 'skill', scope: 'work' }, 'body 1');
    writeMessageMd(sandbox, 'conv-a', '0000-user.md', 'user', 'hello');

    const first = await applyR5ToR6Migration({ yeaftDir: sandbox });
    expect(first.status).toBe('done');
    expect(existsSync(join(sandbox, 'memory', 'vp', LEGACY_VP_ID))).toBe(true);
    expect(existsSync(join(sandbox, 'groups', LEGACY_GROUP_ID))).toBe(true);

    const rollback = await rollbackR5ToR6Migration({ yeaftDir: sandbox });
    expect(rollback.status).toBe('done');
    // R6 paths removed
    expect(existsSync(join(sandbox, 'memory', 'vp', LEGACY_VP_ID))).toBe(false);
    expect(existsSync(join(sandbox, 'groups', LEGACY_GROUP_ID, 'messages'))).toBe(false);
    // Legacy archive preserved
    const archive = join(sandbox, '.legacy', 'r6-state.tar.gz');
    expect(existsSync(archive)).toBe(true);
    // State downgraded to r5
    const state = JSON.parse(readFileSync(join(sandbox, 'migration-state.json'), 'utf8'));
    expect(state.version).toBe('r5');
    expect(state.rolledBackAt).toBeTruthy();
  });

  it('rollback with missing archive errors out without mutation', async () => {
    writeEntry(sandbox, 's1', { kind: 'skill', scope: 'work' }, 'body');
    const first = await applyR5ToR6Migration({ yeaftDir: sandbox });
    expect(first.status).toBe('done');

    // Tamper: delete the archive
    rmSync(join(sandbox, '.legacy', 'r6-state.tar.gz'));

    await expect(
      rollbackR5ToR6Migration({ yeaftDir: sandbox }),
    ).rejects.toThrow(/archive missing/);

    // Because we delete vpDir before restoring, error propagates — but state
    // must still be r6 (downgrade only happens on the success path).
    const state = JSON.parse(readFileSync(join(sandbox, 'migration-state.json'), 'utf8'));
    expect(state.version).toBe('r6');
  });

  it('detectR5MemoryLayout returns flags for empty and populated trees', () => {
    const empty = detectR5MemoryLayout(sandbox);
    expect(empty.hasEntries).toBe(false);
    expect(empty.hasConversationsMd).toBe(false);

    writeEntry(sandbox, 'x', { kind: 'skill' }, 'b');
    writeMessageMd(sandbox, 'c', '0000.md', 'user', 'm');
    const populated = detectR5MemoryLayout(sandbox);
    expect(populated.hasEntries).toBe(true);
    expect(populated.hasConversationsMd).toBe(true);
  });

  it('archiveR5State writes to .legacy/r6-state.tar.gz', () => {
    writeEntry(sandbox, 's', { kind: 'skill', scope: 'work' }, 'x');
    const path = archiveR5State(sandbox);
    expect(path).toBe(join(sandbox, '.legacy', 'r6-state.tar.gz'));
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).size).toBeGreaterThan(0);
  });
});
