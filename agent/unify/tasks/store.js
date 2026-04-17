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

  if (task.parentId) fm.push(`parentId: ${task.parentId}`);
  // task-298: nested task support + thread linkage. Both optional for
  // backward-compat with tasks created before this schema addition.
  if (task.parentTaskId) fm.push(`parentTaskId: ${task.parentTaskId}`);
  if (task.primaryThreadId) fm.push(`primaryThreadId: ${task.primaryThreadId}`);
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

  // Normalize parentId
  if (!task.parentId || task.parentId === 'null') {
    task.parentId = null;
  }
  // task-298 additions: normalize nullables.
  if (!task.parentTaskId || task.parentTaskId === 'null') {
    task.parentTaskId = null;
  }
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
    // task-298: normalize new optional fields so absent → explicit null.
    if (task.parentTaskId === undefined) task.parentTaskId = null;
    if (task.primaryThreadId === undefined) task.primaryThreadId = null;
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
   * task-298: return direct children of a task (parentTaskId match),
   * sorted by createdAt ascending. Numeric createdAt stored as epoch ms.
   * @param {string} parentTaskId
   * @returns {object[]}
   */
  children(parentTaskId) {
    const kids = [...this.#tasks.values()].filter(t => t.parentTaskId === parentTaskId);
    kids.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    return kids;
  }

  /**
   * task-298: return root tasks (parentTaskId is null) with a recursive
   * `children` property attached to each node. Pure snapshot — not live.
   * @returns {object[]}
   */
  tree() {
    const all = [...this.#tasks.values()];
    const byParent = new Map();
    for (const t of all) {
      const p = t.parentTaskId || null;
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p).push(t);
    }
    for (const arr of byParent.values()) {
      arr.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    }
    const build = (node) => ({
      ...node,
      children: (byParent.get(node.id) || []).map(build),
    });
    return (byParent.get(null) || []).map(build);
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
}

// Exported for testing
export { serializeTask as _serializeTask, parseTask as _parseTask };
