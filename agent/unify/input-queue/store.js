/**
 * input-queue/store.js — User input queue for Yeaft Unify (task-298 Phase 1).
 *
 * Queue entries are what the user types when there is no clear thread/task
 * to attach to. Phase 1 only persists the queue schema and offers CRUD.
 * Phase 2 will add the routing logic that moves pending entries into the
 * right thread.
 *
 * Storage: a single JSON file at ~/.yeaft/conversation/input-queue.json.
 * Rationale (per commit/task-298 scope): the queue is a short, transactional
 * list (pending → routing → dispatched), not a long-form document. One
 * file avoids per-entry file churn during rapid typing and gives atomic
 * read-modify-write semantics with a single writeFileSync.
 *
 * Schema per entry:
 *   id: string          — e.g. 'q-<epoch-ms>-<rand>'
 *   text: string        — verbatim user input
 *   createdAt: ISO
 *   status: 'pending'|'routing'|'dispatched'
 *   routedTo: { threadId?: string, taskId?: string } | null
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { isPermissionError } from '../init.js';

const VALID_STATUS = new Set(['pending', 'routing', 'dispatched']);
let _permissionWarned = false;

function genId() {
  const r = Math.random().toString(36).slice(2, 8);
  return `q-${Date.now()}-${r}`;
}

export class InputQueueStore {
  #dir;
  #filePath;
  #entries;   // Map<id, entry>
  #readOnly;

  /**
   * @param {string} yeaftDir
   * @param {{ readOnly?: boolean }} [opts]
   */
  constructor(yeaftDir, opts = {}) {
    this.#dir = join(yeaftDir, 'conversation');
    this.#filePath = join(this.#dir, 'input-queue.json');
    this.#entries = new Map();
    this.#readOnly = !!opts.readOnly;

    if (!this.#readOnly) {
      try {
        if (!existsSync(this.#dir)) mkdirSync(this.#dir, { recursive: true, mode: 0o755 });
      } catch (err) {
        if (isPermissionError(err)) {
          if (!_permissionWarned) {
            console.warn(`[Yeaft] Cannot create ${this.#dir}: ${err.code} — input queue read-only`);
            _permissionWarned = true;
          }
          this.#readOnly = true;
        } else {
          throw err;
        }
      }
    }

    this.#load();
  }

  get size() {
    return this.#entries.size;
  }

  /**
   * Enqueue a user input. Returns the stored entry (with assigned id).
   * @param {{ text: string, status?: string, routedTo?: object|null }} input
   * @returns {object}
   */
  enqueue(input) {
    if (!input || typeof input.text !== 'string' || input.text.length === 0) {
      throw new Error('InputQueueStore.enqueue: text is required');
    }
    const status = input.status || 'pending';
    if (!VALID_STATUS.has(status)) {
      throw new Error(`InputQueueStore.enqueue: invalid status '${status}'`);
    }
    const entry = {
      id: genId(),
      text: input.text,
      createdAt: new Date().toISOString(),
      status,
      routedTo: input.routedTo || null,
    };
    this.#entries.set(entry.id, entry);
    this.#persist();
    return entry;
  }

  /**
   * Update a queue entry. id is immutable. Unknown fields are ignored.
   * @param {string} id
   * @param {object} updates
   * @returns {object|null}
   */
  update(id, updates = {}) {
    const cur = this.#entries.get(id);
    if (!cur) return null;
    if (updates.status && !VALID_STATUS.has(updates.status)) {
      throw new Error(`InputQueueStore.update: invalid status '${updates.status}'`);
    }
    const next = { ...cur, ...updates, id: cur.id, createdAt: cur.createdAt };
    this.#entries.set(id, next);
    this.#persist();
    return next;
  }

  /** @param {string} id */
  get(id) {
    return this.#entries.get(id) || null;
  }

  /**
   * List queue entries, optionally filtered by status.
   * @param {{ status?: string }} [filter]
   */
  list(filter = {}) {
    let arr = [...this.#entries.values()];
    if (filter.status) arr = arr.filter(e => e.status === filter.status);
    // Oldest first — FIFO.
    return arr.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Remove an entry. Returns true if removed, false if missing.
   * @param {string} id
   */
  remove(id) {
    if (!this.#entries.has(id)) return false;
    this.#entries.delete(id);
    this.#persist();
    return true;
  }

  /** Clear all queue entries. */
  clear() {
    this.#entries.clear();
    this.#persist();
  }

  // ─── Internal ─────────────────────────────────────────────

  #load() {
    if (!existsSync(this.#filePath)) return;
    let raw;
    try {
      raw = readFileSync(this.#filePath, 'utf8');
    } catch (err) {
      if (isPermissionError(err)) return;
      throw err;
    }
    if (!raw.trim()) return;
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      // Corrupt file — start fresh rather than crash. The next #persist()
      // will overwrite with valid JSON.
      return;
    }
    if (!Array.isArray(data?.entries)) return;
    for (const e of data.entries) {
      if (e && e.id && typeof e.text === 'string' && VALID_STATUS.has(e.status)) {
        this.#entries.set(e.id, e);
      }
    }
  }

  #persist() {
    if (this.#readOnly) return;
    const data = { entries: [...this.#entries.values()] };
    try {
      writeFileSync(this.#filePath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o644 });
    } catch (err) {
      if (isPermissionError(err)) {
        if (!_permissionWarned) {
          console.warn(`[Yeaft] Cannot write input queue: ${err.code}`);
          _permissionWarned = true;
        }
        return;
      }
      throw err;
    }
  }
}

export { VALID_STATUS as VALID_INPUT_QUEUE_STATUS };
