/**
 * web-bridge.js — Bridge between web UI and Yeaft Unify Engine.
 *
 * PR #797: group VP runtime is threaded again. Each group VP can own multiple
 * classified threads, keyed by (groupId, vpId, threadId), with separate engine,
 * inbox, abort, todo, persistence, and frontend timeline boundaries. Legacy
 * 1:1 chat paths still use the default `main` thread.
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
  resolveGroupYeaftDir,
  groupsRoot,
} from './groups/group-crud.js';
import { openGroup, loadGroupMeta } from './groups/group-store.js';
import { loadGroupConfig, resolveGroupConfig, GroupConfigError } from './groups/group-config.js';
import { updateGroupConfig } from './groups/group-crud.js';
import { createCoordinator } from './groups/coordinator.js';
import { seedDefaultGroup } from './groups/seed-default.js';
import {
  trimSnapshotForBudget,
} from './history-compact.js';
import { persistUnifyAttachments, attachmentsForPersistence, persistedAttachmentPreviewPayload } from './attachments.js';
import { parseSeqFromId } from './conversation/persist.js';
import { sliceLastNTurns } from './turn-utils.js';
import { createVpStatusBroker } from './vp-status-broker.js';
import { classifyThread as defaultClassifyThread, fallbackTitle } from './vp/thread-classifier.js';

/** @type {import('./session.js').Session | null} */
let session = null;

let threadClassifier = defaultClassifyThread;

/** Test-only: replace the lightweight VP thread classifier. */
export function __testSetThreadClassifier(fn) {
  threadClassifier = typeof fn === 'function' ? fn : defaultClassifyThread;
}

/**
 * Tracks scoped-dream triggers that are currently inflight, keyed by
 * groupId. Used by `handleUnifyDreamTrigger` to reject any overlapping
 * scoped trigger rather than racing the sink-wrapping logic against
 * itself.
 *
 * Cross-group overlap is rejected (not just same-group): under the
 * existing dream scheduler a second concurrent trigger silently shares
 * the first's inflight promise and dropped its own scope filter. So
 * "B during A's run" doesn't actually produce a separate scoped pass
 * for B — letting B install a second sink wrapper would only mis-stamp
 * A's events with B's groupId. Reporting B as an explicit skipped
 * result is the honest answer; the user can re-click after A settles.
 * @type {Set<string>}
 */
const inflightScopedDreamGroups = new Set();

/**
 * Single in-flight AbortController for legacy 1:1 chat. A new 1:1 user message
 * cancels the prior round (if any).
 *
 * Group VP turns do not flow through this slot. They each get their own
 * controller in `vpAborts` keyed by `${groupId}::${vpId}::${threadId}`.
 * The `currentAbortCtrl` here is only mutated by 1:1 chat paths, the test
 * seeder, and the session-reset cleanup. Don't reach for it from group-flow
 * code; selective abort, abort-all, and abort-turn already operate against
 * group/thread abort maps correctly.
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
 * Per-turn runtime ownership. Targeted thread aborts use this instead of
 * blindly aborting every turn controller in the process.
 * @type {Map<string, { groupId: string, vpId: string, threadId: string, key: string }>}
 */
const turnAbortMeta = new Map();

/**
 * Per-VP status broker — the agent-side authority for VP timeline
 * status. Lazy-initialized on first use because `sendUnifyEvent` is
 * declared below; trying to call it at module top-level would crash
 * with a TDZ error during agent boot.
 *
 * Every transition (typing → thinking → streaming → tool → idle) is
 * pushed through `vpStatusBroker.transition(...)`. The broker also
 * owns the `vp_status_snapshot` payload for reconnect.
 *
 * @type {ReturnType<typeof createVpStatusBroker> | null}
 */
let vpStatusBroker = null;
function getVpStatusBroker() {
  if (!vpStatusBroker) {
    vpStatusBroker = createVpStatusBroker({
      send: (event) => {
        // The broker emits both `vp_status_changed` and
        // `vp_status_snapshot`. Both ride the standard sendUnifyEvent
        // envelope so the frontend's existing unify_output dispatcher
        // sees them. We stamp groupId/vpId on the envelope for
        // events that target a specific VP so the server's per-client
        // routing (groupId scoping, etc.) works the same way as
        // typing events.
        const env = {};
        if (event && typeof event === 'object') {
          if (event.groupId) env.groupId = event.groupId;
          if (event.vpId) env.vpId = event.vpId;
          if (event.turnId) env.turnId = event.turnId;
        }
        sendUnifyEvent(event, env);
      },
    });
  }
  return vpStatusBroker;
}

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
 *   2. Each VP thread gets its own Engine (via `vpEngines`) so private state
 *      (`#currentAbortCtrl`, `#__queryCounter`, `#pendingT2`,
 *      `#abortReason`, `#adjustRanByGroup`, `#execLog`, `#currentThreadId`)
 *      does not collide across concurrent VP turns. Engines are keyed by
 *      `${groupId}::${vpId}::${threadId}` rather than vpId alone because
 *      Engine cannot serve two concurrent queries safely — even if AMS state
 *      partitions correctly by groupKey, the non-group-keyed private state
 *      would collide if the same VP ran turns in two groups or two threads
 *      in parallel.
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
 * Per-(groupId, vpId) current TodoWrite list. Each VP in a group keeps
 * its own todo state so two VPs in the same group can independently
 * track multi-step tasks without overwriting each other. Threaded into
 * the engine's tool ctx via buildVpQueryOpts → getCurrentTodos /
 * setCurrentTodos closures. Best-effort in-memory cache only — todos
 * are also stamped into the LLM event stream (the frontend reads from
 * the tool_use input, not from this map), so a server restart simply
 * loses the "what was the most recent list?" peek without breaking the
 * UI replay.
 *
 * Key: `${groupId}::${vpId}` (matches vpEngines/vpAborts convention).
 * Value: `Array<{content, status, activeForm}>` — the last full list
 * the VP wrote with TodoWrite.
 *
 * @type {Map<string, Array<{content: string, status: string, activeForm: string}>>}
 */
const vpCurrentTodos = new Map();
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

function threadKey(groupId, vpId, threadId) {
  return `${groupId}::${vpId}::${threadId || 'main'}`;
}

function createThreadId() {
  return `thr_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

const RUNNING_THREAD_STATES = new Set(['queued', 'typing', 'thinking', 'streaming', 'tool']);
/** @type {Map<string, Map<string, object>>} */
const vpThreads = new Map();
/** @type {Map<string, Set<Promise<string|null>>>} */
const routePromisesByMsgId = new Map();

function getVpThreadMap(groupId, vpId) {
  const key = vpKey(groupId, vpId);
  let map = vpThreads.get(key);
  if (!map) {
    map = new Map();
    vpThreads.set(key, map);
  }
  return map;
}

function getRunningThreads(groupId, vpId) {
  return Array.from(getVpThreadMap(groupId, vpId).values())
    .filter(t => t && RUNNING_THREAD_STATES.has(t.status));
}

function getOrCreateVpThread({ groupId, vpId, threadId, title }) {
  const map = getVpThreadMap(groupId, vpId);
  const id = threadId || createThreadId();
  let thread = map.get(id);
  const now = Date.now();
  if (!thread) {
    thread = {
      threadId: id,
      groupId,
      vpId,
      status: 'queued',
      title: title || '新任务',
      createdAt: now,
      updatedAt: now,
      messageIds: [],
      pendingQueries: [],
      recentMessages: [],
      engine: null,
    };
    map.set(id, thread);
  } else if (title && !thread.title) {
    thread.title = title;
  }
  thread.updatedAt = now;
  return thread;
}

function rememberThreadMessage(thread, msg) {
  if (!thread || !msg) return;
  if (msg.id) thread.messageIds.push(msg.id);
  const text = msg.text || msg.content || '';
  if (text) {
    thread.recentMessages.push({ role: msg.role || 'user', text: String(text).slice(0, 500) });
    if (thread.recentMessages.length > 8) thread.recentMessages.splice(0, thread.recentMessages.length - 8);
  }
  thread.updatedAt = Date.now();
}

function registerRoutePromise(msgId, promise) {
  if (!msgId) return;
  let set = routePromisesByMsgId.get(msgId);
  if (!set) {
    set = new Set();
    routePromisesByMsgId.set(msgId, set);
  }
  set.add(promise);
  promise.finally(() => set.delete(promise)).catch(() => {});
}


function buildVpPromptPayload(vpId, envelope) {
  const text = envelope?.msg?.text || '';
  const inboundSuffix = envelope?._promptSuffix || '';
  const inboundParts = Array.isArray(envelope?._promptParts) ? envelope._promptParts : [];
  const prompt = `@vp-${vpId} ${text}${inboundSuffix}`;
  const promptParts = inboundParts.length > 0
    ? [...inboundParts, { type: 'text', text: prompt }]
    : null;
  return { text, prompt, promptParts };
}

function threadSnapshotForClassifier(thread) {
  return {
    threadId: thread.threadId,
    title: thread.title || '',
    status: thread.status || '',
    updatedAt: thread.updatedAt || null,
    recentMessages: Array.isArray(thread.recentMessages) ? thread.recentMessages.slice(-6) : [],
    summary: thread.summary || '',
  };
}

function readVpForClassifier(vpId) {
  try {
    const vp = readVp(vpId);
    return vp ? { vpId, ...vp } : { vpId };
  } catch {
    return { vpId };
  }
}

async function waitForRoutePromises(msgId) {
  if (!msgId) return;
  const set = routePromisesByMsgId.get(msgId);
  if (!set || set.size === 0) return;
  await Promise.all(Array.from(set).map((p) => p.catch(() => null)));
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
  for (const [turnId, meta] of Array.from(turnAbortMeta.entries())) {
    if (meta?.groupId !== groupId) continue;
    turnAbortCtrls.delete(turnId);
    turnAbortMeta.delete(turnId);
  }
  for (const [k, inbox] of vpInboxes) {
    if (!k.startsWith(prefix)) continue;
    if (Array.isArray(inbox)) inbox.length = 0;
  }
  for (const k of Array.from(vpThreads.keys())) {
    if (k.startsWith(prefix)) vpThreads.delete(k);
  }
  // Reap per-(group,vp) TodoWrite snapshots for this group so a
  // deleted/renamed group doesn't pin a stale checklist forever.
  for (const k of vpCurrentTodos.keys()) {
    if (k.startsWith(prefix)) vpCurrentTodos.delete(k);
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

/**
 * Secondary watchdog grace period (ms).
 *
 * After {@link QUERY_TIMEOUT_MS} of silence the per-VP `vpAbort` is fired.
 * That's enough on its own when adapters / tools cooperate with the
 * AbortSignal — the engine throws `AbortError`, runVpTurn's catch emits
 * `result{stopped:true}`, the driver `finally` emits `vp_typing_end`, and
 * the user is unstuck.
 *
 * If a tool ignores `signal` and never resolves, the engine generator's
 * `await tool.execute(...)` is permanently blocked: the abort fires on a
 * controller it never observes, and runVpTurn never returns. The same
 * applies to an adapter `stream()` that ignores `signal` (e.g. a stuck
 * SSE connection) or to tools that legitimately opt out of the per-tool
 * timeout via `timeoutMs <= 0`. The per-tool timeout in
 * {@link import('./tools/registry.js').DEFAULT_TOOL_TIMEOUT_MS}
 * is the primary cure for the tool-ignore-signal case; this bridge-level
 * escalation strictly extends it to cover the adapter and opt-out cases.
 * Without a second-stage escalation the typing dots hang forever —
 * exactly the "halts mid-execution with no turn_end" symptom.
 *
 * The driver loop wraps `await runVpTurn(...)` in a Promise.race against
 * this grace-window timer. If runVpTurn doesn't return within
 * QUERY_TIMEOUT_MS + ESCALATE_AFTER_ABORT_MS, the driver forces its
 * `finally` block (vp_typing_end + group_message), emits a synthetic
 * `result{stopped:true}` so the frontend leaves its in-flight state,
 * and moves on. The hung tool promise leaks (JS lacks cooperative
 * promise cancellation) but the user-facing turn is closed.
 *
 * 15s is wide enough that legitimate "abort took a moment to propagate"
 * paths (network teardown, finally cleanup) finish first; tight enough
 * that a truly stuck tool doesn't stretch the user-visible stall to
 * minutes.
 */
const ESCALATE_AFTER_ABORT_MS = 15_000;

/** Virtual conversationId for the Unify session */
let unifyConversationId = null;

/** task-334-followup-batch-b: stored unsubscribe fn from VP subscribe,
 *  called on session reset to prevent stale subscriber leaks. */
let _vpUnsubscribe = null;

/**
 * Per-group conversation history lives on the GroupContext entry
 * (`groupContexts.get(groupId).history`). The pre-refactor module-level
 * `conversationMessages` was a single array shared across every group —
 * a user prompt in group-A would leak into group-B's next-turn snapshot
 * because the bridge appended every turn to the same array regardless
 * of which group it belonged to. Disk was group-tagged correctly, but
 * the in-memory tape was unified.
 *
 * Post-refactor: each GroupContext owns its own `history`, lazily
 * hydrated from `conversationStore.loadRecentByGroup(groupId)` on first
 * access. Group-A and group-B are isolated.
 *
 * @typedef {Array<{role:'user'|'assistant'|'tool', content:string|Array, toolCalls?:Array, toolCallId?:string, isError?:boolean}>} GroupHistory
 */

/**
 * @typedef {Object} GroupContextEntry
 * @property {object|null} coord — group coordinator (lazily built by getOrCreateGroupContext)
 * @property {object|null} router — message router (lazily built by getOrCreateGroupContext)
 * @property {object|null} groupHandle — opened group handle (lazily built by getOrCreateGroupContext)
 * @property {GroupHistory} history — per-group conversation tape
 * @property {boolean} historyHydrated — true once history has been loaded
 *   from disk (or explicitly assigned). The flag is required because an
 *   empty array is legitimate post-consolidate / post-clear state and
 *   MUST NOT trigger a re-hydrate. Without the flag, a partial entry
 *   would short-circuit `getOrCreateGroupHistory` on truthy `[]` and skip
 *   the disk load.
 */

/** Build a fresh stub entry with no coord/router/history loaded. */
function makeGroupContextStub() {
  return {
    coord: null,
    router: null,
    groupHandle: null,
    history: [],
    historyHydrated: false,
  };
}

/**
 * Parse persisted content that may have been stringified from provider content
 * blocks, then return only user-visible text. Image/file binary blocks are UI
 * metadata and must never be rendered as bubble text; attachment chips ride in
 * `attachments` instead.
 *
 * @param {unknown} content
 * @returns {string}
 */
export function __testNormalizePersistedVisibleContent(content) {
  let value = content;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
      try { value = JSON.parse(trimmed); } catch { value = content; }
    }
  }

  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        if (part.type === 'text' && typeof part.text === 'string') return part.text;
        if (part.type === 'input_text' && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('')
      .replace(/\n\n\[Uploaded files\][\s\S]*$/m, '')
      .trim();
  }

  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text.trim();
    if (typeof value.content === 'string') return value.content.trim();
    return '';
  }

  return typeof value === 'string'
    ? value.replace(/\n\n\[Uploaded files\][\s\S]*$/m, '').trim()
    : '';
}

function isPersistedInternalMessage(m) {
  if (!m) return true;
  if (m._reflection || m.internal || m.systemOnly || m.systemOnlyMessage) return true;
  if (m.kind === 'compact_summary' || m._compactSummary) return true;
  return false;
}

/**
 * Project a persisted message record into the in-memory history shape.
 * Accepts `role:'tool'` and preserves `toolCalls`/`toolCallId` so the
 * next chat-completions serialization includes paired tool messages
 * (avoids "No tool output found for function call" 400s).
 *
 * @param {object} m — record from conversationStore.loadRecent*()
 * @returns {object|null} history-shape entry, or null to skip
 */
function projectPersistedToHistoryEntry(m) {
  if (!m) return null;
  if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'tool') return null;
  if (isPersistedInternalMessage(m)) return null;
  const entry = { role: m.role, content: m.role === 'tool' ? m.content : __testNormalizePersistedVisibleContent(m.content) };
  if (m.id) entry.id = m.id;
  if (m.groupId) entry.groupId = m.groupId;
  if (m.speakerVpId) entry.speakerVpId = m.speakerVpId;
  if (m.toolCallId) entry.toolCallId = m.toolCallId;
  if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
    entry.toolCalls = m.toolCalls.map(tc => ({
      id: tc.id,
      name: tc.name,
      input: tc.input,
    }));
  }
  if (m.isError) entry.isError = true;
  if (m.ts) entry.ts = m.ts;
  if (Array.isArray(m.attachments) && m.attachments.length > 0) entry.attachments = m.attachments;
  if ((entry.role === 'user' || entry.role === 'assistant') && !entry.content && !entry.attachments) return null;
  return entry;
}

function projectPersistedToVisibleHistoryEntry(m) {
  const entry = projectPersistedToHistoryEntry(m);
  return entry && (entry.role === 'user' || entry.role === 'assistant') ? entry : null;
}

function hydrateHistoryAttachmentPreviews(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return [];
  return attachments.map((att) => {
    if (!att || typeof att !== 'object') return att;
    if (!att.isImage || att.preview || att.previewData) return att;
    const payload = persistedAttachmentPreviewPayload(att);
    return payload ? { ...att, previewData: payload } : att;
  });
}

function loadVisibleGroupHistoryPage(store, groupId, limit, beforeSeq = null) {
  if (!store || !groupId || !(limit > 0)) return { messages: [], oldestSeq: null, hasMore: false };

  let rows = [];
  try {
    if (typeof store.loadOlderByGroup === 'function') {
      // Use an unbounded raw prefix, then project/slice visible rows below.
      // This preserves loadOlderByGroup's hot+cold scan without letting raw
      // reflection/internal rows consume the UI-visible page window.
      rows = store.loadOlderByGroup(groupId, beforeSeq, Infinity).messages || [];
    } else if (Number.isFinite(beforeSeq)) {
      const all = typeof store.loadAllByGroup === 'function'
        ? store.loadAllByGroup(groupId)
        : store.loadRecentByGroup(groupId, Infinity);
      rows = all.filter(m => parseSeqFromId(m?.id) < beforeSeq);
    } else if (typeof store.loadAllByGroup === 'function') {
      rows = store.loadAllByGroup(groupId);
    } else {
      rows = store.loadRecentByGroup(groupId, Infinity);
    }
  } catch (err) {
    console.error('[Unify] visible history page load failed:', err?.message || err);
    return { messages: [], oldestSeq: null, hasMore: false };
  }

  const visible = rows
    .map(projectPersistedToVisibleHistoryEntry)
    .filter(Boolean);
  const messages = sliceLastNTurns(visible, limit);
  const oldestSeq = messages.length ? parseSeqFromId(messages[0].id) : null;
  const firstVisibleSeq = visible.length ? parseSeqFromId(visible[0].id) : null;
  const hasMore = messages.length > 0
    && Number.isFinite(oldestSeq)
    && Number.isFinite(firstVisibleSeq)
    && oldestSeq > firstVisibleSeq;

  return {
    messages,
    oldestSeq: Number.isFinite(oldestSeq) ? oldestSeq : null,
    hasMore,
  };
}

/**
 * Hydrate a freshly-created GroupContext's history from the on-disk
 * conversation store. Returns an empty array if the session isn't
 * loaded yet (sub-agent / test paths) or if the load throws.
 *
 * @param {string} groupId
 * @returns {GroupHistory}
 */
function hydrateGroupHistory(groupId) {
  if (!session?.conversationStore || !groupId) return [];
  let recent;
  try {
    recent = session.conversationStore.loadRecentByGroup(groupId);
  } catch (err) {
    console.warn('[Unify] hydrateGroupHistory failed (groupId=%s):', groupId, err?.message || err);
    return [];
  }
  const out = [];
  for (const m of recent || []) {
    const entry = projectPersistedToHistoryEntry(m);
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * Get-or-create the per-group history array. Used everywhere the bridge
 * needs to read/append/snapshot a group's conversation tape. Lazily
 * inserts an entry into `groupContexts` on first access — no
 * `groupHandle` required (history is independent of coord/router
 * lifecycle, so a sub-agent / route_forward path that hasn't yet
 * opened the group can still read history).
 *
 * Returns the SAME array reference across calls within the same
 * lifecycle, so consumers can mutate-in-place. Reassigned only by
 * compact (race guard checks reference equality), `consolidate`
 * events, and session reset.
 *
 * @param {string} groupId
 * @returns {GroupHistory}
 */
function getOrCreateGroupHistory(groupId) {
  if (!groupId) return [];
  let entry = groupContexts.get(groupId);
  // Use `historyHydrated` rather than truthiness on `history` itself —
  // an empty array (post-consolidate, post-clear, or a partial entry
  // seeded by an early `getOrCreateGroupContext` call before data was
  // loaded) is legitimate state that does NOT mean "needs hydration"...
  // unless we never loaded from disk in the first place. The flag
  // separates the two cases.
  if (entry && entry.historyHydrated) return entry.history;
  if (!entry) {
    entry = makeGroupContextStub();
    groupContexts.set(groupId, entry);
  }
  entry.history = hydrateGroupHistory(groupId);
  entry.historyHydrated = true;
  return entry.history;
}

/**
 * Reassign a group's history reference. Used by compact + consolidate +
 * clear paths that need to swap the array (not just mutate it). Returns
 * the new reference. Idempotent if the entry doesn't exist (creates one).
 *
 * Sets `historyHydrated = true` because an explicit assignment is itself
 * a hydration — even setting `[]` after `consolidate` means "this is the
 * canonical state right now, don't re-load from disk".
 *
 * @param {string} groupId
 * @param {GroupHistory} next
 */
function setGroupHistory(groupId, next) {
  if (!groupId) return;
  let entry = groupContexts.get(groupId);
  if (!entry) {
    entry = makeGroupContextStub();
    groupContexts.set(groupId, entry);
  }
  entry.history = next;
  entry.historyHydrated = true;
}

/**
 * Test-only access to a group's history array. Re-exported below as
 * `__testGroupHistory`. Lets tests pin the per-group isolation contract
 * without booting a full session.
 *
 * @param {string} groupId
 */
export function __testGroupHistory(groupId) {
  return getOrCreateGroupHistory(groupId);
}

/**
 * Test-only: install a minimal `session` so `hydrateGroupHistory` can
 * read from a real `ConversationStore`. Pass `null` to clear.
 *
 * Tests that need to verify the hydrate-from-disk path can construct a
 * `ConversationStore` against a tmp dir, write per-group records via
 * `store.append({groupId, ...})`, then call this helper to wire the
 * store into the bridge before calling `__testGroupHistory(groupId)`.
 *
 * @param {{ conversationStore: object } | null} sessionLike
 */
export function __testSetSession(sessionLike) {
  session = sessionLike;
}

/**
 * Test-only: peek at the GroupContext entry for a group (or undefined
 * if never seeded). Lets tests assert the `historyHydrated` flag without
 * exporting the entire `groupContexts` Map.
 *
 * @param {string} groupId
 */
export function __testGroupContextEntry(groupId) {
  return groupContexts.get(groupId);
}

/**
 * Test-only: build (or return cached) per-VP Engine for a session that
 * was wired via `__testSetSession`. Lets tests assert that the engine's
 * dependencies (notably `toolStats`) come from the session reference —
 * see `test/agent/web-bridge-vp-engine-tool-stats.test.js`.
 *
 * @param {string} groupId
 * @param {string} vpId
 */
export function __testGetOrCreateVpEngine(groupId, vpId, threadId = 'main') {
  return getOrCreateVpEngine(groupId, vpId, threadId);
}


/** Test-only: inspect runtime thread rows for a VP. */
export function __testGetVpThreads(groupId, vpId) {
  const map = vpThreads.get(vpKey(groupId, vpId));
  return Array.from((map || new Map()).values()).map((thread) => ({
    threadId: thread.threadId,
    groupId: thread.groupId,
    vpId: thread.vpId,
    status: thread.status,
    title: thread.title,
    messageIds: [...thread.messageIds],
    pendingQueries: [...thread.pendingQueries],
  }));
}

/** Test-only: wait for thread classification/routing spawned by a msg id. */
export async function __testWaitForRoutePromises(msgId) {
  await waitForRoutePromises(msgId);
}

/** Test-only: route one coordinator envelope into the VP thread runtime. */
export function __testEnqueueForVp(groupId, vpId, envelope) {
  return enqueueForVp(groupId, vpId, envelope);
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
function getOrCreateVpEngine(groupId, vpId, threadId = 'main') {
  const key = threadKey(groupId, vpId, threadId);
  let eng = vpEngines.get(key);
  if (eng) return eng;
  if (!session) throw new Error('getOrCreateVpEngine: session not loaded');
  // Per-group config overlay (v1: model only). Falls back to the
  // session's user-level config when no override is set. The resolver
  // never mutates session.config — it returns a new object.
  const yeaftDir = ctx.CONFIG?.yeaftDir || session.yeaftDir;
  const groupCfg = loadGroupConfig(yeaftDir, groupId);
  const effectiveConfig = resolveGroupConfig(session.config, groupCfg);
  eng = new Engine({
    adapter: session.adapter,
    trace: session.trace,
    config: effectiveConfig,
    conversationStore: session.conversationStore,
    memoryIndex: session.memoryIndex || null,
    amsRegistry: session.amsRegistry,
    toolRegistry: session.toolRegistry,
    skillManager: session.skillManager,
    mcpManager: session.mcpManager,
    yeaftDir: session.yeaftDir,
    // Share the session-shared ToolUsageStats so per-VP tool calls land
    // in the same on-disk snapshot the `unify_fetch_tool_stats` handler
    // reads. Without this, engine's record-on-tool-exec guard
    // (`if (this.#toolStats && ...)`) is false and group VP tool calls
    // are silently dropped.
    toolStats: session.toolStats || null,
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
  if (entry && entry.coord && entry.router) return entry;
  // Either no entry, or a partial entry seeded by `getOrCreateGroupHistory`
  // (no coord/router yet). Build the coord/router and merge into the
  // existing record so the per-group history reference and hydration
  // flag are preserved.
  const coord = createCoordinator(groupHandle, {
    deliver: (vpId, envelope) => enqueueForVp(groupId, vpId, envelope),
  });
  const router = createRouter({ coordinator: coord });
  if (!entry) {
    entry = makeGroupContextStub();
    groupContexts.set(groupId, entry);
  }
  entry.coord = coord;
  entry.router = router;
  entry.groupHandle = groupHandle;
  // Defend against a future caller that builds a coord/router without
  // having gone through `getOrCreateGroupHistory` first: a partial entry
  // could exist with `historyHydrated:false`, so do the load now.
  if (!entry.historyHydrated) {
    entry.history = hydrateGroupHistory(groupId);
    entry.historyHydrated = true;
  }
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
  const routePromise = routeEnvelopeToVpThread(groupId, vpId, envelope);
  registerRoutePromise(envelope?.msg?.id, routePromise);
}

async function routeEnvelopeToVpThread(groupId, vpId, envelope) {
  const { text, prompt, promptParts } = buildVpPromptPayload(vpId, envelope);
  const runningThreads = getRunningThreads(groupId, vpId);
  let thread = null;
  let related = false;

  if (runningThreads.length === 0) {
    thread = getOrCreateVpThread({ groupId, vpId, title: fallbackTitle(text) });
  } else {
    const decision = await threadClassifier({
      adapter: session?.adapter,
      model: session?.config?.fastModel || session?.config?.model,
      vp: readVpForClassifier(vpId),
      runningThreads: runningThreads.map(threadSnapshotForClassifier),
      newQuery: text,
    });
    const targetIsRunning = runningThreads.some((t) => t.threadId === decision.targetThreadId);
    if (decision.decision === 'related' && decision.targetThreadId && targetIsRunning) {
      thread = getOrCreateVpThread({
        groupId,
        vpId,
        threadId: decision.targetThreadId,
        title: decision.title,
      });
      related = true;
    } else {
      thread = getOrCreateVpThread({
        groupId,
        vpId,
        title: decision.title || fallbackTitle(text),
      });
    }
  }

  if (!thread) return null;
  rememberThreadMessage(thread, envelope?.msg);
  const turnId = `${randomUUID().slice(0, 8)}:${vpId}`;

  if (related) {
    const content = promptParts || prompt;
    thread.pendingQueries.push({ content, preview: prompt, originalText: text, originalParts: Array.isArray(envelope?._promptParts) ? envelope._promptParts : null });
    persistInboundMessageOnceByMsgId({
      msgId: envelope?.msg?.id,
      text,
      groupId,
      threadId: thread.threadId,
      role: envelope?.msg?.meta?.injectedBy === 'route_forward' ? 'assistant' : 'user',
      speakerVpId: envelope?.msg?.meta?.senderVpId || envelope?.msg?.from || null,
      attachments: Array.isArray(envelope?.msg?.meta?.attachments) ? envelope.msg.meta.attachments : [],
    });
    thread.updatedAt = Date.now();
    try {
      sendUnifyEvent({
        type: 'vp_thread_user_appended',
        groupId,
        vpId,
        threadId: thread.threadId,
        title: thread.title,
        turnId,
        ts: Date.now(),
      }, { groupId, vpId, threadId: thread.threadId, turnId });
    } catch { /* never crash WS pipeline */ }
    return thread.threadId;
  }

  const key = threadKey(groupId, vpId, thread.threadId);
  let inbox = vpInboxes.get(key);
  if (!inbox) {
    inbox = [];
    vpInboxes.set(key, inbox);
  }
  inbox.push({ envelope, turnId, thread });

  try {
    sendUnifyEvent({
      type: 'vp_typing_start',
      groupId,
      vpId,
      threadId: thread.threadId,
      turnId,
      ts: Date.now(),
    }, { groupId, vpId, threadId: thread.threadId, turnId });
  } catch { /* never crash WS pipeline */ }

  try {
    thread.status = 'typing';
    getVpStatusBroker().transition({
      groupId,
      vpId,
      threadId: thread.threadId,
      title: thread.title,
      state: 'typing',
      turnId,
      messageCount: thread.messageIds.length,
    });
  } catch (err) {
    console.warn('[Unify] vp-status typing transition failed:', err?.message || err);
  }

  ensureDriverRunning(groupId, vpId, thread.threadId);
  return thread.threadId;
}

function ensureDriverRunning(groupId, vpId, threadId = 'main') {
  const key = threadKey(groupId, vpId, threadId);
  if (vpDrivers.has(key)) return;
  const promise = (async () => {
    while (true) {
      const inbox = vpInboxes.get(key);
      if (!inbox || inbox.length === 0) break;
      const { envelope, turnId, thread: queuedThread } = inbox.shift();
      const thread = queuedThread || getOrCreateVpThread({ groupId, vpId, threadId });
      const vpAbort = new AbortController();
      vpAborts.set(key, vpAbort);
      turnAbortCtrls.set(turnId, vpAbort);
      turnAbortMeta.set(turnId, { groupId, vpId, threadId: thread.threadId, key });
      const baseSnapshot = getOrCreateGroupHistory(groupId)
        .filter((m) => !m.threadId || m.threadId === 'main' || m.threadId === thread.threadId);
      const trigger = envelope?.trigger || 'fallback';
      const { text, prompt, promptParts } = buildVpPromptPayload(vpId, envelope);

      try {
        const envMsgId = envelope?.msg?.id;
        if (envMsgId && text) {
          const meta = envelope?.msg?.meta || {};
          const isForward = meta.injectedBy === 'route_forward';
          const senderVpId = isForward ? (meta.senderVpId || envelope?.msg?.from || null) : null;
          persistInboundMessageOnceByMsgId({
            msgId: envMsgId,
            text,
            groupId,
            threadId: thread.threadId,
            role: isForward ? 'assistant' : 'user',
            speakerVpId: senderVpId,
            attachments: Array.isArray(meta.attachments) ? meta.attachments : [],
          });
        }
      } catch { /* never crash WS pipeline */ }

      try {
        await runVpTurnWithEscalation({
          prompt,
          promptParts,
          groupId,
          vpId,
          threadId: thread.threadId,
          thread,
          turnId,
          envelope,
          vpAbort,
          baseSnapshot,
        });
      } catch (err) {
        console.warn('[Unify] driveVp: runVpTurn failed', vpId, err?.message || err);
      } finally {
        turnAbortCtrls.delete(turnId);
        turnAbortMeta.delete(turnId);
        if (vpAborts.get(key) === vpAbort) vpAborts.delete(key);
        try {
          sendUnifyEvent({
            type: 'vp_typing_end',
            groupId,
            vpId,
            threadId: thread.threadId,
            turnId,
            ts: Date.now(),
          }, { groupId, vpId, threadId: thread.threadId, turnId });
        } catch { /* never crash WS pipeline */ }
      }
      try {
        if (text && envelope?.msg) {
          sendUnifyEvent({
            type: 'group_message',
            groupId,
            vpId,
            threadId: thread.threadId,
            speakerVpId: vpId,
            text,
            mentions: Array.isArray(envelope?.msg?.mentions) ? envelope.msg.mentions : [],
            trigger,
            ts: Date.now(),
          }, { groupId, vpId, threadId: thread.threadId, turnId });
        }
      } catch { /* never crash WS pipeline */ }

      // fix-vp-multi-thread (bug 1 + 3): rescue any orphaned related-
      // appends. If a user (or a VP via route_forward) added queries
      // to this thread's `pendingQueries` AFTER the engine had already
      // decided to end_turn (so the inner drain at engine.js:1850 no
      // longer fires), those queries would be silently lost. Convert
      // each leftover into a synthetic inbox envelope so the driver
      // re-enters and runs a fresh turn on the same thread.
      if (thread && Array.isArray(thread.pendingQueries) && thread.pendingQueries.length > 0) {
        const leftovers = thread.pendingQueries.splice(0);
        for (const leftover of leftovers) {
          // `originalText` / `originalParts` capture the inbound payload
          // BEFORE `buildVpPromptPayload` prepended `@vp-<id> ` and added
          // any suffix. Replaying through `buildVpPromptPayload` (via the
          // driver) re-applies the prefix, so we must NOT pass the
          // already-decorated `preview` here or the prompt would carry
          // a double `@vp-<id> @vp-<id> ...` mention.
          const replayText = typeof leftover?.originalText === 'string'
            ? leftover.originalText
            : '';
          const replayParts = Array.isArray(leftover?.originalParts) && leftover.originalParts.length > 0
            ? leftover.originalParts
            : null;
          if (!replayText && !replayParts) continue;
          const followUpId = `followup_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
          const followUpEnvelope = {
            groupId,
            taskId: envelope?.taskId || null,
            trigger: 'pending_rescue',
            msg: {
              id: followUpId,
              from: 'user',
              text: replayText,
              meta: { rescuedFrom: 'pendingQueries', threadId: thread.threadId },
            },
            ...(replayParts ? { _promptParts: replayParts } : {}),
          };
          const followUpTurnId = `${randomUUID().slice(0, 8)}:${vpId}`;
          inbox.push({ envelope: followUpEnvelope, turnId: followUpTurnId, thread });
          try {
            thread.status = 'typing';
            thread.updatedAt = Date.now();
            getVpStatusBroker().transition({
              groupId,
              vpId,
              threadId: thread.threadId,
              title: thread.title || '',
              state: 'typing',
              turnId: followUpTurnId,
              messageCount: thread.messageIds.length,
            });
          } catch (err) {
            console.warn('[Unify] vp-status typing transition (rescue) failed:', err?.message || err);
          }
          try {
            sendUnifyEvent({
              type: 'vp_typing_start',
              groupId,
              vpId,
              threadId: thread.threadId,
              turnId: followUpTurnId,
              ts: Date.now(),
            }, { groupId, vpId, threadId: thread.threadId, turnId: followUpTurnId });
          } catch { /* never crash WS pipeline */ }
        }
      }
    }
    vpDrivers.delete(key);
    const tail = vpInboxes.get(key);
    if (tail && tail.length > 0) ensureDriverRunning(groupId, vpId, threadId);
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
  vpThreads.clear();
  turnAbortCtrls.clear();
  turnAbortMeta.clear();
  await __testDrainVpDrivers();
  vpInboxes.clear();
  vpDrivers.clear();
  vpEngines.clear();
  vpAborts.clear();
  groupContexts.clear();
  vpCurrentTodos.clear();
  threadClassifier = defaultClassifyThread;
  // Per-group compact in-flight + pending state lives on the session's
  // Compactor. Clear it so a follow-on test doesn't see ghost in-flight
  // promises from a prior run.
  if (session?.compactor && typeof session.compactor.__testReset === 'function') {
    session.compactor.__testReset();
  }
}


/**
 * Send a unify_output message carrying claude_output-format data.
 * Envelope fields: conversationId, groupId, vpId, turnId, threadId let the
 * frontend route incremental deltas to the correct per-VP/thread block.
 */
function sendUnifyOutput(data, { groupId, vpId, turnId, threadId } = {}) {
  sendToServer({
    type: 'unify_output',
    conversationId: unifyConversationId,
    ...(groupId ? { groupId } : {}),
    ...(vpId ? { vpId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(threadId ? { threadId } : {}),
    data,
  });
}

/** Send a unify_output event (non-claude_output metadata). */
function sendUnifyEvent(event, { groupId, vpId, turnId, threadId } = {}) {
  sendToServer({
    type: 'unify_output',
    conversationId: unifyConversationId,
    ...(groupId ? { groupId } : {}),
    ...(vpId ? { vpId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(threadId ? { threadId } : {}),
    event,
  });
}

function configuredVpPaths() {
  const yeaftDir = ctx.CONFIG?.yeaftDir;
  if (typeof yeaftDir !== 'string' || !yeaftDir.trim()) return {};
  const root = yeaftDir.trim();
  return {
    libDir: join(root, 'virtual-persons'),
    memoryRoot: join(root, 'memory'),
  };
}

export function handleUnifyVpSubscribe(_msg) {
  if (_vpUnsubscribe) {
    try { _vpUnsubscribe(); } catch { /* ignore */ }
    _vpUnsubscribe = null;
  }
  const { libDir } = configuredVpPaths();
  _vpUnsubscribe = handleVpSubscribe(
    sendUnifyEvent,
    undefined,
    libDir ? { dir: libDir } : {},
  );
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
    const { libDir, memoryRoot } = configuredVpPaths();
    const options = {
      ...(libDir ? { libDir } : {}),
      ...(memoryRoot ? { memoryRoot } : {}),
    };
    const { vpId } = createVp(payload || {}, options);
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
    const { libDir } = configuredVpPaths();
    const { vpId } = updateVp(payload || {}, libDir ? { libDir } : {});
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
    const { libDir, memoryRoot } = configuredVpPaths();
    const options = {
      ...(libDir ? { libDir } : {}),
      ...(memoryRoot ? { memoryRoot } : {}),
    };
    deleteVp(vpId, options);
    // vp-status: a deleted VP must not haunt the snapshot. We don't
    // know up front which groups the VP appeared in (the registry's
    // delete already detached it from every group), so sweep every
    // matching entry from the broker table.
    try {
      const broker = getVpStatusBroker();
      for (const row of broker.snapshot()) {
        if (row.vpId === vpId) broker.forget({ groupId: row.groupId, vpId });
      }
    } catch (err) {
      console.warn('[Unify] vp-status forget on delete failed:', err?.message || err);
    }
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

export function handleUnifyVpRead(msg) {
  const requestId = msg && msg.requestId;
  const vpId = msg && msg.vpId;
  const { libDir } = configuredVpPaths();
  const vp = readVp(vpId, libDir ? { libDir } : {});
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
    workDir: group.workDir || '',
  });
}

function groupErrorPayload(err) {
  let code = 'unknown';
  if (err instanceof GroupCrudError) code = err.code;
  else if (err instanceof GroupConfigError) code = err.code;
  return {
    code,
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

/**
 * Persist the model selected in the group conversation header. Cache invalidation:
 * drop every cached Engine whose key starts with `${groupId}::` so the
 * next turn picks up the new model. The group meta itself is untouched.
 *
 * Payload: { groupId, requestId, config: { model?: string|null } }
 *  - `model: ''` or `null` clears the selected group model (falls back to user default).
 */
export function handleUnifyUpdateGroupConfig(msg) {
  const requestId = msg && msg.requestId;
  const groupId = msg && msg.groupId;
  const partial = (msg && msg.config && typeof msg.config === 'object') ? msg.config : null;
  try {
    if (!groupId) throw new GroupConfigError('missing_group_id', 'groupId required');
    if (!partial) throw new GroupConfigError('invalid_patch', 'config object required');
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    const savedConfig = updateGroupConfig(yeaftDir, groupId, partial);
    // Drop cached engines so the next VP turn rebuilds with the new model.
    const prefix = `${groupId}::`;
    for (const k of Array.from(vpEngines.keys())) {
      if (k.startsWith(prefix)) vpEngines.delete(k);
    }
    invalidateGroupContext(groupId);
    sendGroupCrudResult({ op: 'update_config', requestId, ok: true, groupId, config: savedConfig });
    sendGroupSnapshotBroadcast();
  } catch (err) {
    sendGroupCrudResult({ op: 'update_config', requestId, ok: false, error: groupErrorPayload(err) });
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
    const result = deleteGroup(yeaftDir, groupId);
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
    // Also drop the kicked VP's thread engines — the next time they're
    // added back they should start with fresh per-thread state.
    const removedPrefix = `${groupId}::${vpId}::`;
    for (const key of Array.from(vpEngines.keys())) {
      if (key.startsWith(removedPrefix)) vpEngines.delete(key);
    }
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
 * Thread scheduling is owned by the group VP runtime below, not by mutable
 * threadStore settings. The old threadStore setters are kept only as ignored
 * compatibility shims for older clients.
 *
 * @param {import('./session.js').Session} s
 */
export function installUnifyRuntimeBridge(s) {
  if (!s) return;

  // Forward dream pipeline progress events to the web debug panel.
  //
  // Group-id stamping is NO LONGER done here. It used to be: this sink
  // read a module-level `activeScopedDreamGroupId` that
  // `handleUnifyDreamTrigger({groupId})` parked before awaiting the
  // scope-filtered pass. That created a race when two scoped triggers
  // overlapped (auto-tick during a manual click; or two manual clicks
  // for different groups): the second handler's `finally` could clear
  // the module slot while the first run was still emitting events,
  // dropping the stamp from the tail of the first pass. The new design:
  // `handleUnifyDreamTrigger` wraps THIS sink for the lifetime of the
  // trigger to inject `groupId` per-call (see that function below). The
  // base sink is intentionally a pure passthrough.
  //
  // Bug 2: also forward turn_open / turn_close / loop events emitted by
  // the dream pipeline so the debug panel shows dream LLM API calls.
  s._dreamProgressSink = (evt) => {
    try {
      if (evt.type === 'turn_open' || evt.type === 'turn_close' || evt.type === 'loop') {
        const tag = evt && evt.groupId ? { groupId: evt.groupId } : {};
        sendUnifyEvent(evt, tag);
      } else {
        const out = { type: 'dream_progress', ...evt };
        const tag = evt && evt.groupId ? { groupId: evt.groupId } : {};
        sendUnifyEvent(out, tag);
      }
    } catch { /* never let event delivery throw */ }
  };

  // Wire the post-compact WS sink. Compactor is constructed in
  // session.js with a no-op sink; bridge owns `sendUnifyEvent` /
  // `unifyConversationId`, so the sink is wired here once a session is
  // present. Per-group `unify_history_compacted` events fire after a
  // successful summarize+swap.
  if (s.compactor && typeof s.compactor.setOnCompacted === 'function') {
    s.compactor.setOnCompacted((groupId, result) => {
      try {
        sendUnifyEvent({
          type: 'unify_history_compacted',
          reason: result?.reason ?? null,
          beforeTurns: result?.beforeTurns,
          afterTurns: result?.afterTurns,
          beforeTokens: result?.beforeTokens,
          afterTokens: result?.afterTokens,
          archivedCount: result?.archivedCount,
          ts: Date.now(),
        }, { groupId });
      } catch { /* WS pipeline failure must not crash compact */ }
    });
  }

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
 * Mid-turn vp-status transitions (text_delta / tool_call / tool_end).
 * Tolerates `hctx` missing groupId/vpId — pre-707 1:1 chat paths don't
 * have either; they're tracked as the default broker key but the
 * frontend ignores rows it doesn't recognize.
 *
 * @param {object} hctx
 * @param {string} state
 */
function maybeTransitionVpStatus(hctx, state) {
  if (!hctx || !hctx.vpId) return;
  try {
    if (hctx.thread) {
      hctx.thread.status = state;
      hctx.thread.updatedAt = Date.now();
    }
    getVpStatusBroker().transition({
      groupId: hctx.groupId || null,
      vpId: hctx.vpId,
      state,
      turnId: hctx.turnId || null,
      threadId: hctx.threadId || 'main',
      title: hctx.thread?.title || '',
      messageCount: hctx.thread?.messageIds?.length || 0,
    });
  } catch (err) {
    console.warn(`[Unify] vp-status ${state} transition failed:`, err?.message || err);
  }
}

/**
 * Handle a single engine event unwrapped from an `engine_event` envelope.
 * Stamps threadId on every outgoing frame so frontend grouping, tools,
 * todos, debug cards, and persistence all share the same boundary.
 *
 * @param {object} event — engine event (text_delta / tool_call / …)
 * @param {{assistantTextParts:string[], toolCallsAccum:Array, toolResultsAccum:Array, thinkingBlocksAccum?:Array, resetQueryTimer:Function, groupId?:string, vpId?:string, turnId?:string}} hctx
 */
export function __testHandleEngineEvent(event, hctx) {
  return handleEngineEvent(event, hctx);
}

function handleEngineEvent(event, hctx) {
  hctx.resetQueryTimer();
  const envelope = {
    groupId: hctx.groupId,
    vpId: hctx.vpId,
    turnId: hctx.turnId,
    threadId: hctx.threadId || event.threadId,
  };

  switch (event.type) {
    case 'text_delta':
      hctx.assistantTextParts.push(event.text);
      sendUnifyOutput({
        type: 'assistant',
        message: { content: [{ type: 'text', text: event.text }] },
      }, envelope);
      // vp-status: first text-delta of a (thinking|tool) phase flips
      // the row to 'streaming'. transition() is a no-op when already
      // streaming, so subsequent deltas are cheap.
      maybeTransitionVpStatus(hctx, 'streaming');
      break;

    case 'thinking_delta':
      sendUnifyEvent({ type: 'thinking_delta', text: event.text }, envelope);
      break;

    case 'thinking_block_end':
      // task-327d: capture the assembled thinking block (with server-
      // signed signature) so the group history we hand to subsequent
      // turns / VPs includes it. Without this echo Anthropic 400s the
      // next request with "content[].thinking in the thinking mode must
      // be passed back to the API". The signature stays server-side
      // only — wire serializers (stripMetaForWire / sendUnifyOutput)
      // never reference thinkingBlocks, so it cannot leak to the UI.
      if (hctx.thinkingBlocksAccum && event.signature) {
        if (event.redacted) {
          hctx.thinkingBlocksAccum.push({
            redacted: true,
            data: event.data,
            signature: event.signature,
          });
        } else {
          hctx.thinkingBlocksAccum.push({
            thinking: event.thinking,
            signature: event.signature,
          });
        }
      }
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
      maybeTransitionVpStatus(hctx, 'tool');
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
      // Tool finished. The engine may either (a) emit more text-deltas
      // before end_turn, or (b) go straight to end_turn. Settle the
      // row back to 'thinking' — if (a), the next text_delta will flip
      // it to 'streaming'; if (b), runVpTurn's finally will flip it to
      // 'idle'. Either way we never strand the row in 'tool'.
      maybeTransitionVpStatus(hctx, 'thinking');
      break;

    case 'turn_start':
    case 'stop':
      // No UI action needed; outer loop sends the final result.
      break;

    case 'turn_end':
      // Most engine turn_end events are internal loop boundaries. A normal
      // tool_use stop means "run tools, then call the adapter again", so it
      // must NOT end the VP's visible turn. route_forward is different: the
      // tool has handed control to another VP and Engine.query will not
      // stream more text for this VP. Settle the current VP immediately so
      // the roster row does not sit on "thinking" until later result cleanup.
      if (event.stopReason === 'tool_handoff' && event.detail?.kind === 'route_forward') {
        try {
          if (hctx.thread) {
            hctx.thread.status = 'idle';
            hctx.thread.updatedAt = Date.now();
          }
          getVpStatusBroker().settleIdle({
            groupId: hctx.groupId || null,
            vpId: hctx.vpId,
            threadId: hctx.threadId || 'main',
            title: hctx.thread?.title || '',
            messageCount: hctx.thread?.messageIds?.length || 0,
          });
        } catch (err) {
          console.warn('[Unify] vp-status settleIdle (route_forward) failed:', err?.message || err);
        }
        sendUnifyEvent({
          type: 'vp_turn_end',
          groupId: hctx.groupId,
          vpId: hctx.vpId,
          threadId: hctx.threadId || event.threadId || 'main',
          turnId: hctx.turnId,
          stopReason: event.stopReason,
          detail: event.detail || null,
          ts: Date.now(),
        }, envelope);
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
      // Engine compressed the context — clear THIS group's accumulated
      // history. Other groups' histories stay intact.
      if (hctx.groupId) setGroupHistory(hctx.groupId, []);
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

    case 'user_append':
      if (hctx && Array.isArray(hctx.appendedUserPrompts) && event.preview) {
        hctx.appendedUserPrompts.push(String(event.preview));
      }
      sendUnifyEvent({
        type: 'vp_thread_user_append_consumed',
        turnId: event.turnId,
        threadId: event.threadId,
        loopNumber: event.loopNumber,
        preview: event.preview,
        ts: Date.now(),
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
  // PR #721: image-only send is allowed — text may be empty when the
  // user attached files only. The frontend synthesizes a placeholder
  // string in `sendUnifyGroupChat`, so by the time we get here `text`
  // should always be non-empty; but defend anyway in case an API
  // caller sends a bare attachment payload.
  const hasFiles = Array.isArray(msg.files) && msg.files.length > 0;
  if (!text?.trim() && !hasFiles) return;
  const mentions = Array.isArray(msg.mentions) ? msg.mentions : [];
  const groupId = (typeof msg.groupId === 'string' && msg.groupId.trim())
    ? msg.groupId.trim()
    : 'grp_default';

  // Entry gate: if a compact is in flight from the previous turn IN
  // THIS GROUP, wait for it to finish before reading the group's
  // history. Compact runs at turn END (post-fanout) so it does not
  // block the user's current message latency, but a fast double-send
  // from the user must not race with the swap. Other groups' compacts
  // never block this gate. Compactor is created in session.js — until
  // a session has loaded (or in test paths that never call
  // `ensureSessionLoaded`) it may be unavailable; skip gracefully.
  if (session?.compactor) {
    await session.compactor.awaitInFlight(groupId);
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
  let groupRoot = null;
  let seedFailed = false;
  try {
    const groupYeaftDir = resolveGroupYeaftDir(yeaftDir, groupId);
    groupRoot = groupsRoot(groupYeaftDir);
    const dir = join(groupRoot, groupId);
    if (existsSync(dir) && loadGroupMeta(dir)) {
      groupHandle = openGroup(groupRoot, groupId);
    } else if (groupId === 'grp_default') {
      try {
        const seeded = seedDefaultGroup(groupYeaftDir, { memoryRoot: join(groupYeaftDir, 'memory') });
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
      ? `⚠️ Failed to seed default group ${groupId} — check group .yeaft permissions.`
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
        groupHandle = openGroup(groupRoot, groupId);
        sendGroupRosterChanged(groupHandle.getMeta());
      }
    }
    const meta2 = groupHandle.getMeta();
    if (!meta2.defaultVpId && meta2.roster.length) {
      try {
        setGroupDefaultVp(yeaftDir, groupId, meta2.roster[0]);
        try { groupHandle.close && groupHandle.close(); } catch { /* best-effort */ }
        groupHandle = openGroup(groupRoot, groupId);
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

  // Multi-thread routing owns active-VP decisions. Do not abort an active
  // VP before classification: a new query may append to the running thread
  // or spawn an unrelated concurrent thread.

  // ── Attachments (images + files) ───────────────────────────────
  // Server has already resolved fileId → { name, mimeType, data:base64,
  // isImage } via the same path crew uses (client-conversation.js relay
  // for `unify_*`). We persist files to disk under the agent's CWD so
  // file-tools (file-read / bash) can pick them up with relative paths,
  // and we build per-image content blocks for the LLM call. The
  // resolved metadata WITHOUT base64 rides on coord.ingest meta so it
  // shows up in the persisted group log and on the envelope every VP
  // driver receives.
  const inboundFiles = Array.isArray(msg.files) ? msg.files : [];
  let attachmentBundle = { promptAttachments: [], promptSuffix: '', promptParts: [], failed: [] };
  if (inboundFiles.length > 0) {
    try {
      attachmentBundle = persistUnifyAttachments(inboundFiles, { subdir: groupId });
    } catch (err) {
      console.warn('[Unify] unify_group_chat: attachment persist failed', err?.message || err);
    }
  }
  // Surface partial / total upload failures to the user. We don't abort
  // the turn — the LLM can still answer the text-only portion — but the
  // user must know which files didn't make it.
  if (Array.isArray(attachmentBundle.failed) && attachmentBundle.failed.length > 0) {
    const detail = attachmentBundle.failed
      .map((f) => `  - ${f.name}: ${f.error}`)
      .join('\n');
    sendUnifyOutput({
      type: 'assistant',
      message: { content: [{ type: 'text', text: `⚠️ ${attachmentBundle.failed.length} file(s) could not be attached:\n${detail}` }] },
    }, { groupId });
  }
  const persistedAttachments = attachmentsForPersistence(attachmentBundle.promptAttachments);

  // Ingest user text. The coordinator persists, applies mention/fanout
  // rules, and calls deliver() (== enqueueForVp) for each chosen VP —
  // which both (a) emits vp_typing_start and (b) ensures a driver runs.
  let report;
  try {
    report = coord.ingest({
      from: 'user',
      role: 'user',
      text,
      meta: {
        mentions,
        // Persisted form (no base64) — safe for jsonl-log.
        attachments: persistedAttachments,
      },
      // Live form — adapters need the base64 image blocks; runVpTurn
      // reads `_promptParts` off the envelope rather than going
      // back to disk on every fan-out target. NOT persisted.
      _promptParts: attachmentBundle.promptParts,
      _promptSuffix: attachmentBundle.promptSuffix,
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

  // Thread ownership is resolved inside enqueueForVp()/routeEnvelopeToVpThread
  // before persistence. Do not write a canonical 'main' user row here: a
  // route to an active VP may append to an existing thread, while an
  // unrelated query may create a new one. The per-target route path writes
  // the thread-local inbound row with the classified threadId.

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

  // Wait only for routing/classification promises spawned by this message.
  // Do not wait for every driver in the group: unrelated older threads may keep
  // running for minutes and must not hold this request lifecycle hostage.
  await waitForRoutePromises(report?.message?.id);
}

/**
 * Wait for a bounded set of driver keys. Production group chat uses
 * waitForRoutePromises() so a new message is fire-and-stream after its
 * classification/target-thread decision. This helper remains for tests and
 * explicit barriers, but it must never wait for every group driver: an
 * unrelated long-running thread must not pin a fresh query.
 *
 * @param {Iterable<string>} driverKeys
 */
async function waitForVpDrivers(_groupId, driverKeys = []) {
  const keys = new Set(Array.from(driverKeys || []).filter(Boolean));
  while (keys.size > 0) {
    const promises = [];
    for (const key of Array.from(keys)) {
      const p = vpDrivers.get(key);
      if (p) promises.push(p.catch(() => {}));
      else keys.delete(key);
    }
    if (promises.length === 0) return;
    await Promise.all(promises);
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
export function buildVpQueryOpts({ vpId, groupCoordinator, groupId, envelope, threadId = 'main' }) {
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

  const out = { senderVpId: resolvedVpId, threadId: threadId || 'main' };
  if (typeof groupId === 'string' && groupId.trim()) {
    out.groupId = groupId.trim();
  }
  // task-334-group-editor: surface the group announcement to the engine so
  // buildWorkerPrompt can inject it as a CLAUDE.md-style shared prefix.
  // Empty/missing reads as '' and prompts.js skips the section.
  if (groupMeta && typeof groupMeta.announcement === 'string') {
    out.groupAnnouncement = groupMeta.announcement;
  }
  // Surface the group's configured working directory so the engine can
  // resolve CLAUDE.md / AGENTS.md at that path and inject it as a
  // [Project Doc] block above the announcement. Groups with no workDir
  // skip the block silently (matches the announcement contract).
  if (groupMeta && typeof groupMeta.workDir === 'string' && groupMeta.workDir.trim()) {
    out.workDir = groupMeta.workDir.trim();
  }
  try {
    const vp = readVp(resolvedVpId);
    if (vp) {
      out.vpPersona = {
        vpId: resolvedVpId,
        displayName: vp.displayName || resolvedVpId,
        displayNameZh: vp.displayNameZh || '',
        role: vp.role || '',
        roleZh: vp.roleZh || '',
        persona: vp.persona || '',
        // Optional per-VP planning style for the `StartPlan` tool. Empty
        // string means "fall back to the default template" — the tool
        // handles the lookup so callers stay ignorant of the default.
        planInstruction: typeof vp.planInstruction === 'string' ? vp.planInstruction : '',
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
  // TodoWrite per-thread isolation. Bind closures that read/write a slot
  // keyed by `${groupId}::${vpId}::${threadId}` so concurrent threads for
  // the same VP cannot overwrite each other's lists, and the TodoWrite tool
  // can stay ignorant of routing details (it just calls ctx.setCurrentTodos).
  const todosKey = threadKey(out.groupId || '', resolvedVpId, out.threadId || 'main');
  out.getCurrentTodos = () => {
    const cached = vpCurrentTodos.get(todosKey);
    return Array.isArray(cached) ? cached.slice() : null;
  };
  out.setCurrentTodos = (todos) => {
    if (Array.isArray(todos)) {
      vpCurrentTodos.set(todosKey, todos.slice());
    }
  };
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
    serverMode: true,
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

  // Per-group history is hydrated lazily on first `getOrCreateGroupHistory`
  // — there's no global "all conversations" tape any more.

  sendUnifyEvent({
    type: 'session_ready',
    conversationId: unifyConversationId,
    model: session.config.model,
    availableModels: session.config.availableModels || [],
    skills: session.status.skills,
    mcpServers: session.status.mcpServers,
    tools: session.status.tools,
    yeaftDir: ctx.CONFIG?.yeaftDir || null,
  });
  sendGroupSnapshotBroadcast();
  // vp-status: rebuild frontend status table from authoritative agent
  // memory. Sent unconditionally so reconnect/refresh paths get the same
  // bootstrap as first-load (the broker dedup logic makes a redundant
  // snapshot harmless).
  try {
    getVpStatusBroker().broadcastSnapshot();
  } catch (err) {
    console.warn('[Unify] vp-status snapshot broadcast failed:', err?.message || err);
  }
}

/**
 * Wrap {@link runVpTurn} with a hard escalation deadline.
 *
 * The first-line defense is the in-turn watchdog inside runVpTurn: at
 * {@link QUERY_TIMEOUT_MS} of silence it calls `vpAbort.abort()`. When
 * adapters and tools cooperate with AbortSignal that's enough — the
 * engine throws AbortError, the catch handler emits `result{stopped:true}`,
 * and the driver's `finally` emits `vp_typing_end`.
 *
 * This wrapper is the second-line defense for the "tool ignores signal"
 * failure mode. If runVpTurn doesn't return within
 * QUERY_TIMEOUT_MS + ESCALATE_AFTER_ABORT_MS we synthesize a clean exit:
 * emit a synthetic `result{stopped:true}` so the frontend leaves its
 * in-flight state, log loudly so operators know a tool is stuck, and
 * resolve. The hung promise leaks (the engine generator is permanently
 * blocked on a tool that ignores cancellation) but the user-facing turn
 * is closed and the next message can flow. Resolving the wrapper is
 * preferred over rejecting because the driver's catch already logs a
 * warning — we want a single, unambiguous "watchdog escalated" line in
 * the log instead of layered noise.
 *
 * Tool-level timeouts (see registry.js DEFAULT_TOOL_TIMEOUT_MS) are the
 * real cure: this wrapper should rarely fire because no tool should be
 * able to block longer than its budget. It exists as belt-and-suspenders
 * for tools that legitimately disable timeouts (long-running internal
 * helpers) or for adapter implementations that ignore signal.
 */
async function runVpTurnWithEscalation(args) {
  const { groupId, vpId, turnId, threadId, thread } = args;
  const deadlineMs = QUERY_TIMEOUT_MS + ESCALATE_AFTER_ABORT_MS;
  await raceWithEscalation(runVpTurn(args), {
    deadlineMs,
    onEscalate: () => {
      console.error(
        `[Unify] runVpTurn watchdog escalation: VP ${vpId} did not return ${deadlineMs}ms after enqueue — emitting synthetic stop and unblocking driver`,
      );
      try {
        sendUnifyOutput(
          { type: 'result', result_text: '', stopped: true },
          { groupId, vpId, turnId, threadId },
        );
      } catch { /* never crash WS pipeline */ }
      // vp-status: when the watchdog escalates, `runVpTurn`'s inner
      // promise is still dangling (the adapter is ignoring `signal`)
      // and its outer `finally` won't run until the adapter eventually
      // returns — which may be never. Settle the broker here so the
      // row drops to idle in lockstep with the synthetic stop frame.
      // This is the exact failure mode the watchdog exists for; not
      // settling here would re-introduce the "stuck on streaming" bug
      // the whole PR is meant to fix.
      try {
        getVpStatusBroker().settleIdle({ groupId, vpId, threadId: threadId || 'main', title: thread?.title || '' });
      } catch (err) {
        console.warn('[Unify] vp-status settleIdle (escalation) failed:', err?.message || err);
      }
    },
  });
}

/**
 * Race `inner` against a deadline timer. If `inner` resolves/rejects first,
 * the timer is cleared and the result of `inner` is returned. If the timer
 * wins, `onEscalate` is called and the wrapper resolves cleanly — the inner
 * promise is left dangling (JS has no promise cancellation) but the caller
 * is unblocked.
 *
 * `onEscalate` MUST be synchronous. We swallow synchronous throws so a
 * torn-down WS pipeline can't crash the watchdog, but a Promise rejection
 * from an async `onEscalate` would leak past this `catch`.
 *
 * Pure helper, no module-level state, exported as `__testRaceWithEscalation`
 * so the contract can be unit-tested in isolation. Inner errors propagate
 * (a tool that throws still surfaces through `runVpTurn`'s normal catch).
 *
 * @template T
 * @param {Promise<T>} inner
 * @param {{ deadlineMs: number, onEscalate: () => void }} opts
 * @returns {Promise<T|void>}
 */
async function raceWithEscalation(inner, { deadlineMs, onEscalate }) {
  let escalateTimer = null;
  const escalation = new Promise((resolve) => {
    escalateTimer = setTimeout(() => {
      try { onEscalate(); } catch { /* never throw out of the watchdog */ }
      resolve();
    }, deadlineMs);
    // `unref()` lets a pending escalation timer not hold the Node event
    // loop open (e.g. during graceful shutdown). Browsers / non-Node
    // runtimes don't expose it, hence the typeof guard. Node's own
    // `Timeout.unref()` does not throw, so no try/catch is needed.
    if (escalateTimer && typeof escalateTimer.unref === 'function') {
      escalateTimer.unref();
    }
  });
  try {
    return await Promise.race([inner, escalation]);
  } finally {
    clearTimeout(escalateTimer);
  }
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
async function runVpTurn({ prompt, promptParts = null, groupId, vpId, threadId = 'main', thread = null, turnId, envelope: inboundEnvelope, vpAbort, baseSnapshot }) {
  if (!prompt?.trim()) return;

  const envelope = { groupId, vpId, threadId, turnId };

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
    sendUnifyEvent({ type: 'vp_turn_start', vpId, threadId, turnId, groupId, title: thread?.title || '' }, envelope);
    // vp-status: LLM call about to start, no text/tool yet → 'thinking'.
    try {
      getVpStatusBroker().transition({ groupId, vpId, threadId, title: thread?.title || '', state: 'thinking', turnId, messageCount: thread?.messageIds?.length || 0 });
    } catch (err) {
      console.warn('[Unify] vp-status thinking transition failed:', err?.message || err);
    }

    try {
      const assistantTextParts = [];
      const toolCallsAccum = [];
      const toolResultsAccum = [];
      const thinkingBlocksAccum = []; // task-327d: round-trip to next turn
      const appendedUserPrompts = [];
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
        threadId,
      });

      vpEngine = getOrCreateVpEngine(groupId, vpId, threadId);
      if (thread) thread.engine = vpEngine;

      const handlerCtx = {
        assistantTextParts,
        toolCallsAccum,
        toolResultsAccum,
        thinkingBlocksAccum,
        resetQueryTimer,
        groupId,
        vpId,
        turnId,
        threadId,
        thread,
        appendedUserPrompts,
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
        promptParts,
        messages: trimmedMessages,
        signal: vpAbort.signal,
        // Multi-VP fan-out (history-dedup): the user row was persisted
        // ONCE by handleUnifyGroupChat → persistUserMessageOnce before
        // fan-out. Tell the engine's stop-hook to skip the user-row
        // append for THIS VP's turn (it still writes assistant + tool
        // rows for this VP). Without this the magnet of N engines would
        // each write a copy of the user message, and history replay
        // would render the user's prompt N times.
        userAlreadyPersisted: true,
        threadId,
        drainPendingUserMessages: () => {
          if (!thread || !Array.isArray(thread.pendingQueries) || thread.pendingQueries.length === 0) return [];
          return thread.pendingQueries.splice(0);
        },
        ...queryOpts,
      })) {
        resetQueryTimer();
        handleEngineEvent(event, handlerCtx);
      }

      // Turn completed — atomically append this VP's output to shared history.
      appendTurnToGroupHistory(groupId, threadId, [prompt, ...appendedUserPrompts], assistantTextParts, toolCallsAccum, toolResultsAccum, thinkingBlocksAccum);

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

    // vp-status: surface a transient `error` state so the row's status
    // label flips red for the brief window before the outer finally
    // settles it to idle. Without this, an LLM/tool failure would look
    // identical to a normal turn end in the timeline — the user has
    // no way to tell from the row that something went wrong.
    try {
      getVpStatusBroker().transition({ groupId, vpId, threadId, title: thread?.title || '', state: 'error', turnId, messageCount: thread?.messageIds?.length || 0 });
    } catch (brokerErr) {
      console.warn('[Unify] vp-status error transition failed:', brokerErr?.message || brokerErr);
    }

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
  } finally {
    // vp-status: guaranteed-settle. Regardless of how the turn exited
    // (normal completion, AbortError early-return, caught exception),
    // the row must drop back to 'idle'. Wrapped in its own try so a
    // broker bug can't mask the original error.
    try {
      getVpStatusBroker().settleIdle({ groupId, vpId, threadId: threadId || 'main', title: thread?.title || '' });
    } catch (err) {
      console.warn('[Unify] vp-status settleIdle failed:', err?.message || err);
    }
    // fix-vp-multi-thread (bug 2): the bridge tracks per-thread status
    // on `thread.status` separately from the broker. Multiple sites
    // (`maybeTransitionVpStatus`, `routeEnvelopeToVpThread`'s typing
    // transition) write to it but no site cleared it on turn end, so
    // every finished thread was stuck reporting `thinking|streaming|tool`
    // forever. `getRunningThreads` filters on this field, so the
    // classifier next time the user spoke would treat the zombie as
    // a live thread and route the new query as "related" — orphaning
    // the message in `pendingQueries` because no engine was running
    // to drain it. Always settle to 'idle' here.
    if (thread) {
      thread.status = 'idle';
      thread.updatedAt = Date.now();
    }
  }
}

/**
 * Atomically append a completed VP-turn's messages to the GROUP'S
 * conversation history. Called once at turn end (not during streaming).
 *
 * Note: this does NOT see the engine's collapsed form — it appends the
 * raw user prompt(s) + the per-VP assistant text + tool results. Related
 * appends consumed by Engine loop-boundary hooks are passed in the prompt list
 * exactly once, with the same threadId as the running thread. The
 * engine's own `conversationMessages` (with T1/T2 collapse applied)
 * is persisted to disk via stop-hooks, so the next turn's history is
 * read from disk via `loadRecentByGroup` on next session boot. Within
 * a session, this in-memory tape carries the un-collapsed form — which
 * is fine because each VP turn's `engine.query` re-collapses on the fly.
 */
function appendTurnToGroupHistory(groupId, threadId, prompts, assistantTextParts, toolCallsAccum, toolResultsAccum, thinkingBlocksAccum) {
  if (!groupId) return;
  const history = getOrCreateGroupHistory(groupId);
  const promptList = Array.isArray(prompts) ? prompts : [prompts];
  for (const prompt of promptList) {
    if (typeof prompt === 'string' && prompt.trim()) {
      history.push({ role: 'user', content: prompt, threadId: threadId || 'main' });
    }
  }

  const fullText = assistantTextParts.join('');
  if (fullText || toolCallsAccum.length > 0) {
    const assistantMsg = { role: 'assistant', content: fullText, threadId: threadId || 'main' };
    if (toolCallsAccum.length > 0) {
      assistantMsg.toolCalls = toolCallsAccum.map(tc => ({
        id: tc.id,
        name: tc.name,
        input: tc.input,
      }));
    }
    // task-327d: carry thinking blocks across turns. Anthropic protocol
    // requires us to echo them back on the next request or the API
    // returns "content[].thinking in the thinking mode must be passed
    // back to the API". The signature is server-private — it stays in
    // this in-memory history and in agent-side persistence only.
    if (Array.isArray(thinkingBlocksAccum) && thinkingBlocksAccum.length > 0) {
      assistantMsg.thinkingBlocks = thinkingBlocksAccum.map(tb => (
        tb.redacted
          ? { redacted: true, data: tb.data, signature: tb.signature }
          : { thinking: tb.thinking, signature: tb.signature }
      ));
    }
    history.push(assistantMsg);

    for (const tr of toolResultsAccum) {
      history.push({
        role: 'tool',
        toolCallId: tr.toolCallId,
        content: tr.content,
        isError: tr.isError,
        threadId: threadId || 'main',
      });
    }
  }
}

/**
 * Persist an inbound message row to disk EXACTLY ONCE per
 * coordinator-ingest call, keyed by the coordinator-assigned `msgId`.
 * Both `handleUnifyGroupChat` (real user input, persists as
 * role='user') and `enqueueForVp`'s driver loop (route_forward
 * synthetic injections, persists as role='assistant' attributed via
 * `speakerVpId`) call this — the Set guard makes either path the
 * writer, whichever runs first, while the other becomes a no-op.
 *
 * Without this dedup, a 2-VP group prompt produces TWO `m{NNNN}.md`
 * user rows (one per engine) — `handleUnifyLoadHistory` then replays
 * the user's prompt twice and sandwiches one VP's reply between two
 * copies of the user message. Visually this reads as "messages out of
 * order" because the second copy of the user prompt sits BETWEEN the
 * two VPs' replies.
 *
 * Best-effort: a write failure does NOT abort the turn — engines can
 * still run, and the next user message will trigger another append.
 *
 * Note: we mirror `engine.#persistMessages`'s core user-row fields
 * (role/content/threadId/groupId) so existing parsers keep working.
 * Attachment UI metadata is persisted separately (without base64) so
 * refresh replay can render chips without leaking image source data into
 * the message body.
 *
 * @param {{ msgId:string, text:string, groupId:string, role?:string, speakerVpId?:string|null, attachments?:Array<object> }} args
 * @returns {boolean} true if this call wrote the row, false if a prior
 *   call already wrote it (dedup hit).
 */
function persistInboundMessageOnceByMsgId({ msgId, text, groupId, threadId = 'main', role, speakerVpId, attachments }) {
  if (!session?.conversationStore) return false;
  // No msgId means no dedup key — caller is responsible for guarding.
  // Both call sites already do (`if (envMsgId && text)` and
  // `if (persistedMsgId)`); refusing here keeps the helper's contract
  // clean. A synthetic-id fallback (Date.now+random) would defeat dedup —
  // every call would mint a unique id and write a duplicate row, which
  // is the exact bug this helper exists to prevent.
  if (!msgId || typeof msgId !== 'string') return false;
  const dedupKey = `${msgId}::${threadId || 'main'}`;
  if (_persistedUserMsgIds.has(dedupKey)) return false;
  // Mark BEFORE the empty-text bail. If a later same-id call arrives
  // with non-empty text (e.g. a route_forward injection that the first
  // caller passed in with empty text), the Set must already remember
  // this id so the second call dedups instead of writing.
  _persistedUserMsgIds.add(dedupKey);
  if (!text || typeof text !== 'string') return false;
  // Bound the Set so it doesn't grow unbounded over a long session.
  // 4096 msg-ids is well past any realistic "messages in flight"
  // window — once N drivers have observed the id, the rest can fall
  // back to "write again" without harm (the second writer would be a
  // duplicate, but it requires both: (a) the Set evicting an id AND
  // (b) a still-running driver getting around to its first persist).
  if (_persistedUserMsgIds.size > 4096) {
    const iter = _persistedUserMsgIds.values();
    for (let i = 0; i < 1024; i++) {
      const v = iter.next();
      if (v.done) break;
      _persistedUserMsgIds.delete(v.value);
    }
  }
  try {
    // role defaults to 'user' for back-compat: handleUnifyGroupChat's
    // real-user call site passes no role and gets a user row. The driver
    // loop passes role='assistant' + speakerVpId for route_forward
    // injections so the on-disk record correctly attributes the text to
    // the sending VP.
    const persistRole = role === 'assistant' ? 'assistant' : 'user';
    const record = {
      role: persistRole,
      content: text,
      threadId: threadId || 'main',
    };
    if (groupId) record.groupId = groupId;
    // Stamp speakerVpId so the UI's loadHistory replay can route the row
    // to the correct VP block. Only meaningful when role='assistant'; for
    // a real user message we leave it unset (the UI's user track is
    // unattributed).
    if (persistRole === 'assistant' && speakerVpId && typeof speakerVpId === 'string') {
      record.speakerVpId = speakerVpId;
    }
    if (persistRole === 'user' && Array.isArray(attachments) && attachments.length > 0) {
      record.attachments = attachments;
    }
    session.conversationStore.append(record);
    return true;
  } catch (err) {
    console.warn(
      '[Unify] persistInboundMessageOnceByMsgId failed (non-fatal):',
      err?.message || err,
    );
    return false;
  }
}

/**
 * Cleared on session reset (resetUnifySession) so a fresh session
 * starts with no stale msg-ids.
 */
const _persistedUserMsgIds = new Set();

// Per-group post-turn compaction lives on `session.compactor`
// (`agent/unify/compact/compactor.js`), constructed in `session.js`.
// Bridge passes a per-call `historyHandle = { get, set }` and wires the
// `unify_history_compacted` WS sink via `compactor.setOnCompacted` from
// `installUnifyRuntimeBridge`. The bridge keeps history ownership; the
// Compactor owns single-flight, anti-starvation, race-guard, and the
// LLM summarize call.

/**
 * Abort every in-flight VP turn and clear all queued envelopes across
 * every group/thread runtime. Shared by `handleUnifyAbortThread` when no
 * target thread is supplied and by `handleUnifyAbortAll`. Pushes `vp:<key>`
 * strings into the supplied `aborted` array for the unify_aborted event.
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
 * User-initiated abort. If threadId is provided, abort that VP thread;
 * otherwise abort every in-flight VP thread in the current runtime.
 *
 * @param {{ threadId?: string }} _msg
 * @returns {{ aborted: string[], all: boolean }}
 */
export function handleUnifyAbortThread(_msg = {}) {
  const aborted = [];
  const targetThreadId = _msg && typeof _msg.threadId === 'string' ? _msg.threadId : '';

  if (targetThreadId) {
    for (const [key, ctrl] of Array.from(vpAborts.entries())) {
      const parts = key.split('::');
      const threadId = parts[2] || 'main';
      if (threadId !== targetThreadId) continue;
      try {
        if (!ctrl.signal.aborted) { ctrl.abort(); aborted.push(`vp:${key}`); }
      } catch { /* best-effort */ }
      vpAborts.delete(key);
      const inbox = vpInboxes.get(key);
      if (Array.isArray(inbox)) inbox.length = 0;
    }
    for (const [turnId, ctrl] of Array.from(turnAbortCtrls.entries())) {
      const meta = turnAbortMeta.get(turnId);
      if ((meta?.threadId || 'main') !== targetThreadId) continue;
      try { if (!ctrl.signal.aborted) { ctrl.abort(); aborted.push(turnId); } } catch { /* best-effort */ }
      turnAbortCtrls.delete(turnId);
      turnAbortMeta.delete(turnId);
    }
    for (const vpMap of vpThreads.values()) {
      const thread = vpMap.get(targetThreadId);
      if (thread) thread.status = 'aborted';
    }
    sendUnifyEvent({ type: 'unify_aborted', aborted, all: false, threadId: targetThreadId });
    return { aborted, all: false };
  }

  if (currentAbortCtrl && !currentAbortCtrl.signal.aborted) {
    try { currentAbortCtrl.abort(); aborted.push('main'); } catch { /* best-effort */ }
  }
  currentAbortCtrl = null;
  for (const [turnId, ctrl] of turnAbortCtrls) {
    try { if (!ctrl.signal.aborted) { ctrl.abort(); aborted.push(turnId); } } catch { /* best-effort */ }
  }
  turnAbortCtrls.clear();
  turnAbortMeta.clear();
  abortAllVpRuntime(aborted);
  sendUnifyEvent({ type: 'unify_aborted', aborted, all: false });
  return { aborted, all: false };
}

/**
 * Abort all in-flight Unify runtime work.
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
  turnAbortMeta.clear();
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
    turnAbortMeta.delete(turnId);
    sendUnifyEvent({ type: 'unify_turn_aborted', turnId, success: true });
  } else {
    turnAbortCtrls.delete(turnId);
    turnAbortMeta.delete(turnId);
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

function seedAbortController(threadId, ctrl, groupId = 'test', vpId = 'vp', turnId = null) {
  const tid = threadId || 'main';
  const key = threadKey(groupId, vpId, tid);
  if (ctrl) vpAborts.set(key, ctrl);
  if (turnId && ctrl) {
    turnAbortCtrls.set(turnId, ctrl);
    turnAbortMeta.set(turnId, { groupId, vpId, threadId: tid, key });
  }
}

/** Test-only: seed an in-flight VP runtime controller. */
export function __testSeedAbortController(threadId, ctrl, groupId = 'test', vpId = 'vp') {
  seedAbortController(threadId, ctrl, groupId, vpId);
}

/** Test-only: seed an in-flight VP turn controller. */
export function __testSeedTurnAbortController(turnId, threadId, ctrl, groupId = 'test', vpId = 'vp') {
  if (!turnId || !ctrl) return;
  const tid = threadId || 'main';
  const key = threadKey(groupId, vpId, tid);
  turnAbortCtrls.set(turnId, ctrl);
  turnAbortMeta.set(turnId, { groupId, vpId, threadId: tid, key });
}

/** Test-only: returns registered VP runtime thread ids. */
export function __testGetRegisteredThreadIds() {
  const ids = [];
  for (const key of vpAborts.keys()) {
    const parts = key.split('::');
    ids.push(parts[2] || 'main');
  }
  if (currentAbortCtrl && !currentAbortCtrl.signal.aborted) ids.push('main');
  return Array.from(new Set(ids));
}

/**
 * Test-only: expose the bridge-level escalation helper. Lets tests verify
 * the "tool ignored signal → wrapper escalates" contract without booting a
 * full session. See `test/agent/unify/web-bridge-escalation.test.js`.
 */
export const __testRaceWithEscalation = raceWithEscalation;

/**
 * Manual dream trigger.
 *
 * Two call shapes, both routed through this single handler:
 *
 *   { type: 'unify_dream_trigger', vpId }     — per-VP trigger (legacy
 *     VP-detail page button). Fires an unscoped dream pass; the result
 *     event is tagged with `vpId` so the per-VP store row updates.
 *
 *   { type: 'unify_dream_trigger', groupId }  — per-GROUP trigger (new
 *     in v0.1.754 — added so users can manually kick dream for a group
 *     after seeing the Resident layer stuck on the bootstrap seed).
 *     Fires a scope-filtered pass via `triggerDreamForScopes(['group/X'])`
 *     so unrelated groups don't get processed; the result event is
 *     tagged with `groupId` for the per-group UI row.
 *
 * Backwards-compat: when neither field is set, defaults to `vpId='default'`
 * which matches the pre-v0.1.754 behavior.
 */
export function normalizeDreamResult(result) {
  const groups = Array.isArray(result?.groups) ? result.groups : [];
  const targets = Array.isArray(result?.targets) ? result.targets : [];
  const groupsProcessed = groups.filter(g => g && g.status === 'triaged').length;
  const skippedGroups = groups.filter(g => g && g.status === 'skipped');
  const groupsSkipped = skippedGroups.length;
  const targetsApplied = targets.filter(t => t && t.status === 'done').length;
  const targetErrors = targets
    .filter(t => t && t.status === 'error')
    .map(t => ({ target: t.target || null, error: t.error || 'unknown' }));
  const hardError = result?.error || null;
  const explicitSkipped = result?.skipped === true;
  const skipped = !hardError && (explicitSkipped || (groupsProcessed === 0 && targetsApplied === 0));
  const skippedReason = skipped
    ? (result?.skippedReason || skippedGroups[0]?.reason || 'no-targets-applied')
    : null;
  const trigger = result?.trigger || null;
  const success = !hardError && targetErrors.length === 0 && !skipped && targetsApplied > 0;

  return {
    success,
    skipped,
    skippedReason,
    groupsProcessed,
    groupsSkipped,
    targetsApplied,
    targetErrors,
    entriesCreated: targetsApplied,
    lastDreamAt: result?.startedAt || new Date().toISOString(),
    trigger,
    error: hardError || (targetErrors[0]?.error || null),
  };
}

export async function handleUnifyDreamTrigger(msg = {}) {
  // Resolve tag up-front so EVERY outbound envelope (including the
  // scheduler-uninitialised early-return below) carries `groupId` /
  // `vpId`. Without this the frontend's `applyDreamResult` couldn't
  // route the error event back to the right row and the per-group
  // "Run dream now" button would stay stuck on "Running…" forever
  // (review feedback from PR #757).
  const groupId = typeof msg.groupId === 'string' && msg.groupId ? msg.groupId : null;
  const vpId = !groupId ? (msg.vpId || 'default') : null;
  const tag = groupId ? { groupId } : { vpId };

  if (!session?.dreamScheduler) {
    const error = 'Dream scheduler not initialized — session not loaded.';
    sendToServer({
      type: 'unify_dream_result',
      ...tag,
      ...normalizeDreamResult({ error }),
    });
    return;
  }

  // Concurrent-trigger guard for scoped runs. Two scoped clicks (same
  // group or different) overlapping the same inflight pass used to set
  // the module-level groupId slot, race the sink wrapping, and let the
  // second `finally` restore the original sink while the first run was
  // still emitting events. We now refuse any second scoped trigger
  // while ANY scoped pass is inflight — the scheduler already
  // short-circuits the underlying run for same-group, and a different
  // group's filter would have been silently dropped anyway (see
  // dream-v2/schedule.js inflight reuse), so the user-facing semantics
  // are unchanged ("you already asked").
  if (groupId && inflightScopedDreamGroups.size > 0) {
    const skippedResult = {
      skipped: true,
      skippedReason: 'already-running',
      trigger: msg.manual === false ? 'auto' : 'manual',
    };
    sendToServer({
      type: 'unify_dream_result',
      ...tag,
      ...skippedResult,
      ...normalizeDreamResult(skippedResult),
    });
    return;
  }

  // Per-call sink wrapper. For scoped runs we install a closure that
  // injects this trigger's groupId onto top-level events the runner
  // emits without one (start/merge/done), then delegates to the
  // original passthrough sink. The wrapper lives only for the lifetime
  // of this trigger and is restored in `finally`; concurrent calls for
  // OTHER groupIds chain (last-installed wins) but each restoration
  // unwinds back to its predecessor.
  const originalSink = session?._dreamProgressSink;
  if (groupId && typeof originalSink === 'function') {
    inflightScopedDreamGroups.add(groupId);
    session._dreamProgressSink = (evt) => {
      try {
        const stamped = evt && evt.groupId
          ? evt
          : { ...evt, groupId };
        originalSink(stamped);
      } catch { /* never let event delivery throw */ }
    };
  }

  try {
    sendToServer({
      type: 'unify_dream_status',
      ...tag,
      status: 'running',
    });

    const result = groupId
      ? await session.dreamScheduler.triggerDreamForScopes([`group/${groupId}`])
      : await session.dreamScheduler.triggerDreamNow();

    const normalized = normalizeDreamResult(result);

    // Spread `result` FIRST so normalized fields (success, skipped,
    // skippedReason, groupsProcessed, groupsSkipped, targetsApplied,
    // targetErrors, entriesCreated, lastDreamAt) authoritatively shadow
    // anything the runner might grow
    // with the same name. Today there is no collision (runner.js returns
    // { groups, targets, startedAt, error?, skipped? }) but the failure
    // mode of the alternative ordering is silent — review feedback from
    // PR #743.
    //
    // This `unify_dream_result` envelope is the SOLE terminal signal for
    // a dream pass. The chat-store projects it into BOTH `unifyDreamLatest`
    // (final tally row) AND `unifyDreamEvents` (ring-buffer terminal
    // marker), so we no longer mirror a synthetic `phase:'result'`
    // dream_progress event — that mirror used to race the
    // `unifyDreamLatest` writer and flip the success row back to
    // 'running' (Critical reviewer finding pre-merge).
    sendToServer({
      type: 'unify_dream_result',
      ...tag,
      ...result,
      ...normalized,
    });
  } catch (err) {
    const error = err?.message || String(err);
    sendToServer({
      type: 'unify_dream_result',
      ...tag,
      ...normalizeDreamResult({ error }),
    });
  } finally {
    // Restore the original sink and release the per-group inflight lock.
    if (groupId && typeof originalSink === 'function') {
      session._dreamProgressSink = originalSink;
      inflightScopedDreamGroups.delete(groupId);
    }
  }
}

/**
 * 2026-05-13: serve the Unify debug drawer's "Tool Stats" panel.
 *
 * Replies with `{type: 'unify_tool_stats', snapshot, registered,
 * unused}`. `snapshot` is the `ToolUsageStats.snapshot()` keyed by
 * tool name (callCount, errorCount, p50Ms, p95Ms, avgMs, lastCalledAt,
 * lastError, errorRate). `registered` is the static list of built-in
 * tool names so the frontend can render the "(defined but never
 * called)" subview without spinning up its own registry mirror.
 *
 * Best-effort: if the session hasn't booted yet or toolStats is
 * missing, we still reply with an empty snapshot so the UI can render
 * a placeholder rather than spin forever.
 */
export async function handleUnifyFetchToolStats(_msg = {}) {
  let snapshot = {};
  let registered = [];
  let unused = [];
  try {
    if (session?.toolStats && typeof session.toolStats.snapshot === 'function') {
      snapshot = session.toolStats.snapshot();
    }
    // Pull the static built-in tool list. MCP/skill tools aren't in
    // here — that's fine: the "unused" view is meant to flag stale
    // built-in tools, not user-installed ones.
    const { allTools } = await import('./tools/index.js');
    if (Array.isArray(allTools)) {
      registered = allTools
        .filter(t => t && typeof t.name === 'string' && t.name)
        .map(t => t.name);
    }
    if (session?.toolStats && typeof session.toolStats.getRegisteredButUncalled === 'function') {
      unused = session.toolStats.getRegisteredButUncalled(registered);
    }
  } catch (err) {
    sendToServer({
      type: 'unify_tool_stats',
      snapshot: {},
      registered: [],
      unused: [],
      error: err && err.message ? err.message : String(err),
    });
    return;
  }
  sendToServer({
    type: 'unify_tool_stats',
    snapshot,
    registered,
    unused,
  });
}

/**
 * Hydrate the UnifyDebugPanel from the persistent SQLite trace. The
 * panel state (`unifyDebugLoops` / `unifyDebugTurnsById`) is otherwise
 * built ONLY from in-flight `loop` / `turn_open` events on the wire,
 * so a panel opened after a turn has finished sees nothing for that
 * turn. This handler ships back a frontend-shaped snapshot the store
 * splices into place.
 *
 * Inputs (all optional):
 *   - `limit`     — max number of loops to return (1..500, default 100)
 *   - `groupId`   — narrow by group
 *   - `threadId`  — narrow by thread
 *
 * Sends:
 *   { type: 'unify_debug_history', loops: [...], turns: [...] }
 *
 * Best-effort: if the session / trace isn't ready, sends an empty
 * snapshot so the panel renders a placeholder instead of spinning.
 */
export async function handleUnifyFetchDebugHistory(msg = {}) {
  const limit = Number.isFinite(msg?.limit) ? Number(msg.limit) : 100;
  const dreamLimit = Number.isFinite(msg?.dreamLimit) ? Number(msg.dreamLimit) : 5;
  const groupId = typeof msg?.groupId === 'string' && msg.groupId ? msg.groupId : null;
  const threadId = typeof msg?.threadId === 'string' && msg.threadId ? msg.threadId : null;
  let loops = [];
  let turns = [];
  let dreamEvents = [];
  try {
    if (session?.trace && typeof session.trace.fetchRecentDebugHistory === 'function') {
      const out = session.trace.fetchRecentDebugHistory({ limit, dreamLimit, groupId, threadId });
      loops = Array.isArray(out?.loops) ? out.loops : [];
      turns = Array.isArray(out?.turns) ? out.turns : [];
      dreamEvents = Array.isArray(out?.dreamEvents) ? out.dreamEvents : [];
    }
  } catch (err) {
    sendToServer({
      type: 'unify_debug_history',
      loops: [],
      turns: [],
      dreamEvents: [],
      error: err && err.message ? err.message : String(err),
    });
    return;
  }
  sendToServer({
    type: 'unify_debug_history',
    loops,
    turns,
    dreamEvents,
    groupId,
    threadId,
  });
}

/** Deprecated mode switch — Unify is single-mode. */
export function handleUnifyModeSwitch(_msg) {
  console.warn('[Unify] unify_mode_switch is deprecated and ignored — Unify now runs in a single unified mode.');
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
      serverMode: true,
    });
    installUnifyRuntimeBridge(session);

    unifyConversationId = `unify-${Date.now()}`;

    // Per-group history hydrates lazily via getOrCreateGroupHistory.
    // When the load-history call carries a groupId, force-refresh THAT
    // group's tape so the next user message sees on-disk state. When
    // it doesn't (legacy callers), do nothing — the per-group lazy
    // hydration handles it.
    if (groupId) setGroupHistory(groupId, hydrateGroupHistory(groupId));
  } else if (groupId) {
    // Re-entering an existing session with a (possibly new) group filter:
    // re-seed THIS group's history from disk so it doesn't carry stale
    // in-memory state into the next turn's context.
    setGroupHistory(groupId, hydrateGroupHistory(groupId));
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
    yeaftDir: ctx.CONFIG?.yeaftDir || null,
  });
  sendGroupSnapshotBroadcast();
  // vp-status: replay the authoritative table on reconnect so a refreshed
  // frontend doesn't have to wait for the next transition to learn each
  // VP's current state.
  try {
    getVpStatusBroker().broadcastSnapshot();
  } catch (err) {
    console.warn('[Unify] vp-status snapshot broadcast (replay) failed:', err?.message || err);
  }

  // `msg.limit` is the replay-scrollback request from the frontend (UI
  // history pane, not engine context). Semantics changed (2026-05-01):
  // now expressed in TURNS. The previous default (50 messages) maps to
  // ~20–25 turns; in the turn-count world 50 turns of UI scrollback is
  // still cheap and matches what the frontend already passes through.
  const limit = (typeof msg.limit === 'number') ? msg.limit : 50;
  const visiblePage = groupId
    ? loadVisibleGroupHistoryPage(session.conversationStore, groupId, limit)
    : { messages: limit > 0 ? pickRecent(session.conversationStore, limit) : [], oldestSeq: null, hasMore: false };
  const compactSummary = session.conversationStore.readCompactSummary();
  const replayEntries = groupId
    ? visiblePage.messages
    : visiblePage.messages
      .map(projectPersistedToVisibleHistoryEntry)
      .filter(Boolean);

  for (const entry of replayEntries) {
    if (entry.role === 'user') {
      sendUnifyOutput({
        type: 'user',
        message: {
          content: entry.content,
          id: entry.id || null,
          ...(Array.isArray(entry.attachments) && entry.attachments.length > 0 ? { attachments: hydrateHistoryAttachmentPreviews(entry.attachments) } : {}),
        },
        ts: entry.ts || null,
      }, { groupId: entry.groupId || null });
    } else if (entry.role === 'assistant') {
      // speakerVpId rides on the envelope so the frontend can route this
      // replayed assistant text to the correct VP track. Without it, the
      // history replay would merge replies from different VPs onto one
      // anonymous assistant turn.
      const envelopeOpts = {
        groupId: entry.groupId || null,
      };
      if (entry.speakerVpId) envelopeOpts.vpId = entry.speakerVpId;
      sendUnifyOutput({
        type: 'assistant',
        message: { id: entry.id || null, content: [{ type: 'text', text: entry.content }] },
        ts: entry.ts || null,
      }, envelopeOpts);
      sendUnifyOutput({ type: 'result', result_text: '' }, envelopeOpts);
    }
  }

  // Compute the pagination cursor for the bootstrap load so the frontend
  // knows whether a "Load older messages" hint should be shown and where
  // to start the next page. For group history, this is computed from the
  // visible projected page, not raw persisted rows, so reflection/internal
  // tail rows cannot consume the bootstrap window or create false hasMore.
  let hasMore = false;
  let oldestSeq = null;
  if (groupId) {
    hasMore = visiblePage.hasMore;
    oldestSeq = visiblePage.oldestSeq;
  }

  sendUnifyEvent({
    type: 'history_loaded',
    count: replayEntries.length,
    hasCompactSummary: !!compactSummary,
    totalHot: session.conversationStore.countHot(),
    totalCold: session.conversationStore.countCold(),
    groupId,
    hasMore,
    oldestSeq,
  });
}

/**
 * Handle a "load older messages" pagination request. Reads `turns` more
 * turns of history strictly older than `beforeSeq` for `groupId`, and
 * emits them in a single `unify_history_chunk` envelope (NOT a
 * `unify_output` — that pipeline appends, but the frontend needs to
 * PREPEND these older messages above what it already has).
 *
 * Tool replay is NOT included in this PR — same projection as
 * `handleUnifyLoadHistory` (user / assistant text only). On any internal
 * failure we still emit an empty chunk so the spinner clears.
 *
 * @param {object} msg — { groupId, beforeSeq, turns }
 */
export async function handleUnifyLoadMoreHistory(msg) {
  const groupId = (msg && typeof msg.groupId === 'string' && msg.groupId) || null;
  const emit = (payload) => sendToServer({
    type: 'unify_history_chunk',
    conversationId: unifyConversationId,
    groupId,
    ...payload,
  });

  if (!session || !groupId) {
    emit({ messages: [], oldestSeq: null, hasMore: false });
    return;
  }

  const beforeSeq = (typeof msg.beforeSeq === 'number') ? msg.beforeSeq : null;
  const turns = (typeof msg.turns === 'number' && msg.turns > 0) ? msg.turns : 20;

  let result;
  try {
    result = loadVisibleGroupHistoryPage(session.conversationStore, groupId, turns, beforeSeq);
  } catch (err) {
    console.error('[Unify] loadOlderByGroup failed:', err.message);
    result = { messages: [], oldestSeq: null, hasMore: false };
  }

  // Wire shape mirrors handleUnifyLoadHistory's projection: only visible
  // user / assistant text rows. Internal reflection/system-only rows stay
  // server-side, and stable ids + speaker attribution ride with each row
  // so older-history prepend renders exactly like refresh replay.
  const projected = (result.messages || [])
    .map(m => ({
      ...(m.id ? { id: m.id } : {}),
      role: m.role,
      content: m.content,
      groupId: m.groupId || null,
      ...(Array.isArray(m.attachments) && m.attachments.length > 0 ? { attachments: hydrateHistoryAttachmentPreviews(m.attachments) } : {}),
      ...(m.speakerVpId ? { speakerVpId: m.speakerVpId } : {}),
    }));

  emit({
    messages: projected,
    oldestSeq: result.oldestSeq,
    hasMore: !!result.hasMore,
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
  // Per-group histories live on groupContexts entries — clearing the
  // map (a few lines below) drops every group's history with it. No
  // separate global tape to clear.
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
  turnAbortCtrls.clear();
  turnAbortMeta.clear();
  vpInboxes.clear();
  vpDrivers.clear();
  vpEngines.clear();
  groupContexts.clear();
  vpCurrentTodos.clear();
  threadClassifier = defaultClassifyThread;
  // History-dedup cache is keyed by per-session coordinator msg ids;
  // a fresh session resets the id space, so clear the cache too.
  _persistedUserMsgIds.clear();
  // vp-status: nuke the broker table too. Drivers above have just
  // been aborted, so any in-flight `settleIdle` from their outer
  // `finally` blocks is racing this reset. Clearing here makes the
  // post-reset `broadcastSnapshot` (further down) emit an empty
  // table, and the frontend mirror clears in lockstep.
  try {
    getVpStatusBroker().reset();
  } catch (err) {
    console.warn('[Unify] vp-status broker reset failed:', err?.message || err);
  }

  try {
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    session = await loadSession({
      ...(yeaftDir && { dir: yeaftDir }),
      skipMCP: false,
      skipSkills: false,
      serverMode: true,
    });
    installUnifyRuntimeBridge(session);

    unifyConversationId = `unify-${Date.now()}`;

    // Per-group history hydrates lazily via getOrCreateGroupHistory on
    // first read. Nothing to seed here.

    sendUnifyEvent({
      type: 'session_ready',
      conversationId: unifyConversationId,
      model: session.config.model,
      availableModels: session.config.availableModels || [],
      skills: session.status.skills,
      mcpServers: session.status.mcpServers,
      tools: session.status.tools,
      yeaftDir: ctx.CONFIG?.yeaftDir || null,
    });
    // vp-status: after a forced reset the broker table is still live in
    // memory; broadcast so the frontend can rebuild its mirror without
    // waiting for the first per-VP transition.
    try {
      getVpStatusBroker().broadcastSnapshot();
    } catch (err) {
      console.warn('[Unify] vp-status snapshot broadcast (reset) failed:', err?.message || err);
    }
  } catch (err) {
    console.error('[Unify] Failed to re-initialize session after reset:', err.message);
  }
}
