import NavigationIcon from './NavigationIcon.js';
export default {
  components: { NavigationIcon },
  name: 'YeaftSessionActions',
  emits: ['toggle-search', 'reload-messages', 'toggle-session-status', 'toggle-workbench', 'reload-page', 'fork-session'],
  props: {
    showFork: { type: Boolean, default: false },
    forkDisabled: { type: Boolean, default: false },
    forkState: { type: String, default: 'idle' },
    forkTitle: { type: String, default: '' },
    searchOpen: { type: Boolean, default: false },
    loadingMoreHistory: { type: Boolean, default: false },
    sessionStatusVisible: { type: Boolean, default: true },
    workbenchVisible: { type: Boolean, default: false },
    canUseWorkbench: { type: Boolean, default: false },
    showPageReload: { type: Boolean, default: false },
  },
  template: `
    <div class="yeaft-session-actions">
      <button
        v-if="showFork"
        type="button"
        class="yeaft-fork-btn"
        :class="{ 'is-copying': forkState === 'copying', 'is-success': forkState === 'success' }"
        :disabled="forkDisabled || forkState === 'copying' || forkState === 'success'"
        :aria-busy="forkState === 'copying' ? 'true' : 'false'"
        :title="forkTitle || $t('yeaft.session.copy')"
        :aria-label="forkState === 'copying' ? $t('yeaft.session.copying') : (forkState === 'success' ? $t('yeaft.session.copyComplete') : $t('yeaft.session.copy'))"
        @click="$emit('fork-session')"
      >
        <svg v-if="forkState === 'success'" class="yeaft-fork-success-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="m5 12 4 4L19 6"/>
        </svg>
        <svg v-else class="yeaft-fork-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="6" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10m12-10v2a4 4 0 0 1-4 4H6"/>
        </svg>
      </button>
      <span
        v-if="showFork && (forkState === 'copying' || forkState === 'success')"
        class="yeaft-session-action-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >{{ forkState === 'copying' ? $t('yeaft.session.copying') : $t('yeaft.session.copyComplete') }}</span>
      <button
        ref="searchButtonRef"
        type="button"
        class="yeaft-search-btn"
        :class="{ active: searchOpen }"
        @click="$emit('toggle-search')"
        :title="$t('yeaft.historySearch.button')"
        :aria-label="$t('yeaft.historySearch.button')"
        :aria-expanded="searchOpen ? 'true' : 'false'"
        aria-controls="yeaft-conversation-outline"
      >
        <NavigationIcon name="search" :size="16" />
      </button>
      <!-- Message refresh — replays current Yeaft session history without a full page reload. -->
      <button
        class="yeaft-reload-btn"
        :class="{ 'is-loading': loadingMoreHistory }"
        @click="$emit('reload-messages')"
        :disabled="loadingMoreHistory"
        :aria-busy="loadingMoreHistory ? 'true' : 'false'"
        :title="$t('yeaft.reloadMessages')"
        :aria-label="$t('yeaft.reloadMessages')"
      >
        <NavigationIcon name="refresh" :size="16" />
      </button>
      <button
        class="yeaft-topbar-vp-toggle"
        :class="{ active: sessionStatusVisible }"
        @click="$emit('toggle-session-status')"
        :title="sessionStatusVisible ? $t('yeaft.sessionStatus.hide') : $t('yeaft.sessionStatus.show')"
        :aria-label="sessionStatusVisible ? $t('yeaft.sessionStatus.hide') : $t('yeaft.sessionStatus.show')"
        :aria-expanded="sessionStatusVisible ? 'true' : 'false'"
      >
        <NavigationIcon name="activity" :size="16" />
      </button>
      <button
        v-if="canUseWorkbench"
        class="yeaft-topbar-vp-toggle"
        :class="{ active: workbenchVisible }"
        @click="$emit('toggle-workbench')"
        :title="$t('chat.sidebar.workbench')"
        :aria-label="$t('chat.sidebar.workbench')"
        :aria-expanded="workbenchVisible ? 'true' : 'false'"
      >
        <NavigationIcon name="workbench" :size="16" />
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
