/**
 * store.js — File-backed ThreadStore for Yeaft Unify (task-307a).
 *
 * Promotes the Phase-1 in-memory stub to persist threads under
 * `~/.yeaft/threads/` so conversation structure survives agent restarts.
 * API is backward compatible with the task-299 canonical surface — callers
 * that used the in-memory version keep working without change, but a new
 * optional `yeaftDir` argument (to the constructor / `initThreadStore`)
 * switches persistence on.
 *
 * On-disk layout:
 *   ~/.yeaft/threads/
 *     index.md                — Auto-generated overview (current thread id
 *                               + attachments table + thread summary list).
 *     {threadId}.md           — One markdown file per thread. YAML
 *                               frontmatter holds every cached field, the
 *                               body is the short preview.
 *
 * Write semantics:
 *   - Every mutation schedules a debounced flush (8 ms) of the set of dirty
 *     thread files and, when something changed, the index. A synchronous
 *     `flush()` is exposed for tests and graceful shutdown.
 *   - On construction we load any existing `{id}.md` files and rebuild the
 *     in-memory map + attachments, so round-trips are a simple "close /
 *     reopen".
 *   - Read-only mode (e.g. when `~/.yeaft/` is not writable) silently skips
 *     all filesystem writes — in-memory behaviour is preserved.
 *
 * Cached fields (task-299 contract, preserved verbatim):
 *   messageCount / lastMessageAt / lastActivityAt / archived / unread /
 *   preview. These all persist to the YAML frontmatter so ListThreads never
 *   needs to scan messages after a restart.
 *
 * A single "main" thread is always present after init — either loaded from
 * disk or synthesised as a fresh record when the directory is empty.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

/** Default / root thread id — every fresh ThreadStore has one. */
export const MAIN_THREAD_ID = 'main';

/** Valid thread status values. Mirrors design doc §5. */
export const THREAD_STATUSES = ['active', 'idle', 'archived'];

/** Debounce window for grouped disk writes. Kept short so tests don't hang. */
const FLUSH_DEBOUNCE_MS = 8;

// ─── YAML (de)serialisation ──────────────────────────────────────────────

/**
 * Serialise a thread record to Markdown with YAML frontmatter.
 *
 * Only scalar / boolean / number / null frontmatter values are emitted.
 * Strings that span multiple lines or contain leading whitespace get folded
 * into a single-line value (threads' free-text goes in the body).
 *
 * @param {object} t
 * @returns {string}
 */
function serializeThread(t) {
  const forkedFrom = serializeForkedFrom(t.forkedFrom);
  const fm = [
    '---',
    `id: ${t.id}`,
    `name: ${escapeScalar(t.name)}`,
    `goal: ${escapeScalar(t.goal || '')}`,
    `parentThreadId: ${t.parentThreadId == null ? 'null' : t.parentThreadId}`,
    `status: ${t.status}`,
    `archived: ${t.archived ? 'true' : 'false'}`,
    `mergedInto: ${t.mergedInto == null ? 'null' : t.mergedInto}`,
    `forkedFrom: ${forkedFrom}`,
    `messageCount: ${t.messageCount | 0}`,
    `lastMessageAt: ${t.lastMessageAt == null ? 'null' : t.lastMessageAt}`,
    `lastActivityAt: ${t.lastActivityAt == null ? 'null' : t.lastActivityAt}`,
    `unread: ${t.unread | 0}`,
    `createdAt: ${t.createdAt}`,
    `updatedAt: ${t.updatedAt}`,
    '---',
    '',
  ];
  // Body is the preview (wrapped so the file remains human-readable).
  if (t.preview) fm.push(t.preview);
  return fm.join('\n') + '\n';
}

/**
 * Serialise `forkedFrom` as a single-line scalar so the YAML stays flat.
 * Shape: `{threadId}|{messageId}|{timestamp}`. Null becomes literal `null`.
 */
function serializeForkedFrom(ff) {
  if (!ff || typeof ff !== 'object') return 'null';
  if (!ff.threadId || !ff.messageId) return 'null';
  const ts = Number.isFinite(ff.timestamp) ? ff.timestamp : 0;
  return `${ff.threadId}|${ff.messageId}|${ts}`;
}

function parseForkedFrom(raw) {
  if (!raw || raw === 'null') return null;
  const parts = String(raw).split('|');
  if (parts.length < 2) return null;
  const [threadId, messageId, tsStr] = parts;
  if (!threadId || !messageId) return null;
  const ts = parseInt(tsStr || '0', 10);
  return {
    threadId,
    messageId,
    timestamp: Number.isFinite(ts) ? ts : 0,
  };
}

function escapeScalar(v) {
  if (v == null) return '';
  // Keep on one physical line; any embedded newline becomes a space so YAML
  // stays flat.
  return String(v).replace(/\s+/g, ' ').trim();
}

/**
 * Parse the markdown-with-frontmatter produced by `serializeThread`. Returns
 * null when the file is malformed; callers should skip it silently so one
 * corrupt thread file never blocks recovery of the rest.
 *
 * @param {string} raw
 * @returns {object|null}
 */
function parseThread(raw) {
  if (!raw || !raw.startsWith('---')) return null;
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return null;
  const fm = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\n/, '').trimEnd();
  const record = {};
  for (const line of fm.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const rawVal = line.slice(idx + 1).trim();
    if (!key) continue;
    if (rawVal === 'null' || rawVal === '') {
      record[key] = null;
    } else if (rawVal === 'true' || rawVal === 'false') {
      record[key] = rawVal === 'true';
    } else if (/^-?\d+$/.test(rawVal)) {
      record[key] = parseInt(rawVal, 10);
    } else {
      record[key] = rawVal;
    }
  }
  if (!record.id || !record.name) return null;
  // Default to safe values if the file pre-dates a field.
  if (!THREAD_STATUSES.includes(record.status)) record.status = 'active';
  record.archived = record.status === 'archived';
  if (!('mergedInto' in record)) record.mergedInto = null;
  // forkedFrom is a packed scalar — decode back to {threadId, messageId, timestamp}.
  record.forkedFrom = parseForkedFrom(record.forkedFrom);
  record.messageCount = Number.isFinite(record.messageCount) ? record.messageCount : 0;
  record.unread = Number.isFinite(record.unread) ? record.unread : 0;
  record.preview = body;
  record.lastActivityAt = record.lastActivityAt ?? record.lastMessageAt ?? null;
  return record;
}

/**
 * Generate `index.md` — a human-readable roll-up of all threads in the
 * store, the current thread marker, and attachments. Parsers should NOT
 * depend on this file; it exists for human inspection and crash-triage.
 */
function generateIndex(threads, currentId, attachments) {
  const now = new Date().toISOString();
  const lines = [
    '---',
    `currentId: ${currentId}`,
    `totalThreads: ${threads.size}`,
    `lastUpdated: ${now}`,
    '---',
    '# Thread Index',
    '',
    '| ID | Name | Status | Messages | Last Activity |',
    '|----|------|--------|----------|---------------|',
  ];
  for (const t of threads.values()) {
    const stamp = t.lastActivityAt
      ? new Date(t.lastActivityAt).toISOString().slice(0, 19).replace('T', ' ')
      : '-';
    lines.push(`| ${t.id} | ${t.name} | ${t.status} | ${t.messageCount} | ${stamp} |`);
  }
  if (attachments.size > 0) {
    lines.push('');
    lines.push('## Attachments');
    lines.push('');
    lines.push('| Thread | Task |');
    lines.push('|--------|------|');
    for (const [threadId, taskId] of attachments.entries()) {
      lines.push(`| ${threadId} | ${taskId} |`);
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * Serialise the attachments map to a stable JSON payload (array form so key
 * order is preserved on reload). Stored separately from `index.md` so the
 * human-readable index stays cosmetic.
 */
function serializeAttachments(attachments) {
  return JSON.stringify(
    [...attachments.entries()].map(([threadId, taskId]) => ({ threadId, taskId })),
    null,
    2,
  ) + '\n';
}

function parseAttachments(raw) {
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (e) => e && typeof e.threadId === 'string' && typeof e.taskId === 'string',
    );
  } catch {
    return [];
  }
}

// ─── ThreadStore class ───────────────────────────────────────────────────

/**
 * @typedef {Object} Thread
 * @property {string} id
 * @property {string} name
 * @property {string} [goal]
 * @property {string|null} parentThreadId
 * @property {'active'|'idle'|'archived'} status
 * @property {number} messageCount
 * @property {number|null} lastMessageAt
 * @property {number|null} lastActivityAt
 * @property {boolean} archived
 * @property {number} unread
 * @property {string} preview
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

  /** @type {string|null} */
  #dir;
  /** @type {string|null} */
  #indexPath;
  /** @type {string|null} */
  #attachmentsPath;
  /** @type {boolean} */
  #readOnly;
  /** @type {Set<string>} dirty thread ids pending flush */
  #dirtyThreads;
  /** @type {boolean} */
  #dirtyIndex;
  /** @type {boolean} */
  #dirtyAttachments;
  /** @type {any} NodeJS.Timeout */
  #flushTimer;

  /**
   * @param {string} [yeaftDir] — Base ~/.yeaft directory. Omit for in-memory mode.
   * @param {{ readOnly?: boolean }} [opts]
   */
  constructor(yeaftDir, opts = {}) {
    this.#threads = new Map();
    this.#attachments = new Map();
    this.#currentId = MAIN_THREAD_ID;
    this.#dirtyThreads = new Set();
    this.#dirtyIndex = false;
    this.#dirtyAttachments = false;
    this.#flushTimer = null;

    this.#readOnly = !!opts.readOnly;
    if (yeaftDir) {
      this.#dir = join(yeaftDir, 'threads');
      this.#indexPath = join(this.#dir, 'index.md');
      this.#attachmentsPath = join(this.#dir, 'attachments.json');
      if (!this.#readOnly) {
        try {
          if (!existsSync(this.#dir)) mkdirSync(this.#dir, { recursive: true });
        } catch {
          this.#readOnly = true;
        }
      }
      this.#loadAll();
    } else {
      this.#dir = null;
      this.#indexPath = null;
      this.#attachmentsPath = null;
    }

    // Ensure the main thread is always present.
    if (!this.#threads.has(MAIN_THREAD_ID)) {
      const now = Date.now();
      this.#threads.set(
        MAIN_THREAD_ID,
        this.#newThreadRecord({
          id: MAIN_THREAD_ID,
          name: 'main',
          goal: '',
          parentThreadId: null,
          createdAt: now,
          updatedAt: now,
        }),
      );
      this.#markDirty(MAIN_THREAD_ID);
    }

    // If the on-disk currentId is unknown, fall back to main.
    if (!this.#threads.has(this.#currentId)) {
      this.#currentId = MAIN_THREAD_ID;
    }
  }

  /** Build a thread record with default cached fields. */
  #newThreadRecord(base) {
    return {
      status: 'active',
      messageCount: 0,
      lastMessageAt: null,
      lastActivityAt: null,
      archived: false,
      mergedInto: null,
      forkedFrom: null,
      unread: 0,
      preview: '',
      ...base,
    };
  }

  // ─── load / persist ────────────────────────────────────────────────

  /** Load all thread files + attachments from disk into memory. */
  #loadAll() {
    if (!this.#dir || !existsSync(this.#dir)) return;
    let entries;
    try {
      entries = readdirSync(this.#dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      if (entry.name === 'index.md') continue;
      const id = entry.name.slice(0, -3);
      try {
        const raw = readFileSync(join(this.#dir, entry.name), 'utf8');
        const parsed = parseThread(raw);
        if (parsed && parsed.id === id) {
          this.#threads.set(id, parsed);
        }
      } catch {
        // Skip corrupt files silently.
      }
    }
    // Attachments side-car.
    try {
      if (this.#attachmentsPath && existsSync(this.#attachmentsPath)) {
        const raw = readFileSync(this.#attachmentsPath, 'utf8');
        for (const { threadId, taskId } of parseAttachments(raw)) {
          if (this.#threads.has(threadId)) {
            this.#attachments.set(threadId, taskId);
          }
        }
      }
    } catch {
      // Skip silently.
    }
    // Try to recover currentId from index.md frontmatter.
    try {
      if (this.#indexPath && existsSync(this.#indexPath)) {
        const raw = readFileSync(this.#indexPath, 'utf8');
        const m = raw.match(/^currentId:\s*(\S+)/m);
        if (m && this.#threads.has(m[1])) {
          this.#currentId = m[1];
        }
      }
    } catch {
      // Ignore — fall back to main on miss.
    }
  }

  #markDirty(threadId) {
    if (!this.#dir || this.#readOnly) return;
    this.#dirtyThreads.add(threadId);
    this.#dirtyIndex = true;
    this.#scheduleFlush();
  }

  #markAttachmentsDirty() {
    if (!this.#dir || this.#readOnly) return;
    this.#dirtyAttachments = true;
    this.#dirtyIndex = true;
    this.#scheduleFlush();
  }

  #scheduleFlush() {
    if (this.#flushTimer || typeof setTimeout !== 'function') return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      this.flush();
    }, FLUSH_DEBOUNCE_MS);
    // Do not hold the process open for a pending flush — if the Node loop
    // has nothing else to do, the store still makes it through shutdown
    // via explicit flush() or process exit handlers.
    if (this.#flushTimer && typeof this.#flushTimer.unref === 'function') {
      this.#flushTimer.unref();
    }
  }

  /**
   * Write any pending dirty state to disk immediately. Safe to call on an
   * in-memory or read-only store (it becomes a no-op). Returns the number of
   * files written.
   */
  flush() {
    if (!this.#dir || this.#readOnly) {
      this.#dirtyThreads.clear();
      this.#dirtyIndex = false;
      this.#dirtyAttachments = false;
      return 0;
    }
    let written = 0;
    for (const id of this.#dirtyThreads) {
      const t = this.#threads.get(id);
      if (!t) {
        // Deleted thread → remove the file if present.
        try {
          const p = join(this.#dir, `${id}.md`);
          if (existsSync(p)) {
            unlinkSync(p);
            written += 1;
          }
        } catch {
          // ignore
        }
        continue;
      }
      try {
        writeFileSync(join(this.#dir, `${id}.md`), serializeThread(t), 'utf8');
        written += 1;
      } catch {
        // Best-effort
      }
    }
    this.#dirtyThreads.clear();
    if (this.#dirtyAttachments) {
      try {
        writeFileSync(this.#attachmentsPath, serializeAttachments(this.#attachments), 'utf8');
      } catch {
        // ignore
      }
      this.#dirtyAttachments = false;
    }
    if (this.#dirtyIndex) {
      try {
        writeFileSync(this.#indexPath, generateIndex(this.#threads, this.#currentId, this.#attachments), 'utf8');
      } catch {
        // ignore
      }
      this.#dirtyIndex = false;
    }
    return written;
  }

  // ─── Query API (unchanged) ─────────────────────────────────────────

  get currentId() { return this.#currentId; }
  get size() { return this.#threads.size; }

  get(id) { return this.#threads.get(id) || null; }
  list() { return [...this.#threads.values()]; }
  has(id) { return this.#threads.has(id); }

  // ─── Mutation API (all calls schedule a debounced flush) ───────────

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
    this.#markDirty(id);
    return thread;
  }

  /** Set the current thread marker. Throws if unknown. */
  switch(id) {
    if (!this.#threads.has(id)) {
      throw new Error(`thread not found: ${id}`);
    }
    this.#currentId = id;
    const t = this.#threads.get(id);
    t.updatedAt = Date.now();
    this.#markDirty(id);
  }

  /**
   * Record that a message has been persisted on a thread. Increments the
   * cached messageCount and updates lastMessageAt. Safe to call repeatedly;
   * unknown threadIds are silently ignored.
   */
  noteMessage(threadId, at = Date.now(), opts = {}) {
    const t = this.#threads.get(threadId);
    if (!t) return;
    t.messageCount += 1;
    t.lastMessageAt = at;
    t.lastActivityAt = at;
    t.updatedAt = at;
    if (opts.countsAsUnread !== false) {
      t.unread += 1;
    }
    if (typeof opts.preview === 'string' && opts.preview.length > 0) {
      const p = opts.preview.replace(/\s+/g, ' ').trim();
      t.preview = p.length > 160 ? p.slice(0, 157) + '...' : p;
    }
    if (t.status === 'archived') {
      t.status = 'active';
      t.archived = false;
    }
    this.#markDirty(threadId);
  }

  /** Mark a thread as read — resets unread counter to 0. */
  markRead(threadId) {
    const t = this.#threads.get(threadId);
    if (!t) return;
    if (t.unread === 0) return;
    t.unread = 0;
    this.#markDirty(threadId);
  }

  archive(id) {
    const t = this.#threads.get(id);
    if (!t) throw new Error(`thread not found: ${id}`);
    if (id === MAIN_THREAD_ID) throw new Error('cannot archive main thread');
    t.status = 'archived';
    t.archived = true;
    t.updatedAt = Date.now();
    this.#markDirty(id);
  }

  /**
   * Merge the source thread into the target (task-313). The source is
   * marked archived and gets `mergedInto: targetId`; target's cached
   * counters pick up the source's message count and activity. Callers
   * are still expected to reassign the actual messages on disk via
   * `ConversationStore.reassignThread(sourceId, targetId)`.
   *
   * Constraints:
   *  - source !== target
   *  - both threads must exist
   *  - source cannot be the main thread (main cannot be archived)
   *  - source cannot already have been merged elsewhere (idempotency)
   *
   * @param {string} sourceId
   * @param {string} targetId
   * @returns {{ source: Thread, target: Thread }}
   */
  mergeThread(sourceId, targetId) {
    if (!sourceId || !targetId) {
      throw new Error('mergeThread: sourceId and targetId required');
    }
    if (sourceId === targetId) {
      throw new Error('mergeThread: cannot merge a thread into itself');
    }
    if (sourceId === MAIN_THREAD_ID) {
      throw new Error('mergeThread: cannot merge the main thread into another');
    }
    const source = this.#threads.get(sourceId);
    if (!source) throw new Error(`thread not found: ${sourceId}`);
    const target = this.#threads.get(targetId);
    if (!target) throw new Error(`thread not found: ${targetId}`);
    if (source.mergedInto) {
      throw new Error(`thread ${sourceId} already merged into ${source.mergedInto}`);
    }

    const now = Date.now();

    // Accumulate counters onto target.
    target.messageCount += source.messageCount;
    if (source.lastMessageAt && (!target.lastMessageAt || source.lastMessageAt > target.lastMessageAt)) {
      target.lastMessageAt = source.lastMessageAt;
    }
    if (source.lastActivityAt && (!target.lastActivityAt || source.lastActivityAt > target.lastActivityAt)) {
      target.lastActivityAt = source.lastActivityAt;
    }
    target.updatedAt = now;
    // Revive target if it was archived — a merge is an activity signal.
    if (target.status === 'archived') {
      target.status = 'active';
      target.archived = false;
    }

    // Mark source as archived + pointer to target.
    source.status = 'archived';
    source.archived = true;
    source.mergedInto = targetId;
    source.updatedAt = now;

    // If source was current, move the pointer to target.
    if (this.#currentId === sourceId) {
      this.#currentId = targetId;
    }

    // Drop any task attachment on source (it now belongs to target).
    if (this.#attachments.has(sourceId)) {
      const taskId = this.#attachments.get(sourceId);
      this.#attachments.delete(sourceId);
      // Preserve attachment on target if it had none; otherwise keep target's.
      if (!this.#attachments.has(targetId)) {
        this.#attachments.set(targetId, taskId);
      }
      this.#markAttachmentsDirty();
    }

    this.#markDirty(sourceId);
    this.#markDirty(targetId);
    return { source, target };
  }

  /**
   * Fork a new thread from an existing one at a specific message cursor.
   * ThreadStore only creates the new thread record (with `forkedFrom`
   * pointing at source + message + timestamp); the actual copying of
   * messages up to `atMessageId` is done by ConversationStore.copyThreadUpTo
   * — this keeps the two stores' responsibilities separate.
   *
   * Validation:
   *  - source must exist
   *  - source must not be archived (forking a dead thread is confusing)
   *  - atMessageId must be a non-empty string (actual existence check is
   *    the caller's responsibility, since ThreadStore doesn't own messages)
   *  - source may itself be a fork (chain is supported)
   *
   * @param {string} sourceId
   * @param {string} atMessageId
   * @param {{ name?: string, title?: string, timestamp?: number }} [opts]
   * @returns {Thread} the newly created forked thread record
   */
  forkThread(sourceId, atMessageId, opts = {}) {
    if (!sourceId) throw new Error('forkThread: sourceId required');
    if (!atMessageId || typeof atMessageId !== 'string') {
      throw new Error('forkThread: atMessageId required');
    }
    const source = this.#threads.get(sourceId);
    if (!source) throw new Error(`thread not found: ${sourceId}`);
    if (source.archived || source.status === 'archived') {
      throw new Error(`forkThread: cannot fork an archived thread (${sourceId})`);
    }
    const now = Date.now();
    const id = `thr-${randomUUID().slice(0, 8)}`;
    const defaultName = source.id === MAIN_THREAD_ID ? 'inbox-fork' : `${source.name}-fork`;
    const thread = this.#newThreadRecord({
      id,
      name: (opts.name && opts.name.trim()) || defaultName,
      goal: source.goal || '',
      parentThreadId: sourceId,
      createdAt: now,
      updatedAt: now,
      forkedFrom: {
        threadId: sourceId,
        messageId: atMessageId,
        timestamp: Number.isFinite(opts.timestamp) ? opts.timestamp : now,
      },
    });
    this.#threads.set(id, thread);
    this.#markDirty(id);
    return thread;
  }

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
    this.#markDirty(id);
  }

  /**
   * Rebuild cached fields (messageCount/lastMessageAt) from a flat messages
   * list. Used for crash recovery or as a sanity check in tests.
   */
  rebuildFromMessages(messages) {
    for (const t of this.#threads.values()) {
      t.messageCount = 0;
      t.lastMessageAt = null;
      t.lastActivityAt = null;
      this.#markDirty(t.id);
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
      this.#markDirty(tid);
    }
  }

  attachTask(threadId, taskId) {
    if (!this.#threads.has(threadId)) {
      throw new Error(`thread not found: ${threadId}`);
    }
    if (!taskId || typeof taskId !== 'string') {
      throw new Error('taskId is required');
    }
    this.#attachments.set(threadId, taskId);
    this.#markAttachmentsDirty();
  }

  attachedTask(threadId) {
    return this.#attachments.get(threadId) || null;
  }

  listAttachments() {
    return [...this.#attachments.entries()].map(([threadId, taskId]) => ({ threadId, taskId }));
  }
}

// ─── Singleton helpers ───────────────────────────────────────────────────

/** @type {ThreadStore|null} */
let threadStore = null;

/**
 * Initialise the thread store. Safe to call multiple times — subsequent calls
 * replace the store only if `force` is true (primarily for tests).
 *
 * Accepts either `initThreadStore()` (legacy, in-memory) or
 * `initThreadStore(yeaftDir, opts)` (persistent). Legacy callers keep working.
 *
 * @param {string|{ force?: boolean }} [yeaftDirOrOpts]
 * @param {{ force?: boolean, readOnly?: boolean }} [opts]
 * @returns {ThreadStore}
 */
export function initThreadStore(yeaftDirOrOpts, opts = {}) {
  let yeaftDir;
  let mergedOpts;
  if (typeof yeaftDirOrOpts === 'string') {
    yeaftDir = yeaftDirOrOpts;
    mergedOpts = opts || {};
  } else {
    yeaftDir = undefined;
    mergedOpts = yeaftDirOrOpts || {};
  }
  if (!threadStore || mergedOpts.force) {
    threadStore = new ThreadStore(yeaftDir, mergedOpts);
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
  if (threadStore && typeof threadStore.flush === 'function') {
    try { threadStore.flush(); } catch { /* ignore */ }
  }
  threadStore = null;
}

// Exported for tests.
export { serializeThread as _serializeThread, parseThread as _parseThread };
