import ChatInput from './ChatInput.js';
import MessageList from './MessageList.js';
import UnifySettings from './UnifySettings.js';
import UnifySidebarV2 from './UnifySidebarV2.js';
import UnifyBreadcrumb from './UnifyBreadcrumb.js';
import UnifyTaskDetailView from './UnifyTaskDetailView.js';
import VpLibraryLink from './VpLibraryLink.js';
import VpCrudModal from './VpCrudModal.js';
import VpDetailView from './VpDetailView.js';
import GroupInviteModal from './GroupInviteModal.js';
import GroupSelector from './GroupSelector.js';
import TaskMessageRejectToast from './TaskMessageRejectToast.js';
import UserMemoryPage from './UserMemoryPage.js';

export default {
  name: 'UnifyPage',
  components: { ChatInput, MessageList, UnifySettings, UnifySidebarV2, UnifyBreadcrumb, UnifyTaskDetailView, VpLibraryLink, VpCrudModal, VpDetailView, GroupInviteModal, GroupSelector, TaskMessageRejectToast, UserMemoryPage },
  template: `
    <div class="unify-page">
      <!-- Mobile sidebar overlay -->
      <div class="unify-sidebar-overlay" v-if="!sidebarCollapsed && isMobile" @click="sidebarCollapsed = true"></div>

      <!-- Left Sidebar — V2 (experimental, feature-flag) OR legacy minimal. -->
      <UnifySidebarV2
        v-if="sidebarV2Enabled"
        @select-thread="onSelectThreadV2"
        @select-task="onSelectTaskV2"
        @jump-to-message="onJumpToMessage"
        @search-escape="onSearchEscape"
        @open-user-memory="onOpenUserMemory"
      />
      <aside class="unify-sidebar" v-else :class="{ collapsed: sidebarCollapsed }">
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
          <VpLibraryLink @open-library="onOpenVpLibrary" />
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

          <!-- task-338-F3: Group selector (active group + switch + new) -->
          <GroupSelector />

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

        <!-- Breadcrumb: visible only when a thread filter is active AND not in task detail view -->
        <UnifyBreadcrumb
          v-if="store.unifyActiveThreadFilter && !store.unifyActiveTaskDetailId"
          :thread-id="store.unifyActiveThreadFilter"
          :thread-name="activeThreadName"
          @back="clearThreadFilter"
        />

        <!-- task-315: Task Detail View replaces the message list when a
             sidebar task is selected. Owns its own breadcrumb + reply
             thread selector. -->
        <UnifyTaskDetailView
          v-if="!showSettings && store.unifyActiveTaskDetailId && !store.unifyActiveVpDetailId"
          @back="exitTaskDetailView"
          @switch-to-thread="onSwitchToThreadFromTaskDetail"
        />

        <!-- task-334-ui-c: VP Detail View replaces the message list when
             a VP badge / library row has been clicked. Takes precedence
             over the task-detail view so clicking a VP inside a task
             pane feels like a drill-down. Esc returns to previous layer
             via the shared keydown cascade. -->
        <VpDetailView
          v-if="!showSettings && store.unifyActiveVpDetailId"
          :vp-id="store.unifyActiveVpDetailId"
          @back="exitVpDetailView"
        />

        <!-- Messages Area — reuse standard MessageList for identical rendering -->
        <UserMemoryPage v-if="!showSettings && userMemoryOpen && !store.unifyActiveVpDetailId" @back="userMemoryOpen = false" />
        <MessageList v-if="!showSettings && !userMemoryOpen && !store.unifyActiveTaskDetailId && !store.unifyActiveVpDetailId" />

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
                  <div class="unify-debug-messages">
                    <div v-for="(m, mi) in (turn.messages || [])" :key="mi" class="unify-debug-msg" :class="'role-' + m.role">
                      <div class="unify-debug-msg-head">
                        <span class="unify-debug-msg-role">[{{ m.role }}]</span>
                        <span v-if="m.toolCallId" class="unify-debug-msg-callid">call_id={{ m.toolCallId }}</span>
                        <span v-if="m.isError" class="unify-debug-msg-err">isError</span>
                      </div>
                      <pre class="unify-debug-pre" v-if="formatMsgContent(m)">{{ formatMsgContent(m) }}</pre>
                      <details v-for="(tc, ti) in (m.toolCalls || [])" :key="'tc-' + ti" class="unify-debug-tc">
                        <summary>→ call_{{ ti + 1 }} {{ tc.name }} <span class="unify-debug-tc-id">({{ tc.id }})</span></summary>
                        <pre class="unify-debug-pre unify-debug-pre-args">{{ prettyJson(tc.input) }}</pre>
                      </details>
                    </div>
                    <div v-if="!(turn.messages && turn.messages.length)" class="unify-debug-empty-inline">(none)</div>
                  </div>
                </div>
                <!-- Response -->
                <div class="unify-debug-section">
                  <div class="unify-debug-section-title">{{ $t('unify.response') }}</div>
                  <pre class="unify-debug-pre">{{ turn.response || '(empty)' }}</pre>
                </div>
                <!-- Function Calls (task-331): request + paired response -->
                <div class="unify-debug-section" v-if="getFunctionCallPairs(turn).length > 0">
                  <div class="unify-debug-section-title">{{ $t('unify.functionCalls') }} ({{ getFunctionCallPairs(turn).length }})</div>
                  <div class="unify-debug-fncalls">
                    <div v-for="(pair, pi) in getFunctionCallPairs(turn)" :key="pi" class="unify-debug-fncall">
                      <div class="unify-debug-fncall-head">
                        <span class="unify-debug-fncall-num">#{{ pi + 1 }}</span>
                        <span class="unify-debug-fncall-name">{{ pair.name }}</span>
                        <span class="unify-debug-fncall-id">({{ pair.id }})</span>
                        <span v-if="pair.response == null" class="unify-debug-fncall-pending">{{ $t('unify.pending') }}</span>
                        <span v-else-if="pair.isError" class="unify-debug-fncall-err">✗</span>
                        <span v-else class="unify-debug-fncall-ok">✓</span>
                      </div>
                      <details open>
                        <summary>{{ $t('unify.request') }} (arguments)</summary>
                        <pre class="unify-debug-pre unify-debug-pre-args">{{ prettyJson(pair.input) }}</pre>
                      </details>
                      <details>
                        <summary>{{ $t('unify.response') }}</summary>
                        <pre class="unify-debug-pre">{{ pair.response != null ? formatToolOutput(pair.response) : '(pending)' }}</pre>
                      </details>
                    </div>
                  </div>
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

      <!-- task-334-ui-g: VP library CRUD modal. Mounted inside the root
           container so Vue sees a single root; the overlay is fixed-position
           and covers the viewport regardless of parent layout. -->
      <VpCrudModal v-if="vpLibraryOpen" @close="vpLibraryOpen = false" />

      <!-- task-334j: reject toast stack (bottom-right) -->
      <TaskMessageRejectToast />

      <!-- task-334m: Group invite modal. Shown whenever the active group
           has no members + no defaultVpId (drives R6 §Δ10 hard constraint
           (c) default-VP fallback). CTA routes to the VP library modal. -->
      <GroupInviteModal
        v-if="shouldShowInviteModal"
        :group-name="inviteGroupName"
        @open-library="onInviteOpenLibrary"
        @dismiss="onInviteDismiss"
      />
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
    const userMemoryOpen = Vue.ref(false);

    // task-301: feature-flag switch between legacy sidebar and V2.
    // Source of truth is the store (persisted via localStorage). Computed
    // so it reacts to Settings toggles without a page refresh.
    const sidebarV2Enabled = Vue.computed(() => !!store.unifySidebarV2Enabled);

    const onSelectThreadV2 = (threadId) => {
      // task-301 Part 2: delegate to store. setActiveThread also drives
      // the task-303 chat-stream dual view filter, so clicking a thread
      // narrows the conversation to that thread's messages.
      store.setActiveThread(threadId);
    };

    const onSelectTaskV2 = (taskId) => {
      // task-315: clicking a task row enters the Task Detail View —
      // replaces the main pane with a cross-thread aggregated message
      // list. Also keeps the sidebar row highlighted (store handles
      // both flags in enterTaskDetailView).
      store.enterTaskDetailView(taskId);
    };

    // task-315: exit the task-detail view back to the main stream.
    const exitTaskDetailView = () => {
      store.leaveTaskDetailView();
    };

    // task-334-ui-c: exit the VP-detail view back to prior layer.
    const exitVpDetailView = () => {
      store.leaveVpDetailView();
    };

    // task-315: clicking a source-thread pill inside the detail view
    // switches to that thread's dual-view (task-303) and leaves the
    // task-detail view behind.
    const onSwitchToThreadFromTaskDetail = (threadId) => {
      if (!threadId) return;
      store.leaveTaskDetailView();
      store.setActiveThread(threadId);
    };

    // task-312/316: sidebar search results — jump to first matching
    // message inside a thread, or to a specific messageId for message
    // hits from the advanced search (task-316).
    const onJumpToMessage = (payload) => {
      if (payload && typeof payload === 'object') {
        store.setUnifyJumpTarget(payload);
      }
    };

    // task-312: Esc in sidebar search box — refocus chat input. The
    // sidebar has already cleared its own query string by the time this
    // fires. We rely on document-level keydown listener below to
    // additionally clear any thread filter, so nothing else is needed
    // here beyond moving focus.
    const onSearchEscape = () => {
      // Small timeout so the input[type=text] blur completes first.
      Vue.nextTick(() => {
        const el = document.querySelector('.input-area textarea, .input-area input[type="text"]');
        if (el && typeof el.focus === 'function') el.focus();
      });
    };

    const onOpenUserMemory = () => {
      userMemoryOpen.value = true;
      showSettings.value = false;
      store.unifyActiveTaskDetailId = null;
      store.unifyActiveVpDetailId = null;
    };

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

    // Esc cascade (task-334-ui-c extends task-315 extends task-303):
    //   1) vp-detail view active → exit it first
    //   2) task-detail view active → exit it (back to main stream)
    //   3) thread filter active    → clear it (standard dual-view behaviour)
    // Only one layer is popped per keystroke so the user always sees
    // a single, predictable transition.
    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      if (store.unifyActiveVpDetailId) {
        store.leaveVpDetailView();
        return;
      }
      if (store.unifyActiveTaskDetailId) {
        store.leaveTaskDetailView();
        return;
      }
      if (store.unifyActiveThreadFilter) {
        store.clearUnifyThreadFilter();
      }
    };

    Vue.onMounted(() => {
      window.addEventListener('resize', onResize);
      document.addEventListener('click', closeModelDropdownOutside);
      document.addEventListener('keydown', onKeyDown);
    });
    Vue.onUnmounted(() => {
      window.removeEventListener('resize', onResize);
      document.removeEventListener('click', closeModelDropdownOutside);
      document.removeEventListener('keydown', onKeyDown);
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
      // task-334m: Pre-check `no_default_vp` before the WS round-trip.
      // If the active group has no roster + no defaultVpId, surface the
      // invite modal instead of sending a message that would round-trip
      // a `no_default_vp` error back as a silent toast.
      const gs = groupsStore();
      if (gs && gs.activeNeedsInvite) {
        const g = gs.activeGroup;
        if (g) inviteDismissedFor.delete(g.id); // force show
        return;
      }
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
        const head = m.toolCallId ? `[${m.role} call_id=${m.toolCallId}]` : `[${m.role}]`;
        const body = content || '(empty)';
        const calls = Array.isArray(m.toolCalls) && m.toolCalls.length
          ? m.toolCalls.map((tc, i) =>
              `\n  → call_${i + 1} ${tc.name}(${JSON.stringify(tc.input)})`
            ).join('')
          : '';
        return `${head} ${body}${calls}`;
      }).join('\n\n');
    };

    // task-331: content renderer for a single debug message — returns the
    // text body only (function_call details render separately as <details>
    // blocks, tool_result body falls through the same pre).
    const formatMsgContent = (m) => {
      if (!m) return '';
      if (typeof m.content === 'string') {
        const s = m.content;
        return s.length > 2000 ? s.slice(0, 2000) + '…' : s;
      }
      if (m.content == null) return '';
      try {
        const s = JSON.stringify(m.content);
        return s.length > 2000 ? s.slice(0, 2000) + '…' : s;
      } catch {
        return String(m.content);
      }
    };

    // task-331: pretty-print a tool_call input blob.
    const prettyJson = (v) => {
      if (v == null) return '';
      try {
        return JSON.stringify(v, null, 2);
      } catch {
        return String(v);
      }
    };

    // task-331: format a tool_result output — may be a string or structured.
    const formatToolOutput = (out) => {
      if (out == null) return '';
      if (typeof out === 'string') {
        return out.length > 4000 ? out.slice(0, 4000) + '…' : out;
      }
      try {
        const s = JSON.stringify(out, null, 2);
        return s.length > 4000 ? s.slice(0, 4000) + '…' : s;
      } catch {
        return String(out);
      }
    };

    // task-331: walk a turn's messages, pairing each assistant `toolCalls`
    // entry with the matching `role:'tool'` message that shares the same
    // id. Returns [{id, name, input, response, isError}, ...] with
    // `response`/`isError` undefined when no paired result (pending).
    const getFunctionCallPairs = (turn) => {
      const pairs = [];
      const msgs = turn?.messages || [];
      // Build index: toolCallId → tool message
      const toolByCallId = new Map();
      for (const m of msgs) {
        if (m.role === 'tool' && m.toolCallId) toolByCallId.set(m.toolCallId, m);
      }
      for (const m of msgs) {
        if (m.role !== 'assistant' || !Array.isArray(m.toolCalls)) continue;
        for (const tc of m.toolCalls) {
          const paired = toolByCallId.get(tc.id);
          pairs.push({
            id: tc.id,
            name: tc.name,
            input: tc.input,
            response: paired ? paired.content : null,
            isError: paired ? !!paired.isError : false,
          });
        }
      }
      // Also surface the CURRENT turn's tool_call requests (toolCalls[]),
      // which haven't been pushed into conversationMessages yet when
      // `debug_turn` fires. These will never have a paired response in
      // THIS turn's snapshot — responses land in the NEXT debug_turn.
      if (Array.isArray(turn?.toolCalls)) {
        const alreadySeen = new Set(pairs.map(p => p.id));
        for (const tc of turn.toolCalls) {
          if (alreadySeen.has(tc.id)) continue;
          pairs.push({
            id: tc.id,
            name: tc.name,
            input: tc.input,
            response: null,
            isError: false,
          });
        }
      }
      return pairs;
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

    // task-334-ui-g: VP library modal open state.
    const vpLibraryOpen = Vue.ref(false);
    const onOpenVpLibrary = () => {
      vpLibraryOpen.value = true;
    };

    // task-334m: Group invite modal wiring. The modal is shown whenever
    // the active group has no roster + no defaultVpId. A per-group
    // `dismissed` set silences it mid-session until the roster changes
    // (dismiss is sticky to the current `(groupId, rosterVersion)` — any
    // roster mutation re-arms the prompt so adding then removing a VP
    // correctly re-surfaces the invite on the next empty state).
    const inviteDismissedFor = Vue.reactive(new Set());
    const groupsStore = () => {
      try {
        return window.Pinia?.useGroupsStore?.() || null;
      } catch { return null; }
    };
    const activeGroupForInvite = Vue.computed(() => {
      const gs = groupsStore();
      return gs ? gs.activeGroup : null;
    });
    const inviteGroupName = Vue.computed(() => {
      const g = activeGroupForInvite.value;
      if (!g) return '';
      // D1 seed sentinel: translate raw 'Default' on grp_default via global i18n.
      if (g.id === 'grp_default' && (g.name === 'Default' || !g.name)) {
        try {
          const globalI18n = (typeof window !== 'undefined') ? window.i18n : null;
          if (globalI18n && globalI18n.global && typeof globalI18n.global.t === 'function') {
            return globalI18n.global.t('unify.group.defaultName');
          }
        } catch (_) {}
      }
      return g.name || g.id || '';
    });
    const shouldShowInviteModal = Vue.computed(() => {
      const gs = groupsStore();
      if (!gs || !gs.activeNeedsInvite) return false;
      const g = gs.activeGroup;
      if (!g) return false;
      // Skip if the user already dismissed THIS empty-roster state.
      return !inviteDismissedFor.has(g.id);
    });
    const onInviteOpenLibrary = () => {
      const g = activeGroupForInvite.value;
      if (g) inviteDismissedFor.add(g.id);
      vpLibraryOpen.value = true;
    };
    const onInviteDismiss = () => {
      const g = activeGroupForInvite.value;
      if (g) inviteDismissedFor.add(g.id);
    };
    // Re-arm the prompt whenever the active roster transitions back to
    // empty (i.e. after the user removed the last member), so the modal
    // fires again next time `activeNeedsInvite` flips true.
    Vue.watch(
      () => {
        const g = activeGroupForInvite.value;
        if (!g) return '';
        return g.id + ':' + (Array.isArray(g.roster) ? g.roster.length : 0) + ':' + (g.defaultVpId || '');
      },
      (next, prev) => {
        // When the roster changes non-trivially, clear the dismissed flag
        // for whatever group id appears in `next` so a later empty state
        // re-shows the modal.
        const g = activeGroupForInvite.value;
        if (g && next !== prev && Array.isArray(g.roster) && g.roster.length > 0) {
          inviteDismissedFor.delete(g.id);
        }
      },
    );

    const onSettingsSaved = () => {
      showSettings.value = false;
    };

    const clearThreadFilter = () => {
      store.clearUnifyThreadFilter();
    };

    // Derive a human-readable label for the active thread, if any message carries a threadName.
    const activeThreadName = Vue.computed(() => {
      const tid = store.unifyActiveThreadFilter;
      if (!tid) return '';
      const convId = store.unifyConversationId;
      const msgs = convId ? (store.messagesMap[convId] || []) : [];
      const named = msgs.find(m => m && m.threadId === tid && m.threadName);
      return named?.threadName || tid;
    });

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
      onOpenVpLibrary,
      vpLibraryOpen,
      formatMessages,
      formatToolCalls,
      formatMsgContent,
      prettyJson,
      formatToolOutput,
      getFunctionCallPairs,
      sidebarV2Enabled,
      onSelectThreadV2,
      onSelectTaskV2,
      exitTaskDetailView,
      exitVpDetailView,
      onSwitchToThreadFromTaskDetail,
      onJumpToMessage,
      onSearchEscape,
      clearThreadFilter,
      activeThreadName,
      // task-334m: invite modal bindings.
      shouldShowInviteModal,
      inviteGroupName,
      onInviteOpenLibrary,
      onInviteDismiss,
      // task-334-ui-d: user memory
      userMemoryOpen,
      onOpenUserMemory,
    };
  }
};
