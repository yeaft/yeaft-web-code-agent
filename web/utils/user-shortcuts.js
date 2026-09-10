import { useAuthStore } from '../stores/auth.js';

export const SHORTCUT_ACTIONS = Object.freeze([
  'terminal', 'files', 'git', 'newSession', 'closeWorkbench',
  'quickSend1', 'quickSend2', 'quickSend3', 'quickSend4', 'quickSend5',
]);
const STORAGE_PREFIX = 'yeaft:user-shortcuts:v2:';
const LEGACY_STORAGE_PREFIX = 'yeaft:user-shortcuts:v1:';
const MODIFIERS = ['Ctrl', 'Meta', 'Alt', 'Shift'];
const instances = new WeakMap();
const DEFAULT_BINDINGS = Object.freeze({
  terminal: 'Alt+T', files: 'Alt+O', git: 'Alt+G', newSession: 'Alt+N', closeWorkbench: 'Alt+W',
  quickSend1: 'Alt+1', quickSend2: 'Alt+2', quickSend3: 'Alt+3', quickSend4: 'Alt+4', quickSend5: 'Alt+5',
});
const LEGACY_RECOMMENDED_BINDINGS = Object.freeze({
  terminal: ['Ctrl+Shift+Y', 'Meta+Shift+Y'],
  files: ['Ctrl+Shift+O', 'Meta+Shift+O'],
  git: ['Ctrl+Shift+G', 'Meta+Shift+G'],
  newSession: ['Ctrl+Shift+U', 'Meta+Shift+U'],
  quickSend1: ['Alt+Shift+1'], quickSend2: ['Alt+Shift+2'], quickSend3: ['Alt+Shift+3'],
  quickSend4: ['Alt+Shift+4'], quickSend5: ['Alt+Shift+5'],
});

export function defaultUserShortcuts() {
  return { showQuickSends: false, bindings: { ...DEFAULT_BINDINGS } };
}

/** Bindings are explicit modifiers plus a physical letter/digit key, e.g. Ctrl+Shift+Y. */
export function normalizeShortcut(binding) {
  if (typeof binding !== 'string' || !binding.trim()) return '';
  const parts = binding.split('+').map(part => part.trim());
  const key = parts.pop()?.toUpperCase();
  const modifiers = parts.map(part => MODIFIERS.find(mod => mod.toLowerCase() === part.toLowerCase()));
  if (!/^[A-Z0-9]$/.test(key) || modifiers.some(mod => !mod)
    || new Set(modifiers).size !== modifiers.length
    || !modifiers.some(mod => ['Ctrl', 'Meta', 'Alt'].includes(mod))) return null;
  return [...MODIFIERS.filter(mod => modifiers.includes(mod)), key].join('+');
}

/** Conservative browser/project collision list. Platform-level reservations cannot all be detected. */
export function validateShortcut(binding, bindings = {}, action = '') {
  const normalized = normalizeShortcut(binding);
  if (normalized === null) return { valid: false, error: 'invalid' };
  if (!normalized) return { valid: true, binding: '' };
  const parts = normalized.split('+');
  const key = parts.pop();
  const command = parts.includes('Ctrl') || parts.includes('Meta');
  const shifted = parts.includes('Shift');
  // Ctrl/Meta+F is captured by the Session page even when Shift/Alt is held.
  const reserved = command && (
    'TWNLRPFHJDEBKQS'.includes(key) || /^[0-9]$/.test(key)
    || (!shifted && 'GOACVXYZ'.includes(key))
  );
  if (reserved) return { valid: false, error: 'reserved' };
  const conflict = SHORTCUT_ACTIONS.find(other => other !== action
    && normalizeShortcut(bindings[other]) === normalized);
  if (conflict) return { valid: false, error: 'conflict', conflict };
  return { valid: true, binding: normalized };
}

export function isShortcutEvent(event) {
  return !!event && !event.repeat && !event.isComposing && event.keyCode !== 229
    && !['Dead', 'Process', 'Unidentified'].includes(event.key)
    && !event.getModifierState?.('AltGraph');
}

export function shortcutFromEvent(event) {
  if (!isShortcutEvent(event)) return '';
  // code survives Shift+digit punctuation and Option-generated characters on macOS.
  const codeKey = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(event.code || '');
  const key = codeKey ? codeKey[1] || codeKey[2] : String(event.key || '').toUpperCase();
  if (!/^[A-Z0-9]$/.test(key)) return '';
  const parts = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.metaKey) parts.push('Meta');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  return [...parts, key].join('+');
}

/** Focus rules belong to each caller: quick sends may match inside the Composer. */
export function matchShortcut(event, binding) {
  if (!isShortcutEvent(event) || event.defaultPrevented) return false;
  const result = validateShortcut(binding);
  return result.valid && !!result.binding && shortcutFromEvent(event) === result.binding;
}

function sanitizePreferences(value, { migrateLegacy = false } = {}) {
  const result = defaultUserShortcuts();
  if (!value || typeof value !== 'object') return result;
  result.showQuickSends = value.showQuickSends === true;
  const inputBindings = value.bindings && typeof value.bindings === 'object' ? value.bindings : {};
  const explicitBindings = new Set(Object.values(inputBindings).map(normalizeShortcut).filter(Boolean));
  for (const action of SHORTCUT_ACTIONS) {
    if (!Object.prototype.hasOwnProperty.call(inputBindings, action)
      && explicitBindings.has(DEFAULT_BINDINGS[action])) result.bindings[action] = '';
  }
  const seenInputBindings = new Set();
  for (const action of SHORTCUT_ACTIONS) {
    if (!Object.prototype.hasOwnProperty.call(value.bindings || {}, action)) continue;
    const normalizedInput = normalizeShortcut(value.bindings[action]);
    if (normalizedInput && seenInputBindings.has(normalizedInput)) {
      result.bindings[action] = '';
      continue;
    }
    if (normalizedInput) seenInputBindings.add(normalizedInput);
    const validation = validateShortcut(value.bindings[action], result.bindings, action);
    const binding = validation.valid ? validation.binding : '';
    result.bindings[action] = migrateLegacy && LEGACY_RECOMMENDED_BINDINGS[action]?.includes(binding)
      ? DEFAULT_BINDINGS[action]
      : binding;
  }
  return result;
}

/**
 * Browser-local user ownership. No anonymous/shared fallback and no Agent-scoped persistence.
 * Exported separately for focused tests; production consumers use useUserShortcuts().
 */
export function createUserShortcutsState(auth, { storage = () => globalThis.localStorage } = {}) {
  const preferences = Vue.ref(defaultUserShortcuts());
  const ownerId = Vue.ref(null);
  const scope = Vue.effectScope(true);
  scope.run(() => Vue.watch(
    () => auth.isAuthenticated && auth.userId ? String(auth.userId) : null,
    owner => {
      ownerId.value = owner;
      let value = null;
      try {
        if (owner) {
          const target = storage();
          const suffix = encodeURIComponent(owner);
          const current = target?.getItem(STORAGE_PREFIX + suffix);
          const legacy = target?.getItem(LEGACY_STORAGE_PREFIX + suffix);
          value = JSON.parse(current || legacy || 'null');
          preferences.value = sanitizePreferences(value, { migrateLegacy: !current && !!legacy });
          return;
        }
      } catch (_) {}
      preferences.value = sanitizePreferences(value);
    },
    { immediate: true, flush: 'sync' },
  ));
  const save = update => {
    if (!ownerId.value) return { ok: false, error: 'unauthenticated' };
    const next = {
      showQuickSends: update?.showQuickSends ?? preferences.value.showQuickSends,
      bindings: { ...preferences.value.bindings, ...update?.bindings },
    };
    for (const action of SHORTCUT_ACTIONS) {
      const validation = validateShortcut(next.bindings[action], next.bindings, action);
      if (!validation.valid) return { ok: false, action, ...validation };
      next.bindings[action] = validation.binding;
    }
    const sanitized = sanitizePreferences(next);
    try {
      const target = storage();
      if (!target) return { ok: false, error: 'storage' };
      target.setItem(STORAGE_PREFIX + encodeURIComponent(ownerId.value), JSON.stringify(sanitized));
    } catch (_) { return { ok: false, error: 'storage' }; }
    preferences.value = sanitized;
    return { ok: true };
  };
  return {
    preferences: Vue.readonly(preferences), ownerId: Vue.readonly(ownerId), save,
    reset: () => save(defaultUserShortcuts()),
    dispose: () => scope.stop(),
  };
}

/** Shared reactive { preferences: Ref, ownerId: Ref, save(patch), reset() }; save returns { ok, error? }. */
export function useUserShortcuts() {
  const auth = useAuthStore();
  if (!instances.has(auth)) instances.set(auth, createUserShortcutsState(auth));
  return instances.get(auth);
}
