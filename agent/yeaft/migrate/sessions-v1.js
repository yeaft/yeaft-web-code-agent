/**
 * migrate/sessions-v1.js — One-shot migration: collapse groups/ + chats/ → sessions/
 *
 * Idempotent. Marks completion with a sentinel file
 * `<yeaftDir>/.session-migration-v1.done`.
 *
 * Migrates:
 *   1. ~/.yeaft/groups/<g>/         → ~/.yeaft/sessions/<g>/
 *      group.json → meta.json with shape:
 *        { id, vpIds: roster, displayName: name, workDir, createdAt,
 *          lastTurnAt: null, archivedAt? }
 *   2. ~/.yeaft/chats/<c>/          → ~/.yeaft/sessions/<c>/
 *      chat.json → meta.json with vpIds: [vpId]
 *   3. ~/.yeaft/memory/group/<g>/   → ~/.yeaft/memory/session/<g>/
 *   4. ~/.yeaft/memory/chat/<c>/    → ~/.yeaft/memory/session/<c>/
 *      Rewrites front-matter `scope:` fields from group/<id> / chat/<id>
 *      → session/<id>.
 *   5. ~/.yeaft/memory/groups/<g>/ams.json → ~/.yeaft/memory/sessions/<g>/ams.json
 *
 * Collision policy: if `sessions/<x>` already exists, log + skip (we assume
 * a prior partial run already moved it). If both groups/<x> and chats/<x>
 * exist with the same id, bail loudly — that shouldn't happen because
 * group ids are `grp_*` and chat ids are `chat_*`.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';

const SENTINEL = '.session-migration-v1.done';

/**
 * Run the v1 sessions migration. No-op when sentinel exists.
 *
 * @param {string} yeaftDir
 * @returns {{ migrated: boolean, moved: number, warnings: string[] }}
 */
export function migrateSessionsV1(yeaftDir) {
  const warnings = [];
  if (!yeaftDir || !existsSync(yeaftDir)) {
    return { migrated: false, moved: 0, warnings: ['yeaftDir missing'] };
  }
  const sentinel = join(yeaftDir, SENTINEL);
  if (existsSync(sentinel)) {
    return { migrated: false, moved: 0, warnings: [] };
  }

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
  const chatIds = listDirs(chatsRoot);
  const overlap = groupIds.filter((id) => chatIds.includes(id));
  if (overlap.length > 0) {
    throw new Error(`sessions migration: id collision between groups/ and chats/: ${overlap.join(',')}`);
  }

  let moved = 0;

  // 1. groups/<g>/ → sessions/<g>/
  for (const id of groupIds) {
    const src = join(groupsRoot, id);
    const dst = join(sessionsRoot, id);
    if (existsSync(dst)) {
      warnings.push(`sessions/${id} already exists; skipping groups/${id}`);
      continue;
    }
    renameSync(src, dst);
    rewriteGroupMetaToSessionMeta(dst, warnings);
    moved++;
  }

  // 2. chats/<c>/ → sessions/<c>/
  for (const id of chatIds) {
    const src = join(chatsRoot, id);
    const dst = join(sessionsRoot, id);
    if (existsSync(dst)) {
      warnings.push(`sessions/${id} already exists; skipping chats/${id}`);
      continue;
    }
    renameSync(src, dst);
    rewriteChatMetaToSessionMeta(dst, warnings);
    moved++;
  }

  // 3+4. memory/{group,chat}/<id>/ → memory/session/<id>/
  for (const family of ['group', 'chat']) {
    const root = join(memoryRoot, family);
    if (!existsSync(root)) continue;
    for (const id of listDirs(root)) {
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
    for (const id of listDirs(amsChatRoot)) {
      const srcDir = join(amsChatRoot, id);
      const dstDir = join(memSessionsAmsRoot, id);
      if (existsSync(dstDir)) {
        warnings.push(`memory/sessions/${id} already exists; skipping memory/chats/${id}`);
        continue;
      }
      renameSync(srcDir, dstDir);
    }
  }

  // 6. sentinel
  writeFileSync(sentinel, JSON.stringify({
    version: 1,
    migratedAt: new Date().toISOString(),
    moved,
    warnings,
  }, null, 2), 'utf8');

  return { migrated: true, moved, warnings };
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

function rewriteGroupMetaToSessionMeta(sessionDir, warnings) {
  const oldPath = join(sessionDir, 'group.json');
  const newPath = join(sessionDir, 'meta.json');
  if (!existsSync(oldPath)) {
    if (!existsSync(newPath)) warnings.push(`no group.json in ${sessionDir}`);
    return;
  }
  try {
    const raw = JSON.parse(readFileSync(oldPath, 'utf8'));
    const meta = {
      id: raw.id,
      displayName: raw.name || raw.id,
      vpIds: Array.isArray(raw.roster) && raw.roster.length > 0 ? raw.roster.slice() : ['omni'],
      workDir: typeof raw.workDir === 'string' ? raw.workDir : '',
      createdAt: raw.createdAt || new Date().toISOString(),
      lastTurnAt: null,
    };
    writeFileSync(newPath, JSON.stringify(meta, null, 2), 'utf8');
    try { unlinkSync(oldPath); } catch { /* keep both if cannot delete */ }
  } catch (err) {
    warnings.push(`failed to rewrite ${oldPath}: ${err.message}`);
  }
}

function rewriteChatMetaToSessionMeta(sessionDir, warnings) {
  const oldPath = join(sessionDir, 'chat.json');
  const newPath = join(sessionDir, 'meta.json');
  if (!existsSync(oldPath)) {
    if (!existsSync(newPath)) warnings.push(`no chat.json in ${sessionDir}`);
    return;
  }
  try {
    const raw = JSON.parse(readFileSync(oldPath, 'utf8'));
    const meta = {
      id: raw.id,
      displayName: raw.displayName || raw.id,
      vpIds: [raw.vpId || 'omni'],
      workDir: typeof raw.workDir === 'string' ? raw.workDir : '',
      createdAt: raw.createdAt || new Date().toISOString(),
      lastTurnAt: raw.lastTurnAt || null,
    };
    writeFileSync(newPath, JSON.stringify(meta, null, 2), 'utf8');
    try { unlinkSync(oldPath); } catch { /* */ }
  } catch (err) {
    warnings.push(`failed to rewrite ${oldPath}: ${err.message}`);
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
