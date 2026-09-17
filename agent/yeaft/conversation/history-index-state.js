import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { writeAtomic } from '../storage/atomic.js';

// v3 indexes the visible transcript, including rows replaced only in model context.
export const HISTORY_INDEX_SCHEMA_VERSION = 3;

const STATE_VERSION = 1;
const INDEX_DIR = 'conversation-index';
const STATE_FILE = 'mutation-state.json';
const JOURNAL_FILE = 'mutations.jsonl';
const FLUSH_DELAY_MS = 25;
const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;
const stateCache = new Map();
const pendingEvents = new Map();
const flushTimers = new Map();

function scopeKey(scopeKind, scopeId) {
  return `${scopeKind || 'session'}:${scopeId || '*'}`;
}

function safeJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' ? value : fallback;
  } catch {
    return fallback;
  }
}

export function conversationIndexDir(ownerRoot) {
  return join(ownerRoot, INDEX_DIR);
}

export function conversationIndexScopeId(sessionId) {
  return createHash('sha256').update(String(sessionId || ''), 'utf8').digest('hex').slice(0, 24);
}

export function conversationIndexManifestPath(ownerRoot, sessionId) {
  return join(conversationIndexDir(ownerRoot), 'manifests', `${conversationIndexScopeId(sessionId)}.json`);
}

export function conversationIndexDatabasePath(ownerRoot, sessionId, generation) {
  return join(
    conversationIndexDir(ownerRoot),
    'databases',
    `${conversationIndexScopeId(sessionId)}-${generation}.sqlite`,
  );
}

export function removeConversationIndexScope(ownerRoot, sessionId) {
  if (!ownerRoot || !sessionId) return;
  const manifestPath = conversationIndexManifestPath(ownerRoot, sessionId);
  const scopeId = conversationIndexScopeId(sessionId);
  const databaseDir = join(conversationIndexDir(ownerRoot), 'databases');
  rmSync(manifestPath, { force: true });
  if (!existsSync(databaseDir)) return;
  for (const name of readdirSync(databaseDir)) {
    if (!name.startsWith(`${scopeId}-`) || !name.includes('.sqlite')) continue;
    rmSync(join(databaseDir, name), { force: true });
  }
}

export function readConversationMutationState(ownerRoot) {
  const cached = stateCache.get(ownerRoot);
  if (cached) return cached;
  const fallback = { version: STATE_VERSION, revision: 0, scopes: {} };
  const value = safeJson(join(conversationIndexDir(ownerRoot), STATE_FILE), fallback);
  const state = {
    version: STATE_VERSION,
    revision: Number(value.revision) || 0,
    scopes: value.scopes && typeof value.scopes === 'object' ? value.scopes : {},
  };
  stateCache.set(ownerRoot, state);
  return state;
}

export function readConversationMutationInfo(ownerRoot, scopeKind, scopeId) {
  const state = readConversationMutationState(ownerRoot);
  const exact = state.scopes[scopeKey(scopeKind, scopeId)] || null;
  const wildcard = state.scopes[scopeKey(scopeKind, '*')] || null;
  const selected = (Number(exact?.revision) || 0) >= (Number(wildcard?.revision) || 0)
    ? exact
    : wildcard;
  return {
    revision: Number(selected?.revision) || 0,
    reason: selected?.reason || null,
    at: selected?.at || null,
  };
}

export function readConversationMutationRevision(ownerRoot, scopeKind, scopeId) {
  return readConversationMutationInfo(ownerRoot, scopeKind, scopeId).revision;
}

function flushConversationMutations(ownerRoot) {
  const timer = flushTimers.get(ownerRoot);
  if (timer) clearTimeout(timer);
  flushTimers.delete(ownerRoot);
  const eventMap = pendingEvents.get(ownerRoot) || new Map();
  pendingEvents.delete(ownerRoot);
  const events = Array.from(eventMap.values());
  const state = stateCache.get(ownerRoot);
  if (!state || events.length === 0) return;
  const dir = conversationIndexDir(ownerRoot);
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
  const journalPath = join(dir, JOURNAL_FILE);
  let journalBytes = 0;
  try { journalBytes = statSync(journalPath).size; } catch {}
  if (journalBytes >= MAX_JOURNAL_BYTES) writeAtomic(journalPath, '');
  appendFileSync(journalPath, events.map(event => JSON.stringify(event)).join('\n') + '\n', {
    encoding: 'utf8',
    mode: 0o644,
  });
}

function scheduleConversationMutationFlush(ownerRoot) {
  if (flushTimers.has(ownerRoot)) return;
  const timer = setTimeout(() => {
    try { flushConversationMutations(ownerRoot); }
    catch (error) { console.warn('[history-index] failed to flush mutation journal:', error?.message || error); }
  }, FLUSH_DELAY_MS);
  if (typeof timer.unref === 'function') timer.unref();
  flushTimers.set(ownerRoot, timer);
}

/**
 * Record one logical transcript mutation after the source write succeeds.
 * Fingerprint reconciliation covers a crash before the coalesced journal flush,
 * so this marker is a scheduling hint rather than a second authority.
 */
export function markConversationDirty({
  ownerRoot,
  scopeKind = 'session',
  scopeId = '*',
  reason = 'mutation',
  sourceIds = null,
  oldPath = null,
  newPath = null,
} = {}) {
  if (!ownerRoot) return null;
  const state = readConversationMutationState(ownerRoot);
  const revision = state.revision + 1;
  const key = scopeKey(scopeKind, scopeId);
  const event = {
    version: STATE_VERSION,
    revision,
    scopeKind,
    scopeId,
    reason,
    at: new Date().toISOString(),
    ...(Array.isArray(sourceIds) && sourceIds.length > 0 ? { sourceIds } : {}),
    ...(oldPath ? { oldPath } : {}),
    ...(newPath ? { newPath } : {}),
  };
  state.revision = revision;
  state.scopes[key] = { revision, reason, at: event.at };
  const events = pendingEvents.get(ownerRoot) || new Map();
  events.set(key, event);
  pendingEvents.set(ownerRoot, events);
  scheduleConversationMutationFlush(ownerRoot);
  return event;
}

function collectSourceFiles(root, out) {
  if (!existsSync(root)) return;
  let names;
  try { names = readdirSync(root); } catch { return; }
  names.sort();
  for (const name of names) {
    const path = join(root, name);
    let stat;
    try { stat = statSync(path); } catch { continue; }
    if (stat.isDirectory()) {
      if (name === 'compact' || name === 'blobs') continue;
      collectSourceFiles(path, out);
      continue;
    }
    const parentName = root.split(/[\\/]/).at(-1);
    if (name.endsWith('.jsonl')
      || (name.endsWith('.md') && (parentName === 'messages' || parentName === 'cold'))) {
      out.push(path);
    }
  }
}

export function flushConversationIndexMutations(ownerRoot = null, { release = false } = {}) {
  const roots = ownerRoot
    ? [ownerRoot]
    : Array.from(new Set([...stateCache.keys(), ...pendingEvents.keys()]));
  for (const root of roots) {
    flushConversationMutations(root);
    if (release) {
      stateCache.delete(root);
      pendingEvents.delete(root);
      const timer = flushTimers.get(root);
      if (timer) clearTimeout(timer);
      flushTimers.delete(root);
    }
  }
}

function sourceStatKey(stat) {
  return [
    stat.dev,
    stat.ino,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(':');
}

function stableFileDigest(path, digestCache, forceHash) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = statSync(path, { bigint: true });
    const key = sourceStatKey(before);
    const cached = !forceHash ? digestCache?.get(path) : null;
    if (cached?.key === key) return { digest: cached.digest, bytes: Number(before.size), key };
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const fd = openSync(path, 'r');
    let bytes = 0;
    try {
      for (;;) {
        const count = readSync(fd, buffer, 0, buffer.length, null);
        if (count === 0) break;
        hash.update(buffer.subarray(0, count));
        bytes += count;
      }
    } finally {
      closeSync(fd);
    }
    const after = statSync(path, { bigint: true });
    if (sourceStatKey(after) !== key) continue;
    const digest = hash.digest('hex');
    digestCache?.set(path, { key, digest });
    return { digest, bytes, key };
  }
  const error = new Error(`history source changed while hashing: ${path}`);
  error.code = 'source_changed';
  throw error;
}

export function fingerprintConversationSources(ownerRoot, sessionId, {
  digestCache = null,
  forceHash = false,
} = {}) {
  const safeSessionId = String(sessionId || '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 120)
    .replace(/^\.+$/, '_') || '_';
  const roots = [
    join(ownerRoot, 'sessions', safeSessionId, 'conversation'),
    // Legacy on-disk alias retained for pre-Session transcript compatibility.
    join(ownerRoot, 'groups', safeSessionId, 'conversation'),
  ];
  const files = [];
  for (const root of roots) collectSourceFiles(root, files);
  files.sort();
  const hash = createHash('sha256');
  hash.update(`history-source-v${STATE_VERSION}\0${sessionId}\0`, 'utf8');
  let bytes = 0;
  const livePaths = new Set(files);
  for (const path of files) {
    const file = stableFileDigest(path, digestCache, forceHash);
    bytes += file.bytes;
    hash.update(relative(ownerRoot, path), 'utf8');
    hash.update('\0', 'utf8');
    hash.update(file.digest, 'ascii');
    hash.update('\0', 'utf8');
  }
  if (digestCache) {
    for (const path of digestCache.keys()) {
      if (!livePaths.has(path)) digestCache.delete(path);
    }
  }
  return {
    fingerprint: hash.digest('hex'),
    files: files.length,
    bytes,
    exists: files.length > 0,
  };
}
