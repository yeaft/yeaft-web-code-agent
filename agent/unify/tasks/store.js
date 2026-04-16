/**
 * store.js — File-system backed TaskStore for Yeaft Unify.
 *
 * Persists tasks to ~/.yeaft/tasks/ as .md files with YAML frontmatter.
 * Layout:
 *   ~/.yeaft/tasks/
 *     plan.md            — Current plan text
 *     active/            — Pending / in_progress / blocked tasks
 *       task-abc12345.md
 *     completed/         — Completed / cancelled tasks
 *       task-xyz99999.md
 *
 * On construction, loads all existing tasks into an in-memory Map cache.
 * All mutations write-through to disk immediately.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';

// ─── YAML Frontmatter helpers ────────────────────────────────

/**
 * Serialize a task object to YAML frontmatter + body.
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
 * Parse a task .md file (YAML frontmatter + body) into a task object.
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

  // Parse YAML-like key: value lines
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

  return task;
}

// ─── TaskStore ───────────────────────────────────────────────

const DONE_STATUSES = new Set(['completed', 'cancelled']);

export class TaskStore {
  /** @type {string} */
  #dir;
  /** @type {string} */
  #activeDir;
  /** @type {string} */
  #doneDir;
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
    this.#activeDir = join(this.#dir, 'active');
    this.#doneDir = join(this.#dir, 'completed');
    this.#planPath = join(this.#dir, 'plan.md');
    this.#tasks = new Map();
    this.#readOnly = opts.readOnly || false;

    // Ensure directories exist
    if (!this.#readOnly) {
      for (const d of [this.#dir, this.#activeDir, this.#doneDir]) {
        if (!existsSync(d)) {
          try {
            mkdirSync(d, { recursive: true });
          } catch {
            // If we can't create dirs, go read-only
            this.#readOnly = true;
            break;
          }
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
   * Create a new task.
   * @param {object} task — Must have .id, .title, .status
   * @returns {object} The created task
   */
  create(task) {
    this.#tasks.set(task.id, task);
    this.#writeTask(task);
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

    // If status changed to done/cancelled, move file to completed dir
    const wasDone = DONE_STATUSES.has(oldStatus);
    const isDone = DONE_STATUSES.has(task.status);

    if (!wasDone && isDone) {
      this.#moveToCompleted(task);
    } else if (wasDone && !isDone) {
      this.#moveToActive(task);
    } else {
      this.#writeTask(task);
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
   * Delete a task by ID.
   * @param {string} id
   * @returns {boolean}
   */
  delete(id) {
    const task = this.#tasks.get(id);
    if (!task) return false;
    this.#tasks.delete(id);
    this.#deleteFile(task);
    return true;
  }

  /**
   * Get current plan text.
   * @returns {string}
   */
  getPlan() {
    try {
      if (existsSync(this.#planPath)) {
        return readFileSync(this.#planPath, 'utf8');
      }
    } catch {
      // Ignore read errors
    }
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
    } catch {
      // Ignore write errors in degraded mode
    }
  }

  // ─── Internal methods ──────────────────────────────────────

  /** Load all task files from active + completed directories. */
  #loadAll() {
    this.#loadDir(this.#activeDir);
    this.#loadDir(this.#doneDir);
  }

  /** Load tasks from a single directory. */
  #loadDir(dir) {
    if (!existsSync(dir)) return;
    let files;
    try {
      files = readdirSync(dir);
    } catch {
      return;
    }
    for (const f of files) {
      if (!f.endsWith('.md')) continue;
      try {
        const raw = readFileSync(join(dir, f), 'utf8');
        const task = parseTask(raw);
        if (task && task.id) {
          this.#tasks.set(task.id, task);
        }
      } catch {
        // Skip corrupt files
      }
    }
  }

  /** Write a task to the appropriate directory. */
  #writeTask(task) {
    if (this.#readOnly) return;
    const dir = DONE_STATUSES.has(task.status) ? this.#doneDir : this.#activeDir;
    const filePath = join(dir, `${task.id}.md`);
    try {
      writeFileSync(filePath, serializeTask(task), 'utf8');
    } catch {
      // Ignore write errors
    }
  }

  /** Move a task file from active to completed. */
  #moveToCompleted(task) {
    if (this.#readOnly) {
      return;
    }
    const src = join(this.#activeDir, `${task.id}.md`);
    const dst = join(this.#doneDir, `${task.id}.md`);
    try {
      if (existsSync(src)) {
        renameSync(src, dst);
      }
      // Always rewrite to update content
      writeFileSync(dst, serializeTask(task), 'utf8');
    } catch {
      // Fallback: just write to completed
      try { writeFileSync(dst, serializeTask(task), 'utf8'); } catch { /* */ }
    }
  }

  /** Move a task file from completed back to active. */
  #moveToActive(task) {
    if (this.#readOnly) return;
    const src = join(this.#doneDir, `${task.id}.md`);
    const dst = join(this.#activeDir, `${task.id}.md`);
    try {
      if (existsSync(src)) {
        renameSync(src, dst);
      }
      writeFileSync(dst, serializeTask(task), 'utf8');
    } catch {
      try { writeFileSync(dst, serializeTask(task), 'utf8'); } catch { /* */ }
    }
  }

  /** Delete a task file from disk. */
  #deleteFile(task) {
    if (this.#readOnly) return;
    for (const dir of [this.#activeDir, this.#doneDir]) {
      const filePath = join(dir, `${task.id}.md`);
      try {
        if (existsSync(filePath)) unlinkSync(filePath);
      } catch {
        // Ignore
      }
    }
  }
}

// Exported for testing
export { serializeTask as _serializeTask, parseTask as _parseTask };
