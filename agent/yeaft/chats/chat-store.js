/**
 * chat-store.js — Per-chat persistent store for Yeaft Chat Mode.
 *
 * Layout (architecture parity with group-store.js):
 *   ~/.yeaft/chats/<chat-id>/
 *     chat.json           # { id, displayName, vpId, workDir, createdAt, lastTurnAt }
 *     messages/           # JSONL size-rotation log
 *       000001.jsonl
 *       index.json
 *
 * A chat is 1:1 with a single VP and persists messages the same way groups
 * do — same storage primitives, same jsonl shape — but without a roster.
 *
 * Hard constraint: no @-mention parsing, no dispatch, no engine awareness.
 * This module only owns chat.json + the messages log.
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
import { nextMsgId, isReservedVpId, ReservedVpIdError, validateVpId, InvalidVpIdError } from '../groups/ids.js';

const CHAT_FILE = 'chat.json';
const MESSAGES_DIR = 'messages';

const CHAT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Open (or partially create) the directory for a chat. Returns a handle even
 * when chat.json is absent — call createChat() to materialise it.
 *
 * @param {string} chatsRoot
 * @param {string} chatId
 * @returns {ChatHandle}
 */
export function openChat(chatsRoot, chatId) {
  if (!chatId || typeof chatId !== 'string') {
    throw new Error('openChat: chatId required (string)');
  }
  if (!CHAT_ID_RE.test(chatId)) {
    throw new Error(`openChat: invalid chatId "${chatId}"`);
  }
  const dir = join(chatsRoot, chatId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let meta = loadChatMeta(dir);

  const messagesDir = join(dir, MESSAGES_DIR);
  if (!existsSync(messagesDir)) mkdirSync(messagesDir, { recursive: true });
  const log = openLog(messagesDir);

  return {
    dir,
    id: chatId,
    getMeta() { return meta ? structuredClone(meta) : null; },
    saveMeta(next) {
      validateMeta(next);
      meta = next;
      writeAtomic(join(dir, CHAT_FILE), JSON.stringify(meta, null, 2));
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
 * Create a new chat on disk. Fails if chat.json already exists.
 * @param {string} chatsRoot
 * @param {{id:string, vpId:string, displayName?:string, workDir?:string, createdAt?:string}} spec
 * @returns {ChatHandle}
 */
export function createChat(chatsRoot, spec) {
  if (!spec || !spec.id) throw new Error('createChat: spec.id required');
  if (!spec.vpId) throw new Error('createChat: spec.vpId required');
  if (isReservedVpId(spec.vpId)) throw new ReservedVpIdError(spec.vpId);
  const verdict = validateVpId(spec.vpId);
  if (!verdict.ok) throw new InvalidVpIdError(spec.vpId, verdict.reason);

  const h = openChat(chatsRoot, spec.id);
  if (h.getMeta()) {
    throw new Error(`chat ${spec.id} already exists`);
  }
  const meta = {
    id: spec.id,
    displayName: typeof spec.displayName === 'string' && spec.displayName.trim()
      ? spec.displayName.trim() : spec.id,
    vpId: spec.vpId,
    workDir: typeof spec.workDir === 'string' ? spec.workDir.trim() : '',
    createdAt: spec.createdAt || new Date().toISOString(),
    lastTurnAt: null,
  };
  h.saveMeta(meta);
  return h;
}

/** Non-destructive load — returns null if chat.json is missing/corrupt. */
export function loadChatMeta(dir) {
  const path = join(dir, CHAT_FILE);
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

/** List every chat directory under `chatsRoot`. */
export function listChats(chatsRoot) {
  if (!existsSync(chatsRoot)) return [];
  const out = [];
  for (const name of readdirSync(chatsRoot)) {
    if (name.startsWith('.')) continue;
    const p = join(chatsRoot, name);
    try {
      if (!statSync(p).isDirectory()) continue;
    } catch { continue; }
    const meta = loadChatMeta(p);
    if (meta) out.push(meta);
  }
  return out;
}

/** Update a chat's displayName. */
export function renameChat(chatsRoot, chatId, displayName) {
  const h = openChat(chatsRoot, chatId);
  const meta = h.getMeta();
  if (!meta) throw new Error(`renameChat: chat ${chatId} not found`);
  const next = { ...meta, displayName: String(displayName || '').trim() || meta.id };
  h.saveMeta(next);
  h.close();
  return next;
}

/** Stamp lastTurnAt — invoked by web-bridge after a successful turn. */
export function touchChat(chatsRoot, chatId, when = new Date().toISOString()) {
  const h = openChat(chatsRoot, chatId);
  const meta = h.getMeta();
  if (!meta) { h.close(); return null; }
  const next = { ...meta, lastTurnAt: when };
  h.saveMeta(next);
  h.close();
  return next;
}

/** Soft-archive: rename dir to `.archived-<chatId>-<ts>`. */
export function archiveChat(chatsRoot, chatId) {
  const src = join(chatsRoot, chatId);
  if (!existsSync(src)) return false;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dst = join(chatsRoot, `.archived-${chatId}-${ts}`);
  renameSync(src, dst);
  return true;
}

/** Permanently delete a chat directory. Use after archive when sure. */
export function deleteChat(chatsRoot, chatId) {
  const src = join(chatsRoot, chatId);
  if (!existsSync(src)) return false;
  rmSync(src, { recursive: true, force: true });
  return true;
}

function validateMeta(meta) {
  if (!meta || typeof meta !== 'object') throw new Error('chat.json must be object');
  if (!meta.id || typeof meta.id !== 'string') throw new Error('chat.id required');
  if (!meta.vpId || typeof meta.vpId !== 'string') throw new Error('chat.vpId required');
  if (meta.displayName != null && typeof meta.displayName !== 'string') {
    throw new Error('chat.displayName must be string');
  }
  if (meta.workDir != null && typeof meta.workDir !== 'string') {
    throw new Error('chat.workDir must be string');
  }
  if (meta.lastTurnAt != null && typeof meta.lastTurnAt !== 'string') {
    throw new Error('chat.lastTurnAt must be string|null');
  }
}

/**
 * @typedef {Object} ChatHandle
 * @property {string} dir
 * @property {string} id
 * @property {() => any} getMeta
 * @property {(next:any) => void} saveMeta
 * @property {(record:any) => any} appendMessage
 * @property {() => Generator<any>} streamMessages
 * @property {(first:string,last:string) => Generator<any>} readMessageRange
 * @property {() => void} close
 */
