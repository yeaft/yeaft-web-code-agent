import ToolLine from './ToolLine.js';

export default {
  name: 'SessionToolDetails',
  components: { ToolLine },
  props: { tools: { type: Array, default: () => [] } },
  emits: ['restore-focus'],
  template: `
    <div v-if="$slots.default || tools.length" class="yeaft-query-progress-counts">
      <slot />
      <button v-if="tools.length" ref="trigger" type="button" class="btn-ghost session-tool-details-toggle"
        :aria-label="$t('yeaft.sessionStatus.toolDetails')" :title="$t('yeaft.sessionStatus.toolDetails')"
        :aria-expanded="open" :aria-controls="open ? listId : undefined" @click="setOpen(!open)" @keydown.esc="closeOnEscape">
        {{ $t('yeaft.sessionStatus.toolDetailsShort') }}
        <svg class="yeaft-model-chevron" :class="{ open }" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
      </button>
      <slot name="after" />
    </div>
    <ul v-if="open && tools.length" ref="list" :id="listId" class="yeaft-model-dropdown session-tool-list"
      :aria-label="$t('yeaft.sessionStatus.toolDetails')" @keydown.esc="closeOnEscape">
      <li v-for="row in tools" :key="row.uiKey || row.id">
        <ToolLine :tool-name="row.toolName" :tool-input="row.toolInput" :tool-result="row.toolResult"
          :has-result="!!row.hasResult" :is-error="!!row.isError" :start-time="row.startTime"
          :expanded="expandedTools.has(row.uiKey || row.id)"
          @update:expanded="value => setToolExpanded(row.uiKey || row.id, value)" />
      </li>
    </ul>
  `,
  setup(props, { emit }) {
    const listId = Vue.useId();
    const open = Vue.ref(false);
    const trigger = Vue.ref(null);
    const list = Vue.ref(null);
    const expandedTools = Vue.reactive(new Set());
    const setToolExpanded = (key, value) => value ? expandedTools.add(key) : expandedTools.delete(key);
    const setOpen = (value) => {
      open.value = value;
      if (!value) expandedTools.clear();
    };
    const closeOnEscape = (event) => {
      if (!open.value) return;
      event.stopPropagation();
      event.preventDefault();
      setOpen(false);
      trigger.value?.focus();
    };
    const restoreFocus = () => {
      const active = trigger.value?.ownerDocument.activeElement;
      if (active && (trigger.value === active || list.value?.contains(active))) emit('restore-focus');
    };
    Vue.onBeforeUnmount(restoreFocus);
    Vue.watch(() => props.tools.length, count => {
      if (count) return;
      restoreFocus();
      setOpen(false);
    });
    return { listId, open, trigger, list, expandedTools, setToolExpanded, setOpen, closeOnEscape };
  },
};
