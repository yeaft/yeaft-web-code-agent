/**
 * task-message.js — R6 §Δ28 / §Δ31.6 task-scoped direct messaging.
 *
 * Replaces the withdrawn R3 `unify_task_private_chat` event with a simple
 * echo-able `task_message` pair:
 *
 *   inbound  (web → agent):  `unify_task_message`
 *     { type, groupId, taskId, vpId, text, mentions?, replyTo?, requestId? }
 *   outbound (agent → web):  `task_message`
 *     { type, groupId, taskId, vpId, msgId, text, mentions, replyTo,
 *       ts, requestId? }
 *
 * This module owns only the *wire adapter* — the payload is validated,
 * stamped with msgId + ts, and broadcast back so the sender's UI and any
 * other connected views converge on the same record. Persistence + task
 * ACL enforcement are deliberately deferred to task-334l (per PM dispatch:
 * "user_memory_* 实际 ingestion 归 334l"); the parallel task-private
 * storage hook follows the same phasing.
 *
 * Invariants:
 *   • Never throws on the WS hot path — bad payloads reply with a
 *     `task_message_rejected` event carrying a stable `code` string for
 *     UI i18n (mirrors the vp_crud_result contract from 334-ui-g).
 *   • The outbound event field order and keys are considered wire-frozen
 *     per R6 §Δ31.6 table; additive fields only in future slices.
 */

import { nextMsgId, isValidVpId } from './groups/ids.js';

/** Known `reject` codes — kept stable so 334-ui-* can key i18n on them. */
export const TASK_MESSAGE_REJECT_CODES = Object.freeze({
  MISSING_GROUP_ID: 'missing_group_id',
  MISSING_TASK_ID: 'missing_task_id',
  MISSING_VP_ID: 'missing_vp_id',
  INVALID_VP_ID: 'invalid_vp_id',
  EMPTY_TEXT: 'empty_text',
  TEXT_TOO_LONG: 'text_too_long',
});

/** Soft body cap — matches the shard-entry cap used elsewhere in R6 (§Δ26.3). */
export const MAX_TEXT_LENGTH = 16_384;

/**
 * Pure validator. Returns `{ ok: true, payload }` or `{ ok: false, code }`.
 * No IO, no clock reads — safe to unit-test in isolation.
 *
 * @param {any} msg — raw WS message from the web client
 */
export function validateTaskMessage(msg) {
  if (!msg || typeof msg !== 'object') {
    return { ok: false, code: TASK_MESSAGE_REJECT_CODES.MISSING_GROUP_ID };
  }
  const { groupId, taskId, vpId, text } = msg;
  if (!groupId || typeof groupId !== 'string') {
    return { ok: false, code: TASK_MESSAGE_REJECT_CODES.MISSING_GROUP_ID };
  }
  if (!taskId || typeof taskId !== 'string') {
    return { ok: false, code: TASK_MESSAGE_REJECT_CODES.MISSING_TASK_ID };
  }
  if (!vpId || typeof vpId !== 'string') {
    return { ok: false, code: TASK_MESSAGE_REJECT_CODES.MISSING_VP_ID };
  }
  // Allow the reserved `user` sentinel as a speaker here — tasks can have
  // human-user messages alongside VP messages. Any other vpId must pass
  // the full shape check (rejects `all`, `system`, pure digits, etc.).
  if (vpId !== 'user' && !isValidVpId(vpId)) {
    return { ok: false, code: TASK_MESSAGE_REJECT_CODES.INVALID_VP_ID };
  }
  if (typeof text !== 'string' || text.length === 0) {
    return { ok: false, code: TASK_MESSAGE_REJECT_CODES.EMPTY_TEXT };
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return { ok: false, code: TASK_MESSAGE_REJECT_CODES.TEXT_TOO_LONG };
  }

  const mentions = Array.isArray(msg.mentions)
    ? msg.mentions.filter(m => typeof m === 'string' && m.length > 0).slice(0, 32)
    : [];
  const replyTo = typeof msg.replyTo === 'string' && msg.replyTo.length > 0
    ? msg.replyTo
    : null;

  return {
    ok: true,
    payload: { groupId, taskId, vpId, text, mentions, replyTo },
  };
}

/**
 * Build the outbound `task_message` event from a validated payload.
 * Exposed separately so tests can snapshot the wire shape without
 * needing a live send fn.
 *
 * @param {{groupId:string,taskId:string,vpId:string,text:string,mentions:string[],replyTo:?string}} payload
 * @param {{now?:()=>number, msgId?:()=>string, requestId?:string}} [opts]
 */
export function buildTaskMessageEvent(payload, opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const mkId = typeof opts.msgId === 'function' ? opts.msgId : nextMsgId;
  const evt = {
    type: 'task_message',
    groupId: payload.groupId,
    taskId: payload.taskId,
    vpId: payload.vpId,
    msgId: mkId(),
    text: payload.text,
    mentions: payload.mentions,
    replyTo: payload.replyTo,
    ts: now(),
  };
  if (opts.requestId) evt.requestId = opts.requestId;
  return evt;
}

/**
 * Build the outbound `task_message_rejected` event.
 * @param {string} code — one of TASK_MESSAGE_REJECT_CODES
 * @param {any} msg — original inbound msg (for requestId echo)
 */
export function buildTaskMessageRejected(code, msg) {
  const evt = { type: 'task_message_rejected', code };
  if (msg && typeof msg.requestId === 'string') evt.requestId = msg.requestId;
  if (msg && typeof msg.groupId === 'string') evt.groupId = msg.groupId;
  if (msg && typeof msg.taskId === 'string') evt.taskId = msg.taskId;
  return evt;
}

/**
 * WS handler entry point. Validates, echoes, never throws.
 *
 * @param {any} msg
 * @param {(event:object)=>void} sendUnifyEvent
 * @param {{now?:()=>number, msgId?:()=>string}} [opts] — test seams
 */
export function handleUnifyTaskMessage(msg, sendUnifyEvent, opts = {}) {
  const result = validateTaskMessage(msg);
  if (!result.ok) {
    try { sendUnifyEvent(buildTaskMessageRejected(result.code, msg)); } catch { /* best-effort */ }
    return;
  }
  const requestId = msg && typeof msg.requestId === 'string' ? msg.requestId : undefined;
  const evt = buildTaskMessageEvent(result.payload, { ...opts, requestId });
  try { sendUnifyEvent(evt); } catch { /* never crash WS pipeline */ }
}
