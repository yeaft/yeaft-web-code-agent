/**
 * Resolve the containing block of a `position: fixed` popup/menu element.
 *
 * By CSS spec, `position: fixed` uses the viewport as its containing block UNLESS
 * an ancestor creates a containing block via `backdrop-filter`, `transform`,
 * `filter`, `perspective`, `contain` (layout/paint/strict/content), or matching
 * `will-change` (e.g. translucent drawers such as `.cosmos-workbench-host`).
 * Subtracting the containing block origin keeps popups aligned to their trigger
 * and clamped inside embedded hosts while leaving viewport positioning identical.
 */
export function resolveFixedContainingBlock(element) {
  let ancestor = element?.parentElement || null;
  const docEl = typeof document !== 'undefined' ? document.documentElement : null;
  while (ancestor && ancestor !== docEl) {
    const style = typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
      ? window.getComputedStyle(ancestor)
      : null;
    if (style) {
      const hasTransform = Boolean(style.transform && style.transform !== 'none');
      const hasFilter = Boolean(style.filter && style.filter !== 'none');
      const hasBackdrop = Boolean(
        (style.backdropFilter && style.backdropFilter !== 'none')
        || (style.webkitBackdropFilter && style.webkitBackdropFilter !== 'none'),
      );
      const hasPerspective = Boolean(style.perspective && style.perspective !== 'none');
      const hasContain = typeof style.contain === 'string'
        && /\b(paint|layout|strict|content)\b/.test(style.contain);
      const hasWillChange = typeof style.willChange === 'string'
        && /\b(transform|filter|backdrop-filter|perspective)\b/.test(style.willChange);
      if (hasTransform || hasFilter || hasBackdrop || hasPerspective || hasContain || hasWillChange) {
        const rect = ancestor.getBoundingClientRect();
        if (rect && (rect.width > 0 || rect.height > 0)) {
          return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
        }
      }
    }
    ancestor = ancestor.parentElement;
  }
  return {
    left: 0,
    top: 0,
    width: typeof window !== 'undefined' ? window.innerWidth : 0,
    height: typeof window !== 'undefined' ? window.innerHeight : 0,
  };
}

export function clampFixedMenuCoordinates(element, { viewportX, viewportY, width = 0, height = 0, margin = 8, maxHeightCap = Infinity }) {
  const cb = resolveFixedContainingBlock(element);
  const maxWidth = Math.max(0, cb.width - margin * 2);
  const maxHeight = Math.min(maxHeightCap, Math.max(0, cb.height - margin * 2));
  const clampedW = Math.min(Math.max(0, width), maxWidth);
  const clampedH = Math.min(Math.max(0, height), maxHeight);
  const x = Math.max(margin, Math.min(viewportX - cb.left, cb.width - clampedW - margin));
  const y = Math.max(margin, Math.min(viewportY - cb.top, cb.height - clampedH - margin));
  return { x, y, maxWidth, maxHeight, containingBlock: cb };
}
