import { SHORTCUT_ACTIONS, useUserShortcuts, shortcutFromEvent, isShortcutEvent, validateShortcut } from '../utils/user-shortcuts.js';

export default {
  name: 'UserShortcutsSettings',
  setup() {
    const { preferences, ownerId, save, reset } = useUserShortcuts();
    const recording = Vue.ref('');
    const error = Vue.ref(null);
    const command = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || '') ? 'Meta' : 'Ctrl';
    const suggestions = Object.fromEntries(SHORTCUT_ACTIONS.map((action, index) => [
      action, index < 4 ? `${command}+Shift+${['Y', 'O', 'G', 'U'][index]}` : `Alt+Shift+${index - 3}`,
    ]));
    Vue.watch(ownerId, () => { recording.value = ''; error.value = null; }, { flush: 'sync' });
    function persist(patch, action = '') {
      const result = save(patch);
      error.value = result.ok ? null : { ...result, action };
      return result.ok;
    }
    function record(event, action) {
      if (recording.value !== action) return;
      if (event.key === 'Tab') { recording.value = ''; return; }
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') { recording.value = ''; return; }
      if (!isShortcutEvent(event) || ['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) return;
      const binding = shortcutFromEvent(event);
      const validation = binding ? validateShortcut(binding, preferences.value.bindings, action) : { valid: false, error: 'invalid' };
      if (!validation.valid) { error.value = { ...validation, action }; return; }
      if (persist({ bindings: { [action]: binding } }, action)) recording.value = '';
    }
    function resetAll() {
      recording.value = '';
      const result = reset();
      error.value = result.ok ? null : result;
    }
    return { preferences, ownerId, recording, error, actions: SHORTCUT_ACTIONS, suggestions, persist, record, resetAll };
  },
  template: `
    <section class="user-shortcuts-settings" aria-labelledby="user-shortcuts-title">
      <h3 id="user-shortcuts-title">{{ $t('userShortcuts.title') }}</h3>
      <p class="sp-desc">{{ $t('userShortcuts.scope') }}</p>
      <label class="user-shortcuts-toggle">
        <input type="checkbox" :checked="preferences.showQuickSends" :disabled="!ownerId"
          @change="persist({ showQuickSends: $event.target.checked })" />
        <span>{{ $t('userShortcuts.showQuickSends') }}</span>
      </label>
      <p class="sp-desc">{{ $t('userShortcuts.quickSendHelp') }}</p>
      <p class="sp-desc" id="user-shortcuts-help">{{ $t('userShortcuts.help') }}</p>
      <div v-for="action in actions" :key="action" class="user-shortcuts-row">
        <div class="user-shortcuts-label">
          <span :id="'shortcut-label-' + action">{{ $t('userShortcuts.action.' + action) }}</span>
          <small>{{ $t('userShortcuts.suggestion', { binding: suggestions[action] }) }}</small>
        </div>
        <div class="user-shortcuts-controls">
          <button type="button" class="btn-secondary user-shortcuts-record" :class="{ recording: recording === action }"
            :disabled="!ownerId" :aria-labelledby="'shortcut-label-' + action + ' shortcut-value-' + action"
            :aria-pressed="recording === action" aria-describedby="user-shortcuts-help"
            @click="recording = action; error = null" @keydown="record($event, action)"
            @blur="recording = ''">
            <span :id="'shortcut-value-' + action">{{ recording === action ? $t('userShortcuts.recording') : (preferences.bindings[action] || $t('userShortcuts.unbound')) }}</span>
          </button>
          <button type="button" class="btn-ghost" :disabled="!preferences.bindings[action] || !ownerId"
            :aria-label="$t('userShortcuts.clearAction', { action: $t('userShortcuts.action.' + action) })"
            @click="persist({ bindings: { [action]: '' } }, action)">{{ $t('userShortcuts.clear') }}</button>
        </div>
        <p v-if="error && error.action === action" class="user-shortcuts-error" role="alert">
          {{ $t('userShortcuts.error.' + error.error, { action: $t('userShortcuts.action.' + error.conflict) }) }}
        </p>
      </div>
      <p v-if="error && !error.action" class="user-shortcuts-error" role="alert">{{ $t('userShortcuts.error.' + error.error) }}</p>
      <button type="button" class="btn-secondary" :disabled="!ownerId" @click="resetAll">{{ $t('userShortcuts.reset') }}</button>
    </section>
  `,
};
