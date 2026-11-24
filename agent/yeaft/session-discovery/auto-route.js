/**
 * auto-route.js — Three-tier Session auto-routing engine for Sessionless entry.
 *
 * Tier 1 (Highest priority): Running Sessions (active execution or waiting on AskUser)
 *   - Uses `route-running-session` Decision scenario with the last 4–6 live messages
 *     and any pending AskUser question/options.
 * Tier 2 (Secondary priority): Recent idle Sessions active within `activeWindowDays` (default 5)
 *   - Combines FTS5 hits + most-recently-active cards from `discovery.db`, plus any
 *     live manifest Sessions updated within 24h not yet indexed, strictly filtered
 *     by Server-supplied `allowedSessionIds`.
 * Tier 3 (Create new Session):
 *   - Optionally gathers up to 2 older (> 5 days) FTS5 historical hints from `discovery.db`,
 *     then runs `plan-new-session` Decision scenario against the `<= 3` level
 *     workspace folder allowlist + Agent-supported scenes to pick `{ sceneId, workDir, title }`.
 *
 * Serializes routing decisions per `(ownerKey)` so two back-to-back auto-route
 * messages from the same user never split into duplicate newly-created Sessions.
 */

import { join } from 'node:path';
import {
  PLAN_NEW_SESSION_SCENARIO_ID,
  ROUTE_RECENT_SESSION_SCENARIO_ID,
  ROUTE_RUNNING_SESSION_SCENARIO_ID,
  fallbackShortTitle,
  runDecision,
} from '../decision/index.js';
import { SESSION_SCENE_IDS, isSessionSceneId } from '../sessions/scene-ids.js';
import { loadSessionConfig } from '../sessions/session-config.js';
import { loadSessionMeta } from '../sessions/session-store.js';
import { sessionsRoot, snapshotSessions } from '../sessions/session-crud.js';
import { normalizeWorkspaceFolderPath, selectCandidateWorkspaceFolders } from '../workspace-folders.js';
import {
  DAY_MS,
  getRecentSessionMessagesFromIndex,
  listActiveSessionCards,
  openDiscoveryStore,
  searchDiscovery,
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

/**
 * Collect recent idle candidate cards within the 5-day window (excluding any
 * already evaluated in Tier 1 `runningSessionIds`), merging FTS5 lexical hits,
 * recency hits from `discovery.db`, and freshly-active manifest Sessions.
 */
export function collectRecentIdleCandidates(yeaftDir, {
  allowedSessionIds = [],
  excludeSessionIds = new Set(),
  query = '',
  activeWindowDays = DEFAULT_AUTO_ROUTE_WINDOW_DAYS,
  now = Date.now(),
  maxCandidates = 10,
  readRecentFallbackMessages = null,
} = {}) {
  const allowedList = [...normalizeAllowedIdSet(allowedSessionIds)]
    .filter(id => !excludeSessionIds.has(id));
  if (allowedList.length === 0) return { candidates: [], dbAvailable: false };

  const byId = new Map();
  let db = null;
  try {
    db = openDiscoveryStore(yeaftDir, { readOnly: true });
    if (db) {
      // 1. Lexical FTS5 matches within the 5-day window (up to 6).
      if (query && query.trim()) {
        const fts = searchDiscovery(db, yeaftDir, allowedList, query, now, {
          activeWindowDays,
          limit: 6,
        });
        for (const hit of fts.results || []) {
          if (excludeSessionIds.has(hit.sessionId)) continue;
          const sceneId = loadSessionConfig(yeaftDir, hit.sessionId)?.sceneId || '';
          const meta = loadSessionMeta(join(sessionsRoot(yeaftDir), hit.sessionId));
          byId.set(hit.sessionId, {
            sessionId: hit.sessionId,
            title: hit.title,
            sceneId,
            workDir: meta?.workDir || '',
            activeAt: hit.activeAt,
            preview: hit.snippet || '',
            recentMessages: getRecentSessionMessagesFromIndex(db, hit.sessionId, 4),
          });
        }
      }

      // 2. Most-recently-active cards within the 5-day window (fill up to maxCandidates).
      const recent = listActiveSessionCards(db, yeaftDir, allowedList, now, {
        activeWindowDays,
        limit: maxCandidates,
      });
      for (const card of recent.cards || []) {
        if (byId.size >= maxCandidates) break;
        if (byId.has(card.sessionId) || excludeSessionIds.has(card.sessionId)) continue;
        const sceneId = loadSessionConfig(yeaftDir, card.sessionId)?.sceneId || '';
        byId.set(card.sessionId, {
          sessionId: card.sessionId,
          title: card.title,
          sceneId,
          workDir: card.workDir || '',
          activeAt: card.activeAt,
          preview: card.preview || '',
          recentMessages: getRecentSessionMessagesFromIndex(db, card.sessionId, 4),
        });
      }
    }
  } catch {
    //Read-only store open/query is best-effort; fallback to manifest check below.
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
        const recentMessages = readRecentFallbackMessages(meta.id, 4);
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
          recentMessages,
        });
      }
    } catch { /* best-effort */ }
  }

  const candidates = [...byId.values()].sort((a, b) => (b.activeAt || 0) - (a.activeAt || 0));
  return { candidates: candidates.slice(0, maxCandidates), dbAvailable: Boolean(db) };
}

/**
 * Search older indexed Sessions (> `activeWindowDays` old) for lightweight
 * historical clues when Tier 2 decides to create a fresh Session.
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
    const hits = searchDiscovery(db, yeaftDir, allowedList, searchTerms, now, { limit: 8 });
    const olderCutoff = now - activeWindowDays * DAY_MS;
    const out = [];
    for (const row of hits.results || []) {
      if (row.activeAt >= olderCutoff) continue;
      const meta = loadSessionMeta(join(sessionsRoot(yeaftDir), row.sessionId));
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

/**
 * Decide whether an incoming Sessionless message routes to:
 *   - Tier 1: a currently running / AskUser-waiting Session (`tier: 'running'`)
 *   - Tier 2: a recent idle Session within 5 days (`tier: 'recent'`)
 *   - Tier 3: a newly planned Session with LLM-chosen `{ sceneId, workDir, title }` (`tier: 'create'`)
 */
export async function decideSessionAutoRoute({
  yeaftDir,
  agentWorkDir = '',
  text = '',
  allowedSessionIds = [],
  runningSessions = [],
  forceNew = false,
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

  // Filter running sessions strictly by Server-authorized `allowedSessionIds`.
  const eligibleRunning = forceNew
    ? []
    : (runningSessions || []).filter(s => s?.sessionId && allowedSet.has(s.sessionId));

  // ── Tier 1: Running Sessions (including pending AskUser) ──
  if (eligibleRunning.length > 0) {
    const { result: tier1, meta: tier1Meta } = await runDecision({
      scenario: ROUTE_RUNNING_SESSION_SCENARIO_ID,
      input: {
        runningSessions: eligibleRunning,
        newQuery: cleanQuery,
      },
      adapter,
      config,
      traceId,
      signal,
    });
    if (tier1.decision === 'match' && tier1.sessionId && allowedSet.has(tier1.sessionId)) {
      const target = eligibleRunning.find(s => s.sessionId === tier1.sessionId);
      const pendingQuestions = Array.isArray(target?.pendingQuestions)
        ? target.pendingQuestions
        : (target?.pendingQuestion ? [target.pendingQuestion] : []);
      const answeredQuestion = tier1.answeredRequestId
        ? pendingQuestions.find(q => q?.requestId === tier1.answeredRequestId) || null
        : null;
      return {
        action: 'continue',
        tier: 'running',
        sessionId: tier1.sessionId,
        title: target?.title || tier1.sessionId,
        sceneId: target?.sceneId || null,
        workDir: target?.workDir || '',
        answeredQuestion,
        confidence: tier1.confidence,
        reason: tier1.reason || 'matched_running_session',
        decisionModel: tier1Meta.model,
      };
    }
  }

  // ── Tier 2: Recent 5-day idle Sessions ──
  const runningIds = new Set(eligibleRunning.map(s => s.sessionId));
  let searchKeywords = [];
  if (!forceNew && allowedSet.size > 0) {
    const { candidates } = collectRecentIdleCandidates(yeaftDir, {
      allowedSessionIds: [...allowedSet],
      excludeSessionIds: runningIds,
      query: cleanQuery,
      activeWindowDays,
      now,
      readRecentFallbackMessages,
    });

    if (candidates.length > 0) {
      const { result: tier2, meta: tier2Meta } = await runDecision({
        scenario: ROUTE_RECENT_SESSION_SCENARIO_ID,
        input: {
          candidateSessions: candidates,
          newQuery: cleanQuery,
        },
        adapter,
        config,
        traceId,
        signal,
      });
      if (tier2.decision === 'match' && tier2.sessionId && allowedSet.has(tier2.sessionId)) {
        const matchedCard = candidates.find(c => c.sessionId === tier2.sessionId);
        return {
          action: 'continue',
          tier: 'recent',
          sessionId: tier2.sessionId,
          title: matchedCard?.title || tier2.sessionId,
          sceneId: matchedCard?.sceneId || null,
          workDir: matchedCard?.workDir || '',
          confidence: tier2.confidence,
          reason: tier2.reason || 'matched_recent_session',
          decisionModel: tier2Meta.model,
        };
      }
      if (Array.isArray(tier2.searchKeywords)) {
        searchKeywords = tier2.searchKeywords;
      }
    }
  }

  // ── Tier 3: Plan a brand-new Session (LLM chooses folder, scene, title) ──
  const historicalHints = lookupOlderHistoricalHints(yeaftDir, {
    allowedSessionIds: [...allowedSet],
    query: cleanQuery,
    searchKeywords,
    activeWindowDays,
    now,
  });

  const explicitWorkDir = typeof preferredWorkDir === 'string'
    ? (preferredWorkDir.trim() ? normalizeWorkspaceFolderPath(preferredWorkDir) : '')
    : null;
  const explicitSceneId = isSessionSceneId(preferredSceneId) && allowedScenes.includes(preferredSceneId)
    ? preferredSceneId
    : null;

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
  };
}
