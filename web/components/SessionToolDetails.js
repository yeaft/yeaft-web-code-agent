import ToolLine from './ToolLine.js';

export default {
  name: 'SessionToolDetails',
  components: { ToolLine },
  props: {
    groups: { type: Array, required: true },
    liveExecutionKeys: { type: Set, required: true },
  },
  template: `
    <details v-if="groups.length" class="session-tool-details" @toggle="open = $event.currentTarget.open">
      <summary>{{ $t('yeaft.sessionStatus.toolDetails') }}</summary>
      <template v-if="open">
        <select v-if="groups.length > 1" class="session-tool-group-select" :aria-label="$t('yeaft.sessionStatus.toolTurn')"
          :value="group.key" @change="selectedKey = $event.target.value">
          <option v-for="(item, index) in groups" :key="item.key" :value="item.key">{{ groupLabel(item, index) }}</option>
        </select>
        <p v-else-if="group.label || group.key === 'legacy'" class="session-tool-group-label" :title="group.label">{{ groupLabel(group, 0) }}</p>
        <ul class="session-tool-list" :key="group.key">
          <li v-for="({ row, executionKey }, index) in group.tools" :key="toolKey(row, index)">
            <ToolLine :tool-name="row.toolName" :tool-input="row.toolInput" :tool-result="row.toolResult"
              :has-result="!!row.hasResult" :is-error="!!row.isError" :start-time="row.startTime"
              :inactive="!liveExecutionKeys.has(executionKey)" :expanded="expandedTools.has(toolKey(row, index))"
              @update:expanded="value => setToolExpanded(toolKey(row, index), value)" />
          </li>
        </ul>
      </template>
    </details>
  `,
  setup(props) {
    const t = Vue.getCurrentInstance()?.appContext.config.globalProperties.$t || (key => key);
    const open = Vue.ref(false);
    const selectedKey = Vue.ref('');
    const group = Vue.computed(() => props.groups.find(item => item.key === selectedKey.value) || props.groups[0]);
    const groupLabel = (item, index) => {
      const label = item.key === 'legacy' ? t('yeaft.sessionStatus.toolUnknownTurn')
        : item.label || t('yeaft.sessionStatus.turnNumber', { count: props.groups.length - index });
      return `${label} (${item.tools.length})`;
    };
    const expandedTools = Vue.reactive(new Set());
    const toolKey = (row, index) => row.uiKey || row.id || index;
    const setToolExpanded = (key, value) => value ? expandedTools.add(key) : expandedTools.delete(key);
    Vue.watch(() => group.value?.key, () => { expandedTools.clear(); });
    Vue.watch(() => props.groups.length, length => { if (!length) { open.value = false; selectedKey.value = ''; } });
    return { open, selectedKey, group, groupLabel, expandedTools, toolKey, setToolExpanded };
  },
};
