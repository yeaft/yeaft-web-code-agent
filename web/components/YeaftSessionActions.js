export default {
  name: 'YeaftSessionActions',
  emits: ['reload-messages', 'toggle-session-status', 'toggle-debug', 'reload-page'],
  props: {
    loadingMoreHistory: { type: Boolean, default: false },
    sessionStatusVisible: { type: Boolean, default: true },
    debugMode: { type: Boolean, default: false },
    showPageReload: { type: Boolean, default: false },
  },
  template: `
    <div class="yeaft-session-actions">
      <!-- Message refresh — replays current Yeaft session history without a full page reload. -->
      <button
        class="yeaft-reload-btn"
        @click="$emit('reload-messages')"
        :disabled="loadingMoreHistory"
        :title="$t('yeaft.reloadMessages')"
        :aria-label="$t('yeaft.reloadMessages')"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
        </svg>
      </button>
      <button
        class="yeaft-topbar-vp-toggle"
        :class="{ active: sessionStatusVisible }"
        @click="$emit('toggle-session-status')"
        :title="sessionStatusVisible ? $t('yeaft.sessionStatus.hide') : $t('yeaft.sessionStatus.show')"
        :aria-label="sessionStatusVisible ? $t('yeaft.sessionStatus.hide') : $t('yeaft.sessionStatus.show')"
        :aria-expanded="sessionStatusVisible ? 'true' : 'false'"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="4" width="18" height="16" rx="3"/>
          <path d="M8 9h8"/>
          <path d="M8 14h5"/>
        </svg>
      </button>
      <button
        class="yeaft-debug-btn"
        :class="{ active: debugMode }"
        @click="$emit('toggle-debug')"
        :title="debugMode ? $t('yeaft.hideDebug') : $t('yeaft.showDebug')"
      >
        <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M20 8h-2.81c-.45-.78-1.07-1.45-1.82-1.96L17 4.41 15.59 3l-2.17 2.17C12.96 5.06 12.49 5 12 5s-.96.06-1.41.17L8.41 3 7 4.41l1.62 1.63C7.88 6.55 7.26 7.22 6.81 8H4v2h2.09c-.05.33-.09.66-.09 1v1H4v2h2v1c0 .34.04.67.09 1H4v2h2.81c1.04 1.79 2.97 3 5.19 3s4.15-1.21 5.19-3H20v-2h-2.09c.05-.33.09-.66.09-1v-1h2v-2h-2v-1c0-.34-.04-.67-.09-1H20V8zm-6 8h-4v-2h4v2zm0-4h-4v-2h4v2z"/></svg>
      </button>
      <!-- Page refresh is a mobile-only escape hatch; desktop keeps the header focused on session actions. -->
      <button
        v-if="showPageReload"
        class="yeaft-reload-btn yeaft-page-reload-btn"
        @click="$emit('reload-page')"
        :title="$t('yeaft.reloadPage')"
        :aria-label="$t('yeaft.reloadPage')"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="23 20 23 14 17 14"/><polyline points="1 4 1 10 7 10"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
        </svg>
      </button>
    </div>
  `,
};
