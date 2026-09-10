/** Agent-owned presets; keyboard bindings and visibility belong to the user. */
export default {
  name: 'QuickSendButtons',
  props: {
    items: { type: Array, default: () => [] },
    bindings: { type: Object, default: () => ({}) },
    disabled: { type: Boolean, default: false },
  },
  emits: ['send'],
  methods: {
    description(item, index) {
      const shortcut = this.bindings[`quickSend${index + 1}`];
      return [item.name, item.model, item.effort, item.maxOutputTokens, shortcut].filter(Boolean).join(' · ');
    },
  },
  template: `
    <div v-if="items.length" class="composer-quick-sends" role="group" :aria-label="$t('quickSend.composer.label')">
      <button v-for="(item, index) in items" :key="item.id" type="button"
        class="btn-ghost composer-quick-send" :disabled="disabled"
        :title="description(item, index)"
        :aria-label="$t('quickSend.composer.send', { number: index + 1, name: item.name }) + ' · ' + description(item, index)"
        @click="$emit('send', item)">
        <span class="composer-quick-send-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m7 12 5-5 5 5M12 7v10"/></svg>
        </span>
        <span class="composer-quick-send-number">{{ index + 1 }}</span>
      </button>
    </div>
  `,
};
