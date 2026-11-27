/**
 * Document-level theme state: the `data-theme` attribute, the legacy `.light`
 * class, and every `<meta name="theme-color">`.
 *
 * The theme-color metas drive the browser toolbar and the installed-app title
 * bar. Static tags in index.html only follow the OS preference; this module
 * keeps them in step with an explicit in-app choice and with full-bleed
 * surfaces such as the Cosmos page. Colors are read from resolved CSS tokens
 * (`--bg-main`, or the surface's own token) so styles stay the single source.
 */

/** Color of a full-bleed surface currently covering the app, if any. */
let surfaceColor = null;

function syncThemeColorMeta(doc) {
  const root = doc?.documentElement;
  if (!root || typeof doc.querySelectorAll !== 'function') return;
  let color = surfaceColor;
  if (!color) {
    const view = doc.defaultView;
    if (typeof view?.getComputedStyle !== 'function') return;
    color = view.getComputedStyle(root).getPropertyValue('--bg-main').trim();
  }
  if (!color) return;
  for (const meta of doc.querySelectorAll('meta[name="theme-color"]')) {
    meta.setAttribute('content', color);
  }
}

/**
 * Apply the resolved light / dark theme to the document.
 *
 * @param {'light'|'dark'} theme
 * @param {Document} [doc]
 */
export function applyDocumentTheme(theme, doc = globalThis.document) {
  const root = doc?.documentElement;
  if (!root) return;
  root.setAttribute('data-theme', theme);
  root.classList.toggle('light', theme === 'light');
  syncThemeColorMeta(doc);
}

/**
 * Let a full-bleed surface own the theme color while it is shown; pass a
 * falsy color when it goes away to fall back to the theme's `--bg-main`.
 *
 * @param {string|null|undefined} color resolved CSS color of the surface
 * @param {Document} [doc]
 */
export function setThemeColorSurface(color, doc = globalThis.document) {
  surfaceColor = typeof color === 'string' && color.trim() ? color.trim() : null;
  syncThemeColorMeta(doc);
}
