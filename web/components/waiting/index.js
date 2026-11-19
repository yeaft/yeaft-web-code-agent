/**
 * Waiting animations: what plays in the typing indicator while a turn runs.
 *
 * Each animation is one file in this folder that default-exports
 *   { id, layout, component, hidden? }
 *     id         Name used in Settings, in storage and in `?preview=<id>`.
 *     layout     'inline' for a small animation that runs along the indicator
 *                row; 'stage' for one with a picture of its own (see stage.js).
 *     component  Vue component. It is given `clockKey` (identity of the wait
 *                being shown) and `status` (waiting status of the conversation).
 *     hidden     True keeps it out of Settings and out of the random pick;
 *                only `?preview=<id>` shows it.
 *
 * To add one: write the file, import it below and put it in ANIMATIONS. If it
 * has styles, add `styles/waiting/<id>.css` to styles/index.css; if it is not
 * hidden, add its name as `settings.general.waitingAnimationChoice.<id>` in
 * both i18n files. It then joins the random pick and can be chosen in
 * Settings → General.
 */
import cat from './cat.js';
import dog from './dog.js';
import hoops from './hoops.js';

const ANIMATIONS = [hoops, cat, dog];

/** Ids a user can choose, in the order Settings lists them. */
export const WAITING_ANIMATIONS = Object.freeze(ANIMATIONS.filter(animation => !animation.hidden).map(animation => animation.id));

/** Values of the "Waiting animation" preference: a random one each turn, one in particular, or none. */
export const WAITING_ANIMATION_CHOICES = Object.freeze(['random', ...WAITING_ANIMATIONS, 'off']);

const DEFAULT_CHOICE = 'random';
const STORAGE_KEY = 'waitingAnimation';

/** The animation with this id, hidden ones included, or null. */
export function waitingAnimation(id) {
  return ANIMATIONS.find(animation => animation.id === id) || null;
}

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
 * Resolve the preference to an animation. Callers pick once per turn and keep
 * the result, so a turn does not change animation between its tool calls.
 * @param {string} preference A value from WAITING_ANIMATION_CHOICES.
 * @param {number} seed Any integer that differs from turn to turn, such as the
 *   time the wait began; a random pick is derived from it.
 * @returns {string} An id from WAITING_ANIMATIONS, or 'none' for no animation.
 */
export function pickWaitingAnimation(preference, seed = 0) {
  if (preference === 'off') return 'none';
  if (WAITING_ANIMATIONS.includes(preference)) return preference;
  return WAITING_ANIMATIONS[Math.abs(Math.trunc(Number(seed) || 0)) % WAITING_ANIMATIONS.length];
}
