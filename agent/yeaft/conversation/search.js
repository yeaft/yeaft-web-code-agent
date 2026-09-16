/**
 * search.js — Conversation history search
 *
 * Bounded content search across hot and cold messages.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { parseMessage, parseSeqFromId } from './persist.js';

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

function matchesMessage(msg, terms) {
  if (!msg || msg.role === 'tool') return false;
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
    sessionId: msg.sessionId || source.sessionId || null,
    historySource: source.kind,
  };
}

/**
 * Search Markdown messages in one directory, newest first.
 */
function searchMarkdownDir(dir, terms, limit, source, telemetry) {
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .reverse();

  const results = [];
  for (const file of files) {
    if (results.length >= limit) break;
    const raw = readFileSync(join(dir, file), 'utf8');
    recordFileScan(telemetry, raw);
    recordMessageScan(telemetry);
    const lowerRaw = raw.toLocaleLowerCase();
    if (!terms.every(term => lowerRaw.includes(term))) continue;
    const msg = parseMessage(raw);
    if (matchesMessage(msg, terms)) results.push(withSource(msg, source));
  }
  return results;
}

function searchSegmentDir(dir, terms, limit, source, telemetry) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .sort()
    .reverse();

  const results = [];
  for (const file of files) {
    if (results.length >= limit) break;
    const raw = readFileSync(join(dir, file), 'utf8');
    recordFileScan(telemetry, raw);
    const lowerRaw = raw.toLocaleLowerCase();
    if (!terms.every(term => lowerRaw.includes(term))) continue;
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (results.length >= limit) break;
      if (!lines[i]?.trim()) continue;
      recordMessageScan(telemetry);
      const msg = parseJsonLine(lines[i]);
      if (matchesMessage(msg, terms)) results.push(withSource(msg, source));
    }
  }
  return results;
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
 * @param {{telemetry?: {scannedFiles?: number, scannedBytes?: number, scannedMessages?: number}, sessionIds?: string[]}} [options]
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

  const requestedSessionIds = Array.isArray(options.sessionIds)
    ? new Set(options.sessionIds.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))
    : null;
  const scopedSessionDirs = sessionConversationDirs(dir)
    .filter(source => !requestedSessionIds || requestedSessionIds.has(source.sessionId));
  const conversationDirs = requestedSessionIds
    ? scopedSessionDirs
    : [{ dir: join(dir, 'chat'), sessionId: null, kind: 'chat' }, ...scopedSessionDirs];

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
    ...segmentDirs.flatMap(source => searchSegmentDir(source.dir, terms, resultLimit, source, telemetry)),
    ...markdownDirs.flatMap(source => searchMarkdownDir(source.dir, terms, resultLimit, source, telemetry)),
  ]
    .sort(compareNewest)
    .slice(0, resultLimit);

  if (telemetry) telemetry.resultCount = results.length;
  return results;
}
