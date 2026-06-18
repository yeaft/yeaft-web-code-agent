/**
 * store.js — Persistent Session task metadata store.
 *
 * Tasks are Session-scoped runtime facts. Metadata is stored separately from
 * logs so a noisy process cannot corrupt the task index.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, statSync } from 'fs';
import { join } from 'path';

export const TASK_STATUS = Object.freeze({
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  ORPHANED: 'orphaned',
});

const TERMINAL = new Set([
  TASK_STATUS.SUCCEEDED,
  TASK_STATUS.FAILED,
  TASK_STATUS.CANCELLED,
  TASK_STATUS.ORPHANED,
]);

export function isTerminalTaskStatus(status) {
  return TERMINAL.has(status);
}

function safeSessionId(sessionId) {
  const raw = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : 'default';
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function safeTaskId(taskId) {
  const raw = typeof taskId === 'string' && taskId.trim() ? taskId.trim() : 'task_unknown';
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export class TaskStore {
  constructor({ yeaftDir }) {
    if (!yeaftDir) throw new Error('TaskStore requires yeaftDir');
    this.yeaftDir = yeaftDir;
    this.root = join(yeaftDir, 'tasks', 'sessions');
  }

  sessionDir(sessionId) {
    return join(this.root, safeSessionId(sessionId));
  }

  taskPath(sessionId, taskId) {
    return join(this.sessionDir(sessionId), `${safeTaskId(taskId)}.json`);
  }

  logPath(sessionId, taskId) {
    return join(this.sessionDir(sessionId), `${safeTaskId(taskId)}.log`);
  }

  eventPath(sessionId) {
    return join(this.sessionDir(sessionId), 'tasks.jsonl');
  }

  ensureSessionDir(sessionId) {
    const dir = this.sessionDir(sessionId);
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    return dir;
  }

  writeTask(task) {
    if (!task?.id) throw new Error('TaskStore.writeTask requires task.id');
    const sessionId = task.sessionId || 'default';
    this.ensureSessionDir(sessionId);
    writeFileSync(this.taskPath(sessionId, task.id), `${JSON.stringify(task, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
    return task;
  }

  appendEvent(sessionId, event) {
    this.ensureSessionDir(sessionId);
    appendFileSync(this.eventPath(sessionId), `${JSON.stringify({ ...event, at: event.at || new Date().toISOString() })}\n`, { encoding: 'utf8', mode: 0o644 });
  }

  appendLog(sessionId, taskId, chunk) {
    if (typeof chunk !== 'string' || chunk.length === 0) return;
    this.ensureSessionDir(sessionId);
    appendFileSync(this.logPath(sessionId, taskId), chunk, { encoding: 'utf8', mode: 0o644 });
  }

  readLogFile(path, { offset = 0, maxBytes = 64 * 1024, tail = false } = {}) {
    if (!existsSync(path)) return { path, text: '', bytes: 0, offset: 0, nextOffset: 0 };
    const buf = readFileSync(path);
    const bytes = buf.length;
    let start = Math.max(0, Number.isFinite(offset) ? Math.floor(offset) : 0);
    const cap = Math.max(0, Math.min(Number.isFinite(maxBytes) ? Math.floor(maxBytes) : 64 * 1024, 1024 * 1024));
    if (tail) start = Math.max(0, bytes - cap);
    const end = Math.min(bytes, start + cap);
    return {
      path,
      text: buf.subarray(start, end).toString('utf8'),
      bytes,
      offset: start,
      nextOffset: end,
      truncated: end < bytes,
    };
  }

  readLog(sessionId, taskId, opts = {}) {
    return this.readLogFile(this.logPath(sessionId, taskId), opts);
  }

  readTask(sessionId, taskId) {
    const path = this.taskPath(sessionId, taskId);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  }

  loadActiveTasks() {
    if (!existsSync(this.root)) return [];
    const out = [];
    for (const sessionDirName of readdirSync(this.root, { withFileTypes: true })) {
      if (!sessionDirName.isDirectory()) continue;
      const sessionDir = join(this.root, sessionDirName.name);
      for (const entry of readdirSync(sessionDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        try {
          const task = JSON.parse(readFileSync(join(sessionDir, entry.name), 'utf8'));
          if (task && task.status === TASK_STATUS.RUNNING) out.push(task);
        } catch {
          // Ignore corrupt task metadata; one bad task must not block boot.
        }
      }
    }
    return out;
  }

  statLog(sessionId, taskId) {
    const path = this.logPath(sessionId, taskId);
    try {
      const st = statSync(path);
      return { path, bytes: st.size, mtimeMs: st.mtimeMs };
    } catch {
      return { path, bytes: 0, mtimeMs: 0 };
    }
  }
}
