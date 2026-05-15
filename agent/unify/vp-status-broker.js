/**
 * vp-status-broker.js — single source of truth for per-VP status,
 * emitted to the frontend on every transition.
 *
 * Why: the browser used to reverse-infer VP status from assistant
 * messages' `isStreaming` flag (web/stores/helpers/vp-timeline.js).
 * That flag is a UI artifact, not a state machine — whenever the
 * `result` event lands without flipping the flag (reconnect mid-turn,
 * tool window where the flag is cosmetically dropped, persisted
 * history that re-hydrates with the flag absent), the inferred
 * status drifts and can stay stuck on "streaming" forever.
 *
 * This broker owns a tiny in-memory table keyed by `(groupId, vpId)`,
 * and emits a `vp_status_changed` event each time the state really
 * changes. `vp_status_snapshot` rebuilds the table on a fresh
 * frontend (reconnect, refresh). The broker is in-memory only —
 * agent restart starts everyone at `idle`, which is the right default
 * because no turn is in flight on a fresh process either.
 *
 * State machine: see docs/notes/2026-05-15-vp-status-from-agent.md.
 *
 * Sink injection: the broker is constructed with a `send` callback so
 * it doesn't depend on the WebSocket layer directly (and so tests can
 * collect emitted events into an array without spinning up WS).
 */

/**
 * Valid status values. `error` is a terminal/sticky state that the
 * caller is expected to transition out of (the broker doesn't
 * auto-decay — that policy belongs to the caller / web bridge).
 * @type {ReadonlySet<string>}
 */
export const VALID_STATES = new Set([
  'idle',
  'typing',
  'thinking',
  'streaming',
  'tool',
  'error',
]);

/**
 * @typedef {Object} VpStatusEntry
 * @property {string} state    — one of VALID_STATES
 * @property {number} since    — ms timestamp the state was entered
 * @property {string|null} turnId
 */

/**
 * Create a broker instance.
 *
 * @param {object} opts
 * @param {(event: object) => void} opts.send  — emits events to the
 *   wire (web bridge wraps `sendUnifyEvent`). Must be synchronous; the
 *   broker calls it inline so transitions are flushed in order.
 * @param {() => number} [opts.now]            — clock, defaults to
 *   `Date.now`. Injected so tests can pin timestamps.
 */
export function createVpStatusBroker({ send, now = Date.now } = {}) {
  if (typeof send !== 'function') {
    throw new TypeError('createVpStatusBroker: `send` callback is required');
  }

  /**
   * `${groupId}::${vpId}` → VpStatusEntry. Composite key because the
   * same vpId can appear in multiple groups; we track them separately
   * so the frontend's per-group timeline reads only its slice.
   * @type {Map<string, VpStatusEntry & {groupId: string, vpId: string}>}
   */
  const table = new Map();

  const keyOf = (groupId, vpId) => `${groupId || ''}::${vpId}`;

  /**
   * Apply a state transition. Idempotent: a no-op if the requested
   * state is already current (no event emitted, no `since` rewrite).
   * Validates the input state — unknown values throw, so a typo
   * fails loudly in the agent log instead of silently breaking the
   * UI's render.
   *
   * @param {object} args
   * @param {string} args.groupId
   * @param {string} args.vpId
   * @param {string} args.state     — must be in VALID_STATES
   * @param {string|null} [args.turnId]  — optional, for non-idle states
   * @returns {boolean}             — true if a change was emitted
   */
  function transition({ groupId, vpId, state, turnId = null }) {
    if (!vpId) return false;
    if (!VALID_STATES.has(state)) {
      throw new RangeError(`vp-status-broker: invalid state '${state}'`);
    }
    const key = keyOf(groupId, vpId);
    const prev = table.get(key);
    // Dedup: same state AND same turnId means no real transition.
    // Allowing turnId to differ even at the same state lets a fresh
    // turn re-stamp `since` without spamming events.
    if (prev && prev.state === state && prev.turnId === turnId) {
      return false;
    }
    const since = now();
    const entry = { state, since, turnId, groupId: groupId || null, vpId };
    table.set(key, entry);
    send({
      type: 'vp_status_changed',
      groupId: entry.groupId,
      vpId,
      state,
      since,
      turnId,
    });
    return true;
  }

  /**
   * Convenience: force `idle` regardless of current state. Used by
   * the run-vp-turn `finally` block so a turn that ended via *any*
   * path (normal, abort, error, watchdog escalation) always settles
   * back to idle.
   */
  function settleIdle({ groupId, vpId }) {
    return transition({ groupId, vpId, state: 'idle', turnId: null });
  }

  /**
   * Build the snapshot payload. Optionally filtered by groupId.
   *
   * Filtering semantics:
   *   - `groupId === undefined` → return every row across every group.
   *     This is the all-groups broadcast used on `session_ready`.
   *   - `groupId === null`      → same as undefined. Treated as "no
   *     scope" because the wire envelope serializes `undefined` as
   *     `null` over JSON, and we want both forms to behave the same.
   *   - `groupId === '<id>'`    → only rows for that group.
   *
   * The store mirrors this semantic on the frontend (see
   * `vp_status_snapshot` handler in chat.js): scoped snapshots
   * replace just that group's slice, while null/undefined snapshots
   * replace the whole table.
   *
   * @param {string} [groupId]
   * @returns {Array<{vpId:string, state:string, since:number, turnId:string|null, groupId:string|null}>}
   */
  function snapshot(groupId) {
    const out = [];
    for (const entry of table.values()) {
      if (groupId !== undefined && groupId !== null && entry.groupId !== groupId) continue;
      out.push({
        vpId: entry.vpId,
        state: entry.state,
        since: entry.since,
        turnId: entry.turnId,
        groupId: entry.groupId,
      });
    }
    return out;
  }

  /**
   * Emit a `vp_status_snapshot` to the wire. Pulls from `snapshot()`
   * so the wire shape stays consistent with the in-memory table.
   *
   * Wire envelope: `{ type, groupId, statuses }` where `groupId` is
   * `null` when unscoped (frontend uses null to mean "replace the
   * whole table"). See `snapshot()` JSDoc for the scoping contract.
   */
  function broadcastSnapshot({ groupId } = {}) {
    send({
      type: 'vp_status_snapshot',
      groupId: groupId === undefined ? null : groupId,
      statuses: snapshot(groupId),
    });
  }

  /**
   * Drop an entry — e.g. when a VP is removed from a group. Without
   * this, a deleted VP would stay in the snapshot forever and
   * re-appear on the frontend at every reconnect.
   */
  function forget({ groupId, vpId }) {
    table.delete(keyOf(groupId, vpId));
  }

  /**
   * Wipe the in-memory table. Called from `resetUnifySession` on the
   * agent side so a forced session reset doesn't leave the broker
   * holding rows for VPs whose engines/inboxes have been cleared. The
   * post-reset `broadcastSnapshot` then emits an empty table, and the
   * frontend's mirror clears in lockstep.
   *
   * Distinct from `__testReset`: this is production code path, named
   * accordingly. `__testReset` stays for tests that mutate broker
   * state across describe-blocks.
   */
  function reset() {
    table.clear();
  }

  /**
   * Wipe everything (only used by tests; agent runtime keeps the
   * broker alive for the whole process).
   */
  function __testReset() {
    table.clear();
  }

  return {
    transition,
    settleIdle,
    snapshot,
    broadcastSnapshot,
    forget,
    reset,
    __testReset,
  };
}
