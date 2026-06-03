/**
 * session-store.js — Per-session persistent store (collapses group + chat).
 *
 * Layout:
 *   ~/.yeaft/sessions/<sessionId>/
 *     meta.json   # { sessionId, vpIds[], displayName, workDir, createdAt, lastTurnAt, archivedAt? }
 *     messages/   # JSONL size-rotation log (storage/openLog)
 *       000001.jsonl
 *       index.json
 *
 * A session has N≥1 VPs. N=1 is the old "chat"; N>1 is the old "group".
 * The coordinator fan-out is identical for both — N=1 just resolves to
 * one VP turn per ingest.
 *
 * Hard constraint: no @-mention parsing, no dispatch, no engine awareness.
 * Pure persistence.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'fs';
import { join } from 'path';
import { writeAtomic, openLog } from '../storage/index.js';
import {
  nextMsgId,
  isReservedVpId,
  ReservedVpIdError,
  validateVpId,
  InvalidVpIdError,
} from '../groups/ids.js';

const META_FILE = 'meta.json';
const MESSAGES_DIR = 'messages';
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Open (or partially create) the directory for a session. Returns a handle
 * even when meta.json is absent — call createSession() to materialise it.
 *
 * @param {string} sessionsRoot
 * @param {string} sessionId
 * @returns {SessionHandle}
 */
export function openSession(sessionsRoot, sessionId) {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('openSession: sessionId required (string)');
  }
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error(`openSession: invalid sessionId "${sessionId}"`);
  }
  const dir = join(sessionsRoot, sessionId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let meta = loadSessionMeta(dir);

  const messagesDir = join(dir, MESSAGES_DIR);
  if (!existsSync(messagesDir)) mkdirSync(messagesDir, { recursive: true });
  const log = openLog(messagesDir);

  return {
    dir,
    id: sessionId,
    getMeta() { return meta ? structuredClone(meta) : null; },
    saveMeta(next) {
      validateMeta(next);
      meta = next;
      writeAtomic(join(dir, META_FILE), JSON.stringify(meta, null, 2));
    },
    appendMessage(record) {
      if (!record || typeof record !== 'object') {
        throw new Error('appendMessage: record required');
      }
      const leaked = Object.keys(record).filter((k) => typeof k === 'string' && k.startsWith('_'));
      if (leaked.length > 0) {
        throw new Error(`appendMessage: ephemeral fields leaked into log: ${leaked.join(', ')}`);
      }
      const stored = {
        id: record.id || nextMsgId(),
        ts: record.ts || new Date().toISOString(),
        from: record.from,
        role: record.role || (record.from === 'user' ? 'user' : 'assistant'),
        text: record.text ?? '',
        taskId: record.taskId || null,
        mentions: Array.isArray(record.mentions) ? record.mentions.slice() : [],
        meta: record.meta || {},
      };
      log.append(stored);
      return stored;
    },
    *streamMessages() { yield* log.streamAll(); },
    *readMessageRange(firstId, lastId) { yield* log.readRange(firstId, lastId); },
    close() { log.close(); },
  };
}

/**
 * Create a new session on disk. Fails if meta.json already exists.
 * @param {string} sessionsRoot
 * @param {{
 *   id: string,
 *   vpIds: string[],
 *   displayName?: string,
 *   workDir?: string,
 *   createdAt?: string,
 * }} spec
 * @returns {SessionHandle}
 */
export function createSession(sessionsRoot, spec) {
  if (!spec || !spec.id) throw new Error('createSession: spec.id required');
  if (!Array.isArray(spec.vpIds) || spec.vpIds.length === 0) {
    throw new Error('createSession: spec.vpIds required (non-empty array)');
  }
  for (const v of spec.vpIds) {
    if (isReservedVpId(v)) throw new ReservedVpIdError(v);
    const verdict = validateVpId(v);
    if (!verdict.ok) throw new InvalidVpIdError(v, verdict.reason);
  }
  const h = openSession(sessionsRoot, spec.id);
  if (h.getMeta()) throw new Error(`session ${spec.id} already exists`);
  const meta = {
    id: spec.id,
    displayName: typeof spec.displayName === 'string' && spec.displayName.trim()
      ? spec.displayName.trim() : spec.id,
    vpIds: Array.from(new Set(spec.vpIds)),
    workDir: typeof spec.workDir === 'string' ? spec.workDir.trim() : '',
    createdAt: spec.createdAt || new Date().toISOString(),
    lastTurnAt: null,
  };
  h.saveMeta(meta);
  return h;
}

/** Non-destructive load — returns null if meta.json is missing/corrupt. */
export function loadSessionMeta(dir) {
  const path = join(dir, META_FILE);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    validateMeta(parsed);
    if (typeof parsed.displayName !== 'string') parsed.displayName = parsed.id;
    if (typeof parsed.workDir !== 'string') parsed.workDir = '';
    if (parsed.lastTurnAt === undefined) parsed.lastTurnAt = null;
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

/** Update a session's displayName. */
export function renameSession(sessionsRoot, sessionId, displayName) {
  const h = openSession(sessionsRoot, sessionId);
  const meta = h.getMeta();
  if (!meta) throw new Error(`renameSession: session ${sessionId} not found`);
  const next = { ...meta, displayName: String(displayName || '').trim() || meta.id };
  h.saveMeta(next);
  h.close();
  return next;
}

/**
 * Patch a session's meta: add/remove VPs or change displayName/workDir.
 * @param {string} sessionsRoot
 * @param {string} sessionId
 * @param {{addVpIds?: string[], removeVpIds?: string[], displayName?: string, workDir?: string}} patch
 */
export function updateSession(sessionsRoot, sessionId, patch = {}) {
  const h = openSession(sessionsRoot, sessionId);
  const meta = h.getMeta();
  if (!meta) { h.close(); throw new Error(`updateSession: session ${sessionId} not found`); }
  let vpIds = Array.from(meta.vpIds || []);
  if (Array.isArray(patch.addVpIds)) {
    for (const v of patch.addVpIds) {
      if (isReservedVpId(v)) throw new ReservedVpIdError(v);
      const verdict = validateVpId(v);
      if (!verdict.ok) throw new InvalidVpIdError(v, verdict.reason);
      if (!vpIds.includes(v)) vpIds.push(v);
    }
  }
  if (Array.isArray(patch.removeVpIds)) {
    const drop = new Set(patch.removeVpIds);
    vpIds = vpIds.filter((v) => !drop.has(v));
  }
  if (vpIds.length === 0) {
    h.close();
    throw new Error('updateSession: refusing to leave session with zero VPs');
  }
  const next = { ...meta, vpIds };
  if (typeof patch.displayName === 'string' && patch.displayName.trim()) {
    next.displayName = patch.displayName.trim();
  }
  if (typeof patch.workDir === 'string') {
    next.workDir = patch.workDir.trim();
  }
  h.saveMeta(next);
  h.close();
  return next;
}

/** Stamp lastTurnAt. */
export function touchSession(sessionsRoot, sessionId, when = new Date().toISOString()) {
  const h = openSession(sessionsRoot, sessionId);
  const meta = h.getMeta();
  if (!meta) { h.close(); return null; }
  const next = { ...meta, lastTurnAt: when };
  h.saveMeta(next);
  h.close();
  return next;
}

/** Soft-archive: rename dir to `.archived-<sessionId>-<ts>`. */
export function archiveSession(sessionsRoot, sessionId) {
  const src = join(sessionsRoot, sessionId);
  if (!existsSync(src)) return false;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dst = join(sessionsRoot, `.archived-${sessionId}-${ts}`);
  renameSync(src, dst);
  return true;
}

/** Permanently delete a session directory. */
export function deleteSession(sessionsRoot, sessionId) {
  const src = join(sessionsRoot, sessionId);
  if (!existsSync(src)) return false;
  rmSync(src, { recursive: true, force: true });
  return true;
}

function validateMeta(meta) {
  if (!meta || typeof meta !== 'object') throw new Error('session meta.json must be object');
  if (!meta.id || typeof meta.id !== 'string') throw new Error('session.id required');
  if (!Array.isArray(meta.vpIds) || meta.vpIds.length === 0) {
    throw new Error('session.vpIds required (non-empty array)');
  }
  for (const v of meta.vpIds) {
    if (typeof v !== 'string') throw new Error('session.vpIds must be string[]');
  }
  if (meta.displayName != null && typeof meta.displayName !== 'string') {
    throw new Error('session.displayName must be string');
  }
  if (meta.workDir != null && typeof meta.workDir !== 'string') {
    throw new Error('session.workDir must be string');
  }
  if (meta.lastTurnAt != null && typeof meta.lastTurnAt !== 'string') {
    throw new Error('session.lastTurnAt must be string|null');
  }
}

/**
 * @typedef {Object} SessionHandle
 * @property {string} dir
 * @property {string} id
 * @property {() => any} getMeta
 * @property {(next:any) => void} saveMeta
 * @property {(record:any) => any} appendMessage
 * @property {() => Generator<any>} streamMessages
 * @property {(first:string,last:string) => Generator<any>} readMessageRange
 * @property {() => void} close
 */
