/**
 * output-log.js — Durable per-sub-agent event log.
 *
 * Why this exists:
 *   The original sub-agent design relied entirely on the live `onEvent`
 *   callback for visibility. If the UI dropped a frame, the WebSocket
 *   reconnected, or the user backgrounded the tab, the sub-agent's
 *   output was simply gone — there was no way to re-read it. The parent
 *   model had even less recourse: WaitAgent only returned the assistant
 *   text from the very last completed turn (and only at end_turn), so a
 *   sub-agent that ran a long tool sequence looked silent from upstairs.
 *
 *   This module gives every sub-agent a durable JSONL log on disk. Every
 *   event the runner forwards through onEvent is mirrored here. The log
 *   path is exposed to the parent through WaitAgent/ListAgents, and the
 *   parent can Read it at any time. We also expose a `tail()` helper for
 *   wait_agent to include a small preview inline.
 *
 *   Modelled on claude-code's `outputFile` discipline (LocalAgentTask).
 *
 * Format: one JSON object per line:
 *   { t: <ms epoch>, type: <evt.type>, ...payload }
 *
 * Size cap:
 *   Bounded by MAX_BYTES (~2 MiB). When the file would exceed the cap
 *   the writer rotates: rename `<id>.log` → `<id>.log.1` (overwriting any
 *   prior `.1`), and start a fresh `.log`. We keep exactly one rotation
 *   slot — no log forest — because sub-agents are ephemeral and we just
 *   want "the recent past" to remain readable.
 *
 * No external lock: each sub-agent owns its own file; we never write to
 * another agent's log. Multiple processes are not a concern (Yeaft is a
 * single agent process).
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const DEFAULT_DIR = path.join(os.homedir(), '.yeaft', 'sub-agents');
const MAX_BYTES = 2 * 1024 * 1024;      // 2 MiB before rotation
const TAIL_DEFAULT_BYTES = 8 * 1024;    // 8 KiB tail preview

/**
 * Resolve the log file for an agentId under the chosen base directory.
 * Caller controls the dir so tests can write into a tmp dir without
 * stamping on ~/.yeaft.
 *
 * @param {string} agentId
 * @param {string} [baseDir]
 * @returns {string} absolute path
 */
export function resolveLogPath(agentId, baseDir = DEFAULT_DIR) {
  if (!agentId || typeof agentId !== 'string') {
    throw new Error('resolveLogPath: agentId is required');
  }
  // Defensive: never let an agentId escape the dir via traversal.
  if (agentId.includes('/') || agentId.includes('\\') || agentId.includes('..')) {
    throw new Error(`resolveLogPath: unsafe agentId "${agentId}"`);
  }
  return path.join(baseDir, `${agentId}.log`);
}

/**
 * Create a log sink for an agent. Returns:
 *   { path, write(evt), close(), tail(maxBytes?), size() }
 *
 * `write` is best-effort: a disk error is logged once on stderr and
 * subsequent writes silently no-op for this sink. We never want a log
 * failure to crash the driver.
 *
 * `tail(maxBytes)` returns the last N bytes of the file (as a string).
 * If the file doesn't exist yet, returns ''.
 *
 * @param {string} agentId
 * @param {string} [baseDir]
 * @returns {{ path: string, write: (evt: object) => void, close: () => void, tail: (maxBytes?: number) => string, size: () => number }}
 */
export function createOutputLog(agentId, baseDir = DEFAULT_DIR) {
  const filePath = resolveLogPath(agentId, baseDir);
  let closed = false;
  let writeFailed = false;
  let currentSize = 0;

  // Best-effort dir creation; if it fails the writer will go into
  // writeFailed mode below.
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch (err) {
    writeFailed = true;
    // eslint-disable-next-line no-console
    console.warn(`[sub-agent] could not create log dir ${path.dirname(filePath)}: ${err?.message || err}`);
  }

  // If a prior log exists for this id (process restart, name reuse with
  // include_closed=false later, etc.) seed currentSize so rotation
  // calculations are correct.
  if (!writeFailed) {
    try {
      const st = fs.statSync(filePath);
      currentSize = st.size;
    } catch { /* file may not exist yet — that's fine */ }
  }

  function rotate() {
    try {
      const rotated = `${filePath}.1`;
      try { fs.unlinkSync(rotated); } catch { /* may not exist */ }
      fs.renameSync(filePath, rotated);
    } catch (err) {
      // Rotation failed — best-effort: truncate the current file so we
      // don't grow without bound.
      try { fs.truncateSync(filePath, 0); } catch { /* ignore */ }
      // eslint-disable-next-line no-console
      console.warn(`[sub-agent] log rotation failed for ${filePath}: ${err?.message || err}`);
    }
    currentSize = 0;
  }

  function write(evt) {
    if (closed || writeFailed) return;
    let line;
    try {
      const safe = serialize(evt);
      line = JSON.stringify({ t: Date.now(), ...safe }) + '\n';
    } catch {
      // Unserializable event — try a minimal record so the timeline at
      // least notes that "something happened".
      line = JSON.stringify({ t: Date.now(), type: evt?.type || 'unknown', _unserializable: true }) + '\n';
    }
    try {
      if (currentSize + line.length > MAX_BYTES) {
        rotate();
      }
      fs.appendFileSync(filePath, line);
      currentSize += line.length;
    } catch (err) {
      writeFailed = true;
      // eslint-disable-next-line no-console
      console.warn(`[sub-agent] log write failed for ${filePath}: ${err?.message || err}`);
    }
  }

  function close() {
    closed = true;
  }

  function tail(maxBytes = TAIL_DEFAULT_BYTES) {
    if (writeFailed) return '';
    try {
      const st = fs.statSync(filePath);
      if (st.size === 0) return '';
      const fd = fs.openSync(filePath, 'r');
      try {
        const readLen = Math.min(maxBytes, st.size);
        const buf = Buffer.alloc(readLen);
        fs.readSync(fd, buf, 0, readLen, st.size - readLen);
        // Drop a partial leading line so the tail starts on a clean
        // record boundary (unless we read from the very start).
        let text = buf.toString('utf8');
        if (st.size > readLen) {
          const nl = text.indexOf('\n');
          if (nl >= 0) text = text.slice(nl + 1);
        }
        return text;
      } finally {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
    } catch {
      return '';
    }
  }

  function size() {
    return currentSize;
  }

  return { path: filePath, write, close, tail, size };
}

/**
 * Trim event payloads so the log line stays bounded and serializable.
 * We keep type + small-ish text payloads; drop heavyweight fields like
 * full message arrays or binary buffers.
 */
function serialize(evt) {
  if (!evt || typeof evt !== 'object') {
    return { type: 'unknown', value: evt == null ? null : String(evt) };
  }
  const out = { type: evt.type || 'unknown' };
  if (evt.agentId)   out.agentId = evt.agentId;
  if (evt.agentName) out.agentName = evt.agentName;
  if (typeof evt.text === 'string') {
    out.text = evt.text.length > 2048 ? evt.text.slice(0, 2048) + '…' : evt.text;
  }
  if (typeof evt.content === 'string') {
    out.content = evt.content.length > 2048 ? evt.content.slice(0, 2048) + '…' : evt.content;
  }
  if (evt.stopReason) out.stopReason = evt.stopReason;
  if (evt.toolName)   out.toolName = evt.toolName;
  if (evt.toolUseId)  out.toolUseId = evt.toolUseId;
  if (evt.error) {
    out.error = typeof evt.error === 'string'
      ? evt.error
      : (evt.error.message || String(evt.error));
  }
  if (evt.status) out.status = evt.status;
  if (typeof evt.tokens === 'number') out.tokens = evt.tokens;
  return out;
}

/**
 * Read the whole log for an agent as an array of parsed records.
 * Best-effort: lines that fail to parse are skipped (with `_raw`).
 * Used by tests and by the optional /yeaft_fetch_sub_agent_log surface.
 *
 * @param {string} agentId
 * @param {string} [baseDir]
 * @returns {Array<object>}
 */
export function readOutputLog(agentId, baseDir = DEFAULT_DIR) {
  const filePath = resolveLogPath(agentId, baseDir);
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    const out = [];
    for (const line of lines) {
      try { out.push(JSON.parse(line)); }
      catch { out.push({ _raw: line }); }
    }
    return out;
  } catch {
    return [];
  }
}

export const _internals = { MAX_BYTES, TAIL_DEFAULT_BYTES, DEFAULT_DIR };
