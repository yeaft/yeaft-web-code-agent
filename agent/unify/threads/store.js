/**
 * store.js — In-memory ThreadStore for Yeaft Unify (Phase 1 mock).
 *
 * Phase 1 intentionally keeps the implementation in-memory only: it lets the
 * thread/task spawn tools ship and be tested before task-298's real
 * filesystem layer is merged. When task-298 merges, this module will be
 * replaced (or promoted to a shim) by a file-backed store with the same API.
 *
 * Cached fields (task-299 rework, prev-2 suggestion):
 *   - messageCount, lastMessageAt, archived are maintained incrementally via
 *     noteMessage()/archive()/setStatus() so that ListThreads does NOT need
 *     to scan every message on each call. A rebuildFromMessages(messages)
 *     helper exists for sanity / crash-recovery reconciliation.
 *
 * Responsibilities (Phase 1):
 *   - Maintain a map of threadId → thread metadata + cached counters.
 *   - Track a "currentThreadId" marker for the engine.
 *   - Maintain attachments from threadId → taskId.
 *
 * A single "main" thread is created on construction so that pre-spawn
 * messages have a valid threadId to carry.
 */

import { randomUUID } from 'crypto';

/** Default / root thread id — every fresh ThreadStore has one. */
export const MAIN_THREAD_ID = 'main';

/** Valid thread status values. Mirrors design doc §5. */
export const THREAD_STATUSES = ['active', 'idle', 'archived'];

/**
 * @typedef {Object} Thread
 * @property {string} id
 * @property {string} name
 * @property {string} [goal]
 * @property {string|null} parentThreadId
 * @property {'active'|'idle'|'archived'} status — cached; initial 'active'
 * @property {number} messageCount — cached counter, incremented via noteMessage
 * @property {number|null} lastMessageAt — cached timestamp of last noted message
 * @property {boolean} archived — convenience mirror of (status === 'archived')
 * @property {number} createdAt
 * @property {number} updatedAt
 */

export class ThreadStore {
  /** @type {Map<string, Thread>} */
  #threads;

  /** @type {string} */
  #currentId;

  /** @type {Map<string, string>} threadId → taskId */
  #attachments;

  constructor() {
    this.#threads = new Map();
    this.#attachments = new Map();

    const now = Date.now();
    this.#threads.set(MAIN_THREAD_ID, this.#newThreadRecord({
      id: MAIN_THREAD_ID,
      name: 'main',
      goal: '',
      parentThreadId: null,
      createdAt: now,
      updatedAt: now,
    }));
    this.#currentId = MAIN_THREAD_ID;
  }

  /** Internal: build a thread record with default cached fields. */
  #newThreadRecord(base) {
    return {
      status: 'active',
      messageCount: 0,
      lastMessageAt: null,
      lastActivityAt: null, // task-300 sidebar: latest of lastMessageAt/updatedAt
      archived: false,
      unread: 0,            // task-300 sidebar: messages since last read marker
      preview: '',          // task-300 sidebar: short excerpt of latest content
      ...base,
    };
  }

  /** Get current thread id (defaults to 'main'). */
  get currentId() {
    return this.#currentId;
  }

  /** Total thread count (including 'main'). */
  get size() {
    return this.#threads.size;
  }

  /**
   * Create a new thread.
   * @param {{ name: string, goal?: string, parentThreadId?: string }} spec
   * @returns {Thread}
   */
  create({ name, goal = '', parentThreadId = null } = {}) {
    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new Error('thread name is required');
    }
    if (parentThreadId && !this.#threads.has(parentThreadId)) {
      throw new Error(`parent thread not found: ${parentThreadId}`);
    }
    const id = `thr-${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const thread = this.#newThreadRecord({
      id,
      name: name.trim(),
      goal: goal || '',
      parentThreadId: parentThreadId || null,
      createdAt: now,
      updatedAt: now,
    });
    this.#threads.set(id, thread);
    return thread;
  }

  /** @param {string} id */
  get(id) {
    return this.#threads.get(id) || null;
  }

  /** @returns {Thread[]} */
  list() {
    return [...this.#threads.values()];
  }

  /** @param {string} id */
  has(id) {
    return this.#threads.has(id);
  }

  /**
   * Set the current thread marker. Throws if unknown.
   * @param {string} id
   */
  switch(id) {
    if (!this.#threads.has(id)) {
      throw new Error(`thread not found: ${id}`);
    }
    this.#currentId = id;
    const t = this.#threads.get(id);
    t.updatedAt = Date.now();
  }

  /**
   * Record that a message has been persisted on a thread. Increments the
   * cached messageCount and updates lastMessageAt. Safe to call repeatedly;
   * unknown threadIds are silently ignored (defense: bookkeeping must never
   * block the main persist path).
   *
   * @param {string} threadId
   * @param {number} [at=Date.now()]
   */
  noteMessage(threadId, at = Date.now(), opts = {}) {
    const t = this.#threads.get(threadId);
    if (!t) return;
    t.messageCount += 1;
    t.lastMessageAt = at;
    t.lastActivityAt = at;
    t.updatedAt = at;
    // task-300 sidebar unread counter: any new message not originating from the
    // user themselves counts as unread until markRead() is called. Callers may
    // pass { countsAsUnread: false } (e.g. for user's own messages).
    if (opts.countsAsUnread !== false) {
      t.unread += 1;
    }
    // Short preview for sidebar hover / list (capped at 160 chars).
    if (typeof opts.preview === 'string' && opts.preview.length > 0) {
      const p = opts.preview.replace(/\s+/g, ' ').trim();
      t.preview = p.length > 160 ? p.slice(0, 157) + '...' : p;
    }
    // Any activity bumps archived back to active.
    if (t.status === 'archived') {
      t.status = 'active';
      t.archived = false;
    }
  }

  /**
   * Mark a thread as read — resets unread counter to 0. Safe on unknown id.
   * @param {string} threadId
   */
  markRead(threadId) {
    const t = this.#threads.get(threadId);
    if (!t) return;
    t.unread = 0;
  }

  /**
   * Mark a thread archived. 'main' cannot be archived.
   * @param {string} id
   */
  archive(id) {
    const t = this.#threads.get(id);
    if (!t) throw new Error(`thread not found: ${id}`);
    if (id === MAIN_THREAD_ID) throw new Error('cannot archive main thread');
    t.status = 'archived';
    t.archived = true;
    t.updatedAt = Date.now();
  }

  /**
   * Set thread status explicitly. Must be one of THREAD_STATUSES.
   * @param {string} id
   * @param {'active'|'idle'|'archived'} status
   */
  setStatus(id, status) {
    if (!THREAD_STATUSES.includes(status)) {
      throw new Error(`invalid status: ${status}`);
    }
    const t = this.#threads.get(id);
    if (!t) throw new Error(`thread not found: ${id}`);
    if (id === MAIN_THREAD_ID && status === 'archived') {
      throw new Error('cannot archive main thread');
    }
    t.status = status;
    t.archived = status === 'archived';
    t.updatedAt = Date.now();
  }

  /**
   * Rebuild cached fields (messageCount/lastMessageAt) from a flat messages
   * list. Used for crash recovery or as a sanity check in tests. Each
   * message must have { threadId, createdAt? }; missing threadId is treated
   * as MAIN_THREAD_ID (matches design doc §5 default).
   *
   * Counts per thread are reset to zero first to guarantee idempotency.
   *
   * @param {Array<{threadId?: string, createdAt?: number}>} messages
   */
  rebuildFromMessages(messages) {
    // Reset counters
    for (const t of this.#threads.values()) {
      t.messageCount = 0;
      t.lastMessageAt = null;
      t.lastActivityAt = null;
    }
    for (const m of messages || []) {
      const tid = m.threadId || MAIN_THREAD_ID;
      const t = this.#threads.get(tid);
      if (!t) continue;
      t.messageCount += 1;
      const ts = typeof m.createdAt === 'number' ? m.createdAt : Date.now();
      if (!t.lastMessageAt || ts > t.lastMessageAt) {
        t.lastMessageAt = ts;
        t.lastActivityAt = ts;
      }
    }
  }

  /**
   * Attach a task to a thread. Overwrites any existing attachment.
   * @param {string} threadId
   * @param {string} taskId
   */
  attachTask(threadId, taskId) {
    if (!this.#threads.has(threadId)) {
      throw new Error(`thread not found: ${threadId}`);
    }
    if (!taskId || typeof taskId !== 'string') {
      throw new Error('taskId is required');
    }
    this.#attachments.set(threadId, taskId);
  }

  /**
   * Get the taskId attached to a thread, if any.
   * @param {string} threadId
   * @returns {string|null}
   */
  attachedTask(threadId) {
    return this.#attachments.get(threadId) || null;
  }

  /** @returns {Array<{ threadId: string, taskId: string }>} */
  listAttachments() {
    return [...this.#attachments.entries()].map(([threadId, taskId]) => ({ threadId, taskId }));
  }
}

/** @type {ThreadStore|null} */
let threadStore = null;

/**
 * Initialize the thread store. Safe to call multiple times — subsequent calls
 * replace the store only if `force` is true (primarily for tests).
 * @param {{ force?: boolean }} [opts]
 * @returns {ThreadStore}
 */
export function initThreadStore(opts = {}) {
  if (!threadStore || opts.force) {
    threadStore = new ThreadStore();
  }
  return threadStore;
}

/** @returns {ThreadStore} */
export function getThreadStore() {
  if (!threadStore) {
    threadStore = new ThreadStore();
  }
  return threadStore;
}

/** Test-only reset helper. */
export function _resetThreadStoreForTests() {
  threadStore = null;
}
