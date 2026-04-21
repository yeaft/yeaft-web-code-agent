import { useChatStore } from './stores/chat.js';
import { useAuthStore } from './stores/auth.js';
import { useVpStore } from './stores/vp.js';
import { useGroupsStore } from './stores/groups.js';
import { createI18n } from './utils/i18n.js';
import zhCN from './i18n/zh-CN.js';
import en from './i18n/en.js';
import LoginPage from './components/LoginPage.js';
import ChatPage from './components/ChatPage.js';
import UnifyPage from './components/UnifyPage.js';
import SplitPane from './components/SplitPane.js';
import ToolLine from './components/ToolLine.js';
import CrewConfigPanel from './components/CrewConfigPanel.js';

// Make stores globally available for components
window.Pinia = {
  ...Pinia,
  useChatStore: null,
  useAuthStore: null
};

const App = {
  components: { LoginPage, ChatPage, UnifyPage, CrewConfigPanel },
  template: `
    <LoginPage v-if="!authStore.isAuthenticated" />
    <template v-else>
      <UnifyPage v-if="chatStore.currentView === 'unify'" />
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

    // Check auth mode and try to restore session
    Vue.onMounted(async () => {
      await authStore.checkAuthMode();

      // Try to restore session from stored token (if not already authenticated via skip auth)
      if (!authStore.isAuthenticated) {
        await authStore.restoreSession();
      }

      // If authenticated (skip auth mode or restored session), connect WebSocket
      if (authStore.isAuthenticated) {
        console.log('[App] Authenticated, connecting WebSocket...');
        chatStore.connect();
      }
    });

    // Watch for authentication changes
    Vue.watch(() => authStore.isAuthenticated, (isAuth) => {
      if (isAuth) {
        chatStore.connect();
      }
    });

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

// Set up the store references after pinia is installed
window.Pinia.useChatStore = useChatStore;
window.Pinia.useAuthStore = useAuthStore;
window.Pinia.useVpStore = useVpStore;
window.Pinia.useGroupsStore = useGroupsStore;

// Register global components
app.component('ToolLine', ToolLine);

app.mount('#app');
