/**
 * intent-classifier.js — task-309 (Phase 2 Router).
 *
 * Routes an incoming user message to one of four intents relative to the
 * current set of live threads + pending tasks:
 *
 *   - 'continue'  — append to currentThreadId (default / most common)
 *   - 'interrupt' — steal focus on another LIVE thread (e.g. user replies
 *                   while another thread is mid-stream)
 *   - 'fork'      — spawn a NEW thread from the current one
 *   - 'switch'    — re-focus on a different existing thread
 *
 * ### Routing pipeline
 *
 *   1. **Explicit signal parse** (no LLM):
 *      - Prefix `@thread-<id>` → switch/interrupt that thread (direct).
 *      - Prefix `@task-<nnn>` → switch to the thread attached to that task,
 *        if any; otherwise fall through to LLM.
 *   2. **User override lookup**: if UI previously called `.override(msgId,…)`
 *      for this message, return that decision verbatim.
 *   3. **LLM classification**: one call to `primaryModel` (Q2 — router also
 *      uses primary; fast-model route disabled for this phase) with a small
 *      JSON-only prompt. Parse `{action, targetThreadId, reason}`.
 *   4. **Fallback**: on ANY exception, unknown action, or unknown
 *      targetThreadId → degrade to `continue` on the current thread and
 *      record a `router.failure` trace event.
 *
 * ### Out of scope (task-310)
 *
 *   - user_input_queue storage of pending messages.
 *   - Actual dispatch to an EngineInstance (the router just decides WHERE;
 *     task-310 owns the WHO/WHEN).
 *   - Concurrent stream flush-back semantics.
 *
 * This module only exposes `classify()` + `override()`; the caller owns the
 * registry routing after the decision is returned.
 */

/**
 * @typedef {'continue'|'interrupt'|'fork'|'switch'} RouterAction
 *
 * @typedef {Object} RouterDecision
 * @property {RouterAction} action
 * @property {string} targetThreadId — resolved thread (always defined; for
 *   'fork' this is the PARENT thread, the actual new-thread id is chosen
 *   by the caller when it creates the thread)
 * @property {string} reason — short human-readable explanation
 * @property {'explicit'|'override'|'llm'|'fallback'} [source]
 *
 * @typedef {Object} ThreadSummary — minimum info the classifier needs
 * @property {string} id
 * @property {string} [name]
 * @property {string} [goal]
 * @property {string} [status]
 *
 * @typedef {Object} PendingTask
 * @property {string} id
 * @property {string} [title]
 * @property {string} [threadId]  — attached thread, if any
 * @property {string} [status]
 *
 * @typedef {Object} ClassifyInput
 * @property {string} userMessage
 * @property {string} currentThreadId
 * @property {Array<ThreadSummary>} [allThreads]
 * @property {Array<PendingTask>} [pendingTasks]
 * @property {string} [messageId] — if provided, any stored override for this
 *   id is consulted before the LLM path
 */

const VALID_ACTIONS = ['continue', 'interrupt', 'fork', 'switch'];

/**
 * Match a leading `@thread-xxx` marker. Captures the thread id WITHOUT the
 * `@` prefix. Case-sensitive (thread ids are canonical).
 * Example matches: "@thread-main ...", "@thread-abcd1234 ..."
 */
const THREAD_PREFIX_RE = /^@(thread-[A-Za-z0-9_-]+)\b\s*/;

/**
 * Match a leading `@task-NNN` marker. Captures the task id WITHOUT the `@`.
 * Example matches: "@task-309 ...", "@task-abc ..."
 */
const TASK_PREFIX_RE = /^@(task-[A-Za-z0-9_-]+)\b\s*/;

export class IntentClassifier {
  /** @type {object} */            #adapter;
  /** @type {object} */            #trace;
  /** @type {object} */            #config;
  /** @type {Map<string, RouterDecision>} */ #overrides;

  /**
   * @param {{
   *   adapter: object,
   *   trace?: object,
   *   config: object,
   * }} deps
   */
  constructor({ adapter, trace, config } = {}) {
    if (!adapter || typeof adapter.stream !== 'function') {
      throw new Error('IntentClassifier: adapter with .stream() is required');
    }
    if (!config || typeof config !== 'object') {
      throw new Error('IntentClassifier: config is required');
    }
    this.#adapter = adapter;
    this.#trace = trace || null;
    this.#config = config;
    this.#overrides = new Map();
  }

  /**
   * Store a user correction for a specific messageId. Next `.classify()`
   * call with the matching `messageId` will return this decision verbatim
   * (and consume it, so a second call re-enters normal routing).
   *
   * Used by the UI "不对，我是问 X" affordance.
   *
   * @param {string} messageId
   * @param {{ action: RouterAction, targetThreadId: string, reason?: string }} decision
   * @returns {void}
   */
  override(messageId, decision) {
    if (!messageId || typeof messageId !== 'string') {
      throw new Error('IntentClassifier.override: messageId required');
    }
    if (!decision || !VALID_ACTIONS.includes(decision.action)) {
      throw new Error(`IntentClassifier.override: invalid action ${decision && decision.action}`);
    }
    if (!decision.targetThreadId || typeof decision.targetThreadId !== 'string') {
      throw new Error('IntentClassifier.override: targetThreadId required');
    }
    this.#overrides.set(messageId, {
      action: decision.action,
      targetThreadId: decision.targetThreadId,
      reason: decision.reason || 'user_override',
      source: 'override',
    });
  }

  /** Whether an override is currently stored for a given messageId. */
  hasOverride(messageId) {
    return this.#overrides.has(messageId);
  }

  /** Test-only / admin — drop all stored overrides. */
  clearOverrides() {
    this.#overrides.clear();
  }

  /**
   * Classify the user message into a router decision.
   *
   * Resolution order: override → explicit @prefix → LLM → fallback.
   *
   * @param {ClassifyInput} input
   * @returns {Promise<RouterDecision>}
   */
  async classify(input) {
    const {
      userMessage,
      currentThreadId,
      allThreads = [],
      pendingTasks = [],
      messageId,
    } = input || {};

    if (!userMessage || typeof userMessage !== 'string') {
      throw new Error('classify: userMessage is required');
    }
    if (!currentThreadId || typeof currentThreadId !== 'string') {
      throw new Error('classify: currentThreadId is required');
    }

    // 1. User override takes precedence over everything else.
    if (messageId && this.#overrides.has(messageId)) {
      const decision = this.#overrides.get(messageId);
      this.#overrides.delete(messageId);
      return { ...decision, source: 'override' };
    }

    // 2. Explicit signals (no LLM call).
    const explicit = this.#parseExplicit(userMessage, {
      currentThreadId, allThreads, pendingTasks,
    });
    if (explicit) return explicit;

    // 3. LLM classification (best-effort).
    try {
      const decision = await this.#classifyWithLLM({
        userMessage, currentThreadId, allThreads, pendingTasks,
      });
      return this.#validateOrFallback(decision, {
        currentThreadId, allThreads, reason: 'llm',
      });
    } catch (err) {
      this.#traceFailure(err, { userMessage, currentThreadId });
      return this.#fallback(currentThreadId, `classifier_exception: ${err.message}`);
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Explicit-signal parser
  // ──────────────────────────────────────────────────────────────

  /**
   * @param {string} msg
   * @param {{ currentThreadId: string, allThreads: Array<ThreadSummary>, pendingTasks: Array<PendingTask> }} ctx
   * @returns {RouterDecision|null}
   */
  #parseExplicit(msg, { currentThreadId, allThreads, pendingTasks }) {
    const trimmed = msg.replace(/^\s+/, '');

    // @thread-xxx
    const tm = trimmed.match(THREAD_PREFIX_RE);
    if (tm) {
      const targetId = tm[1];
      const known = allThreads.some(t => t && t.id === targetId);
      if (!known) {
        // Unknown thread — silently degrade. Record trace so ops can see it.
        this.#traceFailure(
          new Error(`unknown thread in @prefix: ${targetId}`),
          { userMessage: msg, currentThreadId },
        );
        return this.#fallback(currentThreadId, `unknown_thread:${targetId}`);
      }
      const action = targetId === currentThreadId ? 'continue' : 'switch';
      return {
        action,
        targetThreadId: targetId,
        reason: `explicit @${targetId}`,
        source: 'explicit',
      };
    }

    // @task-NNN
    const mt = trimmed.match(TASK_PREFIX_RE);
    if (mt) {
      const taskId = mt[1];
      const task = pendingTasks.find(t => t && t.id === taskId);
      if (task && task.threadId) {
        const action = task.threadId === currentThreadId ? 'continue' : 'switch';
        return {
          action,
          targetThreadId: task.threadId,
          reason: `explicit @${taskId} → ${task.threadId}`,
          source: 'explicit',
        };
      }
      // Task unknown or not attached — fall through to LLM.
      return null;
    }

    return null;
  }

  // ──────────────────────────────────────────────────────────────
  // LLM classification path
  // ──────────────────────────────────────────────────────────────

  /** Build the prompt/messages for the router LLM call. */
  #buildMessages({ userMessage, currentThreadId, allThreads, pendingTasks }) {
    const system = [
      'You are a thread-routing classifier for a multi-thread AI chat.',
      'Given the user message and current thread context, pick exactly one action:',
      "  - 'continue'  — the message belongs to the current thread",
      "  - 'interrupt' — it answers / redirects a DIFFERENT live thread",
      "  - 'fork'      — it starts a new tangent that should be its own thread",
      "  - 'switch'    — it explicitly re-focuses on another existing thread",
      '',
      'Respond with ONE LINE of JSON, nothing else:',
      '{"action":"<action>","targetThreadId":"<id>","reason":"<short>"}',
      '',
      'Rules:',
      '- For fork, set targetThreadId to the CURRENT thread (it is the parent).',
      '- For continue, set targetThreadId to the CURRENT thread.',
      '- For switch/interrupt, targetThreadId MUST be one of the known thread ids.',
      '- If uncertain, pick continue.',
    ].join('\n');

    const ctx = {
      currentThreadId,
      threads: (allThreads || []).map(t => ({
        id: t.id,
        name: t.name || '',
        goal: t.goal || '',
        status: t.status || 'active',
      })),
      pendingTasks: (pendingTasks || []).map(t => ({
        id: t.id,
        title: t.title || '',
        threadId: t.threadId || null,
      })),
    };

    const user = [
      'Context:',
      JSON.stringify(ctx),
      '',
      'User message:',
      userMessage,
    ].join('\n');

    return { system, messages: [{ role: 'user', content: user }] };
  }

  /** @returns {Promise<RouterDecision>} */
  async #classifyWithLLM({ userMessage, currentThreadId, allThreads, pendingTasks }) {
    const { system, messages } = this.#buildMessages({
      userMessage, currentThreadId, allThreads, pendingTasks,
    });
    // Q2: router uses primaryModel (no fast-model split yet).
    const model = this.#config.primaryModel || this.#config.model;
    if (!model) {
      throw new Error('router: no primaryModel configured');
    }

    let text = '';
    for await (const event of this.#adapter.stream({
      model,
      system,
      messages,
      maxTokens: 256,
    })) {
      if (event && event.type === 'text_delta' && typeof event.text === 'string') {
        text += event.text;
      } else if (event && event.type === 'error') {
        throw event.error || new Error('router stream error');
      }
    }
    return parseLLMDecision(text);
  }

  // ──────────────────────────────────────────────────────────────
  // Validation & fallback
  // ──────────────────────────────────────────────────────────────

  #validateOrFallback(decision, { currentThreadId, allThreads, reason }) {
    if (!decision || !VALID_ACTIONS.includes(decision.action)) {
      this.#traceFailure(
        new Error(`invalid action from classifier: ${decision && decision.action}`),
        { currentThreadId },
      );
      return this.#fallback(currentThreadId, 'invalid_action');
    }
    const known = new Set((allThreads || []).map(t => t && t.id).filter(Boolean));
    known.add(currentThreadId);

    // For fork/continue the target MUST be the current thread parent (we
    // allow any known thread since callers may want to fork from a
    // non-current parent, but continue MUST land on current).
    if (decision.action === 'continue' && decision.targetThreadId !== currentThreadId) {
      decision.targetThreadId = currentThreadId;
    }
    if (!decision.targetThreadId || !known.has(decision.targetThreadId)) {
      this.#traceFailure(
        new Error(`unknown targetThreadId: ${decision.targetThreadId}`),
        { currentThreadId },
      );
      return this.#fallback(currentThreadId, 'unknown_target');
    }
    return {
      action: decision.action,
      targetThreadId: decision.targetThreadId,
      reason: decision.reason || reason,
      source: 'llm',
    };
  }

  /** @returns {RouterDecision} */
  #fallback(currentThreadId, reason) {
    return {
      action: 'continue',
      targetThreadId: currentThreadId,
      reason,
      source: 'fallback',
    };
  }

  #traceFailure(err, ctx) {
    if (!this.#trace || typeof this.#trace.logEvent !== 'function') return;
    try {
      this.#trace.logEvent({
        traceId: 'router',
        eventType: 'router.failure',
        eventData: {
          error: err && err.message ? err.message : String(err),
          currentThreadId: ctx && ctx.currentThreadId,
          userMessage: ctx && typeof ctx.userMessage === 'string'
            ? ctx.userMessage.slice(0, 200)
            : undefined,
        },
      });
    } catch {
      // Trace must never propagate errors into the router path.
    }
  }
}

/**
 * Parse the LLM's single-line JSON response. Tolerates a leading/trailing
 * code fence ```json ... ``` because some proxies wrap.
 *
 * @param {string} raw
 * @returns {RouterDecision}
 */
export function parseLLMDecision(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new Error('empty classifier response');
  }
  let text = raw.trim();
  // Strip ```json fences if present.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) text = fenced[1].trim();
  // Take the first { ... } block.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('no JSON object in classifier response');
  }
  const slice = text.slice(start, end + 1);
  let obj;
  try {
    obj = JSON.parse(slice);
  } catch (e) {
    throw new Error(`classifier response not valid JSON: ${e.message}`);
  }
  return {
    action: obj.action,
    targetThreadId: obj.targetThreadId,
    reason: obj.reason || '',
  };
}

/**
 * Build an IntentClassifier from session-level deps. This is the entry
 * point used by session.js to populate `session.router`.
 *
 * @param {{ adapter: object, trace?: object, config: object }} deps
 * @returns {IntentClassifier}
 */
export function createIntentClassifier(deps) {
  return new IntentClassifier(deps);
}
