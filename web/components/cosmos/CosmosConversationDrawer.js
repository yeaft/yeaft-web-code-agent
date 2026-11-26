/**
 * Yeaft Cosmos — Feathered Translucent Right Planetary Conversation Drawer
 *
 * Mobile-Yeaft compact layout wrapped in the active planet's atmospheric skin:
 * - Single clean Header: [☰ Sessions] | Planet Emblem + Agent/Session Title | [Search] [Refresh] [New] [Workbench] [Widen] [Close]
 * - Zero redundant session pill bar and zero dashed meta header strip.
 * - Reuses authentic Yeaft MessageList (toolsInStatus=true -> pure user/AI messages + AskCard),
 *   ChatInput (attachments, model, effort, scene), YeaftConversationOutline and WorkbenchPanel.
 */
import MessageList from '../MessageList.js';
import ChatInput from '../ChatInput.js';
import SessionSceneSelect from '../SessionSceneSelect.js';
import WorkbenchPanel from '../WorkbenchPanel.js';
import YeaftConversationOutline from '../YeaftConversationOutline.js';
import { parseMentions } from '../../utils/parseMentions.js';
import {
  buildModelSelectionRows,
  getSessionEffortDisplay,
  getSelectableModelEfforts,
  modelOptionMatchesRef,
  resolveSessionModelRef,
} from '../../utils/modelRefs.js';
import { sessionActivityRows } from '../../stores/helpers/session-activity.js';
import { revealOutlineResult } from '../../utils/message-search-navigation.js';
import { alertDialog } from '../../utils/dialog.js';

export default {
  name: 'CosmosConversationDrawer',
  components: {
    MessageList,
    ChatInput,
    SessionSceneSelect,
    WorkbenchPanel,
    YeaftConversationOutline,
  },
  props: {
    agent: { type: Object, required: true },
    planetId: { type: String, required: true },
    allAgents: { type: Array, default: () => [] },
    widened: { type: Boolean, default: false },
  },
  emits: [
    'close',
    'select-session',
    'create-session',
    'open-llm-config',
    'toggle-widen',
    'message-sent',
  ],
  template: `
    <aside
      class="cosmos-drawer"
      :data-planet-theme="planetId"
      :aria-label="agent.name"
      @pointerdown.stop
      @wheel.stop
    >
      <!-- Single Compact Mobile-Yeaft Header -->
      <header class="cosmos-drawer-head">
        <div class="cosmos-drawer-head-left">
          <button
            type="button"
            class="cosmos-icon-btn"
            :class="{ 'is-active': historyOpen }"
            :aria-expanded="historyOpen ? 'true' : 'false'"
            :title="$t('cosmos.panel.history')"
            :aria-label="$t('cosmos.panel.history')"
            @click="historyOpen = !historyOpen"
          >
            <svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h12"/></svg>
          </button>

          <span class="cosmos-planet-emblem" aria-hidden="true"></span>

          <div class="cosmos-drawer-titles">
            <div class="cosmos-drawer-name-row">
              <span class="cosmos-drawer-agent">{{ agent.name }}</span>
              <span class="cosmos-drawer-planet-badge">{{ $t('cosmos.planets.' + planetId + '.name') }} · {{ $t('cosmos.planets.' + planetId + '.theme') }}</span>
            </div>
            <div class="cosmos-drawer-sub-row">
              <span class="cosmos-drawer-session-title" :title="activeSessionTitle">{{ activeSessionTitle }}</span>
            </div>
          </div>
        </div>

        <div class="cosmos-drawer-actions">
          <button
            v-if="isYeaftView && activeGroup"
            type="button"
            class="cosmos-icon-btn"
            :class="{ 'is-active': searchOpen }"
            :title="$t('cosmos.panel.search')"
            :aria-label="$t('cosmos.panel.search')"
            @click="toggleSearch"
          >
            <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
          </button>

          <button
            type="button"
            class="cosmos-icon-btn"
            :title="$t('cosmos.panel.refresh')"
            :aria-label="$t('cosmos.panel.refresh')"
            @click="refreshHistory"
          >
            <svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/></svg>
          </button>

          <button
            type="button"
            class="cosmos-icon-btn"
            :title="$t('cosmos.panel.newSession')"
            :aria-label="$t('cosmos.panel.newSession')"
            @click="$emit('create-session', agent.id)"
          >
            <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
          </button>

          <button
            v-if="canUseWorkbench"
            type="button"
            class="cosmos-icon-btn"
            :class="{ 'is-active': workbenchOpen }"
            :title="$t('cosmos.panel.workbench')"
            :aria-label="$t('cosmos.panel.workbench')"
            @click="toggleWorkbench"
          >
            <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M13 9h5M13 13h4"/></svg>
          </button>

          <button
            v-if="workbenchOpen"
            type="button"
            class="cosmos-icon-btn"
            :class="{ 'is-active': widened }"
            :title="$t('cosmos.panel.widen')"
            :aria-label="$t('cosmos.panel.widen')"
            @click="$emit('toggle-widen')"
          >
            <svg viewBox="0 0 24 24"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
          </button>

          <button
            type="button"
            class="cosmos-icon-btn"
            :title="$t('cosmos.panel.close')"
            :aria-label="$t('cosmos.panel.close')"
            @click="$emit('close')"
          >
            <svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>
      </header>

      <!-- Sidebar History Switcher (opened via ☰) -->
      <div v-if="historyOpen" class="cosmos-history-drawer">
        <div class="cosmos-history-group-label">{{ $t('cosmos.panel.allSessions') }}</div>
        <button
          v-for="s in agent.sessions"
          :key="s.catalogKey"
          type="button"
          class="cosmos-history-row"
          :class="{ 'is-active': isSessionSelected(s) }"
          @click="pickSession(agent.id, s)"
        >
          <span class="cosmos-history-row-left">
            <span class="cosmos-status-pip" :class="s.status"></span>
            <span class="cosmos-history-row-title">{{ s.title }}</span>
          </span>
          <span class="cosmos-history-row-meta">{{ s.updatedLabel }}</span>
        </button>
        <div v-if="!agent.sessions.length" class="cosmos-hover-empty">{{ $t('cosmos.agent.noSessions') }}</div>

        <template v-for="other in otherAgentsWithSessions" :key="other.id">
          <div class="cosmos-history-group-label">{{ other.name }}</div>
          <button
            v-for="s in other.sessions.slice(0, 6)"
            :key="s.catalogKey"
            type="button"
            class="cosmos-history-row"
            :class="{ 'is-active': isSessionSelected(s) }"
            @click="pickSession(other.id, s)"
          >
            <span class="cosmos-history-row-left">
              <span class="cosmos-status-pip" :class="s.status"></span>
              <span class="cosmos-history-row-title">{{ s.title }}</span>
            </span>
            <span class="cosmos-history-row-meta">{{ s.updatedLabel }}</span>
          </button>
        </template>
      </div>

      <!-- Inline Conversation Outline Search -->
      <YeaftConversationOutline
        v-if="searchOpen && isYeaftView && activeGroup"
        ref="historySearchRef"
        :outline-state="historyOutlineState"
        :search-state="store.yeaftHistorySearchState"
        :active-message-id="searchActiveMessageId"
        :hide-speaker-identity="ordinarySession"
        @query="onSearchQuery"
        @move="searchActiveMessageId = $event"
        @preview="onSearchPreview"
        @select="onSearchSelect"
        @load-older="loadOlderOutline"
        @load-more-search="loadMoreSearch"
        @close="closeSearch"
      />

      <!-- Body Stack: Pure Conversation Stream + Slide-Over Real Workbench -->
      <div class="cosmos-drawer-body">
        <div class="cosmos-drawer-chat">
          <div v-if="!hasSelectedSession" class="cosmos-drawer-empty">
            <span>{{ $t('cosmos.panel.empty') }}</span>
            <button type="button" class="cosmos-drawer-cta" @click="$emit('create-session', agent.id)">
              + {{ $t('cosmos.panel.newSession') }}
            </button>
          </div>

          <template v-else>
            <MessageList
              ref="messageListRef"
              :hide-speaker-identity="ordinarySession"
              :tools-in-status="true"
              :live-execution-keys="liveExecutionKeys"
              :session-activity="sessionActivity"
              @quote-message="setMessageQuote"
              @edit-message-as-new="editMessageAsNew"
            />

            <ChatInput
              ref="chatInputRef"
              class="cosmos-drawer-input"
              :conversation-id="isYeaftView ? store.yeaftConversationId : store.currentConversation"
              :draft-key="composerDraftKey"
              :send-fn="isYeaftView ? sendYeaftMessage : null"
              :hide-vp-mentions="isYeaftView && sceneSession"
              :quick-send-enabled="isYeaftView"
              :quote="messageQuote"
              :cancel-fn="isYeaftView ? cancelYeaft : null"
              :show-stop="isProcessing"
              :collapse-start-actions="false"
              placeholder-key="yeaft.placeholder"
              @remove-quote="messageQuote = null"
              @quote-consumed="messageQuote = null"
            >
              <template #actions-start="{ inActionMenu }">
                <SessionSceneSelect
                  v-if="isYeaftView && ordinarySession && activeGroup"
                  :key="JSON.stringify([agent.id, activeGroup.id])"
                  :session="activeGroup"
                  :agent-id="agent.id"
                  :open="composerMenuOpen === 'scene'"
                  :in-action-menu="inActionMenu"
                  :disabled="store.connectionState !== 'connected' || store.hasAgentCapability?.(agent.id, 'session_scenes') === false"
                  @update:open="$event ? (composerMenuOpen = 'scene') : closeComposerMenu('scene')"
                />
              </template>

              <template #actions-end-before>
                <div v-if="isYeaftView && modelRows.length" class="yeaft-composer-model-controls">
                  <div class="yeaft-composer-choice" :class="{ 'is-open': composerMenuOpen === 'model' }">
                    <button
                      type="button"
                      class="yeaft-composer-model"
                      :title="$t('yeaft.modelMenu.label')"
                      aria-haspopup="menu"
                      :aria-expanded="composerMenuOpen === 'model' ? 'true' : 'false'"
                      @click.stop="toggleComposerMenu('model')"
                    >
                      <span class="yeaft-composer-model-name">{{ activeModelLabel }}</span>
                      <svg class="yeaft-model-chevron" :class="{ open: composerMenuOpen === 'model' }" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
                    </button>
                    <div v-if="composerMenuOpen === 'model'" class="yeaft-model-dropdown yeaft-composer-model-dropdown" role="menu">
                      <div class="yeaft-model-list">
                        <button
                          v-for="row in modelRows"
                          :key="row.modelRef"
                          type="button"
                          class="yeaft-model-option"
                          :class="{ active: modelOptionMatchesRef(row.model, activeModel) }"
                          role="menuitemradio"
                          :aria-checked="modelOptionMatchesRef(row.model, activeModel) ? 'true' : 'false'"
                          @click="selectModel(row.modelRef, row.defaultEffort)"
                        >
                          <span class="yeaft-model-check" aria-hidden="true">{{ modelOptionMatchesRef(row.model, activeModel) ? '✓' : '' }}</span>
                          <span class="yeaft-model-option-main">
                            <span class="yeaft-model-option-label">{{ row.label }}</span>
                            <span class="yeaft-model-option-meta" v-if="row.model.provider">{{ row.model.provider }}</span>
                          </span>
                        </button>
                      </div>
                      <button type="button" class="yeaft-model-config-option" @click="$emit('open-llm-config', agent.id)">
                        <span class="yeaft-model-config-label">{{ $t('settings.llm.configureMenu') }}</span>
                      </button>
                    </div>
                  </div>

                  <div v-if="effortOptions.length" class="yeaft-composer-choice" :class="{ 'is-open': composerMenuOpen === 'effort' }">
                    <button
                      type="button"
                      class="yeaft-composer-effort"
                      aria-haspopup="menu"
                      :aria-expanded="composerMenuOpen === 'effort' ? 'true' : 'false'"
                      @click.stop="toggleComposerMenu('effort')"
                    >
                      <span>{{ $t('yeaft.modelMenu.effort.' + activeEffort) }}</span>
                      <svg class="yeaft-model-chevron" :class="{ open: composerMenuOpen === 'effort' }" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
                    </button>
                    <div v-if="composerMenuOpen === 'effort'" class="yeaft-model-dropdown yeaft-composer-effort-dropdown" role="menu">
                      <button
                        v-for="effort in effortOptions"
                        :key="effort"
                        type="button"
                        class="yeaft-model-option yeaft-composer-effort-option"
                        :class="{ active: effort === activeEffort }"
                        role="menuitemradio"
                        :aria-checked="effort === activeEffort ? 'true' : 'false'"
                        @click="selectEffort(effort)"
                      >
                        <span class="yeaft-model-check" aria-hidden="true">{{ effort === activeEffort ? '✓' : '' }}</span>
                        <span class="yeaft-model-option-label">{{ $t('yeaft.modelMenu.effort.' + effort) }}</span>
                      </button>
                    </div>
                  </div>
                </div>
              </template>
            </ChatInput>
          </template>
        </div>

        <!-- Real Yeaft Workbench (Files / Terminal / Git / Browser) -->
        <div v-if="canUseWorkbench && workbenchOpen" class="cosmos-workbench-host">
          <WorkbenchPanel :owner-route="activeRoute" :owner-work-dir="activeWorkDir" />
        </div>
      </div>
    </aside>
  `,
  setup(props, { emit }) {
    const store = Pinia.useChatStore();
    const sessionsStore = Pinia.useSessionsStore ? Pinia.useSessionsStore() : null;
    const { proxy } = Vue.getCurrentInstance();
    const $t = (k, p) => (proxy?.$t ? proxy.$t(k, p) : k);

    const DEFAULT_HISTORY_SENDER = 'user';
    const historyOpen = Vue.ref(false);
    const searchOpen = Vue.ref(false);
    const searchActiveMessageId = Vue.ref('');
    const historySearchQuery = Vue.ref('');
    const historySearchRef = Vue.ref(null);
    let historySearchTimer = null;
    let stopLoadOlderWatch = null;
    const composerMenuOpen = Vue.ref(null);
    const messageQuote = Vue.ref(null);
    const messageListRef = Vue.ref(null);
    const chatInputRef = Vue.ref(null);

    const isYeaftView = Vue.computed(() => store.currentView === 'yeaft');
    const activeRoute = Vue.computed(() => store.activeSessionRoute || null);

    const activeGroup = Vue.computed(() => {
      if (!isYeaftView.value) return null;
      const sid = store.yeaftActiveSessionFilter || sessionsStore?.activeSessionId || null;
      if (!sid || !props.agent?.id) return null;
      return sessionsStore?.sessionById?.(sid, props.agent.id) || null;
    });

    const hasSelectedSession = Vue.computed(() => {
      if (isYeaftView.value) return Boolean(store.yeaftActiveSessionFilter || sessionsStore?.activeSessionId);
      return Boolean(store.currentConversation);
    });

    const activeSessionTitle = Vue.computed(() => {
      if (isYeaftView.value && activeGroup.value) {
        return activeGroup.value.name || activeGroup.value.id;
      }
      const match = (props.agent?.sessions || []).find((s) => isSessionSelected(s));
      if (match) return match.title;
      if (!isYeaftView.value && store.currentConversation) {
        return store.customConversationTitles?.[store.currentConversation]
          || store.conversationTitles?.[store.currentConversation]
          || store.currentConversation;
      }
      return props.agent?.folder || $t('cosmos.panel.empty');
    });

    const activeWorkDir = Vue.computed(() => (
      activeGroup.value?.workDir
      || store.effectiveWorkDir
      || props.agent?.workDir
      || ''
    ));

    const canUseWorkbench = Vue.computed(() => Boolean(props.agent?.online && hasSelectedSession.value));
    const workbenchOpen = Vue.computed(() => Boolean(canUseWorkbench.value && store.workbenchExpanded));

    const ordinarySession = Vue.computed(() => {
      const roster = activeGroup.value?.roster;
      return !Array.isArray(roster) || roster.length <= 1;
    });

    const sceneSession = Vue.computed(() => Boolean(activeGroup.value?.sceneId));

    const isProcessing = Vue.computed(() => {
      if (isYeaftView.value) {
        const sid = store.yeaftActiveSessionFilter || sessionsStore?.activeSessionId;
        return sid ? Boolean(store.isYeaftSessionProcessing?.(sid, props.agent.id)) : false;
      }
      return Boolean(store.currentConversation && store.processingConversations?.[store.currentConversation]);
    });

    const composerDraftKey = Vue.computed(() => {
      if (isYeaftView.value) {
        const sid = store.yeaftActiveSessionFilter || sessionsStore?.activeSessionId || '';
        return `cosmos-drawer:${props.agent.id}:${sid}`;
      }
      return store.currentConversation || `cosmos-drawer:${props.agent.id}`;
    });

    const sessionActivity = Vue.computed(() => {
      if (!isYeaftView.value || !activeGroup.value) return [];
      try {
        return sessionActivityRows(store, activeGroup.value.id, props.agent.id) || [];
      } catch {
        return [];
      }
    });

    const liveExecutionKeys = Vue.computed(() => {
      const set = new Set();
      for (const row of sessionActivity.value) {
        if (row?.live && row.executionKey) set.add(row.executionKey);
      }
      return set;
    });

    const historyOutlineState = Vue.computed(() => (
      store.getYeaftHistoryOutlineState?.() || { results: [], loading: false, hasMore: false, error: null }
    ));

    const modelRows = Vue.computed(() => buildModelSelectionRows(store.yeaftAvailableModels));
    const activeModel = Vue.computed(() => resolveSessionModelRef(activeGroup.value, store.yeaftModel || ''));
    const activeModelMeta = Vue.computed(() => {
      const hit = modelRows.value.find((r) => modelOptionMatchesRef(r.model, activeModel.value));
      return hit?.model || null;
    });
    const activeModelLabel = Vue.computed(() => {
      const hit = modelRows.value.find((r) => modelOptionMatchesRef(r.model, activeModel.value));
      return hit?.label || activeModel.value || $t('settings.llm.selectModel');
    });
    const effortOptions = Vue.computed(() => (
      activeModelMeta.value ? getSelectableModelEfforts(activeModelMeta.value.effortOptions, activeModelMeta.value) : []
    ));
    const activeEffort = Vue.computed(() => getSessionEffortDisplay(
      activeGroup.value,
      store.yeaftModelEffort || '',
      activeModelMeta.value,
    ));

    const otherAgentsWithSessions = Vue.computed(() => (
      (props.allAgents || []).filter((a) => a.id !== props.agent.id && a.sessions.length > 0)
    ));

    function isSessionSelected(s) {
      if (!s) return false;
      if (s.runtimeProvider === 'yeaft') {
        const sid = store.yeaftActiveSessionFilter || sessionsStore?.activeSessionId;
        return isYeaftView.value && s.id === sid && s.agentId === store.currentAgent;
      }
      return !isYeaftView.value && s.id === store.currentConversation;
    }

    function pickSession(agentId, session) {
      historyOpen.value = false;
      closeSearch();
      emit('select-session', { agentId, session });
    }

    function refreshHistory() {
      if (isYeaftView.value) store.reloadYeaftMessages?.();
      else if (store.currentConversation) store.syncChatConversationHistory?.(store.currentConversation);
    }

    function toggleWorkbench() {
      store.toggleWorkbench?.();
    }

    function clearSearchTimers() {
      if (historySearchTimer) {
        clearTimeout(historySearchTimer);
        historySearchTimer = null;
      }
      if (stopLoadOlderWatch) {
        stopLoadOlderWatch();
        stopLoadOlderWatch = null;
      }
    }

    function resetHistorySearchState(senderKey = DEFAULT_HISTORY_SENDER) {
      store.yeaftHistorySearchState = {
        requestId: null,
        agentId: props.agent?.id || store.currentAgent || null,
        sessionId: activeGroup.value?.id || store.yeaftActiveSessionFilter || null,
        query: '',
        senderKey,
        loading: false,
        results: [],
        hasMore: false,
        nextBeforeSeq: null,
        error: null,
      };
    }

    function closeSearch() {
      clearSearchTimers();
      historySearchQuery.value = '';
      resetHistorySearchState(DEFAULT_HISTORY_SENDER);
      searchOpen.value = false;
      searchActiveMessageId.value = '';
    }

    function openSearch() {
      clearSearchTimers();
      historySearchQuery.value = '';
      resetHistorySearchState(DEFAULT_HISTORY_SENDER);
      searchOpen.value = true;
      store.searchYeaftHistory?.('', { senderKey: DEFAULT_HISTORY_SENDER });
      Vue.nextTick(() => historySearchRef.value?.focus?.());
    }

    function toggleSearch() {
      if (searchOpen.value) closeSearch();
      else if (activeGroup.value) openSearch();
    }

    function onSearchQuery(query) {
      if (!activeGroup.value) return;
      historySearchQuery.value = query;
      if (historySearchTimer) clearTimeout(historySearchTimer);
      searchActiveMessageId.value = '';
      historySearchTimer = setTimeout(() => {
        historySearchTimer = null;
        const senderKey = store.yeaftHistorySearchState?.senderKey ?? DEFAULT_HISTORY_SENDER;
        store.searchYeaftHistory?.(historySearchQuery.value, { senderKey });
      }, 220);
    }

    function onSearchPreview(result) {
      if (!result) return;
      if (store.hasCapability?.('session_history_window_prefetch')) {
        store.loadYeaftHistoryWindow?.(result);
      }
    }

    function onSearchSelect(result) {
      if (!result) return null;
      searchActiveMessageId.value = result.messageId || '';
      const revealLease = store.beginYeaftHistoryReveal?.(result) || null;
      const isMobileViewport = typeof window !== 'undefined' && window.innerWidth <= 768;
      return revealOutlineResult({
        result,
        revealWindow: (candidate) => store.revealYeaftHistoryResult?.(candidate, revealLease),
        nextTick: () => Vue.nextTick(),
        revealMessage: (target) => messageListRef.value?.revealMessage?.(target),
        isMobile: isMobileViewport,
        closeOutline: closeSearch,
      }).finally(() => store.finishYeaftHistoryReveal?.(revealLease));
    }

    function loadOlderOutline(scrollSnapshot) {
      if (!activeGroup.value) return;
      if (!store.searchYeaftHistory?.('', { append: true, senderKey: DEFAULT_HISTORY_SENDER })) return;
      if (stopLoadOlderWatch) {
        stopLoadOlderWatch();
        stopLoadOlderWatch = null;
      }
      stopLoadOlderWatch = Vue.watch(
        () => historyOutlineState.value.loading,
        (loading) => {
          if (loading) return;
          if (stopLoadOlderWatch) {
            stopLoadOlderWatch();
            stopLoadOlderWatch = null;
          }
          historySearchRef.value?.restoreOlderScroll?.(scrollSnapshot);
        },
      );
    }

    function loadMoreSearch() {
      if (!activeGroup.value) return;
      const q = store.yeaftHistorySearchState?.query ?? historySearchQuery.value;
      const senderKey = store.yeaftHistorySearchState?.senderKey ?? DEFAULT_HISTORY_SENDER;
      store.searchYeaftHistory?.(q, { append: true, senderKey });
    }

    Vue.watch(
      () => `${props.agent?.id || ''}\u001f${activeGroup.value?.id || ''}`,
      () => {
        if (searchOpen.value || historySearchTimer) closeSearch();
      },
    );

    function toggleComposerMenu(name) {
      composerMenuOpen.value = composerMenuOpen.value === name ? null : name;
    }

    function closeComposerMenu(name = null) {
      if (!name || composerMenuOpen.value === name) composerMenuOpen.value = null;
    }

    async function applyModel(modelId, effort) {
      try {
        const res = await store.switchYeaftModel?.(modelId, activeGroup.value?.id || null, effort);
        if (res?.ok === false && !res.superseded) {
          await alertDialog($t('yeaft.modelMenu.saveFailed'));
        }
      } catch {
        await alertDialog($t('yeaft.modelMenu.saveFailed'));
      }
    }

    function selectModel(modelId, defaultEffort = null) {
      if (!modelId) return;
      void applyModel(modelId, defaultEffort);
      composerMenuOpen.value = null;
    }

    function selectEffort(effort) {
      if (!effortOptions.value.includes(effort) || !activeModel.value) return;
      void applyModel(activeModel.value, effort);
      composerMenuOpen.value = null;
    }

    function sendYeaftMessage(text, attachmentInfos, quote, quickSend) {
      const groupId = store.yeaftActiveSessionFilter || sessionsStore?.activeSessionId;
      if (!groupId) return false;
      const mentions = sceneSession.value ? [] : parseMentions(text).mentions;
      const attachments = Array.isArray(attachmentInfos) ? attachmentInfos : undefined;
      const res = store.sendYeaftSessionMessage({
        groupId,
        text,
        mentions,
        attachments,
        quote,
        cosmosDelivery: true,
        ...(quickSend ? { quickSend } : {}),
      });
      if (res !== false) {
        emit('message-sent', { agentId: props.agent.id, planetId: props.planetId });
      }
      return res;
    }

    function cancelYeaft() {
      const sid = store.yeaftActiveSessionFilter || sessionsStore?.activeSessionId;
      if (sid) store.cancelYeaftSession?.(sid);
    }

    function setMessageQuote(quote) {
      if (!quote) return;
      messageQuote.value = quote;
      chatInputRef.value?.focusInput?.();
    }

    function editMessageAsNew(text) {
      messageQuote.value = null;
      chatInputRef.value?.replaceDraft?.(text || '');
    }

    const onDocClick = (e) => {
      if (composerMenuOpen.value && !e.target.closest('.yeaft-composer-choice')) {
        composerMenuOpen.value = null;
      }
    };

    Vue.onMounted(() => document.addEventListener('click', onDocClick));
    Vue.onBeforeUnmount(() => {
      clearSearchTimers();
      document.removeEventListener('click', onDocClick);
    });

    return {
      store,
      historyOpen,
      searchOpen,
      searchActiveMessageId,
      historySearchRef,
      composerMenuOpen,
      messageQuote,
      messageListRef,
      chatInputRef,
      isYeaftView,
      activeRoute,
      activeGroup,
      hasSelectedSession,
      activeSessionTitle,
      activeWorkDir,
      canUseWorkbench,
      workbenchOpen,
      ordinarySession,
      sceneSession,
      isProcessing,
      composerDraftKey,
      sessionActivity,
      liveExecutionKeys,
      historyOutlineState,
      modelRows,
      activeModel,
      activeModelLabel,
      effortOptions,
      activeEffort,
      otherAgentsWithSessions,
      modelOptionMatchesRef,
      isSessionSelected,
      pickSession,
      refreshHistory,
      toggleWorkbench,
      toggleSearch,
      closeSearch,
      onSearchQuery,
      onSearchPreview,
      onSearchSelect,
      loadOlderOutline,
      loadMoreSearch,
      toggleComposerMenu,
      closeComposerMenu,
      selectModel,
      selectEffort,
      sendYeaftMessage,
      cancelYeaft,
      setMessageQuote,
      editMessageAsNew,
    };
  },
};
