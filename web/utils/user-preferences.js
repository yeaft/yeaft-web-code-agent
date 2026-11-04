const instances = new WeakMap();
export const DEFAULT_SIDEBAR_PROJECTS_RATIO = 0.5;
export const MIN_SIDEBAR_PROJECTS_RATIO = 0.15;
export const MAX_SIDEBAR_PROJECTS_RATIO = 0.85;
const defaultPreferences = () => ({
  sidebarProjectsRatio: DEFAULT_SIDEBAR_PROJECTS_RATIO, sidebarActionsCompact: false,
  sidebarCollapsedProjects: {}, sidebarCollapsedSections: {},
});
const collapseFields = ['sidebarCollapsedProjects', 'sidebarCollapsedSections'];
const patchFieldKeys = patch => Object.entries(patch).flatMap(([field, value]) =>
  collapseFields.includes(field) ? Object.keys(value).map(key => `${field}:${key}`) : [field]);
const validProjectKey = key => typeof key === 'string' && key.length > 0 && key.length <= 200
  && !['__proto__', 'constructor', 'prototype'].includes(key);

function normalizeCollapseMap(value, sections = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, collapsed]) =>
    typeof collapsed === 'boolean' && (sections ? ['projects', 'recents'].includes(key) : validProjectKey(key))));
}

function normalizePreferences(value) {
  return {
    sidebarProjectsRatio: clampSidebarProjectsRatio(value.sidebarProjectsRatio),
    sidebarActionsCompact: value.sidebarActionsCompact === true,
    sidebarCollapsedProjects: normalizeCollapseMap(value.sidebarCollapsedProjects),
    sidebarCollapsedSections: normalizeCollapseMap(value.sidebarCollapsedSections, true),
  };
}

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
        confirmed = normalizePreferences(value);
        failedFields.clear();
        showConfirmed();
        ready.value = true;
        error.value = null;
      } catch {
        if (generation === expectedGeneration && revision === expectedRevision) error.value = 'load';
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
      try {
        const response = await request('/api/user/preferences', {
          ...options(), method: 'PATCH', body: JSON.stringify(patch),
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

  function saveSidebarProjectsRatio(value) {
    return savePatch({ sidebarProjectsRatio: clampSidebarProjectsRatio(value) });
  }

  function saveSidebarActionsCompact(value) {
    if (typeof value !== 'boolean') return Promise.resolve(false);
    return savePatch({ sidebarActionsCompact: value });
  }

  function saveSidebarProjectCollapsed(projectId, collapsed) {
    if (!validProjectKey(projectId) || typeof collapsed !== 'boolean') return Promise.resolve(false);
    return savePatch({ sidebarCollapsedProjects: { [projectId]: collapsed } });
  }

  function saveSidebarSectionCollapsed(section, collapsed) {
    if (!['projects', 'recents'].includes(section) || typeof collapsed !== 'boolean') return Promise.resolve(false);
    return savePatch({ sidebarCollapsedSections: { [section]: collapsed } });
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
    preferences: Vue.readonly(preferences), ready: Vue.readonly(ready), error: Vue.readonly(error),
    refresh, saveSidebarProjectsRatio, saveSidebarActionsCompact,
    saveSidebarProjectCollapsed, saveSidebarSectionCollapsed,
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
