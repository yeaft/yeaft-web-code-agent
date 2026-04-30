/**
 * web-bridge.js — Bridge between web UI and Yeaft Unify Engine.
 *
 * H2.f.2: collapsed to a single-conversation bridge. The pre-H2 multi-thread
 * routing model is gone — there is one engine, one conversation, one
 * AbortController, one flat message history. The wire protocol drops
 * `threadId` from outgoing events; frontend reads them as a single stream.
 *
 * Translates Engine events into claude_output-format messages so the
 * frontend can fully reuse the standard Chat rendering pipeline
 * (MessageList, AssistantTurn, ToolLine, AskCard, waiting cat, etc.).
 *
 * task-330c lint guard:
 *   ⚠️ DO NOT introduce greedy `text.replace(/---ROUTE---[\s\S]*$/g, '')`
 *      style strips on incoming/outgoing message bodies. Crew ROUTE
 *      stripping is owned EXCLUSIVELY by `agent/crew/routing.js`
 *      `parseRoutes()` which returns `{routes, displayBody}` with exact
 *      ranges removed.
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadSession } from './session.js';
import { sendToServer } from '../connection/buffer.js';
import ctx from '../context.js';
import { handleVpSubscribe } from './vp/vp-bridge.js';
import { createVp, updateVp, deleteVp, readVp, VpCrudError } from './vp/vp-crud.js';
import { scanVpLibrary } from './vp/vp-store.js';
import { createRouter } from './routing/router.js';
import { handleUnifyFeatureMessage as _handleUnifyFeatureMessage } from './feature-message.js';
import {
  GroupCrudError,
  createGroupFromSpec,
  renameGroup,
  archiveGroup,
  deleteGroup,
  purgeArchivedGroups,
  addMember,
  removeMember,
  setGroupDefaultVp,
  snapshotGroups,
} from './groups/group-crud.js';
import { openGroup, loadGroupMeta } from './groups/group-store.js';
import { createCoordinator } from './groups/coordinator.js';
import { seedDefaultGroup } from './groups/seed-default.js';
import {
  shouldCompactHistory,
  compactHistory,
} from './history-compact.js';

/** @type {import('./session.js').Session | null} */
let session = null;

/**
 * Single in-flight AbortController. A new user message cancels the prior
 * round (if any). H2.f.2: replaces the per-thread Map.
 * @type {AbortController | null}
 */
let currentAbortCtrl = null;

/**
 * Per-VP-turn AbortControllers. Maps `turnId` → `AbortController`.
 * Each VP-turn in a fan-out gets its own controller so it can be stopped
 * independently (per-VP Stop button). `handleUnifyAbortTurn` looks up by
 * turnId to abort a single VP. `handleUnifyAbortAll` iterates and aborts all.
 * @type {Map<string, AbortController>}
 */
const turnAbortCtrls = new Map();

/** Query timeout in ms — abort if LLM doesn't respond within this window */
const QUERY_TIMEOUT_MS = 120_000;

/** Virtual conversationId for the Unify session */
let unifyConversationId = null;

/** task-334-followup-batch-b: stored unsubscribe fn from VP subscribe,
 *  called on session reset to prevent stale subscriber leaks. */
let _vpUnsubscribe = null;

/**
 * Flat conversation history for engine context continuity. H2.f.2: replaces
 * the per-thread Map. Cleared on session reset or by a `consolidate` event.
 * @type {Array<{role:'user'|'assistant'|'tool', content:string|Array, toolCalls?:Array, toolCallId?:string, isError?:boolean}>}
 */
let conversationMessages = [];

/**
 * Restore conversation history from persisted store. Accepts `role:'tool'`
 * messages and preserves `toolCalls`/`toolCallId` so the next chat-completions
 * serialization includes paired tool messages (avoids "No tool output found
 * for function call" 400s).
 *
 * @param {Array<object>} recent — output of conversationStore.loadRecent()
 */
function restoreHistoryFromRecent(recent) {
  conversationMessages = [];
  for (const m of recent) {
    if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'tool') continue;
    const entry = { role: m.role, content: m.content };
    if (m.toolCallId) entry.toolCallId = m.toolCallId;
    if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
      entry.toolCalls = m.toolCalls.map(tc => ({
        id: tc.id,
        name: tc.name,
        input: tc.input,
      }));
    }
    if (m.isError) entry.isError = true;
    conversationMessages.push(entry);
  }
}

/** Whether we've already sent a permission warning to the UI */
let _permissionDiagnosticSent = false;

function isPermissionErrorMsg(msg) {
  if (!msg) return false;
  const lower = msg.toLowerCase();
  return lower.includes('eacces') || lower.includes('eperm') || lower.includes('permission denied');
}

/**
 * Send a unify_output message carrying claude_output-format data.
 * Envelope fields: conversationId, groupId, vpId, turnId — the last two
 * let the frontend route incremental deltas to the correct per-VP message block.
 */
function sendUnifyOutput(data, { groupId, vpId, turnId } = {}) {
  sendToServer({
    type: 'unify_output',
    conversationId: unifyConversationId,
    ...(groupId ? { groupId } : {}),
    ...(vpId ? { vpId } : {}),
    ...(turnId ? { turnId } : {}),
    data,
  });
}

/** Send a unify_output event (non-claude_output metadata). */
function sendUnifyEvent(event, { groupId, vpId, turnId } = {}) {
  sendToServer({
    type: 'unify_output',
    conversationId: unifyConversationId,
    ...(groupId ? { groupId } : {}),
    ...(vpId ? { vpId } : {}),
    ...(turnId ? { turnId } : {}),
    event,
  });
}

export function handleUnifyVpSubscribe(_msg) {
  if (_vpUnsubscribe) {
    try { _vpUnsubscribe(); } catch { /* ignore */ }
    _vpUnsubscribe = null;
  }
  _vpUnsubscribe = handleVpSubscribe(sendUnifyEvent);
}

/**
 * VP CRUD from the web client. See historic doc for full message shapes.
 */
function sendVpCrudResult(payload) {
  sendUnifyEvent({ type: 'vp_crud_result', ...payload });
}

export function handleUnifyVpCreate(msg) {
  const requestId = msg && msg.requestId;
  const payload = msg && msg.payload;
  try {
    const { vpId } = createVp(payload || {});
    sendVpCrudResult({ op: 'create', requestId, ok: true, vpId });
  } catch (err) {
    sendVpCrudResult({
      op: 'create',
      requestId,
      ok: false,
      error: {
        code: err instanceof VpCrudError ? err.code : 'unknown',
        vpId: err && err.vpId,
        message: err && err.message,
      },
    });
  }
}

export function handleUnifyVpUpdate(msg) {
  const requestId = msg && msg.requestId;
  const payload = msg && msg.payload;
  try {
    const { vpId } = updateVp(payload || {});
    sendVpCrudResult({ op: 'update', requestId, ok: true, vpId });
  } catch (err) {
    sendVpCrudResult({
      op: 'update',
      requestId,
      ok: false,
      error: {
        code: err instanceof VpCrudError ? err.code : 'unknown',
        vpId: err && err.vpId,
        message: err && err.message,
      },
    });
  }
}

export function handleUnifyVpDelete(msg) {
  const requestId = msg && msg.requestId;
  const vpId = msg && msg.vpId;
  try {
    deleteVp(vpId);
    sendVpCrudResult({ op: 'delete', requestId, ok: true, vpId });
  } catch (err) {
    sendVpCrudResult({
      op: 'delete',
      requestId,
      ok: false,
      error: {
        code: err instanceof VpCrudError ? err.code : 'unknown',
        vpId: err && err.vpId,
        message: err && err.message,
      },
    });
  }
}

export function handleUnifyFeatureMessage(msg) {
  _handleUnifyFeatureMessage(msg, sendUnifyEvent);
}

export function handleUnifyVpRead(msg) {
  const requestId = msg && msg.requestId;
  const vpId = msg && msg.vpId;
  const vp = readVp(vpId);
  if (!vp) {
    sendVpCrudResult({
      op: 'read',
      requestId,
      ok: false,
      error: { code: 'not_found', vpId },
    });
    return;
  }
  sendVpCrudResult({ op: 'read', requestId, ok: true, vpId, vp });
}

/**
 * Group CRUD wired to WS events.
 */
function sendGroupCrudResult(payload) {
  sendUnifyEvent({ type: 'group_crud_result', ...payload });
}

function sendGroupSnapshotBroadcast() {
  try {
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    if (!yeaftDir) return;
    const groups = snapshotGroups(yeaftDir);
    sendUnifyEvent({ type: 'group_list_updated', groups });
  } catch (err) {
    console.warn('[Unify] sendGroupSnapshotBroadcast failed:', err?.message || err);
  }
}

function sendGroupRosterChanged(group) {
  if (!group) return;
  sendUnifyEvent({
    type: 'group_roster_changed',
    groupId: group.id,
    name: group.name,
    roster: group.roster,
    defaultVpId: group.defaultVpId,
  });
}

function groupErrorPayload(err) {
  return {
    code: err instanceof GroupCrudError ? err.code : 'unknown',
    groupId: err && err.groupId,
    message: err && err.message,
  };
}

export function handleUnifyListGroups(msg) {
  const requestId = msg && msg.requestId;
  try {
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    const groups = snapshotGroups(yeaftDir);
    sendGroupCrudResult({ op: 'list', requestId, ok: true, groups });
  } catch (err) {
    sendGroupCrudResult({ op: 'list', requestId, ok: false, error: groupErrorPayload(err) });
  }
}

export function handleUnifyCreateGroup(msg) {
  const requestId = msg && msg.requestId;
  const payload = (msg && msg.payload) || {};
  try {
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    const group = createGroupFromSpec(yeaftDir, payload);
    sendGroupCrudResult({ op: 'create', requestId, ok: true, group });
    sendGroupSnapshotBroadcast();
  } catch (err) {
    sendGroupCrudResult({ op: 'create', requestId, ok: false, error: groupErrorPayload(err) });
  }
}

export function handleUnifyRenameGroup(msg) {
  const requestId = msg && msg.requestId;
  const groupId = msg && msg.groupId;
  const name = msg && msg.name;
  try {
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    const group = renameGroup(yeaftDir, groupId, name);
    sendGroupCrudResult({ op: 'rename', requestId, ok: true, group });
    sendGroupSnapshotBroadcast();
  } catch (err) {
    sendGroupCrudResult({ op: 'rename', requestId, ok: false, error: groupErrorPayload(err) });
  }
}

export function handleUnifyArchiveGroup(msg) {
  const requestId = msg && msg.requestId;
  const groupId = msg && msg.groupId;
  try {
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    const result = archiveGroup(yeaftDir, groupId);
    sendGroupCrudResult({ op: 'archive', requestId, ok: true, groupId: result.groupId });
    sendGroupSnapshotBroadcast();
  } catch (err) {
    sendGroupCrudResult({ op: 'archive', requestId, ok: false, error: groupErrorPayload(err) });
  }
}

export function handleUnifyDeleteGroup(msg) {
  const requestId = msg && msg.requestId;
  const groupId = msg && msg.groupId;
  try {
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    const result = deleteGroup(yeaftDir, groupId);
    sendGroupCrudResult({ op: 'delete', requestId, ok: true, groupId: result.groupId });
    sendGroupSnapshotBroadcast();
  } catch (err) {
    sendGroupCrudResult({ op: 'delete', requestId, ok: false, error: groupErrorPayload(err) });
  }
}

export function handleUnifyAddMember(msg) {
  const requestId = msg && msg.requestId;
  const groupId = msg && msg.groupId;
  const vpId = msg && msg.vpId;
  try {
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    const group = addMember(yeaftDir, groupId, vpId);
    sendGroupCrudResult({ op: 'add_member', requestId, ok: true, group });
    sendGroupRosterChanged(group);
  } catch (err) {
    sendGroupCrudResult({ op: 'add_member', requestId, ok: false, error: groupErrorPayload(err) });
  }
}

export function handleUnifyRemoveMember(msg) {
  const requestId = msg && msg.requestId;
  const groupId = msg && msg.groupId;
  const vpId = msg && msg.vpId;
  try {
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    const group = removeMember(yeaftDir, groupId, vpId);
    sendGroupCrudResult({ op: 'remove_member', requestId, ok: true, group });
    sendGroupRosterChanged(group);
  } catch (err) {
    sendGroupCrudResult({ op: 'remove_member', requestId, ok: false, error: groupErrorPayload(err) });
  }
}

export function handleUnifySetDefaultVp(msg) {
  const requestId = msg && msg.requestId;
  const groupId = msg && msg.groupId;
  const vpId = msg && msg.vpId;
  try {
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    const group = setGroupDefaultVp(yeaftDir, groupId, vpId);
    sendGroupCrudResult({ op: 'set_default_vp', requestId, ok: true, group });
    sendGroupRosterChanged(group);
  } catch (err) {
    sendGroupCrudResult({ op: 'set_default_vp', requestId, ok: false, error: groupErrorPayload(err) });
  }
}

/**
 * Install the dream pipeline progress sink and runtime settings bridge.
 * H2.f.2: dropped the threadStore-related setters (autoArchiveIdleDays,
 * maxConcurrentThreads). Only the dream sink remains.
 *
 * @param {import('./session.js').Session} s
 */
export function installUnifyRuntimeBridge(s) {
  if (!s) return;

  // Forward dream pipeline progress events to the web debug panel.
  s._dreamProgressSink = (evt) => {
    try {
      sendUnifyEvent({ type: 'dream_progress', ...evt });
    } catch { /* never let event delivery throw */ }
  };

  ctx.unifyRuntimeSettings = {
    // No multi-thread settings to surface anymore. Stub for back-compat
    // with message-router's update_unify_settings branch — assignments are
    // accepted but ignored.
    get maxConcurrentThreads() { return null; },
    set maxConcurrentThreads(_v) { /* deprecated, ignored */ },
    get autoArchiveIdleDays() { return 0; },
    set autoArchiveIdleDays(_v) { /* deprecated, ignored */ },
  };
}

/**
 * Handle a single engine event unwrapped from an `engine_event` envelope.
 * H2.f.2: no longer stamps a threadId on outgoing claude_output frames.
 *
 * @param {object} event — engine event (text_delta / tool_call / …)
 * @param {{assistantTextParts:string[], toolCallsAccum:Array, toolResultsAccum:Array, resetQueryTimer:Function, groupId?:string, vpId?:string, turnId?:string}} hctx
 */
function handleEngineEvent(event, hctx) {
  hctx.resetQueryTimer();
  const envelope = { groupId: hctx.groupId, vpId: hctx.vpId, turnId: hctx.turnId };

  switch (event.type) {
    case 'text_delta':
      hctx.assistantTextParts.push(event.text);
      sendUnifyOutput({
        type: 'assistant',
        message: { content: [{ type: 'text', text: event.text }] },
      }, envelope);
      break;

    case 'thinking_delta':
      sendUnifyEvent({ type: 'thinking_delta', text: event.text }, envelope);
      break;

    case 'tool_call':
      // Capture tool_call for the assistant message's toolCalls array so
      // the next turn's history pairs `tool_calls` with `role:'tool'`
      // results (fixes "No tool output found for function call" 400s).
      if (hctx.toolCallsAccum) {
        hctx.toolCallsAccum.push({
          id: event.id,
          name: event.name,
          input: event.input,
        });
      }
      // Finish any in-progress text streaming so UI shows typing dots
      sendUnifyOutput({
        type: 'assistant',
        message: { content: [] },
      }, envelope);
      sendUnifyOutput({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: event.id,
            name: event.name,
            input: event.input,
          }],
        },
      }, envelope);
      break;

    case 'tool_start':
      sendUnifyEvent({
        type: 'tool_start',
        id: event.id,
        name: event.name,
      }, envelope);
      break;

    case 'tool_end':
      if (hctx.toolResultsAccum) {
        hctx.toolResultsAccum.push({
          role: 'tool',
          toolCallId: event.id,
          content: typeof event.output === 'string' ? event.output : JSON.stringify(event.output ?? ''),
          isError: !!event.isError,
        });
      }
      sendUnifyOutput({
        type: 'user',
        tool_use_result: [{
          type: 'tool_result',
          tool_use_id: event.id,
          content: event.output || '',
          is_error: event.isError || false,
        }],
      }, envelope);
      break;

    case 'turn_start':
    case 'turn_end':
    case 'stop':
      // No UI action needed; outer loop sends the final result.
      break;

    case 'usage':
      sendUnifyEvent({
        type: 'context_usage',
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
      }, envelope);
      break;

    case 'recall':
      sendUnifyEvent({
        type: 'recall',
        entryCount: event.entryCount,
        cached: event.cached,
      }, envelope);
      break;

    case 'consolidate':
      // Engine compressed the context — clear our accumulated history.
      conversationMessages = [];
      sendUnifyEvent({
        type: 'consolidate',
        archivedCount: event.archivedCount,
        extractedCount: event.extractedCount,
      }, envelope);
      break;

    case 'fallback':
      sendUnifyEvent({
        type: 'fallback',
        from: event.from,
        to: event.to,
        reason: event.reason,
      }, envelope);
      break;

    case 'reflection':
      sendUnifyEvent({
        type: 'reflection',
        // feat-6af5f9f1 PR B: stamp turnId/loopNumber so the debug panel
        // can attach reflection cards to the matching loop.
        turnId: event.turnId || null,
        loopNumber: event.loopNumber || null,
        trigger: event.trigger,
        status: event.status,
        loopRange: event.loopRange,
        toolCount: event.toolCount,
        content: event.content,
        durationMs: event.durationMs,
        error: event.error,
      }, envelope);
      break;

    case 'turn_open':
      sendUnifyEvent({
        type: 'turn_open',
        turnId: event.turnId,
        userPrompt: event.userPrompt,
        vpId: event.vpId,
        groupId: event.groupId,
        at: event.at,
      }, envelope);
      break;

    case 'turn_close':
      sendUnifyEvent({
        type: 'turn_close',
        turnId: event.turnId,
        totalMs: event.totalMs,
        totalTokens: event.totalTokens,
        loopCount: event.loopCount,
      }, envelope);
      break;

    case 'memory_used':
      sendUnifyEvent({
        type: 'memory_used',
        turnId: event.turnId,
        loaded: event.loaded || [],
      }, envelope);
      break;

    case 'memory_adjust':
      sendUnifyEvent({
        type: 'memory_adjust',
        turnId: event.turnId,
        groupKey: event.groupKey,
        added: event.added,
        evicted: event.evicted,
        skipped: event.skipped,
        reason: event.reason,
      }, envelope);
      break;

    case 'tool_exec':
      sendUnifyEvent({
        type: 'tool_exec',
        turnId: event.turnId,
        loopNumber: event.loopNumber,
        callId: event.callId,
        name: event.name,
        durationMs: event.durationMs,
        isError: event.isError,
      }, envelope);
      break;

    case 'loop':
      // feat-6af5f9f1 PR B: replaces the old `debug_turn` event. Same
      // payload shape plus turnId + loopNumber + usage.totalTokens.
      sendUnifyEvent({
        type: 'loop',
        turnId: event.turnId,
        loopNumber: event.loopNumber,
        model: event.model,
        systemPrompt: event.systemPrompt,
        messages: event.messages,
        response: event.response,
        toolCalls: event.toolCalls,
        usage: event.usage,
        latencyMs: event.latencyMs,
        ttfbMs: event.ttfbMs,
        stopReason: event.stopReason,
        rawRequest: event.rawRequest,
        rawResponse: event.rawResponse,
      }, envelope);
      break;

    case 'error': {
      const errMsg = event.error?.message || 'Unknown error';
      if (isPermissionErrorMsg(errMsg)) {
        if (!_permissionDiagnosticSent) {
          _permissionDiagnosticSent = true;
          sendUnifyOutput({
            type: 'assistant',
            message: {
              content: [{
                type: 'text',
                text: '⚠️ Cannot write to ~/.yeaft/ directory — some features (memory, history) are unavailable. Please check directory permissions: `chmod -R u+rw ~/.yeaft/`',
              }],
            },
          }, envelope);
        }
      } else {
        sendUnifyOutput({
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: `⚠️ Error: ${errMsg}` }],
          },
        }, envelope);
      }
      break;
    }

    default:
      // Silently consume unknown events.
      break;
  }
}

/**
 * Handle a unify_group_chat message from the web UI — the SOLE Unify
 * conversation entry point.
 *
 * Contract (post-consolidation, was previously split between handleUnifyChat
 * and handleUnifyGroupChat):
 *   - Frontend ALWAYS sends `unify_group_chat`. There is no `unify_chat`.
 *   - `groupId` defaults to `'grp_default'` if missing — Unify is a single
 *     conversation backed by the default group; the user is never "outside"
 *     a group.
 *   - If the group dir doesn't exist and the resolved id is `'grp_default'`,
 *     it is seeded on the fly. Any other unknown groupId surfaces an error.
 *   - Coordinator is MANDATORY (this is what guarantees ctx.router is wired
 *     so the `route_forward` tool can never trip `router_unavailable`).
 *   - No legacy "no-group" fallback paths — they were the source of the
 *     router_unavailable bug fixed in v0.1.671.
 */
export async function handleUnifyGroupChat(msg) {
  if (!msg || typeof msg !== 'object') return;
  const { text } = msg;
  if (!text?.trim()) return;
  const mentions = Array.isArray(msg.mentions) ? msg.mentions : [];
  const groupId = (typeof msg.groupId === 'string' && msg.groupId.trim())
    ? msg.groupId.trim()
    : 'grp_default';

  // Entry gate: if a compact is in flight from the previous turn,
  // wait for it to finish before reading conversationMessages. Compact
  // runs at turn END (post-fanout) so it does not block the user's
  // current message latency, but a fast double-send from the user must
  // not race with the swap.
  if (_compactInFlight) {
    try { await _compactInFlight; } catch { /* first caller logs */ }
  }

  // yeaftDir is a hard prerequisite for both session boot and group seeding;
  // validate BEFORE booting so a misconfigured agent doesn't leave a zombie
  // session lying around.
  const yeaftDir = ctx.CONFIG?.yeaftDir;
  if (!yeaftDir) {
    sendUnifyOutput({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '⚠️ Unify session error: no yeaft directory configured.' }] },
    }, { groupId });
    sendUnifyOutput({ type: 'result', result_text: '' }, { groupId });
    return;
  }

  await ensureSessionLoaded();

  // Cancel any prior in-flight dispatch BEFORE we fan out.
  if (currentAbortCtrl && !currentAbortCtrl.signal.aborted) {
    try { currentAbortCtrl.abort(); } catch { /* best-effort */ }
  }
  // Also abort any lingering per-VP controllers from the prior dispatch.
  for (const ctrl of turnAbortCtrls.values()) {
    try { if (!ctrl.signal.aborted) ctrl.abort(); } catch { /* best-effort */ }
  }
  turnAbortCtrls.clear();

  const dispatchAbortCtrl = new AbortController();
  currentAbortCtrl = dispatchAbortCtrl;

  // Open the group; seed grp_default on the fly if absent. Track
  // seedFailed separately so a seed crash surfaces a different message
  // than a genuinely-missing group.
  let groupHandle = null;
  let seedFailed = false;
  try {
    const root = join(yeaftDir, 'groups');
    const dir = join(root, groupId);
    if (existsSync(dir) && loadGroupMeta(dir)) {
      groupHandle = openGroup(root, groupId);
    } else if (groupId === 'grp_default') {
      try {
        const seeded = seedDefaultGroup(yeaftDir, {});
        groupHandle = seeded.group;
      } catch (seedErr) {
        seedFailed = true;
        console.warn('[Unify] unify_group_chat: seedDefaultGroup failed', seedErr?.message || seedErr);
      }
    } else {
      console.warn('[Unify] unify_group_chat: groupId %s not found', groupId);
    }
  } catch (err) {
    console.warn('[Unify] unify_group_chat: group open failed', err?.message || err);
  }

  if (!groupHandle) {
    const errText = seedFailed
      ? `⚠️ Failed to seed default group ${groupId} — check ~/.yeaft/ permissions.`
      : `⚠️ Group ${groupId} not found.`;
    sendUnifyOutput({
      type: 'assistant',
      message: { content: [{ type: 'text', text: errText }] },
    }, { groupId });
    sendUnifyOutput({ type: 'result', result_text: '' }, { groupId });
    return;
  }

  // Auto-add @-mentioned VPs from the library, heal missing defaultVpId.
  try {
    const meta = groupHandle.getMeta();
    const wantsAdd = mentions.filter(
      (m) => m && m !== 'all' && !meta.roster.includes(m)
    );
    if (wantsAdd.length) {
      let mutated = false;
      for (const vpId of wantsAdd) {
        try {
          const vp = readVp(vpId);
          if (!vp) continue;
          addMember(yeaftDir, groupId, vpId);
          mutated = true;
        } catch { /* skip strangers */ }
      }
      if (mutated) {
        try { groupHandle.close && groupHandle.close(); } catch { /* best-effort */ }
        groupHandle = openGroup(join(yeaftDir, 'groups'), groupId);
        sendGroupRosterChanged(groupHandle.getMeta());
      }
    }
    const meta2 = groupHandle.getMeta();
    if (!meta2.defaultVpId && meta2.roster.length) {
      try {
        setGroupDefaultVp(yeaftDir, groupId, meta2.roster[0]);
        try { groupHandle.close && groupHandle.close(); } catch { /* best-effort */ }
        groupHandle = openGroup(join(yeaftDir, 'groups'), groupId);
        sendGroupRosterChanged(groupHandle.getMeta());
      } catch { /* best-effort */ }
    }
  } catch (err) {
    console.warn('[Unify] unify_group_chat: auto-roster heal failed', err?.message || err);
  }

  const captured = [];
  const coord = createCoordinator(groupHandle, {
    deliver: (vpId, envelope) => { captured.push({ vpId, envelope }); },
  });

  let report;
  try {
    report = coord.ingest({
      from: 'user',
      role: 'user',
      text,
      meta: { mentions },
    });
  } catch (err) {
    console.warn('[Unify] unify_group_chat: coord.ingest failed', err?.message || err);
    sendUnifyOutput({
      type: 'assistant',
      message: { content: [{ type: 'text', text: `⚠️ Group dispatch error: ${err?.message || err}` }] },
    }, { groupId });
    sendUnifyOutput({ type: 'result', result_text: '' }, { groupId });
    return;
  }

  const dispatchedIds = Array.isArray(report?.dispatched) ? report.dispatched : [];
  if (dispatchedIds.length === 0 && !report?.fallback) {
    // Coordinator chose nobody and provided no fallback — should not happen
    // with a healthy roster. Surface the failure explicitly rather than
    // silently retrying as a single-VP turn (the legacy fallback masked
    // group-roster bugs).
    sendUnifyOutput({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '⚠️ No VP available to respond — check the group roster.' }] },
    }, { groupId });
    sendUnifyOutput({ type: 'result', result_text: '' }, { groupId });
    return;
  }

  // Mint a dispatch ID for this fan-out — each VP gets a unique turnId.
  const dispatchId = randomUUID().slice(0, 8);

  // Snapshot conversation history BEFORE fan-out starts. Each VP reads
  // from this consistent point; no VP sees another VP's in-flight output.
  const baseSnapshot = [...conversationMessages];

  for (const { vpId, envelope } of captured) {
    const turnId = `${dispatchId}:${vpId}`;
    try {
      sendUnifyEvent({
        type: 'group_message',
        groupId,
        vpId,
        speakerVpId: vpId,
        text,
        mentions,
        trigger: envelope?.trigger || 'fallback',
        ts: Date.now(),
      }, { groupId, vpId, turnId });
    } catch { /* never crash WS pipeline */ }

    try {
      sendUnifyEvent({
        type: 'vp_typing_start',
        groupId,
        vpId,
        turnId,
        ts: Date.now(),
      }, { groupId, vpId, turnId });
    } catch { /* never crash WS pipeline */ }
  }

  // Per-VP parallel fan-out. Each VP gets its own AbortController
  // (stoppable individually via per-VP Stop button) and reads from
  // the shared baseSnapshot. On completion (or abort), results are
  // atomically appended to conversationMessages.
  await Promise.all(captured.map(async ({ vpId }) => {
    const turnId = `${dispatchId}:${vpId}`;
    const vpAbort = new AbortController();
    turnAbortCtrls.set(turnId, vpAbort);

    try {
      await runVpTurn({
        prompt: `@vp-${vpId} ${text}`,
        groupId,
        vpId,
        turnId,
        groupCoordinator: coord,
        vpAbort,
        baseSnapshot,
      });
    } catch (err) {
      console.warn('[Unify] unify_group_chat: per-vp dispatch failed', vpId, err?.message || err);
    } finally {
      turnAbortCtrls.delete(turnId);
      try {
        sendUnifyEvent({
          type: 'vp_typing_end',
          groupId,
          vpId,
          turnId,
          ts: Date.now(),
        }, { groupId, vpId, turnId });
      } catch { /* never crash WS pipeline */ }
    }
  }));

  // Post-turn compaction. Triggers when the JUST-APPENDED turn pushed
  // history past 20 turns / 80K tokens. Runs in the background — does
  // not block the response to this message. The next user message
  // awaits `_compactInFlight` at the entry gate (handleUnifyGroupChat
  // top), so the swap is guaranteed to be observed before the next
  // baseSnapshot capture. Errors are swallowed; next turn retries.
  scheduleCompactAfterTurn(groupId);
}

/**
 * Build the per-query VP context for the Engine.
 */
export function buildVpQueryOpts({ vpId, groupCoordinator, groupId }) {
  let resolvedVpId = vpId;
  if (!resolvedVpId) {
    try {
      const meta = groupCoordinator && groupCoordinator.group
        && typeof groupCoordinator.group.getMeta === 'function'
        ? groupCoordinator.group.getMeta() : null;
      if (meta && typeof meta.defaultVpId === 'string' && meta.defaultVpId) {
        resolvedVpId = meta.defaultVpId;
      }
    } catch { /* coordinator inspection is best-effort */ }
  }
  if (!resolvedVpId) {
    const cfgDefault = session?.config?.defaultVpId;
    if (typeof cfgDefault === 'string' && cfgDefault.trim()) {
      resolvedVpId = cfgDefault.trim();
    }
  }
  if (!resolvedVpId) {
    try {
      const lib = scanVpLibrary();
      if (Array.isArray(lib) && lib.length > 0 && lib[0].vpId) {
        resolvedVpId = lib[0].vpId;
      }
    } catch { /* library scan is best-effort */ }
  }
  if (!resolvedVpId) return undefined;

  const out = { senderVpId: resolvedVpId };
  if (typeof groupId === 'string' && groupId.trim()) {
    out.groupId = groupId.trim();
  }
  try {
    const vp = readVp(resolvedVpId);
    if (vp) {
      out.vpPersona = {
        vpId: resolvedVpId,
        displayName: vp.displayName || resolvedVpId,
        role: vp.role || '',
        persona: vp.persona || '',
      };
    }
  } catch { /* persona load is best-effort */ }
  if (groupCoordinator && typeof groupCoordinator.ingest === 'function') {
    try {
      out.router = createRouter({ coordinator: groupCoordinator });
    } catch {
      // Router build failure is non-fatal.
    }
  }
  return out;
}

/**
 * Lazy session boot. Idempotent: subsequent calls are no-ops once `session`
 * is set. Emits `session_ready` on first init so the frontend can finalize
 * its handshake.
 */
async function ensureSessionLoaded() {
  if (session) return;

  const yeaftDir = ctx.CONFIG?.yeaftDir;
  session = await loadSession({
    ...(yeaftDir && { dir: yeaftDir }),
    skipMCP: false,
    skipSkills: false,
  });

  installUnifyRuntimeBridge(session);

  try {
    if (session.engine && typeof session.engine.setSubAgentEventSink === 'function') {
      session.engine.setSubAgentEventSink((agentId, evt) => {
        try {
          sendUnifyEvent({ type: 'sub_agent_event', agentId, payload: evt });
        } catch { /* ignore */ }
      });
    }
  } catch (err) {
    console.warn('[Unify] setSubAgentEventSink wiring failed:', err?.message || err);
  }

  // Bug 8: clean up legacy `.archived-*` group dirs at boot.
  try {
    if (yeaftDir) {
      const removed = purgeArchivedGroups(yeaftDir);
      if (removed && removed.length > 0) {
        console.log(`[Unify] purged ${removed.length} legacy .archived group dir(s)`);
      }
    }
  } catch (err) {
    console.warn('[Unify] purgeArchivedGroups failed:', err?.message || err);
  }

  unifyConversationId = `unify-${Date.now()}`;

  restoreHistoryFromRecent(session.conversationStore.loadRecent(50));

  sendUnifyEvent({
    type: 'session_ready',
    conversationId: unifyConversationId,
    model: session.config.model,
    availableModels: session.config.availableModels || [],
    skills: session.status.skills,
    mcpServers: session.status.mcpServers,
    tools: session.status.tools,
  });
  sendGroupSnapshotBroadcast();
}

/**
 * Run a single VP's turn: call engine.query() with the supplied prompt and
 * coordinator-bound router, stream events to the frontend, and append the
 * result to the flat conversation history.
 *
 * Private — only `handleUnifyGroupChat` calls this. Each VP-turn gets its
 * own AbortController (`vpAbort`) so it can be stopped individually. The
 * shared `baseSnapshot` is the conversation history at fan-out start — no
 * VP sees another VP's in-flight output. After the turn finishes (or is
 * aborted), the VP's output is atomically appended to `conversationMessages`.
 *
 * @param {{ prompt: string, groupId: string, vpId: string, turnId: string, groupCoordinator: object, vpAbort: AbortController, baseSnapshot: Array }} args
 */
async function runVpTurn({ prompt, groupId, vpId, turnId, groupCoordinator, vpAbort, baseSnapshot }) {
  if (!prompt?.trim()) return;

  const envelope = { groupId, vpId, turnId };

  try {
    if (session?.dreamScheduler) {
      session.dreamScheduler.noteUserMessage();
    }

    let queryTimer = null;
    const resetQueryTimer = () => {
      if (queryTimer) clearTimeout(queryTimer);
      queryTimer = setTimeout(() => {
        if (!vpAbort.signal.aborted) {
          console.error(`[Unify] query timeout after ${QUERY_TIMEOUT_MS / 1000}s of silence — aborting VP ${vpId}`);
          try { vpAbort.abort(); } catch { /* best-effort */ }
        }
      }, QUERY_TIMEOUT_MS);
    };
    resetQueryTimer();

    // Emit turn_start so frontend can create the message block.
    sendUnifyEvent({ type: 'vp_turn_start', vpId, turnId, groupId }, envelope);

    try {
      const assistantTextParts = [];
      const toolCallsAccum = [];
      const toolResultsAccum = [];

      const queryOpts = buildVpQueryOpts({ vpId, groupCoordinator, groupId });
      const handlerCtx = {
        assistantTextParts,
        toolCallsAccum,
        toolResultsAccum,
        resetQueryTimer,
        groupId,
        vpId,
        turnId,
      };
      for await (const event of session.engine.query({
        prompt,
        messages: baseSnapshot,
        signal: vpAbort.signal,
        ...queryOpts,
      })) {
        resetQueryTimer();
        handleEngineEvent(event, handlerCtx);
      }

      // Turn completed — atomically append this VP's output to shared history.
      appendTurnToHistory(prompt, assistantTextParts, toolCallsAccum, toolResultsAccum);

      sendUnifyOutput({
        type: 'assistant',
        message: { content: [] },
      }, envelope);
      sendUnifyOutput({
        type: 'result',
        result_text: '',
      }, envelope);
    } finally {
      if (queryTimer) clearTimeout(queryTimer);
    }
  } catch (err) {
    const isAbort = err && (err.name === 'AbortError' || err.name === 'LLMAbortError');
    if (isAbort) {
      sendUnifyOutput({
        type: 'result',
        result_text: '',
        stopped: true,
      }, envelope);
      return;
    }

    console.error('[Unify] query error:', err);

    if (isPermissionErrorMsg(err.message)) {
      if (!_permissionDiagnosticSent) {
        _permissionDiagnosticSent = true;
        sendUnifyOutput({
          type: 'assistant',
          message: {
            content: [{
              type: 'text',
              text: '⚠️ Cannot write to ~/.yeaft/ directory — some features (memory, history) are unavailable. Please check directory permissions: `chmod -R u+rw ~/.yeaft/`',
            }],
          },
        }, envelope);
      }
    } else {
      sendUnifyOutput({
        type: 'assistant',
        message: {
          content: [{
            type: 'text',
            text: `⚠️ Session error: ${err.message}`,
          }],
        },
      }, envelope);
    }
    sendUnifyOutput({
      type: 'result',
      result_text: '',
    }, envelope);
  }
}

/**
 * Atomically append a completed VP-turn's messages to the shared
 * conversation history. Called once at turn end (not during streaming).
 */
function appendTurnToHistory(prompt, assistantTextParts, toolCallsAccum, toolResultsAccum) {
  conversationMessages.push({ role: 'user', content: prompt });

  const fullText = assistantTextParts.join('');
  if (fullText || toolCallsAccum.length > 0) {
    const assistantMsg = { role: 'assistant', content: fullText };
    if (toolCallsAccum.length > 0) {
      assistantMsg.toolCalls = toolCallsAccum.map(tc => ({
        id: tc.id,
        name: tc.name,
        input: tc.input,
      }));
    }
    conversationMessages.push(assistantMsg);

    for (const tr of toolResultsAccum) {
      conversationMessages.push({
        role: 'tool',
        toolCallId: tr.toolCallId,
        content: tr.content,
        isError: tr.isError,
      });
    }
  }
}

/**
 * In-flight compact promise. Set by `scheduleCompactAfterTurn` when a
 * turn ends and triggers compaction; awaited by the next
 * `handleUnifyGroupChat` invocation at its entry gate so the next
 * baseSnapshot reflects the compacted history.
 *
 * Compact runs at turn END (not before fan-out), so it does not add
 * latency to the user's current message. The trade-off: the next user
 * message may have to wait briefly for the compact to finish — but
 * compact uses the fast model and typically completes in 1–3s.
 *
 * @type {Promise<void>|null}
 */
let _compactInFlight = null;

/**
 * Re-trigger flag. If `scheduleCompactAfterTurn` is called while a
 * compact is already in flight, set this so the in-flight one chains
 * a follow-up immediately on completion. Without this, a sustained
 * burst of turns could starve compaction: turn N triggers compact,
 * turns N+1 / N+2 / … each find `_compactInFlight` set and skip,
 * leaving history above threshold until the burst ends.
 */
let _compactPending = false;

/**
 * Fire-and-forget post-turn compaction. Called once at the end of each
 * `handleUnifyGroupChat` after `Promise.all(runVpTurn)` resolves. If a
 * compaction is still in flight from an earlier turn, we set
 * `_compactPending` so the running compact chains a follow-up on
 * completion (anti-starvation).
 *
 * The promise is stored in `_compactInFlight` so the next user message
 * can await it before reading `conversationMessages`.
 *
 * @param {string} groupId — for envelope tagging on the emitted event
 */
function scheduleCompactAfterTurn(groupId) {
  if (_compactInFlight) {
    // A compact is already running. Mark a follow-up so when it
    // finishes, it re-evaluates and runs again if still triggered.
    _compactPending = true;
    return;
  }
  // Cheap O(n) precheck so we don't bother engaging the LLM at all
  // when the conversation is still small.
  const triage = shouldCompactHistory(conversationMessages);
  if (!triage.trigger) return;
  if (!session?.engine || typeof session.engine.summarizeForCompact !== 'function') {
    console.warn('[Unify] history compact: engine.summarizeForCompact unavailable — skipping');
    return;
  }

  _compactInFlight = runCompactNow(groupId).finally(() => {
    _compactInFlight = null;
    // If turns piled up while we were running and compaction is still
    // needed, chain a follow-up. Use a microtask so the .finally chain
    // settles cleanly before the next promise is created.
    if (_compactPending) {
      _compactPending = false;
      queueMicrotask(() => scheduleCompactAfterTurn(groupId));
    }
  });
}

/**
 * Run the in-memory history compactor. Replaces the older prefix of
 * `conversationMessages` with a single user-role summary message,
 * preserving the recent tail verbatim. Mutates the module-level
 * variable in place via reassignment.
 *
 * Behaviour:
 *   - If summarization fails, leaves history untouched.
 *   - On success, emits a `unify_history_compacted` event so dev tools
 *     can show what happened (frontend currently ignores it).
 *
 * Race safety:
 *   - Single-flight via `_compactInFlight` (only one runs at a time).
 *   - Reads the array reference once into `snapshot`. If anything else
 *     reassigns `conversationMessages` during the await (`consolidate`
 *     event from the engine, `clearUnifyMessages`, `resetUnifySession`),
 *     we detect the swap by reference comparison and bail without
 *     overwriting their fresh state.
 *
 * @param {string} groupId
 * @returns {Promise<void>}
 */
async function runCompactNow(groupId) {
  const summarize = ({ system, prompt }) =>
    session.engine.summarizeForCompact({ system, prompt, maxTokens: 1024 });

  // Capture the current array reference. If anyone reassigns
  // `conversationMessages` while we're summarizing (engine consolidate
  // event, session reset, manual clear), the reference will differ
  // and we abandon the swap.
  const snapshot = conversationMessages;

  try {
    const result = await compactHistory(snapshot, { summarize });
    if (!result.compacted) {
      if (result.error) {
        console.warn(
          `[Unify] history compact: summarizer failed (${result.error}); ` +
          `keeping ${result.beforeTurns} turns / ~${result.beforeTokens} tokens`
        );
      }
      return;
    }
    // Race guard: if `conversationMessages` was reassigned during the
    // await (e.g. consolidate / reset), do NOT overwrite the fresh
    // state with our stale compacted snapshot.
    if (conversationMessages !== snapshot) {
      console.log('[Unify] history compact: history was reset during compact — discarding stale summary');
      return;
    }
    conversationMessages = result.messages;
    console.log(
      `[Unify] history compacted (reason=${result.reason}): ` +
      `turns ${result.beforeTurns}→${result.afterTurns}, ` +
      `tokens ~${result.beforeTokens}→${result.afterTokens}, ` +
      `archived ${result.archivedCount} messages`
    );
    try {
      sendUnifyEvent({
        type: 'unify_history_compacted',
        reason: result.reason,
        beforeTurns: result.beforeTurns,
        afterTurns: result.afterTurns,
        beforeTokens: result.beforeTokens,
        afterTokens: result.afterTokens,
        archivedCount: result.archivedCount,
        ts: Date.now(),
      }, { groupId });
    } catch { /* WS pipeline failure must not crash compact */ }
  } catch (err) {
    console.warn('[Unify] history compact: unexpected failure', err?.message || err);
  }
}

/**
 * H2.f.2: user-initiated abort. The pre-H2 multi-thread version took a
 * `threadId` parameter; the new version aborts the single in-flight
 * controller. The `threadId` field on `msg` is accepted but ignored for
 * back-compat with older clients.
 *
 * @param {{ threadId?: string }} _msg
 * @returns {{ aborted: string[], all: boolean }}
 */
export function handleUnifyAbortThread(_msg = {}) {
  const aborted = [];
  if (currentAbortCtrl && !currentAbortCtrl.signal.aborted) {
    try { currentAbortCtrl.abort(); aborted.push('main'); } catch { /* best-effort */ }
  }
  currentAbortCtrl = null;
  // Also abort all per-VP turn controllers.
  for (const [turnId, ctrl] of turnAbortCtrls) {
    try { if (!ctrl.signal.aborted) { ctrl.abort(); aborted.push(turnId); } } catch { /* best-effort */ }
  }
  turnAbortCtrls.clear();
  sendUnifyEvent({ type: 'unify_aborted', aborted, all: false });
  return { aborted, all: false };
}

/**
 * H2.f.2: abort all (single conversation → same as abort one).
 * @returns {{ aborted: string[], all: boolean }}
 */
export function handleUnifyAbortAll() {
  const aborted = [];
  if (currentAbortCtrl && !currentAbortCtrl.signal.aborted) {
    try { currentAbortCtrl.abort(); aborted.push('main'); } catch { /* best-effort */ }
  }
  currentAbortCtrl = null;
  // Also abort all per-VP turn controllers.
  for (const [turnId, ctrl] of turnAbortCtrls) {
    try { if (!ctrl.signal.aborted) { ctrl.abort(); aborted.push(turnId); } } catch { /* best-effort */ }
  }
  turnAbortCtrls.clear();
  sendUnifyEvent({ type: 'unify_aborted', aborted, all: true });
  return { aborted, all: true };
}

/**
 * Per-VP abort: stops a single VP turn by turnId without affecting siblings.
 * Frontend sends `{ type: 'unify_abort_turn', turnId }`.
 * @param {{ turnId?: string }} msg
 */
export function handleUnifyAbortTurn(msg = {}) {
  const { turnId } = msg;
  if (!turnId) {
    sendUnifyEvent({ type: 'unify_turn_aborted', turnId: null, success: false });
    return;
  }
  const ctrl = turnAbortCtrls.get(turnId);
  if (ctrl && !ctrl.signal.aborted) {
    try { ctrl.abort(); } catch { /* best-effort */ }
    turnAbortCtrls.delete(turnId);
    sendUnifyEvent({ type: 'unify_turn_aborted', turnId, success: true });
  } else {
    turnAbortCtrls.delete(turnId);
    sendUnifyEvent({ type: 'unify_turn_aborted', turnId, success: false });
  }
}

/**
 * Unified abort entry: routes by payload shape.
 * @param {{ threadId?: string, all?: boolean }} [opts]
 */
export function abortUnifySession(opts = {}) {
  if (opts && opts.all) return handleUnifyAbortAll();
  if (opts && opts.threadId) return handleUnifyAbortThread({ threadId: opts.threadId });
  // No payload — conservative no-op ack.
  sendUnifyEvent({ type: 'unify_aborted', aborted: [], all: false });
  return { aborted: [], all: false };
}

/** Test-only: seed the in-flight controller. */
export function __testSeedAbortController(_threadId, ctrl) {
  // _threadId is ignored — H2.f.2 has a single controller.
  currentAbortCtrl = ctrl;
}

/** Test-only: returns ['main'] when a controller is registered, else []. */
export function __testGetRegisteredThreadIds() {
  return currentAbortCtrl && !currentAbortCtrl.signal.aborted ? ['main'] : [];
}

/**
 * Manual dream trigger from VP detail page.
 */
export async function handleUnifyDreamTrigger(msg = {}) {
  if (!session?.dreamScheduler) {
    sendToServer({
      type: 'unify_dream_result',
      success: false,
      error: 'Dream scheduler not initialized — session not loaded.',
    });
    return;
  }

  const vpId = msg.vpId || 'default';

  try {
    sendToServer({
      type: 'unify_dream_status',
      vpId,
      status: 'running',
    });

    const result = await session.dreamScheduler.triggerDreamNow();

    sendToServer({
      type: 'unify_dream_result',
      vpId,
      success: !result.error && !result.skipped,
      ...result,
    });
  } catch (err) {
    sendToServer({
      type: 'unify_dream_result',
      vpId,
      success: false,
      error: err?.message || String(err),
    });
  }
}

/** Deprecated mode switch — Unify is single-mode. */
export function handleUnifyModeSwitch(_msg) {
  console.warn('[Unify] unify_mode_switch is deprecated and ignored — Unify now runs in a single unified mode.');
}

/** Fetch a feature's summary history (revision chain). */
export async function handleUnifyFetchSummaryHistory(msg = {}) {
  const requestId = typeof msg.requestId === 'string' ? msg.requestId : undefined;
  const featureId = typeof msg.featureId === 'string' ? msg.featureId : null;
  const includeArchived = !!msg.includeArchived;

  const reply = (extra = {}) => sendUnifyEvent({
    type: 'unify_summary_history',
    featureId,
    ...extra,
    ...(requestId ? { requestId } : {}),
  });

  if (!featureId) { reply({ revisions: [], archived: null, error: 'missing_feature_id' }); return; }

  try {
    const { getFeatureStore } = await import('./tools/feature-tools.js');
    const featureStore = getFeatureStore();
    const feature = featureStore?.get(featureId);
    if (!feature) { reply({ revisions: [], archived: null, error: 'feature_not_found' }); return; }
    const groupId = feature.groupId;
    if (!groupId) { reply({ revisions: [], archived: null, error: 'feature_has_no_group' }); return; }

    const yeaftDir = ctx.CONFIG?.yeaftDir;
    if (!yeaftDir) { reply({ revisions: [], archived: null, error: 'no_yeaft_dir' }); return; }

    const root = join(yeaftDir, 'groups');
    const dir = join(root, groupId);
    if (!existsSync(dir) || !loadGroupMeta(dir)) {
      reply({ revisions: [], archived: null, error: 'group_not_found' });
      return;
    }
    const groupHandle = openGroup(root, groupId);
    const summaries = [];
    for (const m of groupHandle.streamMessages()) {
      if (!m || m.featureId !== featureId) continue;
      const meta = m.meta || {};
      if (meta.kind === 'summary' || meta.type === 'summary') summaries.push(m);
    }
    summaries.sort((a, b) => {
      const at = Date.parse(a.ts || '') || 0;
      const bt = Date.parse(b.ts || '') || 0;
      return bt - at;
    });
    const supersededIds = new Set();
    for (const s of summaries) {
      const arr = s.meta?.supersedes;
      if (Array.isArray(arr)) for (const id of arr) supersededIds.add(id);
    }
    const current = [];
    const archived = [];
    for (const s of summaries) {
      if (supersededIds.has(s.id)) archived.push(s);
      else current.push(s);
    }
    const overflow = current.slice(10);
    const trimmedCurrent = current.slice(0, 10);
    if (overflow.length) archived.push(...overflow);
    archived.sort((a, b) => {
      const at = Date.parse(a.ts || '') || 0;
      const bt = Date.parse(b.ts || '') || 0;
      return bt - at;
    });
    reply({
      revisions: trimmedCurrent,
      archived: includeArchived ? archived : null,
    });
  } catch (err) {
    reply({ revisions: [], archived: null, error: String(err?.message || err) });
  }
}

/** Feature affiliation CRUD (relate / unrelate / kick_vp / abort_vp). */
export async function handleUnifyFeatureCrud(msg = {}) {
  const requestId = typeof msg.requestId === 'string' ? msg.requestId : undefined;
  const op = typeof msg.op === 'string' ? msg.op : null;
  const featureId = typeof msg.featureId === 'string' ? msg.featureId : null;
  const vpId = typeof msg.vpId === 'string' ? msg.vpId : null;
  const relatedFeatureId = typeof msg.relatedFeatureId === 'string' ? msg.relatedFeatureId : null;

  const reply = (extra = {}) => sendUnifyEvent({
    type: 'unify_feature_crud_result',
    op,
    featureId,
    ...(vpId ? { vpId } : {}),
    ...extra,
    ...(requestId ? { requestId } : {}),
  });

  if (!op) { reply({ ok: false, error: 'missing_op' }); return; }
  if (!featureId) { reply({ ok: false, error: 'missing_feature_id' }); return; }

  try {
    const { getFeatureStore } = await import('./tools/feature-tools.js');
    const featureStore = getFeatureStore();
    const feature = featureStore?.get(featureId);
    if (!feature) { reply({ ok: false, error: 'feature_not_found' }); return; }

    if (op === 'relate' || op === 'unrelate') {
      if (!relatedFeatureId) { reply({ ok: false, error: 'missing_related_feature_id' }); return; }
      const other = featureStore.get(relatedFeatureId);
      if (!other) { reply({ ok: false, error: 'related_feature_not_found' }); return; }
      const apply = (t, otherId, add) => {
        const cur = Array.isArray(t.relatedFeatureIds) ? t.relatedFeatureIds.slice() : [];
        const idx = cur.indexOf(otherId);
        if (add && idx === -1) cur.push(otherId);
        if (!add && idx !== -1) cur.splice(idx, 1);
        featureStore.update(t.id, { relatedFeatureIds: cur });
      };
      apply(feature, relatedFeatureId, op === 'relate');
      apply(other, featureId, op === 'relate');
      reply({ ok: true, relatedFeatureId });
      return;
    }

    if (op === 'kick_vp') {
      if (!vpId) { reply({ ok: false, error: 'missing_vp_id' }); return; }
      featureStore.removeMember(featureId, vpId);
      reply({ ok: true });
      return;
    }

    if (op === 'abort_vp') {
      if (!vpId) { reply({ ok: false, error: 'missing_vp_id' }); return; }
      // H2.f.2: per-VP abort no longer routed through engineRegistry — the
      // single engine handles its own abort via currentAbortCtrl. Reply
      // ok:true so the UI surface still works; deeper per-VP cancel is a
      // separate task.
      reply({ ok: true });
      return;
    }

    reply({ ok: false, error: 'unknown_op' });
  } catch (err) {
    reply({ ok: false, error: String(err?.message || err) });
  }
}

/** Handle model switch from the web UI. */
export function handleUnifyModelSwitch(msg) {
  if (!session || !msg.model) return;

  const available = session.config.availableModels || [];
  const found = available.some(m => m.id === msg.model);
  if (!found) {
    console.warn(`[Unify] model switch rejected — "${msg.model}" not in availableModels`);
    return;
  }

  session.config.model = msg.model;

  sendUnifyEvent({
    type: 'model_switched',
    model: msg.model,
  });
}

/**
 * Handle history load request. Loads recent messages from ConversationStore
 * and replays them through the standard claude_output pipeline.
 *
 * Group-history-isolation (Bug 7): when `msg.groupId` is provided the
 * replay AND the engine's bootstrap context are filtered to that group.
 * Messages tagged with another groupId — and legacy messages with no
 * groupId at all — are excluded so a stale `grp_default` (or any other
 * group) never bleeds into the active group's pane.
 */
export async function handleUnifyLoadHistory(msg) {
  const groupId = (msg && typeof msg.groupId === 'string' && msg.groupId) || null;
  const pickRecent = (store, lim) =>
    groupId ? store.loadRecentByGroup(groupId, lim) : store.loadRecent(lim);

  if (!session) {
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    session = await loadSession({
      ...(yeaftDir && { dir: yeaftDir }),
      skipMCP: false,
      skipSkills: false,
    });
    installUnifyRuntimeBridge(session);

    unifyConversationId = `unify-${Date.now()}`;

    restoreHistoryFromRecent(pickRecent(session.conversationStore, 50));
  } else if (groupId) {
    // Re-entering an existing session with a (possibly new) group filter:
    // re-seed the engine's flat history so it doesn't carry messages from
    // another group into the next turn's context.
    restoreHistoryFromRecent(pickRecent(session.conversationStore, 50));
  }

  // Always replay session_ready so refresh / reconnect rebuilds UI state.
  sendUnifyEvent({
    type: 'session_ready',
    conversationId: unifyConversationId,
    model: session.config.model,
    availableModels: session.config.availableModels || [],
    skills: session.status.skills,
    mcpServers: session.status.mcpServers,
    tools: session.status.tools,
  });
  sendGroupSnapshotBroadcast();

  const limit = (typeof msg.limit === 'number') ? msg.limit : 50;
  const messages = limit > 0 ? pickRecent(session.conversationStore, limit) : [];
  const compactSummary = session.conversationStore.readCompactSummary();

  for (const m of messages) {
    if (m.role === 'user') {
      sendUnifyOutput({ type: 'user', message: { content: m.content } }, { groupId: m.groupId || null });
    } else if (m.role === 'assistant') {
      sendUnifyOutput({
        type: 'assistant',
        message: { content: [{ type: 'text', text: m.content }] },
      }, { groupId: m.groupId || null });
      sendUnifyOutput({ type: 'result', result_text: '' }, { groupId: m.groupId || null });
    }
  }

  sendUnifyEvent({
    type: 'history_loaded',
    count: messages.length,
    hasCompactSummary: !!compactSummary,
    totalHot: session.conversationStore.countHot(),
    totalCold: session.conversationStore.countCold(),
    groupId,
  });
}

/**
 * Reset Unify session. Aborts the in-flight controller, tears down the
 * session, then re-initialises so the frontend gets fresh config.
 */
export async function resetUnifySession() {
  if (currentAbortCtrl && !currentAbortCtrl.signal.aborted) {
    try { currentAbortCtrl.abort(); } catch { /* ignore */ }
  }
  currentAbortCtrl = null;
  if (_vpUnsubscribe) {
    try { _vpUnsubscribe(); } catch { /* ignore */ }
    _vpUnsubscribe = null;
  }
  if (session) {
    await session.shutdown();
    session = null;
  }
  unifyConversationId = null;
  conversationMessages = [];

  try {
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    session = await loadSession({
      ...(yeaftDir && { dir: yeaftDir }),
      skipMCP: false,
      skipSkills: false,
    });
    installUnifyRuntimeBridge(session);

    unifyConversationId = `unify-${Date.now()}`;

    restoreHistoryFromRecent(session.conversationStore.loadRecent(50));

    sendUnifyEvent({
      type: 'session_ready',
      conversationId: unifyConversationId,
      model: session.config.model,
      availableModels: session.config.availableModels || [],
      skills: session.status.skills,
      mcpServers: session.status.mcpServers,
      tools: session.status.tools,
    });
  } catch (err) {
    console.error('[Unify] Failed to re-initialize session after reset:', err.message);
  }
}
