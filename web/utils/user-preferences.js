const instances = new WeakMap();
// The Server still stores the retired Projects/Recents split (ratio and
// section collapse) for older pages; this client no longer reads or writes it.
const defaultPreferences = () => ({
  sidebarActionsCompact: false,
  sidebarCollapsedProjects: {},
});
const collapseFields = ['sidebarCollapsedProjects'];
const patchFieldKeys = patch => Object.entries(patch).flatMap(([field, value]) =>
  collapseFields.includes(field) ? Object.keys(value).map(key => `${field}:${key}`) : [field]);
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

function normalizePreferences(value) {
  return {
    sidebarActionsCompact: value.sidebarActionsCompact === true,
    sidebarCollapsedProjects: normalizeCollapseMap(value.sidebarCollapsedProjects),
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
  const failedFields = new Set();
  const showConfirmed = () => {
    const visible = { ...confirmed };
    for (const patch of pendingPatches.values()) {
      const preferencesBeforePatch = { ...visible };
      Object.assign(visible, patch);
      // Each click owns only one folder/section, not the snapshot of its map.
      for (const field of collapseFields) {
        visible[field] = { ...preferencesBeforePatch[field], ...patch[field] };
      }
    }
    preferences.value = visible;
  };
  let controller = null;
  let loading = null;
  let queue = Promise.resolve();
  let pendingWrites = 0;

  const options = signal => ({
    signal,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(auth?.token ? { Authorization: `Bearer ${auth.token}` } : {}),
    },
  });
  const authenticated = () => !!(auth?.isAuthenticated && auth?.userId);
  // Signed in, but the saved state has neither arrived nor failed yet: the
  // sidebar shows its loading row rather than folders in the default state.
  const pending = scope.run(() => Vue.computed(() => authenticated() && !ready.value && !error.value));
  async function refresh() {
    if (!authenticated() || pendingWrites) return;
    if (loading) return loading;
    const expectedGeneration = generation;
    const expectedRevision = revision;
    const work = (async () => {
      const { signal, done } = timedSignal(controller?.signal, LOAD_TIMEOUT_MS);
      try {
        const response = await request('/api/user/preferences', { ...options(signal), cache: 'no-store' });
        if (!response.ok) throw new Error('load');
        const value = await response.json();
        if (generation !== expectedGeneration || revision !== expectedRevision) return;
        confirmed = normalizePreferences(value);
        failedFields.clear();
        showConfirmed();
        ready.value = true;
        error.value = null;
      } catch {
        if (generation === expectedGeneration && revision === expectedRevision) error.value = 'load';
      } finally {
        done();
      }
    })();
    loading = work;
    try { await work; } finally { if (loading === work) loading = null; }
  }

  function savePatch(patch) {
    if (!authenticated() || !ready.value) return Promise.resolve(false);
    const expectedGeneration = generation;
    const expectedRevision = ++revision;
    pendingPatches.set(expectedRevision, patch);
    showConfirmed();
    error.value = null;
    pendingWrites++;
    const work = queue.then(async () => {
      if (generation !== expectedGeneration) return false;
      const { signal, done } = timedSignal(controller?.signal, SAVE_TIMEOUT_MS);
      try {
        const response = await request('/api/user/preferences', {
          ...options(signal), method: 'PATCH', body: JSON.stringify(patch),
        });
        if (!response.ok) throw new Error('save');
        const result = await response.json();
        if (generation !== expectedGeneration) return false;
        confirmed = normalizePreferences(result);
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
        }
      }
    });
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

  scope.run(() => Vue.watch(
    () => [auth?.isAuthenticated, auth?.userId, auth?.authGeneration],
    () => {
      generation++;
      revision++;
      controller?.abort();
      controller = new AbortController();
      loading = null;
      queue = Promise.resolve();
      pendingWrites = 0;
      pendingPatches.clear();
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
    refresh, saveSidebarActionsCompact, saveSidebarProjectCollapsed,
    dispose() { generation++; controller?.abort(); scope.stop(); },
  };
}

export function useUserPreferences() {
  let auth;
  try { auth = globalThis.Pinia?.useAuthStore?.(); } catch { /* isolated/read-only host */ }
  if (!auth) return createUserPreferencesState(null);
  if (!instances.has(auth)) instances.set(auth, createUserPreferencesState(auth));
  return instances.get(auth);
}
