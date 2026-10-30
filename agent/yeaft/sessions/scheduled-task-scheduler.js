import { lstatSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateSessionId } from './ids.js';
import { loadSessionMeta, SESSION_META_FILE } from './session-store.js';
import { writeAtomic } from '../storage/atomic.js';
import { advanceScheduledTask, normalizeScheduledTask, publicScheduledTask } from './scheduled-task-definition.js';

// Internal-only ingress fence. Browser JSON cannot supply or bypass this hook.
export const SCHEDULED_TASK_DISPATCH_GUARD = Symbol('scheduled-task-dispatch-guard');
const POLL_MS = 1000;

/** Instance-owned scheduler. All metadata transitions are synchronous, fresh-read,
 * atomic replacements; no openSession handle can create a deleted directory.
 * dispatch only accepts/routes input. isActive owns the full Session lifecycle,
 * including fanout, route-forward, pending classifications and model task reentry.
 */
export class ScheduledTaskScheduler {
  constructor({ yeaftDir, dispatch, isActive, canDispatch = () => true, onChange = () => {}, notify = () => {}, now = Date.now,
    warn = error => console.warn('[ScheduledTasks]', error?.message || error) }) {
    this.yeaftDir = resolve(yeaftDir);
    this.dispatch = dispatch;
    this.isActive = isActive;
    this.canDispatch = canDispatch;
    this.waitingForContext = new Set();
    this.onChange = onChange;
    this.notify = notify;
    this.now = now;
    this.warn = warn;
    this.runs = new Map();
    this.retryAfter = new Map();
    this.timer = null;
  }

  read(sessionId) {
    if (!validateSessionId(sessionId).ok) throw new Error('Invalid Session id');
    const root = join(this.yeaftDir, 'sessions');
    const dir = join(root, sessionId);
    const path = join(dir, SESSION_META_FILE);
    try {
      const rootStat = lstatSync(root), stat = lstatSync(dir), fileStat = lstatSync(path);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !stat.isDirectory()
        || stat.isSymbolicLink() || !fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error('Invalid Session path');
      const meta = loadSessionMeta(dir);
      if (!meta || meta.id !== sessionId) throw new Error('Session not found');
      return { meta, path, identity: `${stat.dev}:${stat.ino}:${meta.createdAt}` };
    } catch { throw new Error('Session not found or unsafe Session path'); }
  }

  ids() {
    const root = join(this.yeaftDir, 'sessions');
    try {
      const stat = lstatSync(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return [];
      return readdirSync(root).filter(id => validateSessionId(id).ok);
    } catch (error) {
      if (error.code !== 'ENOENT') this.warn(error);
      return [];
    }
  }

  save(row) {
    // Recheck identity rather than creating directories if deletion/recreation won.
    if (this.read(row.meta.id).identity !== row.identity) throw new Error('Session changed');
    row.meta.metadataUpdatedAt = new Date(this.now()).toISOString();
    writeAtomic(row.path, `${JSON.stringify(row.meta, null, 2)}\n`);
  }

  changed() {
    try { this.onChange(); } catch (error) { this.warn(error); }
  }

  snapshot(meta) {
    return { ...meta, ...(meta.task ? { task: publicScheduledTask(meta.task) } : {}) };
  }

  /** Compare the caller's config revision against fresh metadata, never runtime state. */
  update(sessionId, patch, expectedRevision) {
    const row = this.read(sessionId);
    if (!row.meta.task) throw new Error('Session has no task');
    if (typeof expectedRevision !== 'string' || expectedRevision !== row.meta.task._revision) {
      throw Object.assign(new Error('Task changed; refresh before editing'), { code: 'task_conflict' });
    }
    row.meta.task = normalizeScheduledTask(patch, row.meta.task);
    this.save(row);
    this.changed();
    return this.snapshot(row.meta);
  }

  start() {
    if (this.timer) return this;
    for (const id of this.ids()) {
      try { this.recover(this.read(id), true); } catch (error) { this.backoff(id, error); }
    }
    this.timer = setInterval(() => { this.tick().catch(error => this.warn(error)); }, POLL_MS);
    this.timer.unref?.();
    return this;
  }

  recover(row, skipMissed = false) {
    const task = row.meta.task;
    if (!task) return;
    let dirty = false, interrupted = false;
    // Never replay a persisted running attempt: effects may already have occurred.
    if (task.lastRun?.status === 'running') {
      // A newer edited trigger or a manual run must not consume a future one-shot.
      if (task.lastRun.trigger === 'schedule' && task.trigger.type === 'schedule'
        && !task.trigger.recurrence && task.nextRunAt != null && task.nextRunAt <= task.lastRun.startedAt) task.nextRunAt = null;
      task.lastRun = { ...task.lastRun, status: 'interrupted', finishedAt: this.now(), error: 'Agent restarted during execution' };
      interrupted = true;
      dirty = true;
    }
    // Recurring downtime is skipped, including an occurrence exactly at boot.
    if (skipMissed && this.canDispatch(row.meta.id) && task.trigger.type === 'schedule' && task.trigger.recurrence
      && task.nextRunAt != null && task.nextRunAt <= this.now()) {
      task.nextRunAt = advanceScheduledTask(task, this.now());
      dirty = true;
    }
    if (dirty) { this.save(row); this.changed(); }
    if (interrupted && task.notify !== false) {
      try { this.notify({ type: 'scheduled_task_notification', sessionId: row.meta.id, runId: task.lastRun.id,
        status: 'interrupted', taskName: row.meta.name, error: task.lastRun.error }); } catch (error) { this.warn(error); }
    }
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.runs.clear();
    this.waitingForContext.clear();
  }

  backoff(id, error) {
    this.retryAfter.set(id, this.now() + 30_000);
    this.warn(error);
  }

  assertReady(sessionId) {
    if (!this.canDispatch(sessionId)) {
      throw Object.assign(new Error('Waiting for authoritative Project context from Server; retry after synchronization'),
        { code: 'project_context_unavailable' });
    }
  }

  run(sessionId, trigger = 'manual') {
    const row = this.read(sessionId), task = row.meta.task;
    if (!task) throw new Error('Session has no task');
    this.assertReady(sessionId);
    if (this.runs.has(sessionId) || task.lastRun?.status === 'running' || this.isActive(sessionId)) throw new Error('Session is busy or task is already running');
    if (trigger === 'schedule' && (!task.enabled || task.trigger.type !== 'schedule'
      || task.nextRunAt == null || task.nextRunAt > this.now())) throw new Error('Task is no longer due');
    // Validate persisted definitions without trusting externally edited runtime fields.
    normalizeScheduledTask({ prompt: task.prompt, enabled: task.enabled, notify: task.notify, trigger: task.trigger });
    const run = { id: randomUUID(), status: 'running', trigger, startedAt: this.now(), finishedAt: null };
    task.lastRun = run;
    if (trigger === 'schedule') {
      task._scheduledRuns = (task._scheduledRuns || 0) + 1;
      task.nextRunAt = advanceScheduledTask(task, this.now());
    }
    this.save(row); // A durable claim must precede any execution side effect.
    const active = { id: run.id, identity: row.identity, revision: task._revision, routed: false, terminal: false, error: null, interrupted: false };
    this.runs.set(sessionId, active);
    const guard = () => {
      this.assertReady(sessionId);
      const fresh = this.read(sessionId);
      if (fresh.identity !== active.identity || fresh.meta.task?.lastRun?.id !== active.id
        || fresh.meta.task?._revision !== active.revision) throw new Error('Task changed before dispatch');
    };
    try {
      guard();
      const result = this.dispatch({ type: 'yeaft_session_send', sessionId, id: run.id, text: task.prompt,
        [SCHEDULED_TASK_DISPATCH_GUARD]: guard });
      Promise.resolve(result).then(() => { active.routed = true; }, error => {
        active.error = error?.message || String(error); active.routed = true;
      });
    } catch (error) {
      active.error = error?.message || String(error); active.routed = true;
    }
    this.changed();
    return this.snapshot(row.meta);
  }

  observe(sessionId, event) {
    const active = this.runs.get(sessionId);
    if (!active) return;
    if (event.type === 'error') active.error = event.message || event.error?.message || String(event.error || 'Execution failed');
    if (event.type === 'vp_turn_end') {
      active.terminal = true;
      if (event.reason === 'errored') active.error = event.detail?.message || active.error || 'Execution failed';
      if (event.reason === 'aborted') active.interrupted = true;
    }
  }

  finish(id, active) {
    let row;
    try { row = this.read(id); } catch { this.runs.delete(id); return; }
    const task = row.meta.task;
    if (row.identity !== active.identity || task?.lastRun?.id !== active.id) { this.runs.delete(id); return; }
    const status = active.error ? 'failed' : active.interrupted ? 'interrupted' : active.terminal ? 'completed' : 'failed';
    const error = active.error || (status === 'failed' ? 'Session produced no terminal execution' : null);
    task.lastRun = { ...task.lastRun, status, finishedAt: this.now(), ...(error ? { error } : {}) };
    // Completion never consumes or moves a schedule, especially for manual runs.
    // Missed recurring occurrences belong to tick's explicit busy-Session policy.
    this.save(row);
    this.runs.delete(id);
    this.changed();
    if (task.notify !== false) {
      try { this.notify({ type: 'scheduled_task_notification', sessionId: id, runId: active.id, status,
        taskName: row.meta.name, ...(error ? { error } : {}) }); } catch (error) { this.warn(error); }
    }
  }

  async tick() {
    // Inspect due occurrences before retiring tracked runs: an occurrence elapsed
    // during a manual run is busy/missed, even if its runtime just became idle.
    // Manual run/finish themselves never change nextRunAt or _scheduledRuns.
    for (const id of this.ids()) {
      if ((this.retryAfter.get(id) || 0) > this.now()) continue;
      try {
        const row = this.read(id), task = row.meta.task;
        const tracked = this.runs.get(id);
        if (tracked && (row.identity !== tracked.identity || task?.lastRun?.id !== tracked.id)) this.runs.delete(id);
        // Retry boot recovery after a transient atomic-write failure.
        if (task?.lastRun?.status === 'running' && !this.runs.has(id)) { this.recover(row, true); continue; }
        if (task?.enabled && task.trigger.type === 'schedule' && task.nextRunAt != null && task.nextRunAt <= this.now()) {
          if (!this.canDispatch(id)) {
            if (!this.waitingForContext.has(id)) {
              this.waitingForContext.add(id);
              this.warn(new Error(`Session ${id}: waiting for authoritative Project context from Server`));
            }
            continue; // Unknown is not 'no Project': do not claim, fail or consume the occurrence.
          }
          this.waitingForContext.delete(id);
          const busy = this.runs.has(id) || this.isActive(id);
          // One minute of grace tolerates timer jitter. Older recurring
          // occurrences (or ones blocked by an active Session) are missed, not queued.
          if (task.trigger.recurrence && (busy || this.now() - task.nextRunAt > 60_000)) {
            task.nextRunAt = advanceScheduledTask(task, this.now());
            this.save(row);
            this.changed();
          } else if (!busy) this.run(id, 'schedule');
        }
      } catch (error) { this.backoff(id, error); }
    }
    for (const [id, active] of this.runs) {
      if ((this.retryAfter.get(id) || 0) > this.now()) continue;
      try {
        // Drop removed/archived/replaced Sessions even if an old engine stays alive.
        const fresh = this.read(id);
        if (fresh.identity !== active.identity || fresh.meta.task?.lastRun?.id !== active.id) { this.runs.delete(id); continue; }
        if (active.routed && !this.isActive(id)) this.finish(id, active);
      } catch (error) {
        try { this.read(id); this.backoff(id, error); } catch { this.runs.delete(id); }
      }
    }
  }
}
