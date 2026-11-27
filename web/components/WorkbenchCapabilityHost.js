import TerminalTab from './TerminalTab.js';
import GitStatusTab from './GitStatusTab.js';
import FilesTab from './FilesTab.js';
import CreationTab from './workbench/CreationTab.js';

const TOOL_COMPONENTS = Object.freeze({
  terminal: 'TerminalTab',
  git: 'GitStatusTab',
  files: 'FilesTab',
  creation: 'CreationTab',
});

export default {
  name: 'WorkbenchCapabilityHost',
  components: { TerminalTab, GitStatusTab, FilesTab, CreationTab },
  props: {
    activeCapability: { type: String, default: null },
    retainedCapabilities: { type: Array, default: () => [] },
    routeProps: { type: Object, required: true },
  },
  template: `
    <div class="workbench-capability-host" :class="activeCapability ? 'capability-' + activeCapability : ''">
      <component
        v-for="capability in mountedCapabilities"
        :is="capability.component"
        :key="capability.id"
        v-show="activeCapability === capability.id"
        v-bind="routeProps"
      />
    </div>
  `,
  setup(props) {
    const mountedCapabilities = Vue.computed(() => (
      props.retainedCapabilities
        .map(id => ({ id, component: TOOL_COMPONENTS[id] }))
        .filter(capability => capability.component)
    ));
    return { mountedCapabilities };
  },
};
