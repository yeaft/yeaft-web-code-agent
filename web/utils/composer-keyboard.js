/**
 * Mobile layout and touch-only landscape/tablet composers leave Enter to the
 * textarea. Read media queries at keydown time so rotation/resizing takes effect
 * without a listener; do not infer a keyboard action from the user agent.
 * @returns {boolean} Whether sending requires an explicit composer action.
 */
export function usesMobileComposerKeyboard() {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia === 'function') {
    return window.matchMedia('(max-width: 768px)').matches
      || window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  }
  return Number(window.innerWidth) <= 768;
}
