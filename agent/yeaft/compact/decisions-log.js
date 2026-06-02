/**
 * compact/decisions-log.js — DESIGN.md §9.1.
 *
 * Per-task append-only "decisions log". When two VPs run in parallel
 * for the same `targetTaskId` (e.g. a router fan-out), both may want to
 * write a decision. Atomic file create on `entries/*.md` solves the
 * single-entry case; the decisions log is the sequencing layer that
 * lets compact (track 2) read a chronological record and produce one
 * canonical `tasks/<tid>/summary.md`.
 *
 * Format: line-delimited JSON (`decisions.jsonl`). Each line:
 *
 *   {"ts": "<ISO>", "vpId": "<id>", "kind": "<decision-kind>", "text": "<…>"}
 *
 * Append uses `fs.appendFile` which is atomic for small writes on
 * POSIX. Readers tolerate partial last-line corruption (very unlikely
 * but cheap to handle): unparseable lines are skipped with a warning.
 */

import { promises as fs } from 'fs';
import { join, dirname } from 'path';

const FILE = 'decisions.jsonl';

/**
 * @param {string} root
 * @param {string} taskId
 * @returns {string} absolute path
 */
export function decisionsLogPath(root, taskId) {
  if (!root) throw new Error('decisionsLogPath: root required');
  if (!taskId) throw new Error('decisionsLogPath: taskId required');
  return join(root, 'tasks', taskId, FILE);
}

/**
 * Append a decision row. Creates the parent directory on first write.
 *
 * @param {{
 *   root: string,
 *   taskId: string,
 *   vpId: string,
 *   kind: string,
 *   text: string,
 *   ts?: string,
 * }} args
 * @returns {Promise<{ path: string, line: string }>}
 */
export async function appendDecision({ root, taskId, vpId, kind, text, ts }) {
  if (!vpId) throw new Error('appendDecision: vpId required');
  if (!kind) throw new Error('appendDecision: kind required');
  const path = decisionsLogPath(root, taskId);
  await fs.mkdir(dirname(path), { recursive: true });
  const row = {
    ts: ts || new Date().toISOString(),
    vpId,
    kind,
    text: typeof text === 'string' ? text : '',
  };
  const line = JSON.stringify(row) + '\n';
  await fs.appendFile(path, line, 'utf8');
  return { path, line };
}

/**
 * Read the decisions log. Returns [] on missing file. Skips lines that
 * fail JSON parse (logged via console.warn) so a torn write never
 * blocks the reader.
 *
 * @param {{ root: string, taskId: string }} args
 * @returns {Promise<Array<{ts: string, vpId: string, kind: string, text: string}>>}
 */
export async function readDecisions({ root, taskId }) {
  const path = decisionsLogPath(root, taskId);
  let content;
  try {
    content = await fs.readFile(path, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  const lines = content.split('\n');
  for (const ln of lines) {
    if (!ln.trim()) continue;
    try {
      const row = JSON.parse(ln);
      if (row && typeof row === 'object') out.push(row);
    } catch {
      // Tolerate the very last line being torn; warn but continue.
      // (We could distinguish "torn last line" vs "corrupt mid-line"
      // but the read path doesn't need to.)
      // eslint-disable-next-line no-console
      console.warn(`decisions-log: skipped unparseable line in ${path}`);
    }
  }
  return out;
}
