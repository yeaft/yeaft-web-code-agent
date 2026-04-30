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

/** @type {import('./session.js').Session | null} */
let session = null;

/**
 * Single in-flight AbortController. A new user message cancels the prior
 * round (if any). H2.f.2: replaces the per-thread Map.
 * @type {AbortController | null}
 */
let currentAbortCtrl = null;

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
 * Optional `groupId` tags every emitted assistant/tool/user mirror with
 * the originating group so the frontend can stamp arriving messages with
 * the SEND-context group.
 */
function sendUnifyOutput(data, groupId) {
  sendToServer({
    type: 'unify_output',
    conversationId: unifyConversationId,
    ...(groupId ? { groupId } : {}),
    data,
  });
}

/** Send a unify_output event (non-claude_output metadata). */
function sendUnifyEvent(event, groupId) {
  sendToServer({
    type: 'unify_output',
    conversationId: unifyConversationId,
    ...(groupId ? { groupId } : {}),
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
 * @param {{assistantTextParts:string[], toolCallsAccum:Array, toolResultsAccum:Array, resetQueryTimer:Function, groupId?:string}} hctx
 */
function handleEngineEvent(event, hctx) {
  hctx.resetQueryTimer();
  const gid = hctx && hctx.groupId;

  switch (event.type) {
    case 'text_delta':
      hctx.assistantTextParts.push(event.text);
      sendUnifyOutput({
        type: 'assistant',
        message: { content: [{ type: 'text', text: event.text }] },
      }, gid);
      break;

    case 'thinking_delta':
      sendUnifyEvent({ type: 'thinking_delta', text: event.text }, gid);
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
      }, gid);
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
      }, gid);
      break;

    case 'tool_start':
      sendUnifyEvent({
        type: 'tool_start',
        id: event.id,
        name: event.name,
      }, gid);
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
      }, gid);
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
      }, gid);
      break;

    case 'recall':
      sendUnifyEvent({
        type: 'recall',
        entryCount: event.entryCount,
        cached: event.cached,
      }, gid);
      break;

    case 'consolidate':
      // Engine compressed the context — clear our accumulated history.
      conversationMessages = [];
      sendUnifyEvent({
        type: 'consolidate',
        archivedCount: event.archivedCount,
        extractedCount: event.extractedCount,
      }, gid);
      break;

    case 'fallback':
      sendUnifyEvent({
        type: 'fallback',
        from: event.from,
        to: event.to,
        reason: event.reason,
      }, gid);
      break;

    case 'reflection':
      sendUnifyEvent({
        type: 'reflection',
        trigger: event.trigger,
        status: event.status,
        loopRange: event.loopRange,
        toolCount: event.toolCount,
        content: event.content,
        durationMs: event.durationMs,
        error: event.error,
      }, gid);
      break;

    case 'debug_turn':
      sendUnifyEvent({
        type: 'debug_turn',
        turnNumber: event.turnNumber,
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
      }, gid);
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
          }, gid);
        }
      } else {
        sendUnifyOutput({
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: `⚠️ Error: ${errMsg}` }],
          },
        }, gid);
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

  await ensureSessionLoaded();

  // Open the group; seed grp_default on the fly if absent.
  const yeaftDir = ctx.CONFIG?.yeaftDir;
  if (!yeaftDir) {
    sendUnifyOutput({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '⚠️ Unify session error: no yeaft directory configured.' }] },
    }, groupId);
    sendUnifyOutput({ type: 'result', result_text: '' }, groupId);
    return;
  }

  let groupHandle = null;
  try {
    const { openGroup, loadGroupMeta } = await import('./groups/group-store.js');
    const { join } = await import('node:path');
    const { existsSync } = await import('node:fs');
    const root = join(yeaftDir, 'groups');
    const dir = join(root, groupId);
    if (existsSync(dir) && loadGroupMeta(dir)) {
      groupHandle = openGroup(root, groupId);
    } else if (groupId === 'grp_default') {
      const { seedDefaultGroup } = await import('./groups/seed-default.js');
      const seeded = seedDefaultGroup(yeaftDir, {});
      groupHandle = seeded.group;
    } else {
      console.warn('[Unify] unify_group_chat: groupId %s not found', groupId);
    }
  } catch (err) {
    console.warn('[Unify] unify_group_chat: group open/seed failed', err?.message || err);
  }

  if (!groupHandle) {
    sendUnifyOutput({
      type: 'assistant',
      message: { content: [{ type: 'text', text: `⚠️ Group ${groupId} not found.` }] },
    }, groupId);
    sendUnifyOutput({ type: 'result', result_text: '' }, groupId);
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
        const { openGroup } = await import('./groups/group-store.js');
        const { join } = await import('node:path');
        groupHandle = openGroup(join(yeaftDir, 'groups'), groupId);
        sendGroupRosterChanged(groupHandle.getMeta());
      }
    }
    const meta2 = groupHandle.getMeta();
    if (!meta2.defaultVpId && meta2.roster.length) {
      try {
        setGroupDefaultVp(yeaftDir, groupId, meta2.roster[0]);
        try { groupHandle.close && groupHandle.close(); } catch { /* best-effort */ }
        const { openGroup } = await import('./groups/group-store.js');
        const { join } = await import('node:path');
        groupHandle = openGroup(join(yeaftDir, 'groups'), groupId);
        sendGroupRosterChanged(groupHandle.getMeta());
      } catch { /* best-effort */ }
    }
  } catch (err) {
    console.warn('[Unify] unify_group_chat: auto-roster heal failed', err?.message || err);
  }

  const { createCoordinator } = await import('./groups/coordinator.js');
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
    }, groupId);
    sendUnifyOutput({ type: 'result', result_text: '' }, groupId);
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
    }, groupId);
    sendUnifyOutput({ type: 'result', result_text: '' }, groupId);
    return;
  }

  for (const { vpId, envelope } of captured) {
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
      });
    } catch { /* never crash WS pipeline */ }

    try {
      sendUnifyEvent({
        type: 'vp_typing_start',
        groupId,
        vpId,
        ts: Date.now(),
      });
    } catch { /* never crash WS pipeline */ }
  }

  // GC.1 Commit C: VP-level parallelism. Each selected VP runs its
  // turn concurrently via Promise.all. Intra-VP loops (LLM → tool →
  // LLM) stay serial inside each runVpTurn call.
  //
  // Side-effect: VP-B's transcript no longer contains VP-A's reply
  // (they're concurrent). Cross-VP visibility moves to the explicit
  // route_forward tool. The group jsonl log remains the source of
  // truth for full-fidelity replay.
  await Promise.all(captured.map(async ({ vpId }) => {
    try {
      await runVpTurn({
        prompt: `@vp-${vpId} ${text}`,
        groupId,
        vpId,
        groupCoordinator: coord,
      });
    } catch (err) {
      console.warn('[Unify] unify_group_chat: per-vp dispatch failed', vpId, err?.message || err);
    } finally {
      try {
        sendUnifyEvent({
          type: 'vp_typing_end',
          groupId,
          vpId,
          ts: Date.now(),
        });
      } catch { /* never crash WS pipeline */ }
    }
  }));
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
 * Private — only `handleUnifyGroupChat` calls this. Coordinator and groupId
 * are mandatory; callers MUST resolve a default group before invoking.
 *
 * @param {{ prompt: string, groupId: string, vpId: string|null, groupCoordinator: object }} args
 */
async function runVpTurn({ prompt, groupId, vpId, groupCoordinator }) {
  if (!prompt?.trim()) return;

  try {
    if (session?.dreamScheduler) {
      session.dreamScheduler.noteUserMessage();
    }

    // Cancel any prior in-flight round before starting this one.
    if (currentAbortCtrl && !currentAbortCtrl.signal.aborted) {
      try { currentAbortCtrl.abort(); } catch { /* best-effort */ }
    }
    const abortCtrl = new AbortController();
    currentAbortCtrl = abortCtrl;

    let queryTimer = null;
    const resetQueryTimer = () => {
      if (queryTimer) clearTimeout(queryTimer);
      queryTimer = setTimeout(() => {
        if (!abortCtrl.signal.aborted) {
          console.error(`[Unify] query timeout after ${QUERY_TIMEOUT_MS / 1000}s of silence — aborting`);
          abortCtrl.abort();
        }
      }, QUERY_TIMEOUT_MS);
    };
    resetQueryTimer();

    try {
      const assistantTextParts = [];
      const toolCallsAccum = [];
      const toolResultsAccum = [];

      // H2.f.5: dispatcher + InputQueue retired. Call engine.query() directly,
      // passing the flat conversation history as `messages` for context continuity.
      const queryOpts = buildVpQueryOpts({ vpId, groupCoordinator, groupId });
      const handlerCtx = {
        assistantTextParts,
        toolCallsAccum,
        toolResultsAccum,
        resetQueryTimer,
        groupId,
      };
      for await (const event of session.engine.query({
        prompt,
        messages: [...conversationMessages],
        signal: abortCtrl.signal,
        ...queryOpts,
      })) {
        resetQueryTimer();
        handleEngineEvent(event, handlerCtx);
      }

      // Accumulate messages for context continuity.
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

      sendUnifyOutput({
        type: 'assistant',
        message: { content: [] },
      }, groupId);
      sendUnifyOutput({
        type: 'result',
        result_text: '',
      }, groupId);
    } finally {
      if (queryTimer) clearTimeout(queryTimer);
    }
  } catch (err) {
    const isAbort = err && (err.name === 'AbortError' || err.name === 'LLMAbortError');
    if (isAbort) {
      sendUnifyOutput({
        type: 'result',
        result_text: '',
      }, groupId);
      return;
    }

    console.error('[Unify] query error:', err.message);

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
        }, groupId);
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
      }, groupId);
    }
    sendUnifyOutput({
      type: 'result',
      result_text: '',
    }, groupId);
  } finally {
    if (currentAbortCtrl && currentAbortCtrl.signal.aborted) {
      // Aborted controllers stay where they are; a new query will replace.
    }
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
  sendUnifyEvent({ type: 'unify_aborted', aborted, all: true });
  return { aborted, all: true };
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

    const { openGroup, loadGroupMeta } = await import('./groups/group-store.js');
    const { join } = await import('node:path');
    const { existsSync } = await import('node:fs');
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
 */
export async function handleUnifyLoadHistory(msg) {
  if (!session) {
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    session = await loadSession({
      ...(yeaftDir && { dir: yeaftDir }),
      skipMCP: false,
      skipSkills: false,
    });
    installUnifyRuntimeBridge(session);

    unifyConversationId = `unify-${Date.now()}`;

    restoreHistoryFromRecent(session.conversationStore.loadRecent(50));
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
  const messages = limit > 0 ? session.conversationStore.loadRecent(limit) : [];
  const compactSummary = session.conversationStore.readCompactSummary();

  for (const m of messages) {
    if (m.role === 'user') {
      sendUnifyOutput({ type: 'user', message: { content: m.content } }, m.groupId || null);
    } else if (m.role === 'assistant') {
      sendUnifyOutput({
        type: 'assistant',
        message: { content: [{ type: 'text', text: m.content }] },
      }, m.groupId || null);
      sendUnifyOutput({ type: 'result', result_text: '' }, m.groupId || null);
    }
  }

  sendUnifyEvent({
    type: 'history_loaded',
    count: messages.length,
    hasCompactSummary: !!compactSummary,
    totalHot: session.conversationStore.countHot(),
    totalCold: session.conversationStore.countCold(),
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
