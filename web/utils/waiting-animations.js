/**
 * Waiting animations: what plays in the typing indicator while a turn runs.
 *
 * To add one, give it an id here, render it in the indicator beside the
 * others (MessageList, SplitPane) and add its label to Settings. It then
 * joins the random rotation and can be pinned from Settings → General.
 */
export const WAITING_ANIMATIONS = Object.freeze(['hoops', 'cat']);

/** Values of the "Waiting animation" preference: rotate, pin one, or show the dots alone. */
export const WAITING_ANIMATION_CHOICES = Object.freeze(['random', ...WAITING_ANIMATIONS, 'off']);

const DEFAULT_CHOICE = 'random';
const STORAGE_KEY = 'waitingAnimation';

export function normalizeWaitingAnimation(value) {
  return WAITING_ANIMATION_CHOICES.includes(value) ? value : DEFAULT_CHOICE;
}

export function readWaitingAnimationPreference() {
  try {
    return normalizeWaitingAnimation(localStorage.getItem(STORAGE_KEY));
  } catch (_) {
    return DEFAULT_CHOICE;
  }
}

export function writeWaitingAnimationPreference(value) {
  try {
    localStorage.setItem(STORAGE_KEY, normalizeWaitingAnimation(value));
  } catch (_) {
    // Storage can be unavailable (private mode); the choice then lasts for this page.
  }
}

/**
 * The animation for one wait.
 * @param {string} preference A value from WAITING_ANIMATION_CHOICES.
 * @param {number} seed The wait's start time. A rotating pick is derived from
 *   it, so one wait keeps one animation however often its indicator re-renders.
 * @returns {string} An id from WAITING_ANIMATIONS, or 'none' for the dots alone.
 */
export function pickWaitingAnimation(preference, seed = 0) {
  if (preference === 'off') return 'none';
  if (WAITING_ANIMATIONS.includes(preference)) return preference;
  return WAITING_ANIMATIONS[Math.abs(Math.trunc(Number(seed) || 0)) % WAITING_ANIMATIONS.length];
}
