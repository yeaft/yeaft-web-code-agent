import SessionCreateModal from './SessionCreateModal.js';
import { useUserShortcuts } from '../utils/user-shortcuts.js';
import { handleGlobalShortcut } from '../utils/global-shortcuts.js';
import { workbenchRouteKey } from '../utils/workbench-route.js';

/** App-owned keyboard listener; session creation reuses the standard provider/Agent picker. */
export default {
  name: 'UserShortcutsRuntime',
  components: { SessionCreateModal },
  template: `
    <SessionCreateModal v-if="sessionCreateOpen" :initial-agent-id="sessionCreateAgentId"
      @close="sessionCreateOpen = false" @created="sessionCreateOpen = false" />
  `,
  setup() {
    const store = window.Pinia.useChatStore();
    const auth = window.Pinia.useAuthStore();
    const { preferences, ownerId } = useUserShortcuts();
    const sessionCreateOpen = Vue.ref(false);
    const sessionCreateAgentId = Vue.ref(null);
    Vue.watch([ownerId, () => store.currentAgent, () => store.currentView], () => {
      sessionCreateOpen.value = false;
    }, { flush: 'sync' });
    const execute = action => {
      if (action === 'newSession') {
        sessionCreateAgentId.value = store.currentAgent;
        sessionCreateOpen.value = true;
        return true;
      }
      if (action === 'closeWorkbench') {
        if (!store.workbenchExpanded) return false;
        store.toggleWorkbench();
        return true;
      }
      // The mounted WorkbenchPanel acknowledges the exact route synchronously.
      const detail = { capabilityId: action, routeKey: workbenchRouteKey(store.activeSessionRoute), accepted: false };
      window.dispatchEvent(new CustomEvent('workbench-open-capability', { detail }));
      return detail.accepted;
    };
    const onKeydown = event => handleGlobalShortcut(event, {
      preferences: preferences.value, store, auth, execute,
    });
    Vue.onMounted(() => document.addEventListener('keydown', onKeydown));
    Vue.onUnmounted(() => document.removeEventListener('keydown', onKeydown));
    return { sessionCreateOpen, sessionCreateAgentId };
  },
};
