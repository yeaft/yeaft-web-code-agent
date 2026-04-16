import ChatInput from './ChatInput.js';
import MessageList from './MessageList.js';
import UnifySettings from './UnifySettings.js';

export default {
  name: 'UnifyPage',
  components: { ChatInput, MessageList, UnifySettings },
  template: `
    <div class="unify-page">
      <!-- Mobile sidebar overlay -->
      <div class="unify-sidebar-overlay" v-if="!sidebarCollapsed && isMobile" @click="sidebarCollapsed = true"></div>

      <!-- Left Sidebar -->
      <aside class="unify-sidebar" :class="{ collapsed: sidebarCollapsed }">
        <div class="unify-sidebar-header">
          <button class="unify-back-btn" @click="goBack" :title="$t('unify.back')">
            <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
            <span class="unify-back-text">{{ $t('unify.back') }}</span>
          </button>
        </div>

        <!-- Mode Toggle -->
        <div class="unify-sidebar-section">
          <div class="unify-section-label">{{ $t('unify.mode') }}</div>
          <div class="unify-mode-toggle">
            <button
              class="unify-mode-btn"
              :class="{ active: store.unifyMode === 'chat' }"
              @click="setMode('chat')"
            >{{ $t('unify.chat') }}</button>
            <button
              class="unify-mode-btn"
              :class="{ active: store.unifyMode === 'work' }"
              @click="setMode('work')"
            >{{ $t('unify.work') }}</button>
          </div>
        </div>

        <!-- Agent Info -->
        <div class="unify-sidebar-section" v-if="store.unifyModel || (store.unifyStatus && store.unifyStatus.tools > 0)">
          <div class="unify-section-label">{{ $t('unify.agent') }}</div>
          <div class="unify-agent-info">
            <div class="unify-agent-row unify-model-row" v-if="store.unifyModel" @click="toggleModelDropdown" :title="$t('unify.switchModel')">
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M21 10.12h-6.78l2.74-2.82c-2.73-2.7-7.15-2.8-9.88-.1-2.73 2.71-2.73 7.08 0 9.79s7.15 2.71 9.88 0C18.32 15.65 19 14.08 19 12.1h2c0 1.98-.88 4.55-2.64 6.29-3.51 3.48-9.21 3.48-12.72 0-3.5-3.47-3.5-9.11 0-12.58 3.51-3.47 9.14-3.49 12.65-.06L21 3v7.12z"/></svg>
              <span class="unify-model-name">{{ store.unifyModel }}</span>
              <svg v-if="store.unifyAvailableModels.length > 1" class="unify-model-chevron" :class="{ open: modelDropdownOpen }" viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
            </div>
            <!-- Model selector dropdown -->
            <div class="unify-model-dropdown" v-if="modelDropdownOpen && store.unifyAvailableModels.length > 1">
              <div
                class="unify-model-option"
                :class="{ active: m.id === store.unifyModel }"
                v-for="m in store.unifyAvailableModels"
                :key="m.id"
                @click="selectModel(m.id)"
              >
                <span class="unify-model-check" v-if="m.id === store.unifyModel">&#10003;</span>
                <span class="unify-model-check" v-else></span>
                <span class="unify-model-option-label">{{ m.label || m.id }}</span>
                <span class="unify-model-option-provider" v-if="m.provider">{{ m.provider }}</span>
              </div>
            </div>
            <div class="unify-agent-row" v-if="store.unifyStatus && store.unifyStatus.tools > 0">
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z"/></svg>
              <span>{{ store.unifyStatus.tools }} {{ $t('unify.tools') }}</span>
            </div>
            <div class="unify-agent-row" v-if="store.unifyStatus && store.unifyStatus.skills > 0">
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>
              <span>{{ store.unifyStatus.skills }} {{ $t('unify.skills') }}</span>
            </div>
            <div class="unify-agent-row" v-if="store.unifyStatus && store.unifyStatus.mcpServers > 0">
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
              <span>{{ store.unifyStatus.mcpServers }} {{ $t('unify.mcp') }}</span>
            </div>
          </div>
        </div>

        <!-- Settings button -->
        <div class="unify-sidebar-section">
          <button class="unify-settings-btn" :class="{ active: showSettings }" @click="toggleSettings">
            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.488.488 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
            <span>{{ $t('unify.settings.title') }}</span>
          </button>
        </div>
      </aside>

      <!-- Center Conversation -->
      <div class="unify-main">
        <!-- Conversation Header -->
        <div class="unify-topbar">
          <button class="unify-sidebar-toggle" @click="toggleSidebar" :title="sidebarCollapsed ? $t('unify.showSidebar') : $t('unify.hideSidebar')">
            <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>
          </button>
          <span class="unify-model-badge" v-if="store.unifyModel">{{ store.unifyModel }}</span>
          <div class="unify-topbar-right">
            <button
              class="unify-clear-btn"
              @click="clearMessages"
              v-if="hasMessages"
              :title="$t('unify.clearConfirm')"
            >
              <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
            </button>
            <button
              class="unify-debug-btn"
              :class="{ active: debugMode }"
              @click="toggleDebug"
              :title="debugMode ? $t('unify.hideDebug') : $t('unify.showDebug')"
            >
              <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M20 8h-2.81c-.45-.78-1.07-1.45-1.82-1.96L17 4.41 15.59 3l-2.17 2.17C12.96 5.06 12.49 5 12 5s-.96.06-1.41.17L8.41 3 7 4.41l1.62 1.63C7.88 6.55 7.26 7.22 6.81 8H4v2h2.09c-.05.33-.09.66-.09 1v1H4v2h2v1c0 .34.04.67.09 1H4v2h2.81c1.04 1.79 2.97 3 5.19 3s4.15-1.21 5.19-3H20v-2h-2.09c.05-.33.09-.66.09-1v-1h2v-2h-2v-1c0-.34-.04-.67-.09-1H20V8zm-6 8h-4v-2h4v2zm0-4h-4v-2h4v2z"/></svg>
            </button>
            <button
              class="unify-detail-toggle"
              @click="toggleDetail"
              :title="detailCollapsed ? $t('unify.showDetail') : $t('unify.hideDetail')"
            >
              <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg>
            </button>
          </div>
        </div>

        <!-- Messages Area — reuse standard MessageList for identical rendering -->
        <MessageList v-if="!showSettings" />

        <!-- Settings Panel -->
        <UnifySettings v-if="showSettings" @close="showSettings = false" @saved="onSettingsSaved" />

        <!-- Input Area -->
        <ChatInput
          v-if="!showSettings"
          :send-fn="sendMessage"
          :show-stop="isProcessing"
          placeholder-key="unify.placeholder"
        />
      </div>

      <!-- Right Detail Panel -->
      <aside class="unify-detail" :class="{ collapsed: detailCollapsed }">
        <!-- Debug Mode: show per-turn debug info -->
        <div v-if="debugMode" class="unify-debug-panel">
          <div class="unify-debug-header">
            <span class="unify-debug-title">{{ $t('unify.debug') }}</span>
            <span class="unify-debug-count" v-if="store.unifyDebugTurns.length > 0">{{ store.unifyDebugTurns.length }} {{ $t('unify.debugTurns') }}</span>
          </div>
          <div class="unify-debug-turns" v-if="store.unifyDebugTurns.length > 0">
            <div class="unify-debug-turn" v-for="(turn, idx) in store.unifyDebugTurns" :key="idx">
              <div class="unify-debug-turn-header" @click="toggleTurnExpand(idx)">
                <svg class="unify-debug-turn-chevron" :class="{ expanded: expandedTurns[idx] }" viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
                <span class="unify-debug-turn-num">{{ $t('unify.turn').replace('{n}', turn.turnNumber) }}</span>
                <span class="unify-debug-turn-model">{{ turn.model }}</span>
                <span class="unify-debug-turn-stats">
                  <span>{{ turn.ttfbMs != null ? turn.ttfbMs + 'ms' : '-' }}</span>
                  <span>{{ turn.latencyMs }}ms</span>
                  <span>{{ turn.usage?.inputTokens || 0 }}</span>
                  <span>{{ turn.usage?.outputTokens || 0 }}</span>
                </span>
              </div>
              <div class="unify-debug-turn-body" v-if="expandedTurns[idx]">
                <!-- Token usage -->
                <div class="unify-debug-section">
                  <div class="unify-debug-section-title">{{ $t('unify.duration') }} / Tokens</div>
                  <div class="unify-debug-token-row">
                    <span><span class="unify-debug-token-label">TTFB:</span> {{ turn.ttfbMs != null ? turn.ttfbMs + 'ms' : '-' }}</span>
                    <span><span class="unify-debug-token-label">{{ $t('unify.duration') }}:</span> {{ turn.latencyMs }}ms</span>
                    <span><span class="unify-debug-token-label">{{ $t('unify.inputTokens') }}:</span> {{ turn.usage?.inputTokens || 0 }}</span>
                    <span><span class="unify-debug-token-label">{{ $t('unify.outputTokens') }}:</span> {{ turn.usage?.outputTokens || 0 }}</span>
                  </div>
                </div>
                <!-- System Prompt -->
                <div class="unify-debug-section">
                  <div class="unify-debug-section-title">{{ $t('unify.systemPrompt') }}</div>
                  <pre class="unify-debug-pre">{{ turn.systemPrompt || '(empty)' }}</pre>
                </div>
                <!-- Messages -->
                <div class="unify-debug-section">
                  <div class="unify-debug-section-title">{{ $t('unify.messagesLabel') }} ({{ turn.messages?.length || 0 }})</div>
                  <pre class="unify-debug-pre">{{ formatMessages(turn.messages) }}</pre>
                </div>
                <!-- Response -->
                <div class="unify-debug-section">
                  <div class="unify-debug-section-title">{{ $t('unify.response') }}</div>
                  <pre class="unify-debug-pre">{{ turn.response || '(empty)' }}</pre>
                </div>
                <!-- Tool Calls -->
                <div class="unify-debug-section" v-if="turn.toolCalls && turn.toolCalls.length > 0">
                  <div class="unify-debug-section-title">{{ $t('unify.toolCalls') }} ({{ turn.toolCalls.length }})</div>
                  <pre class="unify-debug-pre">{{ formatToolCalls(turn.toolCalls) }}</pre>
                </div>
              </div>
            </div>
          </div>
          <div class="unify-debug-empty" v-else>
            {{ $t('unify.noDebugData') }}
          </div>
        </div>
        <!-- Default: placeholder -->
        <div v-else class="unify-detail-placeholder">
          <svg viewBox="0 0 24 24" width="24" height="24" opacity="0.3"><path fill="currentColor" d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg>
          <span>{{ $t('unify.tasksMemory') }}</span>
          <span class="unify-detail-hint">{{ $t('unify.comingSoon') }}</span>
        </div>
      </aside>
    </div>
  `,
  setup() {
    const store = Pinia.useChatStore();

    const sidebarCollapsed = Vue.ref(false);
    const detailCollapsed = Vue.ref(false);
    const debugMode = Vue.ref(false);
    const expandedTurns = Vue.reactive({});
    const modelDropdownOpen = Vue.ref(false);
    const showSettings = Vue.ref(false);

    // Detect mobile for overlay behavior
    const isMobile = Vue.ref(window.innerWidth <= 768);
    const onResize = () => { isMobile.value = window.innerWidth <= 768; };
    Vue.onMounted(() => {
      window.addEventListener('resize', onResize);
      document.addEventListener('click', closeModelDropdownOutside);
    });
    Vue.onUnmounted(() => {
      window.removeEventListener('resize', onResize);
      document.removeEventListener('click', closeModelDropdownOutside);
    });

    // Watch for conversationId changes (session_ready migrates local -> agent ID)
    Vue.watch(() => store.unifyConversationId, (newId) => {
      if (newId && store.activeConversations[0] !== newId) {
        store.activeConversations = [newId];
      }
    });

    const hasMessages = Vue.computed(() => {
      const convId = store.unifyConversationId;
      if (!convId) return false;
      const msgs = store.messagesMap[convId];
      return msgs && msgs.length > 0;
    });

    const isProcessing = Vue.computed(() => {
      const convId = store.unifyConversationId;
      return convId ? !!store.processingConversations[convId] : false;
    });

    const goBack = () => {
      store.leaveUnify();
    };

    const sendMessage = (text) => {
      store.sendUnifyChat(text);
    };

    const setMode = (mode) => {
      store.setUnifyMode(mode);
    };

    const clearMessages = () => {
      const { t } = Vue.getCurrentInstance().appContext.config.globalProperties;
      if (confirm(t('unify.clearConfirm'))) {
        store.clearUnifyMessages();
      }
    };

    const toggleSidebar = () => {
      sidebarCollapsed.value = !sidebarCollapsed.value;
    };

    const toggleDetail = () => {
      detailCollapsed.value = !detailCollapsed.value;
    };

    const toggleDebug = () => {
      debugMode.value = !debugMode.value;
      // Open detail panel if activating debug and panel is collapsed
      if (debugMode.value && detailCollapsed.value) {
        detailCollapsed.value = false;
      }
    };

    const toggleTurnExpand = (idx) => {
      expandedTurns[idx] = !expandedTurns[idx];
    };

    const formatMessages = (messages) => {
      if (!messages || messages.length === 0) return '(no messages)';
      return messages.map(m => {
        const content = typeof m.content === 'string'
          ? m.content.slice(0, 500) + (m.content.length > 500 ? '...' : '')
          : JSON.stringify(m.content).slice(0, 500);
        return `[${m.role}] ${content}`;
      }).join('\n\n');
    };

    const formatToolCalls = (toolCalls) => {
      if (!toolCalls || toolCalls.length === 0) return '(none)';
      return toolCalls.map(tc =>
        `${tc.name}(${JSON.stringify(tc.input, null, 2)})`
      ).join('\n\n');
    };

    const toggleModelDropdown = (e) => {
      e.stopPropagation();
      if (store.unifyAvailableModels.length <= 1) return;
      modelDropdownOpen.value = !modelDropdownOpen.value;
    };

    const selectModel = (modelId) => {
      if (modelId === store.unifyModel) {
        modelDropdownOpen.value = false;
        return;
      }
      store.switchUnifyModel(modelId);
      modelDropdownOpen.value = false;
    };

    const closeModelDropdownOutside = (e) => {
      if (!modelDropdownOpen.value) return;
      // Close if click is outside the model row / dropdown
      const row = e.target.closest('.unify-model-row, .unify-model-dropdown');
      if (!row) modelDropdownOpen.value = false;
    };

    const toggleSettings = () => {
      showSettings.value = !showSettings.value;
    };

    const onSettingsSaved = () => {
      // After saving LLM config, reset Unify session so Engine picks up new config
      // The UnifySettings component already sends unify_reset
      showSettings.value = false;
    };

    return {
      store,
      sidebarCollapsed,
      detailCollapsed,
      debugMode,
      expandedTurns,
      modelDropdownOpen,
      showSettings,
      isMobile,
      hasMessages,
      isProcessing,
      goBack,
      sendMessage,
      setMode,
      clearMessages,
      toggleSidebar,
      toggleDetail,
      toggleDebug,
      toggleTurnExpand,
      toggleModelDropdown,
      selectModel,
      toggleSettings,
      onSettingsSaved,
      formatMessages,
      formatToolCalls,
    };
  }
};
