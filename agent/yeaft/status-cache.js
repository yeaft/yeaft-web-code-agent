/**
 * status-cache.js — agent-lifecycle Yeaft capability snapshot.
 *
 * Model candidates are an agent capability, not a page lifecycle side-effect.
 * Keep the last good snapshot in memory, refresh it in the background, and
 * never clear the model list just because a refresh failed.
 */

import ctx from '../context.js';
import { sendToServer } from '../connection/buffer.js';
import { loadConfig } from './config.js';

const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

function normalizeAvailableModels(models) {
  if (!Array.isArray(models)) return [];
  return models
    .map((m) => {
      if (typeof m === 'string') return { id: m, label: m };
      if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !m.id) return null;
      return { ...m, label: m.label || m.id };
    })
    .filter(Boolean);
}

function buildEvent(snapshot) {
  return {
    type: 'yeaft_status',
    model: snapshot.model || null,
    availableModels: normalizeAvailableModels(snapshot.availableModels),
    skills: snapshot.skills,
    mcpServers: snapshot.mcpServers,
    tools: snapshot.tools,
    yeaftDir: snapshot.yeaftDir || null,
    refreshedAt: snapshot.refreshedAt || null,
    refreshStartedAt: snapshot.refreshStartedAt || null,
    refreshError: snapshot.refreshError || null,
    refreshing: !!snapshot.refreshing,
  };
}

/**
 * Create a status cache. Tests inject clock/timer/config loading; production
 * uses the exported singleton wrappers below.
 */
export function createYeaftStatusCache(options = {}) {
  const load = options.loadConfig || loadConfig;
  const emit = options.emit || ((event) => sendToServer({ type: 'yeaft_output', event }));
  const now = options.now || (() => Date.now());
  const setTimer = options.setInterval || globalThis.setInterval.bind(globalThis);
  const clearTimer = options.clearInterval || globalThis.clearInterval.bind(globalThis);
  const intervalMs = options.intervalMs || DEFAULT_REFRESH_INTERVAL_MS;
  let snapshot = null;
  let timer = null;
  let inFlight = null;

  function current() {
    return snapshot ? { ...snapshot, availableModels: normalizeAvailableModels(snapshot.availableModels) } : null;
  }

  function emitSnapshot(extra = {}) {
    if (!snapshot) return null;
    const event = buildEvent({ ...snapshot, ...extra });
    emit(event);
    return event;
  }

  async function refresh({ reason = 'manual', emitRefreshing = true, sessionStatus = null } = {}) {
    if (inFlight) return inFlight;
    const startedAt = now();
    if (emitRefreshing && snapshot) {
      snapshot = { ...snapshot, refreshing: true, refreshStartedAt: startedAt, refreshReason: reason };
      emitSnapshot();
    }
    inFlight = Promise.resolve()
      .then(async () => {
        const yeaftDir = options.getYeaftDir ? options.getYeaftDir() : ctx.CONFIG?.yeaftDir;
        const config = await load({ ...(yeaftDir && { dir: yeaftDir }) });
        const previous = snapshot || {};
        snapshot = {
          ...previous,
          model: config.primaryModel || config.model || previous.model || null,
          availableModels: normalizeAvailableModels(config.availableModels),
          yeaftDir: config.dir || yeaftDir || previous.yeaftDir || null,
          skills: sessionStatus?.skills ?? previous.skills,
          mcpServers: sessionStatus?.mcpServers ?? previous.mcpServers,
          tools: sessionStatus?.tools ?? previous.tools,
          refreshedAt: now(),
          refreshStartedAt: startedAt,
          refreshReason: reason,
          refreshError: null,
          refreshing: false,
        };
        return emitSnapshot();
      })
      .catch((err) => {
        const message = err?.message || String(err);
        const previous = snapshot || {};
        snapshot = {
          ...previous,
          availableModels: normalizeAvailableModels(previous.availableModels),
          refreshedAt: previous.refreshedAt || null,
          refreshStartedAt: startedAt,
          refreshReason: reason,
          refreshError: message,
          refreshing: false,
        };
        return emitSnapshot();
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  }

  function hydrateFromSession(sessionLike, { reason = 'session_ready', emitEvent = true } = {}) {
    if (!sessionLike) return null;
    const previous = snapshot || {};
    snapshot = {
      ...previous,
      model: sessionLike.config?.model || previous.model || null,
      availableModels: normalizeAvailableModels(sessionLike.config?.availableModels || previous.availableModels),
      yeaftDir: sessionLike.yeaftDir || sessionLike.config?.dir || previous.yeaftDir || null,
      skills: sessionLike.status?.skills ?? previous.skills,
      mcpServers: sessionLike.status?.mcpServers ?? previous.mcpServers,
      tools: sessionLike.status?.tools ?? previous.tools,
      refreshedAt: now(),
      refreshStartedAt: previous.refreshStartedAt || null,
      refreshReason: reason,
      refreshError: null,
      refreshing: false,
    };
    return emitEvent ? emitSnapshot() : buildEvent(snapshot);
  }

  function start() {
    if (timer) return timer;
    refresh({ reason: 'startup', emitRefreshing: false }).catch(() => {});
    timer = setTimer(() => { refresh({ reason: 'interval' }).catch(() => {}); }, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
  }

  function stop() {
    if (timer) clearTimer(timer);
    timer = null;
  }

  return { current, refresh, hydrateFromSession, start, stop, emitSnapshot };
}

export const yeaftStatusCache = createYeaftStatusCache();

export function startYeaftStatusRefresh() {
  return yeaftStatusCache.start();
}

export function stopYeaftStatusRefresh() {
  return yeaftStatusCache.stop();
}

export function refreshYeaftStatus(options) {
  return yeaftStatusCache.refresh(options);
}

export function hydrateYeaftStatusFromSession(sessionLike, options) {
  return yeaftStatusCache.hydrateFromSession(sessionLike, options);
}

export function getCachedYeaftStatus() {
  return yeaftStatusCache.current();
}
