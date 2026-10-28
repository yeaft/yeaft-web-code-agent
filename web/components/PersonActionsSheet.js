import NavigationIcon from './NavigationIcon.js';

/** Mobile-only navigation. Choosing an action never starts or cancels an episode. */
export default {
  name: 'PersonActionsSheet',
  components: { NavigationIcon },
  props: {
    refreshDisabled: Boolean,
    settingsDisabled: Boolean,
  },
  emits: ['close', 'select'],
  setup(props, { emit }) {
    const dialog = Vue.ref(null);
    const controls = () => [...(dialog.value?.querySelectorAll('button:not(:disabled)') || [])];
    function keepFocus() {
      if (dialog.value && (!dialog.value.contains(document.activeElement) || document.activeElement?.disabled)) {
        (controls()[0] || dialog.value).focus();
      }
    }
    function keydown(event) {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); emit('close');
      } else if (event.key === 'Tab') {
        const items = controls();
        const first = items[0], last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }
    Vue.onMounted(() => {
      document.addEventListener('keydown', keydown);
      document.addEventListener('focusin', keepFocus);
      Vue.nextTick(keepFocus);
    });
    Vue.onUpdated(keepFocus);
    Vue.onBeforeUnmount(() => {
      document.removeEventListener('keydown', keydown);
      document.removeEventListener('focusin', keepFocus);
    });
    return { dialog };
  },
  template: `
    <div class="modal-overlay person-actions-overlay" @click.self="$emit('close')">
      <section id="person-actions-sheet" ref="dialog" class="modal person-actions-sheet" role="dialog" aria-modal="true" aria-labelledby="person-actions-title" tabindex="-1">
        <header class="person-panel-header">
          <h2 id="person-actions-title">{{ $t('person.moreActions') }}</h2>
          <button type="button" class="header-action-btn person-actions-close" :aria-label="$t('common.close')" @click="$emit('close')"><NavigationIcon name="close" /></button>
        </header>
        <div class="person-actions-list">
          <button type="button" class="btn-ghost person-action-search" @click="$emit('select', 'search')"><NavigationIcon name="search" /><span>{{ $t('person.searchMessages') }}</span></button>
          <button type="button" class="btn-ghost person-action-outputs" @click="$emit('select', 'outputs')"><NavigationIcon name="file" /><span>{{ $t('person.outputs') }}</span></button>
          <button type="button" class="btn-ghost person-action-inside" @click="$emit('select', 'thoughts')"><NavigationIcon name="eye" /><span>{{ $t('person.inside') }}</span></button>
          <button type="button" class="btn-ghost person-action-settings" :disabled="settingsDisabled" @click="$emit('select', 'settings')"><NavigationIcon name="settings" /><span>{{ $t('person.settings') }}</span></button>
          <button type="button" class="btn-ghost person-action-refresh" :disabled="refreshDisabled" @click="$emit('select', 'refresh')"><NavigationIcon name="refresh" /><span>{{ $t('common.refresh') }}</span></button>
        </div>
      </section>
    </div>
  `,
};
