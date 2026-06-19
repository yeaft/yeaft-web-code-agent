/**
 * manager.js — Session-scoped background task manager.
 *
 * First-class tasks cover shell background commands today and provide the
 * shared model that sub-agents can attach to next.
 */

import { randomUUID } from 'crypto';
import { TaskStore, TASK_STATUS, isTerminalTaskStatus } from './store.js';
import { startShellProcess } from './shell-runner.js';
import { getRuntimePlatformInfo } from '../runtime-platform.js';

const LOG_PREVIEW_BYTES = 4096;

function nowIso() {
  return new Date().toISOString();
}

function makeTaskId() {
  return `task_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function publicSnapshot(task) {
  if (!task) return null;
  return {
    id: task.id,
    sessionId: task.sessionId,
    ownerVpId: task.ownerVpId || null,
    kind: task.kind,
    title: task.title,
    status: task.status,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    updatedAt: task.updatedAt,
    endedAt: task.endedAt || null,
    runtime: task.runtime || {},
    log: task.log || {},
    result: task.result || {},
    source: task.source || {},
  };
}

export class TaskManager {
  constructor({ yeaftDir, onEvent = null, runtimePlatform = null } = {}) {
    if (!yeaftDir) throw new Error('TaskManager requires yeaftDir');
    this.store = new TaskStore({ yeaftDir });
    this.onEvent = typeof onEvent === 'function' ? onEvent : null;
    this.runtimePlatform = runtimePlatform || getRuntimePlatformInfo();
    this.active = new Map();
    this.processes = new Map();
    this.#loadPersistedRunningTasks();
  }

  setEventSink(onEvent) {
    this.onEvent = typeof onEvent === 'function' ? onEvent : null;
  }

  #key(sessionId, taskId) {
    return `${sessionId || 'default'}::${taskId}`;
  }

  #emit(event, task, extra = {}) {
    const payload = { type: 'yeaft_task_event', event, task: publicSnapshot(task), ...extra };
    try { this.onEvent?.(payload); } catch { /* event sinks must not break tasks */ }
  }

  #loadPersistedRunningTasks() {
    for (const task of this.store.loadActiveTasks()) {
      const orphaned = {
        ...task,
        status: TASK_STATUS.ORPHANED,
        updatedAt: nowIso(),
        endedAt: nowIso(),
        result: {
          ...(task.result || {}),
          error: 'Agent restarted while task was running; process control was lost.',
        },
      };
      this.store.writeTask(orphaned);
      this.store.appendEvent(orphaned.sessionId, { event: 'orphaned', taskId: orphaned.id });
      this.#emit('completed', orphaned);
    }
  }

  startTask({ sessionId, ownerVpId = null, kind = 'tool', title = '', runtime = {}, source = {}, logPath = null } = {}) {
    const taskId = makeTaskId();
    const resolvedSessionId = sessionId || 'default';
    const task = {
      id: taskId,
      sessionId: resolvedSessionId,
      ownerVpId,
      kind,
      title: title || kind,
      status: TASK_STATUS.RUNNING,
      createdAt: nowIso(),
      startedAt: nowIso(),
      updatedAt: nowIso(),
      endedAt: null,
      source,
      runtime,
      log: {
        path: logPath || this.store.logPath(resolvedSessionId, taskId),
        bytes: 0,
        preview: '',
      },
      result: {},
    };
    this.store.writeTask(task);
    this.store.appendEvent(task.sessionId, { event: 'started', taskId: task.id, kind: task.kind });
    this.active.set(this.#key(task.sessionId, task.id), task);
    this.#emit('started', task);
    return publicSnapshot(task);
  }

  completeTask(sessionId, taskId, opts = {}) {
    return this.#completeTask(sessionId, taskId, opts);
  }

  startShellTask({ command, cwd, sessionId, ownerVpId = null, title = '', source = {}, runtimePlatform = null } = {}) {
    if (!command || typeof command !== 'string') throw new Error('command is required');
    const task = {
      id: makeTaskId(),
      sessionId: sessionId || 'default',
      ownerVpId,
      kind: 'shell',
      title: title || command.slice(0, 120),
      status: TASK_STATUS.RUNNING,
      createdAt: nowIso(),
      startedAt: nowIso(),
      updatedAt: nowIso(),
      endedAt: null,
      source,
      runtime: {
        command,
        cwd,
        pid: null,
        platform: (runtimePlatform || this.runtimePlatform)?.platform || process.platform,
      },
      log: {
        path: this.store.logPath(sessionId || 'default', 'pending'),
        bytes: 0,
        preview: '',
      },
      result: {},
    };
    task.log.path = this.store.logPath(task.sessionId, task.id);

    this.store.writeTask(task);
    this.store.appendEvent(task.sessionId, { event: 'started', taskId: task.id, kind: task.kind });
    this.active.set(this.#key(task.sessionId, task.id), task);
    this.#emit('started', task);

    const runtime = runtimePlatform || this.runtimePlatform;
    const runner = startShellProcess({
      command,
      cwd,
      runtimePlatform: runtime,
      onOutput: (stream, text) => {
        const prefix = stream === 'stderr' ? '[stderr] ' : '';
        this.store.appendLog(task.sessionId, task.id, prefix ? text.split(/(\n)/).map(part => part === '\n' ? part : (part ? `${prefix}${part}` : part)).join('') : text);
        this.refreshTaskLog(task.sessionId, task.id);
      },
      onExit: ({ code, signal }) => {
        this.#completeTask(task.sessionId, task.id, {
          status: code === 0 ? TASK_STATUS.SUCCEEDED : TASK_STATUS.FAILED,
          exitCode: code,
          signal,
        });
      },
      onError: (err) => {
        this.#completeTask(task.sessionId, task.id, {
          status: TASK_STATUS.FAILED,
          error: err?.message || String(err),
        });
      },
    });

    task.runtime.pid = runner.pid;
    this.processes.set(this.#key(task.sessionId, task.id), runner);
    this.store.writeTask(task);
    this.#emit('updated', task);
    return publicSnapshot(task);
  }

  #completeTask(sessionId, taskId, { status, exitCode = null, signal = null, error = null, summary = null } = {}) {
    const key = this.#key(sessionId, taskId);
    const task = this.active.get(key) || this.store.readTask(sessionId, taskId);
    if (!task || isTerminalTaskStatus(task.status)) return publicSnapshot(task);
    const logPath = task.log?.path || this.store.logPath(sessionId, taskId);
    const tail = this.store.readLogFile(logPath, { tail: true, maxBytes: LOG_PREVIEW_BYTES });
    task.status = status || TASK_STATUS.FAILED;
    task.updatedAt = nowIso();
    task.endedAt = nowIso();
    task.log = { ...(task.log || {}), path: tail.path, bytes: tail.bytes, preview: tail.text };
    task.result = { ...(task.result || {}), exitCode, signal, error, summary };
    this.store.writeTask(task);
    this.store.appendEvent(sessionId, { event: 'completed', taskId, status: task.status, exitCode, signal, error, summary });
    this.active.delete(key);
    this.processes.delete(key);
    this.#emit('completed', task);
    return publicSnapshot(task);
  }

  cancelTask(sessionId, taskId) {
    const key = this.#key(sessionId, taskId);
    const task = this.active.get(key) || this.store.readTask(sessionId, taskId);
    if (!task) return { ok: false, error: `Unknown task: ${taskId}` };
    if (isTerminalTaskStatus(task.status)) return { ok: true, task: publicSnapshot(task) };
    const runner = this.processes.get(key);
    const killed = runner ? runner.kill('SIGTERM') : false;
    if (!killed) {
      return {
        ok: false,
        error: 'Unable to cancel task: no live process handle or process-tree kill failed.',
        task: publicSnapshot(task),
      };
    }
    const completed = this.#completeTask(sessionId, taskId, {
      status: TASK_STATUS.CANCELLED,
      signal: 'SIGTERM',
    });
    return { ok: true, task: completed };
  }

  listActiveTasks(sessionId = null) {
    const tasks = Array.from(this.active.values()).filter(task => !sessionId || task.sessionId === sessionId);
    return tasks.map(publicSnapshot);
  }

  getTask(sessionId, taskId) {
    return publicSnapshot(this.active.get(this.#key(sessionId, taskId)) || this.store.readTask(sessionId, taskId));
  }

  readTaskLog(sessionId, taskId, opts = {}) {
    const task = this.active.get(this.#key(sessionId, taskId)) || this.store.readTask(sessionId, taskId);
    if (task?.log?.path) return this.store.readLogFile(task.log.path, opts);
    return this.store.readLog(sessionId, taskId, opts);
  }

  setTaskLogPath(sessionId, taskId, logPath) {
    if (!logPath || typeof logPath !== 'string') return null;
    const key = this.#key(sessionId, taskId);
    const task = this.active.get(key) || this.store.readTask(sessionId, taskId);
    if (!task) return null;
    task.log = { ...(task.log || {}), path: logPath };
    task.updatedAt = nowIso();
    this.store.writeTask(task);
    if (!isTerminalTaskStatus(task.status)) this.active.set(key, task);
    return this.refreshTaskLog(sessionId, taskId);
  }

  refreshTaskLog(sessionId, taskId) {
    const key = this.#key(sessionId, taskId);
    const task = this.active.get(key) || this.store.readTask(sessionId, taskId);
    if (!task) return null;
    const logPath = task.log?.path || this.store.logPath(sessionId, taskId);
    const tail = this.store.readLogFile(logPath, { tail: true, maxBytes: LOG_PREVIEW_BYTES });
    task.log = { ...(task.log || {}), path: tail.path, bytes: tail.bytes, preview: tail.text };
    task.updatedAt = nowIso();
    this.store.writeTask(task);
    if (!isTerminalTaskStatus(task.status)) this.active.set(key, task);
    this.#emit('updated', task);
    return publicSnapshot(task);
  }

  renderActiveTasksForPrompt(sessionId = null) {
    const tasks = this.listActiveTasks(sessionId);
    if (tasks.length === 0) return '';
    const lines = ['<active_tasks>'];
    for (const task of tasks) {
      const preview = (task.log?.preview || '').trim().split('\n').slice(-3).join(' | ');
      lines.push(`- ${task.id} | ${task.kind} | ${task.status} | owner=${task.ownerVpId || 'unknown'} | title=${JSON.stringify(task.title)} | log=${task.log?.path || ''}${preview ? ` | tail=${JSON.stringify(preview)}` : ''}`);
    }
    lines.push('</active_tasks>');
    return lines.join('\n');
  }
}
