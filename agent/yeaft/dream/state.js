/**
 * dream/state.js.
 *
 * Three pieces of state, tracked separately:
 *
 *   1. Per-session control state (used to decide whether a session enters
 *      triage and how far to advance the cursor):
 *
 *        ~/.yeaft/memory/sessions/<id>/.dream-state
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
 *      The virtual `_no-session/` session lives at the same path layout
 *      (`sessions/_no-session/.dream-state`) and uses the same accessor.
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
 *   3. Per-scope dream-error sink (added v0.1.754):
 *
 *        ~/.yeaft/memory/<scope>/.dream-last-error.json
 *
 *      Most-recent-wins JSON written unconditionally on every triage
 *      or apply failure (best-effort — never throws even when the I/O
 *      itself fails). The runner used to swallow these exceptions and
 *      the only sink was a `config.debug`-gated console.log; this file
 *      gives operators on-disk evidence regardless of debug. See
 *      `writeDreamError` / `readDreamError` below for the contract.
 *
 * All helpers are pure I/O; no LLM, no logic beyond parsing.
 */

import { promises as fsp, existsSync } from 'fs';
import { join, dirname } from 'path';

const STATE_FILE = '.dream-state';
const ERROR_FILE = '.dream-last-error.json';
const DREAM_BLOCK_OPEN = '<!-- dream-state -->';
const DREAM_BLOCK_CLOSE = '<!-- /dream-state -->';

// ─── per-session ────────────────────────────────────────────────

/**
 * Read a session's .dream-state. Missing file → defaults.
 *
 * @param {string} root — memory root, e.g. ~/.yeaft/memory
 * @param {string} sessionId
 * @returns {Promise<{ lastDreamMessageId: string|null, lastDreamAt: string|null, messageCount: number }>}
 */
export async function readSessionState(root, sessionId) {
  const abs = join(root, 'sessions', sessionId, STATE_FILE);
  const empty = { lastDreamMessageId: null, lastDreamAt: null, messageCount: 0 };
  let raw;
  try { raw = await fsp.readFile(abs, 'utf8'); }
  catch (err) {
    if (err && err.code === 'ENOENT') return empty;
    throw err;
  }
  return parseSessionState(raw);
}

/**
 * Atomically rewrite a session's .dream-state. Creates the session dir if
 * absent. Unknown fields are ignored.
 *
 * @param {string} root
 * @param {string} sessionId
 * @param {{ lastDreamMessageId?: string|null, lastDreamAt?: string|null, messageCount?: number }} state
 */
export async function writeSessionState(root, sessionId, state) {
  const dir = join(root, 'sessions', sessionId);
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
function parseSessionState(raw) {
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

// ─── per-scope dream error sink ────────────────────────────────
//
// Why: dream silently swallowed exceptions at the triage / apply
// catch sites — the only sink was `trace.event('dream_progress', evt)`
// and a `config.debug`-gated `console.log` in `session-wiring.js`. With
// `debug=false` (the default), there was no on-disk evidence that a
// dream pass had ever failed: no `.dream-state` (because we only write
// it on success), no log file, nothing. The Resident layer's continued
// regurgitation of the bootstrap seed was the only symptom.
//
// `writeDreamError` writes `<memoryRoot>/<scope>/.dream-last-error.json`
// unconditionally on every catch (best-effort — write failures must not
// shadow the original error). Operators can then `ls ~/.yeaft/memory/
// sessions/<id>/` and see what blew up, without having to re-enable debug.

/**
 * Resolve a memoryRoot + scope-string to the scope directory.
 * The scope string is the same shape dream already uses internally:
 * `'user'`, `'sessions/<sessionId>'`, `'sessions/<sessionId>/vp/<vpId>'`, etc.
 *
 * Pure path-join; does NOT create the directory. The writer creates it.
 *
 * @param {string} root
 * @param {string} scope
 * @returns {string}
 */
export function scopeDirFor(root, scope) {
  // Defensive: trim leading/trailing slashes so callers can pass either
  // `'sessions/grp_fun'` or `/sessions/grp_fun/` — both land on the same dir.
  const clean = String(scope || '').replace(/^\/+|\/+$/g, '');
  return join(root, clean);
}

/**
 * Best-effort write of the dream-error sink. Never throws — a failed
 * write is silently swallowed because the caller is already in an
 * error-handling path and we must not mask the original failure.
 *
 * @param {string} root         — memory root, e.g. ~/.yeaft/memory
 * @param {string} scope        — `'sessions/<id>'` for triage failures,
 *                                `merged.target` for apply failures.
 * @param {{ phase: string, message: string, stack?: string|null, at?: string }} info
 * @returns {Promise<void>}
 */
export async function writeDreamError(root, scope, info) {
  try {
    const dir = scopeDirFor(root, scope);
    await fsp.mkdir(dir, { recursive: true });
    const abs = join(dir, ERROR_FILE);
    const at = (info && info.at) || new Date().toISOString();
    // Trim stack to the first 5 frames — enough for diagnosis, small
    // enough that the artifact stays human-readable. Missing/empty
    // stack collapses to `null` rather than `""` so the artifact is
    // cleaner for operators.
    const rawStack = info && typeof info.stack === 'string' ? info.stack : '';
    const stackLines = rawStack ? rawStack.split('\n').slice(0, 5) : [];
    const body = JSON.stringify({
      at,
      scope,
      phase: String(info?.phase || 'unknown'),
      message: String(info?.message || ''),
      stack: stackLines.length > 0 ? stackLines.join('\n') : null,
      rawSnippet: typeof info?.rawSnippet === 'string' ? info.rawSnippet.slice(0, 1000) : null,
    }, null, 2) + '\n';
    await atomicWrite(abs, body);
  } catch {
    // Best-effort: swallow. The caller is already handling the real
    // error; an inability to journal it must not shadow that.
  }
}

/**
 * Read the last dream error JSON for a scope, or null if absent. Used
 * by the debug panel and by tests. Tolerates a malformed file by
 * returning `{ raw: <body>, parseError: <message> }` instead of
 * throwing.
 *
 * @param {string} root
 * @param {string} scope
 * @returns {Promise<object|null>}
 */
export async function readDreamError(root, scope) {
  const abs = join(scopeDirFor(root, scope), ERROR_FILE);
  let raw;
  try { raw = await fsp.readFile(abs, 'utf8'); }
  catch (err) { if (err && err.code === 'ENOENT') return null; throw err; }
  try { return JSON.parse(raw); }
  catch (e) { return { raw, parseError: e.message }; }
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
export const _internals = { parseSessionState, extractDreamBlock };
