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
import { Engine } from './engine.js';
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
  updateGroupAnnouncement,
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
  trimSnapshotForBudget,
} from './history-compact.js';
import { createFeatureArc } from './feature-arc.js';
import { getFeatureStore } from './tools/feature-tools.js';

/** @type {import('./session.js').Session | null} */
let session = null;

/**
 * Single in-flight AbortController. A new user message cancels the prior
 * round (if any). H2.f.2: replaces the per-thread Map.
 *
 * Note: post-707, group fan-out turns no longer flow through this slot —
 * they each get their own controller in `vpAborts` keyed by
 * `${groupId}::${vpId}`. The `currentAbortCtrl` here is only mutated by
 * 1:1 chat paths, the test seeder, and the session-reset cleanup. Don't
 * reach for it from new group-flow code; selective abort, abort-all,
 * and abort-turn already operate against `vpAborts` correctly.
 *
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

/**
 * Per-VP inbox + driver + engine pool (group multi-VP delivery).
 *
 * Replaces the pre-707 one-shot `captured[]` array. The coordinator's
 * `deliver(vpId, envelope)` callback now pushes into `vpInboxes`, and a
 * per-VP driver (long-lived async function) drains the inbox one
 * envelope at a time — exactly the shape used by sub-agent runner's
 * `pendingPrompts` + `driveSubAgent`. With this in place:
 *   1. `route_forward` pushes via the same `deliver` → enqueueForVp
 *      path the user dispatch uses, so VP-to-VP hand-offs actually run
 *      the target VP's driver instead of being dropped.
 *   2. Each VP gets its own Engine (via `vpEngines`) so private state
 *      (`#currentAbortCtrl`, `#__queryCounter`, `#pendingT2`,
 *      `#abortReason`, `#adjustRanByGroup`, `#execLog`) does not collide
 *      across concurrent VP turns. Engines are keyed by
 *      `${groupId}::${vpId}` rather than vpId alone because Engine
 *      cannot serve two concurrent queries safely — even if AMS state
 *      partitions correctly by groupKey, the non-group-keyed private
 *      state would collide if the same VP ran turns in two groups in
 *      parallel.
 */
/** @type {Map<string, Array<{envelope: object, opts: object}>>} */
const vpInboxes = new Map();
/** @type {Map<string, Promise<void>>} */
const vpDrivers = new Map();
/** @type {Map<string, import('./engine.js').Engine>} */
const vpEngines = new Map();
/** @type {Map<string, AbortController>} */
const vpAborts = new Map();
/**
 * Per-group cached coordinator + router. Created on first
 * `handleUnifyGroupChat` for a given groupId; reused across user messages
 * AND across `route_forward` deliveries inside running VP turns (the
 * router is wired into engine ctx; if we recreated coord per turn the
 * route_forward path would deliver into a freshly-created `captured[]`
 * that nobody consumes — exactly the pre-707 bug).
 *
 * Purge sites:
 *   - `invalidateGroupContext(groupId)` — called from every group CRUD
 *     handler that mutates roster / meta / lifecycle state on disk
 *     (rename, update announcement, archive, delete, add/remove member,
 *     set default VP).
 *   - `handleUnifyGroupChat` — invalidates inline when its own
 *     auto-add / default-VP-heal pass mutated the roster.
 *   - `resetUnifySession` and `__testResetVpState` clear the whole map.
 *
 * @type {Map<string, { coord: ReturnType<typeof createCoordinator>,
 *                     router: ReturnType<typeof createRouter>,
 *                     groupHandle: object }>}
 */
const groupContexts = new Map();

function vpKey(groupId, vpId) {
  return `${groupId}::${vpId}`;
}

/**
 * Drop the cached coordinator + router for a group AND abort/clear any
 * in-flight VP turns belonging to it. Call this from every CRUD handler
 * that mutates the group's roster, meta, or lifecycle state on disk —
 * the cached coord holds a closed `groupHandle`, so without invalidation
 * later route_forward / ingest calls would read zombie meta (stale
 * roster, pre-rename announcement, kicked members still routable).
 *
 * Idempotent — safe to call when no entry exists.
 */
function invalidateGroupContext(groupId) {
  if (!groupId) return;
  groupContexts.delete(groupId);
  const prefix = `${groupId}::`;
  for (const [k, ctrl] of vpAborts) {
    if (!k.startsWith(prefix)) continue;
    try { if (!ctrl.signal.aborted) ctrl.abort(); } catch { /* best-effort */ }
    vpAborts.delete(k);
  }
  for (const [k, inbox] of vpInboxes) {
    if (!k.startsWith(prefix)) continue;
    if (Array.isArray(inbox)) inbox.length = 0;
  }
  // Engines are NOT torn down here on purpose. They hold subordinate
  // state (AMS adjustments) that should survive a meta change and a
  // closed groupHandle — they don't reach the on-disk group meta
  // directly. They *are* dropped on `resetUnifySession`.
}

/**
 * Live-locale broadcast: push a new language onto every Engine instance
 * the agent currently holds.
 *
 * Called from `agent/connection/message-router.js` after `update_llm_config`
 * persists `language` to ~/.yeaft/config.json. Without this, the per-VP
 * engine pool (constructed once per VP and cached) keeps serving its
 * old language until the session is reloaded — that's the bug fix from
 * task-708 group-locale-sync. The 1:1-chat session.engine is also
 * updated so Chat-mode prompts pick up the new language on the very
 * next turn.
 *
 * No-op when `language` is falsy.
 *
 * @param {string} language — 'en' | 'zh'
 */
export function broadcastLanguageChange(language) {
  if (!language) return;
  for (const eng of vpEngines.values()) {
    try { eng.setLanguage?.(language); } catch { /* best-effort */ }
  }
  try { session?.engine?.setLanguage?.(language); } catch { /* best-effort */ }
}

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

// ============================================================
// task-707: per-VP inbox + driver helpers (group multi-VP fix)
// ============================================================

/**
 * Get-or-create the per-VP Engine. Each VP owns its own Engine instance
 * so private state (`#currentAbortCtrl`, `#__queryCounter`, `#pendingT2`,
 * `#abortReason`, `#adjustRanByGroup`, `#execLog`) doesn't collide when
 * VP-A and VP-B run concurrent turns. All engines share the session's
 * adapter / trace / config / stores so memory recall, conversation
 * persistence, and tool registry remain consistent.
 *
 * @param {string} groupId
 * @param {string} vpId
 * @returns {import('./engine.js').Engine}
 */
function getOrCreateVpEngine(groupId, vpId) {
  const key = vpKey(groupId, vpId);
  let eng = vpEngines.get(key);
  if (eng) return eng;
  if (!session) throw new Error('getOrCreateVpEngine: session not loaded');
  eng = new Engine({
    adapter: session.adapter,
    trace: session.trace,
    config: session.config,
    conversationStore: session.conversationStore,
    memoryIndex: session.memoryIndex || null,
    amsRegistry: session.amsRegistry,
    toolRegistry: session.toolRegistry,
    skillManager: session.skillManager,
    mcpManager: session.mcpManager,
    yeaftDir: session.yeaftDir,
  });
  vpEngines.set(key, eng);
  return eng;
}

/**
 * Get-or-create the persistent per-group coordinator + router.
 *
 * The coordinator MUST be reused across user turns AND across in-flight
 * tool calls (route_forward) — its `deliver` callback is the only way
 * envelopes reach `vpInboxes`. If we recreated it per `handleUnifyGroupChat`
 * call (the pre-707 design), `route_forward` running mid-turn would
 * deliver into a doomed `captured[]` while the new dispatch ran against
 * a fresh coordinator. The persistent coordinator + module-level inboxes
 * close that gap.
 *
 * Caller is responsible for passing in a freshly-opened groupHandle on
 * first creation; subsequent calls reuse the cached coord.
 *
 * @param {string} groupId
 * @param {object} groupHandle — only used on first creation
 * @returns {{ coord: object, router: object, groupHandle: object }}
 */
function getOrCreateGroupContext(groupId, groupHandle) {
  let entry = groupContexts.get(groupId);
  if (entry) return entry;
  const coord = createCoordinator(groupHandle, {
    deliver: (vpId, envelope) => enqueueForVp(groupId, vpId, envelope),
  });
  const router = createRouter({ coordinator: coord });
  entry = { coord, router, groupHandle };
  groupContexts.set(groupId, entry);
  return entry;
}

/**
 * Push an envelope onto a VP's inbox and ensure its driver is running.
 *
 * Side effect: emits `vp_typing_start` immediately (NOT after the driver
 * picks up the envelope). This makes the UX match the user's expectation
 * — the typing indicator turns on the instant the message is queued, so
 * `route_forward` makes the target VP's typing dot light up before the
 * engine even starts that turn.
 *
 * @param {string} groupId
 * @param {string} vpId
 * @param {object} envelope — coordinator envelope `{groupId, taskId, msg, trigger}`
 */
function enqueueForVp(groupId, vpId, envelope) {
  const key = vpKey(groupId, vpId);
  let inbox = vpInboxes.get(key);
  if (!inbox) {
    inbox = [];
    vpInboxes.set(key, inbox);
  }
  // Mint a turnId now so the typing event the UI sees is paired with
  // the same id the driver uses when it later runs the turn.
  const turnId = `${randomUUID().slice(0, 8)}:${vpId}`;
  inbox.push({ envelope, turnId });

  // Typing fires on enqueue. The matching `vp_typing_end` is emitted by
  // the driver's runVpTurn `finally` block — every enqueue eventually
  // results in exactly one runVpTurn execution, so the per-VP counter
  // (`web/stores/helpers/vp-typing.js`) stays balanced.
  try {
    sendUnifyEvent({
      type: 'vp_typing_start',
      groupId,
      vpId,
      turnId,
      ts: Date.now(),
    }, { groupId, vpId, turnId });
  } catch { /* never crash WS pipeline */ }

  ensureDriverRunning(groupId, vpId);
}

/**
 * Spin up a driver loop for a VP if one isn't already running. Idempotent.
 * The driver pulls envelopes from the inbox one at a time and runs each
 * through `runVpTurn`. When the inbox empties, the driver exits and is
 * removed from `vpDrivers`. The next `enqueueForVp` will spawn a fresh
 * driver.
 *
 * Mirrors `sub-agent/runner.js`'s `driveSubAgent` shape: shift → run →
 * loop until empty. No internal sleep — all "wakeups" are driven by
 * external `enqueueForVp` calls.
 */
function ensureDriverRunning(groupId, vpId) {
  const key = vpKey(groupId, vpId);
  if (vpDrivers.has(key)) return;
  const promise = (async () => {
    while (true) {
      const inbox = vpInboxes.get(key);
      if (!inbox || inbox.length === 0) break;
      const { envelope, turnId } = inbox.shift();
      const vpAbort = new AbortController();
      vpAborts.set(key, vpAbort);
      // Mirror into turnAbortCtrls for the existing per-turn Stop button.
      turnAbortCtrls.set(turnId, vpAbort);
      // Snapshot history at the moment this turn starts. Later turns in
      // the same driver loop see updated history (post-append from the
      // previous turn).
      const baseSnapshot = [...conversationMessages];
      const trigger = envelope?.trigger || 'fallback';
      // Synthesize the prompt. For coordinator-emitted envelopes the
      // text lives at envelope.msg.text. We prefix `@vp-<id>` to mirror
      // the legacy fan-out path so the model sees the same surface form
      // it always has.
      const text = envelope?.msg?.text || '';
      const prompt = `@vp-${vpId} ${text}`;
      try {
        await runVpTurn({
          prompt,
          groupId,
          vpId,
          turnId,
          envelope,
          vpAbort,
          baseSnapshot,
        });
      } catch (err) {
        console.warn('[Unify] driveVp: runVpTurn failed', vpId, err?.message || err);
      } finally {
        turnAbortCtrls.delete(turnId);
        // Only clear the entry if it's still ours. A fresh user message
        // can install a new controller for this VP between our abort
        // and our finally (selective-abort pre-pass aborts the OLD
        // controller, then ingest enqueues a NEW envelope which mints
        // a fresh controller). Without this guard we'd drop the new
        // controller and a later abort-all wouldn't see it.
        if (vpAborts.get(key) === vpAbort) vpAborts.delete(key);
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
      // Emit a group_message event so the persisted message shows up in
      // the UI's group log AT THE POINT the turn actually ran (so a
      // queued envelope doesn't "appear" before the prior turn finished
      // its writes). Trigger reflects coord's classification. The emit
      // happens regardless of whether the turn aborted — the envelope
      // is real (coord persisted it before deliver), so the user log
      // should show it even if the assistant reply was cut short.
      try {
        if (text && envelope?.msg) {
          sendUnifyEvent({
            type: 'group_message',
            groupId,
            vpId,
            speakerVpId: vpId,
            text,
            mentions: Array.isArray(envelope?.msg?.mentions) ? envelope.msg.mentions : [],
            trigger,
            ts: Date.now(),
          }, { groupId, vpId, turnId });
        }
      } catch { /* never crash WS pipeline */ }
    }
    vpDrivers.delete(key);
    // Re-arm guard: the inbox could have been pushed into between the
    // top-of-loop empty check and this delete (synchronous re-entry
    // from a sendUnifyEvent listener, or a microtask scheduled while
    // we were in `finally`). Without this, the new envelope would be
    // stranded — `enqueueForVp` saw `vpDrivers.has(key)` return true
    // because we hadn't deleted yet, then we delete and exit. Self-
    // rearm if there is fresh work.
    const tail = vpInboxes.get(key);
    if (tail && tail.length > 0) ensureDriverRunning(groupId, vpId);
  })();
  vpDrivers.set(key, promise);
}

/**
 * Test-only: drain all currently-queued VP work to completion. Tests use
 * this as a barrier between "scenario triggered" and "now assert state".
 * Production code never calls this — driver lifecycles are tied to
 * inbox emptiness, not external signals.
 */
export async function __testDrainVpDrivers() {
  // Snapshot the in-flight driver promises and wait. New drivers
  // spawned during the wait (by route_forward inside a turn) get
  // picked up on the next iteration.
  while (vpDrivers.size > 0) {
    const promises = Array.from(vpDrivers.values());
    await Promise.all(promises.map((p) => p.catch(() => {})));
  }
}

/**
 * Test-only: reset all per-VP / per-group caches. Aborts in-flight
 * drivers and drains them before clearing so the next test doesn't see
 * a half-aborted controller writing to a now-cleared map.
 */
export async function __testResetVpState() {
  for (const ctrl of vpAborts.values()) {
    try { if (!ctrl.signal.aborted) ctrl.abort(); } catch { /* */ }
  }
  for (const inbox of vpInboxes.values()) {
    if (Array.isArray(inbox)) inbox.length = 0;
  }
  await __testDrainVpDrivers();
  vpInboxes.clear();
  vpDrivers.clear();
  vpEngines.clear();
  vpAborts.clear();
  groupContexts.clear();
}


/**
 * Send a unify_output message carrying claude_output-format data.
 * Envelope fields: conversationId, groupId, vpId, turnId — the last two
 * let the frontend route incremental deltas to the correct per-VP message block.
 */
function sendUnifyOutput(data, { groupId, vpId, turnId, featureId } = {}) {
  sendToServer({
    type: 'unify_output',
    conversationId: unifyConversationId,
    ...(groupId ? { groupId } : {}),
    ...(vpId ? { vpId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(featureId ? { featureId } : {}),
    data,
  });
}

/** Send a unify_output event (non-claude_output metadata). */
function sendUnifyEvent(event, { groupId, vpId, turnId, featureId } = {}) {
  sendToServer({
    type: 'unify_output',
    conversationId: unifyConversationId,
    ...(groupId ? { groupId } : {}),
    ...(vpId ? { vpId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(featureId ? { featureId } : {}),
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
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    const memoryRoot = yeaftDir ? join(yeaftDir, 'memory') : undefined;
    const { vpId } = createVp(payload || {}, memoryRoot ? { memoryRoot } : {});
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
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    const memoryRoot = yeaftDir ? join(yeaftDir, 'memory') : undefined;
    deleteVp(vpId, memoryRoot ? { memoryRoot } : {});
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
    const memoryRoot = yeaftDir ? join(yeaftDir, 'memory') : undefined;
    const group = createGroupFromSpec(yeaftDir, payload, memoryRoot ? { memoryRoot } : {});
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
    invalidateGroupContext(groupId);
    sendGroupCrudResult({ op: 'rename', requestId, ok: true, group });
    sendGroupSnapshotBroadcast();
  } catch (err) {
    sendGroupCrudResult({ op: 'rename', requestId, ok: false, error: groupErrorPayload(err) });
  }
}

/**
 * `unify_update_group` — generalised group meta patch. Currently accepts
 * `name` and `announcement` keys. Empty patch is rejected; an empty/
 * whitespace-only `name` is also rejected up front rather than letting
 * `renameGroup` raise a less-specific error deeper in the call stack.
 *
 * Partial-success contract: when a single patch contains BOTH `name` and
 * `announcement`, the rename is committed first; if the announcement
 * write throws, the rename has already persisted on disk and the client
 * receives `ok:false` for the announcement error — i.e. the WS op is not
 * atomic. Today's UI binds Save buttons per pane in `GroupSettingsModal`
 * so this is theoretical; readers extending the patch shape should know
 * the contract permits half-commits.
 */
export function handleUnifyUpdateGroup(msg) {
  const requestId = msg && msg.requestId;
  const groupId = msg && msg.groupId;
  const patch = (msg && msg.patch && typeof msg.patch === 'object') ? msg.patch : null;
  try {
    const hasName = patch && typeof patch.name === 'string' && patch.name.trim().length > 0;
    const hasAnnouncement = patch && typeof patch.announcement === 'string';
    if (!patch || (!hasName && !hasAnnouncement)) {
      throw new GroupCrudError('invalid_patch', groupId);
    }
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    let group = null;
    if (hasName) {
      group = renameGroup(yeaftDir, groupId, patch.name);
    }
    if (hasAnnouncement) {
      group = updateGroupAnnouncement(yeaftDir, groupId, patch.announcement);
    }
    invalidateGroupContext(groupId);
    sendGroupCrudResult({ op: 'update', requestId, ok: true, group });
    sendGroupSnapshotBroadcast();
  } catch (err) {
    sendGroupCrudResult({ op: 'update', requestId, ok: false, error: groupErrorPayload(err) });
  }
}

export function handleUnifyArchiveGroup(msg) {
  const requestId = msg && msg.requestId;
  const groupId = msg && msg.groupId;
  try {
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    const result = archiveGroup(yeaftDir, groupId);
    invalidateGroupContext(groupId);
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
    const memoryRoot = yeaftDir ? join(yeaftDir, 'memory') : undefined;
    const result = deleteGroup(yeaftDir, groupId, memoryRoot ? { memoryRoot } : {});
    // Cascade: remove every persisted message stamped with this group id.
    // Hard delete (per user spec): no soft-archive, the bytes are gone.
    // Skipped silently if the session/store isn't initialized — the next
    // CLI `--compact-orphans` run will sweep them as orphans.
    let messagesRemoved = 0;
    try {
      if (session && session.conversationStore) {
        messagesRemoved = session.conversationStore.deleteByGroup(groupId);
      }
    } catch (cascadeErr) {
      console.warn(`[Yeaft] cascade delete for group ${groupId} failed: ${cascadeErr.message}`);
    }
    // Drop the cached coord/router and abort/clear any in-flight VP
    // turns for the deleted group. Engines for the deleted group are
    // also dropped — unlike rename/announcement updates, the group is
    // gone for good and there's nothing to preserve.
    invalidateGroupContext(groupId);
    const prefix = `${groupId}::`;
    for (const k of Array.from(vpEngines.keys())) {
      if (k.startsWith(prefix)) vpEngines.delete(k);
    }
    sendGroupCrudResult({
      op: 'delete',
      requestId,
      ok: true,
      groupId: result.groupId,
      messagesRemoved,
    });
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
    invalidateGroupContext(groupId);
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
    invalidateGroupContext(groupId);
    // Also drop the kicked VP's engine — the next time they're added
    // back they should start with fresh per-VP state.
    vpEngines.delete(vpKey(groupId, vpId));
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
    invalidateGroupContext(groupId);
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
  // featureId may have just been published mid-turn by the FeatureArc
  // (the arc's observeEvent runs before this dispatch); pull it fresh
  // so the wire envelope tags every subsequent emit with the right id.
  const featureId = typeof hctx.getFeatureId === 'function' ? hctx.getFeatureId() : null;
  const envelope = {
    groupId: hctx.groupId,
    vpId: hctx.vpId,
    turnId: hctx.turnId,
    ...(featureId ? { featureId } : {}),
  };

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
    case 'stop':
      // No UI action needed; outer loop sends the final result.
      break;

    case 'turn_end':
      // When a tool (currently only `route_forward`) signals
      // requestEndTurn, the engine emits turn_end with
      // stopReason='tool_handoff' and a structured `detail` payload.
      // Surface that to the frontend as a `group_handoff` event so the
      // originating VP's bubble can render "↪ 已转交给 @vp-b、@vp-c".
      // Other turn_end variants are ignored (the outer loop handles
      // result/end_turn semantics already).
      //
      // The `version` field is the wire schema version. Today there is
      // only one shape. Future variants (e.g. a second hand-off tool)
      // can bump it without breaking older frontends — they ignore
      // unknown versions.
      if (event.stopReason === 'tool_handoff' && event.detail && typeof event.detail === 'object') {
        const detail = event.detail;
        if (detail.kind === 'route_forward') {
          sendUnifyEvent({
            type: 'group_handoff',
            version: 1,
            kind: 'route_forward',
            fromVpId: detail.fromVpId || hctx.vpId,
            toVpIds: Array.isArray(detail.dispatched) ? detail.dispatched.slice() : [],
            broadcast: Boolean(detail.broadcast),
            text: typeof detail.text === 'string' ? detail.text : '',
            reason: detail.reason || null,
            ts: Date.now(),
          }, envelope);
        }
      }
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
        const seeded = seedDefaultGroup(yeaftDir, { memoryRoot: join(yeaftDir, 'memory') });
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
  let rosterMutated = false;
  try {
    const meta = groupHandle.getMeta();
    const wantsAdd = mentions.filter(
      (m) => m && m !== 'all' && !meta.roster.includes(m)
    );
    if (wantsAdd.length) {
      for (const vpId of wantsAdd) {
        try {
          const vp = readVp(vpId);
          if (!vp) continue;
          addMember(yeaftDir, groupId, vpId);
          rosterMutated = true;
        } catch { /* skip strangers */ }
      }
      if (rosterMutated) {
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
        rosterMutated = true;
      } catch { /* best-effort */ }
    }
  } catch (err) {
    console.warn('[Unify] unify_group_chat: auto-roster heal failed', err?.message || err);
  }

  // task-707: per-group persistent coordinator/router. Created once per
  // groupId; reused across user messages AND across in-flight tool calls
  // (route_forward delivers via this same coord). If the roster mutated
  // we replace the cached coord so it points at the freshly-opened
  // groupHandle.
  if (rosterMutated) {
    groupContexts.delete(groupId);
  }
  const groupCtx = getOrCreateGroupContext(groupId, groupHandle);
  const coord = groupCtx.coord;

  // Selective abort — replace the pre-707 blanket abort that killed
  // every in-flight turn on every new user message (Bug 2). We peek at
  // which VPs THIS message will retrigger via the coordinator's
  // `parseMentions` and only abort those VP's current turns. VPs busy
  // on unrelated work keep running.
  //
  // Intentional limitation: we do NOT walk the route_forward causedBy
  // chain. If VP-A is mid-turn, route_forwarded to VP-B, and the user
  // now mentions only @vp-a, we abort VP-A but VP-B keeps generating
  // even though VP-B's inbound was caused by the now-overridden VP-A
  // turn. The argument for letting VP-B run: VP-B may already have
  // useful work in flight (a partial reply); aborting it on a chain
  // override discards that work for no user-visible benefit. If a
  // future product decision wants to cancel transitively, walk
  // `vpInboxes[*].envelope.causedBy` against the selectively-aborted
  // VP set and fan the abort out.
  //
  // Note: this is a best-effort pre-pass. The real dispatch list comes
  // from `coord.ingest(...).dispatched` below, but at that point we
  // would already have called deliver() and started new typing events
  // for the same VPs we're about to abort — racy. Using the pre-pass
  // result keeps the abort window before any deliver() side effects.
  try {
    const meta = groupHandle.getMeta();
    const willTarget = mentions.includes('all')
      ? meta.roster.slice()
      : mentions.filter((m) => meta.roster.includes(m));
    for (const vpId of willTarget) {
      const k = vpKey(groupId, vpId);
      const ctrl = vpAborts.get(k);
      if (ctrl && !ctrl.signal.aborted) {
        try { ctrl.abort(); } catch { /* best-effort */ }
      }
      // Also drop any queued envelopes for VPs being replaced — the
      // user's new message supersedes them.
      const inbox = vpInboxes.get(k);
      if (inbox && inbox.length > 0) {
        inbox.length = 0;
      }
    }
  } catch (err) {
    console.warn('[Unify] unify_group_chat: selective abort pre-pass failed', err?.message || err);
  }

  // Ingest user text. The coordinator persists, applies mention/fanout
  // rules, and calls deliver() (== enqueueForVp) for each chosen VP —
  // which both (a) emits vp_typing_start and (b) ensures a driver runs.
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
  const fallbackId = typeof report?.fallback === 'string' ? report.fallback : null;
  if (dispatchedIds.length === 0 && !fallbackId) {
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

  // Wait for the drivers initially scheduled by THIS user message to
  // drain. We pass the dispatched id list (plus any fallback) for
  // documentation; the wait function itself blocks on every driver in
  // the group, so route_forward fan-outs the user didn't mention still
  // get drained before we return.
  const primaryTargets = dispatchedIds.length > 0
    ? dispatchedIds.slice()
    : (fallbackId ? [fallbackId] : []);
  await waitForVpDrivers(groupId, primaryTargets);

  // Post-turn compaction. Triggers when the JUST-APPENDED turn pushed
  // history past 20 turns / 80K tokens. Runs in the background — does
  // not block the response to this message. The next user message
  // awaits `_compactInFlight` at the entry gate (handleUnifyGroupChat
  // top), so the swap is guaranteed to be observed before the next
  // baseSnapshot capture. Errors are swallowed; next turn retries.
  scheduleCompactAfterTurn(groupId);
}

/**
 * Wait for the drivers of `primaryTargets` AND any drivers spawned by
 * their downstream route_forward chains to all complete. We re-poll
 * because a route_forward inside VP-A's turn enqueues VP-B, which spawns
 * a new driver while we're waiting for VP-A. Loop terminates when every
 * group-local driver is idle.
 *
 * `primaryTargets` is informational — for filtering we wait on EVERY
 * driver in the group, since route_forward fan-out targets the user
 * never directly mentioned still need to drain before this user message
 * is considered handled.
 *
 * Bounded by the per-driver QUERY_TIMEOUT_MS that runVpTurn enforces,
 * so even a misbehaving model can't pin this forever.
 */
async function waitForVpDrivers(groupId, _primaryTargets) {
  while (true) {
    // Snapshot the current set of drivers belonging to this group.
    const promises = [];
    const prefix = `${groupId}::`;
    for (const [key, p] of vpDrivers.entries()) {
      if (key.startsWith(prefix)) promises.push(p);
    }
    if (promises.length === 0) return;
    await Promise.all(promises.map((p) => p.catch(() => {})));
    // Re-check: if a route_forward in one of the awaited turns
    // enqueued more work for another VP, a new driver may have been
    // started. Loop again. Otherwise exit.
  }
}

/**
 * Build the per-query VP context for the Engine.
 *
 * @param {object} args
 * @param {string} args.vpId
 * @param {object} args.groupCoordinator — the persistent coordinator for the
 *   group; used here for `group.getMeta()` (defaultVpId, announcement) and
 *   to bind the per-group router into toolCtx.
 * @param {string} [args.groupId]
 * @param {object} [args.envelope] — the inbound coordinator envelope that
 *   triggered this turn. Threaded into toolCtx as `inboundEnvelope` so
 *   `route_forward` can extend `causedBy` chains correctly. Optional only
 *   for pre-707 callers that no longer exist in production.
 */
export function buildVpQueryOpts({ vpId, groupCoordinator, groupId, envelope }) {
  // Read the group meta once and reuse for both defaultVpId fallback and
  // announcement injection. Each .getMeta() reload reads + parses the
  // group.json file, so calling it twice per turn is wasteful — and
  // (more importantly) opens a window where a concurrent group edit
  // could land between the two reads, giving the engine a defaultVpId
  // from one snapshot and an announcement from a newer one.
  let groupMeta = null;
  try {
    groupMeta = groupCoordinator && groupCoordinator.group
      && typeof groupCoordinator.group.getMeta === 'function'
      ? groupCoordinator.group.getMeta() : null;
  } catch { /* coordinator inspection is best-effort */ }

  let resolvedVpId = vpId;
  if (!resolvedVpId) {
    if (groupMeta && typeof groupMeta.defaultVpId === 'string' && groupMeta.defaultVpId) {
      resolvedVpId = groupMeta.defaultVpId;
    }
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
  // task-334-group-editor: surface the group announcement to the engine so
  // buildWorkerPrompt can inject it as a CLAUDE.md-style shared prefix.
  // Empty/missing reads as '' and prompts.js skips the section.
  if (groupMeta && typeof groupMeta.announcement === 'string') {
    out.groupAnnouncement = groupMeta.announcement;
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
  // task-707: thread the inbound envelope into toolCtx so `route_forward`
  // can stamp `causedBy` chains and the loop guard can key per-sender
  // throttling against the originating envelope. Safe to omit on a
  // user-initiated turn — route_forward will fall back to a synthetic
  // envelope inside router.forward.
  if (envelope && typeof envelope === 'object') {
    out.inboundEnvelope = envelope;
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

  restoreHistoryFromRecent(session.conversationStore.loadRecent());

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
 * Private — only the per-VP driver in `ensureDriverRunning` calls this.
 * Each VP-turn gets its own AbortController (`vpAbort`) so it can be
 * stopped individually. The shared `baseSnapshot` is the conversation
 * history at fan-out start — no VP sees another VP's in-flight output.
 * After the turn finishes (or is aborted), the VP's output is atomically
 * appended to `conversationMessages`.
 *
 * task-707: takes a coordinator `envelope` rather than the coordinator
 * itself; the persistent coord lives in `groupContexts[groupId]`. Uses
 * `getOrCreateVpEngine(groupId, vpId)` so each VP runs against its own
 * Engine instance — private state (`#currentAbortCtrl`, `#__queryCounter`,
 * `#pendingT2`, `#abortReason`, `#adjustRanByGroup`, `#execLog`) does not
 * collide when VP-A and VP-B run concurrent turns.
 *
 * @param {{ prompt: string, groupId: string, vpId: string, turnId: string, envelope: object, vpAbort: AbortController, baseSnapshot: Array }} args
 */
async function runVpTurn({ prompt, groupId, vpId, turnId, envelope: inboundEnvelope, vpAbort, baseSnapshot }) {
  if (!prompt?.trim()) return;

  const envelope = { groupId, vpId, turnId };
  // Arc is declared at outer-try scope so the catch / finally branches
  // below can call `arc.finalize({status:'aborted'|'error'})` after a
  // throw escaping the inner try. It's null until the inner try
  // populates it; all catch-side calls guard with `arc?.finalize?.`.
  let arc = null;

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
      // PR-4 (review fix): hoist `vpEngine` so the `finally` can clear
      // the per-turn featureId accessor on the SAME engine instance
      // we installed it on — even if the VP was kicked or its group
      // deleted mid-turn (both code paths call `vpEngines.delete(...)`).
      // Calling `getOrCreateVpEngine` again from `finally` would
      // resurrect a zombie engine for a VP that no longer exists.
      let vpEngine = null;

      // task-707: per-VP engine + persistent group coord. The coord is
      // created in handleUnifyGroupChat via getOrCreateGroupContext and
      // cached on `groupContexts`; we pull it here so route_forward
      // (router built from this same coord) lands envelopes back on the
      // right inbox set.
      const groupCtx = groupContexts.get(groupId);
      const groupCoordinator = groupCtx?.coord || null;
      const queryOpts = buildVpQueryOpts({
        vpId,
        groupCoordinator,
        groupId,
        envelope: inboundEnvelope,
      });

      // ── Dual-track feature arc ──
      // Track A (quick-response) runs concurrently against the same
      // primary model with a non-looping single call; its preview is
      // surfaced to the user immediately via `quick_preview` so they
      // see *something* within ~1s. Three signals (Track A intent,
      // ≥3 engine loops, key tool call) auto-create a Feature record
      // and the wire envelope starts tagging emits with `featureId`,
      // letting the frontend fold subsequent messages into a pill.
      arc = createFeatureArc({
        adapter: session?.adapter || null,
        model: session?.config?.model || null,
        featureStore: getFeatureStore(),
        prompt,
        vpId,
        groupId: groupId || null,
        turnId,
        vpDisplayName: queryOpts?.vpPersona?.displayName || vpId,
        language: session?.config?.language || 'en',
        signal: vpAbort.signal,
        emit: {
          quickPreview: ({ intent, preview }) => {
            sendUnifyEvent({
              type: 'quick_preview',
              intent,
              preview,
              vpId,
              turnId,
            }, envelope);
          },
          featureStarted: ({ featureId, title, trigger, toolName }) => {
            sendUnifyEvent({
              type: 'feature_started',
              featureId,
              title,
              trigger,         // 'quick' | 'turns' | 'tool'
              toolName: toolName || null,
              vpId,
              turnId,
            }, { ...envelope, featureId });
          },
          featureCompleted: ({ featureId, summary, status }) => {
            sendUnifyEvent({
              type: 'feature_completed',
              featureId,
              summary,
              status,            // 'completed' | 'aborted' | 'error'
              vpId,
              turnId,
            }, { ...envelope, featureId });
          },
        },
      });
      // Fire-and-forget — Track A produces its preview / decision when
      // ready; the main engine loop must not be held back waiting for it.
      arc.startTrackA();

      // PR-4: let sub-agents spawned during this turn inherit the
      // parent's active featureId. Read lazily inside the engine's
      // parentEngineDeps so a feature that opens AFTER a sub-agent
      // spawns still tags the sub-agent's later events. Cleared in the
      // `finally` below so a stale `arc` reference doesn't leak into
      // the next turn.
      vpEngine = getOrCreateVpEngine(groupId, vpId);
      if (typeof vpEngine.setCurrentFeatureIdAccessor === 'function') {
        vpEngine.setCurrentFeatureIdAccessor(() => {
          try { return arc?.getFeatureId?.() || null; } catch { return null; }
        });
      }

      const handlerCtx = {
        assistantTextParts,
        toolCallsAccum,
        toolResultsAccum,
        resetQueryTimer,
        groupId,
        vpId,
        turnId,
        // Lets handleEngineEvent stamp the latest featureId on each
        // outgoing envelope; the arc may publish it mid-turn.
        getFeatureId: () => arc.getFeatureId(),
      };
      // Always trim the snapshot before passing to engine.query. This is
      // the second-line defense (history-compact only fires above 30K
      // tokens — small chats with many turns still bloat the messages
      // array). See `trimSnapshotForBudget` doc-block for policy.
      const trimmedMessages = trimSnapshotForBudget(baseSnapshot, {
        messageTokenBudget: session?.config?.messageTokenBudget,
      });
      for await (const event of vpEngine.query({
        prompt,
        messages: trimmedMessages,
        signal: vpAbort.signal,
        ...queryOpts,
      })) {
        resetQueryTimer();
        // Arc observes BEFORE dispatch so featureId (if just published)
        // is available when handleEngineEvent stamps the envelope.
        try { arc.observeEvent(event); } catch (err) {
          console.warn('[FeatureArc] observe failed:', err?.message || err);
        }
        handleEngineEvent(event, handlerCtx);
      }

      // Turn completed — atomically append this VP's output to shared history.
      appendTurnToHistory(prompt, assistantTextParts, toolCallsAccum, toolResultsAccum);

      // Close the arc: if a feature was opened during the turn, run the
      // summary call and write status='completed' back to FeatureStore.
      // Awaited so the `feature_completed` event reaches the frontend
      // before the final 'result' bubble (UI ordering matters: the pill
      // should reach its done state before the turn is marked done).
      try { await arc.finalize({ status: 'completed' }); } catch (err) {
        console.warn('[FeatureArc] finalize failed:', err?.message || err);
      }

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
      // PR-4 (review fix): clear the accessor on the SAME engine
      // instance we installed it on. Reusing the captured reference
      // (instead of calling getOrCreateVpEngine again) avoids
      // resurrecting a zombie engine if the VP/group was torn down
      // mid-turn. `vpEngine` is null only when the install path threw
      // before the engine lookup (very early failure) — in that case
      // there's nothing to clear.
      try {
        if (vpEngine && typeof vpEngine.setCurrentFeatureIdAccessor === 'function') {
          vpEngine.setCurrentFeatureIdAccessor(null);
        }
      } catch { /* best-effort */ }
    }
  } catch (err) {
    const isAbort = err && (err.name === 'AbortError' || err.name === 'LLMAbortError');
    if (isAbort) {
      // Best-effort close: mark the feature aborted so the frontend pill
      // settles into the right terminal state instead of staying active.
      try { await arc?.finalize?.({ status: 'aborted' }); } catch { /* ignore */ }
      sendUnifyOutput({
        type: 'result',
        result_text: '',
        stopped: true,
      }, envelope);
      return;
    }

    console.error('[Unify] query error:', err);
    try { await arc?.finalize?.({ status: 'error' }); } catch { /* ignore */ }

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
  // when the conversation is still small. Mirrors the policy that
  // `runCompactNow` will apply: 30K soft floor / 40 % of configured
  // context / 200K hard ceiling. (The turn-count trigger is off by
  // default — DEFAULT_TURN_LIMIT=Infinity — pin `turnLimit` via opts
  // to re-enable it.)
  const maxContextTokens =
    typeof session?.config?.maxContextTokens === 'number'
      ? session.config.maxContextTokens
      : undefined;
  const triage = shouldCompactHistory(conversationMessages, { maxContextTokens });
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

  // Pull the user-configured context width so the 40 %-of-context
  // threshold auto-adjusts to whatever model they're on. Falls back to
  // the module default when missing.
  const maxContextTokens =
    typeof session?.config?.maxContextTokens === 'number'
      ? session.config.maxContextTokens
      : undefined;

  try {
    const result = await compactHistory(snapshot, { summarize, maxContextTokens });
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
 * Abort every in-flight VP turn and clear all queued envelopes across
 * every group. Shared by `handleUnifyAbortThread` and
 * `handleUnifyAbortAll` — both have the same "stop everything" intent
 * after the H2.f.2 collapse to single-conversation. Pushes
 * `vp:<key>` strings into the supplied `aborted` array for the
 * unify_aborted event.
 *
 * @param {string[]} aborted — output array, mutated in place
 */
function abortAllVpRuntime(aborted) {
  for (const [key, ctrl] of vpAborts) {
    try {
      if (!ctrl.signal.aborted) { ctrl.abort(); aborted.push(`vp:${key}`); }
    } catch { /* best-effort */ }
  }
  vpAborts.clear();
  for (const inbox of vpInboxes.values()) {
    if (Array.isArray(inbox)) inbox.length = 0;
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
  abortAllVpRuntime(aborted);
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
  abortAllVpRuntime(aborted);
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
  // `lim` is now expressed in TURNS, not raw messages. `loadRecent` and
  // `loadRecentByGroup` use turn-based slicing so the cut never lands
  // mid-tool-arc. Pass `undefined` to use the persistence-layer default
  // (DEFAULT_RECENT_TURNS = 20 turns).
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

    restoreHistoryFromRecent(pickRecent(session.conversationStore, undefined));
  } else if (groupId) {
    // Re-entering an existing session with a (possibly new) group filter:
    // re-seed the engine's flat history so it doesn't carry messages from
    // another group into the next turn's context.
    restoreHistoryFromRecent(pickRecent(session.conversationStore, undefined));
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

  // `msg.limit` is the replay-scrollback request from the frontend (UI
  // history pane, not engine context). Semantics changed (2026-05-01):
  // now expressed in TURNS. The previous default (50 messages) maps to
  // ~20–25 turns; in the turn-count world 50 turns of UI scrollback is
  // still cheap and matches what the frontend already passes through.
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
  // Re-arm the permission warning. The user might have fixed the
  // ~/.yeaft/ permissions in the interim and is now restarting the
  // session — they should see the diagnostic again if it still fails.
  _permissionDiagnosticSent = false;
  // Drop all per-VP / per-group transient state when the session is
  // replaced. Drivers may still be running with a stale engine
  // reference; abort them so they exit cleanly. The new session gets
  // fresh inboxes / engines / coords on first dispatch.
  for (const [, ctrl] of vpAborts) {
    try { if (!ctrl.signal.aborted) ctrl.abort(); } catch { /* best-effort */ }
  }
  vpAborts.clear();
  vpInboxes.clear();
  vpDrivers.clear();
  vpEngines.clear();
  groupContexts.clear();

  try {
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    session = await loadSession({
      ...(yeaftDir && { dir: yeaftDir }),
      skipMCP: false,
      skipSkills: false,
    });
    installUnifyRuntimeBridge(session);

    unifyConversationId = `unify-${Date.now()}`;

    restoreHistoryFromRecent(session.conversationStore.loadRecent());

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
