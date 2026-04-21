/**
 * user-memory.js — R6 §Δ29 user-memory WS event skeleton.
 *
 * PLACEHOLDER ONLY. Actual ingestion / shard write / cross-task recall
 * is owned by task-334l. This file reserves three event names on the
 * wire + acknowledges the request so the web client can ship its
 * emitter code without a dependency-cycle on 334l's storage layer.
 *
 * Wire shapes (frozen by R6 §Δ31.6 table; additive fields only):
 *
 *   inbound  (web → agent):  `unify_user_memory_write`
 *     { type, text, tags?, sourceRef?, requestId? }
 *
 *   outbound (agent → web):  `user_memory_updated`
 *     { type, entryId?, reason: 'accepted'|'deferred'|'noop',
 *       requestId?, pending?: boolean }
 *
 *   outbound (agent → web):  `user_memory_removed`
 *     { type, entryId, requestId? }
 *
 * Current behaviour: every write is replied with `user_memory_updated`
 * carrying `reason: 'deferred'` and `pending: true` — the frontend
 * treats this as "queued but not yet persisted" and keeps the toast in
 * a muted state. 334l will flip the reason to `'accepted'` with a
 * concrete `entryId` once the ingestion pipeline lands.
 *
 * No removal path is offered yet (would require the storage layer to
 * have produced entryIds first); the handler is exported as a named
 * stub so the router can wire it without a second edit when 334l ships.
 */

/** @type {(event:object)=>void | null} */
let _sendUnifyEvent = null;

/**
 * Install a send fn. Called once during session init from web-bridge.js.
 * Exposed so tests can swap in a collector without spinning up a session.
 */
export function setUserMemorySender(fn) {
  _sendUnifyEvent = (typeof fn === 'function') ? fn : null;
}

/**
 * WS handler: `unify_user_memory_write`.
 *
 * Validates the minimum shape (non-empty string `text`) and replies with
 * a `user_memory_updated` ack carrying `pending: true`. Never throws.
 *
 * @param {any} msg
 * @param {(event:object)=>void} [sendUnifyEvent] — optional override
 *   (falls back to the module-level sender installed via setUserMemorySender)
 */
export function handleUnifyUserMemoryWrite(msg, sendUnifyEvent) {
  const send = sendUnifyEvent || _sendUnifyEvent;
  if (!send) return;

  const requestId = msg && typeof msg.requestId === 'string' ? msg.requestId : undefined;
  const text = msg && typeof msg.text === 'string' ? msg.text : '';

  if (!text || text.length === 0) {
    try {
      send({
        type: 'user_memory_updated',
        reason: 'noop',
        pending: false,
        ...(requestId ? { requestId } : {}),
      });
    } catch { /* best-effort */ }
    return;
  }

  // Placeholder — 334l replaces this with real ingestion.
  try {
    send({
      type: 'user_memory_updated',
      reason: 'deferred',
      pending: true,
      ...(requestId ? { requestId } : {}),
    });
  } catch { /* best-effort */ }
}

/**
 * WS handler: `unify_user_memory_remove` (skeleton).
 *
 * Until 334l lands we have no entries to remove; reply with a noop
 * `user_memory_updated` so the UI can clear its toast.
 */
export function handleUnifyUserMemoryRemove(msg, sendUnifyEvent) {
  const send = sendUnifyEvent || _sendUnifyEvent;
  if (!send) return;

  const requestId = msg && typeof msg.requestId === 'string' ? msg.requestId : undefined;
  const entryId = msg && typeof msg.entryId === 'string' ? msg.entryId : null;

  try {
    send({
      type: 'user_memory_removed',
      entryId,
      pending: true, // 334l will flip once real removal lands
      ...(requestId ? { requestId } : {}),
    });
  } catch { /* best-effort */ }
}
