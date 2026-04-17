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

      <!-- Left Sidebar (minimal: back + settings) -->
      <aside class="unify-sidebar" :class="{ collapsed: sidebarCollapsed }">
        <div class="unify-sidebar-header">
          <button class="unify-back-btn" @click="goBack" :title="$t('unify.back')">
            <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
            <span class="unify-back-text">{{ $t('unify.back') }}</span>
          </button>
        </div>

        <!-- Spacer pushes settings to bottom -->
        <div class="unify-sidebar-spacer"></div>

        <!-- Settings at bottom -->
        <div class="unify-sidebar-footer">
          <button class="unify-settings-btn" :class="{ active: showSettings }" @click="toggleSettings" :title="$t('unify.settings.title')">
            <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.488.488 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
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

          <!-- Model selector (compact dropdown in topbar) -->
          <div class="unify-topbar-model" @click="toggleModelDropdown" :title="$t('unify.switchModel')">
            <span class="unify-topbar-model-name">{{ store.unifyModel || $t('settings.llm.selectModel') }}</span>
            <svg v-if="store.unifyAvailableModels.length > 1" class="unify-model-chevron" :class="{ open: modelDropdownOpen }" viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
            <!-- Dropdown -->
            <div class="unify-model-dropdown unify-topbar-model-dropdown" v-if="modelDropdownOpen && store.unifyAvailableModels.length > 1" @click.stop>
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
                <span class="unify-model-option-ctx" v-if="m.contextWindow">{{ formatModelCtx(m) }}</span>
              </div>
            </div>
          </div>

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
      <aside class="unify-detail" :class="{ collapsed: detailCollapsed, resizing: isResizingDetail }" :style="detailWidthStyle" ref="detailPanel">
        <div class="unify-detail-drag-handle" :class="{ active: isResizingDetail }" @mousedown.prevent="startDetailResize"></div>
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

    // Detail panel resizable width
    const detailPanel = Vue.ref(null);
    const isResizingDetail = Vue.ref(false);
    const DETAIL_MIN_WIDTH = 300;
    const DETAIL_DEFAULT_WIDTH = Math.max(500, window.innerWidth * 0.35);
    const savedDetailWidth = localStorage.getItem('unify-debug-width');
    const detailWidth = Vue.ref(savedDetailWidth ? parseInt(savedDetailWidth, 10) : DETAIL_DEFAULT_WIDTH);

    const detailWidthStyle = Vue.computed(() => {
      return { '--unify-detail-width': detailWidth.value + 'px' };
    });

    const startDetailResize = (e) => {
      isResizingDetail.value = true;
      const startX = e.clientX;
      const startWidth = detailWidth.value;
      const maxWidth = window.innerWidth * 0.6;

      const onMouseMove = (ev) => {
        // Panel is on the right, so dragging left = wider
        const delta = startX - ev.clientX;
        const newWidth = Math.min(maxWidth, Math.max(DETAIL_MIN_WIDTH, startWidth + delta));
        detailWidth.value = newWidth;
      };

      const onMouseUp = () => {
        isResizingDetail.value = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        localStorage.setItem('unify-debug-width', String(detailWidth.value));
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    };

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

    // Format a token count compactly: 400000 → "400k", 1048576 → "1m", <1000 → raw.
    const formatTokens = (n) => {
      if (!n || !Number.isFinite(n) || n <= 0) return '';
      if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}m`;
      if (n >= 1000) return `${Math.round(n / 1000)}k`;
      return String(n);
    };

    // Context line for a model-dropdown row:
    //   both ctx + max → "400k · 128k out"
    //   only ctx       → "400k"
    //   neither        → "" (template uses v-if to hide the span entirely)
    const formatModelCtx = (m) => {
      const ctx = formatTokens(m?.contextWindow);
      const max = formatTokens(m?.maxOutput);
      if (ctx && max) return `${ctx} · ${max} out`;
      return ctx;
    };

    const closeModelDropdownOutside = (e) => {
      if (!modelDropdownOpen.value) return;
      const row = e.target.closest('.unify-topbar-model, .unify-topbar-model-dropdown');
      if (!row) modelDropdownOpen.value = false;
    };

    const toggleSettings = () => {
      showSettings.value = !showSettings.value;
    };

    const onSettingsSaved = () => {
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
      detailPanel,
      isResizingDetail,
      detailWidthStyle,
      startDetailResize,
      hasMessages,
      isProcessing,
      goBack,
      sendMessage,
      clearMessages,
      toggleSidebar,
      toggleDetail,
      toggleDebug,
      toggleTurnExpand,
      toggleModelDropdown,
      selectModel,
      formatTokens,
      formatModelCtx,
      toggleSettings,
      onSettingsSaved,
      formatMessages,
      formatToolCalls,
    };
  }
};
