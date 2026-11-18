/**
 * session-store.js — Per-session persistent store for task-334b.
 *
 * Layout (see architecture §2):
 *   ~/.yeaft/sessions/<session-id>/
 *     session.json        # { id, name, roster: [vpId...], defaultVpId, createdAt }
 *     messages/           # JSONL size-rotation log (334o openLog)
 *       000001.jsonl
 *       index.json
 *     tasks/              # populated by 334n — reserved here
 *     vps/                # populated by 334c RoleInstance runtime — reserved here
 *
 * This module owns only the session.json + messages/ log. Roster mutation
 * logic lives in roster.js so coordinator and session-store both compose it.
 * Legacy `group.json` is read as a compatibility alias for sessions created
 * before the storage terminology was fixed; new writes are always session.json.
 *
 * Hard constraint: the store does not parse @-mentions, does not dispatch,
 * and has no knowledge of VP/RoleInstance. It is pure persistence over 334o.
 */

import {
  existsSync,
  mkdirSync,
  unlinkSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'fs';
import { join } from 'path';
import { writeAtomic, openLog, listSegmentFiles, emptyIndex, saveIndex, statSegmentFromDisk } from '../storage/index.js';
import { nextMsgId, isReservedVpId, ReservedVpIdError, validateVpId, InvalidVpIdError } from './ids.js';

import { readSessionTurnDeletions, sessionDeletionProjection } from '../conversation/turn-deletion-journal.js';
import { normalizeScheduledTask, scheduledTaskRevision } from './scheduled-task-definition.js';
import { withCoordinatorLogLock } from './session-turn-fence.js';

export const SESSION_META_FILE = 'session.json';
export const LEGACY_GROUP_META_FILE = 'group.json';
const MESSAGES_DIR = 'messages';

/**
 * Load (or create) the directory for a single session.
 *
 * @param {string} sessionsRoot  e.g. `${yeaftDir}/sessions`
 * @param {string} sessionId
 * @returns {SessionHandle}
 */
export function openSession(sessionsRoot, sessionId) {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('openSession: sessionId required (string)');
  }
  const dir = join(sessionsRoot, sessionId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const messagesDir = join(dir, MESSAGES_DIR);
  if (!existsSync(messagesDir)) mkdirSync(messagesDir, { recursive: true });
  // No handle retains an append fd or a writable index snapshot between calls.
  // In particular, closing an idle handle must not overwrite a newer index.
  withCoordinatorLogLock(dir, () => openLog(messagesDir).close());
  let closed = false;
  function *visibleMessages(records) {
    const { operations } = readSessionTurnDeletions(join(sessionsRoot, '..'), sessionId);
    const ids = new Set(operations.flatMap(op => op.clientMessageIds));
    const { references } = sessionDeletionProjection(operations);
    for (const row of records) {
      const kept = projectCoordinatorMessage(row, ids, references);
      if (kept) yield kept;
    }
  }

  return {
    dir,
    id: sessionId,
    /** Read fresh: coordinators may retain this handle across external CRUD. */
    getMeta() { return loadSessionMeta(dir); },
    /**
     * Save Session metadata atomically. After creation, the scheduler exclusively
     * owns task definitions/runtime. Preserve its fresh on-disk value even when
     * a caller retained an older metadata snapshot across a run or task edit.
     */
    saveMeta(next) { saveSessionMeta(dir, next); },
    /**
     * Append a message to the session log. Assigns an id if absent.
     * Returns the stored record (with id + ts).
     *
     * Structural invariant: NO field on `record` may start with `_`.
     * The `_` prefix is reserved for ephemeral per-turn payloads (image
     * base64, prompt suffixes) that must reach the driver but must
     * never hit the persisted jsonl-log. If this throws, the caller
     * forgot to partition ephemeral fields off — fix the caller.
     */
    appendMessage(record) {
      if (closed) throw new Error('appendMessage: Session handle is closed');
      if (!record || typeof record !== 'object') {
        throw new Error('appendMessage: record required');
      }
      {
        const leaked = Object.keys(record).filter((k) => typeof k === 'string' && k.startsWith('_'));
        if (leaked.length > 0) {
          throw new Error(`appendMessage: ephemeral fields leaked into log: ${leaked.join(', ')}`);
        }
      }
      const stored = {
        id: record.id || nextMsgId(),
        ts: record.ts || new Date().toISOString(),
        from: record.from,   // vpId | 'user'
        role: record.role || (record.from === 'user' ? 'user' : 'assistant'),
        text: record.text ?? '',
        taskId: record.taskId || null,
        ...(record.userTurnId ? { userTurnId: record.userTurnId } : {}),
        mentions: Array.isArray(record.mentions) ? record.mentions.slice() : [],
        meta: record.meta || {},
      };
      withCoordinatorLogLock(dir, () => {
        const log = openLog(messagesDir);
        try { log.append(stored); } finally { log.close(); }
      });
      return stored;
    },
    /** Iterate all messages oldest→newest. */
    *streamMessages() {
      yield* visibleMessages(readCoordinatorRows(messagesDir));
    },
    /** Iterate a message id range inclusive. */
    *readMessageRange(firstId, lastId) {
      for (const row of visibleMessages(readCoordinatorRows(messagesDir))) {
        if (row?.id != null && firstId <= row.id && row.id <= lastId) yield row;
      }
    },
    /** Stop writes through this handle. No fd or index is held. */
    close() { closed = true; },
  };
}

function* readCoordinatorRows(dir) {
  for (const file of listSegmentFiles(dir)) {
    let raw;
    try { raw = readFileSync(join(dir, file), 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      yield row;
    }
  }
}

function projectCoordinatorMessage(row, ids, references) {
  if (ids.has(row?.id) || (row?.userTurnId && ids.has(row.userTurnId))
    || (row?.meta?.synthetic && Array.isArray(row.meta.causedBy) && row.meta.causedBy.some(id => ids.has(id)))) return null;
  if (!references.has(row?.meta?.quote?.id || row?.meta?.quote?.messageId)) return row;
  const { quote, ...meta } = row.meta;
  return { ...row, meta };
}

/** Offline cleanup only. Older processes ignore the lock and can retain append fds. */
export function pruneDeletedCoordinatorMessages(sessionDir, operation) {
  return withCoordinatorLogLock(sessionDir, () => pruneCoordinatorLog(sessionDir, operation));
}

function pruneCoordinatorLog(sessionDir, operation) {
  const dir = join(sessionDir, MESSAGES_DIR);
  const ids = new Set(operation.clientMessageIds);
  const references = new Set(operation.referenceIds);
  const files = listSegmentFiles(dir);
  if (!files.length) return;
  for (const file of files) {
    const path = join(dir, file);
    const raw = readFileSync(path, 'utf8');
    const next = raw.split('\n').flatMap(line => {
      let row;
      try { row = JSON.parse(line); } catch { return [line]; }
      const kept = projectCoordinatorMessage(row, ids, references);
      return kept === row ? [line] : kept ? [JSON.stringify(kept)] : [];
    }).join('\n');
    if (raw === next) continue;
    if (!next) unlinkSync(path);
    else writeAtomic(path, next);
  }
  saveIndex(dir, { ...emptyIndex(), segments: listSegmentFiles(dir)
    .map(file => statSegmentFromDisk(dir, file, line => JSON.parse(line))) });
}

/**
 * Create a fresh session on disk. Fails if session metadata already exists.
 * @returns {SessionHandle}
 */
export function createSession(sessionsRoot, spec) {
  if (!spec || !spec.id) throw new Error('createSession: spec.id required');
  const task = spec.task === undefined ? undefined : normalizeScheduledTask(spec.task);
  const h = openSession(sessionsRoot, spec.id);
  if (h.getMeta()) {
    throw new Error(`session ${spec.id} already exists`);
  }
  const roster = Array.isArray(spec.roster) ? spec.roster.slice() : [];
  for (const v of roster) {
    if (isReservedVpId(v)) throw new ReservedVpIdError(v);
    const verdict = validateVpId(v);
    if (!verdict.ok) throw new InvalidVpIdError(v, verdict.reason);
  }
  if (spec.defaultVpId) {
    if (isReservedVpId(spec.defaultVpId)) throw new ReservedVpIdError(spec.defaultVpId);
    const dverdict = validateVpId(spec.defaultVpId);
    if (!dverdict.ok) throw new InvalidVpIdError(spec.defaultVpId, dverdict.reason);
  }
  const meta = {
    id: spec.id,
    ...(task ? { task } : {}),
    name: spec.name || spec.id,
    roster,
    defaultVpId: spec.defaultVpId || null,
    announcement: typeof spec.announcement === 'string' ? spec.announcement : '',
    workDir: typeof spec.workDir === 'string' ? spec.workDir.trim() : '',
    workspaceKey: typeof spec.workspaceKey === 'string' ? spec.workspaceKey.trim() : '',
    createdAt: spec.createdAt || new Date().toISOString(),
    metadataUpdatedAt: spec.metadataUpdatedAt || spec.createdAt || new Date().toISOString(),
  };
  h.saveMeta(meta);
  return h;
}

/** Save metadata without opening or repairing the legacy messages log. */
export function saveSessionMeta(dir, next) {
  validateMeta(next);
  const current = loadSessionMeta(dir);
  const meta = structuredClone(next);
  if (current) {
    if (Object.hasOwn(current, 'task')) meta.task = current.task;
    else delete meta.task;
  }
  writeAtomic(join(dir, SESSION_META_FILE), JSON.stringify(meta, null, 2));
}

/**
 * Non-destructive load — returns null if session metadata is missing/corrupt.
 * Reads canonical session.json first, then legacy group.json for disk
 * compatibility. Callers that later save the handle will write session.json.
 */
export function loadSessionMeta(dir) {
  const path = resolveSessionMetaPath(dir);
  if (!path) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    validateMeta(parsed);
    // Legacy sessions created before optional fields were added are
    // forward-compat: missing fields read back as safe empty strings.
    if (typeof parsed.announcement !== 'string') parsed.announcement = '';
    if (typeof parsed.workDir !== 'string') parsed.workDir = '';
    if (typeof parsed.workspaceKey !== 'string') parsed.workspaceKey = '';
    if (parsed.task) parsed.task._revision = scheduledTaskRevision(parsed.task);
    return parsed;
  } catch {
    return null;
  }
}

/** List every session directory under `sessionsRoot`. */
export function listSessions(sessionsRoot) {
  if (!existsSync(sessionsRoot)) return [];
  const out = [];
  for (const name of readdirSync(sessionsRoot)) {
    // Skip dotfiles and legacy soft-archive dirs (`.archived-*`).
    if (name.startsWith('.')) continue;
    const p = join(sessionsRoot, name);
    try {
      if (!statSync(p).isDirectory()) continue;
    } catch { continue; }
    const meta = loadSessionMeta(p);
    if (meta) out.push(meta);
  }
  return out;
}

function validateMeta(meta) {
  if (!meta || typeof meta !== 'object') throw new Error('session.json must be object');
  if (!meta.id || typeof meta.id !== 'string') throw new Error('session.id required');
  if (!Array.isArray(meta.roster)) throw new Error('session.roster must be array');
  for (const v of meta.roster) {
    if (typeof v !== 'string') throw new Error('session.roster must be string[]');
  }
  if (meta.defaultVpId != null && typeof meta.defaultVpId !== 'string') {
    throw new Error('session.defaultVpId must be string|null');
  }
  if (meta.announcement != null && typeof meta.announcement !== 'string') {
    throw new Error('session.announcement must be string');
  }
  if (meta.workDir != null && typeof meta.workDir !== 'string') {
    throw new Error('session.workDir must be string');
  }
}

/**
 * @typedef {Object} SessionHandle
 * @property {string} dir
 * @property {string} id
 * @property {() => any} getMeta
 * @property {(next:any)=>void} saveMeta
 * @property {(record:any)=>any} appendMessage
 * @property {() => Generator<any>} streamMessages
 * @property {(first:string,last:string)=>Generator<any>} readMessageRange
 * @property {() => void} close
 */

function resolveSessionMetaPath(dir) {
  const canonical = join(dir, SESSION_META_FILE);
  if (existsSync(canonical)) return canonical;
  const legacy = join(dir, LEGACY_GROUP_META_FILE);
  if (existsSync(legacy)) return legacy;
  return null;
}
