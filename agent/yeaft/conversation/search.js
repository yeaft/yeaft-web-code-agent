/**
 * search.js — Conversation history search
 *
 * Simple keyword search across hot and cold messages.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
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

function compareNewestFirst(a, b) {
  const sa = parseSeqFromId(a?.id);
  const sb = parseSeqFromId(b?.id);
  if (Number.isFinite(sa) && Number.isFinite(sb) && sa !== sb) return sb - sa;
  return String(b?.time || '').localeCompare(String(a?.time || ''));
}

/**
 * Search Yeaft history (chat + group + legacy conversation) for a keyword.
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
    join(dir, 'group', 'messages'),
    join(dir, 'group', 'cold'),
    // Compatibility for profiles created before chat/group split.
    join(dir, 'conversation', 'messages'),
    join(dir, 'conversation', 'cold'),
  ];

  return dirs
    .flatMap(d => searchDir(d, keyword))
    .sort(compareNewestFirst)
    .slice(0, limit);
}
