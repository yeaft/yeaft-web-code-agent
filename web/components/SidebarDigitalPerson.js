import { LEGACY_PRODUCT_SURFACES_ENABLED } from '../utils/legacy-product-surfaces.js';
import { availableDigitalPersonAgents } from '../utils/digital-person-agent.js';

export default {
  name: 'SidebarDigitalPerson',
  props: {
    collapsed: { type: Boolean, default: false },
    compact: { type: Boolean, default: false },
  },
  computed: {
    store() {
      return typeof Pinia !== 'undefined' && typeof Pinia.useChatStore === 'function'
        ? Pinia.useChatStore() : null;
    },
    enabled() {
      return LEGACY_PRODUCT_SURFACES_ENABLED && availableDigitalPersonAgents(this.store).length > 0;
    },
  },
  methods: { open() { this.store?.enterDigitalPerson(); } },
  template: `
    <button v-if="enabled" type="button" class="sidebar-person-trigger"
            :class="[collapsed ? 'collapsed-icon-btn' : 'btn-ghost sidebar-primary-action', { active: store.digitalPersonOpen }]"
            :title="$t('person.title')" :aria-label="$t('person.title')"
            :aria-current="store.digitalPersonOpen ? 'page' : undefined" @click="open">
      <svg :class="{ 'sidebar-primary-action-icon': !collapsed }" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
        <circle cx="12" cy="7" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>
      </svg>
      <span v-if="!collapsed && !compact">{{ $t('person.title') }}</span>
    </button>
  `,
};
