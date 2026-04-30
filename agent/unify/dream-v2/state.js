/**
 * dream-v2/state.js.
 *
 * Two pieces of state, tracked separately:
 *
 *   1. Per-group control state (used to decide whether a group enters
 *      triage and how far to advance the cursor):
 *
 *        ~/.yeaft/memory/group/<id>/.dream-state
 *
 *      A 3-line text file:
 *
 *        lastDreamMessageId: m-1024
 *        lastDreamAt: 2026-04-28T03:07:00Z
 *        messageCount: 491
 *
 *      Fields are independent of each other; missing fields default to
 *      empty / null / 0. The file is rewritten atomically every dream.
 *
 *      The virtual `_no-group/` group lives at the same path layout
 *      (`group/_no-group/.dream-state`) and uses the same accessor.
 *
 *   2. Per-scope observability marker, embedded inside the scope's
 *      `memory.md` between two HTML comments at the file's tail:
 *
 *        <!-- dream-state -->
 *        lastDreamAt: 2026-04-28T03:07:00Z
 *        <!-- /dream-state -->
 *
 *      Read for the debug panel only; it does NOT participate in any
 *      control-flow decision. We update it by replacing the existing
 *      block (if any) or appending a new one to the end of the file.
 *
 * Both helpers are pure I/O; no LLM, no logic beyond parsing.
 */

import { promises as fsp, existsSync } from 'fs';
import { join, dirname } from 'path';

const STATE_FILE = '.dream-state';
const DREAM_BLOCK_OPEN = '<!-- dream-state -->';
const DREAM_BLOCK_CLOSE = '<!-- /dream-state -->';

// ─── per-group ────────────────────────────────────────────────

/**
 * Read a group's .dream-state. Missing file → defaults.
 *
 * @param {string} root — memory root, e.g. ~/.yeaft/memory
 * @param {string} groupId
 * @returns {Promise<{ lastDreamMessageId: string|null, lastDreamAt: string|null, messageCount: number }>}
 */
export async function readGroupState(root, groupId) {
  const abs = join(root, 'group', groupId, STATE_FILE);
  const empty = { lastDreamMessageId: null, lastDreamAt: null, messageCount: 0 };
  let raw;
  try { raw = await fsp.readFile(abs, 'utf8'); }
  catch (err) { if (err && err.code === 'ENOENT') return empty; throw err; }
  return parseGroupState(raw);
}

/**
 * Atomically rewrite a group's .dream-state. Creates the group dir if
 * absent. Unknown fields are ignored.
 *
 * @param {string} root
 * @param {string} groupId
 * @param {{ lastDreamMessageId?: string|null, lastDreamAt?: string|null, messageCount?: number }} state
 */
export async function writeGroupState(root, groupId, state) {
  const dir = join(root, 'group', groupId);
  await fsp.mkdir(dir, { recursive: true });
  const abs = join(dir, STATE_FILE);
  const body =
    `lastDreamMessageId: ${state.lastDreamMessageId == null ? '' : state.lastDreamMessageId}\n` +
    `lastDreamAt: ${state.lastDreamAt == null ? '' : state.lastDreamAt}\n` +
    `messageCount: ${Number.isFinite(state.messageCount) ? state.messageCount : 0}\n`;
  await atomicWrite(abs, body);
}

/**
 * Parse the 3-line key:value format. Tolerant of stray whitespace and
 * empty values.
 * @param {string} raw
 */
function parseGroupState(raw) {
  const out = { lastDreamMessageId: null, lastDreamAt: null, messageCount: 0 };
  const lines = String(raw || '').split(/\r?\n/);
  for (const ln of lines) {
    const m = /^(\w[\w-]*)\s*:\s*(.*)$/.exec(ln);
    if (!m) continue;
    const k = m[1];
    const v = m[2].trim();
    if (k === 'lastDreamMessageId') out.lastDreamMessageId = v || null;
    else if (k === 'lastDreamAt') out.lastDreamAt = v || null;
    else if (k === 'messageCount') {
      const n = Number(v);
      out.messageCount = Number.isFinite(n) ? n : 0;
    }
  }
  return out;
}

// ─── per-scope marker (memory.md tail block) ───────────────────

/**
 * Read the lastDreamAt timestamp from a scope's memory.md, or null if
 * the file or the dream-state block is absent.
 *
 * @param {string} memoryMdAbsPath
 * @returns {Promise<string|null>}
 */
export async function readScopeDreamMarker(memoryMdAbsPath) {
  let raw;
  try { raw = await fsp.readFile(memoryMdAbsPath, 'utf8'); }
  catch (err) { if (err && err.code === 'ENOENT') return null; throw err; }
  const block = extractDreamBlock(raw);
  if (!block) return null;
  const m = /^lastDreamAt:\s*(.*)$/m.exec(block);
  return m ? (m[1].trim() || null) : null;
}

/**
 * Replace or append the per-scope dream-state block in memory.md.
 * Returns the new file body (caller decides how to persist).
 *
 * @param {string} memoryMd — current full file content
 * @param {{ lastDreamAt: string }} fields
 * @returns {string}
 */
export function withDreamMarker(memoryMd, fields) {
  const block = renderDreamBlock(fields);
  const body = String(memoryMd || '');
  if (body.includes(DREAM_BLOCK_OPEN) && body.includes(DREAM_BLOCK_CLOSE)) {
    // Replace existing block.
    return body.replace(
      new RegExp(`${escapeRe(DREAM_BLOCK_OPEN)}[\\s\\S]*?${escapeRe(DREAM_BLOCK_CLOSE)}`),
      block,
    );
  }
  // Append. Ensure exactly one newline before the block.
  const trimmed = body.replace(/\s+$/, '');
  const sep = trimmed.length === 0 ? '' : '\n\n';
  return `${trimmed}${sep}${block}\n`;
}

/**
 * Extract the contents of the dream-state block (between the two HTML
 * comments). Returns null if the block isn't present.
 * @param {string} body
 */
function extractDreamBlock(body) {
  const re = new RegExp(`${escapeRe(DREAM_BLOCK_OPEN)}([\\s\\S]*?)${escapeRe(DREAM_BLOCK_CLOSE)}`);
  const m = re.exec(String(body || ''));
  return m ? m[1].trim() : null;
}

function renderDreamBlock(fields) {
  const lines = [DREAM_BLOCK_OPEN];
  if (fields.lastDreamAt) lines.push(`lastDreamAt: ${fields.lastDreamAt}`);
  lines.push(DREAM_BLOCK_CLOSE);
  return lines.join('\n');
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ─── shared atomic writer ─────────────────────────────────────

async function atomicWrite(absPath, content) {
  await fsp.mkdir(dirname(absPath), { recursive: true });
  const tmp = `${absPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  await fsp.writeFile(tmp, content, 'utf8');
  await fsp.rename(tmp, absPath);
}

// re-exported for tests
export const _internals = { parseGroupState, extractDreamBlock };
