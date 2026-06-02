/**
 * archive/turn-archive.js — DESIGN.md §4.2 + §4.4.
 *
 * When compact archives a cooling turn-group, the full content is
 * written to `…/archive/<turnId>.md` so a worker can later replay it via
 * `message_trace({turnId})`. Each archived turn is one markdown file
 * with a YAML-ish header followed by JSON-encoded message bodies. We
 * keep the format intentionally simple: any caller that can read JSON
 * lines can replay it.
 *
 * Format:
 *
 *   ---
 *   turnId: <id>
 *   archivedAt: <ISO>
 *   messageCount: <n>
 *   ---
 *   <line-delimited JSON, one message per line>
 *
 * We do NOT strip `_meta` here — DESIGN.md §9.15 says "Compact archive
 * carries `_meta` into the archived turn — useful for `message_trace`
 * replays".
 */

import { promises as fs } from 'fs';
import { join, dirname } from 'path';

/**
 * @param {{ root: string, scopeDir: string, turnId: string }} args
 */
export function turnArchivePath({ root, scopeDir, turnId }) {
  if (!root || !scopeDir || !turnId) {
    throw new Error('turnArchivePath: root + scopeDir + turnId required');
  }
  return join(root, scopeDir, 'archive', `${turnId}.md`);
}

/**
 * @param {{
 *   root: string,
 *   scopeDir: string,
 *   turnId: string,
 *   messages: object[],
 *   archivedAt?: string,
 * }} args
 * @returns {Promise<{ path: string, byteLength: number }>}
 */
export async function archiveTurn({ root, scopeDir, turnId, messages, archivedAt }) {
  if (!Array.isArray(messages)) throw new Error('archiveTurn: messages array required');
  const path = turnArchivePath({ root, scopeDir, turnId });
  await fs.mkdir(dirname(path), { recursive: true });
  const header = [
    '---',
    `turnId: ${turnId}`,
    `archivedAt: ${archivedAt || new Date().toISOString()}`,
    `messageCount: ${messages.length}`,
    '---',
    '',
  ].join('\n');
  const body = messages.map(m => JSON.stringify(m)).join('\n');
  const content = header + body + (messages.length ? '\n' : '');
  await fs.writeFile(path, content, 'utf8');
  return { path, byteLength: content.length };
}

/**
 * @param {{ root: string, scopeDir: string, turnId: string }} args
 * @returns {Promise<{ header: object, messages: object[] } | null>}
 */
export async function readArchivedTurn({ root, scopeDir, turnId }) {
  const path = turnArchivePath({ root, scopeDir, turnId });
  let content;
  try {
    content = await fs.readFile(path, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  const m = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { header: {}, messages: [] };
  const header = {};
  for (const ln of m[1].split('\n')) {
    const idx = ln.indexOf(':');
    if (idx < 0) continue;
    header[ln.slice(0, idx).trim()] = ln.slice(idx + 1).trim();
  }
  const messages = [];
  for (const ln of m[2].split('\n')) {
    if (!ln.trim()) continue;
    try {
      messages.push(JSON.parse(ln));
    } catch {
      // Skip torn line.
    }
  }
  return { header, messages };
}
