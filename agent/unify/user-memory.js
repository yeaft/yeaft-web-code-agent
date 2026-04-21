/**
 * user-memory.js — R6 §Δ29 user-memory WS event handlers.
 *
 * Replaces the stub (task-334h) with real ingestion backed by the R6
 * shard-store. Writes land immediately in `~/.yeaft/user/memory/` with
 * a real entryId; the ack carries `reason: 'accepted'`.
 *
 * Wire shapes (frozen by R6 §Δ31.6 table; additive fields only):
 *
 *   inbound  (web → agent):  `unify_user_memory_write`
 *     { type, text, tags?, sourceRef?, requestId? }
 *
 *   outbound (agent → web):  `user_memory_updated`
 *     { type, entryId?, reason: 'accepted'|'noop',
 *       requestId?, pending?: boolean }
 *
 *   outbound (agent → web):  `user_memory_removed`
 *     { type, entryId, requestId? }
 */

import {
  getUserMemoryStore,
  writeUserMemory,
  removeUserMemory,
} from './memory/user-memory-store.js';

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
 * Validates the minimum shape (non-empty string `text`), writes to the
 * user-memory shard store, and replies with a `user_memory_updated` ack
 * carrying the real entryId. Never throws.
 *
 * @param {any} msg
 * @param {(event:object)=>void} [sendUnifyEvent] — optional override
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

  // Real ingestion via shard store.
  const store = getUserMemoryStore();
  const tags = Array.isArray(msg.tags) ? msg.tags : [];
  const sourceRef = msg.sourceRef && typeof msg.sourceRef === 'object' ? msg.sourceRef : undefined;
  const entryId = store ? writeUserMemory(store, { text, tags, sourceRef }) : null;

  try {
    send({
      type: 'user_memory_updated',
      reason: entryId ? 'accepted' : 'deferred',
      pending: !entryId,
      entryId: entryId || undefined,
      ...(requestId ? { requestId } : {}),
    });
  } catch { /* best-effort */ }
}

/**
 * WS handler: `unify_user_memory_remove`.
 *
 * Removes the entry from the user-memory shard store and acks.
 */
export function handleUnifyUserMemoryRemove(msg, sendUnifyEvent) {
  const send = sendUnifyEvent || _sendUnifyEvent;
  if (!send) return;

  const requestId = msg && typeof msg.requestId === 'string' ? msg.requestId : undefined;
  const entryId = msg && typeof msg.entryId === 'string' ? msg.entryId : null;

  const store = getUserMemoryStore();
  const removed = entryId && store ? removeUserMemory(store, entryId) : false;

  try {
    send({
      type: 'user_memory_removed',
      entryId,
      pending: !removed,
      ...(requestId ? { requestId } : {}),
    });
  } catch { /* best-effort */ }
}
