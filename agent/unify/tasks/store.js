/**
 * store.js — File-system backed TaskStore for Yeaft Unify.
 *
 * Persists tasks to ~/.yeaft/tasks/ with one folder per task.
 * Layout:
 *   ~/.yeaft/tasks/
 *     index.md              — Task index (auto-generated overview)
 *     plan.md               — Global plan text
 *     task-abc12345/         — One folder per task
 *       task.md             — Task metadata (YAML frontmatter + description)
 *       progress.md         — Progress log (append-only)
 *       memory.md           — Task-specific context/notes
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// ─── YAML Frontmatter helpers ────────────────────────────────

/**
 * Serialize a task object to YAML frontmatter + body for task.md.
 * @param {object} task
 * @returns {string}
 */
function serializeTask(task) {
  const fm = [
    '---',
    `id: ${task.id}`,
    `title: ${task.title}`,
    `status: ${task.status}`,
    `priority: ${task.priority || 'medium'}`,
  ];

  // task-299 (Q3 rework): parentTaskId is the canonical field per design §5.
  // parentId is kept as a legacy mirror for backward compat with any tool
  // that still reads it; both are always in sync after migration.
  if (task.parentTaskId) fm.push(`parentTaskId: ${task.parentTaskId}`);
  if (task.parentId) fm.push(`parentId: ${task.parentId}`);
  if (task.primaryThreadId) fm.push(`primaryThreadId: ${task.primaryThreadId}`);
  // task-334n — multi-VP collaboration protocol fields.
  // initiator: VP id that created the task (fallback target for ACL / reminder).
  // members:  explicit VP roster for the task (supersedes group roster when set).
  // groupId:  the group this task belongs to (null for legacy / standalone).
  if (task.initiator) fm.push(`initiator: ${task.initiator}`);
  if (Array.isArray(task.members) && task.members.length) {
    fm.push(`members: [${task.members.join(', ')}]`);
  }
  if (task.groupId) fm.push(`groupId: ${task.groupId}`);
  if (task.createdAt) fm.push(`createdAt: ${task.createdAt}`);
  if (task.updatedAt) fm.push(`updatedAt: ${task.updatedAt}`);

  fm.push('---');
  fm.push('');

  // Body: description + result
  const parts = [];
  if (task.description) parts.push(task.description);
  if (task.result) {
    parts.push('');
    parts.push('## Result');
    parts.push(task.result);
  }
  fm.push(parts.join('\n'));

  return fm.join('\n');
}

/**
 * Parse a task.md file (YAML frontmatter + body) into a task object.
 * @param {string} raw — File contents
 * @returns {object|null}
 */
function parseTask(raw) {
  if (!raw || !raw.startsWith('---')) return null;

  const endIdx = raw.indexOf('---', 3);
  if (endIdx === -1) return null;

  const frontmatter = raw.slice(3, endIdx).trim();
  const body = raw.slice(endIdx + 3).trim();

  const task = {};

  for (const line of frontmatter.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    if (!key) continue;

    if (key === 'createdAt' || key === 'updatedAt') {
      task[key] = parseInt(val, 10) || 0;
    } else if (key === 'members') {
      // task-334n — members: [vp-a, vp-b, ...]
      task.members = val
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      task[key] = val;
    }
  }

  if (!task.id) return null;

  // Parse body: description and result
  const resultIdx = body.indexOf('## Result');
  if (resultIdx !== -1) {
    task.description = body.slice(0, resultIdx).trim();
    task.result = body.slice(resultIdx + '## Result'.length).trim();
  } else {
    task.description = body;
  }

  // Normalize parentId / parentTaskId (design §5 canonical is parentTaskId).
  // If only legacy parentId is present, promote it to parentTaskId so
  // anything that reads the canonical field sees a value. Null/"null"
  // strings become real null.
  if (!task.parentId || task.parentId === 'null') task.parentId = null;
  if (!task.parentTaskId || task.parentTaskId === 'null') task.parentTaskId = null;
  if (!task.parentTaskId && task.parentId) task.parentTaskId = task.parentId;
  if (!task.parentId && task.parentTaskId) task.parentId = task.parentTaskId;

  // primaryThreadId: per design §5 clarification (task-299 Q4), null means
  // "unbound / orphan" — it does NOT implicitly equal 'main'. Keep null as null.
  if (!task.primaryThreadId || task.primaryThreadId === 'null') {
    task.primaryThreadId = null;
  }

  return task;
}

// ─── Index generation ────────────────────────────────────────

/**
 * Generate index.md content from all tasks.
 * @param {Map<string, object>} tasks
 * @returns {string}
 */
function generateIndex(tasks) {
  const now = new Date().toISOString();
  const lines = [
    '---',
    `totalTasks: ${tasks.size}`,
    `lastUpdated: ${now}`,
    '---',
    '# Task Index',
    '',
    '| ID | Title | Status | Priority | Updated |',
    '|----|-------|--------|----------|---------|',
  ];

  // Sort: in_progress first, then pending, then others
  const ORDER = { in_progress: 0, pending: 1, blocked: 2, completed: 3, cancelled: 4 };
  const sorted = [...tasks.values()].sort(
    (a, b) => (ORDER[a.status] ?? 5) - (ORDER[b.status] ?? 5)
  );

  for (const t of sorted) {
    const date = t.updatedAt ? new Date(t.updatedAt).toISOString().slice(0, 10) : '-';
    lines.push(`| ${t.id} | ${t.title} | ${t.status} | ${t.priority || 'medium'} | ${date} |`);
  }

  return lines.join('\n') + '\n';
}

// ─── Progress log helpers ────────────────────────────────────

/**
 * Format a progress entry for appending to progress.md.
 * @param {string} note
 * @param {object} [meta]
 * @returns {string}
 */
function formatProgressEntry(note, meta = {}) {
  const now = new Date();
  const ts = `${now.toISOString().slice(0, 10)} ${now.toISOString().slice(11, 16)}`;
  const lines = [`## ${ts}`];
  lines.push(`- ${note}`);
  if (meta.status) lines.push(`- Status: ${meta.status}`);
  if (meta.result) lines.push(`- Result: ${meta.result}`);
  lines.push('');
  return lines.join('\n');
}

// ─── TaskStore ───────────────────────────────────────────────

export class TaskStore {
  /** @type {string} */
  #dir;
  /** @type {string} */
  #indexPath;
  /** @type {string} */
  #planPath;
  /** @type {Map<string, object>} */
  #tasks;
  /** @type {boolean} */
  #readOnly;
  /** @type {Array<(evt:any)=>void>} */
  #listeners;

  /**
   * @param {string} yeaftDir — Base ~/.yeaft directory
   * @param {{ readOnly?: boolean }} [opts]
   */
  constructor(yeaftDir, opts = {}) {
    this.#dir = join(yeaftDir, 'tasks');
    this.#indexPath = join(this.#dir, 'index.md');
    this.#planPath = join(this.#dir, 'plan.md');
    this.#tasks = new Map();
    this.#readOnly = opts.readOnly || false;
    this.#listeners = [];

    // Ensure base directory exists
    if (!this.#readOnly) {
      if (!existsSync(this.#dir)) {
        try {
          mkdirSync(this.#dir, { recursive: true });
        } catch {
          this.#readOnly = true;
        }
      }
    }

    // Load existing tasks from disk
    this.#loadAll();

    // task-299 (Q3, rework): run a one-shot backfill that promotes legacy
    // `parentId` to the canonical `parentTaskId` field (design §5). A
    // marker file (.migrations/parentTaskId) records completion so the
    // migration is skipped on subsequent boots and is idempotent.
    this.#migrateParentTaskId();
  }

  /** Number of tasks in the store. */
  get size() {
    return this.#tasks.size;
  }

  /**
   * Create a new task. Creates its folder with task.md, progress.md, memory.md.
   * @param {object} task — Must have .id, .title, .status
   * @returns {object} The created task
   */
  create(task) {
    this.#tasks.set(task.id, task);

    if (!this.#readOnly) {
      const taskDir = join(this.#dir, task.id);
      try {
        mkdirSync(taskDir, { recursive: true });
        writeFileSync(join(taskDir, 'task.md'), serializeTask(task), 'utf8');
        writeFileSync(join(taskDir, 'progress.md'), '# Progress Log\n\n', 'utf8');
        writeFileSync(join(taskDir, 'memory.md'), '# Task Memory\n', 'utf8');
        this.#appendProgressInternal(task.id, `Created task: ${task.title}`, { status: 'pending' });
        this.#updateIndex();
      } catch {
        // Best-effort write
      }
    }

    return task;
  }

  /**
   * Update an existing task.
   * @param {string} id
   * @param {object} updates
   * @returns {object|null} Updated task, or null if not found
   */
  update(id, updates) {
    const task = this.#tasks.get(id);
    if (!task) return null;

    const oldStatus = task.status;
    Object.assign(task, updates, { updatedAt: Date.now() });

    if (!this.#readOnly) {
      try {
        const taskDir = join(this.#dir, id);
        writeFileSync(join(taskDir, 'task.md'), serializeTask(task), 'utf8');

        // Log progress on status change
        if (updates.status && updates.status !== oldStatus) {
          this.#appendProgressInternal(id, `Status changed: ${oldStatus} → ${updates.status}`, updates);
        }
        this.#updateIndex();
      } catch {
        // Best-effort
      }
    }

    return task;
  }

  /**
   * task-334n — add a VP member to a task's collaboration roster.
   * Idempotent: adding an existing member is a no-op (no event emitted).
   * Returns `{ task, added: boolean }`.
   *
   * If an `onEvent` callback was passed at construction time, emits a
   * `task_member_added` event synchronously after the write:
   *   { type: 'task_member_added', taskId, vpId, addedBy, members, ts }
   *
   * @param {string} id     — task id
   * @param {string} vpId   — VP being added
   * @param {{ addedBy?: string }} [opts] — provenance: who triggered the add
   */
  addMember(id, vpId, opts) {
    const task = this.#tasks.get(id);
    if (!task) return { task: null, added: false };
    if (!vpId || typeof vpId !== 'string') {
      throw new Error('addMember: vpId required (string)');
    }
    const members = Array.isArray(task.members) ? task.members.slice() : [];
    if (members.includes(vpId)) {
      return { task, added: false };
    }
    members.push(vpId);
    this.update(id, { members });
    const addedBy = opts?.addedBy || null;
    this.#emit({
      type: 'task_member_added',
      taskId: id,
      vpId,
      addedBy,
      members: members.slice(),
      ts: Date.now(),
    });
    return { task: this.#tasks.get(id), added: true };
  }

  /**
   * task-334n — remove a VP member from a task.
   * Idempotent: removing a non-member is a no-op (no event emitted).
   * Returns `{ task, removed: boolean }`.
   * Emits `task_member_removed` on successful removal.
   */
  removeMember(id, vpId) {
    const task = this.#tasks.get(id);
    if (!task) return { task: null, removed: false };
    if (!vpId || typeof vpId !== 'string') {
      throw new Error('removeMember: vpId required (string)');
    }
    const members = Array.isArray(task.members) ? task.members.slice() : [];
    const idx = members.indexOf(vpId);
    if (idx === -1) return { task, removed: false };
    members.splice(idx, 1);
    this.update(id, { members });
    this.#emit({
      type: 'task_member_removed',
      taskId: id,
      vpId,
      members: members.slice(),
      ts: Date.now(),
    });
    return { task: this.#tasks.get(id), removed: true };
  }

  /**
   * task-334n §Δ27.3 ACL — true iff `vpId` may read `otherTaskId`'s
   * memory/summary. Pass grants when:
   *   - both tasks share the same non-null groupId, OR
   *   - members sets intersect on at least one vpId
   * Fail-closed: missing task, missing groupId match, no intersection → false.
   *
   * @param {string} currentTaskId — task the caller is running in
   * @param {string} otherTaskId   — task whose data the caller wants to read
   * @param {string} [vpId]        — caller's vp id; if set, must also be
   *   a member of currentTaskId (prevents stranger elevating via URL probe)
   * @returns {boolean}
   */
  canAccessRelated(currentTaskId, otherTaskId, vpId) {
    if (!currentTaskId || !otherTaskId || currentTaskId === otherTaskId) {
      return false;
    }
    const cur = this.#tasks.get(currentTaskId);
    const other = this.#tasks.get(otherTaskId);
    if (!cur || !other) return false;

    // If caller claims a vpId, they must be a member of the current task or
    // its initiator. Otherwise this is a cross-context read — fail-closed.
    if (vpId) {
      const curMembers = Array.isArray(cur.members) ? cur.members : [];
      const isInsider = curMembers.includes(vpId) || cur.initiator === vpId;
      if (!isInsider) return false;
    }

    // Same-group rule.
    if (cur.groupId && other.groupId && cur.groupId === other.groupId) {
      return true;
    }

    // Members-intersection rule.
    const a = Array.isArray(cur.members) ? cur.members : [];
    const b = Array.isArray(other.members) ? other.members : [];
    if (a.length === 0 || b.length === 0) return false;
    const bSet = new Set(b);
    for (const v of a) if (bSet.has(v)) return true;
    return false;
  }

  /** Register an event listener (task-334n member events). */
  onEvent(fn) {
    if (typeof fn === 'function') this.#listeners.push(fn);
    return () => {
      const i = this.#listeners.indexOf(fn);
      if (i >= 0) this.#listeners.splice(i, 1);
    };
  }

  #emit(evt) {
    for (const fn of this.#listeners) {
      try { fn(evt); } catch { /* listener failures must not corrupt store */ }
    }
  }

  /**
   * Get a task by ID.
   * @param {string} id
   * @returns {object|null}
   */
  get(id) {
    return this.#tasks.get(id) || null;
  }

  /**
   * List tasks with optional filters.
   * @param {{ status?: string, priority?: string }} [filter]
   * @returns {object[]}
   */
  list(filter) {
    let results = [...this.#tasks.values()];
    if (filter?.status) results = results.filter(t => t.status === filter.status);
    if (filter?.priority) results = results.filter(t => t.priority === filter.priority);
    return results;
  }

  /**
   * Return tasks grouped as a tree. Tasks with no parent (parentTaskId == null)
   * are "roots"; each non-root task becomes a child of its parent.
   *
   * Used by task-298/task-300 to render task hierarchies. Critical for the
   * Q3 migration test: before the backfill, old tasks stored only `parentId`
   * and `tree()` would see every task as a root.
   *
   * @returns {{ roots: object[], orphans: object[] }}
   *   - roots   : tasks whose parentTaskId is null
   *   - orphans : tasks whose parentTaskId points to an id that no longer exists
   */
  tree() {
    const all = [...this.#tasks.values()];
    const byId = new Map(all.map(t => [t.id, t]));
    const roots = [];
    const orphans = [];
    for (const t of all) {
      if (!t.parentTaskId) roots.push(t);
      else if (!byId.has(t.parentTaskId)) orphans.push(t);
    }
    return { roots, orphans };
  }

  /**
   * Get progress log for a task.
   * @param {string} id
   * @returns {string}
   */
  getProgress(id) {
    const path = join(this.#dir, id, 'progress.md');
    try {
      if (existsSync(path)) return readFileSync(path, 'utf8');
    } catch { /* */ }
    return '';
  }

  /**
   * Append a progress note to a task's progress log.
   * @param {string} id
   * @param {string} note
   * @param {object} [meta]
   */
  appendProgress(id, note, meta = {}) {
    if (!this.#tasks.has(id)) return;
    this.#appendProgressInternal(id, note, meta);
  }

  /**
   * Get memory content for a task.
   * @param {string} id
   * @returns {string}
   */
  getMemory(id) {
    const path = join(this.#dir, id, 'memory.md');
    try {
      if (existsSync(path)) return readFileSync(path, 'utf8');
    } catch { /* */ }
    return '';
  }

  /**
   * Update memory content for a task.
   * @param {string} id
   * @param {string} content
   */
  updateMemory(id, content) {
    if (this.#readOnly || !this.#tasks.has(id)) return;
    try {
      writeFileSync(join(this.#dir, id, 'memory.md'), content, 'utf8');
    } catch { /* */ }
  }

  /**
   * Get current plan text.
   * @returns {string}
   */
  getPlan() {
    try {
      if (existsSync(this.#planPath)) return readFileSync(this.#planPath, 'utf8');
    } catch { /* */ }
    return '';
  }

  /**
   * Set plan text.
   * @param {string} text
   */
  setPlan(text) {
    if (this.#readOnly) return;
    try {
      writeFileSync(this.#planPath, text, 'utf8');
    } catch { /* */ }
  }

  // ─── Internal methods ──────────────────────────────────────

  /** Load all task folders from disk. */
  #loadAll() {
    if (!existsSync(this.#dir)) return;
    let entries;
    try {
      entries = readdirSync(this.#dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('task-')) continue;
      const taskMdPath = join(this.#dir, entry.name, 'task.md');
      try {
        if (!existsSync(taskMdPath)) continue;
        const raw = readFileSync(taskMdPath, 'utf8');
        const task = parseTask(raw);
        if (task && task.id) {
          this.#tasks.set(task.id, task);
        }
      } catch {
        // Skip corrupt task folders
      }
    }
  }

  /** Append to a task's progress.md. */
  #appendProgressInternal(id, note, meta) {
    if (this.#readOnly) return;
    const path = join(this.#dir, id, 'progress.md');
    try {
      const existing = existsSync(path) ? readFileSync(path, 'utf8') : '# Progress Log\n\n';
      writeFileSync(path, existing + formatProgressEntry(note, meta), 'utf8');
    } catch { /* */ }
  }

  /** Regenerate index.md from all tasks. */
  #updateIndex() {
    if (this.#readOnly) return;
    try {
      writeFileSync(this.#indexPath, generateIndex(this.#tasks), 'utf8');
    } catch { /* */ }
  }

  /**
   * task-299 Q3 migration — one-shot backfill from legacy `parentId` to
   * canonical `parentTaskId` (design §5).
   *
   * Behaviour:
   *   - Reads .migrations/parentTaskId meta marker. If present, returns
   *     immediately (skips). → guarantees idempotency on repeated boots.
   *   - Otherwise: for every loaded task, if parentId is set but
   *     parentTaskId is not, copy parentId → parentTaskId and rewrite
   *     task.md so the new field survives future loads.
   *   - Writes the meta marker on success. Read-only mode is a no-op.
   *
   * Exposed publicly as `migrateParentTaskId()` so tests can re-run it.
   *
   * @returns {{ ran: boolean, migratedCount: number }}
   */
  migrateParentTaskId() {
    return this.#migrateParentTaskId();
  }

  #migrateParentTaskId() {
    if (this.#readOnly) return { ran: false, migratedCount: 0 };

    const markerDir = join(this.#dir, '.migrations');
    const markerPath = join(markerDir, 'parentTaskId');

    try {
      if (existsSync(markerPath)) return { ran: false, migratedCount: 0 };
    } catch {
      // If existsSync throws (pathological FS), proceed cautiously — the
      // migration itself is idempotent on per-task level.
    }

    let migratedCount = 0;
    for (const task of this.#tasks.values()) {
      // parseTask() already promotes parentId → parentTaskId in memory,
      // but the on-disk YAML still lacks the canonical field for old
      // tasks. Rewriting guarantees future loads see parentTaskId and
      // makes the migration visible.
      if (task.parentId && !task.__parentTaskIdWritten) {
        // Ensure the canonical field is set (parseTask normalised this,
        // but handle the edge case where parseTask wasn't used).
        if (!task.parentTaskId) task.parentTaskId = task.parentId;
        const taskDir = join(this.#dir, task.id);
        try {
          writeFileSync(join(taskDir, 'task.md'), serializeTask(task), 'utf8');
          task.__parentTaskIdWritten = true;
          migratedCount += 1;
        } catch {
          // Best-effort; marker is only written if the pass completes.
        }
      }
    }

    try {
      mkdirSync(markerDir, { recursive: true });
      writeFileSync(
        markerPath,
        `migrated: ${new Date().toISOString()}\ncount: ${migratedCount}\n`,
        'utf8',
      );
    } catch {
      // Without the marker the migration may re-run; since it's idempotent
      // that is acceptable but not ideal. Log silently.
    }

    return { ran: true, migratedCount };
  }
}

// Exported for testing
export { serializeTask as _serializeTask, parseTask as _parseTask };
