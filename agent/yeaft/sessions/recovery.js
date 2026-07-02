/**
 * recovery.js — best-effort Session disk self-recovery.
 *
 * Instances can contain old partially migrated Session dirs where the
 * conversation transcript still exists under conversation/messages/*.md, but
 * session.json is missing. This module repairs Session metadata and the
 * coordinator audit-log index only. It deliberately does not convert
 * conversation Markdown into the audit log: the engine/UI history source is
 * ConversationStore under conversation/, not sessions/<id>/messages/.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'fs';
import { join } from 'path';
import { writeAtomic, openLog } from '../storage/index.js';
import { parseMessage, parseSeqFromId } from '../conversation/persist.js';
import { loadSessionMeta, SESSION_META_FILE } from './session-store.js';

const SESSION_ID_RE = /^session_[A-Za-z0-9._-]+$/;
const DEFAULT_VP_ID = 'omni';
const AUDIT_INDEX_FILE = 'index.json';

export function repairSessionStore(yeaftDir, options = {}) {
  const root = join(yeaftDir, 'sessions');
  if (!existsSync(root)) return { repaired: 0, sessions: [] };
  const sessionIds = safeReadDir(root)
    .filter(name => !name.startsWith('.') && SESSION_ID_RE.test(name))
    .filter(name => isDirectory(join(root, name)));
  const sessions = [];
  for (const sessionId of sessionIds) {
    const result = repairSessionDir(root, sessionId, options);
    if (result.changed) sessions.push(result);
  }
  return { repaired: sessions.length, sessions };
}

export function repairSessionDir(sessionsRoot, sessionId, options = {}) {
  const dir = join(sessionsRoot, sessionId);
  const result = {
    sessionId,
    changed: false,
    metaCreated: false,
    auditIndexRebuilt: false,
  };
  if (!isDirectory(dir)) return result;

  if (!loadSessionMeta(dir)) {
    const meta = inferSessionMeta(dir, sessionId, options);
    writeAtomic(join(dir, SESSION_META_FILE), JSON.stringify(meta, null, 2));
    result.metaCreated = true;
    result.changed = true;
  }

  if (repairAuditIndexIfNeeded(join(dir, 'messages'))) {
    result.auditIndexRebuilt = true;
    result.changed = true;
  }

  return result;
}

function inferSessionMeta(dir, sessionId, options = {}) {
  const first = readFirstConversationMarkdownRow(dir, sessionId);
  const createdAt = first?.time || safeStatTime(dir) || new Date().toISOString();
  const name = inferSessionName(sessionId);
  const roster = Array.isArray(options.defaultRoster)
    ? options.defaultRoster.filter(v => typeof v === 'string' && v)
    : [DEFAULT_VP_ID];
  const defaultVpId = typeof options.defaultVpId === 'string'
    ? options.defaultVpId
    : (roster.includes(DEFAULT_VP_ID) ? DEFAULT_VP_ID : (roster[0] || null));
  return {
    id: sessionId,
    name,
    roster,
    defaultVpId,
    announcement: '',
    workDir: typeof options.workDir === 'string' ? options.workDir : '',
    createdAt,
  };
}

function inferSessionName(sessionId) {
  const raw = sessionId
    .replace(/^session_/, '')
    .replace(/_[A-Z0-9]{8}$/, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  return raw ? raw.replace(/\b\w/g, ch => ch.toUpperCase()) : sessionId;
}

function readFirstConversationMarkdownRow(sessionDir, sessionId) {
  const dirs = [
    join(sessionDir, 'conversation', 'cold'),
    join(sessionDir, 'conversation', 'messages'),
  ];
  let first = null;
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of safeReadDir(dir).filter(f => /^m\d+\.md$/.test(f)).sort()) {
      const msg = parseMessage(safeRead(join(dir, file)));
      if (!msg) continue;
      if (msg.sessionId && msg.sessionId !== sessionId) continue;
      if (!first || compareMarkdownMessages(msg, first) < 0) first = msg;
    }
  }
  return first;
}

function repairAuditIndexIfNeeded(messagesDir) {
  if (!existsSync(messagesDir)) return false;
  const segmentFiles = safeReadDir(messagesDir).filter(f => /^\d+\.jsonl$/.test(f)).sort();
  if (segmentFiles.length === 0) return false;

  const indexPath = join(messagesDir, AUDIT_INDEX_FILE);
  if (!auditIndexNeedsRebuild(messagesDir, indexPath, segmentFiles)) return false;

  rmSync(indexPath, { force: true });
  const log = openLog(messagesDir);
  log.close();
  return true;
}

function auditIndexNeedsRebuild(messagesDir, indexPath, segmentFiles) {
  const parsed = readJson(indexPath);
  if (!parsed || !Array.isArray(parsed.segments)) return true;
  const indexFiles = parsed.segments.map(seg => seg && seg.file).filter(Boolean).sort();
  if (indexFiles.length !== segmentFiles.length) return true;
  for (let i = 0; i < segmentFiles.length; i++) {
    if (indexFiles[i] !== segmentFiles[i]) return true;
  }

  const byFile = new Map(parsed.segments.map(seg => [seg.file, seg]));
  for (const file of segmentFiles) {
    const seg = byFile.get(file);
    if (!seg) return true;
    const bytes = safeSize(join(messagesDir, file));
    // This catches the broken real-world case: index says an existing segment
    // is empty even though the JSONL file has data. Full validation is left to
    // openLog's rebuild path after we remove the stale index.
    if (bytes > 0 && ((Number(seg.count) || 0) === 0 || (Number(seg.bytes) || 0) === 0)) return true;
  }
  return false;
}

function compareMarkdownMessages(a, b) {
  const as = parseSeqFromId(a?.id);
  const bs = parseSeqFromId(b?.id);
  if (Number.isFinite(as) && Number.isFinite(bs) && as !== bs) return as - bs;
  return String(a?.time || '').localeCompare(String(b?.time || ''));
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

function safeRead(path) {
  try { return readFileSync(path, 'utf8'); }
  catch { return ''; }
}

function safeReadDir(dir) {
  try { return readdirSync(dir); }
  catch { return []; }
}

function isDirectory(path) {
  try { return statSync(path).isDirectory(); }
  catch { return false; }
}

function safeSize(path) {
  try { return statSync(path).size; }
  catch { return 0; }
}

function safeStatTime(path) {
  try { return statSync(path).mtime.toISOString(); }
  catch { return null; }
}
