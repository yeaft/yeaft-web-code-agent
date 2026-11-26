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
import {
  buildCosmosProjectSessionTree,
  filterCosmosSessions,
} from '../../cosmos/agent-projection.js';
import {
  requestSessionDiscovery,
  supportsSessionDiscovery,
} from '../../stores/helpers/session-discovery.js';

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
    agentToPlanet: { type: Object, default: () => ({}) },
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
            @click="toggleHistoryDrawer"
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
              <span
                v-if="activeSessionProjectPath"
                class="cosmos-drawer-project-chip"
                :title="activeSessionProjectPath"
              >
                <svg viewBox="0 0 20 24" aria-hidden="true"><path d="M2.5 7.5a2 2 0 0 1 2-2h4l1.8 2H15.5a2 2 0 0 1 2 2V18h-15z"/></svg>
                <span>{{ activeSessionProjectPath }}</span>
              </span>
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
            class="cosmos-icon-btn cosmos-drawer-widen-btn"
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

      <!-- Sidebar History, Project Tree & Session Search Switcher (opened via ☰) -->
      <div v-if="historyOpen" class="cosmos-history-drawer">
        <form
          class="cosmos-history-search"
          role="search"
          :aria-label="$t('cosmos.panel.searchSessions')"
          @submit.prevent="submitSessionSearch"
        >
          <svg class="cosmos-history-search-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
          <input
            ref="sessionSearchInputRef"
            v-model="sessionSearchQuery"
            type="search"
            autocomplete="off"
            maxlength="160"
            class="cosmos-history-search-input"
            :placeholder="$t('cosmos.panel.searchSessionsPlaceholder')"
            :aria-label="$t('cosmos.panel.searchSessions')"
            @keydown.esc.stop.prevent="onSessionSearchEsc"
          />
          <button
            v-if="sessionSearchQuery"
            type="button"
            class="cosmos-history-search-clear"
            :title="$t('cosmos.panel.searchSessionsClear')"
            :aria-label="$t('cosmos.panel.searchSessionsClear')"
            @click="clearSessionSearch"
          >×</button>
        </form>

        <div class="cosmos-history-scroll">
          <!-- Filtered + Full-Text Discovery Results -->
          <template v-if="sessionSearchText">
            <button
              v-for="hit in mergedSessionSearchResults"
              :key="hit.key"
              type="button"
              class="cosmos-history-row cosmos-history-search-hit"
              :class="{ 'is-active': isSessionSelected(hit.session) }"
              @click="pickSession(hit.agent.id, hit.session)"
            >
              <div class="cosmos-history-hit-top">
                <span class="cosmos-history-row-left">
                  <span class="cosmos-status-pip" :class="hit.session.status"></span>
                  <span class="cosmos-history-row-title">{{ hit.session.title }}</span>
                </span>
                <span class="cosmos-history-row-meta">{{ hit.session.updatedLabel }}</span>
              </div>
              <div v-if="hit.session.projectPath || hit.agent.id !== agent.id" class="cosmos-history-hit-tags">
                <span v-if="hit.session.projectPath" class="cosmos-history-project-pill">
                  <svg viewBox="0 0 20 24" aria-hidden="true"><path d="M2.5 7.5a2 2 0 0 1 2-2h4l1.8 2H15.5a2 2 0 0 1 2 2V18h-15z"/></svg>
                  <span>{{ hit.session.projectPath }}</span>
                </span>
                <span v-if="hit.agent.id !== agent.id" class="cosmos-history-agent-pill">{{ hit.agent.name }}</span>
              </div>
              <div v-if="hit.snippet" class="cosmos-history-snippet">{{ hit.snippet }}</div>
            </button>

            <div v-if="sessionSearchPending" class="cosmos-history-status" role="status">
              {{ $t('cosmos.panel.searchSessionsLoading') }}
            </div>
            <div v-else-if="!mergedSessionSearchResults.length" class="cosmos-hover-empty">
              {{ $t('cosmos.panel.searchSessionsEmpty') }}
            </div>
          </template>

          <!-- Project Folder Tree + Ungrouped Sessions + Other Agents -->
          <template v-else>
            <div class="cosmos-history-group-label">{{ $t('cosmos.panel.allSessions') }}</div>

            <template v-for="item in currentProjectTree.items" :key="item.key">
              <button
                v-if="item.kind === 'folder'"
                type="button"
                class="cosmos-history-folder"
                :class="{ 'is-collapsed': item.collapsed }"
                :style="{ '--tree-depth': item.depth }"
                :aria-expanded="item.collapsed ? 'false' : 'true'"
                @click="toggleProjectFolder(item.project.id)"
              >
                <svg class="cosmos-history-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
                <svg class="cosmos-history-folder-icon" viewBox="0 0 20 24" aria-hidden="true"><path d="M2.5 7.5a2 2 0 0 1 2-2h4l1.8 2H15.5a2 2 0 0 1 2 2V18h-15z"/></svg>
                <span class="cosmos-history-folder-name" :title="item.pathLabel">{{ item.project.name }}</span>
                <span v-if="item.status === 'waiting' || item.status === 'running'" class="cosmos-status-pip" :class="item.status"></span>
                <span class="cosmos-history-folder-count">{{ item.count }}</span>
              </button>

              <template v-else>
                <div v-if="item.groupStart" class="cosmos-history-group-label cosmos-history-ungrouped-label">
                  {{ $t('cosmos.panel.ungroupedSessions') }}
                </div>
                <button
                  type="button"
                  class="cosmos-history-row"
                  :class="{ 'is-active': isSessionSelected(item.session), 'is-nested': item.depth > 0 }"
                  :style="{ '--tree-depth': item.depth }"
                  @click="pickSession(agent.id, item.session)"
                >
                  <span class="cosmos-history-row-left">
                    <span class="cosmos-status-pip" :class="item.session.status"></span>
                    <span class="cosmos-history-row-title">{{ item.session.title }}</span>
                  </span>
                  <span class="cosmos-history-row-meta">{{ item.session.updatedLabel }}</span>
                </button>
              </template>
            </template>

            <div v-if="!agent.sessions.length" class="cosmos-hover-empty">{{ $t('cosmos.agent.noSessions') }}</div>

            <template v-for="other in otherAgentsWithSessions" :key="other.id">
              <div class="cosmos-history-group-label cosmos-history-other-label">
                <span>{{ other.name }}</span>
                <span v-if="planetLabelForAgent(other.id)" class="cosmos-history-planet-tag">{{ planetLabelForAgent(other.id) }}</span>
              </div>
              <button
                v-for="s in other.sessions.slice(0, 8)"
                :key="s.catalogKey"
                type="button"
                class="cosmos-history-row"
                :class="{ 'is-active': isSessionSelected(s) }"
                @click="pickSession(other.id, s)"
              >
                <span class="cosmos-history-row-left">
                  <span class="cosmos-status-pip" :class="s.status"></span>
                  <span class="cosmos-history-row-title">{{ s.title }}</span>
                  <span v-if="s.projectPath" class="cosmos-history-project-pill" :title="s.projectPath">{{ s.projectPath }}</span>
                </span>
                <span class="cosmos-history-row-meta">{{ s.updatedLabel }}</span>
              </button>
            </template>
          </template>
        </div>
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
        <!-- Bound directly to chatStore (no ownerRoute) so store.workbenchExpanded/Maximized stay live and tabs survive collapse. -->
        <div v-if="canUseWorkbench" v-show="workbenchOpen" class="cosmos-workbench-host">
          <WorkbenchPanel />
        </div>
      </div>
    </aside>
  `,
  setup(props, { emit, expose }) {
    const store = Pinia.useChatStore();
    const sessionsStore = Pinia.useSessionsStore ? Pinia.useSessionsStore() : null;
    const { proxy } = Vue.getCurrentInstance();
    const $t = (k, p) => (proxy?.$t ? proxy.$t(k, p) : k);

    const DEFAULT_HISTORY_SENDER = 'user';
    const SESSION_SEARCH_DEBOUNCE_MS = 220;
    const SESSION_SEARCH_CONCURRENCY = 4;
    const historyOpen = Vue.ref(false);
    const sessionSearchQuery = Vue.ref('');
    const sessionSearchInputRef = Vue.ref(null);
    const sessionSearchPending = Vue.ref(false);
    const sessionDiscoveryResponses = Vue.ref([]);
    const collapsedProjectIds = Vue.ref(new Set());
    let sessionSearchTimer = null;
    let sessionSearchController = null;

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

    const activeProjectedSession = Vue.computed(() => (
      (props.agent?.sessions || []).find((s) => isSessionSelected(s)) || null
    ));

    const currentProjectTree = Vue.computed(() => (
      buildCosmosProjectSessionTree(
        store.sessionProjects || [],
        props.agent?.sessions || [],
        collapsedProjectIds.value,
      )
    ));

    const activeSessionProjectPath = Vue.computed(() => {
      if (activeProjectedSession.value?.projectPath) return activeProjectedSession.value.projectPath;
      if (!isYeaftView.value) return '';
      const sid = store.yeaftActiveSessionFilter || sessionsStore?.activeSessionId || null;
      const aid = props.agent?.id || null;
      if (!sid || !aid) return '';
      const projects = Array.isArray(store.sessionProjects) ? store.sessionProjects : [];
      for (const project of projects) {
        const members = Array.isArray(project?.members)
          ? project.members
          : (project?.agentId ? (project.sessionIds || []).map((sessionId) => ({ agentId: project.agentId, sessionId })) : []);
        if (members.some((m) => m?.agentId === aid && m?.sessionId === sid)) {
          return currentProjectTree.value.tree.pathOf(project.id).map((p) => p.name).filter(Boolean).join(' / ')
            || project.name
            || '';
        }
      }
      return '';
    });

    const canUseWorkbench = Vue.computed(() => Boolean(props.agent?.online && hasSelectedSession.value && activeRoute.value));
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

    const searchableAgents = Vue.computed(() => {
      const list = Array.isArray(props.allAgents) && props.allAgents.length ? props.allAgents : [props.agent];
      return list.filter(Boolean);
    });

    const planetLabelByAgentId = Vue.computed(() => {
      const map = {};
      const bindings = props.agentToPlanet || {};
      for (const ag of searchableAgents.value) {
        const pid = bindings[ag.id] || (ag.id === props.agent?.id ? props.planetId : '');
        if (pid) map[ag.id] = $t(`cosmos.planets.${pid}.name`);
      }
      return map;
    });

    function planetLabelForAgent(agentId) {
      return planetLabelByAgentId.value[agentId] || '';
    }

    const sessionSearchText = Vue.computed(() => (
      historyOpen.value ? sessionSearchQuery.value.trim() : ''
    ));

    const discoveryAgentIds = Vue.computed(() => {
      if (store.sessionDiscoverySupported !== true || store.connectionState !== 'connected') return [];
      const rawAgents = Array.isArray(store.agents) ? store.agents : [];
      return rawAgents
        .filter((a) => a?.online && supportsSessionDiscovery(a))
        .map((a) => a.id)
        .sort();
    });

    const discoveryAgentKey = Vue.computed(() => JSON.stringify(discoveryAgentIds.value));

    const localSessionSearchHits = Vue.computed(() => (
      filterCosmosSessions(searchableAgents.value, sessionSearchText.value, {
        planetLabelByAgentId: planetLabelByAgentId.value,
      })
    ));

    const mergedSessionSearchResults = Vue.computed(() => {
      if (!sessionSearchText.value) return [];
      const byKey = new Map();
      const ordered = [];

      const sessionLookup = new Map();
      for (const ag of searchableAgents.value) {
        for (const s of (ag.sessions || [])) {
          sessionLookup.set(`${ag.id}\u001f${s.id}`, { agent: ag, session: s });
        }
      }

      for (const hit of localSessionSearchHits.value) {
        const k = `${hit.agent.id}\u001f${hit.session.id}`;
        if (byKey.has(k)) continue;
        const entry = {
          key: hit.session.catalogKey || k,
          agent: hit.agent,
          session: hit.session,
          snippet: '',
        };
        byKey.set(k, entry);
        ordered.push(entry);
      }

      const ftsRows = [];
      for (const resp of sessionDiscoveryResponses.value) {
        const results = Array.isArray(resp?.results) ? resp.results : [];
        results.forEach((hit, rank) => {
          if (!hit?.sessionId) return;
          const k = `${resp.agentId}\u001f${hit.sessionId}`;
          const found = sessionLookup.get(k);
          if (!found) return;
          const snippet = typeof hit.snippet === 'string' ? hit.snippet.trim() : '';
          if (byKey.has(k)) {
            const existing = byKey.get(k);
            if (!existing.snippet && snippet) existing.snippet = snippet;
            return;
          }
          ftsRows.push({
            k,
            rank,
            updatedAt: found.session.updatedAt || 0,
            entry: {
              key: found.session.catalogKey || k,
              agent: found.agent,
              session: found.session,
              snippet,
            },
          });
        });
      }

      ftsRows.sort((a, b) => a.rank - b.rank || b.updatedAt - a.updatedAt || a.k.localeCompare(b.k));
      for (const item of ftsRows) {
        if (byKey.has(item.k)) continue;
        byKey.set(item.k, item.entry);
        ordered.push(item.entry);
      }

      return ordered;
    });

    function cancelSessionDiscoverySearch() {
      if (sessionSearchTimer) {
        clearTimeout(sessionSearchTimer);
        sessionSearchTimer = null;
      }
      sessionSearchController?.abort();
      sessionSearchController = null;
      sessionDiscoveryResponses.value = [];
      sessionSearchPending.value = false;
    }

    async function runSessionDiscoverySearch() {
      const query = sessionSearchText.value;
      const agents = discoveryAgentIds.value;
      if (!query || !agents.length) {
        sessionSearchPending.value = false;
        return;
      }
      const controller = new AbortController();
      const { signal } = controller;
      sessionSearchController = controller;
      let next = 0;
      const collected = [];
      const worker = async () => {
        for (let i; !signal.aborted && (i = next++) < agents.length;) {
          const agentId = agents[i];
          try {
            const data = await requestSessionDiscovery(store, agentId, 'search', { query }, signal);
            if (!signal.aborted && Array.isArray(data?.results)) {
              collected.push({ agentId, results: data.results });
              sessionDiscoveryResponses.value = [...collected];
            }
          } catch {
            // Local title/project hits remain visible even if FTS is unavailable or aborted.
          }
        }
      };
      await Promise.all(agents.slice(0, SESSION_SEARCH_CONCURRENCY).map(worker));
      if (!signal.aborted) sessionSearchPending.value = false;
    }

    function queueSessionDiscoverySearch(delay = SESSION_SEARCH_DEBOUNCE_MS) {
      cancelSessionDiscoverySearch();
      if (!sessionSearchText.value || !discoveryAgentIds.value.length) return;
      sessionSearchPending.value = true;
      sessionSearchTimer = setTimeout(() => {
        sessionSearchTimer = null;
        void runSessionDiscoverySearch();
      }, delay);
    }

    Vue.watch(
      () => [sessionSearchText.value, discoveryAgentKey.value, store.ws],
      () => {
        queueSessionDiscoverySearch();
      },
    );

    function expandActiveProjectAncestors() {
      const pid = activeProjectedSession.value?.projectId;
      if (!pid || !collapsedProjectIds.value.size) return;
      const ancestors = currentProjectTree.value.tree.pathOf(pid);
      if (!ancestors.length) return;
      let changed = false;
      const next = new Set(collapsedProjectIds.value);
      for (const item of ancestors) {
        if (next.delete(item.id)) changed = true;
      }
      if (changed) collapsedProjectIds.value = next;
    }

    function toggleProjectFolder(projectId) {
      if (!projectId) return;
      const next = new Set(collapsedProjectIds.value);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      collapsedProjectIds.value = next;
    }

    function closeHistoryDrawer() {
      historyOpen.value = false;
      sessionSearchQuery.value = '';
      cancelSessionDiscoverySearch();
    }

    function toggleHistoryDrawer() {
      if (historyOpen.value) {
        closeHistoryDrawer();
        return;
      }
      historyOpen.value = true;
      expandActiveProjectAncestors();
      Vue.nextTick(() => sessionSearchInputRef.value?.focus?.());
    }

    function clearSessionSearch() {
      sessionSearchQuery.value = '';
      cancelSessionDiscoverySearch();
      Vue.nextTick(() => sessionSearchInputRef.value?.focus?.());
    }

    function onSessionSearchEsc() {
      if (sessionSearchQuery.value) {
        clearSessionSearch();
      } else {
        closeHistoryDrawer();
      }
    }

    function submitSessionSearch() {
      if (mergedSessionSearchResults.value.length > 0) {
        const top = mergedSessionSearchResults.value[0];
        pickSession(top.agent.id, top.session);
      } else if (!sessionSearchPending.value && sessionSearchText.value) {
        queueSessionDiscoverySearch(0);
      }
    }

    function isSessionSelected(s) {
      if (!s) return false;
      if (s.runtimeProvider === 'yeaft') {
        const sid = store.yeaftActiveSessionFilter || sessionsStore?.activeSessionId;
        return isYeaftView.value && s.id === sid && s.agentId === store.currentAgent;
      }
      return !isYeaftView.value && s.id === store.currentConversation;
    }

    function pickSession(agentId, session) {
      closeHistoryDrawer();
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
      cancelSessionDiscoverySearch();
      document.removeEventListener('click', onDocClick);
    });

    expose({
      openSessionSwitcher({ focusSearch = true } = {}) {
        historyOpen.value = true;
        expandActiveProjectAncestors();
        if (focusSearch) Vue.nextTick(() => sessionSearchInputRef.value?.focus?.());
      },
      closeSessionSwitcher() {
        closeHistoryDrawer();
      },
      isHistoryOpen() {
        return historyOpen.value;
      },
    });

    return {
      store,
      historyOpen,
      sessionSearchQuery,
      sessionSearchInputRef,
      sessionSearchText,
      sessionSearchPending,
      currentProjectTree,
      mergedSessionSearchResults,
      activeSessionProjectPath,
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
      planetLabelForAgent,
      toggleHistoryDrawer,
      closeHistoryDrawer,
      toggleProjectFolder,
      clearSessionSearch,
      onSessionSearchEsc,
      submitSessionSearch,
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
