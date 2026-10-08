const STORAGE_KEY = 'digital-person-ui-enabled-by-agent';

/** Browser-only entry preference, keyed by Agent. It never configures the runtime. */
export function readPersonUiPreferences() {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) || 'null');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, enabled]) => enabled === true));
  } catch { return {}; }
}

export function writePersonUiPreferences(preferences) {
  try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(preferences)); }
  catch { /* Retain the in-memory preference when browser storage is unavailable. */ }
}
