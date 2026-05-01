/**
 * group-store.js — Per-group persistent store for task-334b.
 *
 * Layout (see architecture §2):
 *   ~/.yeaft/groups/<group-id>/
 *     group.json          # { id, name, roster: [vpId...], defaultVpId, createdAt }
 *     messages/           # JSONL size-rotation log (334o openLog)
 *       000001.jsonl
 *       index.json
 *     tasks/              # populated by 334n — reserved here
 *     vps/                # populated by 334c RoleInstance runtime — reserved here
 *
 * This module owns only the group.json + messages/ log. Roster mutation
 * logic lives in roster.js so coordinator and group-store both compose it.
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

const GROUP_FILE = 'group.json';
const MESSAGES_DIR = 'messages';

/**
 * Load (or create) the directory for a single group.
 *
 * @param {string} groupsRoot  e.g. `${yeaftDir}/groups`
 * @param {string} groupId
 * @returns {GroupHandle}
 */
export function openGroup(groupsRoot, groupId) {
  if (!groupId || typeof groupId !== 'string') {
    throw new Error('openGroup: groupId required (string)');
  }
  const dir = join(groupsRoot, groupId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let meta = loadGroupMeta(dir);
  if (!meta) {
    // Fresh group — caller must call initGroup() next; we return a handle
    // with meta=null so createGroup() can write the initial file.
  }

  const messagesDir = join(dir, MESSAGES_DIR);
  if (!existsSync(messagesDir)) mkdirSync(messagesDir, { recursive: true });
  const log = openLog(messagesDir);

  return {
    dir,
    id: groupId,
    /** Return current meta (reads fresh from memory after last save). */
    getMeta() { return meta ? structuredClone(meta) : null; },
    /** Overwrite group.json atomically. */
    saveMeta(next) {
      validateMeta(next);
      meta = next;
      writeAtomic(join(dir, GROUP_FILE), JSON.stringify(meta, null, 2));
    },
    /**
     * Append a message to the group log. Assigns an id if absent.
     * Returns the stored record (with id + ts).
     */
    appendMessage(record) {
      if (!record || typeof record !== 'object') {
        throw new Error('appendMessage: record required');
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
 * Create a fresh group on disk. Fails if group.json already exists.
 * @returns {GroupHandle}
 */
export function createGroup(groupsRoot, spec) {
  if (!spec || !spec.id) throw new Error('createGroup: spec.id required');
  const h = openGroup(groupsRoot, spec.id);
  if (h.getMeta()) {
    throw new Error(`group ${spec.id} already exists`);
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
    createdAt: spec.createdAt || new Date().toISOString(),
  };
  h.saveMeta(meta);
  return h;
}

/** Non-destructive load — returns null if group.json is missing/corrupt. */
export function loadGroupMeta(dir) {
  const path = join(dir, GROUP_FILE);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    validateMeta(parsed);
    // Legacy groups created before the announcement field was added are
    // forward-compat: missing field reads back as empty string.
    if (typeof parsed.announcement !== 'string') parsed.announcement = '';
    return parsed;
  } catch {
    return null;
  }
}

/** List every group directory under `groupsRoot`. */
export function listGroups(groupsRoot) {
  if (!existsSync(groupsRoot)) return [];
  const out = [];
  for (const name of readdirSync(groupsRoot)) {
    // Skip dotfiles and legacy soft-archive dirs (`.archived-*`).
    if (name.startsWith('.')) continue;
    const p = join(groupsRoot, name);
    try {
      if (!statSync(p).isDirectory()) continue;
    } catch { continue; }
    const meta = loadGroupMeta(p);
    if (meta) out.push(meta);
  }
  return out;
}

function validateMeta(meta) {
  if (!meta || typeof meta !== 'object') throw new Error('group.json must be object');
  if (!meta.id || typeof meta.id !== 'string') throw new Error('group.id required');
  if (!Array.isArray(meta.roster)) throw new Error('group.roster must be array');
  for (const v of meta.roster) {
    if (typeof v !== 'string') throw new Error('group.roster must be string[]');
  }
  if (meta.defaultVpId != null && typeof meta.defaultVpId !== 'string') {
    throw new Error('group.defaultVpId must be string|null');
  }
  if (meta.announcement != null && typeof meta.announcement !== 'string') {
    throw new Error('group.announcement must be string');
  }
}

/**
 * @typedef {Object} GroupHandle
 * @property {string} dir
 * @property {string} id
 * @property {() => any} getMeta
 * @property {(next:any)=>void} saveMeta
 * @property {(record:any)=>any} appendMessage
 * @property {() => Generator<any>} streamMessages
 * @property {(first:string,last:string)=>Generator<any>} readMessageRange
 * @property {() => void} close
 */
