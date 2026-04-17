/**
 * engine-instance.js — task-308 Phase 2.
 *
 * An EngineInstance binds a single `threadId` to an Engine + an independent
 * per-thread `messages` array + an independent memory scope ref. Multiple
 * EngineInstance objects can run .query() concurrently on the same unify
 * session without cross-contaminating state:
 *
 *   - The underlying Engine's query loop is a pure async generator that
 *     takes `messages` as a parameter — it holds no mutable turn state on
 *     `this` during a run, so concurrent generators cannot alias each
 *     other's conversation or tool-call arrays.
 *   - All yielded events are re-tagged with the instance's bound
 *     `threadId` (not with the global current-thread marker from the
 *     singleton ThreadStore), so the web-bridge can route them to the
 *     right pane even while several threads stream simultaneously.
 *   - `messages` is owned by the instance: user/assistant messages
 *     appended during a query are persisted to the instance's own array,
 *     not to a global.
 *
 * Memory scope: Phase 2 design doc §6 — the memory store is shared across
 * threads (one user, one brain), but the EngineInstance carries a
 * `memoryScope` ref that can later be used to namespace recall/query
 * results by thread. Today the ref is the threadId itself; downstream
 * memory adapters can opt in.
 *
 * Q2 decision (PM brief): all threads use session primaryModel. No
 * per-thread model override is accepted.
 */

import { Engine } from '../engine.js';
import { MAIN_THREAD_ID } from './store.js';

export class EngineInstance {
  /** @type {string} */
  #threadId;

  /** @type {Engine} */
  #engine;

  /** @type {Array<object>} owned per-thread conversation messages */
  #messages;

  /** @type {string} memory scope ref — today simply the threadId */
  #memoryScope;

  /** @type {boolean} */
  #terminated = false;

  /**
   * @param {{
   *   threadId: string,
   *   engine: Engine,
   *   memoryScope?: string,
   *   initialMessages?: Array<object>,
   * }} params
   */
  constructor({ threadId, engine, memoryScope, initialMessages }) {
    if (!threadId || typeof threadId !== 'string') {
      throw new Error('EngineInstance: threadId is required');
    }
    if (!engine) {
      throw new Error('EngineInstance: engine is required');
    }
    this.#threadId = threadId;
    this.#engine = engine;
    this.#memoryScope = memoryScope || threadId;
    this.#messages = Array.isArray(initialMessages) ? [...initialMessages] : [];
  }

  /** @returns {string} */
  get threadId() { return this.#threadId; }

  /** @returns {string} */
  get memoryScope() { return this.#memoryScope; }

  /** @returns {boolean} */
  get terminated() { return this.#terminated; }

  /** Number of messages recorded on this instance. */
  get messageCount() { return this.#messages.length; }

  /** Snapshot of the current messages array (copy, safe for callers). */
  get messages() { return [...this.#messages]; }

  /** Underlying Engine (for tool registration, trace access, etc.). */
  get engine() { return this.#engine; }

  /**
   * Run a query on this thread's engine. Yields events tagged with this
   * instance's bound threadId. After the run, user + assistant messages
   * are appended to the owned messages array.
   *
   * @param {object} params
   * @param {string} params.prompt
   * @param {'dream'} [params.mode]
   * @param {AbortSignal} [params.signal]
   * @yields {object} EngineEvent with { ...event, threadId }
   */
  async *query({ prompt, mode, signal }) {
    if (this.#terminated) {
      yield {
        type: 'error',
        threadId: this.#threadId,
        error: new Error(`EngineInstance(${this.#threadId}) has been terminated`),
        retryable: false,
      };
      return;
    }

    // Snapshot of messages passed to the engine; the engine treats this
    // as read-only (it builds its own conversation array internally).
    const snapshot = [...this.#messages];
    let assistantText = '';
    const assistantToolCalls = [];

    for await (const event of this.#engine.query({ prompt, mode, messages: snapshot, signal })) {
      // Re-tag every event with the bound threadId. Non-object events
      // (shouldn't happen — all engine events are objects) are passed
      // through untouched.
      const tagged = event && typeof event === 'object'
        ? { ...event, threadId: this.#threadId }
        : event;
      yield tagged;

      // Track assistant reply to persist after stream ends. Only tag the
      // natural stream types — not our injected turn_start/turn_end.
      if (event && typeof event === 'object') {
        if (event.type === 'text_delta' && typeof event.text === 'string') {
          assistantText += event.text;
        } else if (event.type === 'tool_call') {
          assistantToolCalls.push({ id: event.id, name: event.name, input: event.input });
        }
      }
    }

    // Append user + assistant to the owned messages array so subsequent
    // queries on this thread carry conversational context.
    this.#messages.push({ role: 'user', content: prompt });
    const assistantMsg = { role: 'assistant', content: assistantText };
    if (assistantToolCalls.length > 0) {
      assistantMsg.toolCalls = assistantToolCalls;
    }
    this.#messages.push(assistantMsg);
  }

  /**
   * Terminate this engine instance. Further .query() calls will emit an
   * error event and return early. Does NOT tear down the underlying
   * Engine (engines are shared across instances via composition from
   * the registry — only the instance's per-thread state is dropped).
   */
  terminate() {
    this.#terminated = true;
    this.#messages = [];
  }

  /**
   * Reset the owned messages array. Used by the registry for crash
   * recovery / test cleanup. Does NOT terminate the instance.
   * @param {Array<object>} [messages=[]]
   */
  resetMessages(messages = []) {
    this.#messages = Array.isArray(messages) ? [...messages] : [];
  }
}

/**
 * Factory helper — builds an EngineInstance that owns a fresh Engine,
 * sharing the given dependency bag across all threads of a session.
 *
 * @param {{
 *   threadId: string,
 *   adapter: object,
 *   trace: object,
 *   config: object,
 *   conversationStore?: object,
 *   memoryStore?: object,
 *   toolRegistry?: object,
 *   skillManager?: object,
 *   mcpManager?: object,
 *   yeaftDir?: string,
 *   initialMessages?: Array<object>,
 * }} deps
 * @returns {EngineInstance}
 */
export function createEngineInstance(deps) {
  const {
    threadId,
    adapter,
    trace,
    config,
    conversationStore,
    memoryStore,
    toolRegistry,
    skillManager,
    mcpManager,
    yeaftDir,
    initialMessages,
  } = deps;
  const engine = new Engine({
    adapter,
    trace,
    config,
    conversationStore,
    memoryStore,
    toolRegistry,
    skillManager,
    mcpManager,
    yeaftDir,
  });
  return new EngineInstance({
    threadId: threadId || MAIN_THREAD_ID,
    engine,
    memoryScope: threadId || MAIN_THREAD_ID,
    initialMessages,
  });
}
