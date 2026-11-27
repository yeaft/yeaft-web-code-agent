import { normalizeCosmosConfigPatch } from '../cosmos/constants.js';

const instances = new WeakMap();
// The Server still stores the retired Projects/Recents split (ratio and
// section collapse) for older pages; this client no longer reads or writes it.
const defaultPreferences = () => ({
  sidebarActionsCompact: false,
  sidebarCollapsedProjects: {},
  cosmosConfig: {},
});
const collapseFields = ['sidebarCollapsedProjects'];
const patchFieldKeys = patch => Object.entries(patch).flatMap(([field, value]) => {
  if (collapseFields.includes(field)) return Object.keys(value).map(key => `${field}:${key}`);
  if (field === 'cosmosConfig' && value && typeof value === 'object') {
    return Object.keys(value).map(key => `cosmosConfig:${key}`);
  }
  return [field];
});
const validProjectKey = key => typeof key === 'string' && key.length > 0 && key.length <= 200
  && !['__proto__', 'constructor', 'prototype'].includes(key);
// The sidebar waits for the first load, so a stalled request falls back to the
// defaults (with a retry) instead of holding the list; a stalled save must not
// block the saves queued behind it.
const LOAD_TIMEOUT_MS = 5000;
const SAVE_TIMEOUT_MS = 10000;

/** Aborts after `ms`, or with the auth generation's `parent` signal. */
function timedSignal(parent, ms) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, ms);
  if (parent?.aborted) abort();
  else parent?.addEventListener?.('abort', abort, { once: true });
  return {
    signal: controller.signal,
    done() { clearTimeout(timer); parent?.removeEventListener?.('abort', abort); },
  };
}

function normalizeCollapseMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, collapsed]) =>
    typeof collapsed === 'boolean' && validProjectKey(key)));
}

function mergeCosmosConfig(base, patch) {
  const prev = base && typeof base === 'object' ? base : {};
  const next = { ...prev };
  if (!patch || typeof patch !== 'object') return next;
  if (Object.hasOwn(patch, 'constants')) {
    next.constants = { ...(prev.constants || {}), ...patch.constants };
  }
  if (Object.hasOwn(patch, 'planetBindings')) {
    next.planetBindings = { ...patch.planetBindings };
  }
  if (Object.hasOwn(patch, 'drawerWidth')) {
    next.drawerWidth = patch.drawerWidth;
  }
  if (Object.hasOwn(patch, 'uiMode')) {
    next.uiMode = patch.uiMode;
  }
  return next;
}

function normalizePreferences(value) {
  return {
    sidebarActionsCompact: value?.sidebarActionsCompact === true,
    sidebarCollapsedProjects: normalizeCollapseMap(value?.sidebarCollapsedProjects),
    cosmosConfig: normalizeCosmosConfigPatch(value?.cosmosConfig),
  };
}

/** Server-owned, authenticated user preferences. No device-local or Agent fallback.
 * Auth generations fence reads and queued writes, including same-user re-login.
 * Writes are serialized so a slow earlier drag cannot overwrite a later choice.
 */
export function createUserPreferencesState(auth, { request = (...args) => fetch(...args) } = {}) {
  const preferences = Vue.ref(defaultPreferences());
  const ready = Vue.ref(false);
  const error = Vue.ref(null);
  const scope = Vue.effectScope(true);
  let generation = 0;
  let revision = 0;
  let confirmed = defaultPreferences();
  // Reapply later local choices over each server response while writes drain.
  const pendingPatches = new Map();
  let queuedCosmosPatch = null;
  let queuedCosmosWaiters = [];
  const failedFields = new Set();
  const showConfirmed = () => {
    const visible = { ...confirmed };
    for (const patch of pendingPatches.values()) {
      const preferencesBeforePatch = { ...visible };
      Object.assign(visible, patch);
      // Each click owns only one folder/section, not the snapshot of its map.
      for (const field of collapseFields) {
        if (patch[field]) {
          visible[field] = { ...preferencesBeforePatch[field], ...patch[field] };
        }
      }
      if (patch.cosmosConfig) {
        visible.cosmosConfig = mergeCosmosConfig(preferencesBeforePatch.cosmosConfig, patch.cosmosConfig);
      }
    }
    if (queuedCosmosPatch) {
      visible.cosmosConfig = mergeCosmosConfig(visible.cosmosConfig, queuedCosmosPatch);
    }
    preferences.value = visible;
  };
  let controller = null;
  let loading = null;
  let initialLoadInFlight = false;
  let queue = Promise.resolve();
  let pendingWrites = 0;

  const options = (signal, { keepalive = false } = {}) => ({
    signal,
    credentials: 'same-origin',
    ...(keepalive ? { keepalive: true } : {}),
    headers: {
      'Content-Type': 'application/json',
      ...(auth?.token ? { Authorization: `Bearer ${auth.token}` } : {}),
    },
  });
  const authenticated = () => !!(auth?.isAuthenticated && auth?.userId);
  // Signed in, but the saved state has neither arrived nor failed yet: the
  // sidebar shows its loading row rather than folders in the default state.
  const pending = scope.run(() => Vue.computed(() => authenticated() && !ready.value && !error.value));
  function drainQueuedCosmos(allowBeforeReady = false) {
    if (!queuedCosmosPatch) return null;
    const flushPatch = queuedCosmosPatch;
    const waiters = queuedCosmosWaiters;
    queuedCosmosPatch = null;
    queuedCosmosWaiters = [];
    const writePromise = savePatch({ cosmosConfig: flushPatch }, { allowBeforeReady });
    writePromise.then((ok) => {
      for (const resolve of waiters) resolve(ok);
    });
    return writePromise;
  }

  async function refresh() {
    if (!authenticated() || pendingWrites) return;
    if (loading) return loading;
    const expectedGeneration = generation;
    const expectedRevision = revision;
    if (!ready.value) initialLoadInFlight = true;
    const work = (async () => {
      const { signal, done } = timedSignal(controller?.signal, LOAD_TIMEOUT_MS);
      let flushPromise = null;
      try {
        const response = await request('/api/user/preferences', { ...options(signal), cache: 'no-store' });
        if (!response.ok) throw new Error('load');
        const value = await response.json();
        if (generation !== expectedGeneration || revision !== expectedRevision) return;
        confirmed = normalizePreferences(value);
        failedFields.clear();
        ready.value = true;
        error.value = null;
        initialLoadInFlight = false;
        if (queuedCosmosPatch) {
          flushPromise = drainQueuedCosmos(false);
        } else {
          showConfirmed();
        }
      } catch {
        if (generation === expectedGeneration) initialLoadInFlight = false;
        if (generation === expectedGeneration && revision === expectedRevision) {
          error.value = 'load';
          if (queuedCosmosPatch) {
            flushPromise = drainQueuedCosmos(true);
          }
        }
      } finally {
        done();
        if (generation === expectedGeneration) initialLoadInFlight = false;
      }
      if (flushPromise) await flushPromise;
    })();
    loading = work;
    try { await work; } finally { if (loading === work) loading = null; }
  }

  function savePatch(patch, { allowBeforeReady = false, keepalive = false } = {}) {
    if (!authenticated() || (!ready.value && !allowBeforeReady)) return Promise.resolve(false);
    const expectedGeneration = generation;
    const expectedRevision = ++revision;
    const wasIdle = pendingWrites === 0;
    pendingPatches.set(expectedRevision, patch);
    showConfirmed();
    error.value = null;
    pendingWrites++;

    const executeRequest = async () => {
      if (generation !== expectedGeneration) return false;
      const { signal, done } = timedSignal(keepalive ? null : controller?.signal, SAVE_TIMEOUT_MS);
      try {
        const response = await request('/api/user/preferences', {
          ...options(signal, { keepalive }), method: 'PATCH', body: JSON.stringify(patch),
        });
        if (!response.ok) throw new Error('save');
        const result = await response.json();
        if (generation !== expectedGeneration) return false;
        confirmed = normalizePreferences(result);
        if (!ready.value) ready.value = true;
        for (const field of patchFieldKeys(patch)) failedFields.delete(field);
        error.value = failedFields.size ? 'save' : null;
        return true;
      } catch {
        if (generation === expectedGeneration) {
          for (const field of patchFieldKeys(patch)) failedFields.add(field);
          error.value = 'save';
        }
        return false;
      } finally {
        done();
        if (generation === expectedGeneration) {
          pendingWrites--;
          pendingPatches.delete(expectedRevision);
          showConfirmed();
          if (ready.value && queuedCosmosPatch) drainQueuedCosmos(false);
        }
      }
    };

    // During pagehide with an idle queue, kick off the keepalive fetch synchronously
    // before the event loop unwinds so the browser does not abort a microtask-deferred write.
    const work = keepalive && wasIdle
      ? executeRequest()
      : queue.then(executeRequest);
    queue = work;
    return work;
  }

  function saveSidebarActionsCompact(value) {
    if (typeof value !== 'boolean') return Promise.resolve(false);
    return savePatch({ sidebarActionsCompact: value });
  }

  function saveSidebarProjectCollapsed(projectId, collapsed) {
    if (!validProjectKey(projectId) || typeof collapsed !== 'boolean') return Promise.resolve(false);
    return savePatch({ sidebarCollapsedProjects: { [projectId]: collapsed } });
  }

  function saveCosmosConfig(cosmosPatch, { keepalive = false } = {}) {
    const clean = normalizeCosmosConfigPatch(cosmosPatch);
    if (Object.keys(clean).length === 0 || !authenticated()) return Promise.resolve(false);
    // Only queue while the initial GET is actively in flight with no writes started yet.
    // Once initial GET has settled (succeeded or failed), or a write is already serialized
    // on `queue`, or this is a pagehide keepalive flush, dispatch directly onto savePatch.
    if (ready.value || !initialLoadInFlight || pendingWrites > 0 || keepalive) {
      return savePatch({ cosmosConfig: clean }, { allowBeforeReady: true, keepalive });
    }
    queuedCosmosPatch = mergeCosmosConfig(queuedCosmosPatch, clean);
    showConfirmed();
    return new Promise((resolve) => {
      queuedCosmosWaiters.push(resolve);
    });
  }

  scope.run(() => Vue.watch(
    () => [auth?.isAuthenticated, auth?.userId, auth?.authGeneration],
    () => {
      generation++;
      revision++;
      controller?.abort();
      controller = new AbortController();
      loading = null;
      initialLoadInFlight = false;
      queue = Promise.resolve();
      pendingWrites = 0;
      pendingPatches.clear();
      const staleWaiters = queuedCosmosWaiters;
      queuedCosmosPatch = null;
      queuedCosmosWaiters = [];
      for (const resolve of staleWaiters) resolve(false);
      failedFields.clear();
      confirmed = defaultPreferences();
      showConfirmed();
      ready.value = false;
      error.value = null;
      void refresh();
    },
    { immediate: true, flush: 'sync' },
  ));
  return {
    preferences: Vue.readonly(preferences), ready: Vue.readonly(ready), error: Vue.readonly(error), pending,
    refresh, saveSidebarActionsCompact, saveSidebarProjectCollapsed, saveCosmosConfig,
    dispose() {
      generation++;
      controller?.abort();
      const staleWaiters = queuedCosmosWaiters;
      queuedCosmosPatch = null;
      queuedCosmosWaiters = [];
      for (const resolve of staleWaiters) resolve(false);
      scope.stop();
    },
  };
}

export function useUserPreferences() {
  let auth;
  try { auth = globalThis.Pinia?.useAuthStore?.(); } catch { /* isolated/read-only host */ }
  if (!auth) return createUserPreferencesState(null);
  if (!instances.has(auth)) instances.set(auth, createUserPreferencesState(auth));
  return instances.get(auth);
}
