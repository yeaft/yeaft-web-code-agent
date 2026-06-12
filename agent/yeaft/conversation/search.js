/**
 * search.js — Conversation history search
 *
 * Simple keyword search across hot and cold messages.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { parseMessage, parseSeqFromId } from './persist.js';

/**
 * Search messages in a directory for a keyword.
 *
 * @param {string} dir — messages directory
 * @param {string} keyword — search term (case-insensitive)
 * @returns {object[]} — matching messages
 */
function searchDir(dir, keyword) {
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

function compareNewest(a, b) {
  const sa = parseSeqFromId(a?.id);
  const sb = parseSeqFromId(b?.id);
  if (Number.isFinite(sa) && Number.isFinite(sb) && sa !== sb) return sb - sa;
  return String(b?.time || '').localeCompare(String(a?.time || ''));
}

function sessionConversationMessageDirs(dir) {
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
      for (const kind of ['messages', 'cold']) {
        const messagesDir = join(conversationDir, kind);
        if (seen.has(messagesDir)) continue;
        seen.add(messagesDir);
        dirs.push(messagesDir);
      }
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

  const dirs = [
    join(dir, 'chat', 'messages'),
    join(dir, 'chat', 'cold'),
    ...sessionConversationMessageDirs(dir),
    // Compatibility for profiles created before chat/session split.
    join(dir, 'conversation', 'messages'),
    join(dir, 'conversation', 'cold'),
  ];

  return dirs
    .flatMap(d => searchDir(d, keyword))
    .sort(compareNewest)
    .slice(0, limit);
}
