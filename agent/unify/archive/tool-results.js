/**
 * archive/tool-results.js — DESIGN.md §4.3.
 *
 * Tool results balloon context (file dumps, web pages, grep output).
 * When `turn_age > 5` AND content length > 2000 chars, archive the body
 * to `…/archive/tool-results/<toolCallId>.md` and replace it in-place
 * with a stub. The `[user, assistant(toolCalls), tool…]` pairing is
 * preserved (the stub is still a `role:'tool'` message with the same
 * `toolCallId`) so the engine never trips the OpenAI/Anthropic schema.
 *
 * This module is pure I/O + bookkeeping. It does NOT mutate the
 * messages array directly; it returns a new array so callers can swap
 * atomically.
 */

import { promises as fs } from 'fs';
import { join, dirname } from 'path';

const DEFAULT_TURN_AGE_MIN = 5;
const DEFAULT_LENGTH_MIN = 2000;
const STUB_PREVIEW_LEN = 200;

/**
 * Where a single archived body lives. The "scope" here is the directory
 * containing the `archive/` folder — typically a group dir
 * (`groups/<gid>`) but task-scoped tools archive under `tasks/<tid>/`.
 *
 * @param {{ root: string, scopeDir: string, toolCallId: string }} args
 * @returns {string}
 */
export function toolArchivePath({ root, scopeDir, toolCallId }) {
  if (!root || !scopeDir || !toolCallId) {
    throw new Error('toolArchivePath: root + scopeDir + toolCallId required');
  }
  return join(root, scopeDir, 'archive', 'tool-results', `${toolCallId}.md`);
}

/**
 * Compute the per-message `turn_age` for tool messages: how many
 * `user` messages have appeared *after* the tool message (1-based — a
 * tool message produced this turn has age 0).
 *
 * @param {object[]} messages
 * @returns {number[]} same length as messages; age 0 for non-tool entries
 */
export function computeTurnAges(messages) {
  if (!Array.isArray(messages)) return [];
  const ages = new Array(messages.length).fill(0);
  let userSeen = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m && m.role === 'user') {
      userSeen += 1;
      continue;
    }
    if (m && m.role === 'tool') ages[i] = userSeen;
  }
  return ages;
}

/**
 * @param {{
 *   root: string,
 *   scopeDir: string,
 *   message: object,
 * }} args
 * @returns {Promise<{ stub: object, archivedBytes: number, path: string }>}
 */
export async function archiveOne({ root, scopeDir, message }) {
  if (!message || message.role !== 'tool') {
    throw new Error('archiveOne: tool message required');
  }
  const toolCallId = message.toolCallId;
  if (!toolCallId) throw new Error('archiveOne: toolCallId required');
  const body = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
  const path = toolArchivePath({ root, scopeDir, toolCallId });
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, body, 'utf8');
  const sizeStr = formatSize(body.length);
  const preview = body.slice(0, STUB_PREVIEW_LEN).replace(/\s+/g, ' ');
  const stub = {
    role: 'tool',
    toolCallId,
    content: `[archived: ${sizeStr}; preview: "${preview}"; retrieve via tool_trace("${toolCallId}")]`,
    isError: !!message.isError,
  };
  return { stub, archivedBytes: body.length, path };
}

/**
 * Read a previously-archived tool result body.
 *
 * @param {{ root: string, scopeDir: string, toolCallId: string }} args
 * @returns {Promise<string|null>} body, or null if not found
 */
export async function readArchivedTool({ root, scopeDir, toolCallId }) {
  const path = toolArchivePath({ root, scopeDir, toolCallId });
  try {
    return await fs.readFile(path, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Sweep messages, archive every tool message that meets the age/length
 * thresholds, return a new messages array with stubs swapped in. Untouched
 * messages keep object identity.
 *
 * @param {{
 *   root: string,
 *   scopeDir: string,
 *   messages: object[],
 *   turnAgeMin?: number,
 *   lengthMin?: number,
 * }} args
 * @returns {Promise<{
 *   nextMessages: object[],
 *   archivedCount: number,
 *   archivedBytes: number,
 * }>}
 */
export async function archiveToolResults({
  root, scopeDir, messages,
  turnAgeMin = DEFAULT_TURN_AGE_MIN, lengthMin = DEFAULT_LENGTH_MIN,
}) {
  if (!Array.isArray(messages)) throw new Error('archiveToolResults: messages array required');
  const ages = computeTurnAges(messages);
  let mutated = false;
  let archivedCount = 0;
  let archivedBytes = 0;
  const out = messages.slice();
  for (let i = 0; i < out.length; i += 1) {
    const m = out[i];
    if (!m || m.role !== 'tool' || !m.toolCallId) continue;
    if (typeof m.content !== 'string') continue;
    if (m.content.startsWith('[archived:')) continue;  // already a stub
    if (ages[i] <= turnAgeMin) continue;
    if (m.content.length <= lengthMin) continue;
    const r = await archiveOne({ root, scopeDir, message: m });
    out[i] = r.stub;
    archivedCount += 1;
    archivedBytes += r.archivedBytes;
    mutated = true;
  }
  return {
    nextMessages: mutated ? out : messages,
    archivedCount,
    archivedBytes,
  };
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
