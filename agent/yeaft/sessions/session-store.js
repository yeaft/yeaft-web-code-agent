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
 * `meta.json` is a read-only rescue alias for the short-lived broken
 * migration that wrote the wrong schema/file name.
 *
 * Hard constraint: the store does not parse @-mentions, does not dispatch,
 * and has no knowledge of VP/RoleInstance. It is pure persistence over 334o.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'fs';
import { join } from 'path';
import { writeAtomic, openLog } from '../storage/index.js';
import { nextMsgId, isReservedVpId, ReservedVpIdError, validateVpId, InvalidVpIdError } from './ids.js';

export const SESSION_META_FILE = 'session.json';
export const LEGACY_GROUP_META_FILE = 'group.json';
const LEGACY_MIGRATION_META_FILE = 'meta.json';
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

  let meta = loadSessionMeta(dir);
  if (!meta) {
    // Fresh session — caller must call createSession() next; we return a handle
    // with meta=null so createSession() can write the initial file.
  }

  const messagesDir = join(dir, MESSAGES_DIR);
  if (!existsSync(messagesDir)) mkdirSync(messagesDir, { recursive: true });
  const log = openLog(messagesDir);

  return {
    dir,
    id: sessionId,
    /** Return current meta (reads fresh from memory after last save). */
    getMeta() { return meta ? structuredClone(meta) : null; },
    /** Overwrite session.json atomically. */
    saveMeta(next) {
      validateMeta(next);
      meta = next;
      writeAtomic(join(dir, SESSION_META_FILE), JSON.stringify(meta, null, 2));
    },
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
        mentions: Array.isArray(record.mentions) ? record.mentions.slice() : [],
        meta: record.meta || {},
      };
      log.append(stored);
      return stored;
    },
    /** Iterate all messages oldest→newest. */
    *streamMessages() {
      yield* log.streamAll();
    },
    /** Iterate a message id range inclusive. */
    *readMessageRange(firstId, lastId) {
      yield* log.readRange(firstId, lastId);
    },
    /** Flush + close underlying log (on shutdown). */
    close() { log.close(); },
  };
}

/**
 * Create a fresh session on disk. Fails if session metadata already exists.
 * @returns {SessionHandle}
 */
export function createSession(sessionsRoot, spec) {
  if (!spec || !spec.id) throw new Error('createSession: spec.id required');
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
    name: spec.name || spec.id,
    roster,
    defaultVpId: spec.defaultVpId || null,
    announcement: typeof spec.announcement === 'string' ? spec.announcement : '',
    workDir: typeof spec.workDir === 'string' ? spec.workDir.trim() : '',
    createdAt: spec.createdAt || new Date().toISOString(),
  };
  h.saveMeta(meta);
  return h;
}

/**
 * Non-destructive load — returns null if session metadata is missing/corrupt.
 * Reads canonical session.json first, then legacy group.json / meta.json for
 * disk compatibility. Callers that later save the handle will write
 * session.json.
 */
export function loadSessionMeta(dir) {
  const path = resolveSessionMetaPath(dir);
  if (!path) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = normalizeLoadedMeta(JSON.parse(raw));
    validateMeta(parsed);
    // Legacy sessions created before optional fields were added are
    // forward-compat: missing fields read back as safe empty strings.
    if (typeof parsed.announcement !== 'string') parsed.announcement = '';
    if (typeof parsed.workDir !== 'string') parsed.workDir = '';
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

function normalizeLoadedMeta(meta) {
  if (!meta || typeof meta !== 'object') return meta;
  if (Array.isArray(meta.roster)) return meta;
  if (Array.isArray(meta.vpIds)) {
    return {
      id: meta.id,
      name: meta.name || meta.displayName || meta.id,
      roster: meta.vpIds.slice(),
      defaultVpId: meta.defaultVpId || meta.vpIds[0] || null,
      announcement: typeof meta.announcement === 'string' ? meta.announcement : '',
      workDir: typeof meta.workDir === 'string' ? meta.workDir : '',
      createdAt: meta.createdAt || new Date().toISOString(),
    };
  }
  return meta;
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
  const legacyMigration = join(dir, LEGACY_MIGRATION_META_FILE);
  if (existsSync(legacyMigration)) return legacyMigration;
  return null;
}
