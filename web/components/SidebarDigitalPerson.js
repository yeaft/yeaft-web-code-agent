export default {
  name: 'SidebarDigitalPerson',
  props: { collapsed: { type: Boolean, default: false } },
  methods: { open() { Pinia.useChatStore().enterDigitalPerson(); } },
  template: `
    <button type="button" class="sidebar-person-trigger" :class="collapsed ? 'collapsed-icon-btn' : 'sidebar-icon-btn'"
            :title="$t('person.title')" :aria-label="$t('person.title')" @click="open">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
        <circle cx="12" cy="7" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>
      </svg>
    </button>
  `,
};
