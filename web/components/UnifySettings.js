/**
 * UnifySettings.js — task-343.
 *
 * Two-column tab dialog mirroring SettingsPanel sizing/tab tokens:
 *   Tab 1 (LLM)     → <LlmTab context="unify"> + task-318 runtime settings
 *   Tab 2 (VP 库)   → <VpCrudPanel>
 *
 * Reuses SettingsPanel's .settings-* class tokens directly (overlay /
 * dialog / nav / content / pane) for zero-drift size alignment.
 *
 * Agent scoping:
 *   Provider CRUD writes target store.unifyAgentId. LlmTab normally binds
 *   to chatStore.currentAgent; the `context="unify"` prop swaps its
 *   effective agent id to unifyAgentId without polluting Chat path.
 *
 * initialTab prop ('llm' | 'vp') lets callers open directly to the VP
 * library (replaces the deprecated standalone VpCrudModal entry point).
 */
import LlmTab from './LlmTab.js';
import VpCrudPanel from './VpCrudPanel.js';

export default {
  name: 'UnifySettings',
  components: { LlmTab, VpCrudPanel },
  props: {
    visible: { type: Boolean, default: true },
    initialTab: { type: String, default: 'llm' }, // 'llm' | 'vp'
  },
  emits: ['close', 'saved'],
  template: `
    <div class="settings-overlay" v-if="visible" @click.self="$emit('close')">
      <div class="settings-dialog">
        <!-- Left Navigation -->
        <div class="settings-nav">
          <div class="settings-nav-title">{{ $t('unify.settings.title') }}</div>
          <button
            v-for="tab in tabs"
            :key="tab.key"
            class="settings-nav-item"
            :class="{ active: activeTab === tab.key }"
            @click="activeTab = tab.key"
          >
            <svg v-if="tab.key === 'llm'" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M21 10.12h-6.78l2.74-2.82c-2.73-2.7-7.15-2.8-9.88-.1-2.73 2.71-2.73 7.08 0 9.79s7.15 2.71 9.88 0C18.32 15.65 19 14.08 19 12.1h2c0 1.98-.88 4.55-2.64 6.29-3.51 3.48-9.21 3.48-12.72 0-3.5-3.47-3.5-9.11 0-12.58 3.51-3.47 9.14-3.49 12.65-.06L21 3v7.12zM12.5 8v4.25l3.5 2.08-.72 1.21L11 13V8h1.5z"/></svg>
            <svg v-else-if="tab.key === 'vp'" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
            <span>{{ tab.label }}</span>
          </button>
        </div>

        <!-- Right Content -->
        <div class="settings-content">
          <div class="settings-content-header">
            <h2 class="settings-content-title">{{ currentTabLabel }}</h2>
            <button class="settings-close" @click="$emit('close')" :title="$t('common.close')">
              <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
            </button>
          </div>
          <div class="settings-scroll">
            <!-- LLM pane: provider CRUD + task-318 runtime settings -->
            <div v-show="activeTab === 'llm'" class="settings-pane">
              <LlmTab context="unify" @message="onLlmMessage" @saved="onLlmSaved" />

              <!-- H2.f.6: thread-concurrency + auto-archive runtime settings
                   removed alongside the multi-thread engine. -->
            </div>

            <!-- VP Library pane -->
            <div v-show="activeTab === 'vp'" class="settings-pane">
              <VpCrudPanel />
            </div>
          </div>
        </div>
      </div>

      <!-- Toast for LlmTab messages -->
      <transition name="sp-toast">
        <div v-if="toastMessage" class="sp-toast" :class="{ error: toastIsError }">{{ toastMessage }}</div>
      </transition>
    </div>
  `,
  setup(props, { emit }) {
    const store = Pinia.useChatStore();
    const instance = Vue.getCurrentInstance();
    const $t = (key) => instance?.proxy?.$t?.(key) ?? key;

    // Active tab — seeded from initialTab, also reactive to prop changes so
    // a host that flips initialTab='vp' after open lands on the VP tab.
    const activeTab = Vue.ref(props.initialTab === 'vp' ? 'vp' : 'llm');
    Vue.watch(() => props.initialTab, (next) => {
      if (next === 'llm' || next === 'vp') activeTab.value = next;
    });

    const tabs = Vue.computed(() => [
      { key: 'llm', label: $t('unify.settings.tabs.llm') },
      { key: 'vp',  label: $t('unify.settings.tabs.vp') },
    ]);
    const currentTabLabel = Vue.computed(() => {
      const t = tabs.value.find(x => x.key === activeTab.value);
      return t ? t.label : '';
    });

    // Toast surface for LlmTab @message (matches SettingsPanel affordance)
    const toastMessage = Vue.ref('');
    const toastIsError = Vue.ref(false);
    let toastTimer = null;
    function onLlmMessage(text, isError) {
      toastMessage.value = text || '';
      toastIsError.value = !!isError;
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toastMessage.value = ''; }, 3000);
    }

    // LlmTab saved → dispatch unify_reset so Engine picks up new config,
    // and propagate `saved` event to host (preserves task-275 behavior).
    function onLlmSaved() {
      const agentId = store.unifyAgentId;
      if (agentId) {
        store.sendWsMessage({ type: 'unify_reset', agentId });
      }
      emit('saved');
    }

    // H2.f.6: Unify runtime settings (maxConcurrentThreads + autoArchiveIdleDays)
    // removed alongside the multi-thread engine. The block previously lived
    // here; LlmTab still owns the LLM provider config.

    Vue.onUnmounted(() => {
      if (toastTimer) clearTimeout(toastTimer);
    });

    return {
      store,
      activeTab, tabs, currentTabLabel,
      toastMessage, toastIsError, onLlmMessage, onLlmSaved,
    };
  },
};
