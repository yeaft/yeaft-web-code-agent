const STORAGE_KEY = 'session-sidebar-width';

/**
 * Desktop Session / Work Center sidebar width, in CSS px. `default` mirrors
 * `--session-sidebar-width` in variables.css. Browser-local on purpose: a
 * laptop and a wide monitor want different widths, so it is not synced.
 */
export const SESSION_SIDEBAR_WIDTH = Object.freeze({ default: 260, min: 220, max: 480 });

export function clampSessionSidebarWidth(value) {
  const width = Math.round(Number(value));
  if (!Number.isFinite(width)) return SESSION_SIDEBAR_WIDTH.default;
  return Math.min(SESSION_SIDEBAR_WIDTH.max, Math.max(SESSION_SIDEBAR_WIDTH.min, width));
}

export function readSessionSidebarWidth() {
  try {
    const saved = globalThis.localStorage?.getItem(STORAGE_KEY);
    return saved ? clampSessionSidebarWidth(saved) : SESSION_SIDEBAR_WIDTH.default;
  } catch { return SESSION_SIDEBAR_WIDTH.default; }
}

export function writeSessionSidebarWidth(width) {
  try {
    if (width === SESSION_SIDEBAR_WIDTH.default) globalThis.localStorage?.removeItem(STORAGE_KEY);
    else globalThis.localStorage?.setItem(STORAGE_KEY, String(width));
  } catch { /* Keep the in-memory width when browser storage is unavailable. */ }
}

/** The root token is the one layout input every sidebar host reads. */
export function applySessionSidebarWidth(width) {
  const root = globalThis.document?.documentElement;
  if (!root) return;
  if (width === SESSION_SIDEBAR_WIDTH.default) root.style.removeProperty('--session-sidebar-width');
  else root.style.setProperty('--session-sidebar-width', `${width}px`);
}
