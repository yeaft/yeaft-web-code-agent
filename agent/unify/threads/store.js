/**
 * threads/store.js — Thread persistence for Yeaft Unify (task-298 Phase 1).
 *
 * Per-thread file layout (one file per thread, parallels tasks/ style):
 *   ~/.yeaft/conversation/threads/<id>.md
 *
 * Each file is YAML frontmatter + markdown body. Body is a free-form
 * scratchpad for the thread (not used by the data layer itself; reserved
 * for future features like thread summary editing by the user).
 *
 * Schema:
 *   id: string                  — stable slug (e.g. 'main', 't-abc12')
 *   name: string                — human-readable title
 *   status: 'active'|'idle'|'archived'
 *   defaultTaskId: string|null  — the task this thread binds to by default
 *   summary: string             — short AI-generated or user summary
 *   createdAt: ISO timestamp
 *   lastMessageAt: ISO timestamp
 *
 * The 'main' thread is auto-created on first construction — every legacy
 * message without a threadId migrates there (see persist.js).
 */

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from 'fs';
import { join } from 'path';
import { isPermissionError } from '../init.js';

const MAIN_THREAD_ID = 'main';
const VALID_STATUS = new Set(['active', 'idle', 'archived']);

let _permissionWarned = false;

// ─── Serialization ───────────────────────────────────────────

/**
 * Build the YAML frontmatter + body for a thread file.
 * @param {object} thread
 * @returns {string}
 */
function serializeThread(thread) {
  const fm = [
    '---',
    `id: ${thread.id}`,
    `name: ${thread.name || thread.id}`,
    `status: ${thread.status || 'active'}`,
    `defaultTaskId: ${thread.defaultTaskId || 'null'}`,
    `createdAt: ${thread.createdAt || new Date().toISOString()}`,
    `lastMessageAt: ${thread.lastMessageAt || thread.createdAt || new Date().toISOString()}`,
    '---',
    '',
    '# Summary',
    '',
    thread.summary || '',
    '',
  ];
  return fm.join('\n');
}

/**
 * Parse a thread .md file into an object. Returns null on malformed input.
 * @param {string} raw
 * @returns {object|null}
 */
export function parseThread(raw) {
  if (!raw || !raw.startsWith('---')) return null;
  const endIdx = raw.indexOf('\n---', 3);
  if (endIdx === -1) return null;
  const frontmatter = raw.slice(4, endIdx).trim();
  const body = raw.slice(endIdx + 4).trim();

  const thread = {};
  for (const line of frontmatter.split('\n')) {
    const ci = line.indexOf(':');
    if (ci === -1) continue;
    const key = line.slice(0, ci).trim();
    const val = line.slice(ci + 1).trim();
    if (!key) continue;
    if (key === 'defaultTaskId') {
      thread.defaultTaskId = val === 'null' || val === '' ? null : val;
    } else {
      thread[key] = val;
    }
  }
  if (!thread.id) return null;

  // Extract summary from body (everything after `# Summary`, if present).
  const sumIdx = body.indexOf('# Summary');
  if (sumIdx !== -1) {
    thread.summary = body.slice(sumIdx + '# Summary'.length).trim();
  } else {
    thread.summary = body;
  }
  return thread;
}

// ─── ThreadStore ─────────────────────────────────────────────

export class ThreadStore {
  #dir;
  #threadsDir;
  #threads; // Map<id, thread>
  #readOnly;

  /**
   * @param {string} yeaftDir — ~/.yeaft root
   * @param {{ readOnly?: boolean, skipBootstrap?: boolean }} [opts]
   */
  constructor(yeaftDir, opts = {}) {
    this.#dir = yeaftDir;
    this.#threadsDir = join(yeaftDir, 'conversation', 'threads');
    this.#threads = new Map();
    this.#readOnly = !!opts.readOnly;

    if (!this.#readOnly) {
      try {
        if (!existsSync(this.#threadsDir)) {
          mkdirSync(this.#threadsDir, { recursive: true, mode: 0o755 });
        }
      } catch (err) {
        if (isPermissionError(err)) {
          if (!_permissionWarned) {
            console.warn(`[Yeaft] Cannot create ${this.#threadsDir}: ${err.code} — threads read-only`);
            _permissionWarned = true;
          }
          this.#readOnly = true;
        } else {
          throw err;
        }
      }
    }

    this.#loadAll();

    // Ensure the 'main' thread always exists. This is idempotent —
    // subsequent calls see it and skip.
    if (!opts.skipBootstrap && !this.#threads.has(MAIN_THREAD_ID)) {
      this.create({
        id: MAIN_THREAD_ID,
        name: 'Main',
        status: 'active',
        summary: '',
      });
    }
  }

  get size() {
    return this.#threads.size;
  }

  /**
   * Create a thread. Throws on duplicate id or invalid status.
   * @param {object} thread — { id, name?, status?, defaultTaskId?, summary? }
   * @returns {object}
   */
  create(thread) {
    if (!thread || !thread.id) {
      throw new Error('ThreadStore.create: thread.id is required');
    }
    if (this.#threads.has(thread.id)) {
      throw new Error(`ThreadStore.create: thread '${thread.id}' already exists`);
    }
    const status = thread.status || 'active';
    if (!VALID_STATUS.has(status)) {
      throw new Error(`ThreadStore.create: invalid status '${status}'`);
    }
    const now = new Date().toISOString();
    const full = {
      id: thread.id,
      name: thread.name || thread.id,
      status,
      defaultTaskId: thread.defaultTaskId || null,
      summary: thread.summary || '',
      createdAt: thread.createdAt || now,
      lastMessageAt: thread.lastMessageAt || thread.createdAt || now,
    };
    this.#threads.set(full.id, full);
    this.#writeThread(full);
    return full;
  }

  /**
   * Update an existing thread. Unknown fields are ignored; id cannot change.
   * @param {string} id
   * @param {object} updates
   * @returns {object|null}
   */
  update(id, updates = {}) {
    const t = this.#threads.get(id);
    if (!t) return null;
    if (updates.status && !VALID_STATUS.has(updates.status)) {
      throw new Error(`ThreadStore.update: invalid status '${updates.status}'`);
    }
    const merged = {
      ...t,
      ...updates,
      id: t.id, // immutable
    };
    this.#threads.set(id, merged);
    this.#writeThread(merged);
    return merged;
  }

  /** @param {string} id */
  get(id) {
    return this.#threads.get(id) || null;
  }

  /**
   * List threads, optionally filtered by status.
   * @param {{ status?: string }} [filter]
   * @returns {object[]}
   */
  list(filter = {}) {
    let arr = [...this.#threads.values()];
    if (filter.status) arr = arr.filter(t => t.status === filter.status);
    return arr;
  }

  /**
   * Delete a thread file. The 'main' thread cannot be deleted — it is the
   * canonical fallback for migrations.
   * @param {string} id
   * @returns {boolean}
   */
  delete(id) {
    if (id === MAIN_THREAD_ID) {
      throw new Error("ThreadStore.delete: cannot delete the 'main' thread");
    }
    if (!this.#threads.has(id)) return false;
    this.#threads.delete(id);
    if (!this.#readOnly) {
      const path = join(this.#threadsDir, `${id}.md`);
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch (err) {
        if (!isPermissionError(err)) throw err;
      }
    }
    return true;
  }

  /**
   * Touch lastMessageAt to now. Called by the engine/persist layer when a
   * new message lands in the thread.
   * @param {string} id
   * @param {string} [iso]
   */
  touch(id, iso) {
    return this.update(id, { lastMessageAt: iso || new Date().toISOString() });
  }

  // ─── Internal ─────────────────────────────────────────────

  #loadAll() {
    if (!existsSync(this.#threadsDir)) return;
    let files;
    try {
      files = readdirSync(this.#threadsDir).filter(f => f.endsWith('.md'));
    } catch (err) {
      if (isPermissionError(err)) return;
      throw err;
    }
    for (const f of files) {
      try {
        const raw = readFileSync(join(this.#threadsDir, f), 'utf8');
        const t = parseThread(raw);
        if (t && t.id) this.#threads.set(t.id, t);
      } catch {
        // Skip corrupt entries — they will be rewritten if updated.
      }
    }
  }

  #writeThread(t) {
    if (this.#readOnly) return;
    const path = join(this.#threadsDir, `${t.id}.md`);
    try {
      writeFileSync(path, serializeThread(t), { encoding: 'utf8', mode: 0o644 });
    } catch (err) {
      if (isPermissionError(err)) {
        if (!_permissionWarned) {
          console.warn(`[Yeaft] Cannot write thread ${t.id}: ${err.code}`);
          _permissionWarned = true;
        }
        return;
      }
      throw err;
    }
  }
}

export { MAIN_THREAD_ID, VALID_STATUS as VALID_THREAD_STATUS };
