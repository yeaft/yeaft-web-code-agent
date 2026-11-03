const instances = new WeakMap();
export const DEFAULT_SIDEBAR_PROJECTS_RATIO = 0.5;
export const MIN_SIDEBAR_PROJECTS_RATIO = 0.15;
export const MAX_SIDEBAR_PROJECTS_RATIO = 0.85;

export function clampSidebarProjectsRatio(value) {
  return Number.isFinite(value)
    ? Math.round(Math.max(MIN_SIDEBAR_PROJECTS_RATIO, Math.min(MAX_SIDEBAR_PROJECTS_RATIO, value)) * 1000) / 1000
    : DEFAULT_SIDEBAR_PROJECTS_RATIO;
}

/** Server-owned, authenticated user preferences. No device-local or Agent fallback.
 * Auth generations fence reads and queued writes, including same-user re-login.
 * Writes are serialized so a slow earlier drag cannot overwrite a later choice.
 */
export function createUserPreferencesState(auth, { request = (...args) => fetch(...args) } = {}) {
  const preferences = Vue.ref({ sidebarProjectsRatio: DEFAULT_SIDEBAR_PROJECTS_RATIO });
  const ready = Vue.ref(false);
  const error = Vue.ref(null);
  const scope = Vue.effectScope(true);
  let generation = 0;
  let revision = 0;
  let confirmed = DEFAULT_SIDEBAR_PROJECTS_RATIO;
  let controller = null;
  let loading = null;
  let queue = Promise.resolve();
  let pendingWrites = 0;

  const options = () => ({
    signal: controller?.signal,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(auth?.token ? { Authorization: `Bearer ${auth.token}` } : {}),
    },
  });
  const authenticated = () => !!(auth?.isAuthenticated && auth?.userId);
  async function refresh() {
    if (!authenticated() || pendingWrites) return;
    if (loading) return loading;
    const expectedGeneration = generation;
    const expectedRevision = revision;
    const work = (async () => {
      try {
        const response = await request('/api/user/preferences', { ...options(), cache: 'no-store' });
        if (!response.ok) throw new Error('load');
        const value = await response.json();
        if (generation !== expectedGeneration || revision !== expectedRevision) return;
        confirmed = clampSidebarProjectsRatio(value.sidebarProjectsRatio);
        preferences.value = { sidebarProjectsRatio: confirmed };
        ready.value = true;
        error.value = null;
      } catch {
        if (generation === expectedGeneration && revision === expectedRevision) error.value = 'load';
      }
    })();
    loading = work;
    try { await work; } finally { if (loading === work) loading = null; }
  }

  function saveSidebarProjectsRatio(value) {
    if (!authenticated() || !ready.value) return Promise.resolve(false);
    const ratio = clampSidebarProjectsRatio(value);
    const expectedGeneration = generation;
    const expectedRevision = ++revision;
    preferences.value = { sidebarProjectsRatio: ratio };
    error.value = null;
    pendingWrites++;
    const work = queue.then(async () => {
      if (generation !== expectedGeneration) return false;
      try {
        const response = await request('/api/user/preferences', {
          ...options(), method: 'PATCH', body: JSON.stringify({ sidebarProjectsRatio: ratio }),
        });
        if (!response.ok) throw new Error('save');
        const result = await response.json();
        if (generation !== expectedGeneration) return false;
        confirmed = clampSidebarProjectsRatio(result.sidebarProjectsRatio);
        if (revision === expectedRevision) preferences.value = { sidebarProjectsRatio: confirmed };
        return true;
      } catch {
        if (generation === expectedGeneration && revision === expectedRevision) {
          preferences.value = { sidebarProjectsRatio: confirmed };
          error.value = 'save';
        }
        return false;
      } finally {
        if (generation === expectedGeneration) pendingWrites--;
      }
    });
    queue = work;
    return work;
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
      confirmed = DEFAULT_SIDEBAR_PROJECTS_RATIO;
      preferences.value = { sidebarProjectsRatio: confirmed };
      ready.value = false;
      error.value = null;
      void refresh();
    },
    { immediate: true, flush: 'sync' },
  ));
  return {
    preferences: Vue.readonly(preferences), ready: Vue.readonly(ready), error: Vue.readonly(error),
    refresh, saveSidebarProjectsRatio,
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
