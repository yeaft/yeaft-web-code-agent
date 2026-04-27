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
  async *query({ prompt, mode, signal, vpPersona, router, senderVpId, inboundEnvelope, taskId, taskMembers, groupId } = {}) {
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

    // task-fix: chat-completions protocol requires every `tool_call_id`
    // on an assistant message to be paired with a matching `role:'tool'`
    // message in history. Without this, turn N+1 sends `tool_calls`
    // orphaned from their results and OpenAI-compatible proxies return
    // `invalid_request_body: No tool output found for function call`.
    //
    // A single query may contain MULTIPLE internal iterations (assistant
    // → tools → assistant → tools → … → assistant-final). We mirror
    // engine.js's own conversationMessages structure so the same
    // interleaved pairing is preserved for subsequent turns:
    //
    //   [user, assistant(text1, toolCalls1), tool r1a, tool r1b,
    //          assistant(text2, toolCalls2), tool r2a,
    //          assistant(finalText)]
    //
    // We flush one assistant message per `turn_end` boundary and
    // append tool results as they stream in. Any assistant turn with
    // toolCalls must have all its `role:'tool'` results paired before
    // the NEXT assistant message (or placeholders — see below).
    const newMessages = [];
    let curText = '';
    let curToolCalls = [];
    let curToolResults = []; // buffered per-iteration, flushed AFTER assistant
    const seenToolResults = new Set();

    function flushAssistantTurn() {
      // Emit the assistant message for the current iteration. Preserve
      // an empty-content assistant (pure tool_calls) — some providers
      // require content:'' rather than omission. The chat-completions
      // adapter normalises either shape.
      const assistantMsg = { role: 'assistant', content: curText };
      if (curToolCalls.length > 0) {
        assistantMsg.toolCalls = curToolCalls.map(tc => ({
          id: tc.id, name: tc.name, input: tc.input,
        }));
      }
      // Skip empty / no-op flushes (can happen on pre-first-turn boundaries).
      if (curText || curToolCalls.length > 0) {
        newMessages.push(assistantMsg);
      }
      // Any buffered tool results for THIS iteration must immediately
      // follow the assistant that produced them — the adapter's history
      // serialiser pairs by order-in-history.
      for (const tr of curToolResults) newMessages.push(tr);
      // Synthesize placeholders for unmatched toolCalls (abort paths).
      for (const tc of curToolCalls) {
        if (!seenToolResults.has(tc.id)) {
          newMessages.push({
            role: 'tool',
            toolCallId: tc.id,
            content: '[tool call did not produce a result — aborted or errored before completion]',
            isError: true,
          });
          seenToolResults.add(tc.id);
        }
      }
      curText = '';
      curToolCalls = [];
      curToolResults = [];
    }

    for await (const event of this.#engine.query({ prompt, mode, messages: snapshot, signal, vpPersona, router, senderVpId, inboundEnvelope, taskId, taskMembers, groupId })) {
      // Re-tag every event with the bound threadId. Non-object events
      // (shouldn't happen — all engine events are objects) are passed
      // through untouched.
      const tagged = event && typeof event === 'object'
        ? { ...event, threadId: this.#threadId }
        : event;
      yield tagged;

      if (!event || typeof event !== 'object') continue;

      switch (event.type) {
        case 'text_delta':
          if (typeof event.text === 'string') curText += event.text;
          break;
        case 'tool_call':
          curToolCalls.push({ id: event.id, name: event.name, input: event.input });
          break;
        case 'tool_end':
          if (event.id) {
            // Mirror engine.js: tool result body is the `output` string;
            // `isError:true` is carried forward. BUFFER here — flush
            // places the assistant message FIRST, then these results,
            // so the order [assistant(toolCalls), tool r1, tool r2]
            // holds (required by OpenAI pairing rules).
            const entry = {
              role: 'tool',
              toolCallId: event.id,
              content: typeof event.output === 'string' ? event.output : String(event.output ?? ''),
            };
            if (event.isError) entry.isError = true;
            curToolResults.push(entry);
            seenToolResults.add(event.id);
          }
          break;
        case 'turn_end':
          // Boundary between internal iterations. engine.js order is:
          //   [text_delta*] [tool_call*] [tool_start tool_end]*
          //   then turn_end{stopReason:'tool_use'}   (or 'end_turn')
          // Flushing here writes the assistant message, then its
          // buffered tool results, then placeholders for any orphans.
          flushAssistantTurn();
          break;
        default:
          break;
      }
    }

    // Final safety flush — if the engine terminated without a final
    // turn_end (shouldn't happen in normal flows, but abort/error
    // paths sometimes skip it), flush whatever we have.
    if (curText || curToolCalls.length > 0 || curToolResults.length > 0) {
      flushAssistantTurn();
    }

    // Append user + all captured messages to the owned array so
    // subsequent queries on this thread carry conversational context.
    this.#messages.push({ role: 'user', content: prompt });
    for (const m of newMessages) {
      this.#messages.push(m);
    }
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
    memoryShardStore,
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
    memoryShardStore,
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
