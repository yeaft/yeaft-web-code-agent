/**
 * engine-registry.js — task-308 Phase 2.
 *
 * A ThreadEngineRegistry is a per-session Map<threadId, EngineInstance>.
 * It owns instance lifecycles:
 *
 *   - `get(threadId)` returns the existing instance for a thread.
 *   - `ensure(threadId, opts)` lazily creates one via the configured
 *     factory if it does not yet exist. This is the primary entry point
 *     for routing a user message to the correct thread engine.
 *   - `listActive()` enumerates non-terminated instances, useful for
 *     the web-bridge to show "active threads" indicators.
 *   - `terminate(threadId)` tears down a single thread engine without
 *     disturbing the rest.
 *   - `terminateAll()` is called on session shutdown.
 *
 * The registry holds no LLM/tool state itself — it delegates to the
 * factory, which in production will be the closure over the shared
 * session deps (adapter, trace, config, stores, tool registry, …).
 *
 * Concurrency note: Node's single-threaded event loop means the
 * registry's Map mutations are race-free. Concurrent .query() calls
 * interleave only at await points, and each EngineInstance keeps its
 * per-turn state inside the async generator's local scope, not on
 * `this` — so two threads can stream simultaneously without stepping
 * on each other.
 */

import { MAIN_THREAD_ID } from './store.js';
import { createEngineInstance } from './engine-instance.js';

export class ThreadEngineRegistry {
  /** @type {Map<string, import('./engine-instance.js').EngineInstance>} */
  #instances;

  /** @type {(threadId: string, opts?: object) => import('./engine-instance.js').EngineInstance} */
  #factory;

  /** @type {string} */
  #currentThreadId;

  /**
   * @param {{
   *   factory: (threadId: string, opts?: object) => import('./engine-instance.js').EngineInstance,
   * }} params
   */
  constructor({ factory } = {}) {
    if (typeof factory !== 'function') {
      throw new Error('ThreadEngineRegistry: factory function is required');
    }
    this.#instances = new Map();
    this.#factory = factory;
    this.#currentThreadId = MAIN_THREAD_ID;
  }

  /** @returns {string} */
  get currentThreadId() { return this.#currentThreadId; }

  /** Total number of registered (including terminated) instances. */
  get size() { return this.#instances.size; }

  /**
   * Get an existing instance for a thread. Returns null if not yet
   * created. Does NOT lazy-create — use ensure() for that.
   * @param {string} threadId
   */
  get(threadId) {
    return this.#instances.get(threadId) || null;
  }

  /**
   * Lazy-get-or-create an instance for a thread. If one already exists
   * and is not terminated, it is returned; if it was terminated, a new
   * one replaces it. Any `opts` are forwarded to the factory.
   *
   * @param {string} threadId
   * @param {object} [opts]
   * @returns {import('./engine-instance.js').EngineInstance}
   */
  ensure(threadId, opts) {
    if (!threadId || typeof threadId !== 'string') {
      throw new Error('ThreadEngineRegistry.ensure: threadId required');
    }
    const existing = this.#instances.get(threadId);
    if (existing && !existing.terminated) return existing;
    const instance = this.#factory(threadId, opts);
    if (!instance || typeof instance.query !== 'function') {
      throw new Error(`ThreadEngineRegistry.ensure: factory did not return an EngineInstance for ${threadId}`);
    }
    this.#instances.set(threadId, instance);
    return instance;
  }

  /**
   * Set the current thread marker. Does not lazy-create — caller must
   * ensure() if they want an instance for an unseen thread.
   * @param {string} threadId
   */
  setCurrent(threadId) {
    if (!threadId || typeof threadId !== 'string') {
      throw new Error('ThreadEngineRegistry.setCurrent: threadId required');
    }
    this.#currentThreadId = threadId;
  }

  /**
   * List all non-terminated instances. The order is insertion order.
   * @returns {Array<import('./engine-instance.js').EngineInstance>}
   */
  listActive() {
    const out = [];
    for (const inst of this.#instances.values()) {
      if (!inst.terminated) out.push(inst);
    }
    return out;
  }

  /**
   * All instances including terminated ones (for inspection / tests).
   * @returns {Array<import('./engine-instance.js').EngineInstance>}
   */
  listAll() {
    return [...this.#instances.values()];
  }

  /**
   * Terminate a single thread's instance. Safe on unknown threadId.
   * @param {string} threadId
   * @returns {boolean} true if a live instance was terminated
   */
  terminate(threadId) {
    const inst = this.#instances.get(threadId);
    if (!inst) return false;
    if (inst.terminated) return false;
    inst.terminate();
    return true;
  }

  /**
   * Terminate all instances. Used on session shutdown.
   * @returns {number} count terminated
   */
  terminateAll() {
    let n = 0;
    for (const inst of this.#instances.values()) {
      if (!inst.terminated) {
        inst.terminate();
        n += 1;
      }
    }
    return n;
  }

  /**
   * Remove a thread's instance from the map entirely. The registry
   * will no longer return it from listAll / listActive. Primarily used
   * after terminate() when the caller wants a full forget.
   * @param {string} threadId
   * @returns {boolean}
   */
  delete(threadId) {
    const inst = this.#instances.get(threadId);
    if (!inst) return false;
    if (!inst.terminated) inst.terminate();
    return this.#instances.delete(threadId);
  }
}

/**
 * Build a registry whose factory constructs full Engine instances using
 * a shared dependency bag. This is the production entry point used by
 * session.js:
 *
 *   const registry = createThreadEngineRegistry({
 *     adapter, trace, config, conversationStore, memoryStore,
 *     toolRegistry, skillManager, mcpManager, yeaftDir,
 *   });
 *   const inst = registry.ensure(threadId);
 *   for await (const event of inst.query({ prompt })) { ... }
 *
 * @param {object} deps — shared session deps (see session.js §9)
 * @returns {ThreadEngineRegistry}
 */
export function createThreadEngineRegistry(deps) {
  return new ThreadEngineRegistry({
    factory: (threadId, opts = {}) => createEngineInstance({
      ...deps,
      ...opts,
      threadId,
    }),
  });
}
