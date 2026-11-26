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
import CosmosComposerTuning from './CosmosComposerTuning.js';
import {
  SESSION_SCENE_IDS,
  sessionScenesForAgent,
  displaySessionScene,
} from '../SessionSceneSelect.js';
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
    CosmosComposerTuning,
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
          <!-- Filtered + Full-Text Discovery Results (Current Planet / Agent Only) -->
          <template v-if="sessionSearchText">
            <button
              v-for="hit in mergedSessionSearchResults"
              :key="hit.key"
              type="button"
              class="cosmos-history-row cosmos-history-search-hit"
              :class="{ 'is-active': isSessionSelected(hit.session) }"
              @click="pickSession(agent.id, hit.session)"
            >
              <div class="cosmos-history-hit-top">
                <span class="cosmos-history-row-left">
                  <span class="cosmos-status-pip" :class="hit.session.status"></span>
                  <span class="cosmos-history-row-title">{{ hit.session.title }}</span>
                </span>
                <span class="cosmos-history-row-meta">{{ hit.session.updatedLabel }}</span>
              </div>
              <div v-if="hit.session.projectPath" class="cosmos-history-hit-tags">
                <span class="cosmos-history-project-pill">
                  <svg viewBox="0 0 20 24" aria-hidden="true"><path d="M2.5 7.5a2 2 0 0 1 2-2h4l1.8 2H15.5a2 2 0 0 1 2 2V18h-15z"/></svg>
                  <span>{{ hit.session.projectPath }}</span>
                </span>
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

          <!-- Current Planet Project Folder Tree + Ungrouped Sessions -->
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
              class="cosmos-drawer-input cosmos-composer-surface"
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
              <template #actions-end-before>
                <CosmosComposerTuning
                  v-if="isYeaftView && (modelRows.length > 0 || showDrawerScene)"
                  ref="tuningRef"
                  :model-rows="modelRows"
                  :active-model="activeModel"
                  :active-model-label="activeModelLabel"
                  :effort-options="effortOptions"
                  :active-effort="activeEffort"
                  :show-scene="showDrawerScene"
                  :scene-options="drawerSceneOptions"
                  :active-scene="displayedDrawerScene"
                  default-scene-id="general"
                  :scene-disabled="drawerSceneDisabled"
                  :scene-busy="Boolean(pendingDrawerScene)"
                  :scene-error="drawerSceneError"
                  :scope-key="composerDraftKey"
                  @select-model="onSelectModel"
                  @select-effort="selectEffort"
                  @select-scene="selectDrawerScene"
                  @open-llm-config="$emit('open-llm-config', agent.id)"
                />
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
    const historyOpen = Vue.ref(false);
    const sessionSearchQuery = Vue.ref('');
    const sessionSearchInputRef = Vue.ref(null);
    const sessionSearchPending = Vue.ref(false);
    const sessionDiscoveryResponses = Vue.ref([]);
    const collapsedProjectIds = Vue.ref(new Set());
    let sessionSearchTimer = null;
    let sessionSearchController = null;
    let sessionDiscoveryGeneration = 0;

    const searchOpen = Vue.ref(false);
    const searchActiveMessageId = Vue.ref('');
    const historySearchQuery = Vue.ref('');
    const historySearchRef = Vue.ref(null);
    let historySearchTimer = null;
    let stopLoadOlderWatch = null;
    const tuningRef = Vue.ref(null);
    const requestedScene = Vue.ref('');
    const unconfirmedScene = Vue.ref('');
    const sceneErrorKey = Vue.ref('');
    let sceneUpdateSeq = 0;
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

    const drawerAgentModels = Vue.computed(() => {
      const cfg = props.agent?.id ? store.llmConfig?.[props.agent.id] : null;
      const list = cfg?.agentConfig?.availableModels ?? cfg?.effectiveConfig?.availableModels;
      if (Array.isArray(list) && list.length > 0) return list;
      if (props.agent?.id && props.agent.id === store.currentAgent && Array.isArray(store.yeaftAvailableModels)) {
        return store.yeaftAvailableModels;
      }
      return [];
    });

    const drawerDefaultModel = Vue.computed(() => {
      const cfg = props.agent?.id ? store.llmConfig?.[props.agent.id] : null;
      const cfgPrimary = cfg?.agentConfig?.primaryModel || cfg?.effectiveConfig?.primaryModel || '';
      if (cfgPrimary) return cfgPrimary;
      if (props.agent?.id && props.agent.id === store.currentAgent) return store.yeaftModel || '';
      return '';
    });

    const drawerDefaultEffort = Vue.computed(() => {
      const cfg = props.agent?.id ? store.llmConfig?.[props.agent.id] : null;
      const cfgEffort = cfg?.agentConfig?.defaultEffort || cfg?.effectiveConfig?.defaultEffort || '';
      if (cfgEffort) return cfgEffort;
      if (props.agent?.id && props.agent.id === store.currentAgent) return store.yeaftModelEffort || '';
      return '';
    });

    const modelRows = Vue.computed(() => buildModelSelectionRows(drawerAgentModels.value));
    const activeModel = Vue.computed(() => resolveSessionModelRef(activeGroup.value, drawerDefaultModel.value));
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
      drawerDefaultEffort.value,
      activeModelMeta.value,
    ));

    const showDrawerScene = Vue.computed(() => Boolean(isYeaftView.value && ordinarySession.value && activeGroup.value));

    const drawerSceneIds = Vue.computed(() => {
      if (!activeGroup.value) return [];
      const offered = sessionScenesForAgent(
        (capability) => store.hasAgentCapability?.(props.agent?.id, capability),
      );
      return SESSION_SCENE_IDS.filter(
        (sceneId) => offered.includes(sceneId) || sceneId === activeGroup.value?.sceneId,
      );
    });

    const drawerSceneOptions = Vue.computed(() => drawerSceneIds.value.map((sceneId) => {
      const key = `yeaft.session.scene.${sceneId}`;
      const translated = $t(key);
      return { id: sceneId, label: translated === key ? sceneId : translated };
    }));

    const pendingDrawerScene = Vue.computed(() => {
      if (!activeGroup.value) return '';
      return requestedScene.value
        || store.pendingSessionSceneSelectionFor?.(activeGroup.value.id, props.agent?.id)
        || '';
    });

    const displayedDrawerScene = Vue.computed(() => (
      pendingDrawerScene.value || displaySessionScene(activeGroup.value)
    ));

    const drawerSceneDisabled = Vue.computed(() => (
      store.connectionState !== 'connected'
      || store.hasAgentCapability?.(props.agent?.id, 'session_scenes') === false
    ));

    const drawerSceneError = Vue.computed(() => (
      sceneErrorKey.value ? $t(`yeaft.session.scene.${sceneErrorKey.value}`) : ''
    ));

    // Strictly scoped to the active planet's Agent (never cross-planet)
    const currentAgentScope = Vue.computed(() => (props.agent ? [props.agent] : []));

    const planetLabelByAgentId = Vue.computed(() => {
      if (!props.agent?.id) return {};
      const pid = props.agentToPlanet?.[props.agent.id] || props.planetId || '';
      return pid ? { [props.agent.id]: $t(`cosmos.planets.${pid}.name`) } : {};
    });

    const sessionSearchText = Vue.computed(() => (
      historyOpen.value ? sessionSearchQuery.value.trim() : ''
    ));

    const discoveryAgentId = Vue.computed(() => {
      const aid = props.agent?.id;
      if (!aid || store.sessionDiscoverySupported !== true || store.connectionState !== 'connected') return null;
      const rawAgents = Array.isArray(store.agents) ? store.agents : [];
      const match = rawAgents.find((a) => a?.id === aid && a.online && supportsSessionDiscovery(a));
      return match ? aid : null;
    });

    const agentDeletionEpochKey = Vue.computed(() => {
      const map = store.yeaftTurnDeleteHistoryBySession;
      const aid = props.agent?.id;
      if (!map || !aid) return '';
      const parts = [];
      for (const [key, deletion] of Object.entries(map)) {
        if (deletion?.agentId === aid) {
          parts.push(`${key}:${deletion.epoch ?? 0}`);
        }
      }
      parts.sort();
      return parts.join('|');
    });

    const localSessionSearchHits = Vue.computed(() => (
      filterCosmosSessions(currentAgentScope.value, sessionSearchText.value, {
        planetLabelByAgentId: planetLabelByAgentId.value,
      })
    ));

    const canonicalSessionKey = (agentId, session) => (
      session?.catalogKey
      || `${agentId}\u001f${session?.runtimeProvider || 'yeaft'}\u001f${session?.id || ''}`
    );

    const mergedSessionSearchResults = Vue.computed(() => {
      if (!sessionSearchText.value || !props.agent?.id) return [];
      const currentAgentId = props.agent.id;
      const byKey = new Map();
      const ordered = [];

      // FTS session_discovery returns native Yeaft sessions only; never join onto CLI rows.
      const nativeYeaftBySessionId = new Map();
      for (const s of (props.agent.sessions || [])) {
        if (s?.runtimeProvider === 'yeaft' && s.id) {
          nativeYeaftBySessionId.set(s.id, s);
        }
      }

      for (const hit of localSessionSearchHits.value) {
        if (hit.agent.id !== currentAgentId) continue;
        const k = canonicalSessionKey(currentAgentId, hit.session);
        if (byKey.has(k)) continue;
        const entry = {
          key: k,
          agent: hit.agent,
          session: hit.session,
          snippet: '',
        };
        byKey.set(k, entry);
        ordered.push(entry);
      }

      const ftsRows = [];
      for (const resp of sessionDiscoveryResponses.value) {
        if (resp?.agentId !== currentAgentId) continue;
        const results = Array.isArray(resp.results) ? resp.results : [];
        results.forEach((hit, rank) => {
          if (!hit?.sessionId) return;
          const nativeSession = nativeYeaftBySessionId.get(hit.sessionId);
          if (!nativeSession) return;
          const k = canonicalSessionKey(currentAgentId, nativeSession);
          const snippet = typeof hit.snippet === 'string' ? hit.snippet.trim() : '';
          if (byKey.has(k)) {
            const existing = byKey.get(k);
            if (!existing.snippet && snippet) existing.snippet = snippet;
            return;
          }
          ftsRows.push({
            k,
            rank,
            updatedAt: nativeSession.updatedAt || 0,
            entry: {
              key: k,
              agent: props.agent,
              session: nativeSession,
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
      sessionDiscoveryGeneration += 1;
      if (sessionSearchTimer) {
        clearTimeout(sessionSearchTimer);
        sessionSearchTimer = null;
      }
      sessionSearchController?.abort();
      sessionSearchController = null;
      sessionDiscoveryResponses.value = [];
      sessionSearchPending.value = false;
    }

    async function runSessionDiscoverySearch(generation) {
      const query = sessionSearchText.value;
      const agentId = discoveryAgentId.value;
      if (!query || !agentId || generation !== sessionDiscoveryGeneration) {
        if (generation === sessionDiscoveryGeneration) sessionSearchPending.value = false;
        return;
      }
      const controller = new AbortController();
      const { signal } = controller;
      sessionSearchController = controller;
      try {
        const data = await requestSessionDiscovery(store, agentId, 'search', { query }, signal);
        if (!signal.aborted && generation === sessionDiscoveryGeneration
            && props.agent?.id === agentId && Array.isArray(data?.results)) {
          sessionDiscoveryResponses.value = [{ agentId, results: data.results }];
        }
      } catch {
        // Local title/project hits remain visible even if FTS is unavailable or aborted.
      } finally {
        if (!signal.aborted && generation === sessionDiscoveryGeneration) {
          sessionSearchPending.value = false;
        }
      }
    }

    function queueSessionDiscoverySearch(delay = SESSION_SEARCH_DEBOUNCE_MS) {
      cancelSessionDiscoverySearch();
      if (!sessionSearchText.value || !discoveryAgentId.value) return;
      const generation = sessionDiscoveryGeneration;
      sessionSearchPending.value = true;
      sessionSearchTimer = setTimeout(() => {
        sessionSearchTimer = null;
        void runSessionDiscoverySearch(generation);
      }, delay);
    }

    Vue.watch(
      () => [sessionSearchText.value, discoveryAgentId.value, store.ws],
      () => {
        queueSessionDiscoverySearch();
      },
    );

    Vue.watch(
      agentDeletionEpochKey,
      (next, prev) => {
        if (next === prev || !sessionSearchText.value) return;
        queueSessionDiscoverySearch(0);
      },
    );

    Vue.watch(
      () => props.agent?.id,
      (next, prev) => {
        if (next === prev) return;
        sessionSearchQuery.value = '';
        cancelSessionDiscoverySearch();
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
        sceneUpdateSeq += 1;
        requestedScene.value = '';
        unconfirmedScene.value = '';
        sceneErrorKey.value = '';
        tuningRef.value?.close?.(false);
      },
    );

    Vue.watch(
      () => activeGroup.value?.sceneId,
      (sceneId) => {
        if (sceneId && sceneId === unconfirmedScene.value) {
          unconfirmedScene.value = '';
          sceneErrorKey.value = '';
        }
      },
    );

    Vue.watch(
      () => workbenchOpen.value || historyOpen.value || searchOpen.value,
      (overlayActive) => {
        if (overlayActive) tuningRef.value?.close?.(false);
      },
    );

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
    }

    function onSelectModel({ modelRef, defaultEffort }) {
      selectModel(modelRef, defaultEffort);
    }

    function selectEffort(effort) {
      if (!effortOptions.value.includes(effort) || !activeModel.value) return;
      void applyModel(activeModel.value, effort);
    }

    async function selectDrawerScene(sceneId) {
      const targetGroup = activeGroup.value;
      const targetAgentId = props.agent?.id;
      if (!targetGroup || !targetAgentId || drawerSceneDisabled.value || pendingDrawerScene.value) return;
      if (!drawerSceneIds.value.includes(sceneId)) return;
      if (sceneId === targetGroup.sceneId) return;
      const targetSessionId = targetGroup.id;
      const updateSeq = ++sceneUpdateSeq;
      sceneErrorKey.value = '';
      unconfirmedScene.value = '';
      requestedScene.value = sceneId;
      try {
        const result = await store.updateYeaftSessionScene?.(targetSessionId, sceneId, targetAgentId);
        const stillSameSession = updateSeq === sceneUpdateSeq
          && activeGroup.value?.id === targetSessionId
          && props.agent?.id === targetAgentId;
        if (!stillSameSession || result?.ok) return;
        if (result?.error?.code === 'scene_unconfirmed') {
          if (activeGroup.value?.sceneId !== sceneId) {
            unconfirmedScene.value = sceneId;
            sceneErrorKey.value = 'unconfirmed';
          }
        } else {
          sceneErrorKey.value = 'updateError';
        }
      } catch {
        if (updateSeq === sceneUpdateSeq
            && activeGroup.value?.id === targetSessionId
            && props.agent?.id === targetAgentId) {
          sceneErrorKey.value = 'updateError';
        }
      } finally {
        if (updateSeq === sceneUpdateSeq) requestedScene.value = '';
      }
    }

    function sendYeaftMessage(text, attachmentInfos, quote, quickSend) {
      const groupId = store.yeaftActiveSessionFilter || sessionsStore?.activeSessionId;
      if (!groupId) return false;
      tuningRef.value?.close?.(false);
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

    Vue.onBeforeUnmount(() => {
      clearSearchTimers();
      cancelSessionDiscoverySearch();
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
      tuningRef,
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
      showDrawerScene,
      drawerSceneOptions,
      pendingDrawerScene,
      displayedDrawerScene,
      drawerSceneDisabled,
      drawerSceneError,
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
      selectModel,
      onSelectModel,
      selectEffort,
      selectDrawerScene,
      sendYeaftMessage,
      cancelYeaft,
      setMessageQuote,
      editMessageAsNew,
    };
  },
};
