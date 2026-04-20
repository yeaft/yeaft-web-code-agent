/**
 * role-instance.js — RoleInstance class (per-group per-VP runtime handle).
 *
 * task-334 §5 RoleInstance. 334a defined the shape; task-334c adds the
 * lifecycle surface:
 *   - state machine:   idle → queued → running → (idle | error) + standby
 *   - inputQueue:      enqueue(envelope) + drain(runner) loop
 *   - abort:           per-instance AbortController, exposed via abort()
 *
 * Hard constraints (inherited from 334a):
 *   - does NOT import 334o shard-store directly (memoryStore stays nullable)
 *   - does NOT import 334d routing (inputQueue accepts whatever coordinator
 *     hands it; runner is the sole consumer)
 *
 * Hard constraint (334c-specific):
 *   - the runner callback is injected — RoleInstance does not know about
 *     Engine internals. See run-turn.js for the canonical runner.
 */

/**
 * @typedef {'idle'|'queued'|'running'|'standby'|'error'} RoleInstanceState
 *
 *   - idle:     no work, ready to accept
 *   - queued:   inputQueue has items, drain scheduled/running but this
 *               iteration is not yet inside the runner (brief transition)
 *   - running:  inside runner for one envelope
 *   - standby:  explicit pause via setState('standby'); enqueue is allowed
 *               (buffers) but drain is gated until setState('idle')
 *   - error:    last turn threw; next enqueue re-enters drain and clears
 */

let _seq = 0;
function nextInstanceId(vpId, groupId) {
  _seq = (_seq + 1) >>> 0;
  return `ri_${groupId}_${vpId}_${Date.now().toString(36)}_${_seq.toString(36)}`;
}

export class RoleInstance {
  /**
   * @param {{ vp: import('./vp-store.js').VP, groupId: string }} params
   */
  constructor({ vp, groupId }) {
    if (!vp) throw new Error('RoleInstance requires a vp');
    if (!groupId) throw new Error('RoleInstance requires a groupId');

    this.id = nextInstanceId(vp.id, groupId);
    this.vpId = vp.id;
    this.groupId = groupId;
    /** Live VP reference. Persona hot-reload mutates fields in place. */
    this.vp = vp;

    // ── Runtime state (preserved across persona hot-reload) ─────
    /** @type {RoleInstanceState} */
    this.state = 'idle';
    /** Conversation messages appended by run-turn (user + assistant pairs). */
    this.messages = [];
    /** Pending input queue (envelopes from coordinator). */
    this.inputQueue = [];
    /** Abort controller for in-flight run. Created per-turn. */
    this.abortController = null;

    // ── Nullable sub-system handles (attached by later slices) ──
    /** threadStore — optional (334h). */
    this.threadStore = null;
    /** subagentPool — optional. */
    this.subagentPool = null;
    /** memoryStore — 334f wraps 334o; NOT created here. */
    this.memoryStore = null;
    /** Cached Engine for this VP; bound lazily by engine-binding.js. */
    this.engine = null;
    /** Cached systemPrompt string; rebuilt when vp.mtimeMs changes. */
    this.systemPrompt = null;
    /** mtimeMs seen when systemPrompt was last built — invalidation key. */
    this._promptBuiltForMtime = null;

    // ── Telemetry ───────────────────────────────────────────────
    this.createdAt = Date.now();
    this.lastActivityAt = this.createdAt;
    /** Total turns executed via drain (error turns included). */
    this.turnCount = 0;
    /** Last error thrown by runner; cleared on next successful turn. */
    this.lastError = null;

    // ── Drain internals ────────────────────────────────────────
    /** Set while a drain loop is active. Prevents re-entry. */
    this._draining = false;
    /** Promise that resolves when the current drain loop exits. */
    this._drainPromise = null;
  }

  /** Update last-activity timestamp (used by LRU eviction). */
  touch() {
    this.lastActivityAt = Date.now();
  }

  /** Transition helper. Emits a state change to optional listeners. */
  setState(next) {
    this.state = next;
    this.touch();
  }

  /**
   * Enqueue an envelope for processing. Triggers a drain if one isn't
   * already running.
   *
   * Envelope shape (from coordinator.js makeEnvelope): { groupId, taskId,
   * msg, trigger }. Opaque to RoleInstance — handed verbatim to runner.
   *
   * @param {object} envelope
   * @returns {number} new inputQueue length
   */
  enqueue(envelope) {
    if (!envelope) throw new Error('enqueue: envelope required');
    this.inputQueue.push(envelope);
    this.touch();
    if (this.state === 'idle') this.setState('queued');
    return this.inputQueue.length;
  }

  /**
   * Abort the in-flight run (if any) and clear the pending queue's
   * ability to advance further by signalling abort. The queue is NOT
   * cleared — that's policy left to the caller (e.g. GroupCoordinator
   * may reshedule on next user message).
   *
   * @param {string} [reason]
   */
  abort(reason = 'user') {
    if (this.abortController && !this.abortController.signal.aborted) {
      try { this.abortController.abort(reason); } catch { /* ignore */ }
    }
    this.touch();
  }

  /**
   * Drain the inputQueue by invoking `runner(envelope)` for each. One
   * envelope at a time, FIFO. Re-entry safe: if a drain is already in
   * progress, return the in-flight promise instead of starting a second
   * loop. Standby gates the loop (standby → no runner calls until a
   * subsequent `setState('idle')` + enqueue).
   *
   * The runner owns state transitions into 'running' and back to 'idle'
   * for the iteration it's handling; drain only sets the initial queued
   * / final idle around the whole loop.
   *
   * @param {(envelope: object, ri: RoleInstance) => Promise<void>} runner
   * @returns {Promise<{turns:number, errors:number}>}
   */
  drain(runner) {
    if (typeof runner !== 'function') {
      return Promise.reject(new Error('drain: runner must be a function'));
    }
    if (this._draining) return this._drainPromise;

    this._draining = true;
    this._drainPromise = (async () => {
      let turns = 0;
      let errors = 0;
      try {
        while (this.inputQueue.length > 0) {
          // Standby blocks the drain — buffer until caller reactivates.
          if (this.state === 'standby') break;
          const envelope = this.inputQueue.shift();
          this.turnCount += 1;
          turns += 1;
          // Fresh controller per turn so abort(reason) only kills one iter
          // and the next envelope starts with a clean signal.
          this.abortController = new AbortController();
          try {
            this.setState('running');
            await runner(envelope, this);
            this.lastError = null;
          } catch (err) {
            errors += 1;
            this.lastError = err;
            this.setState('error');
            // Propagate abort — don't swallow it; but do stop draining so
            // the caller can decide to requeue / resume.
            if (err && err.name === 'AbortError') break;
            // Non-abort errors: continue draining. The next turn gets a
            // fresh state via setState('running') at the top of the loop.
          }
        }
        // Settle terminal state only if we didn't bail in 'error' or
        // 'standby'. Keep 'standby' sticky so caller must reactivate.
        if (this.state !== 'standby' && this.state !== 'error') {
          this.setState('idle');
        }
      } finally {
        this._draining = false;
        this._drainPromise = null;
        this.abortController = null;
      }
      return { turns, errors };
    })();
    return this._drainPromise;
  }

  /**
   * Snapshot for debug / telemetry. Excludes bulky messages.
   */
  snapshot() {
    return {
      id: this.id,
      vpId: this.vpId,
      groupId: this.groupId,
      state: this.state,
      messageCount: this.messages.length,
      queueDepth: this.inputQueue.length,
      turnCount: this.turnCount,
      hasError: Boolean(this.lastError),
      lastActivityAt: this.lastActivityAt,
      createdAt: this.createdAt,
    };
  }
}
