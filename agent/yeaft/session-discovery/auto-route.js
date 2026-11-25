/**
 * auto-route.js — Hybrid two-stage Session auto-routing engine for Sessionless entry.
 *
 * Stage 0 (Zero-LLM local scorer & high-precision fast-path, <5 ms, $0):
 *   - Scores all running + recent (<= 5 day) authorized non-task Sessions with
 *     scale-invariant normalized IDF, recency-weighted TF, exact utterance matching,
 *     and meta-diagnostic detection.
 *   - Resolves unmistakable cases directly without invoking an LLM:
 *       * Exact unambiguous match to a single pending AskUser option
 *       * Exact/near-exact repeated user utterance in one Session
 *       * High-margin lexical/entity hit in a fresh Session
 *       * Short/anaphoric continuation to a sole recently active Session
 *
 * Stage 1 (Compact single-shot unified LLM arbiter, max 1 LLM call):
 *   - Evaluates running Sessions (with pending AskUser prompts) and the top
 *     relevance + recency idle candidates side by side so running Sessions never
 *     blindly hijack messages owned by idle Sessions.
 *   - Returns either a matched Session (`action: 'continue'`) OR complete new
 *     Session metadata `{ sceneId, workDir, title }` (`action: 'create'`) in a
 *     single compact JSON call instead of 2-3 serial calls.
 *
 * Serializes routing decisions per `(ownerKey)` so two back-to-back auto-route
 * messages from the same user never split into duplicate newly-created Sessions.
 */

import { join } from 'node:path';
import {
  AUTO_ROUTE_SESSION_SCENARIO_ID,
  PLAN_NEW_SESSION_SCENARIO_ID,
  fallbackShortTitle,
  runDecision,
} from '../decision/index.js';
import { SESSION_SCENE_IDS, isSessionSceneId } from '../sessions/scene-ids.js';
import { loadSessionConfig } from '../sessions/session-config.js';
import { loadSessionMeta } from '../sessions/session-store.js';
import { sessionsRoot, snapshotSessions } from '../sessions/session-crud.js';
import { normalizeWorkspaceFolderPath, selectCandidateWorkspaceFolders } from '../workspace-folders.js';
import {
  scoreRouteCandidates,
  selectCandidatesForLlm,
  tryFastPathRoute,
} from './route-scorer.js';
import {
  DAY_MS,
  getSessionMessagesInWindowFromIndex,
  listActiveSessionCards,
  openDiscoveryStore,
  searchDiscovery,
  searchDiscoveryRelaxed,
} from './store.js';

export const SESSION_AUTO_ROUTE_CAPABILITY = 'session_auto_route';
export const DEFAULT_AUTO_ROUTE_WINDOW_DAYS = 5;

const ownerRouteLocks = new Map();

/**
 * Serialize auto-route decisions per owner so rapid consecutive messages
 * observe the Session created by the first message instead of racing two creates.
 */
export async function withAutoRouteLock(ownerKey, fn) {
  const key = String(ownerKey || '__default__');
  const prev = ownerRouteLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  const chained = prev.then(() => current, () => current);
  ownerRouteLocks.set(key, chained);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (ownerRouteLocks.get(key) === chained) {
      ownerRouteLocks.delete(key);
    }
  }
}

function normalizeAllowedIdSet(allowedSessionIds) {
  if (!Array.isArray(allowedSessionIds)) return new Set();
  return new Set(
    allowedSessionIds
      .filter(id => typeof id === 'string' && id.trim())
      .map(id => id.trim()),
  );
}

function isTaskSession(yeaftDir, sessionId, metaCache) {
  if (!metaCache.has(sessionId)) {
    metaCache.set(sessionId, loadSessionMeta(join(sessionsRoot(yeaftDir), sessionId)));
  }
  return Boolean(metaCache.get(sessionId)?.task);
}

function getCachedMeta(yeaftDir, sessionId, metaCache) {
  if (!metaCache.has(sessionId)) {
    metaCache.set(sessionId, loadSessionMeta(join(sessionsRoot(yeaftDir), sessionId)));
  }
  return metaCache.get(sessionId);
}

/**
 * Collect recent idle candidate cards within the 5-day window (excluding any
 * scheduled-task Sessions and already-running `excludeSessionIds`), merging
 * natural-language OR-scored FTS5 hits, recency cards from `discovery.db`, and
 * freshly-active manifest Sessions.
 */
export function collectRecentIdleCandidates(yeaftDir, {
  allowedSessionIds = [],
  excludeSessionIds = new Set(),
  query = '',
  activeWindowDays = DEFAULT_AUTO_ROUTE_WINDOW_DAYS,
  now = Date.now(),
  maxCandidates = 24,
  readRecentFallbackMessages = null,
} = {}) {
  const allowedList = [...normalizeAllowedIdSet(allowedSessionIds)]
    .filter(id => !excludeSessionIds.has(id));
  if (allowedList.length === 0) return { candidates: [], dbAvailable: false };

  const sinceMs = now - Math.max(1, Number(activeWindowDays) || DEFAULT_AUTO_ROUTE_WINDOW_DAYS) * DAY_MS;
  const byId = new Map();
  const metaCache = new Map();
  let db = null;
  try {
    db = openDiscoveryStore(yeaftDir, { readOnly: true });
    if (db) {
      // 1. Natural-language OR-scored FTS5 matches within the active window (up to 12).
      if (query && query.trim()) {
        const fts = searchDiscoveryRelaxed(db, yeaftDir, allowedList, query, now, {
          activeWindowDays,
          limit: Math.min(12, maxCandidates),
        });
        for (const hit of fts.results || []) {
          if (excludeSessionIds.has(hit.sessionId)) continue;
          if (isTaskSession(yeaftDir, hit.sessionId, metaCache)) continue;
          const meta = getCachedMeta(yeaftDir, hit.sessionId, metaCache);
          const sceneId = loadSessionConfig(yeaftDir, hit.sessionId)?.sceneId || '';
          const windowMessages = getSessionMessagesInWindowFromIndex(db, hit.sessionId, { sinceMs, limit: 32 });
          byId.set(hit.sessionId, {
            sessionId: hit.sessionId,
            title: hit.title,
            sceneId,
            workDir: meta?.workDir || hit.workDir || '',
            activeAt: hit.activeAt,
            preview: hit.snippet || '',
            matchedOlderSnippet: hit.matchedText || hit.snippet || '',
            windowMessages,
            recentMessages: windowMessages.slice(-4),
          });
        }
      }

      // 2. Most-recently-active cards within the active window (fill up to maxCandidates).
      const recent = listActiveSessionCards(db, yeaftDir, allowedList, now, {
        activeWindowDays,
        limit: Math.min(40, maxCandidates + 6),
      });
      for (const card of recent.cards || []) {
        if (byId.size >= maxCandidates) break;
        if (byId.has(card.sessionId) || excludeSessionIds.has(card.sessionId)) continue;
        if (isTaskSession(yeaftDir, card.sessionId, metaCache)) continue;
        const sceneId = loadSessionConfig(yeaftDir, card.sessionId)?.sceneId || '';
        const windowMessages = getSessionMessagesInWindowFromIndex(db, card.sessionId, { sinceMs, limit: 32 });
        byId.set(card.sessionId, {
          sessionId: card.sessionId,
          title: card.title,
          sceneId,
          workDir: card.workDir || '',
          activeAt: card.activeAt,
          preview: card.preview || '',
          windowMessages,
          recentMessages: windowMessages.slice(-4),
        });
      }
    }
  } catch {
    // Read-only store open/query is best-effort; fallback to manifest check below.
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }

  // 3. Fallback safety net: include manifest Sessions modified within 24h that
  // are in `allowedList` and have at least 1 message, in case `discovery.db` has
  // not indexed them yet (e.g. cold boot before first worker pass).
  if (byId.size < maxCandidates && typeof readRecentFallbackMessages === 'function') {
    const allowedSet = new Set(allowedList);
    const cutoff = now - Math.min(activeWindowDays, 1) * DAY_MS;
    try {
      const metas = snapshotSessions(yeaftDir)
        .filter(m => m?.id && allowedSet.has(m.id) && !byId.has(m.id) && !m.task);
      for (const meta of metas) {
        if (byId.size >= maxCandidates) break;
        const updatedMs = Date.parse(meta.metadataUpdatedAt || meta.createdAt || '') || 0;
        if (updatedMs < cutoff) continue;
        const recentMessages = readRecentFallbackMessages(meta.id, 6);
        if (!Array.isArray(recentMessages) || recentMessages.length === 0) continue;
        const sceneId = loadSessionConfig(yeaftDir, meta.id)?.sceneId || '';
        const lastMsg = recentMessages[recentMessages.length - 1];
        byId.set(meta.id, {
          sessionId: meta.id,
          title: meta.name || meta.id,
          sceneId,
          workDir: meta.workDir || '',
          activeAt: updatedMs,
          preview: String(lastMsg?.text || '').slice(0, 220),
          windowMessages: recentMessages,
          recentMessages: recentMessages.slice(-4),
        });
      }
    } catch { /* best-effort */ }
  }

  const candidates = [...byId.values()].sort((a, b) => (b.activeAt || 0) - (a.activeAt || 0));
  return { candidates: candidates.slice(0, maxCandidates), dbAvailable: Boolean(db) };
}

/**
 * Search older indexed Sessions (> `activeWindowDays` old) for lightweight
 * historical clues when creating a fresh Session.
 */
export function lookupOlderHistoricalHints(yeaftDir, {
  allowedSessionIds = [],
  query = '',
  searchKeywords = [],
  activeWindowDays = DEFAULT_AUTO_ROUTE_WINDOW_DAYS,
  now = Date.now(),
  maxHints = 2,
} = {}) {
  const allowedList = [...normalizeAllowedIdSet(allowedSessionIds)];
  if (allowedList.length === 0) return [];
  const searchTerms = searchKeywords.length > 0 ? searchKeywords.join(' ') : query;
  if (!searchTerms || !searchTerms.trim()) return [];

  let db = null;
  try {
    db = openDiscoveryStore(yeaftDir, { readOnly: true });
    if (!db) return [];
    let hits = searchDiscovery(db, yeaftDir, allowedList, searchTerms, now, { limit: 8 });
    if (!hits.results?.length) {
      hits = searchDiscoveryRelaxed(db, yeaftDir, allowedList, searchTerms, now, { limit: 8 });
    }
    const olderCutoff = now - activeWindowDays * DAY_MS;
    const out = [];
    for (const row of hits.results || []) {
      if (row.activeAt >= olderCutoff) continue;
      const meta = loadSessionMeta(join(sessionsRoot(yeaftDir), row.sessionId));
      if (meta?.task) continue;
      out.push({
        sessionId: row.sessionId,
        title: row.title,
        workDir: meta?.workDir || '',
        snippet: row.snippet || '',
        activeAt: row.activeAt,
      });
      if (out.length >= maxHints) break;
    }
    return out;
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

function enrichRunningCandidatesWithIndex(yeaftDir, runningSessions, { now, activeWindowDays }) {
  if (!runningSessions.length) return [];
  const sinceMs = now - Math.max(1, Number(activeWindowDays) || DEFAULT_AUTO_ROUTE_WINDOW_DAYS) * DAY_MS;
  let db = null;
  try {
    db = openDiscoveryStore(yeaftDir, { readOnly: true });
  } catch {
    db = null;
  }
  try {
    return runningSessions.map(s => {
      const liveRecent = Array.isArray(s.recentMessages) ? s.recentMessages : [];
      let indexedWindow = [];
      if (db) {
        try {
          indexedWindow = getSessionMessagesInWindowFromIndex(db, s.sessionId, { sinceMs, limit: 28 });
        } catch { /* best-effort */ }
      }
      // Combine older indexed window messages with the freshest live messages without duplicating tails.
      const seenTails = new Set(liveRecent.map(m => `${m.role}:${String(m.text || '').slice(0, 80)}`));
      const mergedWindow = [
        ...indexedWindow.filter(m => !seenTails.has(`${m.role}:${String(m.text || '').slice(0, 80)}`)),
        ...liveRecent.map(m => ({ ...m, createdAt: m.createdAt || now })),
      ];
      const latestTs = mergedWindow.reduce((acc, m) => Math.max(acc, Number(m?.createdAt) || 0), 0);
      return {
        ...s,
        isRunning: true,
        state: s.state || ((s.pendingQuestions?.length || s.pendingQuestion) ? 'waiting_input' : 'running'),
        activeAt: latestTs || now,
        windowMessages: mergedWindow,
        recentMessages: liveRecent.length > 0 ? liveRecent : mergedWindow.slice(-4),
      };
    });
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

function resolveAnsweredQuestion(target, answeredRequestId) {
  if (!answeredRequestId || !target) return null;
  const pendingQuestions = Array.isArray(target.pendingQuestions)
    ? target.pendingQuestions
    : (target.pendingQuestion ? [target.pendingQuestion] : []);
  return pendingQuestions.find(q => q?.requestId === answeredRequestId) || null;
}

/**
 * Decide whether an incoming Sessionless message routes to:
 *   - Stage 0 zero-LLM fast-path (`routeSource: 'fast_path'`, `tier: 'running' | 'recent'`)
 *   - Stage 1 single-shot LLM match (`routeSource: 'llm'`, `tier: 'running' | 'recent'`)
 *   - Stage 1 / Tier 3 brand-new Session (`action: 'create'`, `tier: 'create'`)
 */
export async function decideSessionAutoRoute({
  yeaftDir,
  agentWorkDir = '',
  text = '',
  allowedSessionIds = [],
  runningSessions = [],
  forceNew = false,
  fastPath = true,
  preferredSceneId = null,
  preferredWorkDir = null,
  allowedScenes = SESSION_SCENE_IDS,
  activeWindowDays = DEFAULT_AUTO_ROUTE_WINDOW_DAYS,
  adapter = null,
  config = null,
  traceId = null,
  signal,
  now = Date.now(),
  readRecentFallbackMessages = null,
} = {}) {
  const allowedSet = normalizeAllowedIdSet(allowedSessionIds);
  const cleanQuery = String(text || '').trim();

  const explicitWorkDir = typeof preferredWorkDir === 'string'
    ? (preferredWorkDir.trim() ? normalizeWorkspaceFolderPath(preferredWorkDir) : '')
    : null;
  const explicitSceneId = isSessionSceneId(preferredSceneId) && allowedScenes.includes(preferredSceneId)
    ? preferredSceneId
    : null;

  // Filter running Sessions strictly by Server-authorized `allowedSessionIds`.
  const eligibleRunningRaw = forceNew
    ? []
    : (runningSessions || []).filter(s => s?.sessionId && allowedSet.has(s.sessionId));

  const runningIds = new Set(eligibleRunningRaw.map(s => s.sessionId));
  const idleCandidates = (!forceNew && allowedSet.size > 0)
    ? collectRecentIdleCandidates(yeaftDir, {
      allowedSessionIds: [...allowedSet],
      excludeSessionIds: runningIds,
      query: cleanQuery,
      activeWindowDays,
      now,
      readRecentFallbackMessages,
    }).candidates
    : [];

  const enrichedRunning = enrichRunningCandidatesWithIndex(yeaftDir, eligibleRunningRaw, {
    now,
    activeWindowDays,
  });

  const allCandidates = [
    ...enrichedRunning,
    ...idleCandidates.map(c => ({ ...c, isRunning: false, state: 'idle' })),
  ];

  // ── Fast path when there are candidate Sessions (running or recent idle) ──
  if (!forceNew && allCandidates.length > 0) {
    const { scored, metaExcluded } = scoreRouteCandidates({
      query: cleanQuery,
      candidates: allCandidates,
      now,
      activeWindowDays,
    });

    // Stage 0: Zero-LLM local fast-path (<5 ms, $0)
    if (fastPath !== false) {
      const fastHit = tryFastPathRoute({
        query: cleanQuery,
        scoredCandidates: scored,
        metaExcluded,
      });
      if (fastHit && fastHit.sessionId && allowedSet.has(fastHit.sessionId)) {
        return fastHit;
      }
    }

    // Stage 1: Compact single-shot unified LLM arbiter (evaluates running + idle
    // together AND plans new-Session metadata in the same call when creating).
    const llmCandidates = selectCandidatesForLlm({
      scoredCandidates: scored,
      maxTotal: 7,
    });

    const candidateFolders = selectCandidateWorkspaceFolders(yeaftDir, {
      query: cleanQuery,
      agentWorkDir,
      preferredWorkDir: explicitWorkDir || '',
      allowedSessionIds: [...allowedSet],
      limit: 10,
    });

    const { result: routed, meta: routeMeta } = await runDecision({
      scenario: AUTO_ROUTE_SESSION_SCENARIO_ID,
      input: {
        candidates: llmCandidates,
        allowedScenes,
        candidateFolders,
        newQuery: cleanQuery,
        preferredSceneId: explicitSceneId,
        preferredWorkDir: explicitWorkDir || '',
      },
      adapter,
      config,
      traceId,
      signal,
    });

    if (routed.decision === 'match' && routed.sessionId && allowedSet.has(routed.sessionId)) {
      const target = llmCandidates.find(c => c.sessionId === routed.sessionId);
      const answeredQuestion = target?.isRunning
        ? resolveAnsweredQuestion(target, routed.answeredRequestId)
        : null;
      return {
        action: 'continue',
        tier: target?.isRunning ? 'running' : 'recent',
        sessionId: routed.sessionId,
        title: target?.title || routed.sessionId,
        sceneId: target?.sceneId || null,
        workDir: target?.workDir || '',
        answeredQuestion,
        confidence: routed.confidence,
        reason: routed.reason || (target?.isRunning ? 'matched_running_session' : 'matched_recent_session'),
        decisionModel: routeMeta.model,
        routeSource: 'llm',
      };
    }

    const finalSceneId = explicitSceneId || routed.sceneId || 'general';
    const allowedFolderPaths = new Set(candidateFolders.map(f => f.path));
    const finalWorkDir = explicitWorkDir !== null
      ? (explicitWorkDir && allowedFolderPaths.has(explicitWorkDir) ? explicitWorkDir : '')
      : (routed.workDir && allowedFolderPaths.has(routed.workDir) ? routed.workDir : '');
    const finalTitle = routed.title || fallbackShortTitle(cleanQuery, '新对话');

    return {
      action: 'create',
      tier: 'create',
      sessionId: null,
      title: finalTitle,
      sceneId: finalSceneId,
      workDir: finalWorkDir,
      historicalHints: [],
      reason: routed.reason || 'planned_new_session',
      decisionModel: routeMeta.model,
      routeSource: routeMeta.usedFallback ? 'fallback' : 'llm',
    };
  }

  // ── Direct create path (`forceNew` or zero eligible candidates in 5d window) ──
  const historicalHints = lookupOlderHistoricalHints(yeaftDir, {
    allowedSessionIds: [...allowedSet],
    query: cleanQuery,
    activeWindowDays,
    now,
  });

  const candidateFolders = selectCandidateWorkspaceFolders(yeaftDir, {
    query: cleanQuery,
    agentWorkDir,
    preferredWorkDir: explicitWorkDir || '',
    allowedSessionIds: [...allowedSet],
    limit: 25,
  });

  const { result: planned, meta: planMeta } = await runDecision({
    scenario: PLAN_NEW_SESSION_SCENARIO_ID,
    input: {
      newQuery: cleanQuery,
      allowedScenes,
      candidateFolders,
      historicalHints,
      preferredSceneId: explicitSceneId,
      preferredWorkDir: explicitWorkDir || '',
    },
    adapter,
    config,
    traceId,
    signal,
  });

  const finalSceneId = explicitSceneId || planned.sceneId || 'general';
  const allowedFolderPaths = new Set(candidateFolders.map(f => f.path));
  const finalWorkDir = explicitWorkDir !== null
    ? (explicitWorkDir && allowedFolderPaths.has(explicitWorkDir) ? explicitWorkDir : '')
    : (planned.workDir && allowedFolderPaths.has(planned.workDir) ? planned.workDir : '');
  const finalTitle = planned.title || fallbackShortTitle(cleanQuery, '新对话');

  return {
    action: 'create',
    tier: 'create',
    sessionId: null,
    title: finalTitle,
    sceneId: finalSceneId,
    workDir: finalWorkDir,
    historicalHints,
    reason: planned.reason || 'planned_new_session',
    decisionModel: planMeta.model,
    routeSource: planMeta.usedFallback ? 'fallback' : 'llm',
  };
}
