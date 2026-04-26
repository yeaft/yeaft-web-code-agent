/**
 * pipeline/dispatcher.js — task-310 Phase 2 integration.
 *
 * Composes the three Phase-2 building blocks into a single linear pipeline:
 *
 *     unify_chat input
 *            │
 *            ▼
 *    ┌──────────────┐   (task-307b)
 *    │ InputQueue   │   persistent FIFO of pending user inputs
 *    └──────┬───────┘
 *           │ claim()                (transition pending → routing)
 *           ▼
 *    ┌──────────────┐   (task-309)
 *    │ IntentClass. │   explicit @prefix / override / LLM / fallback
 *    └──────┬───────┘
 *           │ { action, targetThreadId, source, reason }
 *           ▼
 *    ┌──────────────┐   (task-308)
 *    │ EngineReg.   │   ensure(threadId) → EngineInstance
 *    └──────┬───────┘
 *           │ inst.query({ prompt })
 *           ▼
 *    ┌──────────────┐
 *    │ Engine events│   text_delta / tool_call / tool_end / …
 *    └──────┬───────┘
 *           │ each event tagged { ...ev, threadId } by EngineInstance
 *           ▼
 *      web-bridge forwards to `unify_output`
 *
 * ### Responsibilities
 *
 * This module OWNS the pipeline's control-flow decisions:
 *
 *   - `submit(input)` — enqueue + return the queue entry, non-streaming.
 *     The caller either invokes `drain()` to actually dispatch, or lets a
 *     future background worker pick it up. (We go with the simple "drain
 *     on submit" default because the web-bridge is the sole producer and
 *     cannot afford a stuck pending entry.)
 *
 *   - `dispatch(entry)` async-generator — runs one entry through router +
 *     engine. Yields a stream of bridge events:
 *
 *       { type: 'input_queue_updated', pending, routing, … }
 *       { type: 'routing_decision', entryId, action, targetThreadId, source, reason }
 *       { type: 'thread_list_updated', threads, currentThreadId }  (on fork)
 *       { type: 'engine_event', threadId, event }     // raw Engine event
 *       { type: 'error', error: Error, retryable }
 *
 *     The web-bridge translates `engine_event`s into claude_output (the
 *     existing code path) and forwards the pipeline-level events as
 *     `unify_output.event`.
 *
 *   - `drain()` — convenience: claim + dispatch repeatedly until the queue
 *     is empty. Web-bridge calls this after every submit().
 *
 * ### What this module does NOT own
 *
 *   - Persistence of messages (Engine / EngineInstance).
 *   - ThreadStore mutations beyond incrementing currentId on 'switch' /
 *     creating a fork thread on 'fork'.
 *   - WebSocket framing (web-bridge does that).
 *   - Abort semantics — each caller wraps `dispatch()` with its own
 *     AbortController / signal (we forward it to EngineInstance.query).
 *
 * ### Concurrent reflow (spec point 5)
 *
 * Node's single-thread event loop means two concurrent `dispatch()` calls
 * interleave at await points. Every yielded `engine_event` carries a
 * `threadId` (EngineInstance re-tags), so the web-bridge can render events
 * into the correct UI bubble. The dispatcher itself holds NO per-turn
 * state on `this` — all state lives in the async generator's closure, so
 * two pipelines can be in-flight at the same time without aliasing.
 */

import { MAIN_THREAD_ID } from '../threads/store.js';
import { getTaskStore } from '../tools/task-tools.js';

/**
 * Per-entry transient metadata (messageId, override) lives here — a
 * WeakMap keyed by the queue entry object so it is NEVER persisted to
 * disk by InputQueueStore.#writeEntry. Entries are GC'd together with
 * the entry once the queue drops the strong reference.
 * @type {WeakMap<object, {messageId?: string, override?: {threadId: string}}>}
 */
const transientMeta = new WeakMap();

/**
 * @typedef {'continue'|'interrupt'|'fork'|'switch'} RouterAction
 *
 * @typedef {Object} SubmitOptions
 * @property {string} [messageId]   — optional stable id for override()
 * @property {{ threadId: string }} [override] — UI-side `@thread-name` hint
 *   or user correction: skip router, go straight to `switch`/`continue`
 *   targeting the given threadId.
 *
 * @typedef {Object} DispatcherDeps
 * @property {import('../input-queue/store.js').InputQueueStore} inputQueue
 * @property {import('../router/intent-classifier.js').IntentClassifier} router
 * @property {import('../threads/engine-registry.js').ThreadEngineRegistry} engineRegistry
 * @property {import('../threads/store.js').ThreadStore} threadStore
 * @property {object} [trace]
 */

export class Dispatcher {
  /** @type {DispatcherDeps} */
  #deps;

  constructor(deps) {
    const { inputQueue, router, engineRegistry, threadStore } = deps || {};
    if (!inputQueue || typeof inputQueue.enqueue !== 'function') {
      throw new Error('Dispatcher: inputQueue is required');
    }
    if (!router || typeof router.classify !== 'function') {
      throw new Error('Dispatcher: router is required');
    }
    if (!engineRegistry || typeof engineRegistry.ensure !== 'function') {
      throw new Error('Dispatcher: engineRegistry is required');
    }
    if (!threadStore || typeof threadStore.list !== 'function') {
      throw new Error('Dispatcher: threadStore is required');
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
   * `dispatch(entry)` next. Separated so callers can atomically observe
   * the `input_queue_updated` snapshot before the first router call fires.
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
    // Transient metadata lives in a WeakMap keyed by the entry — it is
    // intentionally off the entry object itself so InputQueueStore's
    // JSON.stringify write path does NOT leak `_messageId`/`_override`
    // to disk. The WeakMap entry is dropped when the queue releases the
    // entry reference (after markRouted removes it from memory).
    transientMeta.set(entry, {
      messageId: opts.messageId || undefined,
      override: opts.override || undefined,
      queryOpts: opts.queryOpts || undefined,
    });
    const snapshot = this.#queueSnapshot();
    return { entry, snapshot };
  }

  /**
   * Drain the queue: claim → dispatch in a loop until empty.
   * Yields the union of every `dispatch()`'s events, interleaved naturally.
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
   * Dispatch one queue entry through router + engine. Transitions the
   * entry: pending → routing (on claim) → dispatched (on success) or back
   * to pending (on router exception, which is already guarded inside the
   * classifier — so in practice this branch is very rare).
   *
   * @param {object} entry — from inputQueue.peek() or inputQueue.enqueue()
   * @param {{ signal?: AbortSignal }} [opts]
   * @yields {object} bridge events
   */
  async *dispatch(entry, opts = {}) {
    const { inputQueue, router, engineRegistry, threadStore } = this.#deps;
    const { signal } = opts;

    // ── Step 1: claim (pending → routing) ──
    // Note: we assume the caller already found `entry` as the head. A
    // concurrent dispatcher would have claimed it first; we check for that.
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

    // ── Step 2: gather router context ──
    const currentThreadId = threadStore.currentId || MAIN_THREAD_ID;
    const allThreads = threadStore.list().map(t => ({
      id: t.id, name: t.name, goal: t.goal, status: t.status,
    }));
    const pendingTasks = this.#listPendingTasks();

    // ── Step 3: classify (explicit override > classifier) ──
    /** @type {import('../router/intent-classifier.js').RouterDecision} */
    let decision;
    const meta = transientMeta.get(entry) || {};
    const ov = meta.override;
    if (ov && typeof ov.threadId === 'string' && ov.threadId) {
      const known = allThreads.some(t => t.id === ov.threadId) || ov.threadId === currentThreadId;
      if (known) {
        const action = ov.threadId === currentThreadId ? 'continue' : 'switch';
        decision = {
          action,
          targetThreadId: ov.threadId,
          reason: 'ui_override',
          source: 'override',
        };
      }
    }
    if (!decision) {
      try {
        decision = await router.classify({
          userMessage: claimed.text,
          currentThreadId,
          allThreads,
          pendingTasks,
          messageId: meta.messageId || undefined,
        });
      } catch (err) {
        // Classifier is wrapped in its own try/catch already; reaching here
        // means a truly unexpected failure. Degrade to continue.
        decision = {
          action: 'continue',
          targetThreadId: currentThreadId,
          reason: `dispatcher_classify_exception: ${err.message}`,
          source: 'fallback',
        };
      }
    }

    yield {
      type: 'routing_decision',
      entryId: claimed.id,
      action: decision.action,
      targetThreadId: decision.targetThreadId,
      source: decision.source || 'llm',
      reason: decision.reason || '',
    };

    // ── Step 4: resolve target thread (fork may create a new one) ──
    let targetThreadId = decision.targetThreadId;
    if (decision.action === 'fork') {
      const parentId = decision.targetThreadId || currentThreadId;
      const forked = this.#spawnForkedThread(parentId, claimed.text);
      if (forked) {
        targetThreadId = forked.id;
        yield this.#threadListSnapshot();
      }
    } else if (decision.action === 'switch') {
      // Move the ThreadStore cursor so subsequent tool-originated events
      // see the right thread for persistence hooks. Guard: not every
      // ThreadStore implementation exposes has() (e.g. historic mocks).
      const hasFn = typeof threadStore.has === 'function' ? (id) => threadStore.has(id) : () => true;
      if (hasFn(targetThreadId)) {
        try { threadStore.switch(targetThreadId); } catch { /* ignore */ }
      }
    }

    // ── Step 5: dispatch to EngineInstance ──
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

  // ──────────────────────────────────────────────────────────────

  #threadListSnapshot() {
    const { threadStore } = this.#deps;
    const threads = threadStore.list().map(t => ({
      id: t.id,
      name: t.name,
      goal: t.goal || '',
      parentThreadId: t.parentThreadId || null,
      status: t.status,
      archived: !!t.archived,
      messageCount: t.messageCount || 0,
      lastMessageAt: t.lastMessageAt || null,
    }));
    return {
      type: 'thread_list_updated',
      threads,
      currentThreadId: threadStore.currentId,
    };
  }

  #spawnForkedThread(parentId, promptText) {
    const { threadStore } = this.#deps;
    if (!threadStore.create) return null;
    // Short label from first non-empty line, capped at 40 chars.
    const firstLine = (promptText || '').split(/\r?\n/).find(l => l.trim()) || 'fork';
    const name = firstLine.trim().slice(0, 40);
    try {
      return threadStore.create({ name, parentThreadId: parentId });
    } catch {
      return null;
    }
  }

  #listPendingTasks() {
    // Best-effort: the TaskStore is a singleton initialised in loadSession().
    // If the store isn't available (e.g. unit tests without a session) we
    // just return []. Never let a TaskStore exception break routing.
    try {
      const store = getTaskStore();
      if (!store || typeof store.list !== 'function') return [];
      const pending = store.list({ status: 'pending' }) || [];
      return pending.map(t => ({
        id: t.id,
        title: t.title || '',
        threadId: t.threadId || null,
      }));
    } catch { /* ignore */ }
    return [];
  }
}

/**
 * Build a Dispatcher from session-level deps.
 * @param {DispatcherDeps} deps
 * @returns {Dispatcher}
 */
export function createDispatcher(deps) {
  return new Dispatcher(deps);
}
