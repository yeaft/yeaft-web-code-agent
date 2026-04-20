/**
 * v0-to-v1.js — Legacy Yeaft → R6 group-chat layout migration.
 *
 * Spec: .crew/context/task-334i-migration-spec.md
 *
 *   await runMigration({ yeaftDir, dryRun, force, onStep })
 *
 * Behaviour (full spec in §M5):
 *   - hardlink legacy files into `.backup/v0-<ts>/` before writing;
 *   - seed virtual-persons/unify-legacy/, groups/legacy-main/, user/memory/;
 *   - migrate conversation messages, memory entries, task directories;
 *   - state marker `.migration-state.json` allows resume;
 *   - on any throw, rollback = delete new tree (legacy is never touched).
 *
 * The migration only READS from the legacy tree and WRITES to the new
 * tree (groups/, virtual-persons/, user/). It never deletes or moves
 * legacy files — failure recovery is always "delete the new tree and
 * re-run".
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  rmSync,
  linkSync,
  copyFileSync,
} from 'fs';
import { join, relative, dirname, basename } from 'path';

import { openLog, openShardStore } from '../storage/index.js';
import { detect } from './detect.js';
import {
  parseFrontmatter,
  mapMessageMdToJsonl,
  mapMemoryEntry,
  mapTaskMeta,
  splitCoordinatorTurns,
  LEGACY_GROUP_ID,
  LEGACY_VP_ID,
} from './map-fields.js';

const MIGRATION_VERSION = 'v0-to-v1';
const STATE_FILE = '.migration-state.json';

const LEGACY_ROLE_TEMPLATE = `---
id: unify-legacy
name: Unify (legacy)
emoji: 🏛️
color: "#8888AA"
description: 归档自 v0 单 Unify session
model_preference: null
capabilities:
  tools_allow: ["*"]
  tools_deny: []
  skills_allow: ["*"]
tone: ""
---

## Persona
（空 persona — 仅作为归档目标，不参与新群聊协作）
`;

const MEMORY_SCHEMA = {
  shards: [
    'skill',
    'preferences',
    'relations',
    'lessons',
    'project-legacy',
  ],
  defaultSoftCap: { entries: 1000, bytes: 1024 * 1024 },
};

const USER_MEMORY_SCHEMA = {
  shards: ['preferences'],
  defaultSoftCap: { entries: 500, bytes: 256 * 1024 },
};

const STEP_NAMES = [
  'backup',
  'seedVp',
  'seedGroup',
  'migrateMessages',
  'migrateMemory',
  'migrateTasks',
  'migrateUserMemory',
  'finalize',
];

/**
 * Main entry point.
 *
 * @param {object} opts
 * @param {string} opts.yeaftDir — required.
 * @param {boolean} [opts.dryRun=false] — preview only; writes nothing.
 * @param {boolean} [opts.force=false] — ignore and clear state marker.
 * @param {(step, info)=>void} [opts.onStep] — progress callback.
 * @returns {Promise<{status, report, state, dryRun}>}
 */
export async function runMigration({ yeaftDir, dryRun = false, force = false, onStep } = {}) {
  if (!yeaftDir || typeof yeaftDir !== 'string') {
    throw new Error('runMigration: yeaftDir (string) required');
  }
  if (!existsSync(yeaftDir)) {
    throw new Error(`runMigration: yeaftDir does not exist: ${yeaftDir}`);
  }

  const report = detect(yeaftDir);
  const log = typeof onStep === 'function' ? onStep : () => {};

  // Empty home → nothing to do.
  if (report.empty) {
    log('noop', { reason: 'empty home, nothing to migrate' });
    return { status: 'noop', report, state: null, dryRun };
  }

  // Dry-run: walk steps but write nothing.
  if (dryRun) {
    const preview = buildDryRunPreview(report);
    log('dry-run', preview);
    return { status: 'dry-run', report, state: null, dryRun: true, preview };
  }

  const statePath = join(yeaftDir, STATE_FILE);
  if (force && existsSync(statePath)) rmSync(statePath);

  let state = loadState(statePath);
  if (state && state.completedAt) {
    log('already-done', { completedAt: state.completedAt });
    return { status: 'already-done', report, state, dryRun };
  }
  if (!state) {
    state = freshState();
    saveState(statePath, state);
  }

  try {
    // ─── Step 1: hardlink backup ──────────────────
    if (state.steps.backup.status !== 'done') {
      const backupRel = runBackupStep(yeaftDir, report, state);
      state.steps.backup.status = 'done';
      state.steps.backup.path = backupRel;
      state.steps.backup.completedAt = nowIso();
      saveState(statePath, state);
      log('backup', { path: backupRel });
    }

    // ─── Step 2: seed VP ──────────────────
    if (state.steps.seedVp.status !== 'done') {
      seedVp(yeaftDir);
      state.steps.seedVp.status = 'done';
      state.steps.seedVp.completedAt = nowIso();
      saveState(statePath, state);
      log('seedVp', { vpId: LEGACY_VP_ID });
    }

    // ─── Step 3: seed group ──────────────────
    if (state.steps.seedGroup.status !== 'done') {
      seedGroup(yeaftDir);
      state.steps.seedGroup.status = 'done';
      state.steps.seedGroup.completedAt = nowIso();
      saveState(statePath, state);
      log('seedGroup', { groupId: LEGACY_GROUP_ID });
    }

    // ─── Step 4: migrate messages ──────────────────
    if (state.steps.migrateMessages.status !== 'done') {
      state.steps.migrateMessages.status = 'in_progress';
      const migrated = migrateMessagesStep(yeaftDir, report, state);
      state.steps.migrateMessages.status = 'done';
      state.steps.migrateMessages.count = migrated;
      state.steps.migrateMessages.completedAt = nowIso();
      saveState(statePath, state);
      log('migrateMessages', { count: migrated });
    }

    // ─── Step 5: migrate memory ──────────────────
    if (state.steps.migrateMemory.status !== 'done') {
      state.steps.migrateMemory.status = 'in_progress';
      const { migrated, errors } = migrateMemoryStep(yeaftDir, report, state);
      state.steps.migrateMemory.status = 'done';
      state.steps.migrateMemory.count = migrated;
      state.steps.migrateMemory.errors = errors;
      state.steps.migrateMemory.completedAt = nowIso();
      saveState(statePath, state);
      log('migrateMemory', { count: migrated, errors: errors.length });
    }

    // ─── Step 6: migrate tasks ──────────────────
    if (state.steps.migrateTasks.status !== 'done') {
      state.steps.migrateTasks.status = 'in_progress';
      const migrated = migrateTasksStep(yeaftDir, report, state);
      state.steps.migrateTasks.status = 'done';
      state.steps.migrateTasks.count = migrated;
      state.steps.migrateTasks.completedAt = nowIso();
      saveState(statePath, state);
      log('migrateTasks', { count: migrated });
    }

    // ─── Step 7: migrate user memory ──────────────────
    if (state.steps.migrateUserMemory.status !== 'done') {
      state.steps.migrateUserMemory.status = 'in_progress';
      const migrated = migrateUserMemoryStep(yeaftDir, report, state);
      state.steps.migrateUserMemory.status = 'done';
      state.steps.migrateUserMemory.count = migrated;
      state.steps.migrateUserMemory.completedAt = nowIso();
      saveState(statePath, state);
      log('migrateUserMemory', { count: migrated });
    }

    // ─── Step 8: finalize ──────────────────
    state.steps.finalize.status = 'done';
    state.steps.finalize.completedAt = nowIso();
    state.completedAt = nowIso();
    saveState(statePath, state);
    log('finalize', { completedAt: state.completedAt });

    return { status: 'done', report, state, dryRun };
  } catch (err) {
    rollback(yeaftDir);
    resetState(statePath, err);
    throw err;
  }
}

// ═══════════════ steps ═══════════════

function runBackupStep(yeaftDir, report, state) {
  const ts = state.startedAt.replace(/[-:T]/g, '').replace(/\..+Z$/, '').replace(/Z$/, '');
  const backupDir = join(yeaftDir, '.backup', `v0-${ts}`);
  mkdirSync(backupDir, { recursive: true });

  const files = collectBackupFiles(report);
  for (const absPath of files) {
    const rel = relative(yeaftDir, absPath);
    const dest = join(backupDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    try {
      linkSync(absPath, dest);
    } catch {
      // Cross-filesystem or other linkSync failure → fallback to copy.
      try { copyFileSync(absPath, dest); } catch { /* ignore unreadable */ }
    }
  }
  return relative(yeaftDir, backupDir);
}

function collectBackupFiles(report) {
  const out = [];
  const add = (v) => {
    if (Array.isArray(v)) out.push(...v.filter(Boolean));
    else if (v) out.push(v);
  };
  add(report.paths.messages);
  add(report.paths.cold);
  add(report.paths.conversationIndex);
  add(report.paths.conversationCompact);
  add(report.paths.memoryEntries);
  add(report.paths.memoryAggregate);
  add(report.paths.userPreferences);
  add(report.paths.scopes);
  add(report.paths.threads);
  add(report.paths.threadsIndex);
  add(report.paths.tasksIndex);
  add(report.paths.tasksPlan);
  for (const t of report.paths.taskDirs) {
    if (t.meta) out.push(t.meta);
    if (t.coordinator) out.push(t.coordinator);
  }
  return out;
}

function seedVp(yeaftDir) {
  const vpDir = join(yeaftDir, 'virtual-persons', LEGACY_VP_ID);
  mkdirSync(vpDir, { recursive: true });
  mkdirSync(join(vpDir, 'memory'), { recursive: true });
  writeFileSync(join(vpDir, 'role.md'), LEGACY_ROLE_TEMPLATE, 'utf8');
  writeFileSync(
    join(vpDir, 'state.json'),
    JSON.stringify({ runtime: {}, lastMigratedAt: nowIso() }, null, 2),
    'utf8',
  );
}

function seedGroup(yeaftDir) {
  const groupDir = join(yeaftDir, 'groups', LEGACY_GROUP_ID);
  mkdirSync(groupDir, { recursive: true });
  mkdirSync(join(groupDir, 'messages'), { recursive: true });
  mkdirSync(join(groupDir, 'tasks'), { recursive: true });
  writeFileSync(
    join(groupDir, 'group.json'),
    JSON.stringify({
      id: LEGACY_GROUP_ID,
      name: 'Legacy Main',
      roster: [LEGACY_VP_ID],
      defaultVpId: LEGACY_VP_ID,
      createdAt: nowIso(),
    }, null, 2),
    'utf8',
  );
}

function migrateMessagesStep(yeaftDir, report, state) {
  const messagesDir = join(yeaftDir, 'groups', LEGACY_GROUP_ID, 'messages');
  const log = openLog(messagesDir, {});

  // threadId → legacy taskId mapping is captured here from threads/<id>.md
  // frontmatter `taskId` field (task-307a). Absent frontmatter → null.
  const threadTaskMap = new Map();
  for (const tPath of report.paths.threads) {
    const raw = safeRead(tPath);
    const { meta } = parseFrontmatter(raw);
    if (meta && meta.id && meta.taskId) {
      threadTaskMap.set(meta.id, String(meta.taskId));
    }
  }

  // Gather message md inputs: messages/ + cold/. Sort by frontmatter time
  // when available, otherwise by filename.
  const all = [...report.paths.messages, ...report.paths.cold]
    .map((p) => {
      const raw = safeRead(p);
      const { meta, body } = parseFrontmatter(raw);
      const originalId = basename(p, '.md');
      return { path: p, meta, body, originalId };
    })
    .sort((a, b) => {
      const ta = a.meta?.time || '';
      const tb = b.meta?.time || '';
      if (ta && tb) return ta < tb ? -1 : ta > tb ? 1 : 0;
      return a.originalId.localeCompare(b.originalId);
    });

  // Resume support: cursor = last successfully migrated original file.
  const cursor = state.steps.migrateMessages.cursor || null;
  const alreadySeen = cursor
    ? new Set(collectAlreadyAppendedIds(messagesDir))
    : new Set();

  let count = 0;
  for (const item of all) {
    const fallbackTaskId = item.meta?.threadId
      ? (threadTaskMap.get(item.meta.threadId) || null)
      : null;
    const row = mapMessageMdToJsonl({
      meta: item.meta,
      body: item.body,
      originalId: item.originalId,
      fallbackTaskId,
    });
    if (alreadySeen.has(row.id)) {
      state.steps.migrateMessages.cursor = relative(yeaftDir, item.path);
      continue;
    }
    log.append(row);
    count += 1;
    state.steps.migrateMessages.cursor = relative(yeaftDir, item.path);
  }
  log.close();
  return count;
}

function collectAlreadyAppendedIds(messagesDir) {
  if (!existsSync(messagesDir)) return [];
  const ids = [];
  for (const name of readdirSync(messagesDir)) {
    if (!/^\d+\.jsonl$/.test(name)) continue;
    const raw = safeRead(join(messagesDir, name));
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.id) ids.push(obj.id);
      } catch { /* skip malformed line */ }
    }
  }
  return ids;
}

function migrateMemoryStep(yeaftDir, report, state) {
  const memDir = join(yeaftDir, 'virtual-persons', LEGACY_VP_ID, 'memory');
  const store = openShardStore(memDir, MEMORY_SCHEMA);

  const errors = [];
  let migrated = 0;
  const now = nowIso();
  for (const p of report.paths.memoryEntries) {
    const raw = safeRead(p);
    const { meta, body } = parseFrontmatter(raw);
    if (!meta) {
      errors.push({ file: relative(yeaftDir, p), reason: 'frontmatter parse failed' });
      continue;
    }
    const id = `mem_legacy_${safeId(meta.name || basename(p, '.md'))}`;
    try {
      const mapped = mapMemoryEntry({ meta, body, id, now });
      if (!mapped) {
        errors.push({ file: relative(yeaftDir, p), reason: 'mapMemoryEntry returned null' });
        continue;
      }
      store.put(mapped.entry);
      migrated += 1;
    } catch (err) {
      errors.push({ file: relative(yeaftDir, p), reason: String(err && err.message || err) });
    }
  }
  return { migrated, errors };
}

function migrateTasksStep(yeaftDir, report, state) {
  let count = 0;
  for (const td of report.paths.taskDirs) {
    const destDir = join(yeaftDir, 'groups', LEGACY_GROUP_ID, 'tasks', td.id);
    mkdirSync(destDir, { recursive: true });
    mkdirSync(join(destDir, 'messages'), { recursive: true });
    mkdirSync(join(destDir, 'summaries'), { recursive: true });

    // task.json
    const metaRaw = td.meta ? safeRead(td.meta) : '';
    const { meta } = parseFrontmatter(metaRaw);
    const taskJson = mapTaskMeta({ meta, taskId: td.id });
    writeFileSync(join(destDir, 'task.json'), JSON.stringify(taskJson, null, 2), 'utf8');

    // summaries/current.json placeholder
    writeFileSync(
      join(destDir, 'summaries', 'current.json'),
      JSON.stringify({ head: null, chain: [] }, null, 2),
      'utf8',
    );

    // coordinator.md → messages jsonl
    if (td.coordinator) {
      const log = openLog(join(destDir, 'messages'), {});
      const turns = splitCoordinatorTurns(safeRead(td.coordinator));
      let i = 0;
      for (const turn of turns) {
        i += 1;
        log.append({
          id: `msg_legacy_task_${td.id}_${String(i).padStart(3, '0')}`,
          ts: turn.ts,
          type: 'chat',
          authorKind: turn.role === 'user' ? 'user' : 'vp',
          authorId: turn.role === 'user' ? 'user:self' : LEGACY_VP_ID,
          groupId: LEGACY_GROUP_ID,
          taskId: td.id,
          body: turn.body,
          mentions: [],
          replyTo: null,
          viaTool: null,
          _legacyRole: turn.role,
        });
      }
      log.close();
    }
    count += 1;
  }
  return count;
}

function migrateUserMemoryStep(yeaftDir, report, state) {
  // Seed user/profile.json
  const userDir = join(yeaftDir, 'user');
  mkdirSync(userDir, { recursive: true });
  const profilePath = join(userDir, 'profile.json');
  if (!existsSync(profilePath)) {
    writeFileSync(
      profilePath,
      JSON.stringify({ id: 'self', name: null, createdAt: nowIso() }, null, 2),
      'utf8',
    );
  }

  // user/memory shard-store with MEMORY.md + user-preferences.md merged.
  const memDir = join(userDir, 'memory');
  mkdirSync(memDir, { recursive: true });
  const store = openShardStore(memDir, USER_MEMORY_SCHEMA);

  const parts = [];
  if (report.paths.memoryAggregate) parts.push(safeRead(report.paths.memoryAggregate));
  if (report.paths.userPreferences) parts.push(safeRead(report.paths.userPreferences));
  if (parts.length === 0) return 0;

  const body = parts.join('\n\n---\n\n');
  store.put({
    id: 'mem_legacy_user_prefs',
    shard: 'preferences',
    body: body.trim(),
    meta: { kind: 'preference', tags: ['legacy'], pinned: true },
  });
  return 1;
}

// ═══════════════ rollback + state ═══════════════

function rollback(yeaftDir) {
  for (const rel of ['groups', 'virtual-persons', join('user', 'memory')]) {
    const p = join(yeaftDir, rel);
    if (existsSync(p)) {
      try { rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

function freshState() {
  const now = nowIso();
  const steps = {};
  for (const name of STEP_NAMES) steps[name] = { status: 'pending' };
  return {
    version: MIGRATION_VERSION,
    startedAt: now,
    steps,
    completedAt: null,
  };
}

function loadState(statePath) {
  if (!existsSync(statePath)) return null;
  try {
    const raw = readFileSync(statePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveState(statePath, state) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
}

function resetState(statePath, err) {
  try {
    writeFileSync(
      statePath,
      JSON.stringify({
        version: MIGRATION_VERSION,
        cleanedAt: nowIso(),
        reason: String(err && err.message || err),
      }, null, 2),
      'utf8',
    );
  } catch { /* ignore */ }
}

function buildDryRunPreview(report) {
  return {
    wouldMigrate: {
      messages: report.counts.messages + report.counts.cold,
      memoryEntries: report.counts.memoryEntries,
      tasks: report.counts.tasks,
      threadsConsumed: report.counts.threads,
      userMemoryFiles: (report.paths.memoryAggregate ? 1 : 0) + (report.paths.userPreferences ? 1 : 0),
    },
    wouldCreate: {
      seedVp: `virtual-persons/${LEGACY_VP_ID}/`,
      seedGroup: `groups/${LEGACY_GROUP_ID}/`,
      userDir: 'user/',
    },
    wouldBackup: countBackupFiles(report),
  };
}

function countBackupFiles(report) {
  return collectBackupFiles(report).length;
}

// ═══════════════ utilities ═══════════════

function safeRead(path) {
  try {
    if (!path || !existsSync(path) || !statSync(path).isFile()) return '';
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function safeId(s) {
  return String(s).replace(/[^A-Za-z0-9_\-]/g, '_').slice(0, 64) || 'anon';
}

function nowIso() {
  return new Date().toISOString();
}
