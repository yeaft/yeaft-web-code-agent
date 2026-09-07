/**
 * web-bridge.js — Bridge between web UI and Yeaft Yeaft Engine.
 *
 * PR #797: group VP runtime is threaded again. Each group VP can own multiple
 * classified threads, keyed by (sessionId, vpId, threadId), with separate engine,
 * inbox, abort, todo, persistence, and frontend timeline boundaries. Legacy
 * 1:1 chat paths still use the default `main` thread.
 *
 * Translates Engine events into provider-neutral assistant output frames so
 * the frontend can fully reuse the standard Chat rendering pipeline
 * (MessageList, AssistantTurn, ToolLine, AskCard, waiting cat, etc.).
 *
 * task-330c lint guard:
 *   ⚠️ DO NOT introduce greedy `text.replace(/---ROUTE---[\s\S]*$/g, '')`
 *      style strips on incoming/outgoing message bodies.
 */

import { delimiter, join } from 'node:path';
import { COLLAB_TOOL_POLICY } from './tools/registry.js';
import { existsSync, lstatSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DEFAULT_YEAFT_DIR } from './init.js';
import { buildDreamOutputSnapshot } from './dream/output-snapshot.js';
import { Engine } from './engine.js';
import { loadSession } from './session.js';
import { loadAgentMCPConfig, loadConfig, loadMCPConfig } from './config.js';
import {
  createManagedProjectSkill,
  createManagedSkill,
  createSkillManager,
  removeManagedProjectSkill,
  removeManagedSkill,
} from './skills.js';
import { buildPluginCatalog, createPluginSkillManager, resolveMcpPluginPolicy } from './plugins.js';
import { MCPManager } from './mcp.js';
import { sendToServer } from '../connection/buffer.js';
import ctx from '../context.js';

const DEBUG_HISTORY_CHUNK_BYTES = 512 * 1024;

function splitUtf8Json(text, maxBytes = DEBUG_HISTORY_CHUNK_BYTES) {
  const source = Buffer.from(text, 'utf8');
  const chunks = [];
  for (let start = 0; start < source.length;) {
    let end = Math.min(source.length, start + maxBytes);
    if (end < source.length) {
      while (end > start && (source[end] & 0xc0) === 0x80) end -= 1;
      if (end === start) throw new Error('Unable to split debug history UTF-8 payload');
    }
    chunks.push(source.subarray(start, end).toString('utf8'));
    start = end;
  }
  return chunks;
}

async function sendDebugHistory(payload) {
  const encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded, 'utf8') <= DEBUG_HISTORY_CHUNK_BYTES) {
    await sendToServer(payload); // Legacy single-frame wire remains valid.
    return;
  }
  const chunks = splitUtf8Json(encoded);
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    await sendToServer({
      type: 'yeaft_debug_history_chunk',
      requestId: payload.requestId,
      sessionId: payload.sessionId,
      chunkIndex,
      chunkCount: chunks.length,
      data: chunks[chunkIndex],
    });
  }
}

import { hydrateYeaftStatusFromSession } from './status-cache.js';
import { handleVpSubscribe } from './vp/vp-bridge.js';
import { createVp, updateVp, deleteVp, readVp, VpCrudError } from './vp/vp-crud.js';
import { scanVpLibrary } from './vp/vp-store.js';
import {
  bindRepoApprovalCapability,
  createRouter,
  isRepoApprovalCapability,
  revokeRepoApprovalCapability,
} from './routing/router.js';
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
  sessionsRoot,
  scanWorkdirSessions,
  restoreSessionToRegistry,
  readWorkDirRegistry,
  migrateRegisteredWorkDirSessions,
  resolveSessionYeaftDir,
} from './sessions/session-crud.js';
import { openSession, loadSessionMeta, SESSION_META_FILE } from './sessions/session-store.js';
import { validateSessionId } from './sessions/ids.js';
import { loadSessionConfig, normalizeSessionConfig, resolveSessionConfig, SessionConfigError } from './sessions/session-config.js';
import { updateSessionConfig } from './sessions/session-crud.js';
import { createCoordinator } from './sessions/coordinator.js';
import { seedDefaultSession } from './sessions/seed-default.js';
import { trimHistoryCacheForRuntime, trimSnapshotForBudget } from './history-window.js';
import { persistYeaftAttachments, attachmentsForPersistence, persistedAttachmentPreviewPayload } from './attachments.js';
import { normalizeSessionMessageQuote, sessionMessageQuotePrompt } from './session-message-quote.js';
import { ConversationStore, parseSeqFromId, projectVisibleSessionMessages } from './conversation/persist.js';
import {
  loadConversationOutlineFromIndex,
  readConversationIndexWindow,
  searchConversationIndex,
} from './conversation/history-index.js';
import { isHiddenConversationRow, isVisibleConversationRow } from './conversation/internal-control.js';
import {
  ProjectStoreError,
  createProject,
  deleteProject,
  loadProjects,
  moveSessionToProject,
  removeSessionFromProjects,
  renameProject,
  reorderProjects,
  updateProjectInstruction,
} from './projects/store.js';
import { readSummary as readScopeSummary } from './memory/store.js';
import { estimateTokens } from './dream/segment.js';
import { imageMetadataForPersistence } from './image-assets.js';
import { sliceLastNTurns } from './turn-utils.js';
import { pairSanitize } from './pair-sanitize.js';
import { filterSnapshotForVp } from './snapshot-filter.js';
import { createVpStatusBroker, isVpStatusRunning } from './vp-status-broker.js';
import { classifyThread as defaultClassifyThread, fallbackTitle } from './vp/thread-classifier.js';
import { listMcpServers, upsertMcpServer, removeMcpServer } from './config-api.js';
import { buildMcpFlattenedTools } from './tools/mcp-tools.js';
import { getAgentRegistry, agentBelongsToScope } from './tools/agent.js';
import { enqueueSubAgentPrompt } from './sub-agent/prompt-queue.js';
import { isPromptableAgentStatus, isTerminalAgentStatus, STATUS } from './sub-agent/status.js';
import { consumeNotificationForAgent } from './sub-agent/notifications.js';
import { perfNowMs, recordAgentPerfTrace } from './perf-trace.js';
import { recordAgentSessionCreated, recordAgentTurn } from '../metrics.js';
import { TASK_RESULT_DELIVERY, isTerminalTaskStatus, taskResultDeliveryFor } from './tasks/store.js';
import { formatTaskResultForVp } from './tasks/result-format.js';

const LEGACY_SKILL_COMMAND_PREFIX = 'skill:';
const YEAFT_SKILL_COMMAND_PREFIX = 'yeaft-skills:';
const PROJECT_SKILL_TIERS = new Set(['project', 'project-claude', 'project-codex']);
const BASE_RUNTIME_KEY = '__base__';
const SKILL_RELOAD_INTERVAL_MS = 2_000;

/**
 * Live AskUser requests. They are Session-scoped runtime state rather than a
 * turn lock: every connected client may answer the same request, while the
 * first valid answer wins. Pending requests are replayed when another device
 * loads the Session.
 * @type {Map<string, {
 *   resolve:Function,
 *   reject?:Function,
 *   sessionId:string,
 *   vpId:string,
 *   threadId:string,
 *   turnId:string,
 *   toolCallId:string,
 *   question:string,
 *   options:Array<string>,
 *   createdAt:number,
 *   expiresAt:number,
 *   timer?:NodeJS.Timeout|null,
 *   resumeQueryTimer?:Function,
 *   signal?:AbortSignal,
 *   onAbort?:Function,
 * }>} */
const pendingUserPrompts = new Map();

/** @type {import('./session.js').Session | null} */
let session = null;

// Agent-local MCP config and live runtime managers are mutable. WebSocket
// dispatch deliberately allows unrelated frames to overlap, so serialize MCP
// CRUD and runtime bootstrap from config read through connection, activation,
// tool hot-swap, and MCP publication. Keep the tail fulfilled after a failure:
// the caller still receives its error, but a later transition is not blocked.
let mcpTransitionTail = Promise.resolve();

function enqueueMcpTransition(operation) {
  const queued = mcpTransitionTail.then(operation);
  mcpTransitionTail = queued.catch(() => undefined);
  return queued;
}

/**
 * Single-flight runtime boot. History replay must not wait for this promise on
 * cold load; message send still awaits it through ensureSessionLoaded().
 * @type {Promise<import('./session.js').Session> | null}
 */
let sessionLoadPromise = null;

let threadClassifier = defaultClassifyThread;

function liveConfigRoot() {
  return session?.config?.dir || ctx.CONFIG?.yeaftDir || session?.yeaftDir;
}

function applyLiveLanguage(language) {
  if (!language || typeof language !== 'string') return;
  if (session?.config && typeof session.config === 'object') {
    session.config.language = language;
  }
  for (const eng of vpEngines.values()) {
    try { eng.setLanguage?.(language); } catch { /* best-effort */ }
  }
  try { session?.engine?.setLanguage?.(language); } catch { /* best-effort */ }
}

/**
 * Apply an Agent-level Dream toggle to an already loaded runtime.
 * This must never bootstrap a Session: config.json is the authoritative commit,
 * while the live scheduler update is only a best-effort cache refresh.
 */
export function setLiveDreamEnabled(enabled) {
  const next = enabled !== false;
  if (session?.config && typeof session.config === 'object') {
    session.config.dream = { ...(session.config.dream || {}), enabled: next };
  }
  session?.dreamScheduler?.setEnabled?.(next);
}

function modelRefIdentity(value) {
  const text = String(value || '');
  const slash = text.indexOf('/');
  return slash < 0
    ? { provider: '', modelId: text }
    : { provider: text.slice(0, slash), modelId: text.slice(slash + 1) };
}

function modelRefsEquivalent(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  const a = modelRefIdentity(left);
  const b = modelRefIdentity(right);
  if (a.modelId !== b.modelId) return false;
  return !a.provider || !b.provider || a.provider === b.provider;
}

function resolveLiveSessionConfig(baseConfig, sessionId, options = {}) {
  const configRoot = baseConfig?.dir || liveConfigRoot();
  const sessionConfig = normalizeSessionConfig(configRoot, sessionId, baseConfig, options);
  const resolved = resolveSessionConfig(baseConfig, sessionConfig);
  // Session config lives in the agent-local root. `resolveSessionConfig()`
  // intentionally returns a fresh object without its storage hint, so restore
  // it for the next cached-engine lookup.
  return configRoot && !resolved.dir ? { ...resolved, dir: configRoot } : resolved;
}

let sessionConfigRefreshRevision = 0;

/**
 * Reload the Agent-owned config and install it into every live Engine.
 *
 * This deliberately mutates only runtime snapshots. Model/config saves must
 * not retire cached engines, clear task owners, invalidate the coordinator, or
 * abort a request that has already started. Engine.query() captures its LLM
 * request values at each loop boundary, so an active stream completes with its
 * original config and a following tool loop uses the published snapshot.
 */
export async function refreshLiveSessionConfig(options = {}) {
  sessionConfigRefreshRevision += 1;
  if (!session && sessionLoadPromise) {
    // The loader may run its own catch-up refresh, but it does not know this
    // config transaction's pre-save default. Wait for it, then continue once
    // with the original normalization input.
    await sessionLoadPromise;
  }

  const configRoot = liveConfigRoot();
  const freshConfig = loadConfig({ dir: configRoot });
  // All bridge producers reference ctx.CONFIG. Keep it synchronized even
  // when no live Session is loaded and refresh returns early below.
  if (ctx.CONFIG && typeof ctx.CONFIG === 'object') {
    ctx.CONFIG.telemetry = freshConfig.telemetry;
  }
  const previousDefaultModel = options.previousDefaultModel
    || session?.config?.primaryModel
    || session?.config?.model
    || null;
  // Normalize disk state even before the runtime is loaded. The config-save
  // transaction supplies the pre-write default so legacy automatic seeds can
  // become inheritance without depending on page/session lifecycle.
  for (const row of snapshotSessions(configRoot)) {
    normalizeSessionConfig(configRoot, row.id, freshConfig, { previousDefaultModel });
  }
  if (!session) return freshConfig;

  const liveSession = session;
  const currentConfig = liveSession.config || {};
  const pluginsChanged = JSON.stringify(currentConfig.plugins || {})
    !== JSON.stringify(freshConfig.plugins || {});
  const runtimeOnly = {};
  for (const key of ['serverMode', '_readOnly', 'modelEffort']) {
    if (Object.prototype.hasOwnProperty.call(currentConfig, key)) runtimeOnly[key] = currentConfig[key];
  }
  const inheritedAgentDefault = !currentConfig.model
    || modelRefsEquivalent(currentConfig.model, currentConfig.primaryModel);
  const nextModel = inheritedAgentDefault
    ? (freshConfig.primaryModel || freshConfig.model)
    : currentConfig.model;
  const nextConfig = { ...freshConfig, ...runtimeOnly, model: nextModel };
  const vpConfigSnapshots = [];
  for (const [key, engine] of vpEngines) {
    const separator = key.indexOf('::');
    if (separator < 1) continue;
    const sessionId = key.slice(0, separator);
    vpConfigSnapshots.push({
      key,
      engine,
      config: resolveLiveSessionConfig(nextConfig, sessionId, { previousDefaultModel }),
    });
  }

  if (typeof liveSession.adapter?.refreshProviders === 'function') {
    liveSession.adapter.refreshProviders(freshConfig.providers || []);
  }
  // Plugin selections affect connected MCP processes as well as model-visible
  // schemas. Retire cached project runtimes before applying the new selection;
  // the base runtime is rebuilt below so the default Session cannot retain old
  // MCP tools or a stale manager after a save.
  if (pluginsChanged) await shutdownProjectRuntimes();
  for (const key of Object.keys(currentConfig)) delete currentConfig[key];
  Object.assign(currentConfig, nextConfig);
  liveSession.engine?.refreshConfig?.(currentConfig);
  liveSession.trace?.refreshConfig?.(currentConfig.telemetry || {});
  if (pluginsChanged && session === liveSession) {
    claimRuntimeOwnership(liveSession);
    await scheduleBaseRuntimeLoad();
  }
  for (const { key, engine, config } of vpConfigSnapshots) {
    engine.refreshConfig?.(config);
    vpEngineConfigKeys.set(key, engineConfigKey(config));
  }
  if (freshConfig.language) applyLiveLanguage(freshConfig.language);
  return currentConfig;
}


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

async function sendDreamSnapshotForSession(sessionId, extra = {}) {
  const snapshot = await buildDreamOutputSnapshot(session, sessionId);
  if (!snapshot) return null;
  sendSessionEvent({ type: 'yeaft_dream_snapshot', ...extra, snapshot }, { sessionId });
  return snapshot;
}

function scheduleYeaftLoadHistoryMetadataReplay(sessionId) {
  const replaySession = session;
  const replayConversationId = yeaftConversationId;
  setTimeout(async () => {
    try {
      if (!replaySession || session !== replaySession) return;
      try {
        await refreshLiveSessionConfig();
      } catch (err) {
        console.warn('[Yeaft] load-history config refresh failed:', err?.message || err);
      }
      let projectRuntime = null;
      if (sessionId) {
        try {
          const metaRoot = ctx.CONFIG?.yeaftDir || DEFAULT_YEAFT_DIR;
          const meta = loadSessionMeta(join(sessionsRoot(metaRoot), sessionId));
          const workDir = normalizeSessionWorkDir(meta?.workDir);
          if (workDir) {
            const scheduled = scheduleProjectRuntimeLoad(workDir);
            projectRuntime = scheduled && typeof scheduled.then === 'function'
              ? await scheduled
              : scheduled;
          } else {
            activateBaseRuntime(captureRuntimeOwner(replaySession));
          }
        } catch { /* best-effort project metadata */ }
      }
      if (session !== replaySession) return;
      const status = mergedStatusForProjectRuntime(projectRuntime, replaySession);
      hydrateYeaftStatusFromSession({ ...replaySession, status }, { reason: 'history_load', emitEvent: true });
      sendSessionEvent({
        type: 'session_ready',
        conversationId: replayConversationId,
        model: replaySession.config.primaryModel || replaySession.config.model,
        modelEffort: replaySession.config.modelEffort || null,
        availableModels: replaySession.config.availableModels || [],
        skills: status.skills,
        mcpServers: status.mcpServers,
        tools: status.tools,
        yeaftDir: ctx.CONFIG?.yeaftDir || null,
        tasks: replaySession.taskManager ? replaySession.taskManager.listActiveTasks() : [],
      }, { sessionId });
      if (sessionId) replayPendingUserPrompts(sessionId);
      sendSessionSnapshotBroadcast();
      if (sessionId && session === replaySession) {
        sendDreamSnapshotForSession(sessionId, { trigger: 'load_history' }).catch(() => null);
      }
      try {
        getVpStatusBroker().broadcastSnapshot();
      } catch (err) {
        console.warn('[Yeaft] vp-status snapshot broadcast (replay) failed:', err?.message || err);
      }
    } catch (err) {
      console.warn('[Yeaft] load-history metadata replay failed:', err?.message || err);
    }
  }, 0);
}


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
 * blindly aborting every turn controller in the process. Queued VP turns are
 * registered here before their AbortController exists so the VP-list Stop
 * button can remove them from the inbox instead of becoming a no-op.
 * @type {Map<string, { sessionId: string, vpId: string, threadId: string, key: string }>}
 */
const turnAbortMeta = new Map();
/** @type {Map<string, { capability: object, sessionId: string, vpId: string }>} Exact-turn repo approvals, never persisted or projected. */
const turnRepoApprovals = new Map();

function revokeTurnRepoApproval(turnId) {
  const grant = turnRepoApprovals.get(turnId);
  turnRepoApprovals.delete(turnId);
  return grant ? revokeRepoApprovalCapability(grant.capability) : false;
}

function revokeRepoApprovalsForRecipient(sessionId, vpId) {
  for (const [turnId, grant] of turnRepoApprovals.entries()) {
    if (grant.sessionId !== sessionId || grant.vpId !== vpId) continue;
    revokeTurnRepoApproval(turnId);
  }
}

/**
 * Per-VP status broker — the agent-side authority for VP timeline
 * status. Lazy-initialized on first use because `sendSessionEvent` is
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
        // `vp_status_snapshot`. Both ride the standard sendSessionEvent
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
        sendSessionEvent(event, env);
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
 *      `#abortReason`, `#adjustRanBySession`, `#execLog`, `#currentThreadId`)
 *      does not collide across concurrent VP turns. Engines are keyed by
 *      `${sessionId}::${vpId}::${threadId}` rather than vpId alone because
 *      Engine cannot serve two concurrent queries safely — even if AMS state
 *      partitions correctly by sessionKey, the non-session-keyed private state
 *      would collide if the same VP ran turns in two groups or two threads
 *      in parallel.
 */
/** @type {Map<string, Array<{envelope: object, opts: object}>>} */
const vpInboxes = new Map();
/** @type {Map<string, Promise<void>>} */
const vpDrivers = new Map();
/** @type {Map<string, import('./engine.js').Engine>} */
const vpEngines = new Map();
/** @type {Map<string, string>} */
const vpEngineConfigKeys = new Map();
/** @type {Map<string, AbortController>} */
const vpAborts = new Map();

/**
 * Owner index for background tasks currently parked on a running engine.
 * Populated by the per-engine async-task coordinator at register time;
 * cleared at notify time or when the engine teardown unregisters whatever
 * it didn't get to deliver. Used by `scheduleTaskResultReentry` to pick
 * "same-turn injection" over the legacy "new turn" rescue path when the
 * engine is still live.
 * @type {Map<string, import('./engine.js').Engine>}
 */
const asyncTaskOwners = new Map();

function deleteAsyncTaskOwnerIfMatch(taskId, engine) {
  if (typeof taskId !== 'string' || !taskId) return false;
  if (asyncTaskOwners.get(taskId) !== engine) return false;
  asyncTaskOwners.delete(taskId);
  return true;
}

/**
 * Retire one cached VP Engine without letting stale task ownership leak into
 * its replacement. Non-destructive retirement rescues accepted-but-undrained
 * terminal results; destructive Session/roster removal explicitly discards
 * them so a deleted runtime is not recreated by a rescue turn.
 */
function retireCachedVpEngine(key, {
  reason = 'engine_retired',
  rescue = true,
  expectedEngine = null,
} = {}) {
  const cachedEngine = vpEngines.get(key) || null;
  const engine = expectedEngine || cachedEngine;
  if (!engine) {
    if (!vpEngines.has(key)) vpEngineConfigKeys.delete(key);
    return null;
  }

  // Destructive removal must discard accepted payloads before abort(), whose
  // default is to rescue. Config changes and watchdog retirement keep rescue.
  if (!rescue) {
    try { engine.retireAsyncTasks?.(reason, { rescue: false }); } catch { /* best-effort */ }
  }
  let aborted = false;
  try { aborted = engine.abort?.(reason) === true; } catch { /* best-effort */ }
  if (!aborted) {
    try { engine.retireAsyncTasks?.(reason, { rescue }); } catch { /* best-effort */ }
  }

  // Identity guard: a stale promise may retire after a replacement Engine was
  // cached under the same key. Never delete the replacement or its config.
  if (vpEngines.get(key) === engine) {
    vpEngines.delete(key);
    vpEngineConfigKeys.delete(key);
  }
  for (const [taskId, ownerEngine] of asyncTaskOwners) {
    if (ownerEngine === engine) deleteAsyncTaskOwnerIfMatch(taskId, engine);
  }
  return engine;
}

/**
 * Build a coordinator for a freshly-constructed engine. The coordinator
 * keeps `asyncTaskOwners` in sync so a `taskManager` `completed` event
 * can find the engine that launched it in O(1).
 *
 * Defined as a factory (not a single shared object) so each engine's
 * `onRegister` callback closes over its own engine reference — sub-agents
 * inherit a coordinator that still associates their tasks with the
 * sub-engine, not the parent.
 *
 * @returns {{
 *   onRegister: (taskId: string, engine: import('./engine.js').Engine) => void,
 *   onUnregister: (taskId: string, engine: import('./engine.js').Engine) => void,
 *   onConsumed: (taskId: string, engine: import('./engine.js').Engine) => void,
 *   onUndelivered: (taskId: string, delivery: object, engine: import('./engine.js').Engine) => void,
 *   onDeferred: (taskId: string, engine: import('./engine.js').Engine) => void,
 * }}
 */
function buildAsyncTaskCoordinator() {
  const deleteOwnerIfMatch = (taskId, engine) => {
    if (typeof taskId !== 'string' || !taskId) return false;
    if (asyncTaskOwners.get(taskId) !== engine) return false;
    asyncTaskOwners.delete(taskId);
    return true;
  };
  return {
    onRegister(taskId, engine) {
      if (typeof taskId !== 'string' || !taskId) return;
      asyncTaskOwners.set(taskId, engine);
    },
    onUnregister(taskId, engine) {
      deleteOwnerIfMatch(taskId, engine);
    },
    onConsumed(taskId, engine) {
      deleteOwnerIfMatch(taskId, engine);
    },
    onUndelivered(taskId, delivery, engine) {
      if (!deleteOwnerIfMatch(taskId, engine)) return;
      scheduleTaskResultRescue({
        taskId,
        sessionId: delivery?.sessionId || engine?.sessionId || null,
        vpId: delivery?.vpId || engine?.vpId || null,
        threadId: delivery?.threadId || engine?.currentThreadId || 'main',
        content: delivery?.content,
        taskKind: delivery?.taskKind,
        taskStatus: delivery?.taskStatus,
      });
    },
    onDeferred(taskId, engine) {
      if (!engine?.ownsPendingAsyncTask?.(taskId)) return;
      if (!deleteOwnerIfMatch(taskId, engine)) return;
      const sessionId = engine?.sessionId || null;
      const task = sessionId && session?.taskManager?.getTask?.(sessionId, taskId);
      if (!task || !isTerminalTaskStatus(task.status)) return;
      scheduleTaskResultRescue({
        taskId,
        sessionId: task.sessionId || sessionId,
        vpId: task.ownerVpId || engine?.vpId || null,
        threadId: task.source?.threadId || task.runtime?.threadId || engine?.currentThreadId || 'main',
        content: formatTaskResultForVp(task),
        taskKind: task.kind,
        taskStatus: task.status,
      });
    },
  };
}
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
 *   - `invalidateGroupContext(sessionId)` — called from Session CRUD handlers
 *     that mutate roster / metadata / lifecycle state on disk (rename, update
 *     announcement, archive, delete, add/remove member, set default VP).
 *   - `handleYeaftSessionSend` — invalidates inline when its own auto-add /
 *     default-VP-heal pass mutated the roster.
 *   - `resetYeaftSession` and `__testResetVpState` clear the whole map.
 *
 * Model/config saves deliberately do not purge this map: they publish a new
 * in-memory runtime snapshot and the active engine adopts it at its next LLM
 * loop boundary without aborting the request already in flight.
 *
 * @type {Map<string, { coord: ReturnType<typeof createCoordinator>,
 *                     router: ReturnType<typeof createRouter>,
 *                     sessionHandle: object }>}
 */
const sessionContexts = new Map();
/** Latest server-authoritative Project identity and same-Agent siblings per Session. */
const projectContextBySession = new Map();

function normalizeProjectContext(value, sessionId) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.sessionIds)) return null;
  const currentSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  return {
    projectId: typeof value.projectId === 'string' && value.projectId.trim()
      ? value.projectId.trim()
      : null,
    projectName: typeof value.projectName === 'string' && value.projectName.trim()
      ? value.projectName.trim()
      : null,
    projectInstruction: typeof value.projectInstruction === 'string'
      ? value.projectInstruction.trim()
      : '',
    sessionIds: Array.from(new Set(value.sessionIds
      .filter(id => typeof id === 'string' && id.trim())
      .map(id => id.trim())
      .filter(id => id !== currentSessionId))),
  };
}

function legacyProjectContext(yeaftDir, sessionId) {
  const project = loadProjects(yeaftDir).find(row => row.sessionIds.includes(sessionId));
  if (!project) return null;
  return normalizeProjectContext({
    projectId: project.id,
    projectName: project.name,
    projectInstruction: project.instruction || '',
    sessionIds: project.sessionIds,
  }, sessionId);
}

function buildProjectSharedBlock(projectContext, summaries = '') {
  const context = normalizeProjectContext(projectContext, null);
  const body = typeof summaries === 'string' ? summaries.trim() : '';
  if (!context?.projectId && !body) return '';
  const lines = ['[Project Shared Context]'];
  if (context?.projectId) {
    const label = context.projectName
      ? `${context.projectName} (${context.projectId})`
      : context.projectId;
    lines.push(`Project: ${label}`);
    lines.push('Sharing boundary: sibling Sessions in this Project on this Agent only.');
  } else {
    lines.push('Sharing boundary: sibling Sessions in the same Project on this Agent only.');
  }
  lines.push('Read-only memory summaries preserve each source Session identity.');
  if (body) lines.push('', body);
  return lines.join('\n');
}

function vpKey(sessionId, vpId) {
  return `${sessionId}::${vpId}`;
}

function threadKey(sessionId, vpId, threadId) {
  return `${sessionId}::${vpId}::${threadId || 'main'}`;
}

function engineConfigKey(config) {
  return JSON.stringify({
    model: config?.model || '',
    primaryModel: config?.primaryModel || '',
    modelEffort: config?.modelEffort || '',
    fastModel: config?.fastModel || '',
    fastModelId: config?.fastModelId || '',
    fallbackModel: config?.fallbackModel || '',
    plugins: config?.plugins || {},
    providers: Array.isArray(config?.providers) ? config.providers : [],
  });
}

function effectiveRuntimeManagers(skillManager, mcpManager, _config = session?.config) {
  // Engine owns the final skill-policy wrapper so refreshConfig() can safely
  // reapply a changed Agent plugin selection without mutating shared managers.
  return {
    skillManager: skillManager || null,
    mcpManager: mcpManager || null,
  };
}

function normalizeSessionWorkDir(workDir) {
  return typeof workDir === 'string' && workDir.trim() ? workDir.trim() : '';
}

function projectRuntimeKey(workDir) {
  return normalizeSessionWorkDir(workDir) || '__agent_cwd__';
}

function createThreadId() {
  return `thr_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

const RUNNING_THREAD_STATES = new Set(['queued', 'typing', 'thinking', 'retrying', 'streaming', 'tool']);
/** @type {Map<string, Map<string, object>>} */
const vpThreads = new Map();
/** @type {Map<string, Set<Promise<string|null>>>} */
const routePromisesByMsgId = new Map();
/** @type {Map<string, { workDir: string, skillManager: import('./skills.js').SkillManager, mcpManager: import('./mcp.js').MCPManager, mcpStatus: object, configuredMcpConfig: object, effectiveMcpConfig: object, status: { skills: number, mcpServers: string[], mcpFailed: object[], mcpSkipped: object[], tools: number } }>} */
const projectRuntimes = new Map();
/** @type {Map<string, Promise<any>>} */
const baseRuntimeLoadPromises = new Map();
let baseRuntime = null;
let activeRuntimeKey = BASE_RUNTIME_KEY;
let skillReloadTimer = null;
let skillReloadRunning = false;
let skillReloadOwner = null;
let runtimeGeneration = 0;
/** @type {import('./session.js').Session | null} */
let runtimeOwnerSession = null;
const disconnectedRuntimeMcpManagers = new WeakSet();

let createRuntimeSkillManager = createSkillManager;
let createRuntimeMcpManager = () => new MCPManager();
let loadRuntimeMcpConfig = loadMCPConfig;
let loadRuntimeSession = loadSession;
const runtimeLoaderOwners = new WeakMap();

function loaderBelongsToOwner(promise, owner) {
  const tracked = promise ? runtimeLoaderOwners.get(promise) : null;
  return !!tracked
    && tracked.generation === owner?.generation
    && tracked.ownerSession === owner?.ownerSession;
}

function claimRuntimeOwnership(ownerSession) {
  if (!ownerSession) return null;
  runtimeOwnerSession = ownerSession;
  return { generation: runtimeGeneration, ownerSession };
}

function captureRuntimeOwner(ownerSession = session) {
  if (!ownerSession || ownerSession !== session || ownerSession !== runtimeOwnerSession) return null;
  return { generation: runtimeGeneration, ownerSession };
}

function isCurrentRuntimeOwner(owner) {
  return !!owner
    && owner.generation === runtimeGeneration
    && owner.ownerSession === runtimeOwnerSession
    && owner.ownerSession === session;
}

function invalidateRuntimeOwnership() {
  runtimeGeneration += 1;
  runtimeOwnerSession = null;
}

function runtimeBelongsToOwner(runtime, owner) {
  return isCurrentRuntimeOwner(owner)
    && runtime?.generation === owner.generation
    && runtime?.ownerSession === owner.ownerSession;
}

async function disconnectRuntimeMcpManager(mcpManager) {
  if (!mcpManager || typeof mcpManager.disconnectAll !== 'function') return;
  if (disconnectedRuntimeMcpManagers.has(mcpManager)) return;
  disconnectedRuntimeMcpManagers.add(mcpManager);
  try { await mcpManager.disconnectAll(); } catch { /* best-effort shutdown */ }
}

function replaceSessionMcpTools(owner, mcpManager) {
  if (!isCurrentRuntimeOwner(owner)) return { removed: 0, added: 0, skipped: true };
  const ownerSession = owner.ownerSession;
  if (!ownerSession.toolRegistry || typeof ownerSession.toolRegistry.replaceMcpTools !== 'function') {
    return { removed: 0, added: 0, skipped: true };
  }
  try {
    const result = ownerSession.toolRegistry.replaceMcpTools(mcpManager, buildMcpFlattenedTools);
    return { ...result, skipped: false };
  } catch (err) {
    console.warn('[Yeaft] hot-swap MCP tools failed:', err?.message || err);
    return { removed: 0, added: 0, skipped: true, error: err?.message || String(err) };
  }
}

function retargetVpEngines(owner, { skillManager, mcpManager }) {
  if (!isCurrentRuntimeOwner(owner)) return;
  try {
    owner.ownerSession.engine?.setRuntimeManagers?.({ skillManager, mcpManager });
  } catch { /* best-effort default-engine retarget */ }
  for (const eng of vpEngines.values()) {
    try {
      eng.setRuntimeManagers?.({ skillManager, mcpManager });
    } catch { /* best-effort runtime retarget */ }
  }
}

function reloadRuntimeSkillManager(owner, skillManager, status) {
  if (!isCurrentRuntimeOwner(owner) || typeof skillManager?.load !== 'function') {
    return { changed: false, loaded: 0, errors: [] };
  }
  let result;
  try {
    result = skillManager.load() || {};
  } catch (err) {
    result = { changed: false, loaded: 0, errors: [err?.message || String(err)] };
  }
  if (isCurrentRuntimeOwner(owner) && status) status.skills = skillManager.size || 0;
  return {
    changed: !!result.changed,
    loaded: Number(result.loaded) || 0,
    errors: result.errors || [],
  };
}

function activateBaseRuntime(owner = captureRuntimeOwner(), { reloadSkills = true } = {}) {
  if (!isCurrentRuntimeOwner(owner)) return { removed: 0, added: 0, skipped: true };
  const ownerSession = owner.ownerSession;
  const runtime = baseRuntime && runtimeBelongsToOwner(baseRuntime, owner) ? baseRuntime : null;
  const skillManager = runtime?.skillManager || ownerSession.skillManager;
  const mcpManager = runtime?.mcpManager || ownerSession.mcpManager;
  const status = ownerSession.status || runtime?.status;
  const switchingRuntime = activeRuntimeKey !== BASE_RUNTIME_KEY;
  const reload = reloadSkills && switchingRuntime
    ? reloadRuntimeSkillManager(owner, skillManager, status)
    : { changed: false, loaded: 0, errors: [] };
  if (!isCurrentRuntimeOwner(owner)) return { removed: 0, added: 0, skipped: true };
  activeRuntimeKey = BASE_RUNTIME_KEY;
  const swap = replaceSessionMcpTools(owner, mcpManager);
  retargetVpEngines(owner, effectiveRuntimeManagers(skillManager, mcpManager, ownerSession.config));
  if (status) {
    status.skills = skillManager?.size || 0;
    status.mcpServers = Array.isArray(status.mcpServers) ? status.mcpServers : [];
    status.mcpFailed = Array.isArray(status.mcpFailed) ? status.mcpFailed : [];
    status.tools = ownerSession.toolRegistry?.size || status.tools || 0;
  }
  if (!isCurrentRuntimeOwner(owner)) return { removed: 0, added: 0, skipped: true };
  broadcastSkillSlashCommands({ skillManager });
  if (switchingRuntime || reload.changed) {
    hydrateYeaftStatusFromSession({ ...ownerSession, status }, { reason: 'skills_runtime_activate', emitEvent: true });
  }
  startSkillHotReload(owner);
  return swap;
}

function activateProjectRuntime(runtime, owner = captureRuntimeOwner(), { reloadSkills = true } = {}) {
  if (!runtime) return activateBaseRuntime(owner, { reloadSkills });
  if (!runtimeBelongsToOwner(runtime, owner)) return { removed: 0, added: 0, skipped: true };
  const runtimeKey = projectRuntimeKey(runtime.workDir);
  const switchingRuntime = activeRuntimeKey !== runtimeKey;
  const reload = reloadSkills && switchingRuntime
    ? reloadRuntimeSkillManager(owner, runtime.skillManager, runtime.status)
    : { changed: false, loaded: 0, errors: [] };
  if (!runtimeBelongsToOwner(runtime, owner)) return { removed: 0, added: 0, skipped: true };
  activeRuntimeKey = runtimeKey;
  const swap = replaceSessionMcpTools(owner, runtime.mcpManager);
  retargetVpEngines(owner, effectiveRuntimeManagers(
    runtime.skillManager,
    runtime.mcpManager,
    owner.ownerSession.config,
  ));
  runtime.status = {
    ...runtime.status,
    skills: runtime.skillManager?.size || 0,
    tools: owner.ownerSession.toolRegistry?.size || runtime.status?.tools || 0,
  };
  if (!runtimeBelongsToOwner(runtime, owner)) return { removed: 0, added: 0, skipped: true };
  // A project manager already contains bundled, user, and project tiers.
  broadcastSkillSlashCommands({ skillManager: runtime.skillManager });
  if (switchingRuntime || reload.changed) {
    const status = mergedStatusForProjectRuntime(runtime, owner.ownerSession);
    hydrateYeaftStatusFromSession({ ...owner.ownerSession, status }, { reason: 'skills_runtime_activate', emitEvent: true });
  }
  startSkillHotReload(owner);
  return swap;
}

async function shutdownProjectRuntimes() {
  // Invalidate before the first await so every old continuation is cleanup-only.
  invalidateRuntimeOwnership();
  stopSkillHotReload();
  const runtimes = [baseRuntime, ...projectRuntimes.values()].filter(Boolean);
  const loaderPromises = [
    ...baseRuntimeLoadPromises.values(),
    ...projectRuntimeLoadPromises.values(),
  ];
  for (const runtime of runtimes) {
    if (runtime?.previousSkillManager && runtime.ownerSession?.skillManager === runtime.skillManager) {
      runtime.ownerSession.skillManager = runtime.previousSkillManager;
    }
    if (runtime?.previousMcpManager && runtime.ownerSession?.mcpManager === runtime.mcpManager) {
      runtime.ownerSession.mcpManager = runtime.previousMcpManager;
    }
  }
  baseRuntime = null;
  projectRuntimes.clear();
  projectRuntimeLoadPromises.clear();
  baseRuntimeLoadPromises.clear();
  activeRuntimeKey = BASE_RUNTIME_KEY;
  const disconnects = runtimes
    // A loading manager may acquire its first connection after an early
    // disconnect; the stale loader performs the reliable post-connect cleanup.
    .filter(runtime => !runtime?.loading)
    .map(runtime => disconnectRuntimeMcpManager(runtime?.mcpManager));
  await Promise.allSettled([...disconnects, ...loaderPromises]);
}

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
  promise.finally(() => {
    set.delete(promise);
    if (set.size === 0 && routePromisesByMsgId.get(msgId) === set) {
      routePromisesByMsgId.delete(msgId);
    }
  }).catch(() => {});
}


function buildVpPromptPayload(vpId, envelope) {
  const text = envelope?.msg?.text || '';
  const inboundSuffix = `${envelope?._promptSuffix || ''}${sessionMessageQuotePrompt(envelope?.msg?.meta?.quote)}`;
  const inboundParts = Array.isArray(envelope?._promptParts) ? envelope._promptParts : [];
  const prompt = `@vp-${vpId} ${text}${inboundSuffix}`;
  const promptParts = inboundParts.length > 0
    ? [...inboundParts, { type: 'text', text: prompt }]
    : null;
  return { text, prompt, promptParts };
}

function buildPendingRescueEnvelope({ sessionId, taskId = null, threadId = 'main', followUpId, leftover, replayText, replayParts = null }) {
  const leftoverIsInternal = Boolean(leftover?.internal);
  const leftoverInjectedBy = leftoverIsInternal && typeof leftover?.injectedBy === 'string'
    ? leftover.injectedBy
    : null;
  return {
    sessionId,
    taskId,
    trigger: 'pending_rescue',
    msg: {
      id: followUpId,
      from: leftoverIsInternal && leftover.senderVpId ? leftover.senderVpId : 'user',
      role: leftoverIsInternal ? 'assistant' : 'user',
      text: replayText,
      meta: {
        rescuedFrom: 'pendingQueries',
        threadId,
        ...(leftoverInjectedBy ? { injectedBy: leftoverInjectedBy } : {}),
        ...(leftoverIsInternal && leftover.senderVpId ? { senderVpId: leftover.senderVpId } : {}),
        ...(leftoverIsInternal && leftover.sourceThreadId ? { sourceThreadId: leftover.sourceThreadId } : {}),
      },
    },
    ...(Array.isArray(replayParts) && replayParts.length > 0 ? { _promptParts: replayParts } : {}),
  };
}

export function visibleInboundThreadId(envelope, fallbackThreadId = 'main') {
  const meta = envelope?.msg?.meta || {};
  if (
    (meta.injectedBy === 'route_forward' || meta.injectedBy === 'task_result')
    && typeof meta.sourceThreadId === 'string'
    && meta.sourceThreadId.trim()
  ) {
    return meta.sourceThreadId.trim();
  }
  return fallbackThreadId || 'main';
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
    const vp = readConfiguredVp(vpId);
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
 * Drop the cached coordinator + router for a Session. Metadata changes must
 * not abort in-flight work: a rename, announcement sync, or default-VP update
 * can race any provider request, and the running coordinator already owns a
 * consistent snapshot for that turn. Future turns rebuild from disk.
 *
 * Destructive lifecycle operations opt into runtime teardown.
 *
 * Idempotent — safe to call when no entry exists.
 */
function invalidateGroupContext(sessionId, { abortRuntime = false } = {}) {
  if (!sessionId) return;
  sessionContexts.delete(sessionId);
  if (!abortRuntime) return;
  const prefix = `${sessionId}::`;
  for (const [k, ctrl] of vpAborts) {
    if (!k.startsWith(prefix)) continue;
    try { if (!ctrl.signal.aborted) ctrl.abort(); } catch { /* best-effort */ }
    vpAborts.delete(k);
  }
  for (const [turnId, meta] of Array.from(turnAbortMeta.entries())) {
    if (meta?.sessionId !== sessionId) continue;
    revokeTurnRepoApproval(turnId);
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
  // deleted/archived group doesn't pin a stale checklist forever.
  for (const k of vpCurrentTodos.keys()) {
    if (k.startsWith(prefix)) vpCurrentTodos.delete(k);
  }
  // Engines are NOT torn down here on purpose. They hold subordinate
  // state (AMS adjustments) that should survive a meta change and a
  // closed sessionHandle — they don't reach the on-disk group meta
  // directly. Project runtime managers are hot-swapped before each turn.
  // They *are* dropped on `resetYeaftSession`.
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
  applyLiveLanguage(language);
}

/** Query timeout in ms — abort if LLM doesn't respond within this window */
const QUERY_TIMEOUT_MS = 120_000;
const HIGH_REASONING_QUERY_TIMEOUT_MS = 300_000;
/** AskUser is human-paced but must never pin a VP turn forever. */
const ASK_USER_TIMEOUT_MS = 10 * 60_000;

function isHighReasoningEffort(effort) {
  const value = typeof effort === 'string' ? effort.trim().toLowerCase() : '';
  return value === 'high' || value === 'xhigh' || value === 'max' || value === 'ultra';
}

function queryTimeoutMsForSessionConfig(config = null) {
  return isHighReasoningEffort(config?.modelEffort) ? HIGH_REASONING_QUERY_TIMEOUT_MS : QUERY_TIMEOUT_MS;
}

function queryTimeoutMsForSession(sessionId = null) {
  if (!sessionId || !session) return queryTimeoutMsForSessionConfig(session?.config);
  try {
    return queryTimeoutMsForSessionConfig(resolveLiveSessionConfig(session.config, sessionId));
  } catch {
    return queryTimeoutMsForSessionConfig(session?.config);
  }
}

/**
 * Secondary watchdog grace period (ms).
 *
 * After the active provider timeout of silence the per-VP `vpAbort` is fired.
 * Normal turns use {@link QUERY_TIMEOUT_MS}; high-reasoning session turns use
 * {@link HIGH_REASONING_QUERY_TIMEOUT_MS}. Tool execution and declared retry /
 * async-task waits pause this watchdog because those phases own separate,
 * explicit deadlines. Treating a long tool as silent provider work races the
 * tool's own timeout and can abort the whole query before its error result is
 * returned to the model.
 *
 * If an adapter ignores `signal`, runVpTurn still cannot return after the
 * abort. The per-tool timeout in
 * {@link import('./tools/registry.js').DEFAULT_TOOL_TIMEOUT_MS} independently
 * protects tool execution; this bridge-level escalation covers the adapter
 * and any other path that ignores the query abort.
 * Without a second-stage escalation the typing dots hang forever —
 * exactly the "halts mid-execution with no turn_end" symptom.
 *
 * The driver starts this grace-window timer only after `vpAbort.signal`
 * fires. Starting it when the turn is enqueued would turn the activity-based
 * silence watchdog into a hard total-duration limit and kill healthy turns
 * that keep producing LLM/tool events for several minutes.
 *
 * If runVpTurn still does not return within the grace period after abort,
 * the driver emits a synthetic `result{stopped:true}`, closes the visible
 * turn, and moves on. The hung tool promise remains observed in the
 * background because JavaScript promises have no forced cancellation.
 *
 * 15s is wide enough that legitimate "abort took a moment to propagate"
 * paths (network teardown, finally cleanup) finish first; tight enough
 * that a truly stuck tool doesn't stretch the user-visible stall to
 * minutes.
 */
const ESCALATE_AFTER_ABORT_MS = 15_000;

/** Virtual conversationId for the Yeaft session */
let yeaftConversationId = null;

function createYeaftConversationId() {
  return `yeaft-${randomUUID()}`;
}

/** Last agent-level Yeaft slash command payload. Replayed after the web side
 *  creates/replaces the virtual Yeaft conversation id so `/` autocomplete never
 *  falls back to built-ins while full Session metadata is still loading. */
let lastYeaftSlashCommandSnapshot = null;
/** @type {Map<string, Promise<any>>} */
const projectRuntimeLoadPromises = new Map();

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
 * Post-refactor: each Session context owns its own bounded `history` cache,
 * lazily hydrated from `conversationStore.loadRecentBySession(sessionId)` on
 * first access. Group-A and group-B are isolated; the durable transcript is
 * never replaced by the cache trim.
 *
 * @typedef {Array<{role:'user'|'assistant'|'tool', content:string|Array, toolCalls?:Array, thinkingBlocks?:Array, toolCallId?:string, isError?:boolean}>} GroupHistory
 */

/**
 * @typedef {Object} GroupContextEntry
 * @property {object|null} coord — group coordinator (lazily built by getOrCreateSessionContext)
 * @property {object|null} router — message router (lazily built by getOrCreateSessionContext)
 * @property {object|null} sessionHandle — opened group handle (lazily built by getOrCreateSessionContext)
 * @property {GroupHistory} history — per-Session bounded runtime history cache
 * @property {boolean} historyHydrated — true once history has been loaded
 *   from disk (or explicitly assigned). The flag is required because an
 *   empty array is legitimate post-clear state and
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
  return isHiddenConversationRow(m);
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
function projectPersistedToHistoryEntry(m, { includeReflections = false } = {}) {
  if (!m) return null;
  if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'tool') return null;
  if (isPersistedInternalMessage(m) && !(includeReflections && m._reflection === true)) return null;
  const entry = { role: m.role, content: m.role === 'tool' ? m.content : __testNormalizePersistedVisibleContent(m.content) };
  if (m.id) {
    entry.id = m.id;
    entry._persistedMessageId = m.id;
  }
  entry.threadId = m.threadId || m.turnId || 'main';
  if (m.turnId) entry.turnId = m.turnId;
  if (m.imageAssetAnchor) entry.imageAssetAnchor = true;
  if (m.responseKind === 'progress' || m.responseKind === 'result') entry.responseKind = m.responseKind;
  if (Number.isInteger(m.llmCallCount) && m.llmCallCount > 0) entry.llmCallCount = m.llmCallCount;
  if (m.incomplete === true) entry.incomplete = true;
  if (typeof m.stopReason === 'string' && m.stopReason) entry.stopReason = m.stopReason;
  if (m.sessionId) entry.sessionId = m.sessionId;
  if (m.clientMessageId) entry.clientMessageId = m.clientMessageId;
  if (m.speakerVpId) entry.speakerVpId = m.speakerVpId;
  if (m.toolCallId) entry.toolCallId = m.toolCallId;
  if (Array.isArray(m.askUserResults) && m.askUserResults.length > 0) {
    entry.askUserResults = m.askUserResults;
  }
  if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
    entry.toolCalls = m.toolCalls.map(tc => ({
      id: tc.id,
      name: tc.name,
      input: tc.input,
    }));
  }
  // Anthropic thinking blocks carry provider-signed replay state. The durable
  // parser already validates them; preserve the complete payload + signature
  // in the runtime history owner so a restart does not create a tool arc with
  // its required thinking prefix missing. `filterSnapshotForVp` strips these
  // blocks from other VPs before any provider request.
  if (Array.isArray(m.thinkingBlocks) && m.thinkingBlocks.length > 0) {
    const thinkingBlocks = m.thinkingBlocks
      .filter(tb => tb
        && typeof tb.signature === 'string'
        && tb.signature
        && (tb.redacted === true
          ? typeof tb.data === 'string'
          : typeof tb.thinking === 'string'))
      .map(tb => tb.redacted === true
        ? { redacted: true, data: tb.data, signature: tb.signature }
        : { thinking: tb.thinking, signature: tb.signature });
    if (thinkingBlocks.length > 0) entry.thinkingBlocks = thinkingBlocks;
  }
  if (m.isError) entry.isError = true;
  if (m.ts) entry.ts = m.ts;
  else if (m.time) entry.ts = m.time;
  if (Array.isArray(m.images) && m.images.length > 0) entry.images = m.images;
  if (Array.isArray(m.attachments) && m.attachments.length > 0) entry.attachments = m.attachments;
  if (m.quote && typeof m.quote === 'object') entry.quote = m.quote;
  if (Array.isArray(m.todos)) entry.todos = m.todos;
  if ((entry.role === 'user' || entry.role === 'assistant') && !entry.content && !entry.attachments && !entry.images && !entry.toolCalls && !entry.thinkingBlocks && !entry.todos && !entry.askUserResults) return null;
  return entry;
}

function projectPersistedToVisibleHistoryEntry(m) {
  if (!isVisibleConversationRow(m)) return null;
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

function loadVisibleGroupHistoryPage(store, sessionId, limit, beforeSeq = null, opts = {}) {
  if (!store || !sessionId || !(limit > 0)) return { messages: [], oldestSeq: null, hasMore: false };

  let rows = [];
  try {
    if (typeof store.loadVisibleBySession === 'function') {
      const page = store.loadVisibleBySession(sessionId, beforeSeq, limit, opts);
      return {
        messages: (page.messages || []).map(projectPersistedToVisibleHistoryEntry).filter(Boolean),
        oldestSeq: (typeof page.oldestSeq === 'number') ? page.oldestSeq : null,
        nextBeforeSeq: (typeof page.nextBeforeSeq === 'number') ? page.nextBeforeSeq : null,
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

  const visible = projectVisibleSessionMessages(rows)
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
    nextBeforeSeq: Number.isFinite(oldestSeq) ? oldestSeq : null,
    hasMore,
  };
}

function ensureYeaftConversationId() {
  if (!yeaftConversationId) {
    yeaftConversationId = createYeaftConversationId();
    replayCachedSkillSlashCommandsToYeaftConversation();
  }
  return yeaftConversationId;
}

function projectVisibleHistoryChunkMessages(messages = []) {
  return projectVisibleSessionMessages(messages)
    .map(projectPersistedToVisibleHistoryEntry)
    .filter(Boolean)
    .map(m => ({
      ...(m.id ? { id: m.id } : {}),
      ...(Number.isFinite(m.seq) ? { seq: m.seq } : {}),
      role: m.role,
      content: m.content,
      ts: m.ts || null,
      sessionId: m.sessionId || null,
      ...(m.clientMessageId ? { clientMessageId: m.clientMessageId } : {}),
      threadId: m.threadId || m.turnId || 'main',
      ...(m.turnId ? { turnId: m.turnId } : {}),
      ...(m.imageAssetAnchor === true ? { imageAssetAnchor: true } : {}),
      ...(Array.isArray(m.attachments) && m.attachments.length > 0 ? { attachments: hydrateHistoryAttachmentPreviews(m.attachments) } : {}),
      ...(m.quote ? { quote: m.quote } : {}),
      ...(Array.isArray(m.images) && m.images.length > 0 ? { images: m.images } : {}),
      ...(m.speakerVpId ? { speakerVpId: m.speakerVpId } : {}),
      ...(m.responseKind === 'progress' || m.responseKind === 'result' ? { responseKind: m.responseKind } : {}),
      ...(Number.isInteger(m.llmCallCount) && m.llmCallCount > 0 ? { llmCallCount: m.llmCallCount } : {}),
      ...(m.incomplete === true ? { incomplete: true } : {}),
      ...(typeof m.stopReason === 'string' && m.stopReason ? { stopReason: m.stopReason } : {}),
      ...(Array.isArray(m.todos) ? { todos: m.todos } : {}),
      ...(Array.isArray(m.askUserResults) && m.askUserResults.length > 0 ? { askUserResults: m.askUserResults } : {}),
      ...(Array.isArray(m.toolCalls) && m.toolCalls.length > 0 ? { toolCalls: m.toolCalls } : {}),
    }));
}

function emitHistoryChunk({ sessionId, messages, mode = 'older', oldestSeq = null, nextBeforeSeq = null, hasMore = false, latestSeq = null, afterSeq = null, hasMoreAfter = false, streamId = null, revision = null, turns = null, pageKind = null, gapStopAtSeq = null, cacheEpoch = null, requestId = null, requestClientId = null, perfTraceId = null }) {
  const projectedMessages = projectVisibleHistoryChunkMessages(messages);
  // Empty deltas still carry the authoritative safe cursor and clear the
  // browser's syncingAfterSeq fence. Dropping this envelope leaves Session
  // switching stuck after hidden-only or pair-unsafe rows.
  sendToServer({
    type: 'yeaft_history_chunk',
    conversationId: yeaftConversationId,
    ...(perfTraceId ? { perfTraceId } : {}),
    ...(requestId ? { requestId } : {}),
    ...(requestClientId ? { _requestClientId: requestClientId } : {}),
    sessionId,
    mode,
    messages: projectedMessages,
    oldestSeq,
    nextBeforeSeq: Number.isFinite(nextBeforeSeq) ? nextBeforeSeq : oldestSeq,
    hasMore: !!hasMore,
    latestSeq,
    afterSeq,
    hasMoreAfter: !!hasMoreAfter,
    streamId,
    revision,
    turns,
    ...(pageKind ? { pageKind } : {}),
    ...(Number.isFinite(gapStopAtSeq) ? { gapStopAtSeq } : {}),
    ...(Number.isFinite(cacheEpoch) ? { cacheEpoch } : {}),
  });
  return projectedMessages;
}

function emitLegacyHistoryOutputFrames(replayEntries) {
  for (const entry of replayEntries) {
    if (entry.role === 'user') {
      sendSessionOutputFrame({
        type: 'user',
        message: {
          content: entry.content,
          id: entry.id || null,
          ...(Array.isArray(entry.attachments) && entry.attachments.length > 0 ? { attachments: hydrateHistoryAttachmentPreviews(entry.attachments) } : {}),
          ...(entry.quote ? { quote: entry.quote } : {}),
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
      sendSessionOutputFrame({
        type: 'assistant',
        message: {
          id: entry.id || null,
          content: [
            ...(entry.content ? [{ type: 'text', text: entry.content }] : []),
            ...((entry.toolCalls || []).map(toolCall => ({ type: 'tool_use', ...toolCall, history: true }))),
            ...((entry.images || []).map(image => ({ type: 'image_asset', image }))),
          ],
        },
        ts: entry.ts || null,
      }, envelopeOpts);
      sendSessionOutputFrame({ type: 'result', result_text: '' }, envelopeOpts);
    }
  }
}

function emitVisibleHistoryReplay({ store, sessionId, limit, beforeSeq = null, mode = 'recent', requestId = null, requestClientId = null, perfTraceId = null }) {
  const historyMetadata = sessionId && typeof store.getSessionHistoryMetadata === 'function'
    ? store.getSessionHistoryMetadata(sessionId)
    : null;
  const visiblePage = sessionId
    ? loadVisibleGroupHistoryPage(store, sessionId, limit, beforeSeq)
    : { messages: limit > 0 ? (store.loadRecent?.(limit) || []) : [], oldestSeq: null, hasMore: false };
  const replayEntries = sessionId
    ? visiblePage.messages
    : visiblePage.messages
      .map(projectPersistedToVisibleHistoryEntry)
      .filter(Boolean);

  if (sessionId) {
    const latestSeq = replayEntries.length
      ? parseSeqFromId(replayEntries[replayEntries.length - 1]?.id)
      : null;
    emitHistoryChunk({
      sessionId,
      messages: replayEntries,
      mode,
      oldestSeq: visiblePage.oldestSeq,
      nextBeforeSeq: visiblePage.nextBeforeSeq,
      hasMore: visiblePage.hasMore,
      latestSeq: Number.isFinite(latestSeq) ? latestSeq : null,
      streamId: historyMetadata?.streamId || null,
      revision: historyMetadata?.revision ?? null,
      turns: limit,
      requestId,
      requestClientId,
      perfTraceId,
    });
    sendSessionEvent({
      type: 'history_loaded',
      mode,
      count: replayEntries.length,
      sessionId,
      requestId,
      hasMore: visiblePage.hasMore,
      oldestSeq: visiblePage.oldestSeq,
      nextBeforeSeq: visiblePage.nextBeforeSeq,
      latestSeq: Number.isFinite(latestSeq) ? latestSeq : null,
    }, { sessionId, requestId, requestClientId, perfTraceId });
    return;
  }

  emitLegacyHistoryOutputFrames(replayEntries);

  const latestSeq = replayEntries.length
    ? parseSeqFromId(replayEntries[replayEntries.length - 1]?.id)
    : null;
  sendSessionEvent({
    type: 'history_loaded',
    mode,
    count: replayEntries.length,
    sessionId,
    requestId,
    hasMore: visiblePage.hasMore,
    oldestSeq: visiblePage.oldestSeq,
    latestSeq: Number.isFinite(latestSeq) ? latestSeq : null,
  }, { sessionId, requestId, requestClientId, perfTraceId });
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
    recent = session.conversationStore.loadRecentBySession(
      sessionId,
      undefined,
      { includeReflections: true },
    );
  } catch (err) {
    console.warn('[Yeaft] hydrateGroupHistory failed (sessionId=%s):', sessionId, err?.message || err);
    return [];
  }
  const out = [];
  for (const m of recent || []) {
    const entry = projectPersistedToHistoryEntry(m, { includeReflections: true });
    if (entry) out.push(entry);
  }
  return out;
}

function boundRuntimeSessionHistory(history) {
  return trimHistoryCacheForRuntime(history, {
    language: session?.config?.language,
  });
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
 * lifecycle, so consumers can mutate-in-place. Reassigned by session
 * hydration/reset paths when the canonical array must be replaced.
 *
 * @param {string} sessionId
 * @returns {GroupHistory}
 */
function getOrCreateSessionHistory(sessionId) {
  if (!sessionId) return [];
  let entry = sessionContexts.get(sessionId);
  // Use `historyHydrated` rather than truthiness on `history` itself —
  // an empty array (post-clear or a partial entry
  // seeded by an early `getOrCreateSessionContext` call before data was
  // loaded) is legitimate state that does NOT mean "needs hydration"...
  // unless we never loaded from disk in the first place. The flag
  // separates the two cases.
  if (entry && entry.historyHydrated) return entry.history;
  if (!entry) {
    entry = makeGroupContextStub();
    sessionContexts.set(sessionId, entry);
  }
  entry.history = boundRuntimeSessionHistory(hydrateGroupHistory(sessionId));
  entry.historyHydrated = true;
  return entry.history;
}

/**
 * Reassign a group's history reference. Used by session reset and clear
 * paths that need to swap the array (not just mutate it). Returns
 * the new reference. Idempotent if the entry doesn't exist (creates one).
 *
 * Sets `historyHydrated = true` because an explicit assignment is itself
 * a hydration — even setting `[]` after clear means "this is the canonical
 * state right now, don't re-load from disk".
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
  entry.history = boundRuntimeSessionHistory(Array.isArray(next) ? next : []);
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

export function __testResolveVpEffectiveConfig(sessionId) {
  if (!session) return null;
  return resolveLiveSessionConfig(session.config, sessionId);
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
  invalidateRuntimeOwnership();
  stopSkillHotReload();
  session = sessionLike;
  sessionLoadPromise = null;
  if (sessionLike) claimRuntimeOwnership(sessionLike);
  else yeaftConversationId = null;
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

/** Test-only: retire one cached VP Engine through the production helper. */
export function __testRetireVpEngine({
  sessionId,
  vpId,
  threadId = 'main',
  reason = 'test_retire',
  rescue = true,
  expectedEngine = null,
}) {
  return retireCachedVpEngine(threadKey(sessionId, vpId, threadId), {
    reason,
    rescue,
    expectedEngine,
  });
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

/** Test-only: attach an Engine-like wake target to a seeded VP thread. */
export function __testSetVpThreadEngine({ sessionId, vpId, threadId, engine }) {
  const thread = getOrCreateVpThread({ sessionId, vpId, threadId });
  thread.engine = engine || null;
}

/** Test-only: seed a VP thread without starting its engine driver. */
export function __testSeedVpThread({ sessionId, vpId, threadId, title = 'test thread', status = 'queued' }) {
  const thread = getOrCreateVpThread({ sessionId, vpId, threadId, title });
  thread.status = status;
  return thread.threadId;
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
 * `#abortReason`, `#adjustRanBySession`, `#execLog`) doesn't collide when
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
  if (!session) throw new Error('getOrCreateVpEngine: session not loaded');
  // Per-session config overlay (v1: model only). Falls back to the
  // session's user-level config when no override is set. Session config is
  // always resolved from the agent-local root; project `.yeaft` is ignored.
  // Agent-level plugin config is already part of session.config; Session
  // config still only overlays model/effort. Keep the runtime policy Agent
  // scoped even though each VP Engine has its own effective config snapshot.
  const effectiveConfig = resolveLiveSessionConfig(session.config, sessionId);
  const configKey = engineConfigKey(effectiveConfig);
  let eng = vpEngines.get(key);
  if (eng) {
    // Config changes are snapshots, not a lifecycle boundary. The save handler
    // publishes the snapshot to every cached engine. The next query loop reads
    // it before invoking its adapter; no engine replacement or abort needed.
    if (vpEngineConfigKeys.get(key) !== configKey) {
      eng.refreshConfig?.(effectiveConfig);
      vpEngineConfigKeys.set(key, configKey);
    }
    return eng;
  }
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
    managedCliReady: session.managedCliReady || null,
    // Share the session-shared ToolUsageStats so per-VP tool calls land
    // in the same on-disk snapshot the `yeaft_fetch_tool_stats` handler
    // reads. Without this, engine's record-on-tool-exec guard
    // (`if (this.#toolStats && ...)`) is false and group VP tool calls
    // are silently dropped.
    toolStats: session.toolStats || null,
    taskManager: session.taskManager || null,
    // Per-VP fan-out: bind the engine to its (sessionId, vpId) for scoped
    // history, memory, and tool ownership.
    sessionId,
    vpId,
  });
  // Install the async-task coordinator so result-producing child tasks
  // register against the shared owner map. Persistent shell tasks are
  // status-only and never enter this ownership path.
  try {
    if (typeof eng.setAsyncTaskCoordinator === 'function') {
      eng.setAsyncTaskCoordinator(buildAsyncTaskCoordinator());
    }
  } catch { /* coordinator is best-effort plumbing, never block engine creation */ }
  vpEngines.set(key, eng);
  vpEngineConfigKeys.set(key, configKey);
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
  if (entry && entry.coord && entry.router) {
    if (sessionHandle && sessionHandle !== entry.sessionHandle) {
      try { sessionHandle.close?.(); } catch { /* best-effort unused handle cleanup */ }
    }
    return entry;
  }
  // Either no entry, or a partial entry seeded by `getOrCreateSessionHistory`
  // (no coord/router yet). Build the coord/router and merge into the
  // existing record so the per-group history reference and hydration
  // flag are preserved.
  const coord = createCoordinator(sessionHandle, {
    deliver: (vpId, envelope) => enqueueForVp(sessionId, vpId, envelope),
  });
  const router = createRouter({
    coordinator: coord,
  });
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
    entry.history = boundRuntimeSessionHistory(hydrateGroupHistory(sessionId));
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
  const perfTraceId = envelope?._perfTraceId || envelope?.perfTraceId || null;
  if (perfTraceId) {
    recordAgentPerfTrace(ctx.CONFIG, {
      traceId: perfTraceId,
      phase: 'vp.enqueue',
      sessionId,
      vpId,
      turnId: envelope?.msg?.id || null,
      messageType: envelope?.trigger || 'user',
    });
  }
  const routePromise = routeEnvelopeToVpThread(sessionId, vpId, envelope);
  registerRoutePromise(envelope?.msg?.id, routePromise);
}

function scheduleTaskResultRescue({ taskId, sessionId, vpId, threadId = 'main', content, taskKind, taskStatus }) {
  if (!sessionId || !vpId || !taskId) return false;
  const text = typeof content === 'string'
    ? content
    : (() => { try { return JSON.stringify(content); } catch { return String(content); } })();
  if (!text.trim()) return false;
  const msgId = `task_result_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  queueMicrotask(() => {
    enqueueForVp(sessionId, vpId, {
      sessionId,
      taskId,
      trigger: 'task_result',
      _promptSuffix: '',
      msg: {
        id: msgId,
        from: 'tool',
        role: 'assistant',
        text,
        meta: {
          injectedBy: 'task_result',
          taskId,
          taskKind,
          taskStatus,
          sourceThreadId: threadId,
        },
      },
    });
  });
  return true;
}

function scheduleTaskResultReentry(event) {
  if (!event || event.event !== 'completed' || !event.task) return;
  const task = event.task;
  if (taskResultDeliveryFor(task) !== TASK_RESULT_DELIVERY.MODEL_REENTRY) return;
  const sessionId = task.sessionId || event.sessionId || null;
  const vpId = task.ownerVpId || null;
  if (!sessionId || !vpId) return;
  const threadId = task.source?.threadId || task.runtime?.threadId || 'main';
  const formatted = formatTaskResultForVp(task);

  // Same-turn fast path: when the engine that launched this task is
  // still running its query() AND has parked on the wait queue, hand
  // the result straight in — it splices into the very next adapter
  // loop with no new turn / new VP envelope. Falls through to the
  // legacy "open a new turn" rescue path when:
  //   - the engine already finished (typical orphan / late completion),
  //   - the engine was torn down between register and complete, or
  //   - the task wasn't registered with the engine in the first place
  //     (e.g. legacy `taskManager.startTask` callers that bypass tools).
  const ownerEngine = asyncTaskOwners.get(task.id);
  if (ownerEngine
      && typeof ownerEngine.ownsPendingAsyncTask === 'function'
      && ownerEngine.ownsPendingAsyncTask(task.id)
      && typeof ownerEngine.notifyAsyncTaskCompleted === 'function') {
    try {
      const accepted = ownerEngine.notifyAsyncTaskCompleted(task.id, formatted, {
        preview: `task ${task.kind || 'tool'} ${task.status}`,
        sessionId,
        vpId,
        threadId,
        taskKind: task.kind,
        taskStatus: task.status,
      });
      if (accepted) return;
    } catch {
      // Same-turn delivery is best-effort. Fall through to the legacy
      // rescue path so we never drop a terminal event on the floor.
    }
  }

  scheduleTaskResultRescue({
    taskId: task.id,
    sessionId,
    vpId,
    threadId,
    content: formatted,
    taskKind: task.kind,
    taskStatus: task.status,
  });
}

async function routeEnvelopeToVpThread(sessionId, vpId, envelope) {
  const routeStart = perfNowMs();
  const { text, prompt, promptParts } = buildVpPromptPayload(vpId, envelope);
  const runningThreads = getRunningThreads(sessionId, vpId);
  let thread = null;
  let related = false;

  const meta = envelope?.msg?.meta || {};
  const repoApproval = envelope?._repoApproval;
  const hasRepoApproval = isRepoApprovalCapability(repoApproval);
  if (envelope?.msg?.role === 'user' || envelope?.msg?.from === 'user') {
    revokeRepoApprovalsForRecipient(sessionId, vpId);
  }
  const isTaskResult = meta.injectedBy === 'task_result';
  const sourceThreadId = typeof meta.sourceThreadId === 'string' && meta.sourceThreadId.trim()
    ? meta.sourceThreadId.trim()
    : null;

  if (hasRepoApproval) {
    // Approval is an execution capability, not text. It must never collapse
    // into a related thread's pendingQueries/rescue path.
    thread = getOrCreateVpThread({ sessionId, vpId, title: fallbackTitle(text) });
  } else if (isTaskResult && sourceThreadId) {
    thread = getOrCreateVpThread({ sessionId, vpId, threadId: sourceThreadId, title: fallbackTitle(text) });
  } else if (runningThreads.length === 0) {
    thread = getOrCreateVpThread({ sessionId, vpId, title: fallbackTitle(text) });
  } else {
    let decision = null;
    try {
      decision = await threadClassifier({
        adapter: session?.adapter,
        model: session?.config?.fastModel || session?.config?.model,
        vp: readVpForClassifier(vpId),
        runningThreads: runningThreads.map(threadSnapshotForClassifier),
        newQuery: text,
      });
    } catch (err) {
      // Classification is an optimisation, not a delivery boundary. The user
      // message is already durable at this point; dropping the rejected route
      // promise would leave it visible in history without ever starting a turn.
      console.warn('[Yeaft] VP thread classification failed; starting a new thread:', err?.message || err);
    }
    const targetIsRunning = decision
      ? runningThreads.some((t) => t.threadId === decision.targetThreadId)
      : false;
    if (decision?.decision === 'related' && decision.targetThreadId && targetIsRunning) {
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
        title: decision?.title || fallbackTitle(text),
      });
    }
  }

  if (!thread) return null;
  rememberThreadMessage(thread, envelope?.msg);
  const turnId = `${randomUUID().slice(0, 8)}:${vpId}`;
  if (hasRepoApproval) {
    if (!bindRepoApprovalCapability(repoApproval, { sessionId, recipientVpId: vpId, turnId })) {
      return null;
    }
    turnRepoApprovals.set(turnId, { capability: repoApproval, sessionId, vpId });
  }
  const perfTraceId = envelope?._perfTraceId || envelope?.perfTraceId || null;
  if (perfTraceId) {
    recordAgentPerfTrace(ctx.CONFIG, {
      traceId: perfTraceId,
      phase: 'vp.route_thread',
      durationMs: perfNowMs() - routeStart,
      sessionId,
      vpId,
      turnId,
      threadId: thread.threadId,
      detail: { related, runningThreadCount: runningThreads.length },
    });
  }

  if (related) {
    const content = promptParts || prompt;
    const injectedBy = envelope?.msg?.meta?.injectedBy;
    const isInternalAppend = injectedBy === 'route_forward' || injectedBy === 'task_result';
    thread.pendingQueries.push({
      content,
      preview: prompt,
      originalText: text,
      originalParts: Array.isArray(envelope?._promptParts) ? envelope._promptParts : null,
      internal: isInternalAppend,
      injectedBy: isInternalAppend ? injectedBy : null,
      senderVpId: isInternalAppend ? (envelope?.msg?.meta?.senderVpId || envelope?.msg?.from || null) : null,
      sourceThreadId: isInternalAppend ? visibleInboundThreadId(envelope, thread.threadId) : null,
    });
    // A thread parked on a background task has no adapter activity to poll this
    // queue. Wake its Engine explicitly so the new user message is consumed
    // immediately while the task remains tracked in TaskManager. If the Engine
    // is not actually running, this was a stale classifier hit; remove the
    // append and fall through to a normal queued turn instead of orphaning it.
    let appendedToRunningThread = false;
    try { appendedToRunningThread = thread.engine?.wakeForPendingUserMessage?.() === true; } catch { /* best-effort wake */ }
    if (!appendedToRunningThread) {
      thread.pendingQueries.pop();
      related = false;
    } else {
      persistInboundMessageOnceByMsgId({
        msgId: envelope?.msg?.id,
        text,
        sessionId,
        threadId: visibleInboundThreadId(envelope, thread.threadId),
        role: isInternalAppend ? 'assistant' : 'user',
        speakerVpId: envelope?.msg?.meta?.senderVpId || envelope?.msg?.from || null,
        attachments: Array.isArray(envelope?.msg?.meta?.attachments) ? envelope.msg.meta.attachments : [],
        quote: envelope?.msg?.meta?.quote || null,
        internal: isInternalAppend,
        ts: envelope?.msg?.ts || null,
        clientMessageId: envelope?.msg?.meta?.clientMessageId || null,
      });
      thread.updatedAt = Date.now();
      try {
        sendSessionEvent({
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
  }

  const key = threadKey(sessionId, vpId, thread.threadId);
  let inbox = vpInboxes.get(key);
  if (!inbox) {
    inbox = [];
    vpInboxes.set(key, inbox);
  }
  inbox.push({ envelope, turnId, thread });
  turnAbortMeta.set(turnId, { sessionId, vpId, threadId: thread.threadId, key });

  try {
    sendSessionEvent({
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
      // History snapshot covers EVERY prior thread of the session.
      // Threads represent intra-VP concurrent tasks, not isolated
      // conversations, so the LLM needs cross-thread continuity.
      // VP isolation lives in `filterSnapshotForVp`; tool_use/result
      // pairing lives in `pairSanitize`. Mirrors disk-side
      // `loadSessionHistoryForVp`, which applies no threadId filter.
      const baseSnapshot = pairSanitize(
        filterSnapshotForVp(getOrCreateSessionHistory(sessionId), vpId),
      );
      const trigger = envelope?.trigger || 'fallback';
      const { text, prompt, promptParts } = buildVpPromptPayload(vpId, envelope);

      try {
        const envMsgId = envelope?.msg?.id;
        if (envMsgId && text) {
          const meta = envelope?.msg?.meta || {};
          const injectedBy = meta.injectedBy;
          const isInternal = injectedBy === 'route_forward' || injectedBy === 'task_result';
          const senderVpId = isInternal ? (meta.senderVpId || envelope?.msg?.from || null) : null;
          persistInboundMessageOnceByMsgId({
            msgId: envMsgId,
            text,
            sessionId,
            threadId: visibleInboundThreadId(envelope, thread.threadId),
            role: isInternal ? 'assistant' : 'user',
            speakerVpId: senderVpId,
            attachments: Array.isArray(meta.attachments) ? meta.attachments : [],
            quote: meta.quote || null,
            internal: isInternal,
            ts: envelope?.msg?.ts || null,
            clientMessageId: meta.clientMessageId || null,
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
        revokeTurnRepoApproval(turnId);
        turnAbortCtrls.delete(turnId);
        turnAbortMeta.delete(turnId);
        if (vpAborts.get(key) === vpAbort) vpAborts.delete(key);
        try {
          sendSessionEvent({
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
        const injectedBy = envelope?.msg?.meta?.injectedBy;
        const isInternalMessage = injectedBy === 'route_forward' || injectedBy === 'task_result';
        if (text && envelope?.msg && !isInternalMessage) {
          sendSessionEvent({
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
          const followUpEnvelope = buildPendingRescueEnvelope({
            sessionId,
            taskId: envelope?.taskId || null,
            threadId: thread.threadId,
            followUpId,
            leftover,
            replayText,
            replayParts,
          });
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
            sendSessionEvent({
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
  await mcpTransitionTail.catch(() => undefined);
  mcpTransitionTail = Promise.resolve();
  await shutdownProjectRuntimes();
  for (const ctrl of vpAborts.values()) {
    try { if (!ctrl.signal.aborted) ctrl.abort(); } catch { /* */ }
  }
  for (const inbox of vpInboxes.values()) {
    if (Array.isArray(inbox)) inbox.length = 0;
  }
  vpThreads.clear();
  for (const turnId of turnRepoApprovals.keys()) revokeTurnRepoApproval(turnId);
  turnAbortCtrls.clear();
  turnAbortMeta.clear();
  await __testDrainVpDrivers();
  vpInboxes.clear();
  vpDrivers.clear();
  vpEngines.clear();
  vpEngineConfigKeys.clear();
  asyncTaskOwners.clear();
  vpAborts.clear();
  sessionContexts.clear();
  projectContextBySession.clear();
  vpCurrentTodos.clear();
  threadClassifier = defaultClassifyThread;
  if (_vpUnsubscribe) {
    try { _vpUnsubscribe(); } catch { /* ignore */ }
    _vpUnsubscribe = null;
  }
  yeaftConversationId = null;
  lastYeaftSlashCommandSnapshot = null;
}


/**
 * Send a provider-neutral assistant output frame for a Yeaft Session.
 *
 * Wire compatibility: this still emits the legacy `yeaft_output` envelope so
 * upgraded agents continue to work with older servers. The frame in `data` is
 * intentionally generic and is consumed by the web's assistant-output handler.
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

function sendSessionOutputFrame(data, { sessionId, chatId, vpId, turnId, threadId, perfTraceId } = {}) {
  const resolvedVpId = vpId || (sessionId ? resolveGroupDefaultVpId(sessionId) : null);
  sendToServer({
    type: 'yeaft_output',
    conversationId: yeaftConversationId,
    ...(perfTraceId ? { perfTraceId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(chatId ? { chatId } : {}),
    ...(resolvedVpId ? { vpId: resolvedVpId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(threadId ? { threadId } : {}),
    data,
  });
}

function isProjectSkill(skill) {
  return PROJECT_SKILL_TIERS.has(String(skill?.tier || '').trim());
}

export function buildSkillSlashCommands(skillManager) {
  if (!skillManager || typeof skillManager.list !== 'function') return { commands: [], descriptions: {} };
  const commands = [];
  const descriptions = {};
  for (const skill of skillManager.list()) {
    if (!skill?.name || typeof skill.name !== 'string') continue;
    const description = skill.description || skill.trigger || 'Load Yeaft skill';
    const commandName = isProjectSkill(skill)
      ? skill.name
      : `${YEAFT_SKILL_COMMAND_PREFIX}${skill.name}`;
    commands.push(commandName);
    descriptions[commandName] = description;

    // Accepted aliases for typed history and compatibility. They are not added
    // to the visible list unless they are the tier-appropriate display command.
    descriptions[`${LEGACY_SKILL_COMMAND_PREFIX}${skill.name}`] = description;
    descriptions[`${YEAFT_SKILL_COMMAND_PREFIX}${skill.name}`] = description;
  }
  commands.sort((a, b) => a.localeCompare(b));
  return { commands, descriptions };
}

export function buildMergedSkillSlashCommands(skillManagers = []) {
  const byName = new Map();
  for (const manager of skillManagers) {
    if (!manager || typeof manager.list !== 'function') continue;
    for (const skill of manager.list()) {
      if (!skill?.name || typeof skill.name !== 'string') continue;
      byName.set(skill.name, skill);
    }
  }
  return buildSkillSlashCommands({ list: () => [...byName.values()] });
}

function sendSkillSlashCommandsUpdate({ conversationId, slashCommands, slashCommandDescriptions }) {
  sendToServer({
    type: 'slash_commands_update',
    commandSet: 'yeaft',
    agentId: ctx.AGENT_ID || ctx.agentId || null,
    conversationId,
    slashCommands,
    slashCommandDescriptions,
  });
}

function replayCachedSkillSlashCommandsToYeaftConversation() {
  if (!yeaftConversationId || !lastYeaftSlashCommandSnapshot) return;
  sendSkillSlashCommandsUpdate({
    conversationId: yeaftConversationId,
    slashCommands: lastYeaftSlashCommandSnapshot.slashCommands,
    slashCommandDescriptions: lastYeaftSlashCommandSnapshot.slashCommandDescriptions,
  });
}

function loadAndBroadcastYeaftSkillSlashCommands() {
  const yeaftDir = ctx.CONFIG?.yeaftDir || DEFAULT_YEAFT_DIR;
  const roots = [process.cwd()];
  const configuredWorkDir = typeof ctx.CONFIG?.workDir === 'string' ? ctx.CONFIG.workDir.trim() : '';
  if (configuredWorkDir && configuredWorkDir !== process.cwd()) roots.push(configuredWorkDir);
  const skillManager = createSkillManager(yeaftDir, roots.join(delimiter));
  const config = loadConfig({ dir: yeaftDir });
  const visibleSkillManager = createPluginSkillManager(skillManager, config.plugins);
  broadcastSkillSlashCommands({ skillManager: visibleSkillManager });
  return {
    skills: visibleSkillManager?.size || 0,
    slashCommands: ctx.slashCommands,
    slashCommandDescriptions: ctx.slashCommandDescriptions,
  };
}

export function preloadYeaftSkillSlashCommands() {
  setTimeout(() => {
    try { loadAndBroadcastYeaftSkillSlashCommands(); }
    catch (err) { console.warn('[Yeaft] async skill slash preload failed:', err?.message || err); }
  }, 0);
  return { scheduled: true };
}

function broadcastSkillSlashCommands(sessionLike, extraSkillManagers = []) {
  const plugins = sessionLike?.config?.plugins || session?.config?.plugins || {};
  const managers = [sessionLike?.skillManager, ...extraSkillManagers]
    .filter(Boolean)
    .map(manager => createPluginSkillManager(manager, plugins));
  const { commands: slashCommands, descriptions: slashCommandDescriptions } = buildMergedSkillSlashCommands(managers);
  // Yeaft owns an isolated command catalogue. Reusing ctx's Claude Chat
  // commands made unsupported entries such as /compact and /mcp appear in a
  // Session even though the Yeaft engine only parses effort and Skill prefixes.
  lastYeaftSlashCommandSnapshot = { slashCommands, slashCommandDescriptions };
  sendSkillSlashCommandsUpdate({
    conversationId: yeaftConversationId || '__preload__',
    slashCommands,
    slashCommandDescriptions,
  });
}

function activeSkillRuntime(owner) {
  if (!isCurrentRuntimeOwner(owner)) return null;
  if (activeRuntimeKey === BASE_RUNTIME_KEY) {
    if (baseRuntime && runtimeBelongsToOwner(baseRuntime, owner)) return baseRuntime;
    return {
      generation: owner.generation,
      ownerSession: owner.ownerSession,
      skillManager: owner.ownerSession.skillManager,
      status: owner.ownerSession.status,
    };
  }
  const runtime = projectRuntimes.get(activeRuntimeKey) || null;
  return runtimeBelongsToOwner(runtime, owner) ? runtime : null;
}

function reloadActiveSkills(owner = skillReloadOwner || captureRuntimeOwner()) {
  if (!isCurrentRuntimeOwner(owner)) return { changed: false, loaded: 0, errors: [] };
  if (skillReloadRunning) return { changed: false, loaded: 0, errors: [] };
  const runtime = activeSkillRuntime(owner);
  const manager = runtime?.skillManager;
  if (typeof manager?.load !== 'function') return { changed: false, loaded: 0, errors: [] };

  skillReloadRunning = true;
  try {
    const result = manager.load() || {};
    const currentRuntime = activeSkillRuntime(owner);
    if (!isCurrentRuntimeOwner(owner) || currentRuntime?.skillManager !== manager) {
      return { changed: false, loaded: 0, errors: [] };
    }
    const changed = !!result.changed;
    const loaded = Number(result.loaded) || 0;
    const errors = result.errors || [];
    if (runtime.status) runtime.status.skills = manager.size || 0;
    if (activeRuntimeKey === BASE_RUNTIME_KEY && owner.ownerSession.status) {
      owner.ownerSession.status.skills = manager.size || 0;
    }
    if (changed) {
      broadcastSkillSlashCommands({ skillManager: manager });
      const activeStatus = activeRuntimeKey === BASE_RUNTIME_KEY
        ? runtime.status
        : mergedStatusForProjectRuntime(runtime, owner.ownerSession);
      hydrateYeaftStatusFromSession(
        activeStatus ? { ...owner.ownerSession, status: activeStatus } : owner.ownerSession,
        { reason: 'skills_hot_reload', emitEvent: true },
      );
    }
    if (errors.length > 0) {
      console.warn(`[Yeaft] skill hot reload completed with ${errors.length} error(s):`, errors.join('; '));
    }
    return { changed, loaded, errors };
  } finally {
    skillReloadRunning = false;
  }
}

function startSkillHotReload(owner = captureRuntimeOwner()) {
  if (!isCurrentRuntimeOwner(owner)) return false;
  if (skillReloadTimer && skillReloadOwner
      && skillReloadOwner.generation === owner.generation
      && skillReloadOwner.ownerSession === owner.ownerSession) {
    return false;
  }
  stopSkillHotReload();
  skillReloadOwner = owner;
  const timer = setInterval(() => {
    if (!isCurrentRuntimeOwner(owner)) {
      if (skillReloadTimer === timer) stopSkillHotReload(owner);
      return;
    }
    try { reloadActiveSkills(owner); }
    catch (err) { console.warn('[Yeaft] skill hot reload failed:', err?.message || err); }
  }, SKILL_RELOAD_INTERVAL_MS);
  skillReloadTimer = timer;
  timer.unref?.();
  return true;
}

function stopSkillHotReload(owner = null) {
  if (owner && skillReloadOwner
      && (skillReloadOwner.generation !== owner.generation
        || skillReloadOwner.ownerSession !== owner.ownerSession)) {
    return false;
  }
  if (skillReloadTimer) clearInterval(skillReloadTimer);
  skillReloadTimer = null;
  skillReloadOwner = null;
  skillReloadRunning = false;
  return true;
}

async function runBaseRuntimeTransition(owner = captureRuntimeOwner()) {
  if (!isCurrentRuntimeOwner(owner)) return null;
  const ownerSession = owner.ownerSession;
  const yeaftDir = ctx.CONFIG?.yeaftDir || ownerSession.yeaftDir || DEFAULT_YEAFT_DIR;
  const previousSkillManager = ownerSession.skillManager;
  const previousMcpManager = ownerSession.mcpManager;
  const skillManager = createRuntimeSkillManager(yeaftDir, process.cwd());
  const rawMcpConfig = loadRuntimeMcpConfig(yeaftDir, undefined, process.cwd());
  const { configured: configuredMcpConfig, effective: effectiveMcpConfig } = resolveMcpPluginPolicy(
    rawMcpConfig,
    ownerSession.config?.plugins,
  );
  const mcpManager = createRuntimeMcpManager();
  let mcpStatus = { connected: [], failed: [] };
  const runtime = {
    generation: owner.generation,
    ownerSession,
    workDir: '',
    previousSkillManager,
    previousMcpManager,
    skillManager,
    mcpManager,
    mcpStatus,
    configuredMcpConfig,
    effectiveMcpConfig,
    loading: effectiveMcpConfig.servers.length > 0,
    status: {
      skills: skillManager.size,
      mcpServers: [],
      mcpFailed: [],
      mcpSkipped: effectiveMcpConfig.skipped || [],
      tools: ownerSession.toolRegistry?.size || 0,
    },
  };

  if (!isCurrentRuntimeOwner(owner)) {
    await disconnectRuntimeMcpManager(mcpManager);
    return null;
  }
  baseRuntime = runtime;
  ownerSession.skillManager = skillManager;
  ownerSession.mcpManager = mcpManager;
  ownerSession.status = { ...ownerSession.status, ...runtime.status };
  if (activeRuntimeKey === BASE_RUNTIME_KEY) {
    activateBaseRuntime(owner, { reloadSkills: false });
    hydrateYeaftStatusFromSession(ownerSession, { reason: 'base_runtime_skills', emitEvent: true });
  }

  if (effectiveMcpConfig.servers.length > 0) {
    try {
      mcpStatus = await mcpManager.connectAll(effectiveMcpConfig.servers);
    } catch (err) {
      runtime.loading = false;
      if (ownerSession.skillManager === skillManager) ownerSession.skillManager = previousSkillManager;
      if (ownerSession.mcpManager === mcpManager) ownerSession.mcpManager = previousMcpManager;
      await disconnectRuntimeMcpManager(mcpManager);
      if (baseRuntime === runtime) baseRuntime = null;
      throw err;
    }
    runtime.loading = false;
    if (!isCurrentRuntimeOwner(owner) || baseRuntime !== runtime) {
      if (ownerSession.skillManager === skillManager) ownerSession.skillManager = previousSkillManager;
      if (ownerSession.mcpManager === mcpManager) ownerSession.mcpManager = previousMcpManager;
      await disconnectRuntimeMcpManager(mcpManager);
      return null;
    }
    runtime.mcpStatus = mcpStatus;
    runtime.status = {
      ...runtime.status,
      mcpServers: mcpStatus.connected,
      mcpFailed: mcpStatus.failed,
      mcpSkipped: effectiveMcpConfig.skipped || [],
      tools: ownerSession.toolRegistry?.size || 0,
    };
    ownerSession.mcpManager = mcpManager;
    ownerSession.status = { ...ownerSession.status, ...runtime.status };
    if (activeRuntimeKey === BASE_RUNTIME_KEY) {
      activateBaseRuntime(owner, { reloadSkills: false });
      hydrateYeaftStatusFromSession(ownerSession, { reason: 'base_runtime_mcp', emitEvent: true });
      if (isCurrentRuntimeOwner(owner)) {
        try { await broadcastMcpUpdated({ reason: 'base-runtime-load' }); } catch { /* best-effort */ }
      }
    }
  }

  return isCurrentRuntimeOwner(owner) && baseRuntime === runtime ? runtime : null;
}

function loadBaseRuntime(owner = captureRuntimeOwner()) {
  return enqueueMcpTransition(() => runBaseRuntimeTransition(owner));
}

function scheduleBaseRuntimeLoad() {
  const owner = captureRuntimeOwner();
  if (!owner) return null;
  const current = baseRuntimeLoadPromises.get(BASE_RUNTIME_KEY);
  if (current && loaderBelongsToOwner(current, owner)) return current;
  let promise;
  promise = new Promise(resolve => setTimeout(resolve, 0))
    .then(() => loadBaseRuntime(owner))
    .catch((err) => {
      console.warn('[Yeaft] async base runtime load failed:', err?.message || err);
      return null;
    })
    .finally(() => {
      if (owner.generation === runtimeGeneration
          && baseRuntimeLoadPromises.get(BASE_RUNTIME_KEY) === promise) {
        baseRuntimeLoadPromises.delete(BASE_RUNTIME_KEY);
      }
    });
  runtimeLoaderOwners.set(promise, owner);
  baseRuntimeLoadPromises.set(BASE_RUNTIME_KEY, promise);
  return promise;
}

async function runProjectRuntimeTransition(workDir, owner = captureRuntimeOwner()) {
  if (!isCurrentRuntimeOwner(owner)) return null;
  const ownerSession = owner.ownerSession;
  const normalizedWorkDir = normalizeSessionWorkDir(workDir);
  if (!normalizedWorkDir) {
    activateBaseRuntime(owner);
    return null;
  }
  const key = projectRuntimeKey(normalizedWorkDir);
  const cached = projectRuntimes.get(key);
  if (runtimeBelongsToOwner(cached, owner)) {
    activateProjectRuntime(cached, owner);
    return cached;
  }

  const yeaftDir = ctx.CONFIG?.yeaftDir || ownerSession.yeaftDir || DEFAULT_YEAFT_DIR;
  const skillRoots = normalizedWorkDir !== process.cwd()
    ? `${process.cwd()}${delimiter}${normalizedWorkDir}`
    : normalizedWorkDir;
  const skillManager = createRuntimeSkillManager(yeaftDir, skillRoots);
  const rawMcpConfig = loadRuntimeMcpConfig(yeaftDir, undefined, normalizedWorkDir);
  const { configured: configuredMcpConfig, effective: effectiveMcpConfig } = resolveMcpPluginPolicy(
    rawMcpConfig,
    ownerSession.config?.plugins,
  );
  const mcpManager = createRuntimeMcpManager();
  let mcpStatus = { connected: [], failed: [] };
  const runtime = {
    generation: owner.generation,
    ownerSession,
    workDir: normalizedWorkDir,
    skillManager,
    mcpManager,
    mcpStatus,
    configuredMcpConfig,
    effectiveMcpConfig,
    loading: effectiveMcpConfig.servers.length > 0,
    status: {
      skills: skillManager.size,
      mcpServers: [],
      mcpFailed: [],
      mcpSkipped: effectiveMcpConfig.skipped || [],
      tools: ownerSession.toolRegistry?.size || 0,
    },
  };
  if (!isCurrentRuntimeOwner(owner)) {
    await disconnectRuntimeMcpManager(mcpManager);
    return null;
  }
  projectRuntimes.set(key, runtime);
  // Skill metadata is ready before external MCP startup. Activation is still
  // owner-gated so reset cannot publish this runtime into a replacement session.
  activateProjectRuntime(runtime, owner, { reloadSkills: false });
  if (effectiveMcpConfig.servers.length > 0) {
    try {
      mcpStatus = await mcpManager.connectAll(effectiveMcpConfig.servers);
    } catch (err) {
      runtime.loading = false;
      await disconnectRuntimeMcpManager(mcpManager);
      if (projectRuntimes.get(key) === runtime) projectRuntimes.delete(key);
      throw err;
    }
    runtime.loading = false;
    if (!runtimeBelongsToOwner(runtime, owner) || projectRuntimes.get(key) !== runtime) {
      await disconnectRuntimeMcpManager(mcpManager);
      return null;
    }
    runtime.mcpStatus = mcpStatus;
    runtime.status = {
      ...runtime.status,
      mcpServers: mcpStatus.connected,
      mcpFailed: mcpStatus.failed,
      mcpSkipped: effectiveMcpConfig.skipped || [],
      tools: ownerSession.toolRegistry?.size || 0,
    };
    if (activeRuntimeKey === key) activateProjectRuntime(runtime, owner, { reloadSkills: false });
  }
  return runtimeBelongsToOwner(runtime, owner) && projectRuntimes.get(key) === runtime ? runtime : null;
}

function loadProjectRuntime(workDir, owner = captureRuntimeOwner()) {
  return enqueueMcpTransition(() => runProjectRuntimeTransition(workDir, owner));
}

function scheduleProjectRuntimeLoad(workDir) {
  const owner = captureRuntimeOwner();
  const normalizedWorkDir = normalizeSessionWorkDir(workDir);
  if (!normalizedWorkDir || !owner) return null;
  const key = projectRuntimeKey(normalizedWorkDir);
  const cached = projectRuntimes.get(key);
  if (runtimeBelongsToOwner(cached, owner)) return cached;
  const current = projectRuntimeLoadPromises.get(key);
  if (current && loaderBelongsToOwner(current, owner)) return current;
  let promise;
  promise = loadProjectRuntime(normalizedWorkDir, owner)
    .catch((err) => {
      console.warn('[Yeaft] async project runtime load failed for %s: %s', normalizedWorkDir, err?.message || err);
      return null;
    })
    .finally(() => {
      if (owner.generation === runtimeGeneration
          && projectRuntimeLoadPromises.get(key) === promise) {
        projectRuntimeLoadPromises.delete(key);
      }
    });
  runtimeLoaderOwners.set(promise, owner);
  projectRuntimeLoadPromises.set(key, promise);
  return promise;
}

function getProjectRuntimeForTurn(sessionMeta) {
  const owner = captureRuntimeOwner();
  if (!owner) return null;
  const workDir = normalizeSessionWorkDir(sessionMeta?.workDir);
  if (!workDir) {
    if (!runtimeBelongsToOwner(baseRuntime, owner)) scheduleBaseRuntimeLoad();
    activateBaseRuntime(owner);
    return null;
  }
  const cached = projectRuntimes.get(projectRuntimeKey(workDir)) || null;
  if (runtimeBelongsToOwner(cached, owner)) {
    activateProjectRuntime(cached, owner);
    return cached;
  }
  scheduleProjectRuntimeLoad(workDir);
  // Do not let a previous workDir's MCP tools leak into this turn while the
  // requested project runtime is still loading in the background.
  activateBaseRuntime(owner);
  return null;
}

function mergedStatusForProjectRuntime(runtime, ownerSession = session) {
  if (!ownerSession?.status || !runtime?.status) return ownerSession?.status || { skills: 0, mcpServers: [], tools: 0 };
  return {
    ...ownerSession.status,
    skills: Math.max(Number(ownerSession.status.skills) || 0, Number(runtime.status.skills) || 0),
    mcpServers: [...new Set([...(ownerSession.status.mcpServers || []), ...(runtime.status.mcpServers || [])])],
    mcpFailed: [...(ownerSession.status.mcpFailed || []), ...(runtime.status.mcpFailed || [])],
    mcpSkipped: [...(ownerSession.status.mcpSkipped || []), ...(runtime.status.mcpSkipped || [])],
    tools: Math.max(Number(ownerSession.status.tools) || 0, Number(runtime.status.tools) || 0),
  };
}

/** Send a Yeaft Session metadata event over the legacy-compatible envelope. */
function sendSessionEvent(event, { sessionId, chatId, vpId, turnId, threadId, requestId, requestClientId, perfTraceId } = {}) {
  sendToServer({
    type: 'yeaft_output',
    conversationId: yeaftConversationId,
    ...(perfTraceId ? { perfTraceId } : {}),
    ...(requestId ? { requestId } : {}),
    ...(requestClientId ? { _requestClientId: requestClientId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(chatId ? { chatId } : {}),
    ...(vpId ? { vpId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(threadId ? { threadId } : {}),
    event,
  });
}

function pendingUserPromptEvent(requestId, pending, extra = {}) {
  return {
    type: 'ask_user_question',
    requestId,
    toolCallId: pending.toolCallId || null,
    questions: [{
      question: pending.question,
      options: pending.options.map(label => ({ label, description: '' })),
      multiSelect: false,
    }],
    createdAt: pending.createdAt,
    expiresAt: pending.expiresAt,
    ...extra,
  };
}

function sendPendingUserPrompt(requestId, pending, extra = {}) {
  sendSessionEvent(pendingUserPromptEvent(requestId, pending, extra), {
    sessionId: pending.sessionId,
    vpId: pending.vpId,
    threadId: pending.threadId,
    turnId: pending.turnId,
  });
}

function replayPendingUserPrompts(sessionId) {
  const now = Date.now();
  for (const [requestId, pending] of pendingUserPrompts) {
    if (pending.sessionId !== sessionId || pending.expiresAt <= now) continue;
    sendPendingUserPrompt(requestId, pending, { replay: true });
  }
}

function settlePendingUserPrompt(requestId, pending, { answers = null, timedOut = false } = {}) {
  if (pendingUserPrompts.get(requestId) !== pending) return false;
  pendingUserPrompts.delete(requestId);
  if (pending.timer) clearTimeout(pending.timer);
  if (pending.signal && pending.onAbort) {
    try { pending.signal.removeEventListener('abort', pending.onAbort); } catch { /* ignore */ }
  }
  try { pending.resumeQueryTimer?.(); } catch { /* best-effort */ }
  sendSessionEvent({
    type: timedOut ? 'ask_user_expired' : 'ask_user_answered',
    requestId,
    toolCallId: pending.toolCallId || null,
    ...(timedOut ? { expiredAt: Date.now() } : { answers: answers || {} }),
  }, {
    sessionId: pending.sessionId,
    vpId: pending.vpId,
    threadId: pending.threadId,
    turnId: pending.turnId,
  });
  pending.resolve(timedOut ? { __yeaftTimedOut: true } : (answers || {}));
  return true;
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

function readConfiguredVp(vpId) {
  const { libDir } = configuredVpPaths();
  return readVp(vpId, libDir ? { libDir } : {});
}

function scanConfiguredVpLibrary() {
  const { libDir } = configuredVpPaths();
  return scanVpLibrary(libDir ? { dir: libDir } : {});
}

export function handleYeaftVpSubscribe(msg = {}) {
  if (_vpUnsubscribe) {
    try { _vpUnsubscribe(); } catch { /* ignore */ }
    _vpUnsubscribe = null;
  }
  const { libDir } = configuredVpPaths();
  const requestId = typeof msg.requestId === 'string' && msg.requestId ? msg.requestId : null;
  _vpUnsubscribe = handleVpSubscribe(
    event => sendSessionEvent(event, event?.type === 'vp_snapshot' && requestId ? { requestId } : undefined),
    undefined,
    libDir ? { dir: libDir } : {},
  );
}

/**
 * Seed and publish the Agent-owned VP library as soon as the Agent registers.
 * Session creation must not wait for a Session runtime or a first user message:
 * stock VPs ship with the Agent and are cheap synchronous files to materialize.
 * Later explicit subscriptions still refresh the same authoritative library.
 */
export function broadcastYeaftVpSnapshotEager() {
  handleYeaftVpSubscribe();
}

/**
 * VP CRUD from the web client. See historic doc for full message shapes.
 */
function sendVpCrudResult(payload) {
  sendSessionEvent({ type: 'vp_crud_result', ...payload });
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
function decorateSessionsWithRuntimeState(sessions) {
  const rows = Array.isArray(sessions) ? sessions : [];
  if (rows.length === 0) return rows;
  let statuses = [];
  try {
    statuses = getVpStatusBroker().snapshot();
  } catch {
    statuses = [];
  }
  const bySession = new Map();
  for (const status of statuses) {
    const sessionId = status?.sessionId || status?.groupId || null;
    if (!sessionId) continue;
    const state = status.state || 'idle';
    const running = isVpStatusRunning(state);
    const updatedAt = status.updatedAt || status.since || Date.now();
    const prev = bySession.get(sessionId) || { running: false, runningVpCount: 0, latestActivityAt: 0 };
    if (running) prev.runningVpCount += 1;
    prev.running = prev.running || running;
    prev.latestActivityAt = Math.max(prev.latestActivityAt || 0, updatedAt || 0);
    bySession.set(sessionId, prev);
  }
  return rows.map(session => {
    if (!session || !session.id) return session;
    const runtime = bySession.get(session.id);
    if (!runtime) return { ...session, running: false, active: false };
    return {
      ...session,
      running: !!runtime.running,
      active: !!runtime.running,
      runningVpCount: runtime.runningVpCount || 0,
      latestActivityAt: runtime.latestActivityAt || null,
    };
  });
}

const PROJECT_CONTEXT_MAX_SIBLINGS = 8;
const PROJECT_CONTEXT_MAX_TOKENS = 4096;
const PROJECT_CONTEXT_TRUNCATION_NOTICE = '\n[Summary truncated to Project context budget]';

async function sharedProjectContext(yeaftDir, sessionId, options = {}) {
  const requestedSiblingIds = Array.isArray(options.sessionIds)
    ? options.sessionIds.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim())
    : null;
  const project = requestedSiblingIds === null
    ? loadProjects(yeaftDir).find(row => row.sessionIds.includes(sessionId))
    : null;
  const sourceSessionIds = requestedSiblingIds || project?.sessionIds || [];
  if (sourceSessionIds.length === 0) return '';
  const memoryRoot = join(yeaftDir, 'memory');
  const language = options.language || 'en';
  const configuredBudget = Number.isFinite(options.tokenBudget) && options.tokenBudget > 0
    ? options.tokenBudget
    : PROJECT_CONTEXT_MAX_TOKENS;
  const tokenBudget = Math.min(configuredBudget, PROJECT_CONTEXT_MAX_TOKENS);
  let context = '';
  const siblingIds = sourceSessionIds
    .filter(id => id !== sessionId)
    .slice(0, PROJECT_CONTEXT_MAX_SIBLINGS);
  for (const siblingId of siblingIds) {
    const summary = await readScopeSummary(
      { kind: 'session', id: siblingId },
      { root: memoryRoot, language },
    ).catch(() => '');
    if (!summary) continue;
    const separator = context ? '\n\n' : '';
    const header = `[Session ${siblingId}]\n`;
    const fullContext = `${context}${separator}${header}${summary}`;
    if (estimateTokens(fullContext) <= tokenBudget) {
      context = fullContext;
      continue;
    }

    const prefix = `${context}${separator}${header}`;
    if (estimateTokens(`${prefix}${PROJECT_CONTEXT_TRUNCATION_NOTICE}`) <= tokenBudget) {
      let low = 0;
      let high = summary.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        const candidate = `${prefix}${summary.slice(0, middle)}${PROJECT_CONTEXT_TRUNCATION_NOTICE}`;
        if (estimateTokens(candidate) <= tokenBudget) low = middle;
        else high = middle - 1;
      }
      context = `${prefix}${summary.slice(0, low)}${PROJECT_CONTEXT_TRUNCATION_NOTICE}`;
    }
    break;
  }
  return context;
}

function sendSessionCrudResult(payload) {
  const next = payload && payload.ok && Array.isArray(payload.sessions)
    ? { ...payload, sessions: decorateSessionsWithRuntimeState(payload.sessions) }
    : payload;
  sendSessionEvent({ type: 'session_crud_result', ...next });
}

function isMcpServerEnabled(name, plugins = session?.config?.plugins) {
  return !Array.isArray(plugins?.mcpServers) || plugins.mcpServers.includes(name);
}

function resolvePluginCatalogRuntime(workDir = '') {
  const owner = captureRuntimeOwner();
  const normalizedWorkDir = normalizeSessionWorkDir(workDir);
  const runtime = normalizedWorkDir
    ? projectRuntimes.get(projectRuntimeKey(normalizedWorkDir))
    : null;
  const active = runtimeBelongsToOwner(runtime, owner)
    ? runtime
    : (baseRuntime && runtimeBelongsToOwner(baseRuntime, owner) ? baseRuntime : null);
  return {
    toolRegistry: session?.toolRegistry || null,
    skillManager: active?.skillManager || session?.skillManager || null,
    mcpManager: active?.mcpManager || session?.mcpManager || null,
  };
}

function loadPluginCatalogMcpConfig(yeaftDir) {
  // The Plugins catalog is Agent-owned. Re-read its raw configuration on every
  // request so MCP CRUD is visible immediately, while keeping the
  // config.json -> mcp.json compatibility fallback.
  return loadAgentMCPConfig(yeaftDir);
}

const MANAGED_SKILL_SCOPES = new Set(['user', 'project']);

function normalizedManagedSkillScope(value) {
  const scope = typeof value === 'string' ? value.trim() : '';
  return MANAGED_SKILL_SCOPES.has(scope) ? scope : '';
}

function resolveManagedSkillSession(yeaftDir, rawSessionId) {
  const sessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : '';
  const validation = validateSessionId(sessionId);
  if (!validation.ok) throw new Error('invalid Session id');

  // Skill mutation is a filesystem write. Its authority root is strictly the
  // agent-local canonical store, not the read-compatible resolver: that one
  // can consult bootstrap-only group-workdirs.json and project-local legacy
  // Session directories. Those sources are not valid write authorization.
  const sessionRoot = sessionsRoot(yeaftDir);
  try {
    const sessionRootStat = lstatSync(sessionRoot);
    if (!sessionRootStat.isDirectory() || sessionRootStat.isSymbolicLink()) {
      throw new Error('the selected Session was not found');
    }
  } catch (err) {
    if (err?.message === 'the selected Session was not found') throw err;
    throw new Error('the selected Session was not found');
  }
  const sessionDir = join(sessionRoot, sessionId);
  // `loadSessionMeta()` deliberately supports legacy group.json for readers.
  // This mutation path needs the canonical agent-local session.json instead.
  const metaPath = join(sessionDir, SESSION_META_FILE);
  if (!existsSync(metaPath)) throw new Error('the selected Session was not found');
  try {
    const sessionDirStat = lstatSync(sessionDir);
    const metaStat = lstatSync(metaPath);
    if (!sessionDirStat.isDirectory() || sessionDirStat.isSymbolicLink()
      || !metaStat.isFile() || metaStat.isSymbolicLink()) {
      throw new Error('the selected Session was not found');
    }
  } catch (err) {
    if (err?.message === 'the selected Session was not found') throw err;
    throw new Error('the selected Session was not found');
  }
  const meta = loadSessionMeta(sessionDir);
  if (!meta || meta.id !== sessionId) throw new Error('the selected Session was not found');

  const workDir = normalizeSessionWorkDir(meta.workDir);
  if (!workDir) throw new Error('the selected Session has no project directory');
  return { sessionId, workDir };
}

function currentRuntimeMatchesWorkDir(workDir) {
  const runtime = activeSkillRuntime(captureRuntimeOwner());
  return runtime && normalizeSessionWorkDir(runtime.workDir) === normalizeSessionWorkDir(workDir);
}

function reloadManagedSkillRuntime(scope, workDir = '') {
  const owner = captureRuntimeOwner();
  if (!owner) return;
  if (scope === 'project' && currentRuntimeMatchesWorkDir(workDir)) {
    reloadActiveSkills(owner);
    return;
  }
  if (scope === 'user') reloadActiveSkills(owner);
}

function managedSkillCatalog(yeaftDir, workDir = '') {
  const normalizedWorkDir = normalizeSessionWorkDir(workDir);
  const runtime = resolvePluginCatalogRuntime(normalizedWorkDir);
  const manager = createSkillManager(yeaftDir, normalizedWorkDir || process.cwd());
  return buildPluginCatalog({ ...runtime, skillManager: manager });
}

/**
 * Create or remove a native Yeaft Skill in an explicit user/project scope.
 * The Session lookup is agent-local; browser-supplied filesystem paths are
 * never trusted as a write target.
 */
export function handleYeaftManagedSkill(msg = {}) {
  const requestId = msg.requestId || null;
  const action = msg.action === 'remove' ? 'remove' : (msg.action === 'create' ? 'create' : '');
  const scope = normalizedManagedSkillScope(msg.scope);
  const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId.trim() : '';
  const yeaftDir = ctx.CONFIG?.yeaftDir || session?.yeaftDir || DEFAULT_YEAFT_DIR;
  const respond = (payload) => sendToServer({
    type: 'yeaft_managed_skill_result',
    requestId,
    ...(msg._requestClientId ? { _requestClientId: msg._requestClientId } : {}),
    ...payload,
  });
  if (!action || !scope) {
    respond({ catalog: { tools: [], skills: [], skillSources: [], mcpServers: [] }, error: 'skill action must be create or remove and scope must be user or project' });
    return;
  }
  try {
    const managedSession = scope === 'project'
      ? resolveManagedSkillSession(yeaftDir, sessionId)
      : null;
    const result = scope === 'project'
      ? (action === 'create'
        ? createManagedProjectSkill(managedSession.workDir, msg.skill || {})
        : removeManagedProjectSkill(managedSession.workDir, msg.name))
      : (action === 'create'
        ? createManagedSkill(join(yeaftDir, 'skills'), msg.skill || {})
        : removeManagedSkill(join(yeaftDir, 'skills'), msg.name));
    reloadManagedSkillRuntime(scope, managedSession?.workDir || '');
    const catalog = managedSkillCatalog(yeaftDir, managedSession?.workDir || '');
    respond({ scope, sessionId: managedSession?.sessionId || null, result, catalog, error: null });
  } catch (err) {
    respond({ scope, sessionId: null, catalog: { tools: [], skills: [], skillSources: [], mcpServers: [] }, error: err?.message || String(err) });
  }
}

/** Test-only: read the MCP catalog source without sending a bridge response. */
export function __testLoadPluginCatalogMcpConfig(yeaftDir) {
  return loadPluginCatalogMcpConfig(yeaftDir);
}

export function handleYeaftPluginCatalog(msg = {}) {
  const requestId = msg.requestId || null;
  const requestedWorkDir = normalizeSessionWorkDir(msg.workDir);
  try {
    const runtime = resolvePluginCatalogRuntime(requestedWorkDir);
    const yeaftDir = ctx.CONFIG?.yeaftDir || session?.yeaftDir || DEFAULT_YEAFT_DIR;
    runtime.mcpConfig = loadPluginCatalogMcpConfig(yeaftDir);
    const catalog = buildPluginCatalog(runtime);
    sendToServer({
      type: 'yeaft_plugin_catalog_result',
      requestId,
      ...(msg._requestClientId ? { _requestClientId: msg._requestClientId } : {}),
      catalog,
      error: null,
    });
  } catch (err) {
    sendToServer({
      type: 'yeaft_plugin_catalog_result',
      requestId,
      ...(msg._requestClientId ? { _requestClientId: msg._requestClientId } : {}),
      catalog: { tools: [], skills: [], mcpServers: [] },
      error: err?.message || String(err),
    });
  }
}

function sendSessionSnapshotBroadcast() {
  try {
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    if (!yeaftDir) return;
    const sessions = decorateSessionsWithRuntimeState(snapshotSessions(yeaftDir));
    sendSessionEvent({ type: 'session_list_updated', sessions, projects: loadProjects(yeaftDir) });
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
    metadataUpdatedAt: session.metadataUpdatedAt || session.createdAt || null,
  };
  sendSessionEvent({ type: 'session_roster_changed', ...payload });
}

function sessionErrorPayload(err) {
  let code = 'unknown';
  if (err instanceof SessionCrudError) code = err.code;
  else if (err instanceof SessionConfigError) code = err.code;
  else if (err instanceof ProjectStoreError) code = err.code;
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
    sendSessionCrudResult({ op: 'list', requestId, ok: true, sessions: groups, projects: loadProjects(yeaftDir) });
  } catch (err) {
    sendSessionCrudResult({ op: 'list', requestId, ok: false, error: sessionErrorPayload(err) });
  }
}

export function handleYeaftProjectContextSync(msg) {
  for (const row of Array.isArray(msg?.contexts) ? msg.contexts : []) {
    const sessionId = typeof row?.sessionId === 'string' ? row.sessionId.trim() : '';
    if (!sessionId) continue;
    const projectContext = normalizeProjectContext(row.projectContext, sessionId);
    projectContextBySession.set(sessionId, projectContext || {
      projectId: null,
      projectName: null,
      projectInstruction: '',
      sessionIds: [],
    });
  }
}

export function handleYeaftProjectMutation(msg) {
  const requestId = msg && msg.requestId;
  const op = msg && msg.op;
  try {
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    let result = null;
    if (op === 'create') result = createProject(yeaftDir, msg.name);
    else if (op === 'rename') result = renameProject(yeaftDir, msg.projectId, msg.name);
    else if (op === 'update_instruction') {
      result = updateProjectInstruction(yeaftDir, msg.projectId, msg.instruction);
    } else if (op === 'delete') result = deleteProject(yeaftDir, msg.projectId);
    else if (op === 'reorder') result = reorderProjects(yeaftDir, msg.projectIds);
    else if (op === 'move_session') {
      if (!snapshotSessions(yeaftDir).some(row => row.id === msg.sessionId)) {
        throw new ProjectStoreError('session_not_found', 'Session not found');
      }
      result = moveSessionToProject(yeaftDir, msg.sessionId, msg.projectId || null);
    } else {
      throw new ProjectStoreError('invalid_op', 'Unknown Project operation');
    }
    sendSessionEvent({
      type: 'project_mutation_result',
      requestId,
      op,
      ok: true,
      result,
      projects: loadProjects(yeaftDir),
    }, { requestId });
    sendSessionSnapshotBroadcast();
  } catch (err) {
    sendSessionEvent({
      type: 'project_mutation_result',
      requestId,
      op,
      ok: false,
      error: sessionErrorPayload(err),
    }, { requestId });
  }
}

export function handleYeaftCreateSession(msg) {
  const requestId = msg && msg.requestId;
  const payload = (msg && msg.payload) || {};
  try {
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    const group = createSessionFromSpec(yeaftDir, payload, configuredVpPaths());
    recordAgentSessionCreated();
    group.config = loadSessionConfig(yeaftDir, group.id);
    sendSessionCrudResult({ op: 'create', requestId, ok: true, session: group });
    sendSessionSnapshotBroadcast();
  } catch (err) {
    sendSessionCrudResult({ op: 'create', requestId, ok: false, error: sessionErrorPayload(err) });
  }
}

/**
 * `yeaft_scan_workdir_sessions` — compatibility endpoint for the retired
 * workdir Session scan flow. Session data now lives under the user-level
 * `~/.yeaft/sessions`; project `.yeaft` is reserved for project assets such as
 * skills and MCP config.
 */
export function handleYeaftScanWorkdirSessions(msg) {
  const requestId = msg && msg.requestId;
  try {
    const workDir = String(msg && msg.workDir || '').trim();
    if (!workDir) throw new SessionCrudError('invalid_workdir', null, 'workDir required');
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    // Current rows come from the Agent manifest; workDir-local rows remain a
    // legacy import fallback. Keep the decoration shape stable for old clients.
    const sessions = scanWorkdirSessions(workDir, yeaftDir);
    const registry = readWorkDirRegistry(yeaftDir);
    const decorated = sessions.map(s => ({
      ...s,
      alreadyRegistered: !s.legacyImport || Object.prototype.hasOwnProperty.call(registry, s.id),
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
  const sessionId = (msg && msg.sessionId) || null;
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
  const sessionId = (msg && msg.sessionId) || null;
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
 * Persist the model selected in the Session conversation header.
 *
 * Cached engines remain alive. This handler publishes their updated effective
 * config; `Engine.refreshConfig()` applies it at the next LLM loop boundary.
 * The current stream and its AbortController are untouched.
 *
 * Payload: { sessionId, requestId, config: { model?: string|null } }
 *  - `model: ''` or `null` clears the selected Session model (falls back to user default).
 */
export function handleYeaftUpdateSessionConfig(msg) {
  const requestId = msg && msg.requestId;
  // wire-compat: accept legacy `groupId` (see handleYeaftRenameSession).
  const sessionId = (msg && msg.sessionId) || null;
  const partial = (msg && msg.config && typeof msg.config === 'object') ? msg.config : null;
  try {
    if (!sessionId) throw new SessionConfigError('missing_group_id', 'sessionId required');
    if (!partial) throw new SessionConfigError('invalid_patch', 'config object required');
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    const savedConfig = updateSessionConfig(yeaftDir, sessionId, partial);
    const effectiveBaseConfig = session?.config || loadConfig({ dir: yeaftDir });
    // The write above is the source of truth. Merge it directly instead of
    // reopening the file so cached engines cannot observe an unrelated stale
    // read between persistence and publication.
    const sessionConfig = resolveSessionConfig(effectiveBaseConfig, savedConfig);
    const publishedSessionConfig = sessionConfig.dir || !effectiveBaseConfig?.dir
      ? sessionConfig
      : { ...sessionConfig, dir: effectiveBaseConfig.dir };
    const prefix = `${sessionId}::`;
    for (const [key, engine] of vpEngines) {
      if (!key.startsWith(prefix)) continue;
      engine.refreshConfig?.(publishedSessionConfig);
      vpEngineConfigKeys.set(key, engineConfigKey(publishedSessionConfig));
    }
    // Do not invalidate the Session coordinator or abort active VP turns.
    // The next adapter loop sees this config; the stream already underway
    // completes with the values captured for that request.
    sendSessionCrudResult({ op: 'update_config', requestId, ok: true, sessionId, config: savedConfig });
    sendSessionSnapshotBroadcast();
  } catch (err) {
    sendSessionCrudResult({ op: 'update_config', requestId, ok: false, error: sessionErrorPayload(err) });
  }
}

export function handleYeaftArchiveSession(msg) {
  const requestId = msg && msg.requestId;
  // wire-compat: accept legacy `groupId` (see handleYeaftRenameSession).
  const sessionId = (msg && msg.sessionId) || null;
  try {
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    const result = archiveSession(yeaftDir, sessionId);
    projectContextBySession.delete(sessionId);
    invalidateGroupContext(sessionId, { abortRuntime: true });
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
  const sessionId = (msg && msg.sessionId) || null;
  try {
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    const result = deleteSession(yeaftDir, sessionId);
    projectContextBySession.delete(sessionId);
    removeSessionFromProjects(yeaftDir, sessionId);
    ctx.assetOutbox?.removeSession(sessionId);
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
    invalidateGroupContext(sessionId, { abortRuntime: true });
    const prefix = `${sessionId}::`;
    for (const k of Array.from(vpEngines.keys())) {
      if (k.startsWith(prefix)) {
        retireCachedVpEngine(k, { reason: 'session_deleted', rescue: false });
      }
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
  const sessionId = (msg && msg.sessionId) || null;
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
  const sessionId = (msg && msg.sessionId) || null;
  const vpId = msg && msg.vpId;
  try {
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    const group = removeMember(yeaftDir, sessionId, vpId);
    invalidateGroupContext(sessionId);
    // Also drop the kicked VP's thread engines — the next time they're
    // added back they should start with fresh per-thread state.
    const removedPrefix = `${sessionId}::${vpId}::`;
    for (const key of Array.from(vpEngines.keys())) {
      if (key.startsWith(removedPrefix)) {
        retireCachedVpEngine(key, { reason: 'session_member_removed', rescue: false });
      }
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
  const sessionId = (msg && msg.sessionId) || null;
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
    const vp = readConfiguredVp(vpId);
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

  if (s.taskManager && typeof s.taskManager.setEventSink === 'function') {
    s.taskManager.setEventSink((event) => {
      try {
        const sessionId = event?.task?.sessionId || event?.sessionId || null;
        sendSessionEvent(event, { sessionId });
        scheduleTaskResultReentry(event);
      } catch { /* never let task event delivery throw */ }
    });
  }

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
        sendSessionEvent(evt, tag);
      } else {
        const out = { type: 'dream_progress', ...evt };
        const tag = evt && evt.sessionId ? { sessionId: evt.sessionId } : {};
        sendSessionEvent(out, tag);
      }
    } catch { /* never let event delivery throw */ }
  };

  // Auto dream runs are triggered by the scheduler / nudges, not by the
  // manual `handleYeaftDreamTrigger` path. Without this terminal sink the UI
  // only saw progress debug events and could not restore the final dream
  // output after switching sessions. Manual runs keep using their explicit
  // handler below to avoid duplicate terminal events.
  s._dreamResultSink = async (result = {}) => {
    if (result?.trigger !== 'auto') return;
    const normalized = normalizeDreamResult(result);
    const processed = Array.isArray(result.sessions)
      ? result.sessions.filter(row => row && row.status === 'triaged' && row.sessionId)
      : [];
    for (const sessionRow of processed) {
      const sessionId = sessionRow.sessionId;
      const snapshot = await buildDreamOutputSnapshot(session, sessionId).catch(() => null);
      sendToServer({
        type: 'yeaft_dream_result',
        sessionId,
        ...result,
        ...normalized,
        snapshot,
      });
    }
  };

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

const STREAM_TEXT_BATCH_MAX_CHARS = 200;
const STREAM_TEXT_BATCH_MAX_MS = 200;

function createStreamTextBatch() {
  return {
    parts: [],
    charCount: 0,
    timer: null,
    envelope: null,
    immediateNext: true,
  };
}

function getStreamTextBatch(hctx) {
  if (!hctx) return null;
  if (!hctx.streamTextBatch) hctx.streamTextBatch = createStreamTextBatch();
  return hctx.streamTextBatch;
}

function clearStreamTextBatchTimer(batch) {
  if (!batch?.timer) return;
  clearTimeout(batch.timer);
  batch.timer = null;
}

function sendAssistantTextFrame(text, envelope) {
  if (!text) return;
  sendSessionOutputFrame({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  }, envelope);
}

function flushStreamTextBatch(hctx, envelope, { resetImmediate = false } = {}) {
  const batch = hctx?.streamTextBatch;
  if (!batch) return false;
  clearStreamTextBatchTimer(batch);
  const text = batch.parts.join('');
  batch.parts = [];
  batch.charCount = 0;
  const flushEnvelope = envelope || batch.envelope;
  batch.envelope = flushEnvelope || null;
  if (resetImmediate) batch.immediateNext = true;
  if (!text) return false;
  sendAssistantTextFrame(text, flushEnvelope);
  return true;
}

function scheduleStreamTextBatchFlush(hctx, batch) {
  if (!hctx || batch.timer) return;
  batch.timer = setTimeout(() => {
    batch.timer = null;
    flushStreamTextBatch(hctx, batch.envelope);
  }, STREAM_TEXT_BATCH_MAX_MS);
  if (batch.timer && typeof batch.timer.unref === 'function') {
    batch.timer.unref();
  }
}

function queueStreamTextDelta(hctx, text, envelope) {
  if (typeof text !== 'string' || text.length === 0) return;
  const batch = getStreamTextBatch(hctx);
  if (!batch) {
    sendAssistantTextFrame(text, envelope);
    return;
  }

  batch.envelope = envelope;
  if (batch.immediateNext) {
    batch.immediateNext = false;
    sendAssistantTextFrame(text, envelope);
    return;
  }

  batch.parts.push(text);
  batch.charCount += text.length;
  if (batch.charCount >= STREAM_TEXT_BATCH_MAX_CHARS) {
    flushStreamTextBatch(hctx, envelope);
    return;
  }
  scheduleStreamTextBatchFlush(hctx, batch);
}

/**
 * Handle a single engine event unwrapped from an `engine_event` envelope.
 * Stamps threadId on every outgoing frame so frontend grouping, tools,
 * todos, debug cards, and persistence all share the same boundary.
 *
 * @param {object} event — engine event (text_delta / tool_call / …)
 * @param {{assistantTextParts:string[], toolCallsAccum:Array, toolResultsAccum:Array, thinkingBlocksAccum?:Array, resetQueryTimer:Function, pauseQueryTimer?:Function, markEngineTerminal?:Function, sessionId?:string, vpId?:string, turnId?:string}} hctx
 */
export function __testHandleEngineEvent(event, hctx) {
  return handleEngineEvent(event, hctx);
}

function handleEngineEvent(event, hctx) {
  const terminalTurnEnd = event.type === 'turn_end' && event.terminal === true;
  const managesQueryTimer = terminalTurnEnd
    || event.type === 'tool_start'
    || event.type === 'tool_end'
    || event.type === 'async_task_wait_start'
    || event.type === 'async_task_wait_end'
    || event.type === 'llm_retry';
  if (!managesQueryTimer) hctx.resetQueryTimer();
  const envelope = {
    sessionId: hctx.sessionId,
    vpId: hctx.vpId,
    turnId: hctx.turnId,
    threadId: hctx.threadId || event.threadId,
  };

  if (event.type !== 'text_delta') {
    // Preserve wire order. Any boundary/metadata/tool event must see all text
    // accepted before it flushed first; otherwise the browser can render a tool
    // call or terminal result before the text that led to it.
    flushStreamTextBatch(hctx, envelope, { resetImmediate: true });
  }

  switch (event.type) {
    case 'text_delta':
      hctx.assistantTextParts.push(event.text);
      queueStreamTextDelta(hctx, event.text, envelope);
      // vp-status: first text-delta of a (thinking|tool) phase flips
      // the row to 'streaming'. transition() is a no-op when already
      // streaming, so subsequent deltas are cheap.
      maybeTransitionVpStatus(hctx, 'streaming');
      break;

    case 'thinking_delta':
      sendSessionEvent({ type: 'thinking_delta', text: event.text }, envelope);
      break;

    case 'thinking_block_end':
      // task-327d: capture the assembled thinking block (with server-
      // signed signature) so the group history we hand to subsequent
      // turns / VPs includes it. Without this echo Anthropic 400s the
      // next request with "content[].thinking in the thinking mode must
      // be passed back to the API". The signature stays server-side
      // only — wire serializers (stripMetaForWire / sendSessionOutputFrame)
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
      sendSessionOutputFrame({
        type: 'assistant',
        message: { content: [] },
      }, envelope);
      sendSessionOutputFrame({
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
      // ToolRegistry and individual tools own their execution deadlines. The
      // bridge watchdog only protects provider silence; leaving it armed here
      // races legitimate long tools and can abort the whole query just before
      // the tool returns a bounded error result for the model to handle.
      if (typeof hctx.pauseQueryTimer === 'function') hctx.pauseQueryTimer();
      sendSessionEvent({
        type: 'tool_start',
        id: event.id,
        name: event.name,
      }, envelope);
      break;

    case 'tool_end': {
      const images = Array.isArray(event.displayImages) ? event.displayImages : [];
      const displayOutput = typeof event.output === 'string' ? event.output : JSON.stringify(event.output ?? '');
      for (const image of images) {
        const persistedImage = imageMetadataForPersistence(image);
        try {
          if (!ctx.assetOutbox) throw new Error('asset outbox is unavailable');
          const deliveryId = ctx.assetOutbox.enqueue({
            conversationId: yeaftConversationId,
            metadata: persistedImage,
            sessionId: hctx.sessionId,
            vpId: hctx.vpId,
            turnId: hctx.turnId,
            threadId: hctx.threadId || event.threadId,
            image,
          });
          if (!deliveryId) throw new Error('asset outbox did not persist the image');
          image.deliveryQueued = true;
          ctx.assetOutbox.drain().catch(err => console.warn('[AssetOutbox] drain failed:', err?.message || err));
        } catch (err) {
          console.warn('[AssetOutbox] failed to queue image:', err?.message || err);
        }
      }
      if (hctx.toolResultsAccum) {
        hctx.toolResultsAccum.push({
          role: 'tool',
          toolCallId: event.id,
          content: displayOutput,
          isError: !!event.isError,
        });
      }
      if (hctx.sessionId && hctx.turnId && !hctx.skipPartialHistory) {
        const appendedPrompts = Array.isArray(hctx.appendedUserPrompts) ? hctx.appendedUserPrompts : [];
        const prompts = hctx.includeInitialPrompt && typeof hctx.prompt === 'string'
          ? [hctx.prompt, ...appendedPrompts]
          : appendedPrompts;
        appendTurnToSessionHistory(
          hctx.sessionId,
          hctx.threadId || event.threadId || 'main',
          hctx.vpId,
          prompts,
          hctx.assistantTextParts || [],
          hctx.toolCallsAccum || [],
          hctx.toolResultsAccum || [],
          hctx.thinkingBlocksAccum || [],
          { turnId: hctx.turnId, partial: true },
        );
      }
      sendSessionOutputFrame({
        type: 'user',
        userAuthored: false,
        tool_use_result: [{
          type: 'tool_result',
          tool_use_id: event.id,
          content: displayOutput,
          is_error: event.isError || false,
        }],
      }, envelope);
      // Tool execution is over, so the next silent phase is provider work
      // again. Re-arm the provider watchdog before waiting for the next event.
      if (typeof hctx.resetQueryTimer === 'function') hctx.resetQueryTimer();
      // Do NOT speculatively flip to 'thinking' — the engine may emit more
      // text-deltas (→ 'streaming') OR go straight to end_turn (→ 'idle' via
      // runVpTurn's finally). Hold the 'tool' state until a real event arrives.
      break;
    }

    case 'tool_result_update': {
      const content = typeof event.content === 'string'
        ? event.content
        : JSON.stringify(event.content ?? '');
      if (hctx.toolResultsAccum && event.toolCallId) {
        const idx = hctx.toolResultsAccum.findIndex((tr) => tr.toolCallId === event.toolCallId);
        if (idx >= 0) {
          const prior = hctx.toolResultsAccum[idx].content || '';
          hctx.toolResultsAccum[idx] = {
            ...hctx.toolResultsAccum[idx],
            content: `${prior}\n\n${content}`,
          };
        }
      }
      sendSessionOutputFrame({
        type: 'user',
        userAuthored: false,
        tool_use_result: [{
          type: 'tool_result',
          tool_use_id: event.toolCallId,
          content,
          is_update: true,
          task_id: event.taskId || null,
        }],
      }, envelope);
      break;
    }

    case 'turn_start':
    case 'stop':
      // No UI action needed; outer loop sends the final result.
      break;

    case 'aborted':
      if (typeof hctx.markEngineTerminal === 'function') {
        hctx.markEngineTerminal('aborted', { reason: event.reason || 'external' });
      }
      break;

    case 'turn_end':
      // Most engine turn_end events are internal loop boundaries. Only the
      // explicit terminal event precedes post-turn persistence/maintenance;
      // stop the user-query silence watchdog before that best-effort work.
      if (event.terminal && typeof hctx.pauseQueryTimer === 'function') {
        hctx.pauseQueryTimer();
      }
      // A normal tool_use stop means "run tools, then call the adapter again",
      // so it must NOT end the VP's visible turn. An aborted turn is terminal
      // too, but the outer runVpTurn boundary owns its single stopped result
      // and vp_turn_end emission.
      if (event.stopReason === 'aborted') {
        if (typeof hctx.markEngineTerminal === 'function') {
          hctx.markEngineTerminal('aborted', event.detail || null);
        }
        break;
      }
      if (event.stopReason === 'error') {
        if (typeof hctx.markEngineTerminal === 'function') {
          hctx.markEngineTerminal('error', hctx.lastEngineErrorDetail || event.detail || null);
        }
        break;
      }
      // route_forward is different: the tool has handed control to another
      // VP and Engine.query will not stream more text for this VP. Settle the
      // current VP immediately so the roster row does not sit on "thinking"
      // until later result cleanup.
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
        sendSessionEvent({
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
      sendSessionEvent({
        type: 'context_usage',
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheReadTokens: event.cacheReadTokens || 0,
        cacheWriteTokens: event.cacheWriteTokens || 0,
        totalInputTokens: (event.inputTokens || 0) + (event.cacheReadTokens || 0) + (event.cacheWriteTokens || 0),
      }, envelope);
      break;

    case 'recall':
      sendSessionEvent({
        type: 'recall',
        entryCount: event.entryCount,
        cached: event.cached,
      }, envelope);
      break;

    case 'fallback':
      sendSessionEvent({
        type: 'fallback',
        from: event.from,
        to: event.to,
        reason: event.reason,
      }, envelope);
      break;

    case 'llm_retry':
      // Engine is intentionally sleeping before the next provider request.
      // Silence watchdogs protect active calls, not declared retry waits.
      if (typeof hctx.pauseQueryTimer === 'function') hctx.pauseQueryTimer();
      maybeTransitionVpStatus(hctx, 'retrying');
      // Engine paused before re-issuing the same turn because the LLM
      // returned a retryable error (rate limit / 5xx / transient network /
      // stream idle timeout). Surface to the client so the UI can show
      // "retrying in Xs (1/3)"
      // instead of looking frozen mid-turn.
      sendSessionEvent({
        type: 'llm_retry',
        attempt: event.attempt,
        maxRetries: event.maxRetries,
        delayMs: event.delayMs,
        reason: event.reason,
        recoveryMode: event.recoveryMode || 'restart',
        errorName: event.errorName,
        statusCode: event.statusCode,
        message: event.message,
      }, envelope);
      break;

    case 'reflection':
      sendSessionEvent({
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
      sendSessionEvent({
        type: 'turn_open',
        turnId: event.turnId,
        userPrompt: event.userPrompt,
        vpId: event.vpId,
        sessionId: event.sessionId,
        at: event.at,
      }, envelope);
      break;

    case 'turn_close':
      recordAgentTurn('yeaft');
      sendSessionEvent({
        type: 'turn_close',
        turnId: event.turnId,
        threadId: event.threadId,
        totalMs: event.totalMs,
        totalTokens: event.totalTokens,
        loopCount: event.loopCount,
        ts: Date.now(),
      }, envelope);
      break;

    case 'memory_used':
      sendSessionEvent({
        type: 'memory_used',
        turnId: event.turnId,
        loaded: event.loaded || [],
        meta: event.meta || null,
      }, envelope);
      break;

    case 'dream_memory_loaded':
      sendSessionEvent({
        type: 'dream_memory_loaded',
        turnId: event.turnId,
        vpId: event.vpId || null,
        sessionId: event.sessionId || null,
        loadedInto: event.loadedInto || 'system_prompt.memory',
        resident: Array.isArray(event.resident) ? event.resident : [],
      }, envelope);
      break;

    case 'memory_adjust':
      sendSessionEvent({
        type: 'memory_adjust',
        turnId: event.turnId,
        sessionKey: event.sessionKey,
        added: event.added,
        evicted: event.evicted,
        skipped: event.skipped,
        reason: event.reason,
      }, envelope);
      break;

    case 'user_append':
      if (hctx && Array.isArray(hctx.appendedUserPrompts) && event.preview && !event.internal) {
        hctx.appendedUserPrompts.push(String(event.preview));
      }
      sendSessionEvent({
        type: 'vp_thread_user_append_consumed',
        turnId: event.turnId,
        threadId: event.threadId,
        loopNumber: event.loopNumber,
        preview: event.preview,
        ts: Date.now(),
      }, envelope);
      break;

    case 'tool_exec':
      // Full tool output is already durable in the file-backed debug trace and
      // is fetched on demand when the user opens this Turn. Do not mirror it
      // into the always-on browser store: a long-lived tab otherwise retains
      // every large Bash/FileRead result even while the debug panel is closed.
      sendSessionEvent({
        type: 'tool_exec',
        turnId: event.turnId,
        loopNumber: event.loopNumber,
        callId: event.callId,
        name: event.name,
        durationMs: event.durationMs,
        isError: event.isError,
      }, envelope);
      break;

    // Same-turn result-producing task wait. Engine parks at end_turn while a
    // registered child task is still running and re-enters the same turn when
    // the terminal event arrives. Persistent shell tasks are status-only and
    // never emit this wait edge (see engine.js
    // `#runQuery` wait block). Bridge forwards both edges so the debug
    // panel (and any other in-process subscriber) can render the park
    // window with the live list of pending taskIds. Wire types stay
    // namespaced under `vp_async_task_*` to match the existing
    // `vp_thread_*` / `vp_typing_*` event family.
    case 'async_task_wait_start':
      // The engine is intentionally parked on a tracked background task, not
      // waiting on the LLM. Pause the LLM-silence watchdog until the task (or
      // an explicit abort) wakes the turn.
      if (typeof hctx.pauseQueryTimer === 'function') hctx.pauseQueryTimer();
      sendSessionEvent({
        type: 'vp_async_task_wait_start',
        turnId: event.turnId,
        threadId: event.threadId,
        loopNumber: event.loopNumber,
        pendingTaskIds: Array.isArray(event.pendingTaskIds) ? event.pendingTaskIds : [],
        ts: Date.now(),
      }, envelope);
      break;

    case 'async_task_wait_end':
      if (event.timedOut) {
        console.warn(
          '[Yeaft] same-turn async task wait timed out; continuing the VP turn and deferring task results:',
          Array.isArray(event.deferredTaskIds) ? event.deferredTaskIds : [],
        );
      }
      if (!event.aborted && typeof hctx.resetQueryTimer === 'function') hctx.resetQueryTimer();
      sendSessionEvent({
        type: 'vp_async_task_wait_end',
        turnId: event.turnId,
        threadId: event.threadId,
        loopNumber: event.loopNumber,
        aborted: Boolean(event.aborted),
        remainingTaskIds: Array.isArray(event.remainingTaskIds) ? event.remainingTaskIds : [],
        timedOut: Boolean(event.timedOut),
        deferredTaskIds: Array.isArray(event.deferredTaskIds) ? event.deferredTaskIds : [],
        ts: Date.now(),
      }, envelope);
      break;

    case 'loop':
      // Live clients only need bounded summary metadata. The complete request,
      // response, prompt, messages, and tool calls are already persisted by
      // DebugTrace and fetched for one Turn on demand. Forwarding those growing
      // snapshots on every loop made a long-lived browser tab retain hundreds
      // of MiB (or GiB) while the debug panel was closed.
      sendSessionEvent({
        type: 'loop',
        turnId: event.turnId,
        loopNumber: event.loopNumber,
        model: event.model,
        usage: event.usage,
        latencyMs: event.latencyMs,
        ttfbMs: event.ttfbMs,
        stopReason: event.stopReason,
        at: event.at,
      }, envelope);
      break;

    case 'error': {
      // Engine retry exhaustion is an event terminal, not a thrown exception.
      // Move the broker out of its running-only `retrying` state here so
      // reconnect snapshots cannot resurrect a finished Session as active.
      maybeTransitionVpStatus(hctx, 'error');
      const errMsg = event.error?.message || 'Unknown error';
      const retryAttempts = Number.isFinite(event.retryAttempts) ? event.retryAttempts : 0;
      const exhaustedIdle = event.reason === 'stream_idle_timeout' && event.retryExhausted;
      const contentPolicyDenied = event.reason === 'content_policy_denied'
        || event.error?.reasonCode === 'content_policy_denied';
      const visibleErrMsg = contentPolicyDenied
        ? 'Provider blocked this request for content-safety reasons after one safe recovery attempt. Continue and ask the VP to avoid repeating sensitive payloads, credentials, tokens, or exploit samples.'
        : exhaustedIdle && retryAttempts > 0
          ? `${errMsg} after ${retryAttempts} fresh request retries`
          : errMsg;
      hctx.lastEngineErrorDetail = {
        message: visibleErrMsg,
        ...(event.reason ? { reason: event.reason } : {}),
        ...(event.retryExhausted !== undefined ? { retryExhausted: !!event.retryExhausted } : {}),
        ...(Number.isFinite(event.retryAttempts) ? { retryAttempts: event.retryAttempts } : {}),
        ...(Number.isFinite(event.maxRetries) ? { maxRetries: event.maxRetries } : {}),
      };
      sendSessionEvent({
        type: 'error',
        message: visibleErrMsg,
        errorName: event.error?.name || null,
        statusCode: event.error?.statusCode ?? null,
        reasonCode: event.error?.reasonCode || null,
        provider: event.error?.provider || null,
        model: event.error?.model || null,
        credentialRefreshable: event.error?.credentialRefreshable === true,
        retryable: !!event.retryable,
        ...(event.reason ? { reason: event.reason } : {}),
        ...(event.retryExhausted !== undefined ? { retryExhausted: !!event.retryExhausted } : {}),
        ...(Number.isFinite(event.retryAttempts) ? { retryAttempts: event.retryAttempts } : {}),
        ...(Number.isFinite(event.maxRetries) ? { maxRetries: event.maxRetries } : {}),
      }, envelope);
      if (isPermissionErrorMsg(errMsg)) {
        if (!_permissionDiagnosticSent) {
          _permissionDiagnosticSent = true;
          sendSessionOutputFrame({
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
        sendSessionOutputFrame({
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: `⚠️ Error: ${visibleErrMsg}` }],
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
async function runYeaftSessionSend(msg) {
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
  const quote = normalizeSessionMessageQuote(msg.quote);
  const sessionId = (typeof msg.sessionId === 'string' && msg.sessionId.trim())
    ? msg.sessionId.trim()
    : 'grp_default';
  const perfTraceId = typeof msg.perfTraceId === 'string' && msg.perfTraceId.trim()
    ? msg.perfTraceId.trim()
    : null;
  const perfStart = perfNowMs();
  const tracePerf = (phase, extra = {}) => {
    if (!perfTraceId) return;
    recordAgentPerfTrace(ctx.CONFIG, {
      traceId: perfTraceId,
      phase,
      sessionId,
      messageType: msg.type,
      ...extra,
    });
  };
  const traceDuration = (phase, start, extra = {}) => {
    tracePerf(phase, {
      durationMs: perfNowMs() - start,
      ...extra,
    });
  };
  tracePerf('session_send.received', {
    turnId: typeof msg.id === 'string' ? msg.id : null,
    detail: {
      mentionCount: mentions.length,
      attachmentCount: Array.isArray(msg.files) ? msg.files.length : 0,
    },
  });

  // yeaftDir is a hard prerequisite for both session boot and group seeding;
  // validate BEFORE booting so a misconfigured agent doesn't leave a zombie
  // session lying around.
  const yeaftDir = ctx.CONFIG?.yeaftDir;
  if (!yeaftDir) {
    sendSessionOutputFrame({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '⚠️ Yeaft session error: no yeaft directory configured.' }] },
    }, { sessionId });
    sendSessionOutputFrame({ type: 'result', result_text: '' }, { sessionId });
    return;
  }

  // Open the user-level session metadata first so project runtime loading can
  // use the stored workDir without blocking the user-message hot path. If
  // metadata is missing we still boot the agent runtime for a useful error
  // response, then fail on the session open check.
  let sessionHandle = null;
  let sessionRoot = null;
  let sessionMetaForRuntime = null;
  const openSessionStart = perfNowMs();
  try {
    sessionRoot = sessionsRoot(yeaftDir);
    const dir = join(sessionRoot, sessionId);
    if (existsSync(dir) && loadSessionMeta(dir)) {
      sessionHandle = openSession(sessionRoot, sessionId);
      sessionMetaForRuntime = sessionHandle.getMeta();
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
  traceDuration('session_send.open_session', openSessionStart, { ok: !!sessionHandle });

  const ensureSessionStart = perfNowMs();
  await ensureSessionLoaded({ sessionMeta: sessionMetaForRuntime, perfTraceId });
  if (!sessionHandle) {
    try {
      const dir = join(sessionRoot, sessionId);
      if (existsSync(dir) && loadSessionMeta(dir)) {
        sessionHandle = openSession(sessionRoot, sessionId);
        sessionMetaForRuntime = sessionHandle.getMeta();
      }
    } catch (err) {
      console.warn('[Yeaft] yeaft_session_chat: migrated session reopen failed', err?.message || err);
    }
  }
  scheduleProjectRuntimeLoad(sessionMetaForRuntime?.workDir);
  traceDuration('session_send.ensure_session_loaded', ensureSessionStart);


  if (!sessionHandle) {
    sendSessionOutputFrame({
      type: 'assistant',
      message: { content: [{ type: 'text', text: `⚠️ Session ${sessionId} not found.` }] },
    }, { sessionId });
    sendSessionOutputFrame({ type: 'result', result_text: '' }, { sessionId });
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
          const vp = readConfiguredVp(vpId);
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
  // isImage } via the client-conversation.js relay
  // for `yeaft_*`). We persist files to disk under the agent's CWD so
  // file-tools (file-read / bash) can pick them up with relative paths,
  // and we build per-image content blocks for the LLM call. The
  // resolved metadata WITHOUT base64 rides on coord.ingest meta so it
  // shows up in the persisted group log and on the envelope every VP
  // driver receives.
  const inboundFiles = Array.isArray(msg.files) ? msg.files : [];
  let attachmentBundle = { promptAttachments: [], promptSuffix: '', promptParts: [], failed: [] };
  const attachmentsStart = perfNowMs();
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
    sendSessionOutputFrame({
      type: 'assistant',
      message: { content: [{ type: 'text', text: `⚠️ ${attachmentBundle.failed.length} file(s) could not be attached:\n${detail}` }] },
    }, { sessionId });
  }
  const persistedAttachments = attachmentsForPersistence(attachmentBundle.promptAttachments);
  traceDuration('session_send.attachments', attachmentsStart, {
    detail: {
      inputFileCount: inboundFiles.length,
      persistedFileCount: persistedAttachments.length,
      failedFileCount: Array.isArray(attachmentBundle.failed) ? attachmentBundle.failed.length : 0,
    },
  });

  const hasInboundProjectContext = Object.prototype.hasOwnProperty.call(msg, 'projectContext');
  const inboundProjectContext = normalizeProjectContext(msg.projectContext, sessionId);
  if (hasInboundProjectContext) {
    projectContextBySession.set(sessionId, inboundProjectContext || {
      projectId: null,
      projectName: null,
      projectInstruction: '',
      sessionIds: [],
    });
  } else {
    // An old Server does not know this field. Drop any context cached from a
    // newer Server before falling back to this Agent's legacy projects.json.
    projectContextBySession.delete(sessionId);
  }

  // Ingest user text. The coordinator persists, applies mention/fanout
  // rules, and calls deliver() (== enqueueForVp) for each chosen VP —
  // which both (a) emits vp_typing_start and (b) ensures a driver runs.
  let report;
  const ingestStart = perfNowMs();
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
        ...(quote ? { quote } : {}),
        clientMessageId: typeof msg.id === 'string' && msg.id ? msg.id : null,
      },
      // Live form — adapters need the base64 image blocks; runVpTurn
      // reads `_promptParts` off the envelope rather than going
      // back to disk on every fan-out target. NOT persisted.
      _promptParts: attachmentBundle.promptParts,
      _promptSuffix: attachmentBundle.promptSuffix,
      _perfTraceId: perfTraceId,
      _projectContext: msg.projectContext && typeof msg.projectContext === 'object'
        ? msg.projectContext
        : null,
    });
  } catch (err) {
    console.warn('[Yeaft] yeaft_session_chat: coord.ingest failed', err?.message || err);
    sendSessionOutputFrame({
      type: 'assistant',
      message: { content: [{ type: 'text', text: `⚠️ Session dispatch error: ${err?.message || err}` }] },
    }, { sessionId });
    sendSessionOutputFrame({ type: 'result', result_text: '' }, { sessionId });
    return;
  }

  traceDuration('session_send.coordinator_ingest', ingestStart, {
    turnId: report?.message?.id || null,
    detail: {
      dispatchedCount: Array.isArray(report?.dispatched) ? report.dispatched.length : 0,
      fallback: typeof report?.fallback === 'string' ? report.fallback : null,
    },
  });

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
    sendSessionOutputFrame({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '⚠️ No VP available to respond — check the group roster.' }] },
    }, { sessionId });
    sendSessionOutputFrame({ type: 'result', result_text: '' }, { sessionId });
    return;
  }

  // Wait only for routing/classification promises spawned by this message.
  // Do not wait for every driver in the group: unrelated older threads may keep
  // running for minutes and must not hold this request lifecycle hostage.
  const routeWaitStart = perfNowMs();
  await waitForRoutePromises(report?.message?.id);
  traceDuration('session_send.wait_route_promises', routeWaitStart, {
    turnId: report?.message?.id || null,
  });
  traceDuration('session_send.handler_total', perfStart, {
    turnId: report?.message?.id || null,
    ok: true,
  });

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
function resolveCollabToolPolicy(sessionMeta) {
  if (!sessionMeta || typeof sessionMeta !== 'object' || !Array.isArray(sessionMeta.roster)) {
    return null;
  }
  const vpCount = new Set(sessionMeta.roster.filter(v => typeof v === 'string' && v.trim())).size;
  return vpCount > 1 ? COLLAB_TOOL_POLICY.MULTI_VP : COLLAB_TOOL_POLICY.SINGLE_VP;
}

export function buildVpQueryOpts({ vpId, sessionCoordinator, sessionId, envelope, threadId = 'main', turnId = null }) {
  // Read the session meta once and reuse for defaultVpId fallback,
  // announcement injection, and roster prompt context. Calling getMeta()
  // twice per turn is wasteful — and (more importantly) opens a window
  // where a concurrent session edit
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
      const lib = scanConfiguredVpLibrary();
      if (Array.isArray(lib) && lib.length > 0 && lib[0].id) {
        resolvedVpId = lib[0].id;
      }
    } catch { /* library scan is best-effort */ }
  }
  if (!resolvedVpId) return undefined;

  const out = { senderVpId: resolvedVpId, threadId: threadId || 'main' };
  if (typeof turnId === 'string' && turnId.trim()) out.vpTurnId = turnId.trim();
  if (typeof sessionId === 'string' && sessionId.trim()) {
    out.sessionId = sessionId.trim();
  }
  const collabToolPolicy = resolveCollabToolPolicy(sessionMeta);
  if (collabToolPolicy) out.collabToolPolicy = collabToolPolicy;
  if (sessionMeta && Array.isArray(sessionMeta.roster)) {
    out.sessionMembers = sessionMeta.roster
      .filter(v => typeof v === 'string' && v.trim())
      .map(v => v.trim());
  }
  // task-334-session-editor: surface the session announcement to the engine so
  // buildWorkerPrompt can inject it as a CLAUDE.md-style shared prefix.
  // Empty/missing reads as '' and prompts.js skips the section.
  if (sessionMeta && typeof sessionMeta.announcement === 'string') {
    out.sessionAnnouncement = sessionMeta.announcement;
  }
  // Surface the session's configured working directory so the engine can
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
      out.router = createRouter({
        coordinator: sessionCoordinator,
      });
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
 * Lazy session boot. Idempotent: concurrent callers share one in-flight promise.
 * Emits `session_ready` on first init so the frontend can finalize its handshake.
 *
 * @param {{ workDir?: string, sessionId?: string|null, sessionMeta?: object, perfTraceId?: string|null, messageType?: string }} [opts]
 * @returns {Promise<import('./session.js').Session>}
 */
export async function ensureSessionLoaded(opts = {}) {
  if (session) return session;
  if (sessionLoadPromise) return sessionLoadPromise;

  sessionLoadPromise = (async () => {
    const bootConfigRevision = sessionConfigRefreshRevision;
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    const normalizedWorkDir = normalizeSessionWorkDir(opts?.workDir || opts?.sessionMeta?.workDir);
    session = await loadRuntimeSession({
      ...(yeaftDir && { dir: yeaftDir }),
      ...(normalizedWorkDir && { workDir: normalizedWorkDir }),
      skipMCP: true,
      skipSkills: true,
      serverMode: true,
      managedCliReady: ctx.managedCliReady,
      workCenterEnabled: ctx.CONFIG?.workCenterEnabled === true,
    });
    claimRuntimeOwnership(session);

    installYeaftRuntimeBridge(session);
    // A save may complete after loadSession read config.json but before this
    // runtime became visible. Refresh before any status/session_ready emit.
    if (sessionConfigRefreshRevision !== bootConfigRevision) {
      await refreshLiveSessionConfig();
    }

    try {
      if (session.engine && typeof session.engine.setSubAgentEventSink === 'function') {
        session.engine.setSubAgentEventSink((agentId, evt) => {
          try {
            sendSessionEvent({ type: 'sub_agent_event', agentId, payload: evt });
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

    ensureYeaftConversationId();
    scheduleBaseRuntimeLoad();
    let bootProjectRuntime = normalizedWorkDir ? projectRuntimes.get(projectRuntimeKey(normalizedWorkDir)) || null : null;
    if (normalizedWorkDir && !bootProjectRuntime) {
      scheduleProjectRuntimeLoad(normalizedWorkDir);
      bootProjectRuntime = projectRuntimes.get(projectRuntimeKey(normalizedWorkDir)) || null;
    }
    const bootStatus = mergedStatusForProjectRuntime(bootProjectRuntime);
    hydrateYeaftStatusFromSession({ ...session, status: bootStatus }, { reason: 'session_ready', emitEvent: true });
    if (bootProjectRuntime) broadcastSkillSlashCommands({ skillManager: bootProjectRuntime.skillManager });
    else broadcastSkillSlashCommands(session);

    // Per-group history is hydrated lazily on first `getOrCreateSessionHistory`
    // — there's no global "all conversations" tape any more.

    sendSessionEvent({
      type: 'session_ready',
      conversationId: yeaftConversationId,
      model: session.config.primaryModel || session.config.model,
      modelEffort: session.config.modelEffort || null,
      availableModels: session.config.availableModels || [],
      skills: bootStatus.skills,
      mcpServers: bootStatus.mcpServers,
      tools: bootStatus.tools,
      yeaftDir: ctx.CONFIG?.yeaftDir || null,
      tasks: session.taskManager ? session.taskManager.listActiveTasks() : [],
    }, {
      sessionId: opts?.sessionMeta?.id || opts?.sessionId || null,
      perfTraceId: opts?.perfTraceId || null,
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

    return session;
  })();

  try {
    return await sessionLoadPromise;
  } catch (err) {
    await shutdownProjectRuntimes();
    session = null;
    throw err;
  } finally {
    sessionLoadPromise = null;
  }
}

function startSessionLoadInBackground({ sessionId = null, sessionMeta = null, perfTraceId = null, traceDuration = null, tracePerf = null, phase = 'history.load_session_runtime' } = {}) {
  if (session) return null;
  const start = perfNowMs();
  const promise = ensureSessionLoaded({ sessionId, sessionMeta, perfTraceId })
    .then(async (loaded) => {
      if (typeof traceDuration === 'function') traceDuration(phase, start, { detail: { background: true } });
      if (sessionId && loaded?.conversationStore) {
        const hydrateStart = perfNowMs();
        setGroupHistory(sessionId, hydrateGroupHistory(sessionId));
        if (typeof traceDuration === 'function') traceDuration('history.hydrate_group_history', hydrateStart, { detail: { background: true } });
        sendDreamSnapshotForSession(sessionId, { trigger: 'load_history' }).catch(() => null);
      }
      return loaded;
    })
    .catch((err) => {
      if (typeof tracePerf === 'function') {
        tracePerf('history.load_session_runtime_error', {
          ok: false,
          detail: { background: true, errorName: err?.name || null, errorMessage: err?.message || String(err) },
        });
      }
      console.warn('[Yeaft] background session load failed:', err?.message || err);
      return null;
    });
  return promise;
}

/**
 * Wrap {@link runVpTurn} with a second-stage abort escalation.
 *
 * The in-turn watchdog is activity based: every engine event resets its
 * silence timer, and only a genuinely silent turn calls `vpAbort.abort()`.
 * This wrapper must therefore start its grace period from that abort signal,
 * not from turn enqueue. A fixed enqueue deadline incorrectly terminates
 * healthy long-running turns even while the LLM and tools keep making
 * progress.
 *
 * If an adapter or tool ignores AbortSignal and the turn still has not
 * returned after {@link ESCALATE_AFTER_ABORT_MS}, emit one synthetic terminal
 * result and unblock the per-VP driver. The dangling promise may eventually
 * settle, so `escalationState` prevents it from emitting a second terminal
 * result or overwriting the state of a newer turn.
 */
async function runVpTurnWithEscalation(args) {
  const { sessionId, vpId, turnId, threadId, thread, vpAbort } = args;
  const escalationState = { escalated: false, terminalEmitted: false };

  await raceWithEscalation(runVpTurn({ ...args, escalationState }), {
    signal: vpAbort?.signal,
    graceMs: ESCALATE_AFTER_ABORT_MS,
    onEscalate: () => {
      if (escalationState.escalated) return;
      revokeTurnRepoApproval(turnId);
      escalationState.escalated = true;
      escalationState.terminalEmitted = true;
      console.error(
        `[Yeaft] runVpTurn abort escalation: session=${sessionId || ''} vp=${vpId || ''} thread=${threadId || 'main'} turn=${turnId || ''} did not return ${ESCALATE_AFTER_ABORT_MS}ms after abort — emitting synthetic stop and unblocking driver`,
      );
      try {
        sendSessionOutputFrame(
          { type: 'result', result_text: '', stopped: true },
          { sessionId, vpId, turnId, threadId },
        );
      } catch { /* never crash WS pipeline */ }
      if (ctx.CONFIG) {
        recordAgentPerfTrace(ctx.CONFIG, {
          traceId: turnId || `abort-${Date.now()}`,
          phase: 'vp.abort_escalation',
          sessionId,
          vpId,
          turnId,
          threadId: threadId || 'main',
          ok: false,
          detail: { graceMs: ESCALATE_AFTER_ABORT_MS },
        });
      }
      try {
        sendSessionEvent({
          type: 'vp_turn_end',
          sessionId,
          vpId,
          threadId: threadId || 'main',
          turnId,
          reason: 'aborted',
          detail: { reason: 'abort_escalation', graceMs: ESCALATE_AFTER_ABORT_MS },
          ts: Date.now(),
        }, { sessionId, vpId, threadId: threadId || 'main', turnId });
      } catch { /* never crash WS pipeline */ }
      try {
        getVpStatusBroker().settleIdle({ sessionId, vpId, threadId: threadId || 'main', title: thread?.title || '' });
      } catch (err) {
        console.warn('[Yeaft] vp-status settleIdle (abort escalation) failed:', err?.message || err);
      }
      const staleEngine = escalationState.engine || null;
      const engineKey = escalationState.engineKey || threadKey(sessionId, vpId, threadId);
      if (staleEngine) {
        retireCachedVpEngine(engineKey, {
          reason: 'abort_escalation',
          rescue: true,
          expectedEngine: staleEngine,
        });
      }
      if (thread?.engine === staleEngine) thread.engine = null;
      if (thread) {
        thread.status = 'idle';
        thread.updatedAt = Date.now();
      }
    },
  });
}

/**
 * Race `inner` against a grace timer that starts only after `signal` aborts.
 * Resolving or rejecting `inner` first removes the abort listener and timer.
 * If the grace timer wins, `onEscalate` is called synchronously and the
 * wrapper resolves; the underlying promise remains observed by
 * `Promise.race`, so a later rejection cannot become unhandled.
 *
 * @template T
 * @param {Promise<T>} inner
 * @param {{ signal?: AbortSignal, graceMs: number, onEscalate: () => void }} opts
 * @returns {Promise<T|void>}
 */
async function raceWithEscalation(inner, { signal, graceMs, onEscalate }) {
  let escalationTimer = null;
  let settled = false;
  let scheduleEscalation = null;

  const escalation = new Promise((resolve) => {
    scheduleEscalation = () => {
      if (settled || escalationTimer) return;
      escalationTimer = setTimeout(() => {
        escalationTimer = null;
        try { onEscalate(); } catch { /* never throw out of the watchdog */ }
        resolve();
      }, Math.max(0, Number(graceMs) || 0));
      if (escalationTimer && typeof escalationTimer.unref === 'function') {
        escalationTimer.unref();
      }
    };

    if (signal?.aborted) {
      scheduleEscalation();
    } else if (signal) {
      signal.addEventListener('abort', scheduleEscalation, { once: true });
    }
  });

  try {
    return await Promise.race([inner, escalation]);
  } finally {
    settled = true;
    if (escalationTimer) clearTimeout(escalationTimer);
    if (signal && scheduleEscalation) {
      signal.removeEventListener('abort', scheduleEscalation);
    }
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
 * `#pendingT2`, `#abortReason`, `#adjustRanBySession`, `#execLog`) does not
 * collide when VP-A and VP-B run concurrent turns.
 *
 * @param {{ prompt: string, sessionId: string, vpId: string, turnId: string, envelope: object, vpAbort: AbortController, baseSnapshot: Array }} args
 */
async function runVpTurn({ prompt, promptParts = null, sessionId, vpId, threadId = 'main', thread = null, turnId, envelope: inboundEnvelope, vpAbort, baseSnapshot, escalationState = null }) {
  if (!prompt?.trim()) return;

  const perfTraceId = typeof inboundEnvelope?._perfTraceId === 'string' && inboundEnvelope._perfTraceId.trim()
    ? inboundEnvelope._perfTraceId.trim()
    : (typeof inboundEnvelope?.perfTraceId === 'string' && inboundEnvelope.perfTraceId.trim()
      ? inboundEnvelope.perfTraceId.trim()
      : null);
  const envelope = { sessionId, vpId, threadId, turnId, ...(perfTraceId ? { perfTraceId } : {}) };
  const vpTurnPerfStart = perfNowMs();
  if (perfTraceId) {
    recordAgentPerfTrace(ctx.CONFIG, {
      traceId: perfTraceId,
      phase: 'vp.turn_start',
      sessionId,
      vpId,
      turnId,
      threadId,
      detail: { promptBytes: Buffer.byteLength(prompt || '') },
    });
  }

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
  let engineTerminalReason = null;
  let engineTerminalDetail = null;
  let handlerCtx = null;
  const markEngineTerminal = (reason, detail = null) => {
    engineTerminalReason = reason;
    if (detail) engineTerminalDetail = detail;
  };
  const markTurnEnd = (reason) => {
    turnEndEmitted = true;
    turnEndReason = reason;
    if (escalationState) escalationState.terminalEmitted = true;
  };
  const emitVpTurnEnd = (reason, detail = null) => {
    if (turnEndEmitted || escalationState?.terminalEmitted) return;
    turnEndEmitted = true;
    if (escalationState) escalationState.terminalEmitted = true;
    try {
      sendSessionEvent({
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
  const finishAbortedTurn = (detail = null) => {
    flushStreamTextBatch(handlerCtx, envelope, { resetImmediate: true });
    sendSessionOutputFrame({
      type: 'result',
      result_text: '',
      stopped: true,
    }, envelope);
    emitVpTurnEnd('aborted', detail);
  };

  try {
    if (session?.dreamScheduler) {
      session.dreamScheduler.noteUserMessage();
    }

    let queryTimer = null;
    const queryTimeoutMs = queryTimeoutMsForSession(sessionId);
    const pauseQueryTimer = () => {
      if (queryTimer) clearTimeout(queryTimer);
      queryTimer = null;
    };
    const resetQueryTimer = () => {
      pauseQueryTimer();
      queryTimer = setTimeout(() => {
        if (!vpAbort.signal.aborted) {
          console.error(`[Yeaft] query timeout after ${queryTimeoutMs / 1000}s of silence — aborting VP ${vpId}`);
          revokeTurnRepoApproval(turnId);
          try { vpAbort.abort(); } catch { /* best-effort */ }
        }
      }, queryTimeoutMs);
    };
    resetQueryTimer();

    // Emit turn_start so frontend can create the message block.
    sendSessionEvent({ type: 'vp_turn_start', vpId, threadId, turnId, sessionId, title: thread?.title || '' }, envelope);
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
        turnId,
      });
      if (queryOpts) {
        const envelopeProjectContext = normalizeProjectContext(inboundEnvelope?._projectContext, sessionId);
        const projectContext = envelopeProjectContext
          || projectContextBySession.get(sessionId)
          || legacyProjectContext(ctx.CONFIG?.yeaftDir, sessionId);
        const projectSessionIds = projectContext?.sessionIds || [];
        queryOpts.projectSessionIds = projectSessionIds;
        queryOpts.projectLabel = projectContext?.projectName
          ? `${projectContext.projectName} (${projectContext.projectId})`
          : (projectContext?.projectId || '');
        queryOpts.projectInstruction = projectContext?.projectInstruction || '';
        // Related Session summaries now enter through Engine's single AMS
        // memory outlet. Keep this announcement limited to Project identity and
        // sharing boundaries so parent VP prompts do not duplicate the same prose
        // that sub-agents receive through memory.
        const sharedBlock = buildProjectSharedBlock(projectContext);
        if (sharedBlock) {
          queryOpts.sessionAnnouncement = queryOpts.sessionAnnouncement
            ? `${queryOpts.sessionAnnouncement}\n\n${sharedBlock}`
            : sharedBlock;
        }
      }
      let turnSessionMeta = null;
      try { turnSessionMeta = sessionCoordinator?.group?.getMeta?.() || null; } catch { turnSessionMeta = null; }
      const projectRuntime = getProjectRuntimeForTurn(turnSessionMeta);

      vpEngine = getOrCreateVpEngine(sessionId, vpId, threadId);
      if (escalationState) {
        escalationState.engine = vpEngine;
        escalationState.engineKey = threadKey(sessionId, vpId, threadId);
      }
      if (projectRuntime) {
        vpEngine.setRuntimeManagers?.(effectiveRuntimeManagers(
          projectRuntime.skillManager,
          projectRuntime.mcpManager,
          session?.config?.plugins,
        ));
      } else {
        vpEngine.setRuntimeManagers?.(effectiveRuntimeManagers(
          session?.skillManager || null,
          session?.mcpManager || null,
          session?.config?.plugins,
        ));
      }
      if (thread) thread.engine = vpEngine;

      const inboundInjectedBy = inboundEnvelope?.msg?.meta?.injectedBy;
      const inboundIsInternal = inboundInjectedBy === 'route_forward' || inboundInjectedBy === 'task_result';

      handlerCtx = {
        assistantTextParts,
        toolCallsAccum,
        toolResultsAccum,
        thinkingBlocksAccum,
        resetQueryTimer,
        pauseQueryTimer,
        sessionId,
        vpId,
        turnId,
        threadId,
        thread,
        appendedUserPrompts,
        prompt,
        includeInitialPrompt: !inboundIsInternal,
        skipPartialHistory: false,
        markEngineTerminal,
        markTurnEnd,
      };
      // Always trim the snapshot before passing to engine.query. This is a
      // deterministic provider-request window; it never calls an LLM or
      // changes the persisted transcript. See `trimSnapshotForBudget`.
      const trimStart = perfNowMs();
      const trimmedMessages = trimSnapshotForBudget(baseSnapshot, {
        messageTokenBudget: session?.config?.messageTokenBudget,
        language: session?.config?.language,
      });
      if (perfTraceId) {
        recordAgentPerfTrace(ctx.CONFIG, {
          traceId: perfTraceId,
          phase: 'vp.trim_snapshot',
          durationMs: perfNowMs() - trimStart,
          sessionId,
          vpId,
          turnId,
          threadId,
          detail: { beforeMessages: baseSnapshot.length, afterMessages: trimmedMessages.length },
        });
      }
      const engineStart = perfNowMs();
      let firstEngineEvent = false;
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
        askUser: ({ question, options }, toolCall = null) => new Promise((resolve, reject) => {
          const requestId = `ask_${randomUUID()}`;
          const signal = vpAbort.signal;
          const createdAt = Date.now();
          // Human think time is not engine silence. Pause the query watchdog,
          // but keep a separate bounded AskUser lifetime so an abandoned card
          // cannot pin the VP forever.
          if (queryTimer) {
            clearTimeout(queryTimer);
            queryTimer = null;
          }
          const pending = {
            resolve,
            reject,
            sessionId,
            vpId,
            threadId,
            turnId,
            toolCallId: typeof toolCall?.id === 'string' ? toolCall.id : '',
            question,
            options: Array.isArray(options) ? options.filter(label => typeof label === 'string') : [],
            createdAt,
            expiresAt: createdAt + ASK_USER_TIMEOUT_MS,
            timer: null,
            resumeQueryTimer: resetQueryTimer,
            signal,
            onAbort: null,
          };
          const onAbort = () => {
            if (pendingUserPrompts.get(requestId) !== pending) return;
            pendingUserPrompts.delete(requestId);
            if (pending.timer) clearTimeout(pending.timer);
            reject(new Error('aborted'));
          };
          pending.onAbort = onAbort;
          pending.timer = setTimeout(() => {
            settlePendingUserPrompt(requestId, pending, { timedOut: true });
          }, ASK_USER_TIMEOUT_MS);
          if (typeof pending.timer.unref === 'function') pending.timer.unref();
          pendingUserPrompts.set(requestId, pending);
          signal.addEventListener('abort', onAbort, { once: true });
          sendPendingUserPrompt(requestId, pending);
        }),
        threadId,
        vpTurnId: turnId,
        drainPendingUserMessages: () => {
          if (!thread || !Array.isArray(thread.pendingQueries) || thread.pendingQueries.length === 0) return [];
          return thread.pendingQueries.splice(0).map(item => ({ ...item, persisted: true }));
        },
        ...queryOpts,
      })) {
        // An escalated turn is detached from the per-VP driver. Its stale
        // promise may still resume if a provider/tool ignored AbortSignal;
        // never let those late events mutate UI or runtime state.
        if (escalationState?.escalated) continue;
        if (perfTraceId && !firstEngineEvent) {
          firstEngineEvent = true;
          recordAgentPerfTrace(ctx.CONFIG, {
            traceId: perfTraceId,
            phase: 'vp.engine_first_event',
            durationMs: perfNowMs() - engineStart,
            sessionId,
            vpId,
            turnId,
            threadId,
            messageType: event?.type || null,
          });
        }
        resetQueryTimer();
        handleEngineEvent(event, handlerCtx);
      }
      if (perfTraceId) {
        recordAgentPerfTrace(ctx.CONFIG, {
          traceId: perfTraceId,
          phase: 'vp.engine_complete',
          durationMs: perfNowMs() - engineStart,
          sessionId,
          vpId,
          turnId,
          threadId,
        });
      }

      if (escalationState?.escalated) return;

      if (engineTerminalReason === 'aborted') {
        finishAbortedTurn(engineTerminalDetail);
        return;
      }
      if (engineTerminalReason === 'error') {
        turnEndReason = 'errored';
        turnEndDetail = engineTerminalDetail;
        flushStreamTextBatch(handlerCtx, envelope, { resetImmediate: true });
        sendSessionOutputFrame({
          type: 'result',
          result_text: '',
          is_error: true,
        }, envelope);
        return;
      }

      flushStreamTextBatch(handlerCtx, envelope, { resetImmediate: true });

      // Turn completed — atomically append this VP's output to shared history.
      // route_forward handoff text is an internal trigger, already visible as
      // the source VP's tool action. Do not append it as a visible prompt for
      // the target VP turn; otherwise UI replay can show a trailing handoff
      // block after the target response.
      const visiblePrompts = inboundIsInternal ? appendedUserPrompts : [prompt, ...appendedUserPrompts];
      const appendHistoryStart = perfNowMs();
      appendTurnToSessionHistory(sessionId, threadId, vpId, visiblePrompts, assistantTextParts, toolCallsAccum, toolResultsAccum, thinkingBlocksAccum, { turnId });
      if (perfTraceId) {
        recordAgentPerfTrace(ctx.CONFIG, {
          traceId: perfTraceId,
          phase: 'vp.append_history',
          durationMs: perfNowMs() - appendHistoryStart,
          sessionId,
          vpId,
          turnId,
          threadId,
          detail: {
            assistantBytes: Buffer.byteLength(assistantTextParts.join('')),
            toolCallCount: toolCallsAccum.length,
            toolResultCount: toolResultsAccum.length,
          },
        });
      }

      if (!escalationState?.escalated) {
        sendSessionOutputFrame({
          type: 'assistant',
          message: { content: [] },
        }, envelope);
        sendSessionOutputFrame({
          type: 'result',
          result_text: '',
        }, envelope);
        // Normal end-of-turn (no route_forward, no abort, no error). Emit
        // the message-status terminal so the web client can flip the
        // assistant message status from 'pending' → 'completed'.
        emitVpTurnEnd('end_turn');
      }
    } finally {
      if (queryTimer) clearTimeout(queryTimer);
    }
  } catch (err) {
    if (escalationState?.escalated) return;
    const isAbort = err && (err.name === 'AbortError' || err.name === 'LLMAbortError');
    if (isAbort) {
      if (!escalationState?.escalated) finishAbortedTurn();
      return;
    }

    if (perfTraceId) {
      recordAgentPerfTrace(ctx.CONFIG, {
        traceId: perfTraceId,
        phase: 'vp.turn_error',
        durationMs: perfNowMs() - vpTurnPerfStart,
        sessionId,
        vpId,
        turnId,
        threadId,
        ok: false,
        detail: { message: err?.message || String(err) },
      });
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

    flushStreamTextBatch(handlerCtx, envelope, { resetImmediate: true });

    if (isPermissionErrorMsg(err.message)) {
      if (!_permissionDiagnosticSent) {
        _permissionDiagnosticSent = true;
        sendSessionOutputFrame({
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
      sendSessionOutputFrame({
        type: 'assistant',
        message: {
          content: [{
            type: 'text',
            text: `⚠️ Session error: ${err.message}`,
          }],
        },
      }, envelope);
    }
    sendSessionOutputFrame({
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
    if (!escalationState?.escalated && turnEndReason !== 'errored') {
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
    if (!escalationState?.escalated && thread) {
      thread.status = 'idle';
      thread.updatedAt = Date.now();
    }
    if (perfTraceId && !escalationState?.escalated) {
      recordAgentPerfTrace(ctx.CONFIG, {
        traceId: perfTraceId,
        phase: 'vp.turn_total',
        durationMs: perfNowMs() - vpTurnPerfStart,
        sessionId,
        vpId,
        turnId,
        threadId,
        ok: turnEndReason !== 'errored',
        detail: { reason: turnEndReason },
      });
    }
  }
}

/**
 * Atomically append a completed or partial VP-turn's messages to the GROUP'S
 * conversation history. Partial writes are replaced by the final write when
 * the same runtime turn completes.
 *
 * Note: this does NOT see the engine's collapsed form — it appends the
 * raw user prompt(s) + the per-VP assistant text + tool results. Related
 * appends consumed by Engine loop-boundary hooks are passed in the prompt list
 * exactly once, with the same threadId as the running thread. The
 * engine's own `conversationMessages` (with T1/T2 tool-arc folding applied)
 * is persisted to disk via stop-hooks, so the next turn's history is
 * read from disk via `loadRecentBySession` on next session boot. Within
 * a session, this in-memory tape is a bounded deterministic cache; the
 * complete transcript remains in ConversationStore and each provider request
 * applies its own pair-safe history window.
 */
function buildTurnHistoryEntries(threadId, vpId, prompts, assistantTextParts, toolCallsAccum, toolResultsAccum, thinkingBlocksAccum, opts = {}) {
  const entries = [];
  const runtimeTurnId = typeof opts.turnId === 'string' && opts.turnId ? opts.turnId : null;
  const markEntry = (entry) => {
    if (runtimeTurnId) entry._runtimeTurnId = runtimeTurnId;
    if (opts.partial) entry._partialTurn = true;
    return entry;
  };
  const promptList = Array.isArray(prompts) ? prompts : [prompts];
  for (const prompt of promptList) {
    if (typeof prompt === 'string' && prompt.trim()) {
      // user rows intentionally carry NO speakerVpId — every VP in the
      // session should see the prompt in their history.
      entries.push(markEntry({ role: 'user', content: prompt, threadId: threadId || 'main' }));
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
    entries.push(markEntry(assistantMsg));

    for (const tr of toolResultsAccum) {
      const toolMsg = {
        role: 'tool',
        toolCallId: tr.toolCallId,
        content: tr.content,
        isError: tr.isError,
        threadId: threadId || 'main',
      };
      if (vpId) toolMsg.speakerVpId = vpId;
      entries.push(markEntry(toolMsg));
    }
  }
  return entries;
}

function appendTurnToSessionHistory(sessionId, threadId, vpId, prompts, assistantTextParts, toolCallsAccum, toolResultsAccum, thinkingBlocksAccum, opts = {}) {
  if (!sessionId) return;
  const history = getOrCreateSessionHistory(sessionId);
  const nextEntries = buildTurnHistoryEntries(threadId, vpId, prompts, assistantTextParts, toolCallsAccum, toolResultsAccum, thinkingBlocksAccum, opts);
  if (nextEntries.length === 0) return;
  const runtimeTurnId = typeof opts.turnId === 'string' && opts.turnId ? opts.turnId : null;
  if (runtimeTurnId) {
    let insertAt = history.length;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i]?._runtimeTurnId === runtimeTurnId) {
        insertAt = i;
        history.splice(i, 1);
      }
    }
    if (insertAt > history.length) insertAt = history.length;
    history.splice(insertAt, 0, ...nextEntries);
  } else {
    history.push(...nextEntries);
  }
  // The runtime tape is a disposable bounded cache. ConversationStore already
  // owns the complete transcript, so replacing this reference cannot lose
  // durable history. Keep the cache bounded after every partial/final append,
  // including large tool outputs from a long-running turn.
  setGroupHistory(sessionId, history);
}

/**
 * Persist an inbound message row to disk EXACTLY ONCE per
 * coordinator-ingest call, keyed by the coordinator-assigned `msgId`.
 * Both `handleYeaftSessionSend` (real user input, persists as
 * role='user') and `enqueueForVp`'s driver loop (route_forward / task_result
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
 * @param {{ msgId:string, text:string, sessionId:string, role?:string, speakerVpId?:string|null, attachments?:Array<object>, quote?:object|null, internal?:boolean, ts?:string|null, clientMessageId?:string|null }} args
 * @returns {boolean} true if this call wrote the row, false if a prior
 *   call already wrote it (dedup hit).
 */
function persistInboundMessageOnceByMsgId({ msgId, text, sessionId, threadId = 'main', role, speakerVpId, attachments, quote, internal = false, ts = null, clientMessageId = null }) {
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
    // loop passes role='assistant' + speakerVpId for route_forward /
    // task_result injections so the on-disk record correctly attributes
    // the internal trigger text.
    const persistRole = role === 'assistant' ? 'assistant' : 'user';
    const record = {
      role: persistRole,
      content: text,
      threadId: threadId || 'main',
    };
    if (sessionId) record.sessionId = sessionId;
    if (persistRole === 'user') {
      record.userAuthored = true;
      if (clientMessageId && typeof clientMessageId === 'string') {
        record.clientMessageId = clientMessageId;
      }
    }
    // Stamp speakerVpId so the UI's loadHistory replay can route the row
    // to the correct VP block. Only meaningful when role='assistant'; for
    // a real user message we leave it unset (the UI's user track is
    // unattributed).
    if (persistRole === 'assistant' && speakerVpId && typeof speakerVpId === 'string') {
      record.speakerVpId = speakerVpId;
    }
    if (internal) record.internal = true;
    if (persistRole === 'user' && Array.isArray(attachments) && attachments.length > 0) {
      record.attachments = attachments;
    }
    if (persistRole === 'user') {
      const normalizedQuote = normalizeSessionMessageQuote(quote);
      if (normalizedQuote) record.quote = normalizedQuote;
    }
    if (ts && typeof ts === 'string') {
      record.time = ts;
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

/**
 * Abort every in-flight VP turn and clear all queued envelopes across
 * every group/thread runtime. Shared by `handleYeaftAbortThread` when no
 * target thread is supplied and by `handleYeaftAbortAll`. Pushes `vp:<key>`
 * strings into the supplied `aborted` array for the yeaft_aborted event.
 *
 * @param {string[]} aborted — output array, mutated in place
 */
function removeQueuedVpTurn(turnId) {
  const meta = turnAbortMeta.get(turnId);
  const keys = meta?.key ? [meta.key] : Array.from(vpInboxes.keys());
  let removed = false;
  for (const key of keys) {
    const inbox = vpInboxes.get(key);
    if (!Array.isArray(inbox) || inbox.length === 0) continue;
    const before = inbox.length;
    const kept = inbox.filter((entry) => entry?.turnId !== turnId);
    if (kept.length === before) continue;
    removed = true;
    inbox.length = 0;
    inbox.push(...kept);
  }
  return removed;
}

function findTurnIdsForVp({ sessionId = null, vpId = null } = {}) {
  if (!vpId) return [];
  const ids = [];
  for (const [turnId, meta] of turnAbortMeta.entries()) {
    if (!meta || meta.vpId !== vpId) continue;
    if (sessionId && meta.sessionId !== sessionId) continue;
    ids.push(turnId);
  }
  return ids;
}

function emitQueuedTurnAbort(meta, turnId) {
  if (!meta?.vpId) return;
  const sessionId = meta.sessionId || null;
  const vpId = meta.vpId;
  const threadId = meta.threadId || 'main';
  try {
    getVpStatusBroker().transition({
      sessionId,
      vpId,
      threadId,
      state: 'idle',
      turnId,
      messageCount: 0,
    });
  } catch (err) {
    console.warn('[Yeaft] queued VP abort status transition failed:', err?.message || err);
  }
  try {
    sendSessionEvent({
      type: 'vp_typing_end',
      sessionId,
      vpId,
      threadId,
      turnId,
      ts: Date.now(),
    }, { sessionId, vpId, threadId, turnId });
  } catch { /* never crash WS pipeline */ }
  try {
    sendSessionEvent({
      type: 'vp_turn_end',
      sessionId,
      vpId,
      threadId,
      turnId,
      reason: 'aborted',
      ts: Date.now(),
    }, { sessionId, vpId, threadId, turnId });
  } catch { /* never crash WS pipeline */ }
}

function abortAllVpRuntime(aborted, sessionId = null) {
  for (const [turnId, meta] of Array.from(turnAbortMeta.entries())) {
    if (sessionId && meta?.sessionId !== sessionId) continue;
    revokeTurnRepoApproval(turnId);
  }
  for (const [key, ctrl] of vpAborts) {
    if (sessionId && !key.startsWith(`${sessionId}::`)) continue;
    try {
      if (!ctrl.signal.aborted) { ctrl.abort(); aborted.push(`vp:${key}`); }
    } catch { /* best-effort */ }
    vpAborts.delete(key);
  }
  for (const [key, inbox] of vpInboxes) {
    if (sessionId && !key.startsWith(`${sessionId}::`)) continue;
    if (Array.isArray(inbox)) inbox.length = 0;
    if (sessionId) vpInboxes.delete(key);
  }
  if (!sessionId) vpInboxes.clear();
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
      revokeTurnRepoApproval(turnId);
      turnAbortCtrls.delete(turnId);
      turnAbortMeta.delete(turnId);
    }
    for (const vpMap of vpThreads.values()) {
      const thread = vpMap.get(targetThreadId);
      if (thread) thread.status = 'aborted';
    }
    sendSessionEvent({ type: 'yeaft_aborted', aborted, all: false, threadId: targetThreadId });
    return { aborted, all: false };
  }

  if (currentAbortCtrl && !currentAbortCtrl.signal.aborted) {
    try { currentAbortCtrl.abort(); aborted.push('main'); } catch { /* best-effort */ }
  }
  currentAbortCtrl = null;
  for (const [turnId, ctrl] of turnAbortCtrls) {
    try { if (!ctrl.signal.aborted) { ctrl.abort(); aborted.push(turnId); } } catch { /* best-effort */ }
  }
  for (const turnId of turnAbortMeta.keys()) revokeTurnRepoApproval(turnId);
  turnAbortCtrls.clear();
  turnAbortMeta.clear();
  abortAllVpRuntime(aborted);
  sendSessionEvent({ type: 'yeaft_aborted', aborted, all: false });
  return { aborted, all: false };
}

/**
 * Abort all in-flight Yeaft runtime work.
 * With sessionId set, abort only work owned by that Yeaft Session.
 *
 * @param {{ sessionId?: string }} msg
 * @returns {{ aborted: string[], all: boolean }}
 */
export function handleYeaftAbortAll(msg = {}) {
  const sessionId = typeof msg.sessionId === 'string' && msg.sessionId ? msg.sessionId : null;
  const aborted = [];
  if (!sessionId && currentAbortCtrl && !currentAbortCtrl.signal.aborted) {
    try { currentAbortCtrl.abort(); aborted.push('main'); } catch { /* best-effort */ }
  }
  if (!sessionId) currentAbortCtrl = null;
  // Also abort all per-VP turn controllers.
  for (const [turnId, ctrl] of turnAbortCtrls) {
    const meta = turnAbortMeta.get(turnId);
    if (sessionId && meta?.sessionId !== sessionId) continue;
    try { if (!ctrl.signal.aborted) { ctrl.abort(); aborted.push(turnId); } } catch { /* best-effort */ }
    revokeTurnRepoApproval(turnId);
    turnAbortCtrls.delete(turnId);
    turnAbortMeta.delete(turnId);
  }
  if (!sessionId) {
    for (const turnId of turnAbortMeta.keys()) revokeTurnRepoApproval(turnId);
    turnAbortCtrls.clear();
    turnAbortMeta.clear();
  }
  abortAllVpRuntime(aborted, sessionId);
  sendSessionEvent({ type: 'yeaft_aborted', aborted, all: true, sessionId }, sessionId ? { sessionId } : undefined);
  return { aborted, all: true };
}

/**
 * Per-VP abort: stops a single VP turn without affecting siblings.
 * New clients send `{ sessionId, vpId }`; `turnId` is kept for legacy buttons.
 * @param {{ turnId?: string, sessionId?: string, vpId?: string }} msg
 */
export function handleYeaftAbortTurn(msg = {}) {
  const sessionId = msg.sessionId || null;
  const vpId = msg.vpId || null;
  const turnIds = msg.turnId ? [msg.turnId] : findTurnIdsForVp({ sessionId, vpId });

  if (turnIds.length === 0) {
    sendSessionEvent({ type: 'yeaft_turn_aborted', turnId: null, turnIds: [], success: false, sessionId, vpId }, sessionId ? { sessionId } : undefined);
    return;
  }

  let success = false;
  const abortedTurnIds = [];
  let ackSessionId = sessionId;
  let ackVpId = vpId;

  for (const turnId of turnIds) {
    const meta = turnAbortMeta.get(turnId);
    const ctrl = turnAbortCtrls.get(turnId);
    if (!ackSessionId && meta?.sessionId) ackSessionId = meta.sessionId;
    if (!ackVpId && meta?.vpId) ackVpId = meta.vpId;

    let turnAborted = false;
    if (ctrl && !ctrl.signal.aborted) {
      try { ctrl.abort(); turnAborted = true; } catch { /* best-effort */ }
    } else if (removeQueuedVpTurn(turnId)) {
      turnAborted = true;
      emitQueuedTurnAbort(meta, turnId);
    }

    if (turnAborted) {
      success = true;
      abortedTurnIds.push(turnId);
    }
    revokeTurnRepoApproval(turnId);
    turnAbortCtrls.delete(turnId);
    turnAbortMeta.delete(turnId);
  }

  sendSessionEvent({
    type: 'yeaft_turn_aborted',
    turnId: abortedTurnIds[0] || turnIds[0] || null,
    turnIds: abortedTurnIds.length > 0 ? abortedTurnIds : turnIds,
    success,
    sessionId: ackSessionId || null,
    vpId: ackVpId || null,
  }, ackSessionId ? { sessionId: ackSessionId } : undefined);
}

/**
 * Unified abort entry: routes by payload shape.
 * @param {{ threadId?: string, all?: boolean }} [opts]
 */
export function abortYeaftSession(opts = {}) {
  if (opts && opts.all) return handleYeaftAbortAll();
  if (opts && opts.threadId) return handleYeaftAbortThread({ threadId: opts.threadId });
  // No payload — conservative no-op ack.
  sendSessionEvent({ type: 'yeaft_aborted', aborted: [], all: false });
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
 *     Fires a scope-filtered pass via `triggerDreamForScopes(['sessions/X'])`
 *     so unrelated groups don't get processed; the result event is
 *     tagged with `sessionId` for the per-session UI row.
 *
 * Backwards-compat: when neither field is set, defaults to `vpId='default'`
 * which matches the pre-v0.1.754 behavior.
 */
function resolveDreamTriggerSessionId(msg = {}) {
  return typeof msg.sessionId === 'string' && msg.sessionId
    ? msg.sessionId
    : (typeof msg.groupId === 'string' && msg.groupId ? msg.groupId : null);
}

export function normalizeDreamResult(result) {
  const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
  const targets = Array.isArray(result?.targets) ? result.targets : [];
  const sessionsProcessed = sessions.filter(g => g && g.status === 'triaged').length;
  const skippedSessions = sessions.filter(g => g && g.status === 'skipped');
  const sessionsSkipped = skippedSessions.length;
  const targetsApplied = targets.filter(t => t && t.status === 'done').length;
  const targetErrors = targets
    .filter(t => t && t.status === 'error')
    .map(t => ({ target: t.target || null, error: t.error || 'unknown' }));
  const hardError = result?.error || null;
  const explicitSkipped = result?.skipped === true;
  const skipped = !hardError && (explicitSkipped || (sessionsProcessed === 0 && targetsApplied === 0));
  const skippedReason = skipped
    ? (result?.skippedReason || skippedSessions[0]?.reason || 'no-targets-applied')
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
    sessionsProcessed,
    sessionsSkipped,
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
  const sessionId = resolveDreamTriggerSessionId(msg);
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
      ? await session.dreamScheduler.triggerDreamForScopes([`sessions/${sessionId}`])
      : await session.dreamScheduler.triggerDreamNow();

    const normalized = normalizeDreamResult(result);
    const snapshot = sessionId
      ? await buildDreamOutputSnapshot(session, sessionId).catch(() => null)
      : null;

    // Spread `result` FIRST so normalized fields (success, skipped,
    // skippedReason, sessionsProcessed, sessionsSkipped, targetsApplied,
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
      ...(snapshot ? { snapshot } : {}),
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
 * Hydrate the YeaftDebugPanel from the persistent file-backed trace. The
 * panel state (`yeaftDebugLoops` / `yeaftDebugTurnsById`) is otherwise
 * built ONLY from in-flight `loop` / `turn_open` events on the wire,
 * so a panel opened after a turn has finished sees nothing for that
 * turn. This handler ships back a frontend-shaped snapshot the store
 * splices into place.
 *
 * Inputs (all optional):
 *   - `limit`        — request cap; bounded by the file trace store
 *   - `indexOnly`    — list request summaries without loop/detail payloads
 *   - `detailTurnId` — fetch full loops/tools for one request
 *   - `sessionId`    — narrow by Session
 *   - `threadId`     — narrow by thread
 *   - `search`       — regex matched against bounded request summaries
 *
 * Sends:
 *   { type: 'yeaft_debug_history', loops: [...], turns: [...], indexOnly, detailTurnId }
 *
 * Best-effort: if the session / trace isn't ready, sends an empty
 * snapshot so the panel renders a placeholder instead of spinning.
 */
export async function handleYeaftFetchDebugHistory(msg = {}) {
  const limit = Number.isFinite(msg?.limit) ? Number(msg.limit) : 10;
  const dreamLimit = Number.isFinite(msg?.dreamLimit) ? Number(msg.dreamLimit) : 5;
  const sessionId = typeof msg?.sessionId === 'string' && msg.sessionId ? msg.sessionId : null;
  const threadId = typeof msg?.threadId === 'string' && msg.threadId ? msg.threadId : null;
  const search = typeof msg?.search === 'string' ? msg.search.trim() : '';
  const requestId = typeof msg?.requestId === 'string' && msg.requestId ? msg.requestId : null;
  const requestKind = typeof msg?.requestKind === 'string' && msg.requestKind ? msg.requestKind : null;
  const requestClientId = typeof msg?._requestClientId === 'string' && msg._requestClientId ? msg._requestClientId : null;
  const indexOnly = !!msg?.indexOnly;
  const detailTurnId = typeof msg?.detailTurnId === 'string' && msg.detailTurnId ? msg.detailTurnId : null;
  let loops = [];
  let turns = [];
  let dreamEvents = [];
  let projection = null;
  let hasMore = false;
  try {
    if (session?.trace && detailTurnId && sessionId && typeof session.trace.fetchTurnDebug === 'function') {
      const out = await session.trace.fetchTurnDebug({ sessionId, turnId: detailTurnId, dreamLimit });
      loops = Array.isArray(out?.loops) ? out.loops : [];
      turns = Array.isArray(out?.turns) ? out.turns : [];
      dreamEvents = Array.isArray(out?.dreamEvents) ? out.dreamEvents : [];
      projection = out?.projection && typeof out.projection === 'object' ? out.projection : null;
      hasMore = false;
    } else if (session?.trace && typeof session.trace.fetchRecentDebugHistory === 'function') {
      const out = await session.trace.fetchRecentDebugHistory({ limit, dreamLimit, sessionId, threadId, indexOnly, detailTurnId, search });
      loops = Array.isArray(out?.loops) ? out.loops : [];
      turns = Array.isArray(out?.turns) ? out.turns : [];
      dreamEvents = Array.isArray(out?.dreamEvents) ? out.dreamEvents : [];
      projection = out?.projection && typeof out.projection === 'object' ? out.projection : null;
      hasMore = !!out?.hasMore;
    }
  } catch (err) {
    await sendDebugHistory({
      type: 'yeaft_debug_history',
      loops: [],
      turns: [],
      dreamEvents: [],
      requestId,
      requestKind,
      ...(requestClientId ? { _requestClientId: requestClientId } : {}),
      sessionId,
      threadId,
      search,
      limit,
      indexOnly,
      detailTurnId,
      error: err && err.message ? err.message : String(err),
    });
    return;
  }
  await sendDebugHistory({
    type: 'yeaft_debug_history',
    loops,
    turns,
    dreamEvents,
    ...(projection ? { projection } : {}),
    requestId,
    requestKind,
    ...(requestClientId ? { _requestClientId: requestClientId } : {}),
    sessionId,
    threadId,
    search,
    hasMore,
    limit,
    indexOnly,
    detailTurnId,
  });
}

/** Resolve a pending Yeaft AskUser prompt from the web UI. */
export function handleYeaftAskUserAnswer(msg) {
  const requestId = typeof msg?.requestId === 'string' ? msg.requestId : '';
  const pending = pendingUserPrompts.get(requestId);
  if (!pending) return false;
  if (msg.sessionId && msg.sessionId !== pending.sessionId) return false;
  if (msg.vpId && msg.vpId !== pending.vpId) return false;
  if (msg.turnId && msg.turnId !== pending.turnId) return false;
  if (msg.threadId && msg.threadId !== pending.threadId) return false;
  if (msg.toolCallId && msg.toolCallId !== pending.toolCallId) return false;

  return settlePendingUserPrompt(requestId, pending, { answers: msg.answers || {} });
}

export async function handleYeaftSessionSend(msg) {
  return runYeaftSessionSend(msg);
}

export function handleYeaftSubAgentPrompt(msg) {
  const sessionId = typeof msg?.sessionId === 'string' ? msg.sessionId.trim() : '';
  const taskId = typeof msg?.taskId === 'string' ? msg.taskId.trim() : '';
  const subAgentId = typeof msg?.subAgentId === 'string' ? msg.subAgentId.trim() : '';
  const message = typeof msg?.message === 'string' ? msg.message.trim() : '';
  const clientPromptId = typeof msg?.clientPromptId === 'string' ? msg.clientPromptId.trim() : '';
  const fail = (error) => {
    sendSessionEvent({
      type: 'yeaft_sub_agent_prompt_result',
      success: false,
      taskId: taskId || null,
      subAgentId: subAgentId || null,
      clientPromptId: clientPromptId || null,
      error,
    }, sessionId ? { sessionId } : undefined);
  };

  if (!sessionId || !taskId || !subAgentId || !message) {
    fail('sessionId, taskId, subAgentId and message are required');
    return;
  }
  const task = session?.taskManager?.getTask?.(sessionId, taskId) || null;
  if (!task || task.kind !== 'sub_agent' || task.status !== 'running' || task.runtime?.subAgentId !== subAgentId) {
    fail('sub-agent task not found');
    return;
  }

  const agent = getAgentRegistry().get(subAgentId);
  const scope = {
    sessionId,
    parentVpId: task.ownerVpId || null,
    parentThreadId: task.source?.threadId || 'main',
  };
  if (!agent || !agentBelongsToScope(agent, scope)) {
    fail('sub-agent not found');
    return;
  }
  if (!isPromptableAgentStatus(agent.status)) {
    fail(`sub-agent status "${agent.status}" does not accept prompts`);
    return;
  }

  const projectContext = projectContextBySession.get(sessionId)
    || legacyProjectContext(ctx.CONFIG?.yeaftDir, sessionId);
  enqueueSubAgentPrompt(agent, message, {
    projectSessionIds: projectContext?.sessionIds,
    projectLabel: projectContext?.projectName
      ? `${projectContext.projectName} (${projectContext.projectId})`
      : (projectContext?.projectId || ''),
    projectInstruction: projectContext?.projectInstruction,
  });
  if (!Array.isArray(agent.messages)) agent.messages = [];
  agent.messages.push({ role: 'user', content: message, timestamp: Date.now() });
  if (agent.status === 'idle' || agent.status === 'created') agent.status = 'running';

  try {
    agent.outputLog?.write?.({
      type: 'user_prompt',
      agentId: agent.id,
      agentName: agent.name,
      content: message,
    });
    session?.taskManager?.refreshTaskLog?.(sessionId, taskId);
  } catch { /* prompt queueing must not depend on log refresh */ }

  sendSessionEvent({
    type: 'yeaft_sub_agent_prompt_result',
    success: true,
    taskId,
    subAgentId,
    clientPromptId: clientPromptId || null,
    pending: agent.pendingPrompts.length,
  }, { sessionId, vpId: task.ownerVpId || null, threadId: task.source?.threadId || null });
}

export function handleYeaftTaskCancel(msg) {
  const sessionId = typeof msg?.sessionId === 'string' ? msg.sessionId.trim() : '';
  const taskId = typeof msg?.taskId === 'string' ? msg.taskId.trim() : '';
  const clientRequestId = typeof msg?.clientRequestId === 'string' ? msg.clientRequestId.trim() : '';
  const fail = (error, task = null) => {
    sendSessionEvent({
      type: 'yeaft_task_cancel_result',
      success: false,
      taskId: taskId || null,
      clientRequestId: clientRequestId || null,
      error,
      ...(task ? { task } : {}),
    }, sessionId ? { sessionId, vpId: task?.ownerVpId || null, threadId: task?.source?.threadId || null } : undefined);
  };

  if (!sessionId || !taskId) {
    fail('sessionId and taskId are required');
    return;
  }
  if (!session?.taskManager || typeof session.taskManager.cancelTask !== 'function') {
    fail('task manager unavailable');
    return;
  }

  const existingTask = session.taskManager.getTask?.(sessionId, taskId) || null;
  if (existingTask?.kind === 'sub_agent' && existingTask.status === 'running') {
    const subAgentId = existingTask.runtime?.subAgentId || '';
    const agent = subAgentId ? getAgentRegistry().get(subAgentId) : null;
    const scope = {
      sessionId,
      parentVpId: existingTask.ownerVpId || null,
      parentThreadId: existingTask.source?.threadId || 'main',
    };
    if (!agent || !agentBelongsToScope(agent, scope)) {
      fail('sub-agent not found', existingTask);
      return;
    }
    if (!isTerminalAgentStatus(agent.status)) {
      agent.status = STATUS.CLOSED;
      if (agent.abortController && !agent.abortController.signal.aborted) {
        try { agent.abortController.abort('stopped_by_user'); } catch { /* best effort */ }
      }
    }
    try { consumeNotificationForAgent(agent.id); } catch { /* best effort */ }
    const task = session.taskManager.completeTask(sessionId, taskId, { status: 'cancelled' });
    sendSessionEvent({
      type: 'yeaft_task_cancel_result',
      success: true,
      taskId,
      clientRequestId: clientRequestId || null,
      pending: false,
      task,
    }, { sessionId, vpId: task?.ownerVpId || null, threadId: task?.source?.threadId || null });
    return;
  }

  let result;
  try {
    result = session.taskManager.cancelTask(sessionId, taskId);
  } catch (err) {
    fail(err?.message || String(err));
    return;
  }

  const task = result?.task || session.taskManager.getTask?.(sessionId, taskId) || null;
  if (!result?.ok) {
    fail(result?.error || 'Failed to cancel task', task);
    return;
  }

  sendSessionEvent({
    type: 'yeaft_task_cancel_result',
    success: true,
    taskId,
    clientRequestId: clientRequestId || null,
    pending: !!result?.pending,
    task,
  }, { sessionId, vpId: task?.ownerVpId || null, threadId: task?.source?.threadId || null });
}

/** Deprecated mode switch — Yeaft is single-mode. */
export function handleYeaftModeSwitch(_msg) {
  console.warn('[Yeaft] yeaft_mode_switch is deprecated and ignored — Yeaft now runs in a single unified mode.');
}



export function modelRefMatchesAvailable(model, requested) {
  if (!model || !requested) return false;
  return model.id === requested
    || model.ref === requested
    || (model.provider && model.id && `${model.provider}/${model.id}` === requested);
}

/** Handle model switch from the web UI. */
export function handleYeaftModelSwitch(msg) {
  if (!session || !msg.model) return;
  refreshLiveSessionConfig();

  const available = session.config.availableModels || [];
  const found = available.some(m => modelRefMatchesAvailable(m, msg.model));
  if (!found) {
    console.warn(`[Yeaft] model switch rejected — "${msg.model}" not in availableModels`);
    return;
  }

  session.config.model = msg.model;
  session.config.primaryModel = msg.model;
  session.config.modelEffort = msg.modelEffort || null;
  // Legacy non-session model switches mutate the shared root config instead
  // of going through handleYeaftUpdateSessionConfig(), so cached per-VP
  // Engines would otherwise keep the old effective config and drop newly
  // selected effort values until process restart.
  vpEngines.clear();
  vpEngineConfigKeys.clear();
  asyncTaskOwners.clear();

  sendSessionEvent({
    type: 'model_switched',
    model: msg.model,
    modelEffort: session.config.modelEffort || null,
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
  const requestId = typeof msg?.requestId === 'string' && msg.requestId ? msg.requestId : null;
  const requestClientId = typeof msg?._requestClientId === 'string' && msg._requestClientId ? msg._requestClientId : null;
  const perfTraceId = typeof msg?.perfTraceId === 'string' && msg.perfTraceId.trim() ? msg.perfTraceId.trim() : null;
  const perfStart = perfNowMs();
  const tracePerf = (phase, extra = {}) => {
    if (!perfTraceId) return;
    recordAgentPerfTrace(ctx.CONFIG, {
      traceId: perfTraceId,
      phase,
      sessionId,
      messageType: msg?.type || 'yeaft_load_history',
      ...extra,
    });
  };
  const traceDuration = (phase, start, extra = {}) => tracePerf(phase, { durationMs: perfNowMs() - start, ...extra });
  tracePerf('history.received', {
    detail: {
      limit: Number.isFinite(msg?.limit) ? msg.limit : null,
      afterSeq: Number.isFinite(msg?.afterSeq) ? msg.afterSeq : null,
      metadataOnly: !!(msg && Number.isFinite(msg.limit) && msg.limit <= 0),
      sessionLoaded: !!session,
    },
  });
  const metadataOnly = msg && Number.isFinite(msg.limit) && msg.limit <= 0;
  // `lim` is now expressed in TURNS, not raw messages. `loadRecent` and
  // `loadRecentBySession` use turn-based slicing so the cut never lands
  // mid-tool-arc. Pass `undefined` to use the persistence-layer default
  // (DEFAULT_RECENT_TURNS = 20 turns).
  const pickRecent = (store, lim) =>
    sessionId ? store.loadRecentBySession(sessionId, lim) : store.loadRecent(lim);
  let historyAlreadyReplayed = false;

  const replayHistoryFromStore = () => {
    if (metadataOnly) return;
    // Delta path: caller knows the latest seq (or message id) it has cached
    // and wants only the messages that arrived after that cursor. Returns
    // mode:'delta' so the frontend can append+dedupe instead of replacing
    // the pane.
    const deltaLimit = Number.isFinite(msg?.maxRows)
      ? Math.min(500, Math.max(1, Math.floor(msg.maxRows)))
      : 100;
    const deltaMaxBytes = Number.isFinite(msg?.maxBytes)
      ? Math.min(2 * 1024 * 1024, Math.max(32 * 1024, Math.floor(msg.maxBytes)))
      : 512 * 1024;
    const historyMetadata = typeof session.conversationStore.getSessionHistoryMetadata === 'function'
      ? session.conversationStore.getSessionHistoryMetadata(sessionId)
      : null;
    const cacheIdentityMatches = !msg?.streamId || (
      msg.streamId === historyMetadata?.streamId
      && Number(msg.revision) === Number(historyMetadata?.revision)
    );
    const afterSeqRaw = cacheIdentityMatches && msg && Number.isFinite(msg.afterSeq) ? msg.afterSeq : null;
    const afterMessageId = (msg && typeof msg.afterMessageId === 'string') ? msg.afterMessageId : null;
    let afterSeq = afterSeqRaw;
    if (afterSeq === null && afterMessageId && typeof session.conversationStore.getMessageSeqById === 'function') {
      afterSeq = session.conversationStore.getMessageSeqById(afterMessageId);
    }
    if (sessionId && afterSeq !== null && typeof session.conversationStore.loadAfterSeqByGroup === 'function') {
      const loadStart = perfNowMs();
      const delta = session.conversationStore.loadAfterSeqByGroup(sessionId, afterSeq, {
        limit: deltaLimit,
        maxBytes: deltaMaxBytes,
      });
      traceDuration('history.store_load_delta', loadStart, { detail: { count: delta.messages?.length || 0, afterSeq } });
      const emitStart = perfNowMs();
      const projectedMessages = emitHistoryChunk({
        sessionId,
        messages: delta.messages,
        mode: 'delta',
        latestSeq: delta.latestSeq,
        afterSeq,
        hasMoreAfter: delta.hasMoreAfter,
        streamId: historyMetadata?.streamId || null,
        revision: historyMetadata?.revision ?? null,
        requestId,
        requestClientId,
        perfTraceId,
      });
      traceDuration('history.emit_chunk', emitStart, { detail: { mode: 'delta', count: projectedMessages.length } });
      sendSessionEvent({
        type: 'history_loaded',
        mode: 'delta',
        count: projectedMessages.length,
        sessionId,
        requestId,
        latestSeq: delta.latestSeq,
        afterSeq,
        hasMoreAfter: !!delta.hasMoreAfter,
        streamId: historyMetadata?.streamId || null,
        revision: historyMetadata?.revision ?? null,
      }, { sessionId, requestId, requestClientId, perfTraceId });
      return;
    }

    // `msg.limit` is the replay-scrollback request from the frontend (UI
    // history pane, not engine context). Keep the bootstrap window small so
    // opening a group can paint the latest messages quickly; older rows are
    // paged via `yeaft_load_more_history` when the user scrolls upward.
    const limit = (typeof msg.limit === 'number') ? msg.limit : 10;
    const loadStart = perfNowMs();
    const visiblePage = sessionId
      ? loadVisibleGroupHistoryPage(session.conversationStore, sessionId, limit)
      : { messages: limit > 0 ? pickRecent(session.conversationStore, limit) : [], oldestSeq: null, hasMore: false };
    traceDuration('history.store_load_recent', loadStart, { detail: { rawCount: visiblePage.messages?.length || 0, limit } });
    const replayEntries = sessionId
      ? visiblePage.messages
      : visiblePage.messages
        .map(projectPersistedToVisibleHistoryEntry)
        .filter(Boolean);

    let latestSeq = null;
    if (replayEntries.length > 0 && typeof session.conversationStore.getMessageSeqById === 'function') {
      const last = replayEntries[replayEntries.length - 1];
      if (last && last.id) latestSeq = session.conversationStore.getMessageSeqById(last.id);
    }

    if (sessionId) {
      const emitStart = perfNowMs();
      emitHistoryChunk({
        sessionId,
        messages: replayEntries,
        mode: 'recent',
        oldestSeq: visiblePage.oldestSeq,
        nextBeforeSeq: visiblePage.nextBeforeSeq,
        hasMore: visiblePage.hasMore,
        latestSeq,
        streamId: historyMetadata?.streamId || null,
        revision: historyMetadata?.revision ?? null,
        turns: limit,
        requestId,
        requestClientId,
        perfTraceId,
      });
      traceDuration('history.emit_chunk', emitStart, { detail: { mode: 'recent', count: replayEntries.length } });
    } else {
      emitLegacyHistoryOutputFrames(replayEntries);
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

    sendSessionEvent({
      type: 'history_loaded',
      mode: 'recent',
      count: replayEntries.length,
      sessionId,
      requestId,
      hasMore,
      oldestSeq,
      nextBeforeSeq: visiblePage.nextBeforeSeq,
      latestSeq,
      streamId: historyMetadata?.streamId || null,
      revision: historyMetadata?.revision ?? null,
    }, { sessionId, requestId, requestClientId, perfTraceId });
  };

  if (!session) {
    const yeaftDir = ctx.CONFIG?.yeaftDir || DEFAULT_YEAFT_DIR;
    const deltaLimit = Number.isFinite(msg?.maxRows)
      ? Math.min(500, Math.max(1, Math.floor(msg.maxRows)))
      : 100;
    const deltaMaxBytes = Number.isFinite(msg?.maxBytes)
      ? Math.min(2 * 1024 * 1024, Math.max(32 * 1024, Math.floor(msg.maxBytes)))
      : 512 * 1024;
    const afterMessageId = (msg && typeof msg.afterMessageId === 'string') ? msg.afterMessageId : null;
    const limit = (typeof msg.limit === 'number') ? msg.limit : 10;
    ensureYeaftConversationId();

    let sessionMetaForRuntime = null;
    const historyYeaftDir = yeaftDir;
    if (sessionId) {
      try {
        migrateRegisteredWorkDirSessions(yeaftDir);
        const metaDir = join(sessionsRoot(yeaftDir), sessionId);
        sessionMetaForRuntime = loadSessionMeta(metaDir);
      } catch (err) {
        console.warn('[Yeaft] load_history project-store migration failed:', err?.message || err);
      }
    }

    // First paint must not wait for full Yeaft runtime boot (MCP connects,
    // skill scans, memory index sync). The conversation segment store is the
    // source of truth and can be opened cheaply, so replay the visible message
    // window immediately, then finish loadSession below for actual turns.
    const coldStoreStart = perfNowMs();
    const coldStore = new ConversationStore(historyYeaftDir);
    const historyMetadata = sessionId && typeof coldStore.getSessionHistoryMetadata === 'function'
      ? coldStore.getSessionHistoryMetadata(sessionId)
      : null;
    const cacheIdentityMatches = !msg?.streamId || (
      msg.streamId === historyMetadata?.streamId
      && Number(msg.revision) === Number(historyMetadata?.revision)
    );
    const afterSeqRaw = cacheIdentityMatches && msg && Number.isFinite(msg.afterSeq) ? msg.afterSeq : null;
    traceDuration('history.cold_store_open', coldStoreStart);
    if (sessionId && (afterSeqRaw !== null || afterMessageId)) {
      let afterSeq = afterSeqRaw;
      if (afterSeq === null && afterMessageId && typeof coldStore.getMessageSeqById === 'function') {
        afterSeq = coldStore.getMessageSeqById(afterMessageId);
      }
      const loadStart = perfNowMs();
      const delta = afterSeq !== null && typeof coldStore.loadAfterSeqByGroup === 'function'
        ? coldStore.loadAfterSeqByGroup(sessionId, afterSeq, {
            limit: deltaLimit,
            maxBytes: deltaMaxBytes,
          })
        : { messages: [], latestSeq: null, hasMoreAfter: false };
      traceDuration('history.store_load_delta', loadStart, { detail: { count: delta.messages?.length || 0, afterSeq, cold: true } });
      const emitStart = perfNowMs();
      const projectedMessages = emitHistoryChunk({
        sessionId,
        messages: delta.messages,
        mode: 'delta',
        latestSeq: delta.latestSeq,
        afterSeq,
        hasMoreAfter: delta.hasMoreAfter,
        streamId: historyMetadata?.streamId || null,
        revision: historyMetadata?.revision ?? null,
        requestId,
        requestClientId,
        perfTraceId,
      });
      traceDuration('history.emit_chunk', emitStart, { detail: { mode: 'delta', count: projectedMessages.length, cold: true } });
      sendSessionEvent({
        type: 'history_loaded',
        mode: 'delta',
        count: projectedMessages.length,
        sessionId,
        requestId,
        latestSeq: delta.latestSeq,
        afterSeq,
        hasMoreAfter: !!delta.hasMoreAfter,
        streamId: historyMetadata?.streamId || null,
        revision: historyMetadata?.revision ?? null,
      }, { sessionId, requestId, requestClientId, perfTraceId });
    } else if (!metadataOnly) {
      const replayStart = perfNowMs();
      emitVisibleHistoryReplay({ store: coldStore, sessionId, limit, mode: 'recent', requestId, requestClientId, perfTraceId });
      traceDuration('history.cold_replay', replayStart, { detail: { mode: 'recent', limit } });
    }
    historyAlreadyReplayed = true;

    // Full runtime boot can be expensive (memory FTS sync, skills, MCP, dream
    // boot checks). It is not needed to render persisted history, so keep this
    // request short and let message-send await the same single-flight boot when
    // the user actually submits a turn.
    startSessionLoadInBackground({ sessionId, sessionMeta: sessionMetaForRuntime, perfTraceId, traceDuration, tracePerf });
  } else {
    const replayStart = perfNowMs();
    replayHistoryFromStore();
    traceDuration('history.replay_from_store', replayStart);
    historyAlreadyReplayed = true;
  }

  if (session && sessionId) {
    // Re-entering an existing session with a (possibly new) group filter:
    // re-seed THIS group's history from disk so it doesn't carry stale
    // in-memory state into the next turn's context. Do not mark it hydrated
    // before the runtime exists; that would cache an empty tape and starve the
    // next user turn of persisted context.
    const hydrateStart = perfNowMs();
    setGroupHistory(sessionId, hydrateGroupHistory(sessionId));
    traceDuration('history.hydrate_group_history_final', hydrateStart);
  }

  // Always replay session_ready so refresh / reconnect rebuilds UI state, but
  // never make the history response wait for bulky metadata snapshots. The
  // first visible chunk has already been sent above; defer metadata to the next
  // tick so the browser can paint messages before VP/session/dream snapshots.
  if (session) scheduleYeaftLoadHistoryMetadataReplay(sessionId);

  if (historyAlreadyReplayed) {
    traceDuration('history.handler_total', perfStart, { ok: true });
    return;
  }

  const replayStart = perfNowMs();
  replayHistoryFromStore();
  traceDuration('history.replay_from_store', replayStart);
  traceDuration('history.handler_total', perfStart, { ok: true });
}

function traceHistoryScan({ perfTraceId, phase, sessionId, messageType, start, scanStats, detail = null }) {
  if (!perfTraceId) return;
  recordAgentPerfTrace(ctx.CONFIG, {
    traceId: perfTraceId,
    phase,
    sessionId,
    messageType,
    durationMs: perfNowMs() - start,
    bytes: Number(scanStats?.bytes) || 0,
    detail: {
      segments: Number(scanStats?.segments) || 0,
      rows: Number(scanStats?.rows) || 0,
      legacyFiles: Number(scanStats?.legacyFiles) || 0,
      ...(detail || {}),
    },
  });
}

function scheduleHistoryEventLoopTrace({ perfTraceId, phase, sessionId, messageType }) {
  if (!perfTraceId) return;
  const scheduledAt = perfNowMs();
  setImmediate(() => {
    recordAgentPerfTrace(ctx.CONFIG, {
      traceId: perfTraceId,
      phase,
      sessionId,
      messageType,
      durationMs: perfNowMs() - scheduledAt,
    });
  });
}

/**
 * Load one lightweight Conversation Outline page. The response contains only
 * visible user/assistant metadata and bounded snippets; full message bodies and
 * tool payloads stay on the Agent. `beforeSeq` is an exclusive older-page
 * cursor, and total counting is explicit because it scans the full transcript.
 *
 * @param {object} msg — { sessionId, beforeSeq, limit, includeTotal, perfTraceId }
 */
export async function handleYeaftLoadHistoryOutline(msg) {
  const sessionId = typeof msg?.sessionId === 'string' ? msg.sessionId.trim() : '';
  const requestId = typeof msg?.requestId === 'string' ? msg.requestId : null;
  const beforeSeq = Number.isFinite(msg?.beforeSeq) ? msg.beforeSeq : null;
  const limit = Math.min(100, Math.max(1, Number.isFinite(msg?.limit) ? Math.floor(msg.limit) : 50));
  const response = {
    type: 'yeaft_history_outline',
    requestId,
    sessionId: sessionId || null,
    results: [],
    hasMore: false,
    nextBeforeSeq: null,
    totalCount: null,
    _requestClientId: msg?._requestClientId || null,
  };

  if (!sessionId) {
    sendToServer({ ...response, error: 'invalid_session' });
    return;
  }

  const perfTraceId = typeof msg?.perfTraceId === 'string' && msg.perfTraceId.trim() ? msg.perfTraceId.trim() : null;
  const scanStats = {};
  scheduleHistoryEventLoopTrace({
    perfTraceId,
    phase: 'history_outline.event_loop_delay',
    sessionId,
    messageType: msg?.type || 'yeaft_load_history_outline',
  });
  const scanStart = perfNowMs();
  try {
    const defaultYeaftDir = ctx.CONFIG?.yeaftDir || DEFAULT_YEAFT_DIR;
    const storeDir = resolveSessionYeaftDir(defaultYeaftDir, sessionId);
    let result;
    let indexFallback = false;
    try {
      result = await loadConversationOutlineFromIndex(storeDir, sessionId, {
        limit,
        beforeSeq,
        cursor: msg?.cursor || null,
        includeTotal: msg?.includeTotal === true,
        _waitForBuild: false,
      });
    } catch (indexError) {
      sendToServer({
        ...response,
        error: indexError?.code === 'stale_result'
          ? 'stale_result'
          : (indexError?.code === 'index_building' ? 'index_building' : 'index_unavailable'),
        ...(perfTraceId ? { perfTraceId } : {}),
      });
      return;
    }
    if (!indexFallback) {
      scanStats.segments = Number(result.indexSourceFiles) || 0;
      scanStats.bytes = Number(result.indexSourceBytes) || 0;
      scanStats.rows = Number(result.indexEntryCount) || 0;
    }
    traceHistoryScan({
      perfTraceId,
      phase: 'history_outline.store_scan',
      sessionId,
      messageType: msg?.type || 'yeaft_load_history_outline',
      start: scanStart,
      scanStats,
      detail: {
        limit,
        includeTotal: msg?.includeTotal === true,
        resultCount: result.results.length,
        indexGeneration: result.indexGeneration || null,
        indexFallback,
      },
    });
    sendToServer({ ...response, ...result, ...(perfTraceId ? { perfTraceId } : {}) });
  } catch (err) {
    console.error('[Yeaft] Session history outline failed:', err?.message || err);
    sendToServer({ ...response, error: 'outline_failed' });
  }
}

export async function handleYeaftSearchHistory(msg) {
  const sessionId = typeof msg?.sessionId === 'string' ? msg.sessionId.trim() : '';
  const query = typeof msg?.query === 'string' ? msg.query.trim().slice(0, 500) : '';
  const senderKey = typeof msg?.senderKey === 'string' && (msg.senderKey === 'user' || msg.senderKey.startsWith('vp:'))
    ? msg.senderKey.slice(0, 103)
    : '';
  const requestId = typeof msg?.requestId === 'string' ? msg.requestId : null;
  const beforeSeq = Number.isFinite(msg?.beforeSeq) ? msg.beforeSeq : null;
  const limit = Math.min(50, Math.max(1, Number.isFinite(msg?.limit) ? Math.floor(msg.limit) : 20));
  const response = {
    type: 'yeaft_history_search_result',
    requestId,
    sessionId: sessionId || null,
    query,
    senderKey,
    results: [],
    hasMore: false,
    nextBeforeSeq: null,
    _requestClientId: msg?._requestClientId || null,
  };

  if (!sessionId || (Array.from(query).length < 1 && !senderKey)) {
    sendToServer(response);
    return;
  }

  const perfTraceId = typeof msg?.perfTraceId === 'string' && msg.perfTraceId.trim() ? msg.perfTraceId.trim() : null;
  const scanStats = {};
  scheduleHistoryEventLoopTrace({
    perfTraceId,
    phase: 'history_search.event_loop_delay',
    sessionId,
    messageType: msg?.type || 'yeaft_search_history',
  });
  const scanStart = perfNowMs();
  try {
    const defaultYeaftDir = ctx.CONFIG?.yeaftDir || DEFAULT_YEAFT_DIR;
    const storeDir = resolveSessionYeaftDir(defaultYeaftDir, sessionId);
    let result;
    let indexFallback = false;
    try {
      result = await searchConversationIndex(storeDir, sessionId, query, {
        limit,
        beforeSeq,
        cursor: msg?.cursor || null,
        senderKey,
        _waitForBuild: false,
      });
    } catch (indexError) {
      sendToServer({
        ...response,
        error: indexError?.code === 'stale_result'
          ? 'stale_result'
          : (indexError?.code === 'index_building' ? 'index_building' : 'index_unavailable'),
        ...(perfTraceId ? { perfTraceId } : {}),
      });
      return;
    }
    if (!indexFallback) {
      scanStats.segments = Number(result.indexSourceFiles) || 0;
      scanStats.bytes = Number(result.indexSourceBytes) || 0;
      scanStats.rows = Number(result.indexEntryCount) || 0;
    }
    traceHistoryScan({
      perfTraceId,
      phase: 'history_search.store_scan',
      sessionId,
      messageType: msg?.type || 'yeaft_search_history',
      start: scanStart,
      scanStats,
      detail: {
        limit,
        queryLength: Array.from(query).length,
        senderFilter: !!senderKey,
        resultCount: result.results.length,
        indexGeneration: result.indexGeneration || null,
        indexFallback,
      },
    });
    sendToServer({ ...response, ...result, ...(perfTraceId ? { perfTraceId } : {}) });
  } catch (err) {
    console.error('[Yeaft] Session history search failed:', err?.message || err);
    sendToServer({ ...response, error: 'search_failed' });
  }
}

export async function handleYeaftLoadHistoryWindow(msg) {
  const sessionId = typeof msg?.sessionId === 'string' ? msg.sessionId.trim() : '';
  const requestId = typeof msg?.requestId === 'string' ? msg.requestId : null;
  const anchorSeq = Number(msg?.anchorSeq);
  const anchorMessageId = typeof msg?.anchorMessageId === 'string' ? msg.anchorMessageId : null;
  const entryId = typeof msg?.entryId === 'string' ? msg.entryId : null;
  const indexGeneration = Number(msg?.indexGeneration);
  const entryStartSeq = Number(msg?.entryStartSeq);
  const response = {
    type: 'yeaft_history_window',
    requestId,
    conversationId: ensureYeaftConversationId(),
    sessionId: sessionId || null,
    entryId,
    indexGeneration: Number.isFinite(indexGeneration) ? indexGeneration : null,
    entryStartSeq: Number.isFinite(entryStartSeq) ? entryStartSeq : null,
    anchorMessageId,
    anchorSeq: Number.isFinite(anchorSeq) ? anchorSeq : null,
    messages: [],
    oldestSeq: null,
    hasMoreBefore: false,
    _requestClientId: msg?._requestClientId || null,
  };

  if (!sessionId || !entryId || !anchorMessageId
    || !Number.isFinite(indexGeneration)
    || !Number.isFinite(entryStartSeq)
    || !Number.isFinite(anchorSeq)) {
    sendToServer({ ...response, error: 'invalid_anchor' });
    return;
  }

  try {
    const defaultYeaftDir = ctx.CONFIG?.yeaftDir || DEFAULT_YEAFT_DIR;
    const storeDir = resolveSessionYeaftDir(defaultYeaftDir, sessionId);
    const loaded = await readConversationIndexWindow(storeDir, sessionId, {
      indexGeneration,
      entryId,
      entryStartSeq,
      anchorMessageId,
      anchorSeq,
      beforeTurns: msg?.beforeTurns,
      afterTurns: msg?.afterTurns,
      maxRows: msg?.maxRows,
      maxBytes: msg?.maxBytes,
    });
    if (!loaded?.ok) {
      sendToServer({ ...response, error: 'stale_result' });
      return;
    }
    sendToServer({
      ...response,
      ...loaded.window,
      entryEndSeq: loaded.entry.entryEndSeq,
      sourceMessageIds: loaded.entry.sourceMessageIds,
      messages: projectVisibleHistoryChunkMessages(loaded.window.messages),
    });
  } catch (err) {
    console.error('[Yeaft] Session history anchor load failed:', err?.message || err);
    sendToServer({
      ...response,
      error: err?.code === 'stale_result' ? 'stale_result' : 'window_load_failed',
    });
  }
}

export async function handleYeaftLoadMoreHistory(msg) {
  const sessionId = (msg && typeof msg.sessionId === 'string' && msg.sessionId) || null;
  const requestId = typeof msg?.requestId === 'string' && msg.requestId ? msg.requestId : null;
  const requestClientId = typeof msg?._requestClientId === 'string' && msg._requestClientId ? msg._requestClientId : null;
  const perfTraceId = typeof msg?.perfTraceId === 'string' && msg.perfTraceId.trim() ? msg.perfTraceId.trim() : null;
  const perfStart = perfNowMs();
  const tracePerf = (phase, extra = {}) => {
    if (!perfTraceId) return;
    recordAgentPerfTrace(ctx.CONFIG, { traceId: perfTraceId, phase, sessionId, messageType: msg?.type || 'yeaft_load_more_history', ...extra });
  };
  const traceDuration = (phase, start, extra = {}) => tracePerf(phase, { durationMs: perfNowMs() - start, ...extra });
  tracePerf('history_more.received');
  if (!sessionId) {
    emitHistoryChunk({ sessionId, messages: [], mode: 'older', oldestSeq: null, hasMore: false, requestId, requestClientId, perfTraceId });
    traceDuration('history_more.handler_total', perfStart, { ok: false, detail: { missingSessionId: true } });
    return;
  }

  const beforeSeq = (typeof msg.beforeSeq === 'number') ? msg.beforeSeq : null;
  const pageKind = msg.pageKind === 'gap' ? 'gap' : 'server';
  const gapStopAtSeq = pageKind === 'gap' && Number.isFinite(msg.gapStopAtSeq)
    ? msg.gapStopAtSeq
    : null;
  const cacheEpoch = Number.isFinite(msg.cacheEpoch) ? msg.cacheEpoch : 0;
  const turns = Math.min(50, (typeof msg.turns === 'number' && msg.turns > 0) ? Math.floor(msg.turns) : 20);

  let result;
  try {
    const loadStart = perfNowMs();
    const store = session?.conversationStore || new ConversationStore(
      resolveSessionYeaftDir(ctx.CONFIG?.yeaftDir || DEFAULT_YEAFT_DIR, sessionId),
    );
    result = loadVisibleGroupHistoryPage(store, sessionId, turns, beforeSeq, {
      stopAtSeq: gapStopAtSeq,
    });
    traceDuration('history_more.store_load', loadStart, {
      detail: { count: result.messages?.length || 0, beforeSeq, turns, pageKind, gapStopAtSeq },
    });
  } catch (err) {
    console.error('[Yeaft] loadOlderBySession failed:', err.message);
    result = { messages: [], oldestSeq: null, hasMore: false };
    tracePerf('history_more.store_error', { ok: false, detail: { errorName: err?.name || null, errorMessage: err?.message || String(err) } });
  }

  // Wire shape mirrors handleYeaftLoadHistory's projection: only visible
  // user / assistant text rows. Internal reflection/system-only rows stay
  // server-side, and stable ids + speaker attribution ride with each row
  // so older-history prepend renders exactly like refresh replay.
  const emitStart = perfNowMs();
  emitHistoryChunk({
    sessionId,
    messages: result.messages || [],
    mode: 'older',
    oldestSeq: result.oldestSeq,
    nextBeforeSeq: result.nextBeforeSeq,
    hasMore: !!result.hasMore,
    turns,
    pageKind,
    gapStopAtSeq,
    cacheEpoch,
    requestId,
    requestClientId,
    perfTraceId,
  });
  traceDuration('history_more.emit_chunk', emitStart, { detail: { count: result.messages?.length || 0 } });
  traceDuration('history_more.handler_total', perfStart, { ok: true });
}

/**
 * Reset Yeaft session. Aborts the in-flight controller, tears down the
 * session, then re-initialises so the frontend gets fresh config.
 */
export async function resetYeaftSession() {
  // Runtime ownership must be revoked before reset reaches its first await.
  const oldSession = session;
  const oldRuntimesShutdown = shutdownProjectRuntimes();
  await oldRuntimesShutdown;
  if (currentAbortCtrl && !currentAbortCtrl.signal.aborted) {
    try { currentAbortCtrl.abort(); } catch { /* ignore */ }
  }
  currentAbortCtrl = null;
  if (_vpUnsubscribe) {
    try { _vpUnsubscribe(); } catch { /* ignore */ }
    _vpUnsubscribe = null;
  }
  if (oldSession) {
    await oldSession.shutdown();
    if (session === oldSession) session = null;
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
  for (const turnId of turnAbortMeta.keys()) revokeTurnRepoApproval(turnId);
  turnAbortCtrls.clear();
  turnAbortMeta.clear();
  vpInboxes.clear();
  vpDrivers.clear();
  vpEngines.clear();
  vpEngineConfigKeys.clear();
  asyncTaskOwners.clear();
  sessionContexts.clear();
  projectContextBySession.clear();
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
    session = await loadRuntimeSession({
      ...(yeaftDir && { dir: yeaftDir }),
      skipMCP: true,
      skipSkills: true,
      serverMode: true,
      managedCliReady: ctx.managedCliReady,
      workCenterEnabled: ctx.CONFIG?.workCenterEnabled === true,
    });
    claimRuntimeOwnership(session);
    installYeaftRuntimeBridge(session);

    yeaftConversationId = createYeaftConversationId();
    scheduleBaseRuntimeLoad();
    hydrateYeaftStatusFromSession(session, { reason: 'reset', emitEvent: true });
    broadcastSkillSlashCommands(session);

    // Per-group history hydrates lazily via getOrCreateSessionHistory on
    // first read. Nothing to seed here.

    sendSessionEvent({
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

// ────────────────────────────────────────────────────────────
// MCP CRUD wire handlers (Claude-Code-style Settings → MCP tab)
//
// Wire types: `yeaft_mcp_list` / `yeaft_mcp_add` / `yeaft_mcp_remove` /
// `yeaft_mcp_reload`. Each:
//   1. Reads / writes ~/.yeaft/config.json `mcpServers` via config-api.
//   2. Calls `session.mcpManager.connect|disconnect` to apply at runtime.
//   3. Hot-swaps the live `toolRegistry` via `replaceMcpTools(...)` so the
//      next LLM turn sees the new tool catalogue WITHOUT a session restart.
//   4. Broadcasts `yeaft_mcp_updated` so any subscribed web client (the
//      Settings panel + any open Yeaft view) refreshes its badge without
//      a manual reload.
//
// The handlers do NOT block on `ensureSessionLoaded()` — the session may
// not yet be initialised when the user opens Settings before sending the
// first message. In that case `session` is null and we operate ONLY on
// the on-disk config; the live runtime takes effect on the next session
// boot. When `session` IS available, we apply the runtime change too.
//
// Wire shape per response: always `{ type: 'yeaft_mcp_*', servers, runtime?, error? }`.
// Frontend reducer should treat `error` as a non-empty string failure.
// ────────────────────────────────────────────────────────────

/**
 * Snapshot the live MCP runtime so the UI can render per-server
 * connection state next to the configured servers. Safe to call when
 * the session hasn't been initialised yet — returns an empty runtime.
 */
function activeMcpManager(owner = captureRuntimeOwner()) {
  if (!isCurrentRuntimeOwner(owner)) return session?.mcpManager || null;
  if (activeRuntimeKey !== BASE_RUNTIME_KEY) {
    const runtime = projectRuntimes.get(activeRuntimeKey) || null;
    if (runtimeBelongsToOwner(runtime, owner)) return runtime.mcpManager || null;
  }
  return owner.ownerSession.mcpManager || null;
}

async function retireInactiveMcpRuntimes(owner, activeManager) {
  if (!isCurrentRuntimeOwner(owner)) return;
  const retire = [];

  // The base manager stays cached while a project runtime is active. It was
  // built from the old Agent config, so remove it rather than allowing a later
  // base activation to revive a deleted MCP. The next base turn schedules a
  // fresh loader; until then there is deliberately no base MCP fallback.
  if (runtimeBelongsToOwner(baseRuntime, owner) && baseRuntime.mcpManager !== activeManager) {
    const staleBase = baseRuntime;
    baseRuntime = null;
    baseRuntimeLoadPromises.delete(BASE_RUNTIME_KEY);
    if (owner.ownerSession.mcpManager === staleBase.mcpManager) owner.ownerSession.mcpManager = null;
    // A loading manager may acquire its connection after this point. Its
    // post-connect ownership check performs the reliable cleanup in that case.
    if (!staleBase.loading) retire.push(disconnectRuntimeMcpManager(staleBase.mcpManager));
  }

  for (const [key, runtime] of projectRuntimes) {
    if (!runtimeBelongsToOwner(runtime, owner) || runtime.mcpManager === activeManager) continue;
    projectRuntimes.delete(key);
    projectRuntimeLoadPromises.delete(key);
    if (!runtime.loading) retire.push(disconnectRuntimeMcpManager(runtime.mcpManager));
  }

  await Promise.allSettled(retire);
}

function mcpRuntimeSnapshot() {
  const mcpManager = activeMcpManager();
  if (!mcpManager) {
    return { connected: false, toolCount: 0, perServer: [] };
  }
  const status = mcpManager.status() || [];
  const toolCount = typeof mcpManager.toolCount === 'number'
    ? mcpManager.toolCount
    : status.reduce((sum, s) => sum + (s.toolCount || 0), 0);
  return {
    connected: !!mcpManager.hasServers,
    toolCount,
    perServer: status.map(s => ({
      name: s.name,
      ready: !!s.ready,
      toolCount: s.toolCount || 0,
    })),
  };
}

/**
 * Re-flatten MCP tools into the live ToolRegistry. No-op when the session
 * (or its registry) hasn't been created yet — the next session boot will
 * pick up the change.
 */
function hotSwapMcpTools() {
  const owner = captureRuntimeOwner();
  return replaceSessionMcpTools(owner, activeMcpManager(owner));
}

/**
 * Broadcast a `yeaft_mcp_updated` event so any client subscribed to the
 * Yeaft view (Settings panel, status badge) refreshes without needing
 * to re-open the panel. A CRUD/reload caller should pass its confirmed
 * `configuredServers` snapshot rather than rereading config after async
 * runtime work. Fallback reads preserve an existing UI cache on failure by
 * omitting `servers` and reporting the strict-read error.
 */
function broadcastMcpUpdated({ configuredServers, ...extra } = {}) {
  let servers = configuredServers;
  let error = null;
  if (!Array.isArray(servers)) {
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    const listed = listMcpServers(yeaftDir);
    if (listed.error) error = listed.error;
    else servers = listed.servers;
  }

  return sendToServer({
    type: 'yeaft_mcp_updated',
    runtime: mcpRuntimeSnapshot(),
    ...extra,
    ...(Array.isArray(servers) ? { servers } : {}),
    error,
  });
}

export function handleYeaftMcpList(msg = {}) {
  const yeaftDir = ctx.CONFIG?.yeaftDir;
  const listed = listMcpServers(yeaftDir);
  sendToServer({
    type: 'yeaft_mcp_list_result',
    requestId: msg.requestId || null,
    servers: listed.servers || [],
    runtime: mcpRuntimeSnapshot(),
    error: listed.error || null,
  });
}

async function runYeaftMcpAddMutation(msg = {}) {
  const yeaftDir = ctx.CONFIG?.yeaftDir;
  const result = upsertMcpServer(msg.server || {}, yeaftDir);
  if (result.error) {
    await sendToServer({
      type: 'yeaft_mcp_add_result',
      requestId: msg.requestId || null,
      servers: [],
      runtime: mcpRuntimeSnapshot(),
      error: result.error,
    });
    return;
  }

  // A queued runtime bootstrap may have made a project manager active before
  // this mutation runs. Capture the manager after the config write, then
  // retire inactive caches and update the manager that owns live tools.
  const owner = captureRuntimeOwner();
  const mcpManager = activeMcpManager(owner);
  await retireInactiveMcpRuntimes(owner, mcpManager);
  let connectError = null;
  if (mcpManager && !isMcpServerEnabled(result.server.name)) {
    try {
      await mcpManager.disconnect(result.server.name);
    } catch { /* no active connection to retire */ }
  } else if (mcpManager) {
    try {
      await mcpManager.connect(result.server);
    } catch (err) {
      connectError = err?.message || String(err);
      console.warn(`[Yeaft] MCP connect "${result.server.name}" failed:`, connectError);
    }
  }

  const swap = replaceSessionMcpTools(owner, mcpManager);
  await sendToServer({
    type: 'yeaft_mcp_add_result',
    requestId: msg.requestId || null,
    servers: result.servers,
    runtime: mcpRuntimeSnapshot(),
    swap,
    connectError,
    error: null,
  });
  await broadcastMcpUpdated({
    reason: 'add',
    name: result.server.name,
    connectError,
    configuredServers: result.servers,
  });
}

export function handleYeaftMcpAdd(msg = {}) {
  return enqueueMcpTransition(() => runYeaftMcpAddMutation(msg));
}

async function runYeaftMcpRemoveMutation(msg = {}) {
  const yeaftDir = ctx.CONFIG?.yeaftDir;
  const name = typeof msg.name === 'string' ? msg.name : '';
  const result = removeMcpServer(name, yeaftDir);
  if (result.error) {
    await sendToServer({
      type: 'yeaft_mcp_remove_result',
      requestId: msg.requestId || null,
      servers: [],
      runtime: mcpRuntimeSnapshot(),
      error: result.error,
    });
    return;
  }

  const owner = captureRuntimeOwner();
  const mcpManager = activeMcpManager(owner);
  await retireInactiveMcpRuntimes(owner, mcpManager);
  if (mcpManager) {
    try {
      await mcpManager.disconnect(name);
    } catch (err) {
      console.warn(`[Yeaft] MCP disconnect "${name}" failed:`, err?.message || err);
    }
  }

  const swap = replaceSessionMcpTools(owner, mcpManager);
  await sendToServer({
    type: 'yeaft_mcp_remove_result',
    requestId: msg.requestId || null,
    servers: result.servers,
    runtime: mcpRuntimeSnapshot(),
    removed: !!result.removed,
    swap,
    error: null,
  });
  await broadcastMcpUpdated({
    reason: 'remove',
    name,
    configuredServers: result.servers,
  });
}

export function handleYeaftMcpRemove(msg = {}) {
  return enqueueMcpTransition(() => runYeaftMcpRemoveMutation(msg));
}

async function runYeaftMcpReloadMutation(msg = {}) {
  const yeaftDir = ctx.CONFIG?.yeaftDir;
  const targetName = typeof msg.name === 'string' && msg.name ? msg.name : null;
  const listed = listMcpServers(yeaftDir);

  // Do not turn a failed strict config read into an empty successful reload.
  // In particular, leave an existing MCP runtime and its flattened tools alone
  // until the user repairs config.json.
  if (listed.error) {
    await sendToServer({
      type: 'yeaft_mcp_reload_result',
      requestId: msg.requestId || null,
      servers: [],
      runtime: mcpRuntimeSnapshot(),
      error: listed.error,
    });
    return;
  }

  const owner = captureRuntimeOwner();
  const mcpManager = activeMcpManager(owner);
  if (!mcpManager) {
    // Session not yet alive; just echo the current config + an empty
    // runtime so the UI knows to wait for session boot.
    await sendToServer({
      type: 'yeaft_mcp_reload_result',
      requestId: msg.requestId || null,
      servers: listed.servers,
      runtime: mcpRuntimeSnapshot(),
      error: null,
    });
    return;
  }

  // Full reload applies an externally changed Agent MCP config, so stale
  // runtime caches are just as unsafe as after add/remove. A named reload is
  // only a local reconnect and must keep inactive base/project caches warm.
  if (!targetName) await retireInactiveMcpRuntimes(owner, mcpManager);

  const configured = listed.servers;
  const enabled = configured.filter(server => isMcpServerEnabled(server.name));
  const failures = [];
  try {
    if (targetName) {
      const cfg = enabled.find(server => server.name === targetName);
      try { await mcpManager.disconnect(targetName); } catch { /* ignore */ }
      if (cfg) {
        try { await mcpManager.connect(cfg); }
        catch (err) { failures.push({ name: targetName, error: err?.message || String(err) }); }
      }
    } else {
      try { await mcpManager.disconnectAll(); } catch { /* ignore */ }
      for (const cfg of enabled) {
        try { await mcpManager.connect(cfg); }
        catch (err) { failures.push({ name: cfg.name, error: err?.message || String(err) }); }
      }
    }
  } catch (err) {
    console.warn('[Yeaft] MCP reload failed:', err?.message || err);
  }

  const swap = replaceSessionMcpTools(owner, mcpManager);
  await sendToServer({
    type: 'yeaft_mcp_reload_result',
    requestId: msg.requestId || null,
    servers: configured,
    runtime: mcpRuntimeSnapshot(),
    failures,
    swap,
    error: null,
  });
  await broadcastMcpUpdated({
    reason: 'reload',
    name: targetName,
    failures,
    configuredServers: configured,
  });
}

export function handleYeaftMcpReload(msg = {}) {
  return enqueueMcpTransition(() => runYeaftMcpReloadMutation(msg));
}

export const __testHooks = {
  loadProjects,
  sharedProjectContext,
  buildProjectSharedBlock,
  normalizeProjectContext,
  handleProjectContextSyncForTest(msg) {
    handleYeaftProjectContextSync(msg);
  },
  projectContextForSessionForTest(sessionId) {
    return projectContextBySession.get(sessionId) || null;
  },
  loadVisibleGroupHistoryPage,
  projectVisibleHistoryChunkMessages,
  persistInboundMessageOnceByMsgId,
  buildPendingRescueEnvelope,
  runYeaftSessionSendForTest(msg) {
    return runYeaftSessionSend(msg);
  },
  setSessionForTest(nextSession) {
    __testSetSession(nextSession || null);
  },
  broadcastMcpUpdatedForTest(extra) {
    return broadcastMcpUpdated(extra);
  },
  setRuntimeFactoriesForTest({
    createSkillManager: nextCreateSkillManager,
    createMcpManager: nextCreateMcpManager,
    loadMcpConfig: nextLoadMcpConfig,
    loadSession: nextLoadSession,
  } = {}) {
    if (typeof nextCreateSkillManager === 'function') createRuntimeSkillManager = nextCreateSkillManager;
    if (typeof nextCreateMcpManager === 'function') createRuntimeMcpManager = nextCreateMcpManager;
    if (typeof nextLoadMcpConfig === 'function') loadRuntimeMcpConfig = nextLoadMcpConfig;
    if (typeof nextLoadSession === 'function') loadRuntimeSession = nextLoadSession;
  },
  resetRuntimeFactoriesForTest() {
    createRuntimeSkillManager = createSkillManager;
    createRuntimeMcpManager = () => new MCPManager();
    loadRuntimeMcpConfig = loadMCPConfig;
    loadRuntimeSession = loadSession;
  },
  scheduleBaseRuntimeLoadForTest() {
    return scheduleBaseRuntimeLoad();
  },
  scheduleProjectRuntimeLoadForTest(workDir) {
    return scheduleProjectRuntimeLoad(workDir);
  },
  activateBaseRuntimeForTest() {
    return activateBaseRuntime();
  },
  activateProjectRuntimeForTest(workDir) {
    const runtime = projectRuntimes.get(projectRuntimeKey(workDir)) || null;
    return activateProjectRuntime(runtime);
  },
  startSkillHotReloadForTest() {
    return startSkillHotReload();
  },
  runtimeLifecycleSnapshotForTest(workDir = '') {
    const key = workDir ? projectRuntimeKey(workDir) : null;
    const owner = captureRuntimeOwner();
    return {
      generation: runtimeGeneration,
      ownerSession: runtimeOwnerSession,
      activeRuntimeKey,
      timerActive: !!skillReloadTimer,
      timerOwnerGeneration: skillReloadOwner?.generation ?? null,
      timerOwnerSession: skillReloadOwner?.ownerSession || null,
      basePromise: baseRuntimeLoadPromises.get(BASE_RUNTIME_KEY) || null,
      projectPromise: key ? projectRuntimeLoadPromises.get(key) || null : null,
      projectRuntime: key ? projectRuntimes.get(key) || null : null,
      activeSkillManager: activeSkillRuntime(owner)?.skillManager || null,
    };
  },
  ensureYeaftConversationIdForTest() {
    return ensureYeaftConversationId();
  },
  setYeaftConversationIdForTest(value) {
    yeaftConversationId = value || null;
  },
  preloadYeaftSkillSlashCommandsForTest() {
    return broadcastSkillSlashCommands(session);
  },
  reloadActiveSkillsForTest() {
    return reloadActiveSkills();
  },
  loadAndBroadcastYeaftSkillSlashCommandsForTest() {
    return loadAndBroadcastYeaftSkillSlashCommands();
  },
  resetAbortState() {
    for (const turnId of turnRepoApprovals.keys()) revokeTurnRepoApproval(turnId);
    turnAbortCtrls.clear();
    turnAbortMeta.clear();
    vpAborts.clear();
    vpInboxes.clear();
  },
  seedPendingUserPrompt({ requestId = 'ask-test', sessionId = 'session-test', vpId = 'vp-test', threadId = 'main', turnId = 'turn-test', toolCallId = 'call-test', question = 'Continue?', options = [], createdAt = Date.now(), expiresAt = Date.now() + ASK_USER_TIMEOUT_MS } = {}) {
    let resolved;
    const promise = new Promise(resolve => { resolved = resolve; });
    pendingUserPrompts.set(requestId, { resolve: resolved, sessionId, vpId, threadId, turnId, toolCallId, question, options, createdAt, expiresAt, timer: null });
    return promise;
  },
  replayPendingUserPrompts,
  settlePendingUserPromptForTest(requestId, opts = {}) {
    const pending = pendingUserPrompts.get(requestId);
    return pending ? settlePendingUserPrompt(requestId, pending, opts) : false;
  },
  resetPendingUserPrompts() {
    for (const pending of pendingUserPrompts.values()) {
      if (pending.timer) clearTimeout(pending.timer);
    }
    pendingUserPrompts.clear();
  },
  resetVpStatusBroker() {
    if (vpStatusBroker) vpStatusBroker.reset();
  },
  seedVpStatus(status) {
    return getVpStatusBroker().transition(status);
  },
  decorateSessionsWithRuntimeState,
  resolveDreamTriggerSessionId,
  async loadProjectRuntime(workDir) {
    return loadProjectRuntime(workDir);
  },
  registerRoutePromiseForTest(msgId, promise) {
    registerRoutePromise(msgId, promise);
  },
  routePromiseEntryCountForTest() {
    return routePromisesByMsgId.size;
  },
  getOrCreateSessionContextForTest(sessionId, sessionHandle) {
    return getOrCreateSessionContext(sessionId, sessionHandle);
  },
  clearSessionContextForTest(sessionId) {
    const entry = sessionContexts.get(sessionId);
    try { entry?.sessionHandle?.close?.(); } catch { /* best-effort test cleanup */ }
    sessionContexts.delete(sessionId);
  },
  seedSessionContext(sessionId, meta) {
    const group = {
      getMeta() { return structuredClone(meta); },
      appendMessage(record) {
        return {
          ...record,
          id: record?.id || `msg-${Date.now()}`,
          ts: record?.ts || new Date().toISOString(),
          role: record?.role || (record?.from === 'user' ? 'user' : 'assistant'),
          meta: record?.meta || {},
        };
      },
    };
    const coord = createCoordinator(group, {
      deliver: (vpId, envelope) => enqueueForVp(sessionId, vpId, envelope),
    });
    const entry = makeGroupContextStub();
    entry.coord = coord;
    entry.router = createRouter({
      coordinator: coord,
    });
    entry.sessionHandle = group;
    entry.historyHydrated = true;
    sessionContexts.set(sessionId, entry);
    return entry;
  },
  seedProjectRuntime(workDir, runtime) {
    const normalizedWorkDir = normalizeSessionWorkDir(workDir);
    const owner = captureRuntimeOwner();
    const seeded = {
      generation: owner?.generation ?? runtimeGeneration,
      ownerSession: owner?.ownerSession || session,
      workDir: normalizedWorkDir,
      skillManager: runtime?.skillManager || { list: () => [] },
      mcpManager: runtime?.mcpManager || { listTools: () => [], disconnectAll: async () => {} },
      mcpStatus: runtime?.mcpStatus || { connected: [], failed: [] },
      configuredMcpConfig: runtime?.configuredMcpConfig || runtime?.mcpConfig || { servers: [], skipped: [] },
      effectiveMcpConfig: runtime?.effectiveMcpConfig || runtime?.mcpConfig || { servers: [], skipped: [] },
      status: runtime?.status || { skills: 0, mcpServers: [], mcpFailed: [], mcpSkipped: [], tools: 0 },
    };
    projectRuntimes.set(projectRuntimeKey(normalizedWorkDir), seeded);
    return seeded;
  },
  async shutdownProjectRuntimes() {
    return shutdownProjectRuntimes();
  },
  projectRuntimeCount() {
    return projectRuntimes.size;
  },
  queryTimeoutMsForSessionConfig,
  queryTimeoutMsForSession,
  seedQueuedVpTurn({ sessionId = 'session-test', vpId = 'vp-test', threadId = 'main', turnId = 'turn-test' } = {}) {
    const key = threadKey(sessionId, vpId, threadId);
    const inbox = vpInboxes.get(key) || [];
    inbox.push({ envelope: { msg: { id: `${turnId}-msg` } }, turnId, thread: { threadId, title: '', messageIds: [] } });
    vpInboxes.set(key, inbox);
    turnAbortMeta.set(turnId, { sessionId, vpId, threadId, key });
    return { key, turnId };
  },
  seedRunningVpTurn({ sessionId = 'session-test', vpId = 'vp-test', threadId = 'main', turnId = 'turn-test' } = {}) {
    const key = threadKey(sessionId, vpId, threadId);
    const ctrl = new AbortController();
    vpAborts.set(key, ctrl);
    turnAbortCtrls.set(turnId, ctrl);
    turnAbortMeta.set(turnId, { sessionId, vpId, threadId, key });
    return { key, turnId, ctrl };
  },
  queuedTurnIds() {
    return Array.from(vpInboxes.values()).flatMap((inbox) => Array.isArray(inbox) ? inbox.map((entry) => entry.turnId) : []);
  },
  asyncTaskCoordinatorForTest() {
    return buildAsyncTaskCoordinator();
  },
  asyncTaskOwnerForTest(taskId) {
    return asyncTaskOwners.get(taskId) || null;
  },
};
