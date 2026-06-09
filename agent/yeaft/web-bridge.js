/**
 * web-bridge.js — Bridge between web UI and Yeaft Yeaft Engine.
 *
 * PR #797: group VP runtime is threaded again. Each group VP can own multiple
 * classified threads, keyed by (sessionId, vpId, threadId), with separate engine,
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
  SessionCrudError,
  createSessionFromSpec,
  renameSession,
  updateSessionAnnouncement,
  archiveSession,
  deleteSession,
  purgeArchivedSessions,
  addMember,
  removeMember,
  setSessionDefaultVp,
  snapshotSessions,
  resolveSessionYeaftDir,
  sessionsRoot,
  scanWorkdirSessions,
  restoreSessionToRegistry,
  readWorkDirRegistry,
} from './sessions/session-crud.js';
import { openSession, loadSessionMeta } from './sessions/session-store.js';
import { loadSessionConfig, resolveSessionConfig, SessionConfigError } from './sessions/session-config.js';
import { updateSessionConfig } from './sessions/session-crud.js';
import { createCoordinator } from './sessions/coordinator.js';
import { seedDefaultSession } from './sessions/seed-default.js';
import {
  trimSnapshotForBudget,
} from './history-compact.js';
import { persistYeaftAttachments, attachmentsForPersistence, persistedAttachmentPreviewPayload } from './attachments.js';
import { parseSeqFromId } from './conversation/persist.js';
import { sliceLastNTurns } from './turn-utils.js';
import { pairSanitize } from './pair-sanitize.js';
import { filterSnapshotForVp } from './snapshot-filter.js';
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
 * sessionId. Used by `handleYeaftDreamTrigger` to reject any overlapping
 * scoped trigger rather than racing the sink-wrapping logic against
 * itself.
 *
 * Cross-group overlap is rejected (not just same-group): under the
 * existing dream scheduler a second concurrent trigger silently shares
 * the first's inflight promise and dropped its own scope filter. So
 * "B during A's run" doesn't actually produce a separate scoped pass
 * for B — letting B install a second sink wrapper would only mis-stamp
 * A's events with B's sessionId. Reporting B as an explicit skipped
 * result is the honest answer; the user can re-click after A settles.
 * @type {Set<string>}
 */
const inflightScopedDreamGroups = new Set();

/**
 * Single in-flight AbortController for legacy 1:1 chat. A new 1:1 user message
 * cancels the prior round (if any).
 *
 * Group VP turns do not flow through this slot. They each get their own
 * controller in `vpAborts` keyed by `${sessionId}::${vpId}::${threadId}`.
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
 * independently (per-VP Stop button). `handleYeaftAbortTurn` looks up by
 * turnId to abort a single VP. `handleYeaftAbortAll` iterates and aborts all.
 * @type {Map<string, AbortController>}
 */
const turnAbortCtrls = new Map();

/**
 * Per-turn runtime ownership. Targeted thread aborts use this instead of
 * blindly aborting every turn controller in the process.
 * @type {Map<string, { sessionId: string, vpId: string, threadId: string, key: string }>}
 */
const turnAbortMeta = new Map();

/**
 * Per-VP status broker — the agent-side authority for VP timeline
 * status. Lazy-initialized on first use because `sendYeaftEvent` is
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
        // `vp_status_snapshot`. Both ride the standard sendYeaftEvent
        // envelope so the frontend's existing yeaft_output dispatcher
        // sees them. We stamp sessionId/vpId on the envelope for
        // events that target a specific VP so the server's per-client
        // routing (sessionId scoping, etc.) works the same way as
        // typing events.
        const env = {};
        if (event && typeof event === 'object') {
          if (event.sessionId) env.sessionId = event.sessionId;
          if (event.vpId) env.vpId = event.vpId;
          if (event.turnId) env.turnId = event.turnId;
        }
        sendYeaftEvent(event, env);
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
 *      `${sessionId}::${vpId}::${threadId}` rather than vpId alone because
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
 * Per-(sessionId, vpId) current TodoWrite list. Each VP in a group keeps
 * its own todo state so two VPs in the same group can independently
 * track multi-step tasks without overwriting each other. Threaded into
 * the engine's tool ctx via buildVpQueryOpts → getCurrentTodos /
 * setCurrentTodos closures. Best-effort in-memory cache only — todos
 * are also stamped into the LLM event stream (the frontend reads from
 * the tool_use input, not from this map), so a server restart simply
 * loses the "what was the most recent list?" peek without breaking the
 * UI replay.
 *
 * Key: `${sessionId}::${vpId}` (matches vpEngines/vpAborts convention).
 * Value: `Array<{content, status, activeForm}>` — the last full list
 * the VP wrote with TodoWrite.
 *
 * @type {Map<string, Array<{content: string, status: string, activeForm: string}>>}
 */
const vpCurrentTodos = new Map();
/**
 * Per-group cached coordinator + router. Created on first
 * `handleYeaftSessionSend` for a given sessionId; reused across user messages
 * AND across `route_forward` deliveries inside running VP turns (the
 * router is wired into engine ctx; if we recreated coord per turn the
 * route_forward path would deliver into a freshly-created `captured[]`
 * that nobody consumes — exactly the pre-707 bug).
 *
 * Purge sites:
 *   - `invalidateGroupContext(sessionId)` — called from every group CRUD
 *     handler that mutates roster / meta / lifecycle state on disk
 *     (rename, update announcement, archive, delete, add/remove member,
 *     set default VP).
 *   - `handleYeaftSessionSend` — invalidates inline when its own
 *     auto-add / default-VP-heal pass mutated the roster.
 *   - `resetYeaftSession` and `__testResetVpState` clear the whole map.
 *
 * @type {Map<string, { coord: ReturnType<typeof createCoordinator>,
 *                     router: ReturnType<typeof createRouter>,
 *                     sessionHandle: object }>}
 */
const sessionContexts = new Map();

function vpKey(sessionId, vpId) {
  return `${sessionId}::${vpId}`;
}

function threadKey(sessionId, vpId, threadId) {
  return `${sessionId}::${vpId}::${threadId || 'main'}`;
}

function createThreadId() {
  return `thr_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

const RUNNING_THREAD_STATES = new Set(['queued', 'typing', 'thinking', 'streaming', 'tool']);
/** @type {Map<string, Map<string, object>>} */
const vpThreads = new Map();
/** @type {Map<string, Set<Promise<string|null>>>} */
const routePromisesByMsgId = new Map();

function getVpThreadMap(sessionId, vpId) {
  const key = vpKey(sessionId, vpId);
  let map = vpThreads.get(key);
  if (!map) {
    map = new Map();
    vpThreads.set(key, map);
  }
  return map;
}

function getRunningThreads(sessionId, vpId) {
  return Array.from(getVpThreadMap(sessionId, vpId).values())
    .filter(t => t && RUNNING_THREAD_STATES.has(t.status));
}

function getOrCreateVpThread({ sessionId, vpId, threadId, title }) {
  const map = getVpThreadMap(sessionId, vpId);
  const id = threadId || createThreadId();
  let thread = map.get(id);
  const now = Date.now();
  if (!thread) {
    thread = {
      threadId: id,
      sessionId,
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
 * the cached coord holds a closed `sessionHandle`, so without invalidation
 * later route_forward / ingest calls would read zombie meta (stale
 * roster, pre-rename announcement, kicked members still routable).
 *
 * Idempotent — safe to call when no entry exists.
 */
function invalidateGroupContext(sessionId) {
  if (!sessionId) return;
  sessionContexts.delete(sessionId);
  const prefix = `${sessionId}::`;
  for (const [k, ctrl] of vpAborts) {
    if (!k.startsWith(prefix)) continue;
    try { if (!ctrl.signal.aborted) ctrl.abort(); } catch { /* best-effort */ }
    vpAborts.delete(k);
  }
  for (const [turnId, meta] of Array.from(turnAbortMeta.entries())) {
    if (meta?.sessionId !== sessionId) continue;
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
  // closed sessionHandle — they don't reach the on-disk group meta
  // directly. They *are* dropped on `resetYeaftSession`.
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

/** Virtual conversationId for the Yeaft session */
let yeaftConversationId = null;

/** task-334-followup-batch-b: stored unsubscribe fn from VP subscribe,
 *  called on session reset to prevent stale subscriber leaks. */
let _vpUnsubscribe = null;

/**
 * Per-group conversation history lives on the GroupContext entry
 * (`sessionContexts.get(sessionId).history`). The pre-refactor module-level
 * `conversationMessages` was a single array shared across every group —
 * a user prompt in group-A would leak into group-B's next-turn snapshot
 * because the bridge appended every turn to the same array regardless
 * of which group it belonged to. Disk was group-tagged correctly, but
 * the in-memory tape was unified.
 *
 * Post-refactor: each GroupContext owns its own `history`, lazily
 * hydrated from `conversationStore.loadRecentBySession(sessionId)` on first
 * access. Group-A and group-B are isolated.
 *
 * @typedef {Array<{role:'user'|'assistant'|'tool', content:string|Array, toolCalls?:Array, toolCallId?:string, isError?:boolean}>} GroupHistory
 */

/**
 * @typedef {Object} GroupContextEntry
 * @property {object|null} coord — group coordinator (lazily built by getOrCreateSessionContext)
 * @property {object|null} router — message router (lazily built by getOrCreateSessionContext)
 * @property {object|null} sessionHandle — opened group handle (lazily built by getOrCreateSessionContext)
 * @property {GroupHistory} history — per-group conversation tape
 * @property {boolean} historyHydrated — true once history has been loaded
 *   from disk (or explicitly assigned). The flag is required because an
 *   empty array is legitimate post-consolidate / post-clear state and
 *   MUST NOT trigger a re-hydrate. Without the flag, a partial entry
 *   would short-circuit `getOrCreateSessionHistory` on truthy `[]` and skip
 *   the disk load.
 */

/** Build a fresh stub entry with no coord/router/history loaded. */
function makeGroupContextStub() {
  return {
    coord: null,
    router: null,
    sessionHandle: null,
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
  entry.threadId = m.threadId || m.turnId || 'main';
  entry.turnId = m.turnId || entry.threadId;
  if (m.sessionId) entry.sessionId = m.sessionId;
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
  else if (m.time) entry.ts = m.time;
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

function loadVisibleGroupHistoryPage(store, sessionId, limit, beforeSeq = null) {
  if (!store || !sessionId || !(limit > 0)) return { messages: [], oldestSeq: null, hasMore: false };

  let rows = [];
  try {
    if (typeof store.loadVisibleBySession === 'function') {
      const page = store.loadVisibleBySession(sessionId, beforeSeq, limit);
      return {
        messages: (page.messages || []).map(projectPersistedToVisibleHistoryEntry).filter(Boolean),
        oldestSeq: (typeof page.oldestSeq === 'number') ? page.oldestSeq : null,
        hasMore: !!page.hasMore,
      };
    } else if (typeof store.loadOlderBySession === 'function') {
      // Compatibility fallback for older test doubles: use an unbounded raw
      // prefix, then project/slice visible rows below.
      rows = store.loadOlderBySession(sessionId, beforeSeq, Infinity).messages || [];
    } else if (Number.isFinite(beforeSeq)) {
      const all = typeof store.loadAllBySession === 'function'
        ? store.loadAllBySession(sessionId)
        : store.loadRecentBySession(sessionId, Infinity);
      rows = all.filter(m => parseSeqFromId(m?.id) < beforeSeq);
    } else if (typeof store.loadAllBySession === 'function') {
      rows = store.loadAllBySession(sessionId);
    } else {
      rows = store.loadRecentBySession(sessionId, Infinity);
    }
  } catch (err) {
    console.error('[Yeaft] visible history page load failed:', err?.message || err);
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
 * @param {string} sessionId
 * @returns {GroupHistory}
 */
function hydrateGroupHistory(sessionId) {
  if (!session?.conversationStore || !sessionId) return [];
  let recent;
  try {
    recent = session.conversationStore.loadRecentBySession(sessionId);
  } catch (err) {
    console.warn('[Yeaft] hydrateGroupHistory failed (sessionId=%s):', sessionId, err?.message || err);
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
 * inserts an entry into `sessionContexts` on first access — no
 * `sessionHandle` required (history is independent of coord/router
 * lifecycle, so a sub-agent / route_forward path that hasn't yet
 * opened the group can still read history).
 *
 * Returns the SAME array reference across calls within the same
 * lifecycle, so consumers can mutate-in-place. Reassigned only by
 * compact (race guard checks reference equality), `consolidate`
 * events, and session reset.
 *
 * @param {string} sessionId
 * @returns {GroupHistory}
 */
function getOrCreateSessionHistory(sessionId) {
  if (!sessionId) return [];
  let entry = sessionContexts.get(sessionId);
  // Use `historyHydrated` rather than truthiness on `history` itself —
  // an empty array (post-consolidate, post-clear, or a partial entry
  // seeded by an early `getOrCreateSessionContext` call before data was
  // loaded) is legitimate state that does NOT mean "needs hydration"...
  // unless we never loaded from disk in the first place. The flag
  // separates the two cases.
  if (entry && entry.historyHydrated) return entry.history;
  if (!entry) {
    entry = makeGroupContextStub();
    sessionContexts.set(sessionId, entry);
  }
  entry.history = hydrateGroupHistory(sessionId);
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
 * @param {string} sessionId
 * @param {GroupHistory} next
 */
function setGroupHistory(sessionId, next) {
  if (!sessionId) return;
  let entry = sessionContexts.get(sessionId);
  if (!entry) {
    entry = makeGroupContextStub();
    sessionContexts.set(sessionId, entry);
  }
  entry.history = next;
  entry.historyHydrated = true;
}

/**
 * Test-only access to a group's history array. Re-exported below as
 * `__testGroupHistory`. Lets tests pin the per-group isolation contract
 * without booting a full session.
 *
 * @param {string} sessionId
 */
export function __testGroupHistory(sessionId) {
  return getOrCreateSessionHistory(sessionId);
}

/**
 * Test-only: install a minimal `session` so `hydrateGroupHistory` can
 * read from a real `ConversationStore`. Pass `null` to clear.
 *
 * Tests that need to verify the hydrate-from-disk path can construct a
 * `ConversationStore` against a tmp dir, write per-group records via
 * `store.append({sessionId, ...})`, then call this helper to wire the
 * store into the bridge before calling `__testGroupHistory(sessionId)`.
 *
 * @param {{ conversationStore: object } | null} sessionLike
 */
export function __testSetSession(sessionLike) {
  session = sessionLike;
}

/**
 * Test-only: peek at the GroupContext entry for a group (or undefined
 * if never seeded). Lets tests assert the `historyHydrated` flag without
 * exporting the entire `sessionContexts` Map.
 *
 * @param {string} sessionId
 */
export function __testGroupContextEntry(sessionId) {
  return sessionContexts.get(sessionId);
}

/**
 * Test-only: build (or return cached) per-VP Engine for a session that
 * was wired via `__testSetSession`. Lets tests assert that the engine's
 * dependencies (notably `toolStats`) come from the session reference —
 * see `test/agent/web-bridge-vp-engine-tool-stats.test.js`.
 *
 * @param {string} sessionId
 * @param {string} vpId
 */
export function __testGetOrCreateVpEngine(sessionId, vpId, threadId = 'main') {
  return getOrCreateVpEngine(sessionId, vpId, threadId);
}


/** Test-only: inspect runtime thread rows for a VP. */
export function __testGetVpThreads(sessionId, vpId) {
  const map = vpThreads.get(vpKey(sessionId, vpId));
  return Array.from((map || new Map()).values()).map((thread) => ({
    threadId: thread.threadId,
    sessionId: thread.sessionId,
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
export function __testEnqueueForVp(sessionId, vpId, envelope) {
  return enqueueForVp(sessionId, vpId, envelope);
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
 * @param {string} sessionId
 * @param {string} vpId
 * @returns {import('./engine.js').Engine}
 */
function getOrCreateVpEngine(sessionId, vpId, threadId = 'main') {
  const key = threadKey(sessionId, vpId, threadId);
  let eng = vpEngines.get(key);
  if (eng) return eng;
  if (!session) throw new Error('getOrCreateVpEngine: session not loaded');
  // Per-group config overlay (v1: model only). Falls back to the
  // session's user-level config when no override is set. The resolver
  // never mutates session.config — it returns a new object.
  const yeaftDir = ctx.CONFIG?.yeaftDir || session.yeaftDir;
  const groupCfg = loadSessionConfig(yeaftDir, sessionId);
  const effectiveConfig = resolveSessionConfig(session.config, groupCfg);
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
    // in the same on-disk snapshot the `yeaft_fetch_tool_stats` handler
    // reads. Without this, engine's record-on-tool-exec guard
    // (`if (this.#toolStats && ...)`) is false and group VP tool calls
    // are silently dropped.
    toolStats: session.toolStats || null,
    // Per-VP fan-out: bind the engine to its (sessionId, vpId) so post-turn
    // compact reads/writes a scoped summary instead of the legacy global
    // compact.md (which every VP would otherwise share, producing
    // identical, ever-growing summaries across groups).
    sessionId,
    vpId,
  });
  vpEngines.set(key, eng);
  return eng;
}

/**
 * Get-or-create the persistent per-group coordinator + router.
 *
 * The coordinator MUST be reused across user turns AND across in-flight
 * tool calls (route_forward) — its `deliver` callback is the only way
 * envelopes reach `vpInboxes`. If we recreated it per `handleYeaftSessionSend`
 * call (the pre-707 design), `route_forward` running mid-turn would
 * deliver into a doomed `captured[]` while the new dispatch ran against
 * a fresh coordinator. The persistent coordinator + module-level inboxes
 * close that gap.
 *
 * Caller is responsible for passing in a freshly-opened sessionHandle on
 * first creation; subsequent calls reuse the cached coord.
 *
 * @param {string} sessionId
 * @param {object} sessionHandle — only used on first creation
 * @returns {{ coord: object, router: object, sessionHandle: object }}
 */
function getOrCreateSessionContext(sessionId, sessionHandle) {
  let entry = sessionContexts.get(sessionId);
  if (entry && entry.coord && entry.router) return entry;
  // Either no entry, or a partial entry seeded by `getOrCreateSessionHistory`
  // (no coord/router yet). Build the coord/router and merge into the
  // existing record so the per-group history reference and hydration
  // flag are preserved.
  const coord = createCoordinator(sessionHandle, {
    deliver: (vpId, envelope) => enqueueForVp(sessionId, vpId, envelope),
  });
  const router = createRouter({ coordinator: coord });
  if (!entry) {
    entry = makeGroupContextStub();
    sessionContexts.set(sessionId, entry);
  }
  entry.coord = coord;
  entry.router = router;
  entry.sessionHandle = sessionHandle;
  // Defend against a future caller that builds a coord/router without
  // having gone through `getOrCreateSessionHistory` first: a partial entry
  // could exist with `historyHydrated:false`, so do the load now.
  if (!entry.historyHydrated) {
    entry.history = hydrateGroupHistory(sessionId);
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
 * @param {string} sessionId
 * @param {string} vpId
 * @param {object} envelope — coordinator envelope `{sessionId, taskId, msg, trigger}`
 */
function enqueueForVp(sessionId, vpId, envelope) {
  const routePromise = routeEnvelopeToVpThread(sessionId, vpId, envelope);
  registerRoutePromise(envelope?.msg?.id, routePromise);
}

async function routeEnvelopeToVpThread(sessionId, vpId, envelope) {
  const { text, prompt, promptParts } = buildVpPromptPayload(vpId, envelope);
  const runningThreads = getRunningThreads(sessionId, vpId);
  let thread = null;
  let related = false;

  if (runningThreads.length === 0) {
    thread = getOrCreateVpThread({ sessionId, vpId, title: fallbackTitle(text) });
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
        sessionId,
        vpId,
        threadId: decision.targetThreadId,
        title: decision.title,
      });
      related = true;
    } else {
      thread = getOrCreateVpThread({
        sessionId,
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
      sessionId,
      threadId: thread.threadId,
      role: envelope?.msg?.meta?.injectedBy === 'route_forward' ? 'assistant' : 'user',
      speakerVpId: envelope?.msg?.meta?.senderVpId || envelope?.msg?.from || null,
      attachments: Array.isArray(envelope?.msg?.meta?.attachments) ? envelope.msg.meta.attachments : [],
    });
    thread.updatedAt = Date.now();
    try {
      sendYeaftEvent({
        type: 'vp_thread_user_appended',
        sessionId,
        vpId,
        threadId: thread.threadId,
        title: thread.title,
        turnId,
        ts: Date.now(),
      }, { sessionId, vpId, threadId: thread.threadId, turnId });
    } catch { /* never crash WS pipeline */ }
    return thread.threadId;
  }

  const key = threadKey(sessionId, vpId, thread.threadId);
  let inbox = vpInboxes.get(key);
  if (!inbox) {
    inbox = [];
    vpInboxes.set(key, inbox);
  }
  inbox.push({ envelope, turnId, thread });

  try {
    sendYeaftEvent({
      type: 'vp_typing_start',
      sessionId,
      vpId,
      threadId: thread.threadId,
      turnId,
      ts: Date.now(),
    }, { sessionId, vpId, threadId: thread.threadId, turnId });
  } catch { /* never crash WS pipeline */ }

  try {
    thread.status = 'typing';
    getVpStatusBroker().transition({
      sessionId,
      vpId,
      threadId: thread.threadId,
      title: thread.title,
      state: 'typing',
      turnId,
      messageCount: thread.messageIds.length,
    });
  } catch (err) {
    console.warn('[Yeaft] vp-status typing transition failed:', err?.message || err);
  }

  ensureDriverRunning(sessionId, vpId, thread.threadId);
  return thread.threadId;
}

function ensureDriverRunning(sessionId, vpId, threadId = 'main') {
  const key = threadKey(sessionId, vpId, threadId);
  if (vpDrivers.has(key)) return;
  const promise = (async () => {
    while (true) {
      const inbox = vpInboxes.get(key);
      if (!inbox || inbox.length === 0) break;
      const { envelope, turnId, thread: queuedThread } = inbox.shift();
      const thread = queuedThread || getOrCreateVpThread({ sessionId, vpId, threadId });
      const vpAbort = new AbortController();
      vpAborts.set(key, vpAbort);
      turnAbortCtrls.set(turnId, vpAbort);
      turnAbortMeta.set(turnId, { sessionId, vpId, threadId: thread.threadId, key });
      const baseSnapshot = pairSanitize(
        filterSnapshotForVp(
          getOrCreateSessionHistory(sessionId)
            .filter((m) => !m.threadId || m.threadId === 'main' || m.threadId === thread.threadId),
          vpId,
        ),
      );
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
            sessionId,
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
          sessionId,
          vpId,
          threadId: thread.threadId,
          thread,
          turnId,
          envelope,
          vpAbort,
          baseSnapshot,
        });
      } catch (err) {
        console.warn('[Yeaft] driveVp: runVpTurn failed', vpId, err?.message || err);
      } finally {
        turnAbortCtrls.delete(turnId);
        turnAbortMeta.delete(turnId);
        if (vpAborts.get(key) === vpAbort) vpAborts.delete(key);
        try {
          sendYeaftEvent({
            type: 'vp_typing_end',
            sessionId,
            vpId,
            threadId: thread.threadId,
            turnId,
            ts: Date.now(),
          }, { sessionId, vpId, threadId: thread.threadId, turnId });
        } catch { /* never crash WS pipeline */ }
      }
      try {
        if (text && envelope?.msg) {
          sendYeaftEvent({
            type: 'session_message',
            sessionId,
            vpId,
            threadId: thread.threadId,
            speakerVpId: vpId,
            text,
            mentions: Array.isArray(envelope?.msg?.mentions) ? envelope.msg.mentions : [],
            trigger,
            ts: Date.now(),
          }, { sessionId, vpId, threadId: thread.threadId, turnId });
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
            sessionId,
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
              sessionId,
              vpId,
              threadId: thread.threadId,
              title: thread.title || '',
              state: 'typing',
              turnId: followUpTurnId,
              messageCount: thread.messageIds.length,
            });
          } catch (err) {
            console.warn('[Yeaft] vp-status typing transition (rescue) failed:', err?.message || err);
          }
          try {
            sendYeaftEvent({
              type: 'vp_typing_start',
              sessionId,
              vpId,
              threadId: thread.threadId,
              turnId: followUpTurnId,
              ts: Date.now(),
            }, { sessionId, vpId, threadId: thread.threadId, turnId: followUpTurnId });
          } catch { /* never crash WS pipeline */ }
        }
      }
    }
    vpDrivers.delete(key);
    const tail = vpInboxes.get(key);
    if (tail && tail.length > 0) ensureDriverRunning(sessionId, vpId, threadId);
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
  sessionContexts.clear();
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
 * Send a yeaft_output message carrying claude_output-format data.
 * Envelope fields: conversationId, sessionId, vpId, turnId, threadId let the
 * frontend route incremental deltas to the correct per-VP/thread block.
 */
function resolveGroupDefaultVpId(sessionId) {
  if (!sessionId) return null;
  try {
    const meta = ensureGroupCoordinator(sessionId)?.group?.getMeta?.();
    const vpId = typeof meta?.defaultVpId === 'string' ? meta.defaultVpId.trim() : '';
    return vpId || null;
  } catch {
    return null;
  }
}

function sendYeaftOutput(data, { sessionId, chatId, vpId, turnId, threadId } = {}) {
  const resolvedVpId = vpId || (sessionId ? resolveGroupDefaultVpId(sessionId) : null);
  sendToServer({
    type: 'yeaft_output',
    conversationId: yeaftConversationId,
    ...(sessionId ? { sessionId } : {}),
    ...(chatId ? { chatId } : {}),
    ...(resolvedVpId ? { vpId: resolvedVpId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(threadId ? { threadId } : {}),
    data,
  });
}

/** Send a yeaft_output event (non-claude_output metadata). */
function sendYeaftEvent(event, { sessionId, chatId, vpId, turnId, threadId } = {}) {
  sendToServer({
    type: 'yeaft_output',
    conversationId: yeaftConversationId,
    ...(sessionId ? { sessionId } : {}),
    ...(chatId ? { chatId } : {}),
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

export function handleYeaftVpSubscribe(_msg) {
  if (_vpUnsubscribe) {
    try { _vpUnsubscribe(); } catch { /* ignore */ }
    _vpUnsubscribe = null;
  }
  const { libDir } = configuredVpPaths();
  _vpUnsubscribe = handleVpSubscribe(
    sendYeaftEvent,
    undefined,
    libDir ? { dir: libDir } : {},
  );
}

/**
 * VP CRUD from the web client. See historic doc for full message shapes.
 */
function sendVpCrudResult(payload) {
  sendYeaftEvent({ type: 'vp_crud_result', ...payload });
}

export function handleYeaftVpCreate(msg) {
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

export function handleYeaftVpUpdate(msg) {
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

export function handleYeaftVpDelete(msg) {
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
        if (row.vpId === vpId) broker.forget({ sessionId: row.sessionId, vpId });
      }
    } catch (err) {
      console.warn('[Yeaft] vp-status forget on delete failed:', err?.message || err);
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

export function handleYeaftVpRead(msg) {
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
 * Session CRUD wired to WS events.
 */
function sendSessionCrudResult(payload) {
  sendYeaftEvent({ type: 'session_crud_result', ...payload });
}

function sendSessionSnapshotBroadcast() {
  try {
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    if (!yeaftDir) return;
    const sessions = snapshotSessions(yeaftDir);
    sendYeaftEvent({ type: 'session_list_updated', sessions });
  } catch (err) {
    console.warn('[Yeaft] sendSessionSnapshotBroadcast failed:', err?.message || err);
  }
}

/**
 * Eager-broadcast this agent's session snapshot to the server (which
 * relays it to all owner clients with `agentId` stamped). Called on
 * `registered` so the unified sidebar can render this agent's sessions
 * the moment the agent connects — without waiting for the user to
 * first enter Yeaft view and trigger `ensureSessionLoaded`. Cheap:
 * pure FS scan of `~/.yeaft/sessions/`, no engine boot.
 *
 * fix-yeaft-session-per-agent: previously, Agent B's sessions were
 * invisible in the unified sidebar until the user clicked into B's
 * Yeaft view, because `sendSessionSnapshotBroadcast` only fired from
 * `ensureSessionLoaded`. That made the cross-agent list look broken
 * ("I see A but not B even though B is online") and was a major
 * contributor to the "session list disappears on switch" symptom.
 */
export { sendSessionSnapshotBroadcast as broadcastYeaftSessionSnapshotEager };

function sendSessionRosterChanged(session) {
  if (!session) return;
  const payload = {
    sessionId: session.id,
    name: session.name,
    roster: session.roster,
    defaultVpId: session.defaultVpId,
    workDir: session.workDir || '',
  };
  sendYeaftEvent({ type: 'session_roster_changed', ...payload });
}

function sessionErrorPayload(err) {
  let code = 'unknown';
  if (err instanceof SessionCrudError) code = err.code;
  else if (err instanceof SessionConfigError) code = err.code;
  return {
    code,
    sessionId: err && err.sessionId,
    message: err && err.message,
  };
}

export function handleYeaftListSessions(msg) {
  const requestId = msg && msg.requestId;
  try {
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    const groups = snapshotSessions(yeaftDir);
    sendSessionCrudResult({ op: 'list', requestId, ok: true, sessions: groups });
  } catch (err) {
    sendSessionCrudResult({ op: 'list', requestId, ok: false, error: sessionErrorPayload(err) });
  }
}

export function handleYeaftCreateSession(msg) {
  const requestId = msg && msg.requestId;
  const payload = (msg && msg.payload) || {};
  try {
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    const group = createSessionFromSpec(yeaftDir, payload);
    sendSessionCrudResult({ op: 'create', requestId, ok: true, session: group });
    sendSessionSnapshotBroadcast();
  } catch (err) {
    sendSessionCrudResult({ op: 'create', requestId, ok: false, error: sessionErrorPayload(err) });
  }
}

/**
 * `yeaft_scan_workdir_sessions` — read-only probe: list every yeaft
 * session physically present under `<workDir>/.yeaft/sessions/` along with
 * an `alreadyRegistered` flag (so the restore UI can disable sessions
 * already visible in the sidebar). Never mutates the registry; never
 * throws on missing/empty directories.
 *
 * Pairs with `handleYeaftRestoreSession` for the "Restore session from a
 * workdir" flow — see plan rosy-snuggling-waterfall.md.
 */
export function handleYeaftScanWorkdirSessions(msg) {
  const requestId = msg && msg.requestId;
  try {
    const workDir = String(msg && msg.workDir || '').trim();
    if (!workDir) throw new SessionCrudError('invalid_workdir', null, 'workDir required');
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    // scanWorkdirSessions is a layer-pure utility — it doesn't read the
    // central workdir registry. The handler is the right layer to fold in
    // `alreadyRegistered` because that flag couples the per-workdir scan
    // to a specific agent's registry (the same scan from a CLI tool or
    // a different agent would compare against a different registry).
    const sessions = scanWorkdirSessions(workDir);
    const registry = readWorkDirRegistry(yeaftDir);
    const decorated = sessions.map(s => ({
      ...s,
      alreadyRegistered: Object.prototype.hasOwnProperty.call(registry, s.id),
    }));
    sendSessionCrudResult({ op: 'scan_workdir', requestId, ok: true, sessions: decorated });
  } catch (err) {
    sendSessionCrudResult({ op: 'scan_workdir', requestId, ok: false, error: sessionErrorPayload(err) });
  }
}

/**
 * `yeaft_restore_session` — register `(sessionId, workDir)` in the
 * central workdir registry so the next `snapshotSessions()` includes
 * the session. Validates the session dir exists; rebroadcasts the
 * snapshot on success so connected sidebars refresh.
 *
 * Idempotent: re-restoring an already-registered session succeeds.
 */
export function handleYeaftRestoreSession(msg) {
  const requestId = msg && msg.requestId;
  const sessionId = msg && msg.sessionId;
  const workDir = String(msg && msg.workDir || '').trim();
  try {
    if (!sessionId) throw new SessionCrudError('invalid_session_id', null);
    if (!workDir) throw new SessionCrudError('invalid_workdir', sessionId);
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    const meta = restoreSessionToRegistry(yeaftDir, sessionId, workDir);
    sendSessionCrudResult({ op: 'restore', requestId, ok: true, session: meta });
    sendSessionSnapshotBroadcast();
  } catch (err) {
    sendSessionCrudResult({ op: 'restore', requestId, ok: false, error: sessionErrorPayload(err) });
  }
}

export function handleYeaftRenameSession(msg) {
  const requestId = msg && msg.requestId;
  // fix-yeaft-delete-and-agent-revert: accept legacy `groupId` in
  // addition to `sessionId`. The contract documented in
  // `web/stores/sessions.js` header ("Inbound payloads may carry
  // either sessionId (new) or groupId (legacy); both are accepted,
  // prefer sessionId") was only honored on web-side reads; the agent
  // handlers were silently rejecting the older wire shape that today's
  // SessionSettingsModal still sends. That's what made delete/rename/
  // archive/update_config/add_member/remove_member/set_default_vp
  // all throw `not_found` on undefined ids.
  const sessionId = (msg && (msg.sessionId || msg.groupId)) || null;
  const name = msg && msg.name;
  try {
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    const group = renameSession(yeaftDir, sessionId, name);
    invalidateGroupContext(sessionId);
    sendSessionCrudResult({ op: 'rename', requestId, ok: true, session: group });
    sendSessionSnapshotBroadcast();
  } catch (err) {
    sendSessionCrudResult({ op: 'rename', requestId, ok: false, error: sessionErrorPayload(err) });
  }
}

/**
 * `yeaft_update_group` — generalised group meta patch. Currently accepts
 * `name` and `announcement` keys. Empty patch is rejected; an empty/
 * whitespace-only `name` is also rejected up front rather than letting
 * `renameSession` raise a less-specific error deeper in the call stack.
 *
 * Partial-success contract: when a single patch contains BOTH `name` and
 * `announcement`, the rename is committed first; if the announcement
 * write throws, the rename has already persisted on disk and the client
 * receives `ok:false` for the announcement error — i.e. the WS op is not
 * atomic. Today's UI binds Save buttons per pane in `GroupSettingsModal`
 * so this is theoretical; readers extending the patch shape should know
 * the contract permits half-commits.
 */
export function handleYeaftUpdateSession(msg) {
  const requestId = msg && msg.requestId;
  // wire-compat: accept legacy `groupId` (see handleYeaftRenameSession).
  const sessionId = (msg && (msg.sessionId || msg.groupId)) || null;
  const patch = (msg && msg.patch && typeof msg.patch === 'object') ? msg.patch : null;
  try {
    const hasName = patch && typeof patch.name === 'string' && patch.name.trim().length > 0;
    const hasAnnouncement = patch && typeof patch.announcement === 'string';
    if (!patch || (!hasName && !hasAnnouncement)) {
      throw new SessionCrudError('invalid_patch', sessionId);
    }
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    let group = null;
    if (hasName) {
      group = renameSession(yeaftDir, sessionId, patch.name);
    }
    if (hasAnnouncement) {
      group = updateSessionAnnouncement(yeaftDir, sessionId, patch.announcement);
    }
    invalidateGroupContext(sessionId);
    sendSessionCrudResult({ op: 'update', requestId, ok: true, session: group });
    sendSessionSnapshotBroadcast();
  } catch (err) {
    sendSessionCrudResult({ op: 'update', requestId, ok: false, error: sessionErrorPayload(err) });
  }
}

/**
 * Persist the model selected in the group conversation header. Cache invalidation:
 * drop every cached Engine whose key starts with `${sessionId}::` so the
 * next turn picks up the new model. The group meta itself is untouched.
 *
 * Payload: { sessionId, requestId, config: { model?: string|null } }
 *  - `model: ''` or `null` clears the selected group model (falls back to user default).
 */
export function handleYeaftUpdateSessionConfig(msg) {
  const requestId = msg && msg.requestId;
  // wire-compat: accept legacy `groupId` (see handleYeaftRenameSession).
  const sessionId = (msg && (msg.sessionId || msg.groupId)) || null;
  const partial = (msg && msg.config && typeof msg.config === 'object') ? msg.config : null;
  try {
    if (!sessionId) throw new SessionConfigError('missing_group_id', 'sessionId required');
    if (!partial) throw new SessionConfigError('invalid_patch', 'config object required');
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    const savedConfig = updateSessionConfig(yeaftDir, sessionId, partial);
    // Drop cached engines so the next VP turn rebuilds with the new model.
    const prefix = `${sessionId}::`;
    for (const k of Array.from(vpEngines.keys())) {
      if (k.startsWith(prefix)) vpEngines.delete(k);
    }
    invalidateGroupContext(sessionId);
    sendSessionCrudResult({ op: 'update_config', requestId, ok: true, sessionId, config: savedConfig });
    sendSessionSnapshotBroadcast();
  } catch (err) {
    sendSessionCrudResult({ op: 'update_config', requestId, ok: false, error: sessionErrorPayload(err) });
  }
}

export function handleYeaftArchiveSession(msg) {
  const requestId = msg && msg.requestId;
  // wire-compat: accept legacy `groupId` (see handleYeaftRenameSession).
  const sessionId = (msg && (msg.sessionId || msg.groupId)) || null;
  try {
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    const result = archiveSession(yeaftDir, sessionId);
    invalidateGroupContext(sessionId);
    sendSessionCrudResult({
      op: 'archive',
      requestId,
      ok: true,
      sessionId: result.sessionId,
      alreadyGone: !!result.alreadyGone,
    });
    sendSessionSnapshotBroadcast();
  } catch (err) {
    sendSessionCrudResult({ op: 'archive', requestId, ok: false, error: sessionErrorPayload(err) });
  }
}

export function handleYeaftDeleteSession(msg) {
  const requestId = msg && msg.requestId;
  // wire-compat: accept legacy `groupId` (see handleYeaftRenameSession).
  const sessionId = (msg && (msg.sessionId || msg.groupId)) || null;
  try {
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    const result = deleteSession(yeaftDir, sessionId);
    // Cascade: remove every persisted message stamped with this group id.
    // Hard delete (per user spec): no soft-archive, the bytes are gone.
    // Skipped silently if the session/store isn't initialized — the next
    // CLI `--compact-orphans` run will sweep them as orphans.
    let messagesRemoved = 0;
    try {
      if (session && session.conversationStore) {
        messagesRemoved = session.conversationStore.deleteByGroup(sessionId);
      }
    } catch (cascadeErr) {
      console.warn(`[Yeaft] cascade delete for group ${sessionId} failed: ${cascadeErr.message}`);
    }
    // Drop the cached coord/router and abort/clear any in-flight VP
    // turns for the deleted group. Engines for the deleted group are
    // also dropped — unlike rename/announcement updates, the group is
    // gone for good and there's nothing to preserve.
    invalidateGroupContext(sessionId);
    const prefix = `${sessionId}::`;
    for (const k of Array.from(vpEngines.keys())) {
      if (k.startsWith(prefix)) vpEngines.delete(k);
    }
    sendSessionCrudResult({
      op: 'delete',
      requestId,
      ok: true,
      sessionId: result.sessionId,
      messagesRemoved,
      alreadyGone: !!result.alreadyGone,
    });
    sendSessionSnapshotBroadcast();
  } catch (err) {
    sendSessionCrudResult({ op: 'delete', requestId, ok: false, error: sessionErrorPayload(err) });
  }
}

export function handleYeaftSessionAddMember(msg) {
  const requestId = msg && msg.requestId;
  // wire-compat: accept legacy `groupId` (see handleYeaftRenameSession).
  const sessionId = (msg && (msg.sessionId || msg.groupId)) || null;
  const vpId = msg && msg.vpId;
  try {
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    const group = addMember(yeaftDir, sessionId, vpId);
    invalidateGroupContext(sessionId);
    sendSessionCrudResult({ op: 'add_member', requestId, ok: true, session: group });
    sendSessionRosterChanged(group);
  } catch (err) {
    sendSessionCrudResult({ op: 'add_member', requestId, ok: false, error: sessionErrorPayload(err) });
  }
}

export function handleYeaftSessionRemoveMember(msg) {
  const requestId = msg && msg.requestId;
  // wire-compat: accept legacy `groupId` (see handleYeaftRenameSession).
  const sessionId = (msg && (msg.sessionId || msg.groupId)) || null;
  const vpId = msg && msg.vpId;
  try {
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    const group = removeMember(yeaftDir, sessionId, vpId);
    invalidateGroupContext(sessionId);
    // Also drop the kicked VP's thread engines — the next time they're
    // added back they should start with fresh per-thread state.
    const removedPrefix = `${sessionId}::${vpId}::`;
    for (const key of Array.from(vpEngines.keys())) {
      if (key.startsWith(removedPrefix)) vpEngines.delete(key);
    }
    sendSessionCrudResult({ op: 'remove_member', requestId, ok: true, session: group });
    sendSessionRosterChanged(group);
  } catch (err) {
    sendSessionCrudResult({ op: 'remove_member', requestId, ok: false, error: sessionErrorPayload(err) });
  }
}

export function handleYeaftSessionSetDefaultVp(msg) {
  const requestId = msg && msg.requestId;
  // wire-compat: accept legacy `groupId` (see handleYeaftRenameSession).
  const sessionId = (msg && (msg.sessionId || msg.groupId)) || null;
  const vpId = msg && msg.vpId;
  try {
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    const group = setSessionDefaultVp(yeaftDir, sessionId, vpId);
    invalidateGroupContext(sessionId);
    sendSessionCrudResult({ op: 'set_default_vp', requestId, ok: true, session: group });
    sendSessionRosterChanged(group);
  } catch (err) {
    sendSessionCrudResult({ op: 'set_default_vp', requestId, ok: false, error: sessionErrorPayload(err) });
  }
}


/**
 * Build the vpPersona payload threaded into engine.query so the worker
 * system prompt carries the VP's identity/role/persona/planInstruction.
 * Returns null on miss — callers treat that as "use generic prompt".
 * Used by the group fan-out path (buildVpQueryOpts).
 */
function buildVpPersona(vpId) {
  if (!vpId) return null;
  try {
    const vp = readVp(vpId);
    if (!vp) return null;
    return {
      vpId,
      displayName: vp.displayName || vpId,
      displayNameZh: vp.displayNameZh || '',
      role: vp.role || '',
      roleZh: vp.roleZh || '',
      persona: vp.persona || '',
      planInstruction: typeof vp.planInstruction === 'string' ? vp.planInstruction : '',
    };
  } catch {
    return null;
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
export function installYeaftRuntimeBridge(s) {
  if (!s) return;

  // Forward dream pipeline progress events to the web debug panel.
  //
  // Group-id stamping is NO LONGER done here. It used to be: this sink
  // read a module-level `activeScopedDreamGroupId` that
  // `handleYeaftDreamTrigger({sessionId})` parked before awaiting the
  // scope-filtered pass. That created a race when two scoped triggers
  // overlapped (auto-tick during a manual click; or two manual clicks
  // for different groups): the second handler's `finally` could clear
  // the module slot while the first run was still emitting events,
  // dropping the stamp from the tail of the first pass. The new design:
  // `handleYeaftDreamTrigger` wraps THIS sink for the lifetime of the
  // trigger to inject `sessionId` per-call (see that function below). The
  // base sink is intentionally a pure passthrough.
  //
  // Bug 2: also forward turn_open / turn_close / loop events emitted by
  // the dream pipeline so the debug panel shows dream LLM API calls.
  s._dreamProgressSink = (evt) => {
    try {
      if (evt.type === 'turn_open' || evt.type === 'turn_close' || evt.type === 'loop') {
        const tag = evt && evt.sessionId ? { sessionId: evt.sessionId } : {};
        sendYeaftEvent(evt, tag);
      } else {
        const out = { type: 'dream_progress', ...evt };
        const tag = evt && evt.sessionId ? { sessionId: evt.sessionId } : {};
        sendYeaftEvent(out, tag);
      }
    } catch { /* never let event delivery throw */ }
  };

  // Wire the post-compact WS sink. Compactor is constructed in
  // session.js with a no-op sink; bridge owns `sendYeaftEvent` /
  // `yeaftConversationId`, so the sink is wired here once a session is
  // present. Per-group `yeaft_history_compacted` events fire after a
  // successful summarize+swap.
  if (s.compactor && typeof s.compactor.setOnCompacted === 'function') {
    s.compactor.setOnCompacted((sessionId, result) => {
      try {
        sendYeaftEvent({
          type: 'yeaft_history_compacted',
          reason: result?.reason ?? null,
          beforeTurns: result?.beforeTurns,
          afterTurns: result?.afterTurns,
          beforeTokens: result?.beforeTokens,
          afterTokens: result?.afterTokens,
          archivedCount: result?.archivedCount,
          ts: Date.now(),
        }, { sessionId });
      } catch { /* WS pipeline failure must not crash compact */ }
    });
  }

  ctx.yeaftRuntimeSettings = {
    // No multi-thread settings to surface anymore. Stub for back-compat
    // with message-router's update_yeaft_settings branch — assignments are
    // accepted but ignored.
    get maxConcurrentThreads() { return null; },
    set maxConcurrentThreads(_v) { /* deprecated, ignored */ },
    get autoArchiveIdleDays() { return 0; },
    set autoArchiveIdleDays(_v) { /* deprecated, ignored */ },
  };
}

/**
 * Mid-turn vp-status transitions (text_delta / tool_call / tool_end).
 * Tolerates `hctx` missing sessionId/vpId — pre-707 1:1 chat paths don't
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
      sessionId: hctx.sessionId || null,
      vpId: hctx.vpId,
      state,
      turnId: hctx.turnId || null,
      threadId: hctx.threadId || 'main',
      title: hctx.thread?.title || '',
      messageCount: hctx.thread?.messageIds?.length || 0,
    });
  } catch (err) {
    console.warn(`[Yeaft] vp-status ${state} transition failed:`, err?.message || err);
  }
}

/**
 * Handle a single engine event unwrapped from an `engine_event` envelope.
 * Stamps threadId on every outgoing frame so frontend grouping, tools,
 * todos, debug cards, and persistence all share the same boundary.
 *
 * @param {object} event — engine event (text_delta / tool_call / …)
 * @param {{assistantTextParts:string[], toolCallsAccum:Array, toolResultsAccum:Array, thinkingBlocksAccum?:Array, resetQueryTimer:Function, sessionId?:string, vpId?:string, turnId?:string}} hctx
 */
export function __testHandleEngineEvent(event, hctx) {
  return handleEngineEvent(event, hctx);
}

function handleEngineEvent(event, hctx) {
  hctx.resetQueryTimer();
  const envelope = {
    sessionId: hctx.sessionId,
    vpId: hctx.vpId,
    turnId: hctx.turnId,
    threadId: hctx.threadId || event.threadId,
  };

  switch (event.type) {
    case 'text_delta':
      hctx.assistantTextParts.push(event.text);
      sendYeaftOutput({
        type: 'assistant',
        message: { content: [{ type: 'text', text: event.text }] },
      }, envelope);
      // vp-status: first text-delta of a (thinking|tool) phase flips
      // the row to 'streaming'. transition() is a no-op when already
      // streaming, so subsequent deltas are cheap.
      maybeTransitionVpStatus(hctx, 'streaming');
      break;

    case 'thinking_delta':
      sendYeaftEvent({ type: 'thinking_delta', text: event.text }, envelope);
      break;

    case 'thinking_block_end':
      // task-327d: capture the assembled thinking block (with server-
      // signed signature) so the group history we hand to subsequent
      // turns / VPs includes it. Without this echo Anthropic 400s the
      // next request with "content[].thinking in the thinking mode must
      // be passed back to the API". The signature stays server-side
      // only — wire serializers (stripMetaForWire / sendYeaftOutput)
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
      sendYeaftOutput({
        type: 'assistant',
        message: { content: [] },
      }, envelope);
      sendYeaftOutput({
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
      sendYeaftEvent({
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
      sendYeaftOutput({
        type: 'user',
        tool_use_result: [{
          type: 'tool_result',
          tool_use_id: event.id,
          content: event.output || '',
          is_error: event.isError || false,
        }],
      }, envelope);
      // Tool finished. Do NOT speculatively flip to 'thinking' — the
      // engine may emit more text-deltas (→ 'streaming') OR go straight
      // to end_turn (→ 'idle' via runVpTurn's finally). The old
      // speculative transition caused a visible 'tool → thinking →
      // streaming' flicker on every tool call. Hold the 'tool' state
      // until the next real event arrives.
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
            sessionId: hctx.sessionId || null,
            vpId: hctx.vpId,
            threadId: hctx.threadId || 'main',
            title: hctx.thread?.title || '',
            messageCount: hctx.thread?.messageIds?.length || 0,
          });
        } catch (err) {
          console.warn('[Yeaft] vp-status settleIdle (route_forward) failed:', err?.message || err);
        }
        sendYeaftEvent({
          type: 'vp_turn_end',
          sessionId: hctx.sessionId,
          vpId: hctx.vpId,
          threadId: hctx.threadId || event.threadId || 'main',
          turnId: hctx.turnId,
          stopReason: event.stopReason,
          reason: 'route_forward',
          detail: event.detail || null,
          ts: Date.now(),
        }, envelope);
        if (typeof hctx.markTurnEnd === 'function') hctx.markTurnEnd('route_forward');
      }
      break;

    case 'usage':
      sendYeaftEvent({
        type: 'context_usage',
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
      }, envelope);
      break;

    case 'recall':
      sendYeaftEvent({
        type: 'recall',
        entryCount: event.entryCount,
        cached: event.cached,
      }, envelope);
      break;

    case 'consolidate':
      // Engine compressed the context — clear THIS group's accumulated
      // history. Other groups' histories stay intact.
      if (hctx.sessionId) setGroupHistory(hctx.sessionId, []);
      sendYeaftEvent({
        type: 'consolidate',
        archivedCount: event.archivedCount,
        extractedCount: event.extractedCount,
      }, envelope);
      break;

    case 'fallback':
      sendYeaftEvent({
        type: 'fallback',
        from: event.from,
        to: event.to,
        reason: event.reason,
      }, envelope);
      break;

    case 'reflection':
      sendYeaftEvent({
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
      sendYeaftEvent({
        type: 'turn_open',
        turnId: event.turnId,
        userPrompt: event.userPrompt,
        vpId: event.vpId,
        sessionId: event.sessionId,
        at: event.at,
      }, envelope);
      break;

    case 'turn_close':
      sendYeaftEvent({
        type: 'turn_close',
        turnId: event.turnId,
        totalMs: event.totalMs,
        totalTokens: event.totalTokens,
        loopCount: event.loopCount,
      }, envelope);
      break;

    case 'memory_used':
      sendYeaftEvent({
        type: 'memory_used',
        turnId: event.turnId,
        loaded: event.loaded || [],
      }, envelope);
      break;

    case 'memory_adjust':
      sendYeaftEvent({
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
      sendYeaftEvent({
        type: 'vp_thread_user_append_consumed',
        turnId: event.turnId,
        threadId: event.threadId,
        loopNumber: event.loopNumber,
        preview: event.preview,
        ts: Date.now(),
      }, envelope);
      break;

    case 'tool_exec':
      sendYeaftEvent({
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
      sendYeaftEvent({
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
          sendYeaftOutput({
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
        sendYeaftOutput({
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
 * Handle a yeaft_session_chat message from the web UI — the SOLE Yeaft
 * conversation entry point.
 *
 * Contract (post-consolidation, was previously split between handleYeaftChat
 * and handleYeaftSessionSend):
 *   - Frontend ALWAYS sends `yeaft_session_chat`. There is no `yeaft_chat`.
 *   - `sessionId` defaults to `'grp_default'` if missing — Yeaft is a single
 *     conversation backed by the default session; the user is never "outside"
 *     a session.
 *   - Sessions are created up-front via `handleYeaftCreateSession`; this
 *     handler does NOT seed missing sessions on the fly. An unknown
 *     sessionId surfaces a clear "session not found" error to the UI.
 *   - Coordinator is MANDATORY (this is what guarantees ctx.router is wired
 *     so the `route_forward` tool can never trip `router_unavailable`).
 *   - No legacy "no-session" fallback paths — they were the source of the
 *     router_unavailable bug fixed in v0.1.671.
 */
export async function handleYeaftSessionSend(msg) {
  if (!msg || typeof msg !== 'object') return;
  const { text } = msg;
  // PR #721: image-only send is allowed — text may be empty when the
  // user attached files only. The frontend synthesizes a placeholder
  // string in `sendYeaftGroupChat`, so by the time we get here `text`
  // should always be non-empty; but defend anyway in case an API
  // caller sends a bare attachment payload.
  const hasFiles = Array.isArray(msg.files) && msg.files.length > 0;
  if (!text?.trim() && !hasFiles) return;
  const mentions = Array.isArray(msg.mentions) ? msg.mentions : [];
  const sessionId = (typeof msg.sessionId === 'string' && msg.sessionId.trim())
    ? msg.sessionId.trim()
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
    await session.compactor.awaitInFlight(sessionId);
  }

  // yeaftDir is a hard prerequisite for both session boot and group seeding;
  // validate BEFORE booting so a misconfigured agent doesn't leave a zombie
  // session lying around.
  const yeaftDir = ctx.CONFIG?.yeaftDir;
  if (!yeaftDir) {
    sendYeaftOutput({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '⚠️ Yeaft session error: no yeaft directory configured.' }] },
    }, { sessionId });
    sendYeaftOutput({ type: 'result', result_text: '' }, { sessionId });
    return;
  }

  await ensureSessionLoaded();

  // Open the session. The default `grp_default` no longer self-seeds
  // here — session creation happens up-front via `handleYeaftCreateSession`,
  // so a missing dir surfaces a clear error rather than masking it.
  let sessionHandle = null;
  let sessionRoot = null;
  try {
    const groupYeaftDir = resolveSessionYeaftDir(yeaftDir, sessionId);
    sessionRoot = sessionsRoot(groupYeaftDir);
    const dir = join(sessionRoot, sessionId);
    if (existsSync(dir) && loadSessionMeta(dir)) {
      sessionHandle = openSession(sessionRoot, sessionId);
    } else {
      // fix-yeaft-session-server-persistence: the `grp_default` on-the-
      // fly seed used to manufacture a missing session here. That
      // hid the "session not found" error and re-created the phantom
      // default-group row across agents. Now we surface the not-found
      // case so the web can show an "agent offline / session missing"
      // hint instead of silently creating a different session.
      console.warn('[Yeaft] yeaft_session_chat: sessionId %s not found', sessionId);
    }
  } catch (err) {
    console.warn('[Yeaft] yeaft_session_chat: session open failed', err?.message || err);
  }

  if (!sessionHandle) {
    sendYeaftOutput({
      type: 'assistant',
      message: { content: [{ type: 'text', text: `⚠️ Session ${sessionId} not found.` }] },
    }, { sessionId });
    sendYeaftOutput({ type: 'result', result_text: '' }, { sessionId });
    return;
  }

  // Auto-add @-mentioned VPs from the library, heal missing defaultVpId.
  let rosterMutated = false;
  try {
    const meta = sessionHandle.getMeta();
    const wantsAdd = mentions.filter(
      (m) => m && m !== 'all' && !meta.roster.includes(m)
    );
    if (wantsAdd.length) {
      for (const vpId of wantsAdd) {
        try {
          const vp = readVp(vpId);
          if (!vp) continue;
          addMember(yeaftDir, sessionId, vpId);
          rosterMutated = true;
        } catch { /* skip strangers */ }
      }
      if (rosterMutated) {
        try { sessionHandle.close && sessionHandle.close(); } catch { /* best-effort */ }
        sessionHandle = openSession(sessionRoot, sessionId);
        sendSessionRosterChanged(sessionHandle.getMeta());
      }
    }
    const meta2 = sessionHandle.getMeta();
    if (!meta2.defaultVpId && meta2.roster.length) {
      try {
        setSessionDefaultVp(yeaftDir, sessionId, meta2.roster[0]);
        try { sessionHandle.close && sessionHandle.close(); } catch { /* best-effort */ }
        sessionHandle = openSession(sessionRoot, sessionId);
        sendSessionRosterChanged(sessionHandle.getMeta());
        rosterMutated = true;
      } catch { /* best-effort */ }
    }
  } catch (err) {
    console.warn('[Yeaft] yeaft_session_chat: auto-roster heal failed', err?.message || err);
  }

  // task-707: per-group persistent coordinator/router. Created once per
  // sessionId; reused across user messages AND across in-flight tool calls
  // (route_forward delivers via this same coord). If the roster mutated
  // we replace the cached coord so it points at the freshly-opened
  // sessionHandle.
  if (rosterMutated) {
    sessionContexts.delete(sessionId);
  }
  const sessionCtx = getOrCreateSessionContext(sessionId, sessionHandle);
  const coord = sessionCtx.coord;

  // Multi-thread routing owns active-VP decisions. Do not abort an active
  // VP before classification: a new query may append to the running thread
  // or spawn an unrelated concurrent thread.

  // ── Attachments (images + files) ───────────────────────────────
  // Server has already resolved fileId → { name, mimeType, data:base64,
  // isImage } via the same path crew uses (client-conversation.js relay
  // for `yeaft_*`). We persist files to disk under the agent's CWD so
  // file-tools (file-read / bash) can pick them up with relative paths,
  // and we build per-image content blocks for the LLM call. The
  // resolved metadata WITHOUT base64 rides on coord.ingest meta so it
  // shows up in the persisted group log and on the envelope every VP
  // driver receives.
  const inboundFiles = Array.isArray(msg.files) ? msg.files : [];
  let attachmentBundle = { promptAttachments: [], promptSuffix: '', promptParts: [], failed: [] };
  if (inboundFiles.length > 0) {
    try {
      attachmentBundle = persistYeaftAttachments(inboundFiles, { subdir: sessionId });
    } catch (err) {
      console.warn('[Yeaft] yeaft_session_chat: attachment persist failed', err?.message || err);
    }
  }
  // Surface partial / total upload failures to the user. We don't abort
  // the turn — the LLM can still answer the text-only portion — but the
  // user must know which files didn't make it.
  if (Array.isArray(attachmentBundle.failed) && attachmentBundle.failed.length > 0) {
    const detail = attachmentBundle.failed
      .map((f) => `  - ${f.name}: ${f.error}`)
      .join('\n');
    sendYeaftOutput({
      type: 'assistant',
      message: { content: [{ type: 'text', text: `⚠️ ${attachmentBundle.failed.length} file(s) could not be attached:\n${detail}` }] },
    }, { sessionId });
  }
  const persistedAttachments = attachmentsForPersistence(attachmentBundle.promptAttachments);

  // Ingest user text. The coordinator persists, applies mention/fanout
  // rules, and calls deliver() (== enqueueForVp) for each chosen VP —
  // which both (a) emits vp_typing_start and (b) ensures a driver runs.
  let report;
  try {
    report = coord.ingest({
      id: typeof msg.id === 'string' && msg.id ? msg.id : undefined,
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
    console.warn('[Yeaft] yeaft_session_chat: coord.ingest failed', err?.message || err);
    sendYeaftOutput({
      type: 'assistant',
      message: { content: [{ type: 'text', text: `⚠️ Session dispatch error: ${err?.message || err}` }] },
    }, { sessionId });
    sendYeaftOutput({ type: 'result', result_text: '' }, { sessionId });
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
    sendYeaftOutput({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '⚠️ No VP available to respond — check the group roster.' }] },
    }, { sessionId });
    sendYeaftOutput({ type: 'result', result_text: '' }, { sessionId });
    return;
  }

  // Wait only for routing/classification promises spawned by this message.
  // Do not wait for every driver in the group: unrelated older threads may keep
  // running for minutes and must not hold this request lifecycle hostage.
  await waitForRoutePromises(report?.message?.id);

  // Post-turn compaction. Fire-and-forget — does NOT block the response
  // path. The Compactor's own precheck (`shouldCompactHistory`) decides
  // whether to engage the LLM, using the trigger ratio wired in
  // `session.js` (default 70% of model context, knob:
  // `config.compactTriggerRatio`). The single-flight + anti-starvation
  // logic inside Compactor handles concurrent turns; the entry-gate
  // `awaitInFlight` at the top of `handleYeaftSessionSend` (~:2291)
  // ensures a follow-up turn never reads a half-mutated history.
  //
  // Why a per-call historyHandle: Compactor must NEVER close over a
  // frozen snapshot — the array reference can be swapped by
  // `consolidate`, session reset, or `route_forward` bursts. The handle
  // re-resolves on each `get` via the same sessionId-keyed helpers used
  // everywhere else in the bridge.
  //
  // Naming asymmetry note: `getOrCreateSessionHistory` and
  // `setGroupHistory` are intentionally NOT renamed to match. Both are
  // session-keyed today (the `set` helper's name is a historical alias
  // from the pre-VP-thread era), but per CLAUDE.md's "不要为了改名而批量
  // 重命名" guardrail we leave the wire-compat names alone and rely on
  // co-location to make the symmetry obvious. The source-pinning test
  // `web-bridge-post-turn-compact-wiring.test.js` matches both names.
  if (session?.compactor && sessionId) {
    session.compactor.scheduleAfterTurn(sessionId, {
      get: () => getOrCreateSessionHistory(sessionId),
      set: (next) => setGroupHistory(sessionId, next),
    });
  }
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
 * @param {object} args.sessionCoordinator — the persistent coordinator for the
 *   group; used here for `group.getMeta()` (defaultVpId, announcement) and
 *   to bind the per-group router into toolCtx.
 * @param {string} [args.sessionId]
 * @param {object} [args.envelope] — the inbound coordinator envelope that
 *   triggered this turn. Threaded into toolCtx as `inboundEnvelope` so
 *   `route_forward` can extend `causedBy` chains correctly. Optional only
 *   for pre-707 callers that no longer exist in production.
 */
export function buildVpQueryOpts({ vpId, sessionCoordinator, sessionId, envelope, threadId = 'main' }) {
  // Read the group meta once and reuse for both defaultVpId fallback and
  // announcement injection. Each .getMeta() reload reads + parses the
  // group.json file, so calling it twice per turn is wasteful — and
  // (more importantly) opens a window where a concurrent group edit
  // could land between the two reads, giving the engine a defaultVpId
  // from one snapshot and an announcement from a newer one.
  let sessionMeta = null;
  try {
    sessionMeta = sessionCoordinator && sessionCoordinator.group
      && typeof sessionCoordinator.group.getMeta === 'function'
      ? sessionCoordinator.group.getMeta() : null;
  } catch { /* coordinator inspection is best-effort */ }

  let resolvedVpId = vpId;
  if (!resolvedVpId) {
    if (sessionMeta && typeof sessionMeta.defaultVpId === 'string' && sessionMeta.defaultVpId) {
      resolvedVpId = sessionMeta.defaultVpId;
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
  if (typeof sessionId === 'string' && sessionId.trim()) {
    out.sessionId = sessionId.trim();
  }
  // task-334-group-editor: surface the group announcement to the engine so
  // buildWorkerPrompt can inject it as a CLAUDE.md-style shared prefix.
  // Empty/missing reads as '' and prompts.js skips the section.
  if (sessionMeta && typeof sessionMeta.announcement === 'string') {
    out.sessionAnnouncement = sessionMeta.announcement;
  }
  // Surface the group's configured working directory so the engine can
  // resolve CLAUDE.md / AGENTS.md at that path and inject it as a
  // [Project Doc] block above the announcement. Groups with no workDir
  // skip the block silently (matches the announcement contract).
  if (sessionMeta && typeof sessionMeta.workDir === 'string' && sessionMeta.workDir.trim()) {
    out.workDir = sessionMeta.workDir.trim();
  }
  const persona = buildVpPersona(resolvedVpId);
  if (persona) out.vpPersona = persona;
  if (sessionCoordinator && typeof sessionCoordinator.ingest === 'function') {
    try {
      out.router = createRouter({ coordinator: sessionCoordinator });
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
  // keyed by `${sessionId}::${vpId}::${threadId}` so concurrent threads for
  // the same VP cannot overwrite each other's lists, and the TodoWrite tool
  // can stay ignorant of routing details (it just calls ctx.setCurrentTodos).
  const todosKey = threadKey(out.sessionId || '', resolvedVpId, out.threadId || 'main');
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

  installYeaftRuntimeBridge(session);

  try {
    if (session.engine && typeof session.engine.setSubAgentEventSink === 'function') {
      session.engine.setSubAgentEventSink((agentId, evt) => {
        try {
          sendYeaftEvent({ type: 'sub_agent_event', agentId, payload: evt });
        } catch { /* ignore */ }
      });
    }
  } catch (err) {
    console.warn('[Yeaft] setSubAgentEventSink wiring failed:', err?.message || err);
  }

  // Bug 8: clean up legacy `.archived-*` group dirs at boot.
  try {
    if (yeaftDir) {
      const removed = purgeArchivedSessions(yeaftDir);
      if (removed && removed.length > 0) {
        console.log(`[Yeaft] purged ${removed.length} legacy .archived group dir(s)`);
      }
    }
  } catch (err) {
    console.warn('[Yeaft] purgeArchivedSessions failed:', err?.message || err);
  }

  yeaftConversationId = `yeaft-${Date.now()}`;

  // Per-group history is hydrated lazily on first `getOrCreateSessionHistory`
  // — there's no global "all conversations" tape any more.

  sendYeaftEvent({
    type: 'session_ready',
    conversationId: yeaftConversationId,
    model: session.config.model,
    availableModels: session.config.availableModels || [],
    skills: session.status.skills,
    mcpServers: session.status.mcpServers,
    tools: session.status.tools,
    yeaftDir: ctx.CONFIG?.yeaftDir || null,
  });
  sendSessionSnapshotBroadcast();
  // vp-status: rebuild frontend status table from authoritative agent
  // memory. Sent unconditionally so reconnect/refresh paths get the same
  // bootstrap as first-load (the broker dedup logic makes a redundant
  // snapshot harmless).
  try {
    getVpStatusBroker().broadcastSnapshot();
  } catch (err) {
    console.warn('[Yeaft] vp-status snapshot broadcast failed:', err?.message || err);
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
  const { sessionId, vpId, turnId, threadId, thread } = args;
  const deadlineMs = QUERY_TIMEOUT_MS + ESCALATE_AFTER_ABORT_MS;
  await raceWithEscalation(runVpTurn(args), {
    deadlineMs,
    onEscalate: () => {
      console.error(
        `[Yeaft] runVpTurn watchdog escalation: VP ${vpId} did not return ${deadlineMs}ms after enqueue — emitting synthetic stop and unblocking driver`,
      );
      try {
        sendYeaftOutput(
          { type: 'result', result_text: '', stopped: true },
          { sessionId, vpId, turnId, threadId },
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
        getVpStatusBroker().settleIdle({ sessionId, vpId, threadId: threadId || 'main', title: thread?.title || '' });
      } catch (err) {
        console.warn('[Yeaft] vp-status settleIdle (escalation) failed:', err?.message || err);
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
 * itself; the persistent coord lives in `sessionContexts[sessionId]`. Uses
 * `getOrCreateVpEngine(sessionId, vpId)` so each VP runs against its own
 * Engine instance — private state (`#currentAbortCtrl`, `#__queryCounter`,
 * `#pendingT2`, `#abortReason`, `#adjustRanByGroup`, `#execLog`) does not
 * collide when VP-A and VP-B run concurrent turns.
 *
 * @param {{ prompt: string, sessionId: string, vpId: string, turnId: string, envelope: object, vpAbort: AbortController, baseSnapshot: Array }} args
 */
async function runVpTurn({ prompt, promptParts = null, sessionId, vpId, threadId = 'main', thread = null, turnId, envelope: inboundEnvelope, vpAbort, baseSnapshot }) {
  if (!prompt?.trim()) return;

  const envelope = { sessionId, vpId, threadId, turnId };

  // Per-message turn lifecycle: track start ts + which terminal reason
  // we'll emit. `emitVpTurnEnd` is idempotent (route_forward emits inside
  // the engine loop; normal end_turn / abort / error emit at runVpTurn
  // boundaries — without idempotency a route_forward turn would emit
  // twice). `markTurnEnd` lets the engine-event handler tell us that
  // it already emitted, so we don't emit a duplicate at the runVpTurn
  // normal-completion path.
  const turnStartAt = Date.now();
  let turnEndReason = 'end_turn';
  let turnEndEmitted = false;
  let turnEndDetail = null;
  const markTurnEnd = (reason) => { turnEndEmitted = true; turnEndReason = reason; };
  const emitVpTurnEnd = (reason, detail = null) => {
    if (turnEndEmitted) return;
    turnEndEmitted = true;
    try {
      sendYeaftEvent({
        type: 'vp_turn_end',
        sessionId,
        vpId,
        threadId: threadId || 'main',
        turnId,
        reason,
        durationMs: Date.now() - turnStartAt,
        detail: detail || null,
        ts: Date.now(),
      }, envelope);
    } catch (err) {
      console.warn('[Yeaft] vp_turn_end emit failed:', err?.message || err);
    }
  };

  try {
    if (session?.dreamScheduler) {
      session.dreamScheduler.noteUserMessage();
    }

    let queryTimer = null;
    const resetQueryTimer = () => {
      if (queryTimer) clearTimeout(queryTimer);
      queryTimer = setTimeout(() => {
        if (!vpAbort.signal.aborted) {
          console.error(`[Yeaft] query timeout after ${QUERY_TIMEOUT_MS / 1000}s of silence — aborting VP ${vpId}`);
          try { vpAbort.abort(); } catch { /* best-effort */ }
        }
      }, QUERY_TIMEOUT_MS);
    };
    resetQueryTimer();

    // Emit turn_start so frontend can create the message block.
    sendYeaftEvent({ type: 'vp_turn_start', vpId, threadId, turnId, sessionId, title: thread?.title || '' }, envelope);
    // vp-status: LLM call about to start, no text/tool yet → 'thinking'.
    try {
      getVpStatusBroker().transition({ sessionId, vpId, threadId, title: thread?.title || '', state: 'thinking', turnId, messageCount: thread?.messageIds?.length || 0 });
    } catch (err) {
      console.warn('[Yeaft] vp-status thinking transition failed:', err?.message || err);
    }

    try {
      const assistantTextParts = [];
      const toolCallsAccum = [];
      const toolResultsAccum = [];
      const thinkingBlocksAccum = []; // task-327d: round-trip to next turn
      const appendedUserPrompts = [];
      let vpEngine = null;

      // task-707: per-VP engine + persistent group coord. The coord is
      // created in handleYeaftSessionSend via getOrCreateSessionContext and
      // cached on `sessionContexts`; we pull it here so route_forward
      // (router built from this same coord) lands envelopes back on the
      // right inbox set.
      const sessionCtx = sessionContexts.get(sessionId);
      const sessionCoordinator = sessionCtx?.coord || null;
      const queryOpts = buildVpQueryOpts({
        vpId,
        sessionCoordinator,
        sessionId,
        envelope: inboundEnvelope,
        threadId,
      });

      vpEngine = getOrCreateVpEngine(sessionId, vpId, threadId);
      if (thread) thread.engine = vpEngine;

      const handlerCtx = {
        assistantTextParts,
        toolCallsAccum,
        toolResultsAccum,
        thinkingBlocksAccum,
        resetQueryTimer,
        sessionId,
        vpId,
        turnId,
        threadId,
        thread,
        appendedUserPrompts,
        markTurnEnd,
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
        // ONCE by handleYeaftSessionSend → persistUserMessageOnce before
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
      appendTurnToSessionHistory(sessionId, threadId, vpId, [prompt, ...appendedUserPrompts], assistantTextParts, toolCallsAccum, toolResultsAccum, thinkingBlocksAccum);

      sendYeaftOutput({
        type: 'assistant',
        message: { content: [] },
      }, envelope);
      sendYeaftOutput({
        type: 'result',
        result_text: '',
      }, envelope);
      // Normal end-of-turn (no route_forward, no abort, no error). Emit
      // the message-status terminal so the web client can flip the
      // assistant message status from 'pending' → 'completed'.
      emitVpTurnEnd('end_turn');
    } finally {
      if (queryTimer) clearTimeout(queryTimer);
    }
  } catch (err) {
    const isAbort = err && (err.name === 'AbortError' || err.name === 'LLMAbortError');
    if (isAbort) {
      sendYeaftOutput({
        type: 'result',
        result_text: '',
        stopped: true,
      }, envelope);
      emitVpTurnEnd('aborted');
      return;
    }

    console.error('[Yeaft] query error:', err);
    turnEndReason = 'errored';
    turnEndDetail = { message: err?.message || String(err) };

    // vp-status: surface a transient `error` state so the row's status
    // label flips red for the brief window before the outer finally
    // settles it to idle. Without this, an LLM/tool failure would look
    // identical to a normal turn end in the timeline — the user has
    // no way to tell from the row that something went wrong.
    try {
      getVpStatusBroker().transition({ sessionId, vpId, threadId, title: thread?.title || '', state: 'error', turnId, messageCount: thread?.messageIds?.length || 0 });
    } catch (brokerErr) {
      console.warn('[Yeaft] vp-status error transition failed:', brokerErr?.message || brokerErr);
    }

    if (isPermissionErrorMsg(err.message)) {
      if (!_permissionDiagnosticSent) {
        _permissionDiagnosticSent = true;
        sendYeaftOutput({
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
      sendYeaftOutput({
        type: 'assistant',
        message: {
          content: [{
            type: 'text',
            text: `⚠️ Session error: ${err.message}`,
          }],
        },
      }, envelope);
    }
    sendYeaftOutput({
      type: 'result',
      result_text: '',
    }, envelope);
  } finally {
    // Emit terminal vp_turn_end for the error path (normal + abort + route
    // already emitted above). Done before settleIdle so the web client
    // sees status flip BEFORE the broker's idle event lands.
    if (turnEndReason === 'errored') emitVpTurnEnd('errored', turnEndDetail);
    // vp-status: guaranteed-settle. Regardless of how the turn exited
    // (normal completion, AbortError early-return, caught exception),
    // the row must drop back to 'idle'. EXCEPTION: when the turn errored,
    // we keep the broker's 'error' state visible until the next turn
    // starts, so the user can see something failed instead of a silent
    // green-state turn end. Wrapped in its own try so a broker bug
    // can't mask the original error.
    if (turnEndReason !== 'errored') {
      try {
        getVpStatusBroker().settleIdle({ sessionId, vpId, threadId: threadId || 'main', title: thread?.title || '' });
      } catch (err) {
        console.warn('[Yeaft] vp-status settleIdle failed:', err?.message || err);
      }
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
 * read from disk via `loadRecentBySession` on next session boot. Within
 * a session, this in-memory tape carries the un-collapsed form — which
 * is fine because each VP turn's `engine.query` re-collapses on the fly.
 */
function appendTurnToSessionHistory(sessionId, threadId, vpId, prompts, assistantTextParts, toolCallsAccum, toolResultsAccum, thinkingBlocksAccum) {
  if (!sessionId) return;
  const history = getOrCreateSessionHistory(sessionId);
  const promptList = Array.isArray(prompts) ? prompts : [prompts];
  for (const prompt of promptList) {
    if (typeof prompt === 'string' && prompt.trim()) {
      // user rows intentionally carry NO speakerVpId — every VP in the
      // session should see the prompt in their history.
      history.push({ role: 'user', content: prompt, threadId: threadId || 'main' });
    }
  }

  const fullText = assistantTextParts.join('');
  if (fullText || toolCallsAccum.length > 0) {
    // Stamp speakerVpId on assistant + tool rows so the in-memory
    // baseSnapshot filter (filterSnapshotForVp) can mirror the disk
    // replay's per-VP isolation rules. Without this stamp, the next
    // VP turn would inherit the previous VP's tool_use ids without
    // matching tool_result rows → Anthropic API 422.
    const assistantMsg = { role: 'assistant', content: fullText, threadId: threadId || 'main' };
    if (vpId) assistantMsg.speakerVpId = vpId;
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
    // this in-memory history and in agent-side persistence only. The
    // signature is also VP-private; filterSnapshotForVp drops it from
    // OTHER VPs' rows before each turn's payload is built.
    if (Array.isArray(thinkingBlocksAccum) && thinkingBlocksAccum.length > 0) {
      assistantMsg.thinkingBlocks = thinkingBlocksAccum.map(tb => (
        tb.redacted
          ? { redacted: true, data: tb.data, signature: tb.signature }
          : { thinking: tb.thinking, signature: tb.signature }
      ));
    }
    history.push(assistantMsg);

    for (const tr of toolResultsAccum) {
      const toolMsg = {
        role: 'tool',
        toolCallId: tr.toolCallId,
        content: tr.content,
        isError: tr.isError,
        threadId: threadId || 'main',
      };
      if (vpId) toolMsg.speakerVpId = vpId;
      history.push(toolMsg);
    }
  }
}

/**
 * Persist an inbound message row to disk EXACTLY ONCE per
 * coordinator-ingest call, keyed by the coordinator-assigned `msgId`.
 * Both `handleYeaftSessionSend` (real user input, persists as
 * role='user') and `enqueueForVp`'s driver loop (route_forward
 * synthetic injections, persists as role='assistant' attributed via
 * `speakerVpId`) call this — the Set guard makes either path the
 * writer, whichever runs first, while the other becomes a no-op.
 *
 * Without this dedup, a 2-VP group prompt produces TWO `m{NNNN}.md`
 * user rows (one per engine) — `handleYeaftLoadHistory` then replays
 * the user's prompt twice and sandwiches one VP's reply between two
 * copies of the user message. Visually this reads as "messages out of
 * order" because the second copy of the user prompt sits BETWEEN the
 * two VPs' replies.
 *
 * Best-effort: a write failure does NOT abort the turn — engines can
 * still run, and the next user message will trigger another append.
 *
 * Note: we mirror `engine.#persistMessages`'s core user-row fields
 * (role/content/threadId/sessionId) so existing parsers keep working.
 * Attachment UI metadata is persisted separately (without base64) so
 * refresh replay can render chips without leaking image source data into
 * the message body.
 *
 * @param {{ msgId:string, text:string, sessionId:string, role?:string, speakerVpId?:string|null, attachments?:Array<object> }} args
 * @returns {boolean} true if this call wrote the row, false if a prior
 *   call already wrote it (dedup hit).
 */
function persistInboundMessageOnceByMsgId({ msgId, text, sessionId, threadId = 'main', role, speakerVpId, attachments }) {
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
    // role defaults to 'user' for back-compat: handleYeaftSessionSend's
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
    if (sessionId) record.sessionId = sessionId;
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
      '[Yeaft] persistInboundMessageOnceByMsgId failed (non-fatal):',
      err?.message || err,
    );
    return false;
  }
}

/**
 * Cleared on session reset (resetYeaftSession) so a fresh session
 * starts with no stale msg-ids.
 */
const _persistedUserMsgIds = new Set();

// Per-group post-turn compaction lives on `session.compactor`
// (`agent/yeaft/compact/compactor.js`), constructed in `session.js`.
// Bridge passes a per-call `historyHandle = { get, set }` and wires the
// `yeaft_history_compacted` WS sink via `compactor.setOnCompacted` from
// `installYeaftRuntimeBridge`. The bridge keeps history ownership; the
// Compactor owns single-flight, anti-starvation, race-guard, and the
// LLM summarize call.

/**
 * Abort every in-flight VP turn and clear all queued envelopes across
 * every group/thread runtime. Shared by `handleYeaftAbortThread` when no
 * target thread is supplied and by `handleYeaftAbortAll`. Pushes `vp:<key>`
 * strings into the supplied `aborted` array for the yeaft_aborted event.
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
export function handleYeaftAbortThread(_msg = {}) {
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
    sendYeaftEvent({ type: 'yeaft_aborted', aborted, all: false, threadId: targetThreadId });
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
  sendYeaftEvent({ type: 'yeaft_aborted', aborted, all: false });
  return { aborted, all: false };
}

/**
 * Abort all in-flight Yeaft runtime work.
 * @returns {{ aborted: string[], all: boolean }}
 */
export function handleYeaftAbortAll() {
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
  sendYeaftEvent({ type: 'yeaft_aborted', aborted, all: true });
  return { aborted, all: true };
}

/**
 * Per-VP abort: stops a single VP turn by turnId without affecting siblings.
 * Frontend sends `{ type: 'yeaft_abort_turn', turnId }`.
 * @param {{ turnId?: string }} msg
 */
export function handleYeaftAbortTurn(msg = {}) {
  const { turnId } = msg;
  if (!turnId) {
    sendYeaftEvent({ type: 'yeaft_turn_aborted', turnId: null, success: false });
    return;
  }
  const ctrl = turnAbortCtrls.get(turnId);
  if (ctrl && !ctrl.signal.aborted) {
    try { ctrl.abort(); } catch { /* best-effort */ }
    turnAbortCtrls.delete(turnId);
    turnAbortMeta.delete(turnId);
    sendYeaftEvent({ type: 'yeaft_turn_aborted', turnId, success: true });
  } else {
    turnAbortCtrls.delete(turnId);
    turnAbortMeta.delete(turnId);
    sendYeaftEvent({ type: 'yeaft_turn_aborted', turnId, success: false });
  }
}

/**
 * Unified abort entry: routes by payload shape.
 * @param {{ threadId?: string, all?: boolean }} [opts]
 */
export function abortYeaftSession(opts = {}) {
  if (opts && opts.all) return handleYeaftAbortAll();
  if (opts && opts.threadId) return handleYeaftAbortThread({ threadId: opts.threadId });
  // No payload — conservative no-op ack.
  sendYeaftEvent({ type: 'yeaft_aborted', aborted: [], all: false });
  return { aborted: [], all: false };
}

function seedAbortController(threadId, ctrl, sessionId = 'test', vpId = 'vp', turnId = null) {
  const tid = threadId || 'main';
  const key = threadKey(sessionId, vpId, tid);
  if (ctrl) vpAborts.set(key, ctrl);
  if (turnId && ctrl) {
    turnAbortCtrls.set(turnId, ctrl);
    turnAbortMeta.set(turnId, { sessionId, vpId, threadId: tid, key });
  }
}

/** Test-only: seed an in-flight VP runtime controller. */
export function __testSeedAbortController(threadId, ctrl, sessionId = 'test', vpId = 'vp') {
  seedAbortController(threadId, ctrl, sessionId, vpId);
}

/** Test-only: seed an in-flight VP turn controller. */
export function __testSeedTurnAbortController(turnId, threadId, ctrl, sessionId = 'test', vpId = 'vp') {
  if (!turnId || !ctrl) return;
  const tid = threadId || 'main';
  const key = threadKey(sessionId, vpId, tid);
  turnAbortCtrls.set(turnId, ctrl);
  turnAbortMeta.set(turnId, { sessionId, vpId, threadId: tid, key });
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
 * full session. See `test/agent/yeaft/web-bridge-escalation.test.js`.
 */
export const __testRaceWithEscalation = raceWithEscalation;

/**
 * Test-only: invoke `appendTurnToSessionHistory` directly. Lets the VP
 * stamp contract (`speakerVpId` on assistant + tool rows, none on user
 * rows) be pinned with a table-driven test instead of booting a full
 * session. See `test/agent/yeaft/web-bridge-append-turn-vp-stamp.test.js`.
 */
export function __testAppendTurnToSessionHistory(...args) {
  return appendTurnToSessionHistory(...args);
}

/**
 * Manual dream trigger.
 *
 * Two call shapes, both routed through this single handler:
 *
 *   { type: 'yeaft_dream_trigger', vpId }     — per-VP trigger (legacy
 *     VP-detail page button). Fires an unscoped dream pass; the result
 *     event is tagged with `vpId` so the per-VP store row updates.
 *
 *   { type: 'yeaft_dream_trigger', sessionId }  — per-GROUP trigger (new
 *     in v0.1.754 — added so users can manually kick dream for a group
 *     after seeing the Resident layer stuck on the bootstrap seed).
 *     Fires a scope-filtered pass via `triggerDreamForScopes(['group/X'])`
 *     so unrelated groups don't get processed; the result event is
 *     tagged with `sessionId` for the per-group UI row.
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
    durationMs: Number.isFinite(Number(result?.durationMs)) ? Number(result.durationMs) : 0,
    llmCallCount: Number.isFinite(Number(result?.llmCallCount)) ? Number(result.llmCallCount) : 0,
    inputTokens: Number.isFinite(Number(result?.inputTokens)) ? Number(result.inputTokens) : 0,
    outputTokens: Number.isFinite(Number(result?.outputTokens)) ? Number(result.outputTokens) : 0,
    totalTokens: Number.isFinite(Number(result?.totalTokens)) ? Number(result.totalTokens) : 0,
    metrics: result?.metrics || null,
    passBreakdown: result?.passBreakdown || result?.metrics?.passBreakdown || null,
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

export async function handleYeaftDreamTrigger(msg = {}) {
  // Resolve tag up-front so EVERY outbound envelope (including the
  // scheduler-uninitialised early-return below) carries `sessionId` /
  // `vpId`. Without this the frontend's `applyDreamResult` couldn't
  // route the error event back to the right row and the per-group
  // "Run dream now" button would stay stuck on "Running…" forever
  // (review feedback from PR #757).
  const sessionId = typeof msg.sessionId === 'string' && msg.sessionId ? msg.sessionId : null;
  const vpId = !sessionId ? (msg.vpId || 'default') : null;
  const tag = sessionId ? { sessionId } : { vpId };

  if (!session?.dreamScheduler) {
    const error = 'Dream scheduler not initialized — session not loaded.';
    sendToServer({
      type: 'yeaft_dream_result',
      ...tag,
      ...normalizeDreamResult({ error }),
    });
    return;
  }

  // Concurrent-trigger guard for scoped runs. Two scoped clicks (same
  // group or different) overlapping the same inflight pass used to set
  // the module-level sessionId slot, race the sink wrapping, and let the
  // second `finally` restore the original sink while the first run was
  // still emitting events. We now refuse scoped triggers while ANY dream
  // pass is already running: a scoped manual click during an unscoped
  // auto run must not install `_dreamActiveGroupId` or wrap the sink,
  // otherwise auto-run events can be persisted under the clicked group.
  // The scheduler also short-circuits the underlying run for same-group,
  // and a different group's filter would have been silently dropped
  // anyway (see dream/schedule.js inflight reuse), so the user-facing
  // semantics are unchanged ("you already asked").
  if (sessionId && (inflightScopedDreamGroups.size > 0 || session.dreamScheduler.isRunning)) {
    const skippedResult = {
      skipped: true,
      skippedReason: 'already-running',
      trigger: msg.manual === false ? 'auto' : 'manual',
    };
    sendToServer({
      type: 'yeaft_dream_result',
      ...tag,
      ...skippedResult,
      ...normalizeDreamResult(skippedResult),
    });
    return;
  }

  // Per-call sink wrapper. For scoped runs we install a closure that
  // injects this trigger's sessionId onto top-level events the runner
  // emits without one (start/merge/done), then delegates to the
  // original passthrough sink. The wrapper lives only for the lifetime
  // of this trigger and is restored in `finally`; concurrent calls for
  // OTHER sessionIds chain (last-installed wins) but each restoration
  // unwinds back to its predecessor.
  const originalSink = session?._dreamProgressSink;
  if (sessionId) session._dreamActiveGroupId = sessionId;
  if (sessionId && typeof originalSink === 'function') {
    inflightScopedDreamGroups.add(sessionId);
    session._dreamProgressSink = (evt) => {
      try {
        const stamped = evt && evt.sessionId
          ? evt
          : { ...evt, sessionId };
        originalSink(stamped);
      } catch { /* never let event delivery throw */ }
    };
  }

  try {
    sendToServer({
      type: 'yeaft_dream_status',
      ...tag,
      status: 'running',
    });

    const result = sessionId
      ? await session.dreamScheduler.triggerDreamForScopes([`group/${sessionId}`])
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
    // This `yeaft_dream_result` envelope is the SOLE terminal signal for
    // a dream pass. The chat-store projects it into BOTH `yeaftDreamLatest`
    // (final tally row) AND `yeaftDreamEvents` (ring-buffer terminal
    // marker), so we no longer mirror a synthetic `phase:'result'`
    // dream_progress event — that mirror used to race the
    // `yeaftDreamLatest` writer and flip the success row back to
    // 'running' (Critical reviewer finding pre-merge).
    sendToServer({
      type: 'yeaft_dream_result',
      ...tag,
      ...result,
      ...normalized,
    });
  } catch (err) {
    const error = err?.message || String(err);
    sendToServer({
      type: 'yeaft_dream_result',
      ...tag,
      ...normalizeDreamResult({ error }),
    });
  } finally {
    // Restore the original sink and release the per-group inflight lock.
    if (sessionId && session?._dreamActiveGroupId === sessionId) session._dreamActiveGroupId = null;
    if (sessionId && typeof originalSink === 'function') {
      session._dreamProgressSink = originalSink;
      inflightScopedDreamGroups.delete(sessionId);
    }
  }
}

/**
 * 2026-05-13: serve the Yeaft debug drawer's "Tool Stats" panel.
 *
 * Replies with `{type: 'yeaft_tool_stats', snapshot, registered,
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
export async function handleYeaftFetchToolStats(_msg = {}) {
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
      type: 'yeaft_tool_stats',
      snapshot: {},
      registered: [],
      unused: [],
      error: err && err.message ? err.message : String(err),
    });
    return;
  }
  sendToServer({
    type: 'yeaft_tool_stats',
    snapshot,
    registered,
    unused,
  });
}

/**
 * Hydrate the YeaftDebugPanel from the persistent SQLite trace. The
 * panel state (`yeaftDebugLoops` / `yeaftDebugTurnsById`) is otherwise
 * built ONLY from in-flight `loop` / `turn_open` events on the wire,
 * so a panel opened after a turn has finished sees nothing for that
 * turn. This handler ships back a frontend-shaped snapshot the store
 * splices into place.
 *
 * Inputs (all optional):
 *   - `limit`     — max number of loops to return (1..500, default 100)
 *   - `sessionId`   — narrow by group
 *   - `threadId`  — narrow by thread
 *
 * Sends:
 *   { type: 'yeaft_debug_history', loops: [...], turns: [...] }
 *
 * Best-effort: if the session / trace isn't ready, sends an empty
 * snapshot so the panel renders a placeholder instead of spinning.
 */
export async function handleYeaftFetchDebugHistory(msg = {}) {
  const limit = Number.isFinite(msg?.limit) ? Number(msg.limit) : 100;
  const dreamLimit = Number.isFinite(msg?.dreamLimit) ? Number(msg.dreamLimit) : 5;
  const sessionId = typeof msg?.sessionId === 'string' && msg.sessionId ? msg.sessionId : null;
  const threadId = typeof msg?.threadId === 'string' && msg.threadId ? msg.threadId : null;
  let loops = [];
  let turns = [];
  let dreamEvents = [];
  try {
    if (session?.trace && typeof session.trace.fetchRecentDebugHistory === 'function') {
      const out = session.trace.fetchRecentDebugHistory({ limit, dreamLimit, sessionId, threadId });
      loops = Array.isArray(out?.loops) ? out.loops : [];
      turns = Array.isArray(out?.turns) ? out.turns : [];
      dreamEvents = Array.isArray(out?.dreamEvents) ? out.dreamEvents : [];
    }
  } catch (err) {
    sendToServer({
      type: 'yeaft_debug_history',
      loops: [],
      turns: [],
      dreamEvents: [],
      error: err && err.message ? err.message : String(err),
    });
    return;
  }
  sendToServer({
    type: 'yeaft_debug_history',
    loops,
    turns,
    dreamEvents,
    sessionId,
    threadId,
  });
}

/** Deprecated mode switch — Yeaft is single-mode. */
export function handleYeaftModeSwitch(_msg) {
  console.warn('[Yeaft] yeaft_mode_switch is deprecated and ignored — Yeaft now runs in a single unified mode.');
}


/** Handle model switch from the web UI. */
export function handleYeaftModelSwitch(msg) {
  if (!session || !msg.model) return;

  const available = session.config.availableModels || [];
  const found = available.some(m => m.id === msg.model);
  if (!found) {
    console.warn(`[Yeaft] model switch rejected — "${msg.model}" not in availableModels`);
    return;
  }

  session.config.model = msg.model;

  sendYeaftEvent({
    type: 'model_switched',
    model: msg.model,
  });
}

/**
 * Handle history load request. Loads recent messages from ConversationStore
 * and replays them through the standard claude_output pipeline.
 *
 * Group-history-isolation (Bug 7): when `msg.sessionId` is provided the
 * replay AND the engine's bootstrap context are filtered to that group.
 * Messages tagged with another sessionId — and legacy messages with no
 * sessionId at all — are excluded so a stale `grp_default` (or any other
 * group) never bleeds into the active group's pane.
 */
export async function handleYeaftLoadHistory(msg) {
  const sessionId = (msg && typeof msg.sessionId === 'string' && msg.sessionId) || null;
  // `lim` is now expressed in TURNS, not raw messages. `loadRecent` and
  // `loadRecentBySession` use turn-based slicing so the cut never lands
  // mid-tool-arc. Pass `undefined` to use the persistence-layer default
  // (DEFAULT_RECENT_TURNS = 20 turns).
  const pickRecent = (store, lim) =>
    sessionId ? store.loadRecentBySession(sessionId, lim) : store.loadRecent(lim);

  if (!session) {
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    session = await loadSession({
      ...(yeaftDir && { dir: yeaftDir }),
      skipMCP: false,
      skipSkills: false,
      serverMode: true,
    });
    installYeaftRuntimeBridge(session);

    yeaftConversationId = `yeaft-${Date.now()}`;

    // Per-group history hydrates lazily via getOrCreateSessionHistory.
    // When the load-history call carries a sessionId, force-refresh THAT
    // group's tape so the next user message sees on-disk state. When
    // it doesn't (legacy callers), do nothing — the per-group lazy
    // hydration handles it.
    if (sessionId) setGroupHistory(sessionId, hydrateGroupHistory(sessionId));
  } else if (sessionId) {
    // Re-entering an existing session with a (possibly new) group filter:
    // re-seed THIS group's history from disk so it doesn't carry stale
    // in-memory state into the next turn's context.
    setGroupHistory(sessionId, hydrateGroupHistory(sessionId));
  }

  // Always replay session_ready so refresh / reconnect rebuilds UI state.
  sendYeaftEvent({
    type: 'session_ready',
    conversationId: yeaftConversationId,
    model: session.config.model,
    availableModels: session.config.availableModels || [],
    skills: session.status.skills,
    mcpServers: session.status.mcpServers,
    tools: session.status.tools,
    yeaftDir: ctx.CONFIG?.yeaftDir || null,
  });
  sendSessionSnapshotBroadcast();
  // vp-status: replay the authoritative table on reconnect so a refreshed
  // frontend doesn't have to wait for the next transition to learn each
  // VP's current state.
  try {
    getVpStatusBroker().broadcastSnapshot();
  } catch (err) {
    console.warn('[Yeaft] vp-status snapshot broadcast (replay) failed:', err?.message || err);
  }

  // Delta path: caller knows the latest seq (or message id) it has cached
  // and wants only the messages that arrived after that cursor. Returns
  // early with mode:'delta' so the frontend can append+dedupe instead of
  // replacing the pane.
  const afterSeqRaw = (msg && Number.isFinite(msg.afterSeq)) ? msg.afterSeq : null;
  const afterMessageId = (msg && typeof msg.afterMessageId === 'string') ? msg.afterMessageId : null;
  let afterSeq = afterSeqRaw;
  if (afterSeq === null && afterMessageId && typeof session.conversationStore.getMessageSeqById === 'function') {
    afterSeq = session.conversationStore.getMessageSeqById(afterMessageId);
  }
  if (sessionId && afterSeq !== null && typeof session.conversationStore.loadAfterSeqByGroup === 'function') {
    const delta = session.conversationStore.loadAfterSeqByGroup(sessionId, afterSeq);
    for (const entry of delta.messages) {
      if (entry.role === 'user') {
        sendYeaftOutput({
          type: 'user',
          message: {
            content: entry.content,
            id: entry.id || null,
            ...(Array.isArray(entry.attachments) && entry.attachments.length > 0 ? { attachments: hydrateHistoryAttachmentPreviews(entry.attachments) } : {}),
          },
          ts: entry.ts || null,
        }, { sessionId: entry.sessionId || null, threadId: entry.threadId || 'main', turnId: entry.turnId || entry.threadId || 'main' });
      } else if (entry.role === 'assistant') {
        const envelopeOpts = {
          sessionId: entry.sessionId || null,
          threadId: entry.threadId || 'main',
          turnId: entry.turnId || entry.threadId || 'main',
        };
        if (entry.speakerVpId) envelopeOpts.vpId = entry.speakerVpId;
        sendYeaftOutput({
          type: 'assistant',
          message: { id: entry.id || null, content: [{ type: 'text', text: entry.content }] },
          ts: entry.ts || null,
        }, envelopeOpts);
        sendYeaftOutput({ type: 'result', result_text: '' }, envelopeOpts);
      }
    }
    sendYeaftEvent({
      type: 'history_loaded',
      mode: 'delta',
      count: delta.messages.length,
      sessionId,
      latestSeq: delta.latestSeq,
      afterSeq,
    });
    return;
  }

  // `msg.limit` is the replay-scrollback request from the frontend (UI
  // history pane, not engine context). Keep the bootstrap window small so
  // opening a group can paint the latest messages quickly; older rows are
  // paged via `yeaft_load_more_history` when the user scrolls upward.
  const limit = (typeof msg.limit === 'number') ? msg.limit : 10;
  const visiblePage = sessionId
    ? loadVisibleGroupHistoryPage(session.conversationStore, sessionId, limit)
    : { messages: limit > 0 ? pickRecent(session.conversationStore, limit) : [], oldestSeq: null, hasMore: false };
  // Legacy compact.md is a non-group fallback only. For group replay, reading
  // it makes every group show "has compact" once any legacy/non-scoped compact
  // exists, even when this group has no scoped summary.
  const compactSummary = sessionId ? '' : session.conversationStore.readCompactSummary();
  const replayEntries = sessionId
    ? visiblePage.messages
    : visiblePage.messages
      .map(projectPersistedToVisibleHistoryEntry)
      .filter(Boolean);

  for (const entry of replayEntries) {
    if (entry.role === 'user') {
      sendYeaftOutput({
        type: 'user',
        message: {
          content: entry.content,
          id: entry.id || null,
          ...(Array.isArray(entry.attachments) && entry.attachments.length > 0 ? { attachments: hydrateHistoryAttachmentPreviews(entry.attachments) } : {}),
        },
        ts: entry.ts || null,
      }, { sessionId: entry.sessionId || null, threadId: entry.threadId || 'main', turnId: entry.turnId || entry.threadId || 'main' });
    } else if (entry.role === 'assistant') {
      // speakerVpId rides on the envelope so the frontend can route this
      // replayed assistant text to the correct VP track. Without it, the
      // history replay would merge replies from different VPs onto one
      // anonymous assistant turn.
      const envelopeOpts = {
        sessionId: entry.sessionId || null,
        threadId: entry.threadId || 'main',
        turnId: entry.turnId || entry.threadId || 'main',
      };
      if (entry.speakerVpId) envelopeOpts.vpId = entry.speakerVpId;
      sendYeaftOutput({
        type: 'assistant',
        message: { id: entry.id || null, content: [{ type: 'text', text: entry.content }] },
        ts: entry.ts || null,
      }, envelopeOpts);
      sendYeaftOutput({ type: 'result', result_text: '' }, envelopeOpts);
    }
  }

  // Compute the pagination cursor for the bootstrap load so the frontend
  // knows whether a "Load older messages" hint should be shown and where
  // to start the next page. For group history, this is computed from the
  // visible projected page, not raw persisted rows, so reflection/internal
  // tail rows cannot consume the bootstrap window or create false hasMore.
  let hasMore = false;
  let oldestSeq = null;
  if (sessionId) {
    hasMore = visiblePage.hasMore;
    oldestSeq = visiblePage.oldestSeq;
  }

  // hasCompactSummary used to read a single session-global file, so it was
  // always true once ANY group/VP in the session had compacted. For group
  // replay, only scoped per-(group, vp) summaries count; legacy compact.md is
  // reserved for non-group / pre-scoped 1:1 callers.
  let hasCompactSummaryFlag = !!compactSummary;
  if (sessionId && typeof session.conversationStore.hasAnyCompactSummaryForSession === 'function') {
    hasCompactSummaryFlag = session.conversationStore.hasAnyCompactSummaryForSession(sessionId);
  }

  // Latest seq cursor in the recent-mode reply lets the frontend stamp its
  // delta cursor on first paint, so the next session-switch can ask for
  // afterSeq instead of a full recent-N replay.
  let latestSeq = null;
  if (replayEntries.length > 0 && typeof session.conversationStore.getMessageSeqById === 'function') {
    const last = replayEntries[replayEntries.length - 1];
    if (last && last.id) latestSeq = session.conversationStore.getMessageSeqById(last.id);
  }

  sendYeaftEvent({
    type: 'history_loaded',
    mode: 'recent',
    count: replayEntries.length,
    hasCompactSummary: hasCompactSummaryFlag,
    totalHot: session.conversationStore.countHot(),
    totalCold: session.conversationStore.countCold(),
    sessionId,
    hasMore,
    oldestSeq,
    latestSeq,
  });
}

/**
 * Handle a "load older messages" pagination request. Reads `turns` more
 * turns of history strictly older than `beforeSeq` for `sessionId`, and
 * emits them in a single `yeaft_history_chunk` envelope (NOT a
 * `yeaft_output` — that pipeline appends, but the frontend needs to
 * PREPEND these older messages above what it already has).
 *
 * Tool replay is NOT included in this PR — same projection as
 * `handleYeaftLoadHistory` (user / assistant text only). On any internal
 * failure we still emit an empty chunk so the spinner clears.
 *
 * @param {object} msg — { sessionId, beforeSeq, turns }
 */
export async function handleYeaftLoadMoreHistory(msg) {
  const sessionId = (msg && typeof msg.sessionId === 'string' && msg.sessionId) || null;
  const emit = (payload) => sendToServer({
    type: 'yeaft_history_chunk',
    conversationId: yeaftConversationId,
    sessionId,
    ...payload,
  });

  if (!session || !sessionId) {
    emit({ messages: [], oldestSeq: null, hasMore: false });
    return;
  }

  const beforeSeq = (typeof msg.beforeSeq === 'number') ? msg.beforeSeq : null;
  const turns = (typeof msg.turns === 'number' && msg.turns > 0) ? msg.turns : 10;

  let result;
  try {
    result = loadVisibleGroupHistoryPage(session.conversationStore, sessionId, turns, beforeSeq);
  } catch (err) {
    console.error('[Yeaft] loadOlderBySession failed:', err.message);
    result = { messages: [], oldestSeq: null, hasMore: false };
  }

  // Wire shape mirrors handleYeaftLoadHistory's projection: only visible
  // user / assistant text rows. Internal reflection/system-only rows stay
  // server-side, and stable ids + speaker attribution ride with each row
  // so older-history prepend renders exactly like refresh replay.
  const projected = (result.messages || [])
    .map(m => ({
      ...(m.id ? { id: m.id } : {}),
      role: m.role,
      content: m.content,
      ts: m.ts || m.time || null,
      sessionId: m.sessionId || null,
      threadId: m.threadId || m.turnId || 'main',
      turnId: m.turnId || m.threadId || 'main',
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
 * Reset Yeaft session. Aborts the in-flight controller, tears down the
 * session, then re-initialises so the frontend gets fresh config.
 */
export async function resetYeaftSession() {
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
  yeaftConversationId = null;
  // Per-group histories live on sessionContexts entries — clearing the
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
  sessionContexts.clear();
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
    console.warn('[Yeaft] vp-status broker reset failed:', err?.message || err);
  }

  try {
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    session = await loadSession({
      ...(yeaftDir && { dir: yeaftDir }),
      skipMCP: false,
      skipSkills: false,
      serverMode: true,
    });
    installYeaftRuntimeBridge(session);

    yeaftConversationId = `yeaft-${Date.now()}`;

    // Per-group history hydrates lazily via getOrCreateSessionHistory on
    // first read. Nothing to seed here.

    sendYeaftEvent({
      type: 'session_ready',
      conversationId: yeaftConversationId,
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
      console.warn('[Yeaft] vp-status snapshot broadcast (reset) failed:', err?.message || err);
    }
  } catch (err) {
    console.error('[Yeaft] Failed to re-initialize session after reset:', err.message);
  }
}
