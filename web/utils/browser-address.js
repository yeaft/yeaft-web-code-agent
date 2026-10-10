/**
 * Normalize a client-browser address. Only credential-free HTTP(S) destinations
 * outside the control plane's origin are eligible; this is not a proxy URL.
 * @param {string} value
 * @param {string} [controlPlaneOrigin] Defaults to the current browser origin.
 * @returns {string|null}
 */
export function normalizeBrowserAddress(value, controlPlaneOrigin = globalThis.location?.origin) {
  const raw = String(value || '').trim();
  if (!raw || /[\u0000-\u0020\u007f]/.test(raw) || /^\/(?!\/)/.test(raw)) return null;
  // A host's numeric port is not a URI scheme (e.g. localhost:5173).
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw)
    && !/^(?:localhost|[^/:]+\.[^/:]+):\d+(?:[/?#]|$)/i.test(raw);
  const candidate = raw.startsWith('//') ? `https:${raw}` : hasScheme ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if (controlPlaneOrigin && url.origin === new URL(controlPlaneOrigin).origin) return null;
    return url.href;
  } catch {
    return null;
  }
}
