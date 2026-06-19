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
import SidebarModeToggle from './SidebarModeToggle.js';
import SidebarAgentHeader from './SidebarAgentHeader.js';
import { shortenPath } from '../utils/path-display.js';
import { buildYeaftSidebarSessionList } from '../stores/helpers/yeaft-sidebar-sessions.js';

export default {
  name: 'YeaftSidebar',
  components: { SessionCreateModal, SidebarModeToggle, SidebarAgentHeader },
  emits: ['select-group', 'select-chat', 'toggle-sidebar', 'back', 'open-settings', 'open-group-settings'],
  template: `
    <aside class="yeaft-sidebar" :class="{ collapsed: collapsed }">
      <!-- Collapsed Icon Bar — mirrors Chat's .sidebar-collapsed-bar so the
           sidebar can be re-expanded after collapse instead of disappearing. -->
      <div class="sidebar-collapsed-bar" v-if="collapsed">
        <button class="collapsed-icon-btn" @click="$emit('toggle-sidebar')" :title="tr('chat.sidebar.expand', 'Expand')">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>
        </button>
        <button class="collapsed-icon-btn" @click="$emit('back')" :title="tr('yeaft.back', 'Back')">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
        </button>
        <button v-if="canUseWorkbench" class="collapsed-icon-btn" :class="{ active: chatStore && chatStore.workbenchExpanded }" @click="onToggleWorkbench" :title="tr('chat.sidebar.workbench', 'Workbench')">
          <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M20 3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H4V5h16v14zM6 7h5v2H6V7zm0 4h5v2H6v-2zm0 4h5v2H6v-2zm7-8h5v10h-5V7z"/></svg>
        </button>
        <div class="collapsed-spacer"></div>
        <button class="collapsed-icon-btn" @click="$emit('open-settings')" :title="tr('chat.sidebar.settings', 'Settings')">
          <svg viewBox="0 0 24 24" width="18" height="18"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" fill="currentColor"/></svg>
        </button>
      </div>

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
            @restart-agent="restartAgent"
            @upgrade-agent="upgradeAgent"
          />
          <div class="sidebar-header-actions">
            <SidebarModeToggle view="yeaft" @flip="onModeFlip" />
            <button class="sidebar-icon-btn" :title="tr('chat.sidebar.collapse', 'Collapse')" @click="$emit('toggle-sidebar')">
              <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M3 18h13v-2H3v2zm0-5h10v-2H3v2zm0-7v2h13V6H3zm18 9.59L17.42 12 21 8.41 19.59 7l-5 5 5 5L21 15.59z"/></svg>
            </button>
            <button v-if="canUseWorkbench" class="sidebar-icon-btn" :class="{ active: chatStore && chatStore.workbenchExpanded }" :title="tr('chat.sidebar.workbench', 'Workbench')" @click="onToggleWorkbench">
              <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M20 3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H4V5h16v14zM6 7h5v2H6V7zm0 4h5v2H6v-2zm0 4h5v2H6v-2zm7-8h5v10h-5V7z"/></svg>
            </button>
          </div>
        </div>
      </div>

      <div class="us-scroll us-scroll-flush">
        <!-- Parity with Chat/Crew sidebar: session-tab-bar (single Chat tab,
             no Crew) + session-item rows reusing sidebar.css classes. -->
        <div class="session-tab-bar">
          <div class="session-tab session-tab-solo active">
            <svg class="session-tab-icon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>
            <span>{{ $t('yeaft.session.title') }}</span>
            <span class="session-tab-count" v-if="sessionList.length > 0">{{ sessionList.length }}</span>
            <button
              type="button"
              class="session-tab-add-btn"
              :title="$t('yeaft.session.new')"
              :aria-label="$t('yeaft.session.new')"
              @click.stop="onOpenSessionCreate"
            >
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
            </button>
          </div>
        </div>

        <div class="session-panels">
          <div class="session-panel-list">
            <template v-if="sessionList.length > 0">
              <div
                v-for="s in sessionList"
                :key="s.kind + ':' + s.id"
                class="session-item"
                :class="{ active: s.active, pinned: s.pinned, processing: s.processing || isSessionProcessing(s.id) }"
                @click="onSelectGroup(s.raw)"
                @contextmenu.prevent="openGroupMenu(s.raw, $event)"
              >
                <div class="session-item-header">
                  <span v-if="s.pinned" class="session-pin-icon"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg></span>
                  <span v-if="s.processing || isSessionProcessing(s.id)" class="processing-dot"></span>
                  <div class="title" :title="groupDisplayName(s.raw)">
                    <span>{{ groupDisplayName(s.raw) }}</span>
                  </div>
                  <span class="session-time" v-if="groupTime(s.raw)">{{ groupTime(s.raw) }}</span>
                  <button
                    type="button"
                    class="session-dots-btn"
                    :class="{ 'menu-open': groupMenu.open && groupMenu.groupId === s.id }"
                    :title="$t('yeaft.session.moreActions')"
                    :aria-label="$t('yeaft.session.moreActions')"
                    aria-haspopup="menu"
                    :aria-expanded="groupMenu.open && groupMenu.groupId === s.id ? 'true' : 'false'"
                    @click.stop="openGroupMenu(s.raw, $event)"
                  >
                    <svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
                  </button>
                  <div v-if="groupMenu.open && groupMenu.groupId === s.id" class="session-menu" role="menu" @click.stop>
                    <button type="button" role="menuitem" class="session-menu-item" @click="onTogglePin(s.raw)">
                      {{ isSessionPinned(s) ? $t('chat.sidebar.unpin') : $t('chat.sidebar.pin') }}
                    </button>
                    <button type="button" role="menuitem" class="session-menu-item" @click="openGroupSettingsFromMenu(s.raw, 'announcement')">
                      {{ $t('yeaft.session.openSettings') }}
                    </button>
                    <button type="button" role="menuitem" class="session-menu-item" @click="onRemoveFromList(s.raw)">
                      {{ $t('yeaft.session.removeFromList') }}
                    </button>
                  </div>
                </div>
                <div class="session-info">
                  <span class="session-path">{{ groupPath(s.raw) }}</span>
                  <span class="session-agent" v-if="sessionAgentName(s.raw)">{{ sessionAgentName(s.raw) }}</span>
                </div>
              </div>
            </template>
            <div v-else class="session-empty-hint">{{ $t('yeaft.session.empty') }}</div>
          </div>
        </div>
      </div>

      <!-- H2.f.6: merge target picker + irreversible confirm dialog removed. -->

      <!-- Phase 3: unified session create modal.
           fix-session-restore-modal-unify: this modal now ALSO hosts the
           "Restore from disk" panel; the separate SessionRestoreModal
           was deleted in this PR. The user has ONE place to create or
           restore a session for a workdir — matches Chat's
           new-conversation modal. -->
      <SessionCreateModal
        v-if="sessionCreateOpen"
        @close="sessionCreateOpen = false"
        @created="onSessionCreated"
      />

      <!-- task-yeaft-group-editor: Per-group rename/delete formerly lived
           in inline overlays here. They've been folded into the unified
           SessionSettingsModal — opened via the kebab → unified modal at
           the proper section. YeaftPage owns the modal lifecycle. -->

      <!-- task-342: sidebar bottom — Settings entry + version badge. -->
      <div class="sidebar-bottom">
        <button class="sidebar-nav-item" @click="$emit('open-settings')">
          <svg viewBox="0 0 24 24" width="20" height="20"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" fill="currentColor"/></svg>
          <span>{{ tr('chat.sidebar.settings', 'Settings') }}</span>
          <span v-if="serverVersion" class="sidebar-version">{{ serverVersion }}</span>
        </button>
      </div>
    </aside>
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
      // task-yeaft-group-editor: per-row action menu only — the rename
      // and delete modals have been folded into the unified
      // SessionSettingsModal owned by YeaftPage.
      groupMenu: { open: false, groupId: null },
      // task-342: server version shown in sidebar-bottom (mirrors ChatPage).
      serverVersion: '',
      restartingAgents: {},
      upgradingAgents: {},
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
    this._agentUpgradeAckHandler = (e) => {
      const { agentId, success, error, alreadyLatest, version, reason, currentNode, requiredNode } = e.detail || {};
      if (!agentId) return;
      if (!success) {
        delete this.upgradingAgents[agentId];
        if (reason === 'node_incompatible') {
          alert(this.$t('chat.agent.nodeIncompatible', {
            current: currentNode || '?',
            required: requiredNode || '?',
            version: version || '',
          }));
        } else {
          alert(`Agent upgrade failed: ${error || 'Unknown error'}`);
        }
      } else if (alreadyLatest) {
        delete this.upgradingAgents[agentId];
        alert(this.$t('chat.agent.alreadyLatest', { version: version || '' }));
      }
      // success && !alreadyLatest means the agent process will restart. Keep
      // the upgrading marker until the next agent_list shows it is back.
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('agent-upgrade-ack', this._agentUpgradeAckHandler);
    }

    if (typeof this.$watch === 'function') {
      this._checkAgentTransientStates = this.$watch(
        () => {
          const s = this.chatStore || this.store;
          return Array.isArray(s?.agents)
            ? s.agents.map(a => `${a.id}:${a.online}:${a.version || ''}`)
            : [];
        },
        () => this.clearRecoveredAgentStatuses()
      );
    }
  },
  beforeUnmount() {
    if (this._agentUpgradeAckHandler && typeof window !== 'undefined') {
      window.removeEventListener('agent-upgrade-ack', this._agentUpgradeAckHandler);
    }
    if (this._checkAgentTransientStates) this._checkAgentTransientStates();
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
    // Phase 4: chat container removed. Session list is just sessions now.
    sessionList() {
      return buildYeaftSidebarSessionList({
        sessions: this.sessionsStore?.sessionList || [],
        activeSessionId: this.activeSessionId,
        pinnedSessionIds: this.chatStore?.pinnedSessions || [],
      });
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
    canUseWorkbench() {
      const s = this.chatStore || this.store;
      if (!s || typeof s.hasCapability !== 'function') return false;
      try {
        return !!(s.hasCapability('terminal') || s.hasCapability('file_editor'));
      } catch (_) { return false; }
    },
    // task-yeaft-remove-sidebar-search: retired query-related computeds
    // and placeholder helpers were removed with the old query UI.
  },
  methods: {
    // task-341: i18n lookup for keys outside the yeaft.sidebar namespace.
    tr(fullKey, fallback) {
      if (typeof this.$t === 'function') {
        const v = this.$t(fullKey);
        if (v && v !== fullKey) return v;
      }
      return fallback;
    },
    isSessionProcessing(sessionId) {
      const s = this.chatStore || this.store;
      if (!s || !sessionId) return false;
      if (typeof s.isYeaftSessionProcessing === 'function') return s.isYeaftSessionProcessing(sessionId);
      return !!s.yeaftProcessingSessions?.[sessionId];
    },
    // task-341: workbench toggle, guarded for test env.
    onToggleWorkbench() {
      const s = this.chatStore || this.store;
      if (s && typeof s.toggleWorkbench === 'function') s.toggleWorkbench();
    },
    onModeFlip(target) {
      // Only 'chat' is reachable from here — 'yeaft' is a no-op because
      // we're already in the Yeaft view when this sidebar is mounted.
      if (target === 'chat') {
        this.$emit('back');
      }
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
    onOpenSessionCreate() { this.sessionCreateOpen = true; },
    onSessionCreated(_group) {
      // groups store auto-activates via applyCrudResult; modal closes itself.
    },
    onSelectGroup(g) {
      if (!g || !g.id) return;
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
      if (this.sessionsStore) this.sessionsStore.setActive(g.id);
      this.$emit('select-group', g);
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
    // task-yeaft-group-editor: ⚙ button on each group row opens the
    // unified SessionSettingsModal (announcement / members / rename /
    // danger). Default landing section is 'members' so the existing
    // muscle-memory of the kebab "Manage members" lands in the same
    // place. YeaftPage owns the modal lifecycle.
    openGroupSettings(g, section = 'members') {
      if (!g || !g.id) return;
      this.$emit('open-group-settings', { sessionId: g.id, section });
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
      const rowPinned = !!(sessionOrId && typeof sessionOrId === 'object' && sessionOrId.pinned);
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
          agentId: g.agentId || this.store?.yeaftAgentId || this.store?.currentAgent || null,
          sessionName: g.name || g.title || g.id,
          workDir: g.workDir || '',
        });
      }
    },
    // "Remove from list" — soft-archive only. Server marks
    // is_archived=1 in yeaft_sessions; the agent's on-disk session is
    // untouched. Real delete (DELETE FROM yeaft_sessions + on-disk
    // cleanup) lives in SessionSettingsModal's danger zone.
    onRemoveFromList(g) {
      this.groupMenu = { open: false, groupId: null };
      if (!g || !g.id) return;
      const fn = this.chatStore && this.chatStore.sessionCrudRequest;
      if (typeof fn === 'function') fn.call(this.chatStore, 'archive', { sessionId: g.id });
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
      if (this.groupMenu.open && this.groupMenu.groupId === g.id) {
        this.groupMenu = { open: false, groupId: null };
        return;
      }
      this.groupMenu = { open: true, groupId: g.id };
      // Close on next outside click.
      const close = (ev) => {
        if (ev && ev.target && ev.target.closest && ev.target.closest('.session-menu')) return;
        this.groupMenu = { open: false, groupId: null };
        window.removeEventListener('click', close, true);
      };
      setTimeout(() => window.addEventListener('click', close, true), 0);
      if (evt && typeof evt.stopPropagation === 'function') evt.stopPropagation();
    },
    restartAgent(agentId) {
      const s = this.chatStore || this.store;
      if (!s || !Array.isArray(s.agents) || typeof s.restartAgent !== 'function') return;
      const agent = s.agents.find(a => a && a.id === agentId);
      const name = agent?.name || agentId;
      if (!confirm(this.$t('chat.agent.restartConfirm', { name }))) return;
      this.restartingAgents[agentId] = true;
      setTimeout(() => { delete this.restartingAgents[agentId]; }, 120000);
      s.restartAgent(agentId);
    },
    clearRecoveredAgentStatuses() {
      const s = this.chatStore || this.store;
      if (!s || !Array.isArray(s.agents)) return;
      for (const agentId of Object.keys(this.restartingAgents)) {
        const agent = s.agents.find(a => a && a.id === agentId);
        if (agent?.online || !agent) delete this.restartingAgents[agentId];
      }
      for (const agentId of Object.keys(this.upgradingAgents)) {
        const agent = s.agents.find(a => a && a.id === agentId);
        const info = this.upgradingAgents[agentId];
        const elapsed = Date.now() - (info?.since || 0);
        if (!agent || elapsed > 120000) {
          delete this.upgradingAgents[agentId];
        } else if (agent.online) {
          const oldVersion = info?.oldVersion || null;
          const versionChanged = !!(oldVersion && agent.version && agent.version !== oldVersion);
          const minDisplayMs = 3000;
          if (versionChanged || elapsed >= minDisplayMs) {
            delete this.upgradingAgents[agentId];
          } else {
            setTimeout(() => {
              const latestStore = this.chatStore || this.store;
              const latest = Array.isArray(latestStore?.agents)
                ? latestStore.agents.find(a => a && a.id === agentId)
                : null;
              if (latest?.online) delete this.upgradingAgents[agentId];
            }, minDisplayMs - elapsed);
          }
        }
      }
    },
    upgradeAgent(agentId) {
      const s = this.chatStore || this.store;
      if (!s || !Array.isArray(s.agents) || typeof s.upgradeAgent !== 'function') return;
      const agent = s.agents.find(a => a && a.id === agentId);
      const name = agent?.name || agentId;
      if (!confirm(this.$t('chat.agent.upgradeConfirm', { name }))) return;
      this.upgradingAgents[agentId] = { since: Date.now(), oldVersion: agent?.version || null };
      setTimeout(() => { delete this.upgradingAgents[agentId]; }, 120000);
      s.upgradeAgent(agentId);
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
