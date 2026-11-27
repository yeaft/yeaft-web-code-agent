import NavigationIcon from './NavigationIcon.js';
import { alertDialog, confirmDialog } from '../utils/dialog.js';

/**
 * YeaftSidebar — H2.f.6 trimmed.
 *
 * Standalone sidebar component with:
 *   - Groups list (with kebab menu: manage members / rename / delete)
 *   - emits `select-group` on click
 *
 * H2.f.6: thread/merge/fork UI removed alongside the multi-thread engine.
 * The remaining sidebar is a flat single-conversation surface.
 *
 * Tasks tree was removed in the yeaft_feature_message channel cleanup
 * (2026-05-07) — see docs/notes/2026-05-07-feature-message-channel-removal.md.
 *
 * task-yeaft-remove-sidebar-search (2026-05-08): the retired query UI and
 * its helper code are gone; the sidebar is now Groups + Settings.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

import SessionCreateModal from './SessionCreateModal.js';
import CreationCreateModal from './workbench/CreationCreateModal.js';
import SidebarAgentHeader from './SidebarAgentHeader.js';
import SidebarWorkCenter from './SidebarWorkCenter.js';
import SidebarDigitalPerson from './SidebarDigitalPerson.js';
import SessionSidebarShell from './SessionSidebarShell.js';
import UnifiedSessionList from './UnifiedSessionList.js';
import { shortenPath } from '../utils/path-display.js';
import { buildYeaftSidebarSessionList } from '../stores/helpers/yeaft-sidebar-sessions.js';
import { useCreationsStore, formatAgentDisplayName } from '../stores/creations.js';

export default {
  name: 'YeaftSidebar',
  components: { NavigationIcon, SessionCreateModal, CreationCreateModal, SidebarAgentHeader, SidebarWorkCenter, SidebarDigitalPerson, SessionSidebarShell, UnifiedSessionList },
  emits: ['select-group', 'select-chat', 'toggle-sidebar', 'back', 'open-settings', 'open-agent-settings', 'open-group-settings'],
  template: `
    <SessionSidebarShell class="yeaft-sidebar" :collapsed="collapsed">
      <template #collapsed>
      <!-- Collapsed Icon Bar — mirrors Chat's .sidebar-collapsed-bar so the
           sidebar can be re-expanded after collapse instead of disappearing. -->
      <div class="sidebar-collapsed-bar" v-if="collapsed">
        <button class="collapsed-icon-btn" @click="$emit('toggle-sidebar')" :title="tr('chat.sidebar.expand', 'Expand')">
          <NavigationIcon name="menu" :size="18" />
        </button>
        <button v-if="!chatStore?.digitalPersonOpen" class="collapsed-icon-btn" @click="$emit('back')" :title="tr('yeaft.back', 'Back')">
          <NavigationIcon name="back" :size="18" />
        </button>
        <button
          v-if="creationCapableOnlineAgents.length > 0 || sidebarCreations.length > 0"
          type="button"
          class="collapsed-icon-btn sidebar-creations-collapsed-btn"
          :title="tr('creation.sidebar.title', 'Creations')"
          :aria-label="tr('creation.sidebar.title', 'Creations')"
          @click="onCollapsedCreationsClick"
        >✦</button>
        <SidebarDigitalPerson :collapsed="true" />
        <SidebarWorkCenter
          v-if="chatStore?.legacyProductSurfacesEnabled && chatStore.workCenterUiEnabled"
          :agents="chatStore?.agents"
          :active-agent-id="chatStore.workCenterAgentId"
          :collapsed="true"
          @open="onOpenWorkCenter"
        />
        <div class="collapsed-spacer"></div>
        <button class="collapsed-icon-btn" @click="$emit('open-settings')" :title="tr('chat.sidebar.settings', 'Settings')">
          <NavigationIcon name="settings" :size="18" />
        </button>
      </div>
      </template>

      <!-- Sidebar header — reuses Chat sidebar's .sidebar-top /
           .sidebar-header-row / .sidebar-header-actions / .sidebar-icon-btn
           so the two sidebars render pixel-identically. -->
      <div class="sidebar-top">
        <div class="sidebar-header-row">
          <SidebarAgentHeader
            :online-agents="onlineAgents"
            :online-agent-count="onlineAgentCount"
            :restarting-agents="restartingAgents"
            :upgrading-agents="upgradingAgents"
            :show-agent-actions="true"
            :can-upgrade-all="bulkUpgradableAgents.length > 0"
            :upgrading-all="!!chatStore?.agentUpgradeBatch?.pending"
            @open-agent-settings="$emit('open-agent-settings')"
            @restart-agent="restartAgent"
            @upgrade-agent="upgradeAgent"
            @upgrade-all-agents="upgradeAllAgents"
          />
          <div class="sidebar-header-actions">
            <SidebarWorkCenter
              v-if="chatStore?.legacyProductSurfacesEnabled && chatStore.workCenterUiEnabled"
              :agents="chatStore?.agents"
              :active-agent-id="chatStore.workCenterAgentId"
              @open="onOpenWorkCenter"
            />
            <button class="sidebar-icon-btn" :title="tr('chat.sidebar.collapse', 'Collapse')" @click="$emit('toggle-sidebar')">
              <NavigationIcon name="collapse" :size="18" />
            </button>
          </div>
        </div>
      </div>

      <UnifiedSessionList
        :sessions="chatStore?.sidebarSessionCatalog || chatStore?.sessionCatalog || []"
        :loading="chatStore ? (chatStore.sidebarSessionCatalogLoading ?? !chatStore.sessionCatalogLoaded) : false"
        :project-store="chatStore"
        :active-route="chatStore?.activeSessionRoute"
        :is-session-unread="isCatalogSessionUnread"
        :processing-conversations="chatStore?.processingConversations"
        :is-yeaft-session-processing="chatStore?.isYeaftSessionProcessing"
        :agents="chatStore?.agents"
        :work-center-open="chatStore?.workCenterOpen"
        @select="onSelectCatalogSession"
        @create="onUnifiedCreate"
        @create-task="onUnifiedCreateTask"
        @create-in-project="onUnifiedCreateInProject"
        @close-work-center="chatStore?.leaveWorkCenter"
        @action="onUnifiedSessionAction"
      />

      <!-- H2.f.6: merge target picker + irreversible confirm dialog removed. -->

      <!-- Phase 3: unified session create modal.
           fix-session-restore-modal-unify: this modal now ALSO hosts the
           "Restore from disk" panel; the separate SessionRestoreModal
           was deleted in this PR. The user has ONE place to create or
           restore a session for a workdir — matches Chat's
           new-conversation modal. -->
      <SessionCreateModal
        v-if="sessionCreateOpen"
        :task-mode="sessionCreateTaskMode"
        :initial-agent-id="sessionCreateProject?.legacyAgentId || null"
        @close="closeSessionCreate"
        @created="onSessionCreated"
      />

      <CreationCreateModal
        v-if="creationCreateOpen"
        :visible="creationCreateOpen"
        :initial-agent-id="defaultCreationAgentId"
        @close="closeCreationCreate"
        @created="onCreationCreated"
      />

      <!-- Creations collapsible section (Classic sidebar parity) -->
      <section
        v-if="creationCapableOnlineAgents.length > 0 || sidebarCreations.length > 0"
        class="sidebar-creations"
        :aria-label="tr('creation.sidebar.title', 'Creations')"
      >
        <div class="sidebar-creations-header">
          <button
            type="button"
            class="sidebar-creations-toggle"
            :aria-expanded="creationsExpanded ? 'true' : 'false'"
            @click="toggleCreationsSection"
          >
            <svg
              class="sidebar-section-chevron"
              :class="{ collapsed: !creationsExpanded }"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M4.5 6.5L8 10l3.5-3.5" />
            </svg>
            <span class="sidebar-creations-glyph" aria-hidden="true">✦</span>
            <span class="sidebar-creations-label">{{ tr('creation.sidebar.title', 'Creations') }}</span>
            <span class="sidebar-creations-count">{{ sidebarCreations.length }}</span>
          </button>
          <button
            type="button"
            class="sidebar-creations-add-btn"
            :disabled="creationCapableOnlineAgents.length === 0"
            :title="tr('creation.sidebar.new', 'New Creation')"
            :aria-label="tr('creation.sidebar.new', 'New Creation')"
            @click="openCreationCreate"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">
              <path d="M8 3.5v9M3.5 8h9" />
            </svg>
          </button>
        </div>

        <div v-if="creationsExpanded" class="sidebar-creations-list">
          <div v-if="sidebarCreations.length === 0" class="sidebar-creations-empty">
            {{ tr('creation.sidebar.empty', 'No creations yet') }}
          </div>
          <button
            v-for="item in sidebarCreations"
            :key="item.key"
            type="button"
            class="sidebar-creations-item"
            :class="{ active: isCreationActive(item) }"
            :title="item.title"
            @click="onOpenSidebarCreation(item)"
          >
            <span class="sidebar-creations-swatch" :class="'is-' + item.kind" aria-hidden="true"></span>
            <span class="sidebar-creations-title">{{ item.title }}</span>
            <span v-if="showCreationAgentTag && item.agentLabel" class="sidebar-creations-agent">{{ item.agentLabel }}</span>
          </button>
        </div>
      </section>

      <!-- task-yeaft-group-editor: Per-group rename/delete formerly lived
           in inline overlays here. They've been folded into the unified
           SessionSettingsModal — opened via the kebab → unified modal at
           the proper section. YeaftPage owns the modal lifecycle. -->

      <!-- task-342: sidebar bottom — Settings entry + version badge + Cosmos toggle. -->
      <div class="sidebar-bottom">
        <div class="sidebar-bottom-row">
          <button class="sidebar-nav-item" @click="$emit('open-settings')">
            <NavigationIcon name="settings" :size="18" />
            <span>{{ tr('chat.sidebar.settings', 'Settings') }}</span>
            <span v-if="serverVersion" class="sidebar-version">{{ serverVersion }}</span>
          </button>
          <button
            type="button"
            class="sidebar-cosmos-btn"
            :title="tr('cosmos.mode.enter', 'Cosmos UI')"
            :aria-label="tr('cosmos.mode.enter', 'Cosmos UI')"
            @click="chatStore?.setUiMode?.('cosmos')"
          >✦</button>
        </div>
      </div>
    </SessionSidebarShell>
  `,
  props: {
    // task-fix: collapsed flag from parent (YeaftPage). Used to drive
    // the mobile slide-away behavior.
    collapsed: { type: Boolean, default: false },
  },
  data() {
    return {
      now: Date.now(),
      // task-334m: session-create modal visibility.
      // fix-session-restore-modal-unify: this single modal now hosts
      // both "create new" and "restore from disk" — the standalone
      // sessionRestoreOpen flag + SessionRestoreModal are gone.
      sessionCreateOpen: false,
      sessionCreateTaskMode: false,
      sessionCreateProject: null,
      creationsExpanded: false,
      creationCreateOpen: false,
      // task-yeaft-group-editor: per-row action menu only — the rename
      // and delete modals have been folded into the unified
      // SessionSettingsModal owned by YeaftPage.
      groupMenu: { open: false, groupId: null },
      draggedSessionKey: null,
      dragOverSessionKey: null,
      // task-342: server version shown in sidebar-bottom (mirrors ChatPage).
      serverVersion: '',
    };
  },
  created() {
    // task-342: lazily fetch /api/version once; silently swallow failures
    // (unit tests run without a server).
    try {
      if (typeof fetch === 'function') {
        fetch('/api/version')
          .then((r) => r.json())
          .then((d) => { this.serverVersion = (d && d.version) || ''; })
          .catch(() => {});
      }
    } catch (_) { /* no-fetch test env */ }
  },
  mounted() {
    if (this.chatStore?.openUnifiedSessionCreate) {
      this.chatStore.openUnifiedSessionCreate = false;
      this.sessionCreateOpen = true;
    }
    if (this.chatStore?.pendingUnifiedSessionSettings) {
      const pending = this.chatStore.pendingUnifiedSessionSettings;
      this.chatStore.pendingUnifiedSessionSettings = null;
      this.openGroupSettings({ id: pending.sessionId, agentId: pending.agentId }, pending.section || 'session');
    }
    this._agentUpgradeAckHandler = (event) => {
      const { success, error, alreadyLatest, version, reason, currentNode, requiredNode, batchId } = event.detail || {};
      if (batchId) return;
      if (!success) {
        if (reason === 'node_incompatible') {
          alertDialog(this.$t('chat.agent.nodeIncompatible', {
            current: currentNode || '?',
            required: requiredNode || '?',
            version: version || '',
          }));
        } else if (reason === 'container_image_upgrade_required') {
          alertDialog(this.$t('chat.agent.containerImageUpgradeRequired', { version: version || '?' }));
        } else if (reason === 'manual_upgrade_required') {
          alertDialog(this.$t('chat.agent.manualUpgradeRequired', { version: version || '?' }));
        } else {
          alertDialog(`Agent upgrade failed: ${error || 'Unknown error'}`);
        }
      } else if (alreadyLatest) {
        alertDialog(this.$t('chat.agent.alreadyLatest', { version: version || '' }));
      }
    };
    this._agentUpgradeBatchHandler = (event) => this.showAgentUpgradeBatchSummary(event.detail || {});
    if (typeof window !== 'undefined') {
      window.addEventListener('agent-upgrade-ack', this._agentUpgradeAckHandler);
      window.addEventListener('agent-upgrade-batch-complete', this._agentUpgradeBatchHandler);
    }
  },
  beforeUnmount() {
    this.creationsStore?.cancelPendingWorkspaceOpen?.();
    if (typeof window !== 'undefined') {
      window.removeEventListener('agent-upgrade-ack', this._agentUpgradeAckHandler);
      window.removeEventListener('agent-upgrade-batch-complete', this._agentUpgradeBatchHandler);
    }
  },
  computed: {
    // Resolve the Pinia store lazily. Guarded so unit tests that mount
    // the component without Pinia can still exercise the logic via the
    // *Source props.
    store() {
      try {
        if (typeof Pinia !== 'undefined' && Pinia.useChatStore) {
          return Pinia.useChatStore();
        }
      } catch (_) { /* no-pinia test env */ }
      return null;
    },
    // task-334m: groups store lookup (lazy, guarded like `store`).
    sessionsStore() {
      try {
        if (typeof window !== 'undefined' && window.Pinia?.useSessionsStore) {
          return window.Pinia.useSessionsStore();
        }
      } catch (_) { /* no-pinia test env */ }
      return null;
    },
    activeSessionId() {
      return this.chatStore?.yeaftActiveSessionFilter || this.sessionsStore?.activeSessionId || null;
    },
    activeSessionKey() {
      const activeKey = this.sessionsStore?.activeSessionKey || null;
      const activeRow = activeKey ? this.sessionsStore?.sessions?.[activeKey] : null;
      return activeRow?.id === this.activeSessionId ? activeKey : null;
    },
    // Phase 4: chat container removed. Session list is just sessions now.
    sessionList() {
      const rows = buildYeaftSidebarSessionList({
        sessions: this.sessionsStore?.sessionList || [],
        activeSessionId: this.activeSessionId,
        activeSessionKey: this.activeSessionKey,
        pinnedSessionIds: this.chatStore?.pinnedSessions || [],
        onlineAgentIds: Array.isArray(this.onlineAgents)
          ? this.onlineAgents.map(agent => agent.id)
          : undefined,
      });
      const hidden = new Set((this.chatStore?.hiddenSessionCatalog || [])
        .filter(row => row?.runtimeProvider === 'yeaft')
        .map(row => `${row.routeRef?.agentId || ''}\u001f${row.routeRef?.sessionId || ''}`));
      const currentAgentId = this.chatStore?.currentAgent || '';
      return rows.filter(row => !hidden.has(`${row.raw?.agentId || currentAgentId}\u001f${row.id || ''}`));
    },
    restartingAgents() {
      return Object.fromEntries(Object.entries(this.chatStore?.agentOperations || {}).filter(([, value]) => value.restart?.pending));
    },
    upgradingAgents() {
      return Object.fromEntries(Object.entries(this.chatStore?.agentOperations || {}).filter(([, value]) => value.upgrade?.pending));
    },
    bulkUpgradableAgents() {
      const s = this.chatStore || this.store;
      return typeof s?.getUpgradableAgents === 'function' ? s.getUpgradableAgents() : [];
    },
    chatStore() {
      // Needed for `sessionCrudRequest` and the Yeaft session pin menu.
      // Prefer the same global-Pinia path as `store()` so deployments that
      // expose `Pinia.useChatStore` but do not mirror it onto `window.Pinia`
      // still wire the menu actions. Keep the window fallback for tests /
      // older bootstraps that only provide the namespaced object.
      if (this.store) return this.store;
      try {
        if (typeof window !== 'undefined' && window.Pinia?.useChatStore) {
          return window.Pinia.useChatStore();
        }
      } catch (_) {}
      return null;
    },
    // task-341: header-row agent identifier + workbench gate.
    onlineAgents() {
      const s = this.chatStore || this.store;
      if (!s || !Array.isArray(s.agents)) return [];
      return s.agents.filter(a => a && a.online);
    },
    onlineAgentCount() {
      return this.onlineAgents.length;
    },
    workCenterAgents() {
      return this.onlineAgents.filter(agent => Array.isArray(agent.capabilities) && agent.capabilities.includes('work_center'));
    },
    creationsStore() {
      try {
        return useCreationsStore();
      } catch (_) { /* no-pinia test env */ }
      return null;
    },
    creationCapableOnlineAgents() {
      return this.onlineAgents.filter((agent) => {
        if (!agent) return false;
        if (Array.isArray(agent.capabilities)) {
          return agent.capabilities.includes('creations');
        }
        if (agent.capabilities && typeof agent.capabilities === 'object') {
          return agent.capabilities.creations !== false;
        }
        return false;
      });
    },
    defaultCreationAgentId() {
      const current = this.chatStore?.currentAgent || '';
      if (current && this.creationCapableOnlineAgents.some((a) => a.id === current)) {
        return current;
      }
      return this.creationCapableOnlineAgents[0]?.id || current || '';
    },
    sidebarCreations() {
      const cStore = this.creationsStore;
      if (!cStore) return [];
      const rows = [];
      for (const agent of this.onlineAgents) {
        const list = cStore.creationsForAgent?.(agent.id) || cStore.byAgent?.[agent.id]?.list || [];
        const agentLabel = formatAgentDisplayName(agent);
        for (const creation of list) {
          if (!creation || !creation.id || creation.status === 'archived') continue;
          rows.push({
            key: `${agent.id}\u001f${creation.id}`,
            agentId: agent.id,
            agentLabel,
            creation,
            title: creation.title || creation.id,
            kind: creation.kind || 'book',
            sortTs: Number(creation.updatedAt || creation.createdAt || 0),
          });
        }
      }
      rows.sort((a, b) => b.sortTs - a.sortTs);
      return rows;
    },
    showCreationAgentTag() {
      if (this.creationCapableOnlineAgents.length > 1) return true;
      const distinct = new Set(this.sidebarCreations.map((item) => item.agentId));
      return distinct.size > 1;
    },
    currentAgentName() {
      const s = this.chatStore || this.store;
      if (!s || !Array.isArray(s.agents)) return '';
      const id = s.currentAgent;
      if (id) {
        const agent = s.agents.find(a => a && a.id === id);
        if (agent && agent.name) return String(agent.name);
        if (agent && agent.id) return String(agent.id);
      }
      // Fallback: first online agent
      const online = s.agents.find(a => a && a.online);
      if (online) return String(online.name || online.id || '');
      return 'Agent';
    },
    currentAgentOnline() {
      const s = this.chatStore || this.store;
      if (!s || !Array.isArray(s.agents)) return false;
      const id = s.currentAgent;
      if (id) {
        const agent = s.agents.find(a => a && a.id === id);
        if (agent) return !!agent.online;
      }
      return s.agents.some(a => a && a.online);
    },
    agentTitleText() {
      const s = this.chatStore || this.store;
      if (!s || !s.currentAgent) return '';
      return String(s.currentAgent);
    },
    // task-yeaft-remove-sidebar-search: retired query-related computeds
    // and placeholder helpers were removed with the old query UI.
  },
  watch: {
    creationCapableOnlineAgents: {
      immediate: true,
      handler(agents) {
        if (Array.isArray(agents) && agents.length > 0) {
          this.ensureCreationsLoaded();
        }
      },
    },
  },
  methods: {
    ensureCreationsLoaded() {
      const cStore = this.creationsStore;
      if (!cStore || typeof cStore.listCreations !== 'function') return;
      for (const agent of this.creationCapableOnlineAgents) {
        const bucket = cStore.byAgent?.[agent.id];
        if (!bucket?.loaded && !bucket?.loading) {
          cStore.listCreations(agent.id).catch(() => {});
        }
      }
    },
    toggleCreationsSection() {
      this.creationsExpanded = !this.creationsExpanded;
      if (this.creationsExpanded) {
        this.ensureCreationsLoaded();
      }
    },
    onCollapsedCreationsClick() {
      this.creationsExpanded = true;
      this.ensureCreationsLoaded();
      this.$emit('toggle-sidebar');
    },
    openCreationCreate() {
      this.creationsStore?.cancelPendingWorkspaceOpen?.();
      this.creationCreateOpen = true;
    },
    closeCreationCreate() {
      this.creationCreateOpen = false;
    },
    isCreationActive(item) {
      const sessionId = item?.sessionId || item?.creation?.sessionId || null;
      if (!item?.agentId || !sessionId) return false;
      const route = this.chatStore?.activeSessionRoute || null;
      const activeKey = this.sessionsStore?.activeSessionKey || null;
      const activeRow = activeKey ? this.sessionsStore?.sessions?.[activeKey] : null;
      const activeSessionId = route?.sessionId || this.activeSessionId || null;
      const activeAgentId = route?.agentId || activeRow?.agentId || this.chatStore?.currentAgent || null;
      if (!activeAgentId || !activeSessionId) return false;
      return item.agentId === activeAgentId && sessionId === activeSessionId;
    },
    async onOpenSidebarCreation(item) {
      if (!item?.agentId || !item?.creation?.id) return;
      const cStore = this.creationsStore;
      if (!cStore || typeof cStore.openCreationInClassic !== 'function') return;
      cStore.cancelPendingWorkspaceOpen?.();
      try {
        await cStore.openCreationInClassic({
          agentId: item.agentId,
          creationId: item.creation.id,
          mode: 'studio',
        });
      } catch (err) {
        await alertDialog(err?.message || this.tr('creation.create.failed', 'Failed to open Creation'));
      }
    },
    async onCreationCreated(payload) {
      this.closeCreationCreate();
      this.creationsExpanded = true;
      const creation = payload?.creation;
      const agentId = payload?.agentId;
      if (!agentId || !creation?.id) return;
      const cStore = this.creationsStore;
      if (!cStore || typeof cStore.openCreationInClassic !== 'function') return;
      cStore.cancelPendingWorkspaceOpen?.();
      try {
        await cStore.openCreationInClassic({
          agentId,
          creationId: creation.id,
          mode: 'studio',
          sessionId: payload?.sessionId || creation.sessionId,
          rootDir: payload?.rootDir || creation.rootDir,
          initialPrompt: payload?.prompt || '',
        });
      } catch (err) {
        await alertDialog(err?.message || this.tr('creation.create.failed', 'Failed to open Creation'));
      }
    },
    // task-341: i18n lookup for keys outside the yeaft.sidebar namespace.
    tr(fullKey, fallback) {
      if (typeof this.$t === 'function') {
        const v = this.$t(fullKey);
        if (v && v !== fullKey) return v;
      }
      return fallback;
    },
    isSessionProcessing(sessionId, agentId = null) {
      const s = this.chatStore || this.store;
      if (!s || !sessionId) return false;
      return typeof s.isYeaftSessionProcessing === 'function'
        ? s.isYeaftSessionProcessing(sessionId, agentId)
        : false;
    },
    isCatalogSessionUnread(row) {
      if (row?.runtimeProvider !== 'yeaft') return false;
      const s = this.chatStore || this.store;
      if (!s || typeof s.isYeaftSessionUnread !== 'function') return false;
      return s.isYeaftSessionUnread(row.routeRef?.sessionId, row.routeRef?.agentId);
    },
    onModeFlip(target) {
      // Only 'chat' is reachable from here — 'yeaft' is a no-op because
      // we're already in the Yeaft view when this sidebar is mounted.
      if (target === 'chat') {
        this.$emit('back');
      }
    },
    onOpenWorkCenter(agentId = null) {
      const s = this.chatStore || this.store;
      const target = this.workCenterAgents.find(agent => agent.id === agentId)
        || this.workCenterAgents.find(agent => agent.id === s?.workCenterAgentId)
        || this.workCenterAgents[0];
      if (s && typeof s.enterWorkCenter === 'function') s.enterWorkCenter(target?.id || null);
    },
    async restartAgent(agentId) {
      const s = this.chatStore || this.store;
      if (!s || typeof s.restartAgent !== 'function') return;
      const agent = s.agents?.find(candidate => candidate?.id === agentId);
      const name = agent?.name || agentId;
      if (!await confirmDialog(this.$t('chat.agent.restartConfirm', { name }))) return;
      s.restartAgent(agentId);
    },
    async upgradeAgent(agentId) {
      const s = this.chatStore || this.store;
      if (!s || typeof s.upgradeAgent !== 'function') return;
      const agent = s.agents?.find(candidate => candidate?.id === agentId);
      const name = agent?.name || agentId;
      if (!await confirmDialog(this.$t('chat.agent.upgradeConfirm', { name }))) return;
      s.upgradeAgent(agentId);
    },
    async upgradeAllAgents() {
      const s = this.chatStore || this.store;
      const candidates = this.bulkUpgradableAgents;
      if (!s || candidates.length === 0) return;
      const skipped = Math.max(0, (s.agents || []).length - candidates.length);
      if (!await confirmDialog(this.$t('chat.agent.upgradeAllConfirm', { count: candidates.length, skipped }))) return;
      s.upgradeAllAgents();
    },
    showAgentUpgradeBatchSummary(batch) {
      const results = Object.values(batch?.results || {});
      const upgraded = results.filter(result => result.status === 'upgraded').length;
      const latest = results.filter(result => result.status === 'already_latest').length;
      const failed = results.filter(result => result.status === 'failed').length;
      alertDialog(this.$t('chat.agent.upgradeAllSummary', { upgraded, latest, failed, skipped: batch?.skippedCount || 0 }));
    },
    // task-334m: session-create + selection handlers.
    onGroupCreated(_group) {
      // Store auto-activates via applyCrudResult; modal closes itself.
    },
    // Phase 3: unified session create — single entry point users see.
    // fix-session-restore-modal-unify: this same modal now hosts the
    // "Restore from disk" panel, so onOpenSessionRestore +
    // onSessionRestored are gone (folded into SessionCreateModal's own
    // `created` flow).
    onUnifiedCreateTask() {
      this.onOpenSessionCreate();
      this.sessionCreateTaskMode = true;
    },
    onOpenSessionCreate() {
      this.creationsStore?.cancelPendingWorkspaceOpen?.();
      this.sessionCreateTaskMode = false;
      this.sessionCreateProject = null;
      this.sessionCreateOpen = true;
    },
    onUnifiedCreate() { this.onOpenSessionCreate(); },
    onUnifiedCreateInProject({ project, taskMode = false } = {}) {
      if (!project?.id) return;
      this.creationsStore?.cancelPendingWorkspaceOpen?.();
      this.sessionCreateTaskMode = taskMode === true;
      this.sessionCreateProject = project;
      this.sessionCreateOpen = true;
    },
    closeSessionCreate() {
      this.sessionCreateOpen = false;
      this.sessionCreateProject = null;
    },
    async onUnifiedSessionAction({ action, row, title, sessions } = {}) {
      if (!row?.routeRef) return;
      const s = this.chatStore || this.store;
      const { runtimeProvider, agentId, sessionId } = row.routeRef;
      if (action === 'rename') {
        s?.renameCatalogSession?.({ row, title });
      } else if (action === 'reorder') {
        s?.reorderCatalogSessions?.(sessions);
      } else if (action === 'pin') {
        s?.toggleCatalogSessionPin?.(row);
      } else if (runtimeProvider === 'yeaft' && action === 'merge') {
        s.openSessionMerge(row);
      } else if (runtimeProvider === 'yeaft' && action === 'copy') {
        const result = await s?.copyCatalogSession?.(row);
        if (!result?.ok) {
          const code = result?.error?.code || 'unknown';
          const key = `yeaft.session.error.${code}`;
          const translated = this.$t(key);
          const message = translated === key ? (result?.error?.message || code) : translated;
          await alertDialog(this.$t('yeaft.session.copyFailed', { message }));
        }
      } else if (runtimeProvider === 'yeaft' && action === 'settings') {
        this.openGroupSettings({ id: sessionId, agentId }, 'session');
      } else if (action === 'remove') {
        s?.hideCatalogSession?.(row);
      }
    },
    async onSessionCreated(session) {
      this.creationsStore?.cancelPendingWorkspaceOpen?.();
      const project = this.sessionCreateProject;
      this.closeSessionCreate();
      if (!project || !session?.id) return;
      const store = this.chatStore || this.store;
      const agentId = session.agentId || project.legacyAgentId || store?.currentAgent || null;
      const result = await store?.mutateProject?.('move_session', {
        sessionId: session.id,
        projectId: project.legacyProjectId || project.id,
      }, agentId);
      if (!result?.ok) {
        const message = result?.error?.message || result?.error?.code || 'unknown';
        await alertDialog(this.$t('sidebar.projects.assignFailed', { name: project.name, message }));
      }
    },
    onSelectCatalogSession(row) {
      this.creationsStore?.cancelPendingWorkspaceOpen?.();
      return this.chatStore?.openCatalogSession(row);
    },
    onSelectGroup(g) {
      if (!g || !g.id) return;
      this.creationsStore?.cancelPendingWorkspaceOpen?.();
      const activeStore = this.chatStore || this.store;
      if (activeStore && typeof activeStore.leaveWorkCenter === 'function') activeStore.leaveWorkCenter();
      // Cross-agent routing: when selecting a session owned by an agent
      // other than the currently-selected one, switch the chat store's
      // active agent so subsequent CRUD/messaging hits the owning agent.
      // Go through the store action (not bare assignment) so any side
      // effects in selectAgent (caches, subscriptions) stay in sync.
      if (g.agentId && this.chatStore && this.chatStore.currentAgent !== g.agentId) {
        if (typeof this.chatStore.selectAgent === 'function') {
          this.chatStore.selectAgent(g.agentId);
        } else {
          this.chatStore.currentAgent = g.agentId;
        }
      }
      if (this.sessionsStore) this.sessionsStore.setActive(g.id, g.agentId || null);
      this.$emit('select-group', g);
    },
    sessionDragKey(g) {
      if (!g || !g.id) return '';
      return g.agentId ? `${g.agentId}\u001f${g.id}` : `legacy\u001f${g.id}`;
    },
    onSessionDragStart(g, evt) {
      const key = this.sessionDragKey(g);
      if (!key) return;
      this.groupMenu = { open: false, groupId: null };
      this.draggedSessionKey = key;
      this.dragOverSessionKey = null;
      if (evt?.dataTransfer) {
        evt.dataTransfer.effectAllowed = 'move';
        evt.dataTransfer.setData('text/plain', key);
      }
    },
    onSessionDragOver(g, evt) {
      const key = this.sessionDragKey(g);
      if (!key || !this.draggedSessionKey || key === this.draggedSessionKey) return;
      this.dragOverSessionKey = key;
      if (evt?.dataTransfer) evt.dataTransfer.dropEffect = 'move';
    },
    onSessionDragLeave(g, evt) {
      const key = this.sessionDragKey(g);
      if (!key || this.dragOverSessionKey !== key) return;
      const next = evt?.relatedTarget;
      if (next && evt?.currentTarget?.contains && evt.currentTarget.contains(next)) return;
      this.dragOverSessionKey = null;
    },
    onSessionDrop(g, evt) {
      const fromKey = this.draggedSessionKey || evt?.dataTransfer?.getData?.('text/plain') || null;
      const toKey = this.sessionDragKey(g);
      this.draggedSessionKey = null;
      this.dragOverSessionKey = null;
      if (!fromKey || !toKey || fromKey === toKey) return;
      this.reorderSessionRows(fromKey, toKey);
    },
    onSessionDragEnd() {
      this.draggedSessionKey = null;
      this.dragOverSessionKey = null;
    },
    reorderSessionRows(fromKey, toKey) {
      const keys = this.sessionList.map(row => this.sessionDragKey(row.raw)).filter(Boolean);
      const fromIndex = keys.indexOf(fromKey);
      const toIndex = keys.indexOf(toKey);
      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;
      const [moved] = keys.splice(fromIndex, 1);
      keys.splice(toIndex, 0, moved);
      const ordered = this.sessionsStore?.reorderSessionsGlobally?.(keys) || [];
      const request = this.chatStore?.sessionCrudRequest;
      if (typeof request === 'function') {
        request.call(this.chatStore, 'reorder', { sessions: ordered });
      }
    },
    // Per-row agent badge — mirrors chat session rows.
    sessionAgentName(g) {
      if (!g || !g.agentId) return '';
      const s = this.chatStore || this.store;
      if (!s || !Array.isArray(s.agents)) return String(g.agentName || g.agentId || '');
      const agent = s.agents.find(a => a && a.id === g.agentId);
      return String(agent?.name || g.agentName || g.agentId || '');
    },
    // Path subtitle for parity with chat rows. Do not fall back to member
    // count; users need workDir + agent here.
    groupPath(g) {
      return shortenPath(g?.workDir);
    },
    // task-yeaft-group-editor: each session row opens the unified
    // SessionSettingsModal (session / members / memory). The row settings
    // action lands on the combined Session page; legacy callers can still
    // pass old announcement / rename / danger section aliases and the modal
    // maps them to Session. YeaftPage owns the modal lifecycle.
    openGroupSettings(g, section = 'members') {
      if (!g || !g.id) return;
      this.$emit('open-group-settings', { sessionId: g.id, agentId: g.agentId || null, section });
    },
    // Convenience wrapper used by the kebab menu items: closes the menu
    // first so the unified modal opens cleanly without the kebab still
    // hovering above it.
    openGroupSettingsFromMenu(g, section) {
      this.groupMenu = { open: false, groupId: null };
      this.openGroupSettings(g, section);
    },
    // fix-yeaft-session-list-and-menu: kebab-menu helpers for pin + remove.
    // These mirror chat sidebar's row action menu (pin / settings / close)
    // so yeaft users get the same "operate on the session row" shape
    // instead of the previous 4-button modal-shortcut menu.
    //
    // isSessionPinned primarily reads the row metadata used by this sidebar,
    // then falls back to chatStore.pinnedSessions — the same registry chat uses.
    // Server snapshots keep both sources in sync, but row metadata must remain
    // enough for the menu label if a partial refresh races the shared cache.
    isSessionPinned(sessionOrId) {
      const id = sessionOrId && typeof sessionOrId === 'object' ? sessionOrId.id : sessionOrId;
      const hasRowPin = !!(sessionOrId && typeof sessionOrId === 'object' && Object.prototype.hasOwnProperty.call(sessionOrId, 'pinned'));
      const rowPinned = !!(hasRowPin && sessionOrId.pinned);
      if (hasRowPin && sessionOrId.agentId) return rowPinned;
      const fn = this.chatStore && this.chatStore.isSessionPinned;
      return rowPinned || (typeof fn === 'function' ? !!fn.call(this.chatStore, id) : false);
    },
    // Pin/unpin toggle. Closes the menu first so the row's animated
    // reorder isn't visually obscured by the open kebab.
    onTogglePin(g) {
      this.groupMenu = { open: false, groupId: null };
      if (!g || !g.id) return;
      const fn = this.chatStore && this.chatStore.togglePin;
      if (typeof fn === 'function') {
        fn.call(this.chatStore, g.id, {
          sessionKind: 'yeaft',
          agentId: g.agentId || this.store?.currentAgent || null,
          sessionName: g.name || g.title || g.id,
          workDir: g.workDir || '',
          pinned: !!g.pinned,
        });
      }
    },
    // "Remove from list" only hides the Session from this user's sidebar.
    // It intentionally does not call the Agent archive/delete APIs: the
    // on-disk Session and its messages must stay available for re-adding.
    onRemoveFromList(g) {
      this.groupMenu = { open: false, groupId: null };
      if (!g || !g.id) return;
      const agentId = g.agentId || this.chatStore?.currentAgent || null;
      if (!agentId || typeof this.chatStore?.hideCatalogSession !== 'function') return;
      const catalogKey = `yeaft:${agentId}:${g.id}`;
      const row = this.chatStore.sessionCatalog?.find(item => item.catalogKey === catalogKey) || {
        catalogKey,
        runtimeProvider: 'yeaft',
        routeRef: { runtimeProvider: 'yeaft', agentId, sessionId: g.id },
        title: g.name || g.id,
        workDir: g.workDir || '',
        agentName: this.sessionAgentName(g),
        availability: this.onlineAgents.some(agent => agent.id === agentId) ? 'online' : 'offline',
        pinned: !!g.pinned,
      };
      this.chatStore.hideCatalogSession(row);
    },
    groupDisplayName(g) {
      if (!g) return '';
      // D1 seed sentinel: replace raw 'Default' on grp_default with i18n label.
      if (g.id === 'grp_default' && (g.name === 'Default' || !g.name)) {
        return this.$t('yeaft.session.defaultName');
      }
      return g.name || g.id || '';
    },
    // Relative time for the row's right-aligned timestamp (mirrors ChatPage's
    // getConversationTime). Yeaft groups only expose createdAt today; later
    // we'll surface lastMessageAt from group activity once the engine stores it.
    groupTime(g) {
      const ts = g && g.createdAt ? g.createdAt : null;
      if (!ts) return '';
      const date = new Date(ts);
      const now = new Date();
      const diff = now - date;
      if (diff < 60_000) return this.$t('chat.time.justNow');
      if (diff < 3_600_000) return this.$t('chat.time.minutesAgo', { count: Math.floor(diff / 60_000) });
      if (date.toDateString() === now.toDateString()) {
        return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      }
      return date.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
    },
    // Subtitle line (parity with .session-info / .session-path). For Yeaft
    // groups we surface roster size, e.g. "2 members" or "Empty".
    groupSubtitle(g) {
      if (!g) return '';
      const n = Array.isArray(g.roster) ? g.roster.length : 0;
      if (n === 0) return this.$t('yeaft.session.empty.title');
      const key = n === 1 ? 'yeaft.session.memberCount.one' : 'yeaft.session.memberCount.other';
      return this.$t(key, { count: n });
    },
    // task-334m prev-2 rev: per-row kebab + rename/delete wiring.
    openGroupMenu(g, evt) {
      if (!g || !g.id) return;
      // Toggle when clicking the same row again.
      const menuKey = this.sessionDragKey(g);
      if (!menuKey) return;
      if (this.groupMenu.open && this.groupMenu.groupId === menuKey) {
        this.groupMenu = { open: false, groupId: null };
        return;
      }
      this.groupMenu = { open: true, groupId: menuKey };
      // Close on next outside click.
      const close = (ev) => {
        if (ev && ev.target && ev.target.closest && ev.target.closest('.session-menu')) return;
        this.groupMenu = { open: false, groupId: null };
        window.removeEventListener('click', close, true);
      };
      setTimeout(() => window.addEventListener('click', close, true), 0);
      if (evt && typeof evt.stopPropagation === 'function') evt.stopPropagation();
    },
    // task-yeaft-group-editor: per-group rename/delete + manage-members
    // formerly lived as discrete startManageMembers/startRenameGroup/
    // startDeleteGroup methods that mounted inline overlays. They've
    // all been folded into the unified SessionSettingsModal opened via
    // openGroupSettingsFromMenu(g, section) above. YeaftPage owns the
    // modal lifecycle.
    // H2.f.6: thread display / tooltip / link / fork helpers removed.
    // H2.f.7 (2026-05-07): tasks tree removed; isTaskExpanded/toggleTask
    // dropped along with the rendered section.
    // task-yeaft-remove-sidebar-search (2026-05-08): the search box,
    // its results list, and the helpers it required (onSelectResult,
    // onSearchEscape, pickTaskSnippet, truncate) have all been removed.
    // H2.f.6: merge / fork flows retired with the multi-thread model.
  }
};
