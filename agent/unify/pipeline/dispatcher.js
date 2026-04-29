/**
 * pipeline/dispatcher.js — H2.f.1 single-thread dispatcher.
 *
 * H2 retires the multi-thread routing model. The new memory architecture
 * (pre-flow FTS + adjustMemory) does not need an LLM router to pick a
 * thread per turn; one engine, one conversation. This module preserves
 * the historic `submit()` / `drain()` API surface so web-bridge does not
 * change in this PR — it just always routes to MAIN_THREAD_ID and never
 * calls a classifier.
 *
 * The pipeline now collapses to:
 *
 *     unify_chat input
 *            │
 *            ▼
 *    ┌──────────────┐
 *    │ InputQueue   │   persistent FIFO of pending user inputs
 *    └──────┬───────┘
 *           │ claim()
 *           ▼
 *    ┌──────────────┐
 *    │ EngineReg.   │   ensure(MAIN_THREAD_ID) → EngineInstance
 *    └──────┬───────┘
 *           │ inst.query({ prompt })
 *           ▼
 *      web-bridge forwards engine events as `unify_output`.
 *
 * `routing_decision` is still yielded so the wire protocol is unchanged
 * (action='continue', source='single-thread'). Frontend treats it as a
 * no-op marker.
 */

import { MAIN_THREAD_ID } from '../threads/store.js';

/**
 * Per-entry transient metadata (messageId, queryOpts) lives in a WeakMap
 * keyed by the queue entry object so it is NEVER persisted to disk by
 * InputQueueStore. Entries are GC'd together with the entry once the
 * queue drops the strong reference.
 * @type {WeakMap<object, {messageId?: string, queryOpts?: object}>}
 */
const transientMeta = new WeakMap();

/**
 * @typedef {Object} SubmitOptions
 * @property {string} [messageId]
 * @property {object} [queryOpts]
 * @property {object} [override] — accepted for back-compat, ignored.
 *
 * @typedef {Object} DispatcherDeps
 * @property {import('../input-queue/store.js').InputQueueStore} inputQueue
 * @property {import('../threads/engine-registry.js').ThreadEngineRegistry} engineRegistry
 * @property {object} [trace]
 */

export class Dispatcher {
  /** @type {DispatcherDeps} */
  #deps;

  constructor(deps) {
    const { inputQueue, engineRegistry } = deps || {};
    if (!inputQueue || typeof inputQueue.enqueue !== 'function') {
      throw new Error('Dispatcher: inputQueue is required');
    }
    if (!engineRegistry || typeof engineRegistry.ensure !== 'function') {
      throw new Error('Dispatcher: engineRegistry is required');
    }
    this.#deps = deps;
  }

  /** Snapshot of queue counters for the UI, post-mutation. */
  #queueSnapshot() {
    const { inputQueue } = this.#deps;
    const entries = inputQueue.list();
    const counts = { pending: 0, routing: 0, dispatched: 0 };
    for (const e of entries) {
      if (counts[e.status] !== undefined) counts[e.status] += 1;
    }
    return {
      type: 'input_queue_updated',
      total: entries.length,
      pending: counts.pending,
      routing: counts.routing,
      dispatched: counts.dispatched,
      head: entries[0] ? { id: entries[0].id, status: entries[0].status, text: entries[0].text.slice(0, 80) } : null,
    };
  }

  /**
   * Enqueue a user input. Does NOT dispatch — caller invokes `drain()` or
   * `dispatch(entry)` next.
   *
   * @param {string} text
   * @param {SubmitOptions} [opts]
   * @returns {{ entry: object, snapshot: object }}
   */
  submit(text, opts = {}) {
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('Dispatcher.submit: text required');
    }
    const { inputQueue } = this.#deps;
    const entry = inputQueue.enqueue(text);
    transientMeta.set(entry, {
      messageId: opts.messageId || undefined,
      queryOpts: opts.queryOpts || undefined,
    });
    const snapshot = this.#queueSnapshot();
    return { entry, snapshot };
  }

  /**
   * Drain the queue: claim → dispatch in a loop until empty.
   *
   * @param {{ signal?: AbortSignal }} [opts]
   * @yields {object} bridge events
   */
  async *drain(opts = {}) {
    const { inputQueue } = this.#deps;
    while (true) {
      const head = inputQueue.peek();
      if (!head) return;
      if (head.status !== 'pending') return; // another dispatcher holds it
      for await (const ev of this.dispatch(head, opts)) yield ev;
    }
  }

  /**
   * Dispatch one queue entry to the single thread engine. Always routes
   * to MAIN_THREAD_ID — no LLM classification, no fork/switch/interrupt.
   *
   * @param {object} entry — from inputQueue.peek() or inputQueue.enqueue()
   * @param {{ signal?: AbortSignal }} [opts]
   * @yields {object} bridge events
   */
  async *dispatch(entry, opts = {}) {
    const { inputQueue, engineRegistry } = this.#deps;
    const { signal } = opts;

    // ── Step 1: claim (pending → routing) ──
    let claimed = entry;
    if (entry.status === 'pending') {
      claimed = inputQueue.claim();
      if (!claimed || claimed.id !== entry.id) {
        // Another worker took it. Treat as a no-op success.
        yield this.#queueSnapshot();
        return;
      }
    }
    yield this.#queueSnapshot();

    // ── Step 2: synthesize a "continue to main" routing decision so the
    //            wire protocol stays compatible with old clients. ──
    const targetThreadId = MAIN_THREAD_ID;
    yield {
      type: 'routing_decision',
      entryId: claimed.id,
      action: 'continue',
      targetThreadId,
      source: 'single-thread',
      reason: 'single-thread-dispatcher',
    };

    // ── Step 3: dispatch to the single EngineInstance ──
    let instance;
    try {
      instance = engineRegistry.ensure(targetThreadId);
    } catch (err) {
      inputQueue.markFailed(claimed.id, err);
      yield this.#queueSnapshot();
      yield { type: 'error', error: err, retryable: false };
      return;
    }

    try {
      const queryOpts = (transientMeta.get(claimed) || {}).queryOpts || {};
      for await (const event of instance.query({ prompt: claimed.text, signal, ...queryOpts })) {
        yield { type: 'engine_event', threadId: targetThreadId, event };
      }
      inputQueue.markRouted(claimed.id, targetThreadId);
      yield this.#queueSnapshot();
    } catch (err) {
      inputQueue.markFailed(claimed.id, err);
      yield this.#queueSnapshot();
      yield { type: 'error', error: err, retryable: true };
    }
  }
}

/**
 * Build a single-thread Dispatcher from session-level deps.
 * @param {DispatcherDeps} deps
 * @returns {Dispatcher}
 */
export function createDispatcher(deps) {
  return new Dispatcher(deps);
}
