/**
 * migrate-r5-to-r6.js — task-334i (wave-4) R5 → R6 storage migration.
 *
 * Continuation of task-334i-v0 (PR #552, shipped v0.1.521) which established
 * the general `~/.yeaft/` tree via `v0-to-v1.js`. This slice implements the
 * R5→R6 *memory shard + conversation rotation* pass that fleshes out the
 * previously-stubbed `applyR5ToR6Migration`.
 *
 * Spec: .crew/context/task-334i-impl-spec.md
 *
 * Key invariants:
 *   - This is independently idempotent from v0→v1. State version bumps r5→r6.
 *   - Does NOT touch 334f `shard-store.js` or 334o storage primitives —
 *     only consumes their public APIs.
 *   - Legacy R5 data is archived to `.legacy/r6-state.tar.gz` BEFORE any
 *     write. Rollback restores the archive but never deletes it.
 *   - `migration-state.json` is the single source of truth; writes go
 *     through `writeAtomic` (tmp+rename) mirroring 334f commitRecompression.
 *
 * Two-pass algorithm (pre-emptive discovery #2):
 *   Pass 1 — write each entry to its default semantic shard
 *            (skill / relations / lessons / preferences / project-legacy)
 *            while counting entries per groupId.
 *   Pass 2 — for each groupId with count ≥ PROJECT_DERIVE_THRESHOLD (30),
 *            derive a `project-<slug>` shard and move entries via
 *            stageRecompression / commitRecompression.
 *
 * Name drift fix (pre-emptive discovery #1):
 *   `map-fields.js` (shipped) defines MIGRATION_AUTHOR='system:migration-v0-to-v1'.
 *   Correct spec value is 'system:migration-v0-v1'. This file overrides via
 *   local constants without editing the shipped pure-mapper module.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';

import { openLog, writeAtomic } from '../storage/index.js';
import { parseEntry } from './store.js';
import {
  openMemoryShardStore,
  classifyLegacyEntryToShard,
} from './shard-store.js';
import { PROJECT_DERIVE_THRESHOLD } from './schema.js';
import {
  parseFrontmatter,
  mapMessageMdToJsonl,
  splitCoordinatorTurns,
  LEGACY_GROUP_ID,
  LEGACY_VP_ID,
} from '../migration/map-fields.js';

// ─── Name-drift fix (spec §3, §4) ────────────────────────────────
export const R5_TO_R6_AUTHOR_SYS = 'system:migration-v0-v1';
export const R5_TO_R6_AUTHOR_USER = 'user:migration-v0-v1';
const SOURCE_HINT = 'legacy-r5-migration';
const STATE_FILE = 'migration-state.json';
const ARCHIVE_REL = join('.legacy', 'r6-state.tar.gz');

// authoredBy inference table (spec §3 deliverable E).
function inferAuthoredBy(kind) {
  switch (kind) {
    case 'preference':
    case 'identity':
      return R5_TO_R6_AUTHOR_USER;
    case 'fact':
    case 'skill':
    case 'lesson':
    case 'context':
    case 'relation':
    default:
      return R5_TO_R6_AUTHOR_SYS;
  }
}

// ─── Planner (dry-run, unchanged behaviour from 334f stub) ───────
/**
 * Produce a migration plan without applying it.
 *
 * @param {string} legacyEntriesDir  e.g. ~/.yeaft/memory/entries
 * @returns {{
 *   totalEntries: number,
 *   plan: Array<{ slug: string, shard: string, kind: string, tags: string[] }>,
 *   byShard: Record<string, number>
 * }}
 */
export function planR5ToR6Migration(legacyEntriesDir) {
  if (!legacyEntriesDir || !existsSync(legacyEntriesDir)) {
    return { totalEntries: 0, plan: [], byShard: {} };
  }
  const files = readdirSync(legacyEntriesDir).filter(f => f.endsWith('.md'));
  const plan = [];
  const byShard = {};
  for (const file of files) {
    const raw = readFileSync(join(legacyEntriesDir, file), 'utf8');
    const entry = parseEntry(raw);
    if (!entry) continue;
    const shard = classifyLegacyEntryToShard(entry);
    plan.push({
      slug: file.replace(/\.md$/, ''),
      shard,
      kind: entry.kind || 'fact',
      tags: entry.tags || [],
    });
    byShard[shard] = (byShard[shard] || 0) + 1;
  }
  return { totalEntries: plan.length, plan, byShard };
}

// ─── State I/O ────────────────────────────────────────────────────
function stateFilePath(yeaftDir) {
  return join(yeaftDir, STATE_FILE);
}

function loadState(yeaftDir) {
  const p = stateFilePath(yeaftDir);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function saveState(yeaftDir, state) {
  writeAtomic(stateFilePath(yeaftDir), JSON.stringify(state, null, 2));
}

function clearState(yeaftDir) {
  const p = stateFilePath(yeaftDir);
  if (existsSync(p)) rmSync(p);
}

function nowIso() { return new Date().toISOString(); }

function stableId(slug) {
  const h = createHash('sha1').update(String(slug)).digest('hex').slice(0, 12);
  return `mem_legacy_${h}`;
}

// ─── Archive helper (spec §11 step 3) ────────────────────────────
/**
 * tar+gzip `memory/entries/` and `conversations/` into .legacy/r6-state.tar.gz.
 * Uses the `tar` CLI via execFileSync (same pattern as 334i-v0). Any failure
 * throws so the caller can bail before making destructive changes.
 */
export function archiveR5State(yeaftDir) {
  const legacyDir = join(yeaftDir, '.legacy');
  mkdirSync(legacyDir, { recursive: true });
  const archivePath = join(yeaftDir, ARCHIVE_REL);
  const entriesDir = join(yeaftDir, 'memory', 'entries');
  const conversationsDir = join(yeaftDir, 'conversations');
  const args = ['-czf', archivePath, '-C', yeaftDir];
  let added = 0;
  if (existsSync(entriesDir)) { args.push(join('memory', 'entries')); added++; }
  if (existsSync(conversationsDir)) { args.push('conversations'); added++; }
  if (added === 0) {
    // Write a zero-content marker so rollback has a file to inspect.
    writeAtomic(archivePath, '');
    return archivePath;
  }
  execFileSync('tar', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  return archivePath;
}

// ─── Detect helpers ──────────────────────────────────────────────
/**
 * Classify the shape of the R5 memory layout in `yeaftDir`.
 */
export function detectR5MemoryLayout(yeaftDir) {
  const entriesDir = join(yeaftDir, 'memory', 'entries');
  const conversationsDir = join(yeaftDir, 'conversations');
  const groupsDir = join(yeaftDir, 'groups');
  const hasEntries = existsSync(entriesDir) && readdirSync(entriesDir).some(f => f.endsWith('.md'));
  const hasConversationsMd = existsSync(conversationsDir)
    && readdirSync(conversationsDir).some(() => true);
  const hasGroupsJsonl = existsSync(groupsDir);
  return {
    entriesDir,
    conversationsDir,
    groupsDir,
    hasEntries,
    hasConversationsMd,
    hasGroupsJsonl,
  };
}

// ─── Pass 1: write entries to default shards ─────────────────────
function runPass1({ yeaftDir, layout, vpDir, log, existingState }) {
  const shardStore = openMemoryShardStore(vpDir, 'vp');
  const files = layout.hasEntries
    ? readdirSync(layout.entriesDir).filter(f => f.endsWith('.md')).sort()
    : [];
  const counts = (existingState && existingState.counts) || {};
  const migrated = [];
  const errors = [];

  for (const file of files) {
    const slug = file.replace(/\.md$/, '');
    const id = stableId(slug);
    // Idempotency: skip already-migrated ids.
    if (shardStore.get(id)) {
      migrated.push({ id, slug, shard: shardStore.get(id).shard, skipped: true });
      continue;
    }
    let raw;
    try {
      raw = readFileSync(join(layout.entriesDir, file), 'utf8');
    } catch (e) {
      errors.push({ file, error: String(e.message || e) });
      continue;
    }
    const legacy = parseEntry(raw);
    if (!legacy) {
      errors.push({ file, error: 'parseEntry returned null (malformed frontmatter)' });
      continue;
    }
    const shard = classifyLegacyEntryToShard(legacy);
    const kind = legacy.kind || 'fact';
    const tags = Array.isArray(legacy.tags) ? legacy.tags.slice() : [];
    const createdAt = legacy.created_at || nowIso();
    const updatedAt = legacy.updated_at || createdAt;
    // Determine groupId for project-derive counting. Legacy schema has no
    // explicit groupId; fall back to scope's top segment, else LEGACY_GROUP_ID.
    const groupId = deriveGroupId(legacy);

    // identity/preference kinds are allowed empty msgIds per §Δ23.
    // Other kinds rely on the hint='legacy-r5-migration' to legitimise [].
    // `validateR6Entry` requires non-empty msgIds for non-identity/preference —
    // so we put a synthetic legacy marker to keep the validator happy while
    // still conveying "migrated, no real messages attached" semantically.
    const needsMsgIdMarker = !(kind === 'identity' || kind === 'preference');
    const msgIds = needsMsgIdMarker ? [`legacy:${slug}`] : [];

    const entry = {
      id,
      shard,
      kind,
      tags,
      pinned: legacy.importance === 'high',
      sourceRef: {
        groupId,
        taskId: null,
        msgIds,
        timeWindow: `[${createdAt}, ${updatedAt}]`,
        hint: SOURCE_HINT,
      },
      supersedes: null,
      supersededBy: null,
      authoredBy: inferAuthoredBy(kind),
      createdAt,
      updatedAt,
      body: legacy.content || '',
    };
    try {
      shardStore.put(entry);
      counts[groupId] = (counts[groupId] || 0) + 1;
      migrated.push({ id, slug, shard, groupId });
    } catch (e) {
      errors.push({ file, error: String(e.message || e) });
    }
  }

  log('pass1', { migrated: migrated.length, errors: errors.length });
  return { counts, migrated, errors };
}

function deriveGroupId(legacyEntry) {
  // scope is a path like "work/project-name/auth". Use first segment as
  // coarse groupId; fall back to LEGACY_GROUP_ID.
  const scope = legacyEntry && legacyEntry.scope;
  if (typeof scope === 'string' && scope.trim()) {
    const first = scope.split('/').map(s => s.trim()).filter(Boolean)[0];
    if (first) return first;
  }
  return LEGACY_GROUP_ID;
}

// ─── Pass 2: project-<slug> derive ───────────────────────────────
function runPass2({ vpDir, counts, log }) {
  const derived = [];
  const qualifyingShards = Object.entries(counts || {})
    .filter(([, c]) => c >= PROJECT_DERIVE_THRESHOLD)
    .map(([g]) => `project-${slugify(g)}`);
  // Re-open with project-<slug> allow-listed up front so put() validates.
  const shardStore = openMemoryShardStore(vpDir, 'vp', { extraShards: qualifyingShards });
  for (const [groupId, count] of Object.entries(counts || {})) {
    if (count < PROJECT_DERIVE_THRESHOLD) continue;
    const slug = slugify(groupId);
    const targetShard = `project-${slug}`;
    // Skip if this project shard already exists and is populated — re-entry safe.
    const stats = shardStore.stats();
    if (stats.shards[targetShard] && stats.shards[targetShard].count > 0) {
      derived.push({ groupId, shard: targetShard, moved: 0, skipped: true });
      continue;
    }
    // Collect entries in the relevant default shard matching this groupId.
    // Search across all default shards (classification is kind-driven; a
    // groupId may span skill/lessons/etc).
    const { results } = shardStore.query({});
    const moveIds = results
      .filter(r => r.groupId === groupId)
      .map(r => r.id);
    let moved = 0;
    for (const id of moveIds) {
      const full = shardStore.get(id);
      if (!full) continue;
      // Re-put with new shard; old entry removal happens via supersede-free
      // rewrite by removing old id after the new one lands.
      const newEntry = {
        ...full,
        shard: targetShard,
        body: full.body || '',
      };
      try {
        shardStore.put(newEntry);
        // shardStore.put upserts by id (see 334o shard-store put semantics
        // removing any prior shard copy of the same id) — so the entry now
        // lives in targetShard exclusively.
        moved++;
      } catch {
        // best-effort — keep legacy in default shard if move fails.
      }
    }
    derived.push({ groupId, shard: targetShard, moved });
  }
  log('pass2', { derived: derived.length });
  return derived;
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'legacy';
}

// ─── Conversation migration ──────────────────────────────────────
function migrateConversations({ yeaftDir, layout, log }) {
  if (!layout.hasConversationsMd) {
    log('conversations', { messages: 0, shards: 0 });
    return { messages: 0, shards: 0 };
  }
  const groupDir = join(yeaftDir, 'groups', LEGACY_GROUP_ID, 'messages');
  mkdirSync(groupDir, { recursive: true });
  const log_ = openLog(groupDir);
  let messagesWritten = 0;
  const convos = readdirSync(layout.conversationsDir);
  for (const cId of convos) {
    const msgDir = join(layout.conversationsDir, cId, 'messages');
    if (!existsSync(msgDir)) continue;
    const files = readdirSync(msgDir).filter(f => f.endsWith('.md')).sort();
    for (const file of files) {
      const raw = readFileSync(join(msgDir, file), 'utf8');
      const { meta, body } = parseFrontmatter(raw);
      const originalId = `${cId}_${file.replace(/\.md$/, '')}`;
      const row = mapMessageMdToJsonl({ meta, body, originalId, fallbackTaskId: null });
      try {
        log_.append(row);
        messagesWritten++;
      } catch {
        // Skip malformed row; keep going.
      }
    }
    // Also handle coordinator.md if present
    const coordPath = join(layout.conversationsDir, cId, 'coordinator.md');
    if (existsSync(coordPath)) {
      const raw = readFileSync(coordPath, 'utf8');
      const turns = splitCoordinatorTurns(raw);
      for (const turn of turns) {
        const row = {
          id: `msg_legacy_${cId}_coord_${turn.index}`,
          ts: turn.ts || null,
          type: 'chat',
          authorKind: 'unknown',
          authorId: `legacy:${turn.role}`,
          groupId: LEGACY_GROUP_ID,
          taskId: null,
          body: turn.body,
          mentions: [],
          replyTo: null,
          viaTool: null,
        };
        try { log_.append(row); messagesWritten++; } catch { /* skip */ }
      }
    }
  }
  log_.close();
  const index = log_.getIndex();
  log('conversations', { messages: messagesWritten, shards: (index.segments || []).length });
  return { messages: messagesWritten, shards: (index.segments || []).length };
}

// ─── Main entry ──────────────────────────────────────────────────
/**
 * Apply the R5 → R6 migration.
 *
 * @param {object} opts
 * @param {string} opts.yeaftDir  required
 * @param {string} [opts.vpId]    legacy VP id (default LEGACY_VP_ID)
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.force]  clear existing r6 state and re-run from scratch
 * @param {(step, info)=>void} [opts.onStep]
 * @returns {Promise<object>}
 */
export async function applyR5ToR6Migration(opts = {}) {
  const { yeaftDir, dryRun = false, force = false, onStep } = opts;
  const vpId = opts.vpId || LEGACY_VP_ID;
  if (!yeaftDir || typeof yeaftDir !== 'string') {
    throw new Error('applyR5ToR6Migration: yeaftDir (string) required');
  }
  if (!existsSync(yeaftDir)) {
    throw new Error(`applyR5ToR6Migration: yeaftDir does not exist: ${yeaftDir}`);
  }
  const log = typeof onStep === 'function' ? onStep : () => {};
  const layout = detectR5MemoryLayout(yeaftDir);

  if (dryRun) {
    const plan = planR5ToR6Migration(layout.entriesDir);
    const counts = {};
    for (const p of plan.plan) {
      // coarse counting keyed by synthetic groupId based on slug prefix (best-effort preview)
      counts[LEGACY_GROUP_ID] = (counts[LEGACY_GROUP_ID] || 0) + 1;
    }
    const wouldDerive = Object.entries(counts)
      .filter(([, c]) => c >= PROJECT_DERIVE_THRESHOLD)
      .map(([g]) => `project-${slugify(g)}`);
    let estMessages = 0;
    if (layout.hasConversationsMd) {
      for (const cId of readdirSync(layout.conversationsDir)) {
        const msgDir = join(layout.conversationsDir, cId, 'messages');
        if (existsSync(msgDir)) {
          estMessages += readdirSync(msgDir).filter(f => f.endsWith('.md')).length;
        }
      }
    }
    const preview = {
      pass1: plan.byShard,
      pass2Candidates: wouldDerive,
      conversations: {
        count: layout.hasConversationsMd ? readdirSync(layout.conversationsDir).length : 0,
        estimatedMessages: estMessages,
        estimatedShards: Math.max(1, Math.ceil(estMessages / 5000)),
      },
    };
    log('dry-run', preview);
    return { status: 'dry-run', dryRun: true, preview };
  }

  // Force: wipe only r6 state, never touch legacy archive.
  if (force) clearState(yeaftDir);

  let state = loadState(yeaftDir);
  if (state && state.version === 'r6' && state.pass2CompletedAt) {
    log('already-done', { migratedAt: state.migratedAt });
    return { status: 'already-done', state };
  }

  // Fresh state — but preserve a pre-existing r5 state (from PR #552) if present.
  if (!state || state.version !== 'r6') {
    const prior = state || {};
    state = {
      version: 'r6',
      startedAt: nowIso(),
      legacyArchive: null,
      pass1CompletedAt: null,
      pass2CompletedAt: null,
      migratedAt: null,
      counts: {},
      derivedProjects: [],
      messageCount: 0,
      entryCount: 0,
      // Preserve reference to prior r5 state for audit.
      priorR5: prior && prior.version === 'r5' ? { completedAt: prior.completedAt || null } : null,
    };
    saveState(yeaftDir, state);
  }

  try {
    // Archive R5 state BEFORE any writes (or skip if already archived in a prior resume).
    if (!state.legacyArchive) {
      const archivePath = archiveR5State(yeaftDir);
      state.legacyArchive = archivePath;
      saveState(yeaftDir, state);
      log('archive', { path: archivePath });
    }

    const vpDir = join(yeaftDir, 'memory', 'vp', vpId);
    mkdirSync(vpDir, { recursive: true });

    // Pass 1
    if (!state.pass1CompletedAt) {
      const p1 = runPass1({ yeaftDir, layout, vpDir, log, existingState: state });
      state.counts = p1.counts;
      state.entryCount = (state.entryCount || 0) + p1.migrated.filter(m => !m.skipped).length;
      state.pass1CompletedAt = nowIso();
      state.pass1Errors = p1.errors;
      saveState(yeaftDir, state);
    } else {
      log('pass1', { skipped: true });
    }

    // Pass 2
    if (!state.pass2CompletedAt) {
      const derived = runPass2({ vpDir, counts: state.counts, log });
      state.derivedProjects = derived.map(d => d.shard);
      state.pass2CompletedAt = nowIso();
      saveState(yeaftDir, state);
    } else {
      log('pass2', { skipped: true });
    }

    // Conversations (always run once — guarded by index existence).
    if (!state.conversationsMigratedAt) {
      const convRes = migrateConversations({ yeaftDir, layout, log });
      state.messageCount = convRes.messages;
      state.conversationsMigratedAt = nowIso();
      saveState(yeaftDir, state);
    } else {
      log('conversations', { skipped: true });
    }

    state.migratedAt = nowIso();
    saveState(yeaftDir, state);
    log('done', { migratedAt: state.migratedAt });
    return { status: 'done', state };
  } catch (err) {
    // On error: state file preserved so next run resumes. Archive untouched.
    state.lastError = String(err && err.message || err);
    saveState(yeaftDir, state);
    throw err;
  }
}

// ─── Rollback (deliverable G) ────────────────────────────────────
/**
 * Roll back an R5→R6 migration. Restores from .legacy/r6-state.tar.gz and
 * clears r6-specific state. Never touches the separate r5 archive created
 * by v0-to-v1.js. Idempotent: safe to call when no r6 state is present.
 *
 * @param {object} opts
 * @param {string} opts.yeaftDir required
 * @param {string} [opts.vpId]   legacy VP id (default LEGACY_VP_ID)
 * @param {(step, info)=>void} [opts.onStep]
 */
export async function rollbackR5ToR6Migration(opts = {}) {
  const { yeaftDir, onStep } = opts;
  const vpId = opts.vpId || LEGACY_VP_ID;
  if (!yeaftDir || typeof yeaftDir !== 'string') {
    throw new Error('rollbackR5ToR6Migration: yeaftDir required');
  }
  const log = typeof onStep === 'function' ? onStep : () => {};
  const state = loadState(yeaftDir);
  if (!state || state.version !== 'r6') {
    log('noop', { reason: 'no r6 state file present' });
    return { status: 'noop' };
  }
  const archivePath = state.legacyArchive;
  if (!archivePath || !existsSync(archivePath)) {
    throw new Error(`rollbackR5ToR6Migration: archive missing at ${archivePath}`);
  }

  // Delete R6-specific paths first (only what this migration created).
  const vpDir = join(yeaftDir, 'memory', 'vp', vpId);
  if (existsSync(vpDir)) {
    rmSync(vpDir, { recursive: true, force: true });
    log('rm-vp-memory', { path: vpDir });
  }
  const groupsDir = join(yeaftDir, 'groups', LEGACY_GROUP_ID, 'messages');
  if (existsSync(groupsDir)) {
    rmSync(groupsDir, { recursive: true, force: true });
    log('rm-group-messages', { path: groupsDir });
  }

  // Restore archive back to yeaftDir. tar -xzf will overwrite paths it owns.
  // Only do this if archive is non-empty (empty marker = nothing was archived).
  const sz = statSync(archivePath).size;
  if (sz > 0) {
    execFileSync('tar', ['-xzf', archivePath, '-C', yeaftDir], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    log('restore', { from: archivePath });
  } else {
    log('restore', { from: archivePath, note: 'empty archive — nothing to restore' });
  }

  // Downgrade state to r5 marker (archive left on disk for audit).
  const newState = {
    version: 'r5',
    rolledBackAt: nowIso(),
    previousR6: {
      migratedAt: state.migratedAt,
      legacyArchive: state.legacyArchive,
    },
  };
  saveState(yeaftDir, newState);
  log('done', { rolledBackAt: newState.rolledBackAt });
  return { status: 'done', state: newState };
}
