/**
 * search.js — Conversation history search
 *
 * Simple keyword search across hot and cold messages.
 * Reference: yeaft-unify-core-systems.md §4.3
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseMessage } from './persist.js';

/**
 * Search messages in a directory for a keyword.
 *
 * @param {string} dir — messages directory
 * @param {string} keyword — search term (case-insensitive)
 * @param {number} limit — max results
 * @returns {object[]} — matching messages
 */
function searchDir(dir, keyword, limit) {
  if (!existsSync(dir)) return [];

  const lowerKeyword = keyword.toLowerCase();
  const files = readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .reverse(); // newest first

  const results = [];
  for (const file of files) {
    if (results.length >= limit) break;

    const raw = readFileSync(join(dir, file), 'utf8');
    if (raw.toLowerCase().includes(lowerKeyword)) {
      const msg = parseMessage(raw);
      if (msg) results.push(msg);
    }
  }

  return results;
}

/**
 * Search conversation history (hot + cold) for a keyword.
 *
 * @param {string} dir — Yeaft root directory (e.g. ~/.yeaft)
 * @param {string} keyword — search term
 * @param {number} [limit=20] — max results
 * @returns {object[]} — matching messages, newest first
 */
export function searchMessages(dir, keyword, limit = 20) {
  if (!keyword || !keyword.trim()) return [];

  const msgDir = join(dir, 'conversation', 'messages');
  const coldDir = join(dir, 'conversation', 'cold');

  // Search hot first (more recent), then cold
  const hotResults = searchDir(msgDir, keyword, limit);
  const remaining = limit - hotResults.length;
  const coldResults = remaining > 0
    ? searchDir(coldDir, keyword, remaining)
    : [];

  return [...hotResults, ...coldResults];
}
