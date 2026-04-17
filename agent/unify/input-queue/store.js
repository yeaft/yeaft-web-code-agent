/**
 * input-queue/store.js — Persistent FIFO input queue for Yeaft Unify.
 *
 * task-307b (Phase 2): a disk-backed queue of user inputs waiting to be
 * routed to a thread/engine. Each entry is one JSON file at
 *   <yeaftDir>/input-queue/<id>.json
 * so that crashing during a routing decision never loses a queued input.
 *
 * Schema follows design doc §5:
 *   {
 *     id:         'iq-xxxxxxxx',
 *     text:       '<the user-typed input>',
 *     createdAt:  1234567890123,            // epoch ms
 *     status:     'pending' | 'routing' | 'dispatched',
 *     routedTo:   '<threadId>' | null,      // set when status === 'dispatched'
 *     routedAt:   1234567890456 | null,
 *     error:      '<message>' | null,       // optional — populated when a
 *                                           //   routing attempt fails and
 *                                           //   the entry is put back to
 *                                           //   'pending' for retry.
 *   }
 *
 * State machine:
 *        enqueue(text)
 *             │
 *             ▼
 *         pending ─────claim()─────► routing ─────markRouted()────► dispatched
 *             ▲                        │
 *             └──────markFailed()──────┘  (status back to pending; error field recorded)
 *
 *   - pending    : waiting for a dispatcher
 *   - routing    : a dispatcher has taken responsibility; crash here means
 *                  boot-time recovery will still see the entry and can
 *                  re-claim it (the row is still on disk).
 *   - dispatched : routed to a thread — the file is removed because the
 *                  durable audit trail now lives in the messages.
 *
 * API (task-307b per PM):
 *   - enqueue(text)                → entry          Create + persist pending.
 *   - dequeue()                    → entry | null   Peek at oldest pending
 *                                                   (non-mutating — see
 *                                                   claim() for the mutating
 *                                                   transition).
 *   - claim()                      → entry | null   Oldest pending → 'routing'
 *                                                   (atomic w.r.t. disk).
 *   - list(status?)                → entry[]        Snapshot filtered by status.
 *   - markRouted(id, routedTo)     → entry | null   routing → dispatched;
 *                                                   file deleted.
 *   - markFailed(id, err)          → entry | null   routing → pending; error
 *                                                   recorded; kept on disk.
 *   - peek() / get(id) / remove(id) / size() / pendingCount()
 *
 * Persistence:
 *   - Writes are synchronous. The queue is a durability boundary, not a
 *     hot path (one write per state transition).
 *   - Permission/FS failures don't throw: they are swallowed and logged once
 *     per process (matches ConversationStore's philosophy).
 *   - If `yeaftDir` is omitted, the store operates purely in memory.
 */

import { randomUUID } from 'crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from 'fs';
import { join } from 'path';

/** All valid status values, per design §5. */
export const INPUT_QUEUE_STATUSES = ['pending', 'routing', 'dispatched'];

export class InputQueueStore {
  /** @type {Map<string, object>} */
  #entries;
  /** @type {string|null} */
  #dir;
  /** @type {boolean} */
  #persistent;
  /** @type {boolean} */
  #warned;

  /**
   * @param {string|null} [yeaftDir]
   */
  constructor(yeaftDir = null) {
    this.#entries = new Map();
    this.#warned = false;

    if (yeaftDir) {
      this.#dir = join(yeaftDir, 'input-queue');
      this.#persistent = true;
      this.#ensureDir();
      this.#loadAll();
    } else {
      this.#dir = null;
      this.#persistent = false;
    }
  }

  get persistent() { return this.#persistent; }
  size() { return this.#entries.size; }

  pendingCount() {
    let n = 0;
    for (const e of this.#entries.values()) if (e.status === 'pending') n += 1;
    return n;
  }

  /**
   * Append a new pending entry and persist it.
   * @param {string} text
   * @returns {object} the entry
   */
  enqueue(text) {
    if (typeof text !== 'string') throw new Error('text must be a string');
    const id = `iq-${randomUUID().slice(0, 8)}`;
    const entry = {
      id,
      text,
      createdAt: Date.now(),
      status: 'pending',
      routedTo: null,
      routedAt: null,
      error: null,
    };
    this.#entries.set(id, entry);
    this.#writeEntry(entry);
    return entry;
  }

  /** Oldest pending entry (no state change). null if empty. */
  peek() {
    let oldest = null;
    for (const e of this.#entries.values()) {
      if (e.status !== 'pending') continue;
      if (!oldest || e.createdAt < oldest.createdAt) oldest = e;
    }
    return oldest;
  }

  /**
   * Return the oldest pending entry without mutating state. Kept as a
   * separate method from claim() because some consumers only want to
   * observe the head of the queue (e.g. UI preview).
   */
  dequeue() {
    return this.peek();
  }

  /**
   * Transition the oldest pending entry → 'routing' and persist. This is
   * the real consumer-facing take: after claim() the caller must eventually
   * call markRouted() (success) or markFailed() (→ put back as pending).
   *
   * @returns {object|null} the claimed entry, or null if nothing pending
   */
  claim() {
    const e = this.peek();
    if (!e) return null;
    e.status = 'routing';
    this.#writeEntry(e);
    return e;
  }

  /**
   * Mark an entry as successfully dispatched to a thread. Persists the
   * updated state then removes the file — the authoritative record now
   * lives in the conversation/messages log.
   *
   * @param {string} id
   * @param {string} routedTo — thread id (e.g. 'main' or 'thr-xxxxxxxx')
   * @returns {object|null}
   */
  markRouted(id, routedTo) {
    const e = this.#entries.get(id);
    if (!e) return null;
    if (!routedTo || typeof routedTo !== 'string') throw new Error('routedTo required');
    e.status = 'dispatched';
    e.routedTo = routedTo;
    e.routedAt = Date.now();
    // Persist the transition before removing (crash-safe ordering).
    this.#writeEntry(e);
    this.#removeFile(id);
    this.#entries.delete(id);
    return e;
  }

  /**
   * Mark a routing attempt failed. The entry returns to 'pending' so the
   * next claim() can retry it; the error string is retained for diagnostics.
   *
   * @param {string} id
   * @param {string|Error} err
   */
  markFailed(id, err) {
    const e = this.#entries.get(id);
    if (!e) return null;
    e.status = 'pending';
    e.error = typeof err === 'string' ? err : (err?.message || String(err));
    this.#writeEntry(e);
    return e;
  }

  /** Remove an entry entirely (memory + disk). */
  remove(id) {
    if (!this.#entries.has(id)) return false;
    this.#entries.delete(id);
    this.#removeFile(id);
    return true;
  }

  /**
   * Snapshot of all entries, optionally filtered by status. Chronological.
   * @param {'pending'|'routing'|'dispatched'} [status]
   */
  list(status) {
    let arr = [...this.#entries.values()];
    if (status) arr = arr.filter(e => e.status === status);
    arr.sort((a, b) => a.createdAt - b.createdAt);
    return arr;
  }

  get(id) { return this.#entries.get(id) || null; }

  // ─── Persistence internals ────────────────────────────

  #ensureDir() {
    try {
      if (!existsSync(this.#dir)) mkdirSync(this.#dir, { recursive: true, mode: 0o755 });
    } catch (err) {
      this.#warn(`Cannot create input-queue dir: ${err?.code || err?.message}`);
    }
  }

  #loadAll() {
    if (!existsSync(this.#dir)) return;
    let files;
    try {
      files = readdirSync(this.#dir);
    } catch (err) {
      this.#warn(`Cannot read input-queue dir: ${err?.code || err?.message}`);
      return;
    }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const path = join(this.#dir, f);
      try {
        const raw = readFileSync(path, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || !parsed.id) continue;
        if (!INPUT_QUEUE_STATUSES.includes(parsed.status)) continue;
        // Crash recovery: an entry left in 'routing' at startup had a
        // dispatcher claim it right before the crash. Put it back to
        // 'pending' so the next claim() can retry it.
        const status = parsed.status === 'routing' ? 'pending' : parsed.status;
        this.#entries.set(parsed.id, {
          id: parsed.id,
          text: typeof parsed.text === 'string' ? parsed.text : '',
          createdAt: Number(parsed.createdAt) || Date.now(),
          status,
          routedTo: parsed.routedTo || null,
          routedAt: parsed.routedAt || null,
          error: parsed.error || null,
        });
      } catch {
        // Skip corrupt file.
      }
    }
  }

  #writeEntry(entry) {
    if (!this.#persistent) return;
    const path = join(this.#dir, `${entry.id}.json`);
    try {
      writeFileSync(path, JSON.stringify(entry, null, 2), { encoding: 'utf8', mode: 0o644 });
    } catch (err) {
      this.#warn(`Cannot write ${entry.id}: ${err?.code || err?.message}`);
    }
  }

  #removeFile(id) {
    if (!this.#persistent) return;
    const path = join(this.#dir, `${id}.json`);
    if (!existsSync(path)) return;
    try {
      unlinkSync(path);
    } catch (err) {
      this.#warn(`Cannot remove ${id}: ${err?.code || err?.message}`);
    }
  }

  #warn(msg) {
    if (this.#warned) return;
    this.#warned = true;
    // eslint-disable-next-line no-console
    console.warn(`[Yeaft InputQueue] ${msg}`);
  }
}

// ─── Singleton helpers ────────────────────────────────────

/** @type {InputQueueStore|null} */
let inputQueueStore = null;

export function initInputQueueStore(opts = {}) {
  if (!inputQueueStore || opts.force) {
    inputQueueStore = new InputQueueStore(opts.yeaftDir || null);
  }
  return inputQueueStore;
}

export function getInputQueueStore() {
  if (!inputQueueStore) inputQueueStore = new InputQueueStore(null);
  return inputQueueStore;
}

export function _resetInputQueueStoreForTests() {
  inputQueueStore = null;
}
