import TerminalTab from './TerminalTab.js';
import GitStatusTab from './GitStatusTab.js';
import FilesTab from './FilesTab.js';

const TOOL_COMPONENTS = Object.freeze({
  terminal: 'TerminalTab',
  git: 'GitStatusTab',
  files: 'FilesTab',
});

export default {
  name: 'WorkbenchCapabilityHost',
  components: { TerminalTab, GitStatusTab, FilesTab },
  props: {
    activeCapability: { type: String, default: null },
    routeProps: { type: Object, required: true },
  },
  template: `
    <KeepAlive :max="3">
      <component
        :is="activeComponent"
        v-if="activeComponent"
        :key="activeCapability"
        v-bind="routeProps"
        :tree-initially-visible="activeCapability === 'files' ? false : undefined"
      />
    </KeepAlive>
  `,
  setup(props) {
    const activeComponent = Vue.computed(() => TOOL_COMPONENTS[props.activeCapability] || null);
    return { activeComponent };
  },
};
