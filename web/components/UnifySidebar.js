/**
 * UnifySidebar — H2.f.6 trimmed.
 *
 * Standalone sidebar component with:
 *   - top search box (task / message keywords; #thread- prefix retired)
 *   - Groups list (with kebab menu: manage members / rename / delete)
 *   - Tasks tree (expand/collapse, max 3 levels)
 *   - emits `select-task` / `select-group` on click
 *
 * H2.f.6: thread/merge/fork UI removed alongside the multi-thread engine.
 * The remaining sidebar is a flat single-conversation surface.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// task-316: pulled parser out into a standalone, unit-tested module.
// The sidebar only consumes the typed ParsedQuery + the pure matchers.
import {
  parseSearchQuery,
  hasActiveQuery,
  taskMatches as _taskMatches,
  messageMatches as _messageMatches,
} from '../utils/search-parser.js';
import GroupCreateWizard from './GroupCreateWizard.js';

export default {
  name: 'UnifySidebar',
  components: { GroupCreateWizard },
  emits: ['select-task', 'select-group', 'search-escape', 'toggle-sidebar', 'back', 'open-settings', 'open-group-settings'],
  template: `
    <aside class="unify-sidebar" :class="{ collapsed: collapsed }">
      <!-- Collapsed Icon Bar — mirrors Chat's .sidebar-collapsed-bar so the
           sidebar can be re-expanded after collapse instead of disappearing. -->
      <div class="sidebar-collapsed-bar" v-if="collapsed">
        <button class="collapsed-icon-btn" @click="$emit('toggle-sidebar')" :title="tr('chat.sidebar.expand', 'Expand')">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>
        </button>
        <button class="collapsed-icon-btn" @click="$emit('back')" :title="tr('unify.back', 'Back')">
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

      <!-- task-341: sidebar header row — agent identifier + collapse/back/workbench. -->
      <div class="us-header-row">
        <div class="us-brand" :title="agentTitleText">
          <span class="us-status-dot" :class="{ online: currentAgentOnline }"></span>
          <span class="us-brand-label">{{ currentAgentName }}</span>
          <span v-if="currentAgentLatency != null" class="us-latency" :class="getLatencyClass(currentAgentLatency)">{{ currentAgentLatency }}ms</span>
        </div>
        <div class="us-header-actions">
          <button class="us-icon-btn" :title="tr('chat.sidebar.collapse', 'Collapse')" @click="$emit('toggle-sidebar')">
            <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M3 18h13v-2H3v2zm0-5h10v-2H3v2zm0-7v2h13V6H3zm18 9.59L17.42 12 21 8.41 19.59 7l-5 5 5 5L21 15.59z"/></svg>
          </button>
          <button class="us-icon-btn" :title="tr('unify.back', 'Back')" @click="$emit('back')">
            <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
          </button>
          <button v-if="canUseWorkbench" class="us-icon-btn" :class="{ active: chatStore && chatStore.workbenchExpanded }" :title="tr('chat.sidebar.workbench', 'Workbench')" @click="onToggleWorkbench">
            <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M20 3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H4V5h16v14zM6 7h5v2H6V7zm0 4h5v2H6v-2zm0 4h5v2H6v-2zm7-8h5v10h-5V7z"/></svg>
          </button>
        </div>
      </div>

      <div class="us-search">
        <svg class="us-search-icon" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
        <input
          type="text"
          class="us-search-input"
          v-model="searchQuery"
          :placeholder="placeholderText"
          @keydown.esc.prevent="onSearchEscape"
          ref="searchInput"
        />
        <button
          v-if="searchQuery"
          type="button"
          class="us-search-clear"
          :title="label('clearSearch')"
          @click="onSearchEscape"
        >×</button>
      </div>

      <!-- task-312/316: unified search results list. Shown whenever a
           query is active; hides the Active/Idle/Archived/Tasks sections
           so the user sees labelled sections (Threads / Tasks / Messages)
           with click-to-jump semantics. -->
      <div class="us-scroll" v-if="searchActive">
        <!-- Tasks group -->
        <section class="us-group us-group-results" v-if="searchGroups.tasks.length > 0">
          <div class="us-group-header us-results-header">
            <span class="us-group-label">{{ label('resultsTasks') }}</span>
            <span class="us-group-count">{{ searchGroups.tasks.length }}</span>
          </div>
          <div class="us-group-body">
            <div
              v-for="r in searchGroups.tasks"
              :key="'task:' + r.id"
              class="us-result us-result-task"
              @click="onSelectResult(r)"
            >
              <span class="us-result-kind">{{ label('kindTask') }}</span>
              <span class="us-result-name">{{ r.task.id }}</span>
              <span class="us-result-title">{{ r.title }}</span>
              <span class="us-result-snippet" v-if="r.snippet">{{ r.snippet }}</span>
            </div>
          </div>
        </section>
        <!-- Messages group (task-316) — only populated when query asks
             for body-level match, e.g. in:body foo or task:N kw. -->
        <section class="us-group us-group-results" v-if="searchGroups.messages.length > 0">
          <div class="us-group-header us-results-header">
            <span class="us-group-label">{{ label('resultsMessages') }}</span>
            <span class="us-group-count">{{ searchGroups.messages.length }}</span>
          </div>
          <div class="us-group-body">
            <div
              v-for="r in searchGroups.messages"
              :key="'msg:' + r.id"
              class="us-result us-result-message"
              @click="onSelectResult(r)"
            >
              <span class="us-result-kind">{{ label('kindMessage') }}</span>
              <span class="us-result-title">{{ r.title }}</span>
              <span class="us-result-snippet" v-if="r.snippet">{{ r.snippet }}</span>
            </div>
          </div>
        </section>
        <!-- Empty state with usage examples (task-316) -->
        <div class="us-empty us-empty-with-hints" v-if="searchResults.length === 0">
          <div class="us-empty-title">{{ label('emptyResults') }}</div>
          <div class="us-empty-hints">
            <div class="us-empty-hint-label">{{ label('examplesLabel') }}</div>
            <div class="us-empty-hint"><code>task:42</code></div>
            <div class="us-empty-hint"><code>in:title foo</code></div>
            <div class="us-empty-hint"><code>status:open bar</code></div>
          </div>
        </div>
      </div>

      <div class="us-scroll" v-else>
        <!-- task-339-F1: Groups section hoisted ABOVE threads; hidden entirely when empty. -->
        <section v-if="groupList.length > 0" class="us-group us-group-groups" :aria-label="$t('unify.group.sidebarAria')">
          <div class="us-group-header">
            <span class="us-group-label">{{ $t('unify.group.sidebarTitle') }}</span>
            <span class="us-group-count">{{ groupList.length }}</span>
            <button
              type="button"
              class="us-group-new-btn"
              :title="$t('unify.group.newButtonAria')"
              :aria-label="$t('unify.group.newButtonAria')"
              @click="onOpenGroupWizard"
            >
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
            </button>
          </div>
          <div class="us-group-body">
            <div
              v-for="g in groupList"
              :key="g.id"
              class="us-row us-group-row"
              :class="{
                selected: g.id === activeGroupId,
                'is-empty': !g.roster || g.roster.length === 0,
                'is-default-empty': g.id === 'grp_default' && (!g.roster || g.roster.length === 0),
              }"
              @click="onSelectGroup(g)"
              @contextmenu.prevent="openGroupMenu(g, $event)"
            >
              <span class="us-dot us-dot-group"></span>
              <span class="us-row-name">{{ groupDisplayName(g) }}</span>
              <span class="us-row-title">
                <template v-if="g.roster && g.roster.length === 1">{{ $t('unify.group.oneMember') }}</template>
                <template v-else-if="g.roster && g.roster.length > 1">{{ $t('unify.group.membersCount', { count: g.roster.length }) }}</template>
                <template v-else>{{ $t('unify.group.noMembers') }}</template>
              </span>
              <button
                type="button"
                class="us-group-row-settings"
                :title="$t('unify.group.settings.title', { name: groupDisplayName(g) })"
                :aria-label="$t('unify.group.settings.title', { name: groupDisplayName(g) })"
                @click.stop="openGroupSettings(g)"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
              </button>
              <button
                type="button"
                class="us-group-row-kebab"
                :title="$t('unify.group.moreActions')"
                :aria-label="$t('unify.group.moreActions')"
                aria-haspopup="menu"
                :aria-expanded="groupMenu.open && groupMenu.groupId === g.id ? 'true' : 'false'"
                @click.stop="openGroupMenu(g, $event)"
              >⋯</button>
              <div v-if="groupMenu.open && groupMenu.groupId === g.id" class="us-group-row-menu" role="menu" @click.stop>
                <button type="button" role="menuitem" class="us-group-row-menu-item" @click="openGroupSettingsFromMenu(g, 'members')">
                  {{ $t('unify.group.manageMembers') }}
                </button>
                <button type="button" role="menuitem" class="us-group-row-menu-item" @click="openGroupSettingsFromMenu(g, 'announcement')">
                  {{ $t('unify.group.settings.nav.announcement') }}
                </button>
                <button type="button" role="menuitem" class="us-group-row-menu-item" @click="openGroupSettingsFromMenu(g, 'rename')">
                  {{ $t('unify.group.rename') }}
                </button>
                <button type="button" role="menuitem" class="us-group-row-menu-item us-group-row-menu-danger" @click="openGroupSettingsFromMenu(g, 'danger')">
                  {{ $t('unify.group.delete') }}
                </button>
              </div>
            </div>
          </div>
        </section>

        <!-- task-339-F1: Create-group entry point — visible even when groups=0 so user
             can still bootstrap. Mirrors .new-chat-btn chrome from the Chat sidebar. -->
        <button
          v-if="groupList.length === 0"
          type="button"
          class="us-new-group-btn"
          :title="$t('unify.group.newButtonAria')"
          :aria-label="$t('unify.group.newButtonAria')"
          @click="onOpenGroupWizard"
        >
          <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
          <span>{{ $t('unify.group.newButtonAria') }}</span>
        </button>

        <!-- H2.f.6: Active / Idle / Archived thread sections removed. -->

        <!-- Tasks Tree -->
        <section class="us-group us-group-tasks" :class="{ collapsed: !tasksOpen }">
          <button type="button" class="us-group-header" @click="tasksOpen = !tasksOpen">
            <svg class="us-chevron" :class="{ open: tasksOpen }" viewBox="0 0 24 24" width="10" height="10"><path fill="currentColor" d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
            <span class="us-group-label">{{ label('tasks') }}</span>
            <span class="us-group-count">{{ filteredTasks.length }}</span>
          </button>
          <div class="us-group-body" v-show="tasksOpen">
            <div v-for="task in filteredTasks" :key="task.id">
              <div
                class="us-task us-task-lvl-0"
                :class="['us-task-status-' + (task.status || 'unknown'), { selected: task.id === activeTaskId }]"
                @click="onSelectTask(task)"
              >
                <span
                  class="us-task-toggle"
                  v-if="task.children && task.children.length > 0"
                  @click.stop="toggleTask(task.id)"
                >
                  <svg class="us-chevron" :class="{ open: isTaskExpanded(task.id) }" viewBox="0 0 24 24" width="9" height="9"><path fill="currentColor" d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
                </span>
                <span class="us-task-toggle-spacer" v-else></span>
                <span class="us-task-id">{{ task.id }}</span>
                <span class="us-task-title">{{ task.title }}</span>
              </div>
              <div v-if="isTaskExpanded(task.id) && task.children && task.children.length > 0">
                <div
                  v-for="child in task.children"
                  :key="child.id"
                  class="us-task us-task-lvl-1"
                  :class="['us-task-status-' + (child.status || 'unknown'), { selected: child.id === activeTaskId }]"
                  @click="onSelectTask(child)"
                >
                  <span class="us-task-toggle-spacer"></span>
                  <span class="us-task-id">{{ child.id }}</span>
                  <span class="us-task-title">{{ child.title }}</span>
                </div>
              </div>
            </div>
            <div class="us-empty" v-if="filteredTasks.length === 0">{{ label('emptyTasks') }}</div>
          </div>
        </section>

        <!-- task-339-F1: Groups section moved to top of sidebar (see above). -->
      </div>

      <!-- H2.f.6: merge target picker + irreversible confirm dialog removed. -->

      <!-- task-334m: Create-group wizard (inline, modal overlay). -->
      <GroupCreateWizard
        v-if="groupWizardOpen"
        @close="groupWizardOpen = false"
        @created="onGroupCreated"
      />

      <!-- task-unify-group-editor: Per-group rename/delete formerly lived
           in inline overlays here. They've been folded into the unified
           GroupSettingsModal — opened via the kebab → unified modal at
           the proper section. UnifyPage owns the modal lifecycle. -->

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
    // task-fix: collapsed flag from parent (UnifyPage). Used to drive
    // the mobile slide-away behavior.
    collapsed: { type: Boolean, default: false },
    // Optional injection hooks — primarily for unit tests that don't
    // mount Pinia. When null the component reads from store.
    tasksSource: { type: Array, default: null },
    // task-316: let tests inject messages the same way.
    messagesSource: { type: Array, default: null },
  },
  data() {
    return {
      searchQuery: '',
      tasksOpen: true,
      expandedTasks: {},
      now: Date.now(),
      // task-334m: group-create wizard visibility.
      groupWizardOpen: false,
      groupsOpen: true,
      // task-unify-group-editor: per-row action menu only — the rename
      // and delete modals have been folded into the unified
      // GroupSettingsModal owned by UnifyPage.
      groupMenu: { open: false, groupId: null },
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
    groupsStore() {
      try {
        if (typeof window !== 'undefined' && window.Pinia?.useGroupsStore) {
          return window.Pinia.useGroupsStore();
        }
      } catch (_) { /* no-pinia test env */ }
      return null;
    },
    groupList() { return this.groupsStore?.groupList || []; },
    activeGroupId() { return this.groupsStore?.activeGroupId || null; },
    chatStore() {
      // Needed for `groupCrudRequest`. Reuses the same guarded lookup
      // as `store` above but via window.Pinia for consistency with the
      // groups-store lookup.
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
    currentAgentLatency() {
      const s = this.chatStore || this.store;
      if (!s || !s.currentAgent || !Array.isArray(s.agents)) return null;
      const agent = s.agents.find(a => a && a.id === s.currentAgent);
      return (agent && agent.latency != null) ? agent.latency : null;
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
    // H2.f.6: threads removed. Tasks remain.
    tasks() {
      if (Array.isArray(this.tasksSource)) return this.tasksSource;
      return this.store?.unifyFeatures || [];
    },
    activeTaskId() {
      return this.store?.unifyActiveFeatureId || null;
    },
    // Localized placeholder. Falls back gracefully when $t is not injected
    // (e.g. stand-alone unit tests that don't mount the component).
    placeholderText() {
      if (typeof this.$t === 'function') {
        return this.$t('unify.sidebar.searchPlaceholder');
      }
      return 'Search…';
    },
    // task-316: parser now lives in web/utils/search-parser.js.
    parsedQuery() {
      return parseSearchQuery(this.searchQuery || '');
    },
    searchActive() {
      return hasActiveQuery(this.parsedQuery);
    },
    filteredTasks() {
      const q = this.parsedQuery;
      if (!hasActiveQuery(q)) return this.tasks;
      // Keep task visible when itself OR any descendant matches so the
      // expand-chevron still renders the parent chain in the tree view.
      const matches = (task) => {
        if (_taskMatches(task, q)) return true;
        return (task.children || []).some(matches);
      };
      return this.tasks.filter(matches);
    },
    // H2.f.6: search results = tasks + messages only (no threads).
    searchResults() {
      if (!this.searchActive) return [];
      const q = this.parsedQuery;
      const { keyword, scopedField } = q;
      const out = [];
      const flatten = (task) => {
        if (_taskMatches(task, q)) {
          out.push({
            kind: 'task',
            id: task.id,
            title: task.title || '',
            snippet: this.pickTaskSnippet(task, keyword, scopedField),
            task,
          });
        }
        for (const c of (task.children || [])) flatten(c);
      };
      for (const task of this.filteredTasks) flatten(task);
      // Message hits — only included when query could meaningfully match.
      if (q.featureId || q.scopedField === 'body') {
        const msgs = this.messages || [];
        for (const m of msgs) {
          if (_messageMatches(m, q)) {
            out.push({
              kind: 'message',
              id: m.id || `msg-${out.length}`,
              title: this.truncate(typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''), 80),
              snippet: '',
              message: m,
            });
          }
        }
      }
      return out;
    },
    // H2.f.6: parallel grouping view — tasks + messages only.
    searchGroups() {
      const groups = { tasks: [], messages: [] };
      for (const r of this.searchResults) {
        if (r.kind === 'task') groups.tasks.push(r);
        else if (r.kind === 'message') groups.messages.push(r);
      }
      return groups;
    },
    // task-316: messages visible to the sidebar. Reads the active Unify
    // conversation's message array directly from the store; unit tests
    // that don't mount Pinia can inject via `messagesSource`.
    messages() {
      if (Array.isArray(this.messagesSource)) return this.messagesSource;
      const s = this.store;
      const convId = s?.unifyConversationId;
      if (!convId) return [];
      return (s.messagesMap && s.messagesMap[convId]) || [];
    }
  },
  methods: {
    // Unified i18n lookup for sidebar labels/empties. Falls back to a
    // built-in English dictionary when $t is not available (unit tests).
    label(key) {
      const full = `unify.sidebar.${key}`;
      if (typeof this.$t === 'function') return this.$t(full);
      const fallback = {
        // H2.f.6: thread/merge keys removed alongside the multi-thread UI.
        tasks: 'Tasks',
        emptyTasks: 'No tasks match',
        results: 'Results',
        resultsTasks: 'Tasks',
        resultsMessages: 'Messages',
        emptyResults: 'No matches',
        kindTask: 'task',
        kindMessage: 'msg',
        clearSearch: 'Clear',
        cancel: 'Cancel',
        examplesLabel: 'Try:',
      };
      return fallback[key] || full;
    },
    // task-341: i18n lookup for keys outside the unify.sidebar namespace.
    tr(fullKey, fallback) {
      if (typeof this.$t === 'function') {
        const v = this.$t(fullKey);
        if (v && v !== fullKey) return v;
      }
      return fallback;
    },
    // task-341: latency indicator colour mirrors ChatPage.
    getLatencyClass(latency) {
      if (latency == null) return '';
      if (latency < 200) return 'latency-good';
      if (latency < 500) return 'latency-warn';
      return 'latency-bad';
    },
    // task-341: workbench toggle, guarded for test env.
    onToggleWorkbench() {
      const s = this.chatStore || this.store;
      if (s && typeof s.toggleWorkbench === 'function') s.toggleWorkbench();
    },
    // task-334m: group-wizard + selection handlers.
    onOpenGroupWizard() { this.groupWizardOpen = true; },
    onCloseGroupWizard() { this.groupWizardOpen = false; },
    onSelectGroup(g) {
      if (!g || !g.id) return;
      if (this.groupsStore) this.groupsStore.setActive(g.id);
      this.$emit('select-group', g);
    },
    // task-unify-group-editor: ⚙ button on each group row opens the
    // unified GroupSettingsModal (announcement / members / rename /
    // danger). Default landing section is 'members' so the existing
    // muscle-memory of the kebab "Manage members" lands in the same
    // place. UnifyPage owns the modal lifecycle.
    openGroupSettings(g, section = 'members') {
      if (!g || !g.id) return;
      this.$emit('open-group-settings', { groupId: g.id, section });
    },
    // Convenience wrapper used by the kebab menu items: closes the menu
    // first so the unified modal opens cleanly without the kebab still
    // hovering above it.
    openGroupSettingsFromMenu(g, section) {
      this.groupMenu = { open: false, groupId: null };
      this.openGroupSettings(g, section);
    },
    onGroupCreated(_group) {
      // Store auto-activates via applyCrudResult; wizard closes itself.
    },
    groupDisplayName(g) {
      if (!g) return '';
      // D1 seed sentinel: replace raw 'Default' on grp_default with i18n label.
      if (g.id === 'grp_default' && (g.name === 'Default' || !g.name)) {
        return this.$t('unify.group.defaultName');
      }
      return g.name || g.id || '';
    },
    groupMemberCount(g) {
      return Array.isArray(g?.roster) ? g.roster.length : 0;
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
        if (ev && ev.target && ev.target.closest && ev.target.closest('.us-group-row-menu')) return;
        this.groupMenu = { open: false, groupId: null };
        window.removeEventListener('click', close, true);
      };
      setTimeout(() => window.addEventListener('click', close, true), 0);
      if (evt && typeof evt.stopPropagation === 'function') evt.stopPropagation();
    },
    // task-unify-group-editor: per-group rename/delete + manage-members
    // formerly lived as discrete startManageMembers/startRenameGroup/
    // startDeleteGroup methods that mounted inline overlays. They've
    // all been folded into the unified GroupSettingsModal opened via
    // openGroupSettingsFromMenu(g, section) above. UnifyPage owns the
    // modal lifecycle.
    // H2.f.6: thread display / tooltip / link / fork helpers removed.
    isTaskExpanded(id) {
      return !!this.expandedTasks[id];
    },
    toggleTask(id) {
      this.expandedTasks = { ...this.expandedTasks, [id]: !this.expandedTasks[id] };
    },
    onSelectTask(task) {
      this.$emit('select-task', task.id);
    },
    // H2.f.6: results list now only contains tasks + messages.
    onSelectResult(r) {
      if (r.kind === 'message') {
        // Message hit: nothing to navigate to without threads — no-op for now.
        return;
      }
      this.$emit('select-task', r.id);
    },
    // task-312: Esc in the search box clears + asks parent to refocus
    // the chat input. Plain string empty also exits the results view.
    onSearchEscape() {
      this.searchQuery = '';
      this.$emit('search-escape');
    },
    pickTaskSnippet(task, keyword, scopedField) {
      const kw = keyword || '';
      if (!kw) return '';
      const candidates = scopedField === 'title'
        ? [task.title]
        : scopedField === 'summary'
          ? [task.summary, task.description]
          : [task.summary, task.description];
      for (const txt of candidates) {
        if (txt && String(txt).toLowerCase().includes(kw)) {
          return this.truncate(String(txt));
        }
      }
      return '';
    },
    truncate(s, n = 80) {
      if (!s) return '';
      return s.length > n ? s.slice(0, n - 1) + '…' : s;
    }
    // H2.f.6: merge / fork flows retired with the multi-thread model.
  }
};
