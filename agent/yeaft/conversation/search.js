/**
 * search.js — Conversation history search
 *
 * Bounded content search across hot and cold messages.
 */

import { closeSync, constants, existsSync, fstatSync, lstatSync, opendirSync, openSync, readSync, readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { parseMessage, parseSeqFromId } from './persist.js';
import { isVisibleConversationRow } from './internal-control.js';
import { readSessionTurnDeletions, sessionDeletionProjection } from './turn-deletion-journal.js';
import { sessionManifestPath } from '../sessions/session-manifest.js';
import { SESSION_META_FILE } from '../sessions/session-store.js';


const MAX_AGENT_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_AGENT_FILE_BYTES = 8 * 1024 * 1024;
const MAX_AGENT_DIRECTORY_ENTRIES = 16_000;

// Match the canonical deletion journal's ID width so it cannot alias a different Session.
export const isAgentHistorySessionId = id => typeof id === 'string' && /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}$/.test(id);

// Only the explicit agent scope uses these shared, per-call I/O bounds. The
// configured instance root is trusted; no symlinks below it are traversed.
export function createAgentHistoryScan(instanceRoot, telemetry, signal, { maxScanBytes = MAX_AGENT_SCAN_BYTES } = {}) {
  const root = resolve(instanceRoot);
  let remainingBytes = maxScanBytes;
  let remainingEntries = MAX_AGENT_DIRECTORY_ENTRIES;
  const limited = () => { telemetry.scanIncomplete = true; return null; };
  const stopped = () => signal?.aborted || remainingBytes <= 0 || remainingEntries <= 0;
  const missing = error => ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code);

  function isDirectory(dir) {
    if (dir === root) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    const parentExists = isDirectory(parent);
    if (parentExists !== true) return parentExists;
    try { return lstatSync(dir).isDirectory(); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  }

  return {
    stopped,
    limited,
    list(dir, suffix) {
      if (stopped()) return limited();
      dir = resolve(dir);
      const directoryExists = isDirectory(dir);
      if (directoryExists !== true) return directoryExists === undefined ? [] : limited();
      const files = [];
      let handle;
      try {
        handle = opendirSync(dir);
        for (let entry; (entry = handle.readSync());) {
          if (remainingEntries-- <= 0) {
            limited();
            break;
          }
          if (entry.isFile() && entry.name.endsWith(suffix)) files.push(entry.name);
        }
      } catch (error) {
        if (!missing(error)) throw error;
      } finally {
        handle?.closeSync();
      }
      return files;
    },
    read(file) {
      if (signal?.aborted || remainingBytes <= 0) return limited();
      file = resolve(file);
      const directoryExists = isDirectory(dirname(file));
      if (directoryExists !== true) return directoryExists === undefined ? undefined : limited();
      let fd;
      try {
        const before = lstatSync(file);
        if (!before.isFile()) return limited();
        fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) return limited();
        if (stat.size > MAX_AGENT_FILE_BYTES || stat.size > remainingBytes) return limited();
        const buffer = Buffer.allocUnsafe(stat.size);
        let count = 0;
        while (count < buffer.length) {
          const bytes = readSync(fd, buffer, count, buffer.length - count, null);
          if (bytes === 0) break;
          count += bytes;
        }
        remainingBytes -= count;
        return buffer.toString('utf8', 0, count);
      } catch (error) {
        if (error.code === 'ENOENT') return undefined;
        if (missing(error)) return limited();
        throw error;
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    },
  };
}

function parseJsonObject(raw) {
  if (typeof raw !== 'string') return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function canonicalAgentSessions(dir, requestedIds, scan) {
  const manifest = parseJsonObject(scan.read(sessionManifestPath(dir)));
  if (manifest?.version !== 1 || !Array.isArray(manifest.sessions)) return [];

  const entries = new Map();
  for (const entry of manifest.sessions) {
    if (requestedIds.has(entry?.id)) entries.set(entry.id, entries.has(entry.id) ? null : entry);
  }

  const ids = [];
  for (const id of requestedIds) {
    const entry = entries.get(id);
    if (!entry || typeof entry.path !== 'string' || typeof entry.createdAt !== 'string' || !entry.createdAt.trim()) continue;
    const sessionDir = resolve(dir, 'sessions', id);
    if (resolve(entry.path) !== sessionDir) continue;
    // The host catalog carries IDs only. Compare the local incarnation against
    // the manifest to reject a different Session left at the same path.
    const meta = parseJsonObject(scan.read(join(sessionDir, SESSION_META_FILE)));
    if (meta?.id === id && meta.createdAt === entry.createdAt) ids.push(id);
  }
  return ids;
}

function parseJsonLine(line) {
  if (!line || !line.trim()) return null;
  try {
    const msg = JSON.parse(line);
    return msg && typeof msg === 'object' ? msg : null;
  } catch {
    return null;
  }
}

function normalizeTerms(keyword) {
  return String(keyword || '')
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/u)
    .filter(Boolean);
}

function searchableContent(msg) {
  if (typeof msg?.content === 'string') return msg.content;
  if (Array.isArray(msg?.content)) {
    return msg.content
      .map(block => typeof block === 'string' ? block : (block?.text || ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function matchesMessage(msg, terms, source, boundary) {
  if (!msg || msg.role === 'tool' || !isVisibleConversationRow(msg)) return false;
  if (source.agentScan && msg.role !== 'user' && msg.role !== 'assistant') return false;
  // Sequence numbers belong to the source Session, not to a sibling transcript
  // (or a row's optional sessionId). Filter before counting toward any limit.
  if (boundary && source.sessionId === boundary.sessionId) {
    const seq = Number.isFinite(msg.seq) ? msg.seq : parseSeqFromId(msg.id);
    if (Number.isFinite(seq) && seq >= boundary.beforeSeq) return false;
  }
  const content = searchableContent(msg).toLocaleLowerCase();
  return content.length > 0 && terms.every(term => content.includes(term));
}

function recordFileScan(telemetry, raw) {
  if (!telemetry) return;
  telemetry.scannedFiles += 1;
  telemetry.scannedBytes += Buffer.byteLength(raw, 'utf8');
}

function recordMessageScan(telemetry) {
  if (telemetry) telemetry.scannedMessages += 1;
}

function withSource(msg, source) {
  const { providerState, thinkingBlocks, ...publicMessage } = msg;
  return {
    ...publicMessage,
    content: searchableContent(msg),
    sessionId: source.sessionId || msg.sessionId || null,
    historySource: source.kind,
  };
}

/**
 * Search Markdown messages in one directory, newest first.
 */
function searchMarkdownDir(dir, terms, limit, source, telemetry, boundary) {
  const { agentScan } = source;
  const files = (agentScan ? agentScan.list(dir, '.md') || []
    : existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.md')) : [])
    .sort()
    .reverse();

  const results = [];
  for (const file of files) {
    if (!agentScan && results.length >= limit) break;
    if (agentScan?.stopped()) {
      agentScan.limited();
      break;
    }
    const path = join(dir, file);
    const raw = agentScan ? agentScan.read(path) : readFileSync(path, 'utf8');
    if (raw == null) continue;
    recordFileScan(telemetry, raw);
    recordMessageScan(telemetry);
    if (!agentScan) {
      const lowerRaw = raw.toLocaleLowerCase();
      if (!terms.every(term => lowerRaw.includes(term))) continue;
    }
    const msg = source.project(parseMessage(raw), source.sessionId);
    collectMatch(results, msg, terms, source, boundary, limit);
  }
  return results;
}

function searchSegmentDir(dir, terms, limit, source, telemetry, boundary) {
  const { agentScan } = source;
  const files = (agentScan ? agentScan.list(dir, '.jsonl') || []
    : existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.jsonl')) : [])
    .sort()
    .reverse();

  const results = [];
  for (const file of files) {
    if (!agentScan && results.length >= limit) break;
    if (agentScan?.stopped()) {
      agentScan.limited();
      break;
    }
    const path = join(dir, file);
    const raw = agentScan ? agentScan.read(path) : readFileSync(path, 'utf8');
    if (raw == null) continue;
    recordFileScan(telemetry, raw);
    if (!agentScan) {
      const lowerRaw = raw.toLocaleLowerCase();
      if (!terms.every(term => lowerRaw.includes(term))) continue;
    }
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!agentScan && results.length >= limit) break;
      if (!lines[i]?.trim()) continue;
      recordMessageScan(telemetry);
      const msg = source.project(parseJsonLine(lines[i]), source.sessionId);
      collectMatch(results, msg, terms, source, boundary, limit);
    }
  }
  return results;
}

function collectMatch(results, msg, terms, source, boundary, limit) {
  if (!matchesMessage(msg, terms, source, boundary)) return;
  if (!source.agentScan) {
    results.push(withSource(msg, source));
    return;
  }
  // Retain only the newest matches even if old-format files or rows arrive
  // out of timestamp order. Do not retain the full scan in memory.
  const candidate = withSource(msg, source);
  let low = 0;
  let high = results.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (compareNewest(candidate, results[mid]) < 0) high = mid;
    else low = mid + 1;
  }
  if (low >= limit) return;
  results.splice(low, 0, candidate);
  if (results.length > limit) results.pop();
}

function compareNewest(a, b) {
  const timeComparison = String(b?.time || b?.timestamp || '').localeCompare(String(a?.time || a?.timestamp || ''));
  if (timeComparison !== 0) return timeComparison;
  if (a?.sessionId !== b?.sessionId || a?.historySource !== b?.historySource) return 0;
  const sa = parseSeqFromId(a?.id);
  const sb = parseSeqFromId(b?.id);
  return Number.isFinite(sa) && Number.isFinite(sb) ? sb - sa : 0;
}

function sessionConversationDirs(dir) {
  const dirs = [];
  const seen = new Set();
  for (const rootName of ['sessions', 'groups']) {
    const root = join(dir, rootName);
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      const sessionDir = join(root, name);
      try {
        if (!statSync(sessionDir).isDirectory()) continue;
      } catch {
        continue;
      }

      const conversationDir = join(sessionDir, 'conversation');
      if (seen.has(conversationDir)) continue;
      seen.add(conversationDir);
      dirs.push({ dir: conversationDir, sessionId: name, kind: rootName === 'sessions' ? 'session' : 'legacy-session' });
    }
  }
  return dirs;
}

/**
 * Search Yeaft history (chat + per-session + legacy conversation) by content.
 * Whitespace-separated terms use AND semantics. Tool messages are excluded.
 *
 * @param {string} dir — Yeaft root directory (e.g. ~/.yeaft)
 * @param {string} keyword — search terms
 * @param {number} [limit=10] — max results
 * @param {{telemetry?: {scannedFiles?: number, scannedBytes?: number, scannedMessages?: number, scannedSessions?: number}, sessionIds?: string[], boundarySessionId?: string, beforeSeq?: number, beforeMessageId?: string, agentScan?: ReturnType<typeof createAgentHistoryScan>, agentCurrentSessionId?: string}} [options]
 *   A trusted exclusive boundary applies only to boundarySessionId's transcript.
 *   Finite beforeSeq takes precedence over a monotonic beforeMessageId. Without
 *   a valid boundary, legacy search behavior is preserved.
 * @returns {object[]} — matching messages, newest first
 */
export function searchMessages(dir, keyword, limit = 10, options = {}) {
  const terms = normalizeTerms(keyword);
  if (terms.length === 0) return [];

  const resultLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 10)));
  const telemetry = options.telemetry || null;
  if (telemetry) {
    telemetry.scannedFiles = 0;
    telemetry.scannedBytes = 0;
    telemetry.scannedMessages = 0;
  }

  const beforeSeq = Number.isFinite(options.beforeSeq)
    ? options.beforeSeq
    : parseSeqFromId(options.beforeMessageId);
  const boundary = typeof options.boundarySessionId === 'string' && options.boundarySessionId && Number.isFinite(beforeSeq)
    ? { sessionId: options.boundarySessionId, beforeSeq }
    : null;

  const { agentScan } = options;
  const requestedSessionIds = Array.isArray(options.sessionIds)
    ? new Set(agentScan ? options.sessionIds.filter(isAgentHistorySessionId)
      : options.sessionIds.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))
    : null;
  let scopedSessionDirs;
  if (agentScan) {
    if (!requestedSessionIds?.has(options.agentCurrentSessionId)) throw new Error('Agent history requires an authorized current Session');
    const ids = canonicalAgentSessions(dir, requestedSessionIds, agentScan);
    if (!ids.includes(options.agentCurrentSessionId)) throw new Error('Agent history requires a canonical current Session');
    scopedSessionDirs = ids.map(sessionId => ({
      dir: join(dir, 'sessions', sessionId, 'conversation'),
      sessionId,
      kind: 'session',
      agentScan,
    }));
  } else {
    scopedSessionDirs = sessionConversationDirs(dir).filter(source => !requestedSessionIds || requestedSessionIds.has(source.sessionId));
  }
  const conversationDirs = requestedSessionIds
    ? scopedSessionDirs
    : [{ dir: join(dir, 'chat'), sessionId: null, kind: 'chat' }, ...scopedSessionDirs];

  const deletions = new Map();
  const project = (row, scopeId) => {
    if (!row) return null;
    const sessionId = agentScan ? scopeId : row.sessionId || scopeId;
    if (!sessionId) return row;
    if (!deletions.has(sessionId)) {
      if (agentScan) {
        // A missing journal is normal; an unreadable or over-budget journal
        // must never let a logically deleted row back into results.
        const journal = readSessionTurnDeletions(dir, sessionId, agentScan.read);
        deletions.set(sessionId, journal ? sessionDeletionProjection(journal.operations) : null);
      } else {
        deletions.set(sessionId, sessionDeletionProjection(readSessionTurnDeletions(dir, sessionId).operations));
      }
    }
    if (agentScan) {
      // Only a well-formed copy origin on a correctly owned row can exempt it
      // from the local causal-ID scrub (copies may reuse another Session's IDs).
      const { origin } = row;
      const validCopyOrigin = row.sessionId === scopeId && origin && !Array.isArray(origin)
        && isAgentHistorySessionId(origin.sessionId) && origin.sessionId !== scopeId
        && typeof origin.streamId === 'string' && origin.streamId.trim()
        && typeof origin.messageId === 'string' && origin.messageId.trim();
      row = { ...row, sessionId: scopeId, origin: validCopyOrigin ? origin : null };
    }
    return deletions.get(sessionId)?.scrub(row) ?? null;
  };
  if (agentScan) {
    let results = [];
    if (telemetry) telemetry.scannedSessions = 0;
    for (const source of conversationDirs) {
      if (agentScan.stopped()) {
        agentScan.limited();
        break;
      }
      if (telemetry) telemetry.scannedSessions += 1;
      const projected = { ...source, project };
      results = [
        ...results,
        ...searchSegmentDir(join(source.dir, 'segments'), terms, resultLimit, projected, telemetry, boundary),
        ...searchMarkdownDir(join(source.dir, 'messages'), terms, resultLimit, projected, telemetry, boundary),
        ...searchMarkdownDir(join(source.dir, 'cold'), terms, resultLimit, projected, telemetry, boundary),
      ].sort(compareNewest).slice(0, resultLimit);
    }
    if (telemetry) telemetry.resultCount = results.length;
    return results;
  }
  const markdownDirs = [
    ...conversationDirs.flatMap(source => [
      { ...source, dir: join(source.dir, 'messages') },
      { ...source, dir: join(source.dir, 'cold') },
    ]),
    ...(!requestedSessionIds ? [
      { dir: join(dir, 'conversation', 'messages'), sessionId: null, kind: 'legacy-conversation' },
      { dir: join(dir, 'conversation', 'cold'), sessionId: null, kind: 'legacy-conversation' },
    ] : []),
  ];
  const segmentDirs = conversationDirs.map(source => ({ ...source, dir: join(source.dir, 'segments') }));

  const results = [
    ...segmentDirs.flatMap(source => searchSegmentDir(source.dir, terms, resultLimit, { ...source, project }, telemetry, boundary)),
    ...markdownDirs.flatMap(source => searchMarkdownDir(source.dir, terms, resultLimit, { ...source, project }, telemetry, boundary)),
  ]
    .sort(compareNewest)
    .slice(0, resultLimit);

  if (telemetry) telemetry.resultCount = results.length;
  return results;
}
