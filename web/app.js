import { useChatStore } from './stores/chat.js';
import { useAuthStore } from './stores/auth.js';
import { useVpStore } from './stores/vp.js';
import { useSessionsStore } from './stores/sessions.js';
import { useBrowserStore } from './stores/browser.js';
import { createI18n } from './utils/i18n.js';
import { installAuthFetch } from './utils/auth-fetch.js';
import zhCN from './i18n/zh-CN.js';
import en from './i18n/en.js';
import LoginPage from './components/LoginPage.js';
import ChatPage from './components/ChatPage.js';
import YeaftPage from './components/YeaftPage.js';
import SplitPane from './components/SplitPane.js';
import ToolLine from './components/ToolLine.js';
import AppDialog from './components/AppDialog.js';
import UserShortcutsRuntime from './components/UserShortcutsRuntime.js';
import { removeLegacyYeaftHistoryDatabase } from './stores/helpers/legacy-yeaft-history-cache-cleanup.js';

removeLegacyYeaftHistoryDatabase();

// Make stores globally available for components
window.Pinia = {
  ...Pinia,
  useChatStore: null,
  useAuthStore: null,
  useBrowserStore: null
};

const App = {
  components: { LoginPage, ChatPage, YeaftPage, AppDialog, UserShortcutsRuntime },
  template: `
    <AppDialog />
    <div v-if="!authStore.initialized" class="auth-bootstrap" aria-busy="true"><span class="session-loading-spinner"></span></div>
    <LoginPage v-else-if="!authStore.isAuthenticated" />
    <template v-else>
      <UserShortcutsRuntime />
      <YeaftPage v-if="chatStore.currentView === 'yeaft'" />
      <ChatPage v-else />
    </template>
  `,
  setup() {
    const chatStore = useChatStore();
    const authStore = useAuthStore();

    // Initialize theme
    chatStore.initTheme();

    // Setup visibility handler for mobile app switching
    chatStore.setupVisibilityHandler();

    Vue.onMounted(() => {
      authStore.initialize();
    });

    Vue.watch(
      () => authStore.initialized && authStore.isAuthenticated,
      (isReady) => {
        if (!isReady) return;
        console.log('[App] Authenticated, connecting WebSocket...');
        chatStore.connect();
      },
      { immediate: true }
    );

    return {
      authStore,
      chatStore
    };
  }
};

// Create and mount Vue app
const app = Vue.createApp(App);
const pinia = Pinia.createPinia();
app.use(pinia);

// Install i18n
createI18n(app, { 'zh-CN': zhCN, en });

// Install fetch interceptor that swaps in renewed JWTs from X-New-Token.
installAuthFetch();

// Set up the store references after pinia is installed
window.Pinia.useChatStore = useChatStore;
window.Pinia.useAuthStore = useAuthStore;
window.Pinia.useVpStore = useVpStore;
window.Pinia.useSessionsStore = useSessionsStore;
window.Pinia.useBrowserStore = useBrowserStore;

// Register global components
app.component('ToolLine', ToolLine);

app.mount('#app');
