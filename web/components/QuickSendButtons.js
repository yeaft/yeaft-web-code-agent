/** Agent-owned presets; keyboard bindings and visibility belong to the user. */
export default {
  name: 'QuickSendButtons',
  props: {
    items: { type: Array, default: () => [] },
    bindings: { type: Object, default: () => ({}) },
    disabled: { type: Boolean, default: false },
  },
  emits: ['send'],
  setup(props, { emit }) {
    const open = Vue.ref(false);
    const root = Vue.ref(null);
    const description = (item, index) => {
      const shortcut = props.bindings[`quickSend${index + 1}`];
      return [item.model, item.effort, item.maxOutputTokens, shortcut].filter(Boolean).join(' · ');
    };
    const choose = item => {
      open.value = false;
      emit('send', item);
    };
    const closeOutside = event => {
      if (open.value && !root.value?.contains(event.target)) open.value = false;
    };
    const onKeydown = event => {
      if (event.key !== 'Escape' || !open.value) return;
      event.preventDefault();
      open.value = false;
      Vue.nextTick(() => root.value?.querySelector('.composer-send-mode-trigger')?.focus());
    };
    Vue.onMounted(() => {
      document.addEventListener('mousedown', closeOutside);
      document.addEventListener('keydown', onKeydown);
    });
    Vue.onBeforeUnmount(() => {
      document.removeEventListener('mousedown', closeOutside);
      document.removeEventListener('keydown', onKeydown);
    });
    return { open, root, description, choose };
  },
  template: `
    <div v-if="items.length" ref="root" class="composer-send-modes">
      <button type="button" class="composer-send-mode-trigger" :disabled="disabled"
        :title="$t('quickSend.composer.label')" :aria-label="$t('quickSend.composer.label')"
        aria-haspopup="menu" :aria-expanded="open ? 'true' : 'false'" @click="open = !open">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path fill="currentColor" d="M5.25 7.5 10 12.25 14.75 7.5z"/></svg>
      </button>
      <div v-if="open" class="composer-send-mode-menu" role="menu">
        <div class="composer-send-mode-heading">{{ $t('quickSend.composer.label') }}</div>
        <button v-for="(item, index) in items" :key="item.id" type="button" role="menuitem"
          class="composer-send-mode-option" :title="description(item, index)" @click="choose(item)">
          <span class="composer-send-mode-number">{{ index + 1 }}</span>
          <span class="composer-send-mode-copy">
            <span class="composer-send-mode-name">{{ item.name }}</span>
            <span class="composer-send-mode-detail">{{ description(item, index) }}</span>
          </span>
          <span v-if="bindings['quickSend' + (index + 1)]" class="composer-send-mode-shortcut">{{ bindings['quickSend' + (index + 1)] }}</span>
        </button>
      </div>
    </div>
  `,
};
