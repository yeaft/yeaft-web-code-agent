/**
 * migrate/sessions.js — One-shot migration that consolidates legacy on-disk
 * layouts into the current `sessions/`-based shape.
 *
 * Idempotent. Marks completion with `<yeaftDir>/.yeaft-migration.done`.
 * Synchronous: callers (notably initYeaftDir) rely on the migration
 * completing before the engine reads any conversation rows.
 *
 * Steps:
 *   0. Snapshot conversation directories into
 *      `<yeaftDir>/.legacy-backup-<YYYYMMDD>/` so the in-place rewrites
 *      below have a recovery point. Skipped if today's backup exists.
 *   1. ~/.yeaft/groups/<g>/         → ~/.yeaft/sessions/<g>/
 *      group.json → session.json
 *   2. Legacy ~/.yeaft/chats/<c>/ with chat.json → ~/.yeaft/sessions/<c>/
 *      chat.json → session.json
 *   3. ~/.yeaft/memory/group/<g>/   → ~/.yeaft/memory/session/<g>/
 *   4. ~/.yeaft/memory/chat/<c>/    → ~/.yeaft/memory/session/<c>/
 *      Rewrites front-matter `scope:` fields from group/<id> / chat/<id>
 *      → session/<id>.
 *   5. ~/.yeaft/memory/groups/<g>/ams.json → ~/.yeaft/memory/sessions/<g>/ams.json
 *   6. SQLite FTS index `memory_segments.scope` rows: rewrite group/* / chat/*
 *      → session/*.
 *   7. Per-message frontmatter: rewrite `groupId: X` / `chatId: X` →
 *      `sessionId: X` in every `*.md` under `conversation/messages|cold/` and
 *      `sessions/<id>/conversation/messages|cold/`. This is what closes the
 *      loop on PR #881's rename — without it, the parser would have to carry
 *      a permanent `groupId` alias.
 *
 * Collision policy: if `sessions/<x>` already exists, log + skip (we assume
 * a prior partial run already moved it). If both groups/<x> and chats/<x>
 * exist with the same id, bail loudly — that shouldn't happen because
 * group ids are `grp_*` and chat ids are `chat_*`.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { openSegmentIndex } from '../memory/index-db.js';

const SENTINEL = '.yeaft-migration.done';
const SENTINEL_VERSION = 4;

/**
 * Run the sessions migration. No-op when sentinel exists.
 *
 * Synchronous: the per-message frontmatter rewrite (step 7) MUST finish
 * before any conversation row is loaded, otherwise the parser would drop
 * legacy `groupId:` rows. Keeping this synchronous lets initYeaftDir stay
 * synchronous too — its 5+ callers all expect that.
 *
 * @param {string} yeaftDir
 * @returns {{ migrated: boolean, moved: number, frontmatterRewrites: number, warnings: string[] }}
 */
export function migrateSessions(yeaftDir) {
  const warnings = [];
  if (!yeaftDir || !existsSync(yeaftDir)) {
    return { migrated: false, moved: 0, frontmatterRewrites: 0, warnings: ['yeaftDir missing'] };
  }
  const sentinel = join(yeaftDir, SENTINEL);
  if (existsSync(sentinel)) {
    // Version-aware: ignore a sentinel from an older schema. Future v3
    // migrations can run on v2-completed trees because they read what
    // we wrote and decide for themselves whether to re-execute.
    let v = 0;
    try { v = JSON.parse(readFileSync(sentinel, 'utf8'))?.version ?? 0; } catch { /* corrupt sentinel — treat as 0 */ }
    if (v >= SENTINEL_VERSION) {
      return { migrated: false, moved: 0, frontmatterRewrites: 0, warnings: [] };
    }
  }

  // Step 0 — backup conversation dirs before any in-place rewrite.
  // Only operates on the conversation tree (the only thing step 7 touches
  // in-place); directory renames in steps 1–5 don't need a backup because
  // they're reversible by moving the directory back.
  const backupRoot = join(yeaftDir, `.legacy-backup-${ymdLocal(new Date())}`);
  backupConversationTrees(yeaftDir, backupRoot, warnings);

  const sessionsRoot = join(yeaftDir, 'sessions');
  const groupsRoot = join(yeaftDir, 'groups');
  const chatsRoot = join(yeaftDir, 'chats');
  const memoryRoot = join(yeaftDir, 'memory');
  const memSessionRoot = join(memoryRoot, 'session');
  const memSessionsAmsRoot = join(memoryRoot, 'sessions');

  if (!existsSync(sessionsRoot)) mkdirSync(sessionsRoot, { recursive: true });
  if (!existsSync(memSessionRoot)) mkdirSync(memSessionRoot, { recursive: true });
  if (!existsSync(memSessionsAmsRoot)) mkdirSync(memSessionsAmsRoot, { recursive: true });

  // ID collision check
  const groupIds = listDirs(groupsRoot);
  const chatIds = listLegacyChatDirs(chatsRoot);
  const overlap = groupIds.filter((id) => chatIds.includes(id));
  if (overlap.length > 0) {
    throw new Error(`sessions migration: id collision between groups/ and chats/: ${overlap.join(',')}`);
  }

  let moved = 0;

  // Reconcile any half-migrated sessions/<id>/ from a prior crash, including
  // v3's wrong `meta.json` target. Repair before moving on so the session is
  // usable post-migration.
  for (const id of listDirs(sessionsRoot)) {
    const dst = join(sessionsRoot, id);
    reconcileSessionMetadataDir(dst, warnings, `sessions/${id}`, {
      meta: `reconciled wrong meta.json at sessions/${id}`,
      group: `reconciled partial migration at sessions/${id}`,
      chat: `reconciled partial migration at sessions/${id}`,
    });
  }

  // 1. groups/<g>/ → sessions/<g>/
  for (const id of groupIds) {
    const src = join(groupsRoot, id);
    const dst = join(sessionsRoot, id);
    if (existsSync(dst)) {
      // Partial-run reconcile: if session.json is missing or invalid, retry
      // the rewrite from legacy files at the destination. Avoids permanently
      // broken sessions when a prior run crashed mid-rewrite.
      const reconciled = reconcileSessionMetadataDir(dst, warnings, `sessions/${id}`, {
        meta: `reconciled wrong meta.json at sessions/${id}`,
        group: `reconciled partial migration at sessions/${id}`,
        chat: `reconciled partial migration at sessions/${id}`,
      });
      if (!reconciled) {
        warnings.push(`sessions/${id} already exists; skipping groups/${id}`);
      }
      continue;
    }
    renameSync(src, dst);
    rewriteGroupMetaToSessionJson(dst, warnings);
    moved++;
  }

  // 2. chats/<c>/ → sessions/<c>/
  for (const id of chatIds) {
    const src = join(chatsRoot, id);
    const dst = join(sessionsRoot, id);
    if (existsSync(dst)) {
      const reconciled = reconcileSessionMetadataDir(dst, warnings, `sessions/${id}`, {
        meta: `reconciled wrong meta.json at sessions/${id}`,
        group: `reconciled partial migration at sessions/${id}`,
        chat: `reconciled partial migration at sessions/${id}`,
      });
      if (!reconciled) {
        warnings.push(`sessions/${id} already exists; skipping chats/${id}`);
      }
      continue;
    }
    renameSync(src, dst);
    rewriteChatMetaToSessionJson(dst, warnings);
    moved++;
  }

  // 3+4. memory/{group,chat}/<id>/ → memory/session/<id>/
  for (const family of ['group', 'chat']) {
    const root = join(memoryRoot, family);
    if (!existsSync(root)) continue;
    const ids = family === 'chat' ? chatIds.filter((id) => existsSync(join(root, id))) : listDirs(root);
    for (const id of ids) {
      const src = join(root, id);
      const dst = join(memSessionRoot, id);
      if (existsSync(dst)) {
        warnings.push(`memory/session/${id} already exists; skipping memory/${family}/${id}`);
        continue;
      }
      renameSync(src, dst);
      rewriteSegmentScopes(dst, family, id, warnings);
    }
  }

  // 5. memory/groups/<g>/ams.json → memory/sessions/<g>/ams.json
  const amsGroupRoot = join(memoryRoot, 'groups');
  if (existsSync(amsGroupRoot)) {
    for (const id of listDirs(amsGroupRoot)) {
      const srcDir = join(amsGroupRoot, id);
      const dstDir = join(memSessionsAmsRoot, id);
      if (existsSync(dstDir)) {
        warnings.push(`memory/sessions/${id} already exists; skipping memory/groups/${id}`);
        continue;
      }
      renameSync(srcDir, dstDir);
    }
  }
  const amsChatRoot = join(memoryRoot, 'chats');
  if (existsSync(amsChatRoot)) {
    for (const id of chatIds.filter((chatId) => existsSync(join(amsChatRoot, chatId)))) {
      const srcDir = join(amsChatRoot, id);
      const dstDir = join(memSessionsAmsRoot, id);
      if (existsSync(dstDir)) {
        warnings.push(`memory/sessions/${id} already exists; skipping memory/chats/${id}`);
        continue;
      }
      renameSync(srcDir, dstDir);
    }
  }

  // 6. Rewrite SQLite FTS index scope strings via the shared index-db module
  //    (which already handles ABI loading). Idempotent: WHERE clause skips
  //    already-rewritten rows. Synchronous: better-sqlite3 has no async API.
  rewriteFtsScopes(memoryRoot, warnings, { legacyChatIds: chatIds });

  // 7. Per-message frontmatter rewrite. Walks both the legacy flat
  //    conversation directory and every per-session conversation directory
  //    so that any pre-rename row still on disk gets the new key shape.
  let frontmatterRewrites = rewriteAllMessageFrontmatter(yeaftDir, warnings);

  // 8. Cleanup: if this is rerunning after a v2 sentinel, legacy groups/ or
  //    chats/ directories may have been recreated. Merge non-duplicate files
  //    into sessions/<id>, then remove empty legacy directories.
  const cleanup = cleanupLegacySessionDirs(yeaftDir, warnings);
  moved += cleanup.moved;
  reconcileSessionMetadataDirs(sessionsRoot, warnings);
  frontmatterRewrites += rewriteAllMessageFrontmatter(yeaftDir, warnings);

  // 9. Sentinel — version 4 = current session.json schema plus legacy cleanup.
  writeFileSync(sentinel, JSON.stringify({
    version: SENTINEL_VERSION,
    migratedAt: new Date().toISOString(),
    moved,
    frontmatterRewrites,
    warnings,
  }, null, 2), 'utf8');

  return { migrated: true, moved, frontmatterRewrites, warnings };
}

/** YYYYMMDD in local time. */
function ymdLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/**
 * Snapshot the conversation trees so step 7's in-place frontmatter rewrite
 * is reversible. Only the dirs step 7 touches get backed up — directory
 * renames in steps 1–5 are reversible by moving the directory back.
 *
 * Skips per-source-dir if the destination already exists (resume safety).
 */
function backupConversationTrees(yeaftDir, backupRoot, warnings) {
  const sources = [
    join(yeaftDir, 'conversation'),
    join(yeaftDir, 'chat'),
    join(yeaftDir, 'sessions'),
    // Step 1/2 move groups/<g>/ and chats/<c>/ into sessions/<x>/, and
    // step 7 then rewrites *.md inside the moved trees. Without backing
    // these up at step 0, a regex bug would silently destroy the only
    // copy of pre-rename conversation messages.
    join(yeaftDir, 'groups'),
    join(yeaftDir, 'chats'),
  ];
  for (const src of sources) {
    if (!existsSync(src)) continue;
    const rel = src.slice(yeaftDir.length + 1);
    const dst = join(backupRoot, rel);
    if (existsSync(dst)) continue; // resume / second run today
    try {
      mkdirSync(dst, { recursive: true });
      cpSync(src, dst, { recursive: true });
    } catch (err) {
      warnings.push(`backup ${src} → ${dst} failed: ${err.message}`);
    }
  }
}

function rewriteFtsScopes(memoryRoot, warnings, { legacyChatIds = [] } = {}) {
  const dbPath = join(memoryRoot, 'index.db');
  if (!existsSync(dbPath)) return;
  // Best-effort: index-db.js is the single ABI-load site, so we route through
  // it. Errors here are non-fatal — the FTS index can be rebuilt at runtime.
  let idx;
  try {
    idx = openSegmentIndex(dbPath);
  } catch (err) {
    warnings.push(`FTS rewrite skipped: ${err.message}`);
    return;
  }
  try {
    const db = idx._db;
    db.exec('BEGIN');
    db.exec("UPDATE memory_segments SET scope = REPLACE(scope, 'group/', 'session/') WHERE scope LIKE 'group/%'");
    const stmt = db.prepare(`
      UPDATE memory_segments
      SET scope = ? || substr(scope, ?)
      WHERE scope = ? OR scope LIKE ?
    `);
    for (const id of legacyChatIds) {
      const from = `chat/${id}`;
      const to = `session/${id}`;
      stmt.run(to, from.length + 1, from, `${from}/%`);
    }
    db.exec('COMMIT');
  } catch (err) {
    try { idx._db.exec('ROLLBACK'); } catch { /* ignore */ }
    warnings.push(`FTS scope rewrite failed: ${err.message}`);
  } finally {
    try { idx.close(); } catch { /* ignore */ }
  }
}

/**
 * Rewrite legacy conversation ids (`groupId` / `chatId`) to `sessionId` in
 * every message frontmatter under the known conversation directories. Returns
 * the number of files mutated.
 *
 * Idempotent: a second run finds nothing to rewrite and returns 0.
 */
function rewriteAllMessageFrontmatter(yeaftDir, warnings) {
  let count = 0;
  const dirs = [];
  // Legacy flat layout.
  for (const sub of ['messages', 'cold']) {
    const d = join(yeaftDir, 'conversation', sub);
    if (existsSync(d)) dirs.push(d);
  }
  // Defensive: chat mode dir (empty in production today, but cheap to scan).
  for (const sub of ['messages', 'cold']) {
    const d = join(yeaftDir, 'chat', sub);
    if (existsSync(d)) dirs.push(d);
  }
  // Per-session layout.
  const sessionsRoot = join(yeaftDir, 'sessions');
  if (existsSync(sessionsRoot)) {
    for (const id of listDirs(sessionsRoot)) {
      for (const sub of ['messages', 'cold']) {
        const d = join(sessionsRoot, id, 'conversation', sub);
        if (existsSync(d)) dirs.push(d);
      }
    }
  }
  for (const dir of dirs) {
    count += rewriteFrontmatterInDir(dir, warnings);
  }
  return count;
}

/**
 * Walk a single directory and rewrite any `.md` file whose YAML frontmatter
 * carries `groupId:` / `chatId:` but not `sessionId:`. If both keys are
 * already present the redundant legacy id line is dropped. Atomic via
 * tmp-then-rename.
 *
 * Returns the number of files mutated.
 */
function rewriteFrontmatterInDir(dir, warnings) {
  let mutated = 0;
  let entries;
  try { entries = readdirSync(dir); } catch { return 0; }
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const path = join(dir, name);
    try {
      const raw = readFileSync(path, 'utf8');
      // Frontmatter must open with `---` (LF or CRLF) for us to touch it.
      // Skip the legacy human-readable conv-XXXX.md transcript files (no
      // frontmatter) — they're informational dumps, not parser inputs.
      const openMatch = raw.match(/^---\r?\n/);
      if (!openMatch) continue;
      const openLen = openMatch[0].length;
      // Find the closing `\n---` (allow CRLF before the close too).
      const endIdx = raw.search(/\r?\n---/);
      if (endIdx === -1 || endIdx < openLen) continue;
      const fmBody = raw.slice(openLen, endIdx);
      const after = raw.slice(endIdx);
      // Detect line ending used by the file so we round-trip it.
      const eol = raw.slice(0, openLen).includes('\r\n') ? '\r\n' : '\n';
      const lines = fmBody.split(/\r?\n/);
      const legacyIdLineIndexes = lines
        .map((line, index) => (/^(groupId|chatId):\s*/.test(line) ? index : -1))
        .filter((index) => index !== -1);
      if (legacyIdLineIndexes.length === 0) continue;
      const hasSessionId = lines.some((l) => /^sessionId:\s*\S/.test(l));
      const legacyIdLineIdx = legacyIdLineIndexes[0];
      const m = lines[legacyIdLineIdx].match(/^(?:groupId|chatId):\s*(.*?)\s*$/);
      const value = m ? m[1] : '';
      if (!hasSessionId && !value) {
        // Pathological: legacy id with no value AND no existing sessionId.
        // Don't manufacture `sessionId: ` — that would silently mint a
        // useless row. Leave the file alone and log it so we can audit.
        warnings.push(`frontmatter rewrite skipped (empty legacy session id, no sessionId): ${path}`);
        continue;
      }
      let newLines;
      if (hasSessionId) {
        // Redundant — drop legacy id lines.
        newLines = lines.filter((_, i) => !legacyIdLineIndexes.includes(i));
      } else {
        // Replace in place to preserve frontmatter ordering.
        newLines = lines
          .map((line, i) => (i === legacyIdLineIdx ? `sessionId: ${value}` : line))
          .filter((_, i) => i === legacyIdLineIdx || !legacyIdLineIndexes.includes(i));
      }
      const next = `---${eol}${newLines.join(eol)}${after}`;
      // Collision-safe tmp name: pid + counter. Parallel migration runs
      // shouldn't happen (sentinel gates everything) but the atomic-rename
      // contract is cheap insurance.
      const tmp = `${path}.tmp.${process.pid}`;
      writeFileSync(tmp, next, 'utf8');
      renameSync(tmp, path);
      mutated++;
    } catch (err) {
      warnings.push(`frontmatter rewrite failed ${path}: ${err.message}`);
    }
  }
  return mutated;
}

function listDirs(root) {
  if (!root || !existsSync(root)) return [];
  const out = [];
  for (const name of readdirSync(root)) {
    if (name.startsWith('.')) continue;
    try {
      if (statSync(join(root, name)).isDirectory()) out.push(name);
    } catch { /* ignore */ }
  }
  return out;
}

function listLegacyChatDirs(root) {
  return listDirs(root).filter((id) => existsSync(join(root, id, 'chat.json')));
}

function cleanupLegacySessionDirs(yeaftDir, warnings) {
  const sessionsRoot = join(yeaftDir, 'sessions');
  let moved = 0;
  for (const legacyName of ['groups', 'chats']) {
    const legacyRoot = join(yeaftDir, legacyName);
    if (!existsSync(legacyRoot)) continue;
    const ids = legacyName === 'chats' ? listLegacyChatDirs(legacyRoot) : listDirs(legacyRoot);
    for (const id of ids) {
      const src = join(legacyRoot, id);
      const dst = join(sessionsRoot, id);
      if (!existsSync(dst)) continue;
      mergeLegacyDirIntoSession(src, dst, warnings, `${legacyName}/${id}`);
      removeDirIfEmpty(src, warnings, `${legacyName}/${id}`);
      if (!existsSync(src)) moved++;
    }
    removeDirIfEmpty(legacyRoot, warnings, legacyName);
  }
  return { moved };
}

function reconcileSessionMetadataDirs(sessionsRoot, warnings) {
  for (const id of listDirs(sessionsRoot)) {
    const dst = join(sessionsRoot, id);
    reconcileSessionMetadataDir(dst, warnings, `sessions/${id}`, {
      meta: `reconciled wrong meta.json at sessions/${id}`,
      group: `reconciled legacy group.json at sessions/${id}`,
      chat: `reconciled legacy chat.json at sessions/${id}`,
    });
  }
}

function reconcileSessionMetadataDir(sessionDir, warnings, label, messages = {}) {
  const canonicalPath = join(sessionDir, 'session.json');
  if (existsSync(canonicalPath) && isValidSessionJson(canonicalPath)) {
    removeWrongMetaJson(sessionDir, warnings);
    return true;
  }
  if (existsSync(canonicalPath)) {
    warnings.push(`${label}: invalid session.json; trying legacy metadata`);
  }
  if (existsSync(join(sessionDir, 'meta.json'))) {
    const ok = rewriteWrongMetaToSessionJson(sessionDir, warnings);
    if (ok && messages.meta) warnings.push(messages.meta);
    if (ok) return true;
  }
  if (existsSync(join(sessionDir, 'group.json'))) {
    const ok = rewriteGroupMetaToSessionJson(sessionDir, warnings);
    if (ok && messages.group) warnings.push(messages.group);
    if (ok) return true;
  }
  if (existsSync(join(sessionDir, 'chat.json'))) {
    const ok = rewriteChatMetaToSessionJson(sessionDir, warnings);
    if (ok && messages.chat) warnings.push(messages.chat);
    if (ok) return true;
  }
  return existsSync(canonicalPath) && isValidSessionJson(canonicalPath);
}

function mergeLegacyDirIntoSession(src, dst, warnings, label) {
  if (!existsSync(src) || !existsSync(dst)) return;
  let entries = [];
  try { entries = readdirSync(src, { withFileTypes: true }); }
  catch (err) { warnings.push(`${label}: failed to scan legacy dir: ${err.message}`); return; }

  for (const ent of entries) {
    const from = join(src, ent.name);
    const to = join(dst, ent.name);
    if (!existsSync(to)) {
      try { renameSync(from, to); }
      catch (err) { warnings.push(`${label}: failed to move ${ent.name}: ${err.message}`); }
      continue;
    }
    if (ent.isDirectory()) {
      mergeLegacyDirIntoSession(from, to, warnings, `${label}/${ent.name}`);
      removeDirIfEmpty(from, warnings, `${label}/${ent.name}`);
    } else {
      warnings.push(`${label}: kept duplicate legacy file ${ent.name}`);
    }
  }
}

function removeDirIfEmpty(dir, warnings, label) {
  if (!existsSync(dir)) return;
  try {
    const entries = readdirSync(dir);
    if (entries.length === 0) rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    warnings.push(`${label}: failed to remove empty legacy dir: ${err.message}`);
  }
}

function rewriteGroupMetaToSessionJson(sessionDir, warnings) {
  const oldPath = join(sessionDir, 'group.json');
  const newPath = join(sessionDir, 'session.json');
  if (!existsSync(oldPath)) {
    if (!existsSync(newPath)) warnings.push(`no group.json in ${sessionDir}`);
    return false;
  }
  try {
    const raw = JSON.parse(readFileSync(oldPath, 'utf8'));
    const roster = Array.isArray(raw.roster) ? raw.roster.slice() : ['omni'];
    const meta = {
      id: raw.id,
      name: raw.name || raw.id,
      roster,
      defaultVpId: raw.defaultVpId || roster[0] || null,
      announcement: typeof raw.announcement === 'string' ? raw.announcement : '',
      workDir: typeof raw.workDir === 'string' ? raw.workDir : '',
      createdAt: raw.createdAt || new Date().toISOString(),
    };
    writeJsonFileAtomic(newPath, meta);
    try { unlinkSync(oldPath); } catch { /* keep both if cannot delete */ }
    return true;
  } catch (err) {
    warnings.push(`failed to rewrite ${oldPath}: ${err.message}`);
    return false;
  }
}

function rewriteChatMetaToSessionJson(sessionDir, warnings) {
  const oldPath = join(sessionDir, 'chat.json');
  const newPath = join(sessionDir, 'session.json');
  if (!existsSync(oldPath)) {
    if (!existsSync(newPath)) warnings.push(`no chat.json in ${sessionDir}`);
    return false;
  }
  try {
    const raw = JSON.parse(readFileSync(oldPath, 'utf8'));
    const roster = [raw.vpId || 'omni'];
    const meta = {
      id: raw.id,
      name: raw.displayName || raw.name || raw.id,
      roster,
      defaultVpId: raw.defaultVpId || roster[0] || null,
      announcement: typeof raw.announcement === 'string' ? raw.announcement : '',
      workDir: typeof raw.workDir === 'string' ? raw.workDir : '',
      createdAt: raw.createdAt || new Date().toISOString(),
    };
    writeJsonFileAtomic(newPath, meta);
    try { unlinkSync(oldPath); } catch { /* */ }
    return true;
  } catch (err) {
    warnings.push(`failed to rewrite ${oldPath}: ${err.message}`);
    return false;
  }
}

function rewriteWrongMetaToSessionJson(sessionDir, warnings) {
  const oldPath = join(sessionDir, 'meta.json');
  const newPath = join(sessionDir, 'session.json');
  if (!existsSync(oldPath)) return false;
  try {
    const raw = JSON.parse(readFileSync(oldPath, 'utf8'));
    const roster = Array.isArray(raw.roster) && raw.roster.length > 0
      ? raw.roster.slice()
      : Array.isArray(raw.vpIds) && raw.vpIds.length > 0
        ? raw.vpIds.slice()
        : (raw.vpId ? [raw.vpId] : ['omni']);
    const meta = {
      id: raw.id,
      name: raw.name || raw.displayName || raw.id,
      roster,
      defaultVpId: raw.defaultVpId || roster[0] || null,
      announcement: typeof raw.announcement === 'string' ? raw.announcement : '',
      workDir: typeof raw.workDir === 'string' ? raw.workDir : '',
      createdAt: raw.createdAt || new Date().toISOString(),
    };
    writeJsonFileAtomic(newPath, meta);
    try { unlinkSync(oldPath); } catch { /* keep both if cannot delete */ }
    return true;
  } catch (err) {
    warnings.push(`failed to rewrite ${oldPath}: ${err.message}`);
    return false;
  }
}

function isValidSessionJson(path) {
  try {
    return isValidSessionMeta(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return false;
  }
}

function isValidSessionMeta(meta) {
  return !!meta
    && typeof meta.id === 'string'
    && meta.id.length > 0
    && Array.isArray(meta.roster)
    && meta.roster.every((vpId) => typeof vpId === 'string')
    && (meta.defaultVpId == null || typeof meta.defaultVpId === 'string')
    && (meta.announcement == null || typeof meta.announcement === 'string')
    && (meta.workDir == null || typeof meta.workDir === 'string');
}

function writeJsonFileAtomic(path, value) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, path);
}

function removeWrongMetaJson(sessionDir, warnings) {
  const oldPath = join(sessionDir, 'meta.json');
  if (!existsSync(oldPath)) return;
  try {
    unlinkSync(oldPath);
  } catch (err) {
    warnings.push(`failed to remove obsolete ${oldPath}: ${err.message}`);
  }
}

function rewriteSegmentScopes(sessionMemoryDir, oldFamily, id, warnings) {
  const segDir = join(sessionMemoryDir, 'segments');
  if (!existsSync(segDir)) return;
  let entries;
  try { entries = readdirSync(segDir); } catch { return; }
  const re = new RegExp(`^(\\s*scope:\\s*)${oldFamily}/${escapeRe(id)}\\b`, 'gm');
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const path = join(segDir, name);
    try {
      const src = readFileSync(path, 'utf8');
      const next = src.replace(re, `$1session/${id}`);
      if (next !== src) writeFileSync(path, next, 'utf8');
    } catch (err) {
      warnings.push(`segment rewrite failed ${path}: ${err.message}`);
    }
  }
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
