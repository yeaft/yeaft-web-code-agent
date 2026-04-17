/**
 * store.js — In-memory ThreadStore for Yeaft Unify (Phase 1 mock).
 *
 * Phase 1 intentionally keeps the implementation in-memory only: it lets the
 * thread/task spawn tools ship and be tested before task-298's real
 * filesystem layer is merged. When task-298 merges, this module will be
 * replaced (or promoted to a shim) by a file-backed store with the same API.
 *
 * Responsibilities (Phase 1):
 *   - Maintain a map of threadId → thread metadata.
 *   - Track a "currentThreadId" marker for the engine.
 *   - Maintain attachments from threadId → taskId.
 *
 * A single "main" thread is created on construction so that pre-spawn
 * messages have a valid threadId to carry.
 */

import { randomUUID } from 'crypto';

/** Default / root thread id — every fresh ThreadStore has one. */
export const MAIN_THREAD_ID = 'main';

/**
 * @typedef {Object} Thread
 * @property {string} id
 * @property {string} name
 * @property {string} [goal]
 * @property {string|null} parentThreadId
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
    const main = {
      id: MAIN_THREAD_ID,
      name: 'main',
      goal: '',
      parentThreadId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.#threads.set(main.id, main);
    this.#currentId = main.id;
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
    const thread = {
      id,
      name: name.trim(),
      goal: goal || '',
      parentThreadId: parentThreadId || null,
      createdAt: now,
      updatedAt: now,
    };
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
