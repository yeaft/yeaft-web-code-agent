/**
 * search.js — Conversation history search
 *
 * Simple keyword search across hot and cold messages.
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

/**
 * Search Markdown messages in a directory for a keyword.
 *
 * @param {string} dir — messages directory
 * @param {string} keyword — search term (case-insensitive)
 * @returns {object[]} — matching messages
 */
function searchMarkdownDir(dir, keyword) {
  if (!existsSync(dir)) return [];

  const lowerKeyword = keyword.toLowerCase();
  const files = readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .reverse(); // newest first within one directory

  const results = [];
  for (const file of files) {
    const raw = readFileSync(join(dir, file), 'utf8');
    if (!raw.toLowerCase().includes(lowerKeyword)) continue;

    const msg = parseMessage(raw);
    if (msg) results.push(msg);
  }
  return results;
}

function searchSegmentDir(dir, keyword) {
  if (!existsSync(dir)) return [];
  const lowerKeyword = keyword.toLowerCase();
  const files = readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .sort()
    .reverse();

  const results = [];
  for (const file of files) {
    const raw = readFileSync(join(dir, file), 'utf8');
    if (!raw.toLowerCase().includes(lowerKeyword)) continue;
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (!line || !line.toLowerCase().includes(lowerKeyword)) continue;
      const msg = parseJsonLine(line);
      if (msg) results.push(msg);
    }
  }
  return results;
}

function compareNewest(a, b) {
  const sa = parseSeqFromId(a?.id);
  const sb = parseSeqFromId(b?.id);
  if (Number.isFinite(sa) && Number.isFinite(sb) && sa !== sb) return sb - sa;
  return String(b?.time || '').localeCompare(String(a?.time || ''));
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
      dirs.push(conversationDir);
    }
  }
  return dirs;
}

/**
 * Search Yeaft history (chat + per-session + legacy conversation) for a keyword.
 *
 * @param {string} dir — Yeaft root directory (e.g. ~/.yeaft)
 * @param {string} keyword — search term
 * @param {number} [limit=20] — max results
 * @returns {object[]} — matching messages, newest first
 */
export function searchMessages(dir, keyword, limit = 20) {
  if (!keyword || !keyword.trim()) return [];

  const conversationDirs = [
    join(dir, 'chat'),
    ...sessionConversationDirs(dir),
  ];

  const markdownDirs = [
    ...conversationDirs.flatMap(d => [join(d, 'messages'), join(d, 'cold')]),
    // Compatibility for profiles created before chat/session split.
    join(dir, 'conversation', 'messages'),
    join(dir, 'conversation', 'cold'),
  ];
  const segmentDirs = conversationDirs.map(d => join(d, 'segments'));

  return [
    ...segmentDirs.flatMap(d => searchSegmentDir(d, keyword)),
    ...markdownDirs.flatMap(d => searchMarkdownDir(d, keyword)),
  ]
    .sort(compareNewest)
    .slice(0, limit);
}
