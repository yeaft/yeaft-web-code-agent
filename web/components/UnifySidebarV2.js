/**
 * UnifySidebarV2 — task-300 skeleton + task-301 Part 1/2 integration.
 *
 * Standalone sidebar component with:
 *   - top search box (keyword + `#thread-name` prefix), i18n placeholder
 *   - Active / Idle / Archived thread groups (main pinned first in Active,
 *     displayed as the localized "Inbox" label)
 *   - Tasks tree (expand/collapse, max 3 levels)
 *   - emits `select-thread` / `select-task` on row click
 *
 * Part 2 (task-301): Phase-1 mock data is gone. The component now reads
 * `store.unifyThreads` / `store.unifyTasks` directly — those arrays are
 * populated by `thread_list_updated` / `task_list_updated` events sent
 * from agent/unify/web-bridge.js (which wraps task-299 ThreadStore /
 * TaskStore snapshots).
 *
 * All group labels, empty-state strings and the search placeholder go
 * through the `$t()` i18n helper; nothing is hardcoded in English.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// task-316: pulled parser out into a standalone, unit-tested module.
// The sidebar only consumes the typed ParsedQuery + the pure matchers.
import {
  parseSearchQuery,
  hasActiveQuery,
  threadMatches as _threadMatches,
  taskMatches as _taskMatches,
  messageMatches as _messageMatches,
} from '../utils/search-parser.js';
import GroupCreateWizard from './GroupCreateWizard.js';

export default {
  name: 'UnifySidebarV2',
  components: { GroupCreateWizard },
  emits: ['select-thread', 'select-task', 'jump-to-message', 'search-escape', 'merge-thread', 'select-group', 'open-user-memory', 'toggle-sidebar', 'back', 'open-settings', 'manage-members'],
  template: `
    <aside class="unify-sidebar-v2" :class="{ collapsed: collapsed }">
      <!-- task-341: sidebar header row — agent identifier + collapse/back/workbench. -->
      <div class="usv2-header-row">
        <div class="usv2-brand" :title="agentTitleText">
          <span class="usv2-status-dot" :class="{ online: currentAgentOnline }"></span>
          <span class="usv2-brand-label">{{ currentAgentName }}</span>
          <span v-if="currentAgentLatency != null" class="usv2-latency" :class="getLatencyClass(currentAgentLatency)">{{ currentAgentLatency }}ms</span>
        </div>
        <div class="usv2-header-actions">
          <button class="usv2-icon-btn" :title="tr('chat.sidebar.collapse', 'Collapse')" @click="$emit('toggle-sidebar')">
            <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>
          </button>
          <button class="usv2-icon-btn" :title="tr('unify.back', 'Back')" @click="$emit('back')">
            <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
          </button>
          <button v-if="canUseWorkbench" class="usv2-icon-btn" :class="{ active: chatStore && chatStore.workbenchExpanded }" :title="tr('chat.sidebar.workbench', 'Workbench')" @click="onToggleWorkbench">
            <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M20 3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H4V5h16v14zM6 7h5v2H6V7zm0 4h5v2H6v-2zm0 4h5v2H6v-2zm7-8h5v10h-5V7z"/></svg>
          </button>
        </div>
      </div>

      <div class="usv2-search">
        <svg class="usv2-search-icon" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
        <input
          type="text"
          class="usv2-search-input"
          v-model="searchQuery"
          :placeholder="placeholderText"
          @keydown.esc.prevent="onSearchEscape"
          ref="searchInput"
        />
        <button
          v-if="searchQuery"
          type="button"
          class="usv2-search-clear"
          :title="label('clearSearch')"
          @click="onSearchEscape"
        >×</button>
      </div>

      <!-- task-312/316: unified search results list. Shown whenever a
           query is active; hides the Active/Idle/Archived/Tasks sections
           so the user sees labelled sections (Threads / Tasks / Messages)
           with click-to-jump semantics. -->
      <div class="usv2-scroll" v-if="searchActive">
        <!-- Threads group -->
        <section class="usv2-group usv2-group-results" v-if="searchGroups.threads.length > 0">
          <div class="usv2-group-header usv2-results-header">
            <span class="usv2-group-label">{{ label('resultsThreads') }}</span>
            <span class="usv2-group-count">{{ searchGroups.threads.length }}</span>
          </div>
          <div class="usv2-group-body">
            <div
              v-for="r in searchGroups.threads"
              :key="'thread:' + r.id"
              class="usv2-result usv2-result-thread"
              @click="onSelectResult(r)"
            >
              <span class="usv2-result-kind">{{ label('kindThread') }}</span>
              <span class="usv2-result-name">#{{ threadDisplayName(r.thread) }}</span>
              <span class="usv2-result-title">{{ r.title }}</span>
              <span class="usv2-result-snippet" v-if="r.snippet">{{ r.snippet }}</span>
            </div>
          </div>
        </section>
        <!-- Tasks group -->
        <section class="usv2-group usv2-group-results" v-if="searchGroups.tasks.length > 0">
          <div class="usv2-group-header usv2-results-header">
            <span class="usv2-group-label">{{ label('resultsTasks') }}</span>
            <span class="usv2-group-count">{{ searchGroups.tasks.length }}</span>
          </div>
          <div class="usv2-group-body">
            <div
              v-for="r in searchGroups.tasks"
              :key="'task:' + r.id"
              class="usv2-result usv2-result-task"
              @click="onSelectResult(r)"
            >
              <span class="usv2-result-kind">{{ label('kindTask') }}</span>
              <span class="usv2-result-name">{{ r.task.id }}</span>
              <span class="usv2-result-title">{{ r.title }}</span>
              <span class="usv2-result-snippet" v-if="r.snippet">{{ r.snippet }}</span>
            </div>
          </div>
        </section>
        <!-- Messages group (task-316) — only populated when query asks
             for body-level match, e.g. in:body foo or task:N kw. -->
        <section class="usv2-group usv2-group-results" v-if="searchGroups.messages.length > 0">
          <div class="usv2-group-header usv2-results-header">
            <span class="usv2-group-label">{{ label('resultsMessages') }}</span>
            <span class="usv2-group-count">{{ searchGroups.messages.length }}</span>
          </div>
          <div class="usv2-group-body">
            <div
              v-for="r in searchGroups.messages"
              :key="'msg:' + r.id"
              class="usv2-result usv2-result-message"
              @click="onSelectResult(r)"
            >
              <span class="usv2-result-kind">{{ label('kindMessage') }}</span>
              <span class="usv2-result-title">{{ r.title }}</span>
              <span class="usv2-result-snippet" v-if="r.snippet">{{ r.snippet }}</span>
            </div>
          </div>
        </section>
        <!-- Empty state with usage examples (task-316) -->
        <div class="usv2-empty usv2-empty-with-hints" v-if="searchResults.length === 0">
          <div class="usv2-empty-title">{{ label('emptyResults') }}</div>
          <div class="usv2-empty-hints">
            <div class="usv2-empty-hint-label">{{ label('examplesLabel') }}</div>
            <div class="usv2-empty-hint"><code>#thread-name</code></div>
            <div class="usv2-empty-hint"><code>task:42</code></div>
            <div class="usv2-empty-hint"><code>in:title foo</code></div>
            <div class="usv2-empty-hint"><code>status:open bar</code></div>
          </div>
        </div>
      </div>

      <div class="usv2-scroll" v-else>
        <!-- task-339-F1: Groups section hoisted ABOVE threads; hidden entirely when empty. -->
        <section v-if="groupList.length > 0" class="usv2-group usv2-group-groups" :aria-label="$t('unify.group.sidebarAria')">
          <div class="usv2-group-header">
            <span class="usv2-group-label">{{ $t('unify.group.sidebarTitle') }}</span>
            <span class="usv2-group-count">{{ groupList.length }}</span>
            <button
              type="button"
              class="usv2-group-new-btn"
              :title="$t('unify.group.newButtonAria')"
              :aria-label="$t('unify.group.newButtonAria')"
              @click="onOpenGroupWizard"
            >
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
            </button>
          </div>
          <div class="usv2-group-body">
            <div
              v-for="g in groupList"
              :key="g.id"
              class="usv2-thread usv2-group-row"
              :class="{
                selected: g.id === activeGroupId,
                'is-empty': !g.roster || g.roster.length === 0,
                'is-default-empty': g.id === 'grp_default' && (!g.roster || g.roster.length === 0),
              }"
              @click="onSelectGroup(g)"
              @contextmenu.prevent="openGroupMenu(g, $event)"
            >
              <span class="usv2-dot usv2-dot-group"></span>
              <span class="usv2-thread-name">{{ groupDisplayName(g) }}</span>
              <span class="usv2-thread-title">
                <template v-if="g.roster && g.roster.length === 1">{{ $t('unify.group.oneMember') }}</template>
                <template v-else-if="g.roster && g.roster.length > 1">{{ $t('unify.group.membersCount', { count: g.roster.length }) }}</template>
                <template v-else>{{ $t('unify.group.noMembers') }}</template>
              </span>
              <button
                type="button"
                class="usv2-group-row-kebab"
                :title="$t('unify.group.moreActions')"
                :aria-label="$t('unify.group.moreActions')"
                aria-haspopup="menu"
                :aria-expanded="groupMenu.open && groupMenu.groupId === g.id ? 'true' : 'false'"
                @click.stop="openGroupMenu(g, $event)"
              >⋯</button>
              <div v-if="groupMenu.open && groupMenu.groupId === g.id" class="usv2-group-row-menu" role="menu" @click.stop>
                <button type="button" role="menuitem" class="usv2-group-row-menu-item" @click="startManageMembers(g)">
                  {{ $t('unify.group.manageMembers') }}
                </button>
                <button type="button" role="menuitem" class="usv2-group-row-menu-item" @click="startRenameGroup(g)">
                  {{ $t('unify.group.rename') }}
                </button>
                <button type="button" role="menuitem" class="usv2-group-row-menu-item usv2-group-row-menu-danger" @click="startDeleteGroup(g)">
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
          class="usv2-new-group-btn"
          :title="$t('unify.group.newButtonAria')"
          :aria-label="$t('unify.group.newButtonAria')"
          @click="onOpenGroupWizard"
        >
          <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
          <span>{{ $t('unify.group.newButtonAria') }}</span>
        </button>

        <!-- Active Threads -->
        <section class="usv2-group" :class="{ collapsed: !activeOpen }">
          <button type="button" class="usv2-group-header" @click="activeOpen = !activeOpen">
            <svg class="usv2-chevron" :class="{ open: activeOpen }" viewBox="0 0 24 24" width="10" height="10"><path fill="currentColor" d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
            <span class="usv2-group-label">{{ label('activeThreads') }}</span>
            <span class="usv2-group-count">{{ grouped.active.length }}</span>
          </button>
          <div class="usv2-group-body" v-show="activeOpen">
            <div
              v-for="t in grouped.active"
              :key="t.id"
              class="usv2-thread"
              :class="{ selected: t.id === activeThreadId }"
              :title="threadTooltip(t)"
              @click="onSelectThread(t)"
              @contextmenu.prevent="onRequestMerge(t)"
            >
              <span class="usv2-dot usv2-dot-active" :class="{ running: t.running }"></span>
              <span class="usv2-thread-name">#{{ threadDisplayName(t) }}</span>
              <span v-if="t.forkedFrom" class="usv2-fork-icon" :title="forkSourceLabel(t)">
                <svg viewBox="0 0 24 24" width="11" height="11"><path fill="currentColor" d="M6 4a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm12 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM6 16a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM7 9v4a4 4 0 0 0 4 4h2v-2h-2a2 2 0 0 1-2-2V9H7zm10 0h-2v4h2V9z"/></svg>
              </span>
              <span class="usv2-thread-title">{{ t.title || t.goal || '' }}</span>
              <span class="usv2-unread" v-if="t.unread > 0">{{ t.unread }}</span>
              <button
                v-if="t.id !== 'main'"
                type="button"
                class="usv2-thread-kebab"
                :title="label('mergeInto')"
                @click.stop="onRequestMerge(t)"
              >⋯</button>
            </div>
            <div class="usv2-empty" v-if="grouped.active.length === 0">{{ label('emptyActive') }}</div>
          </div>
        </section>

        <!-- Idle Threads (collapsed by default) -->
        <section class="usv2-group" :class="{ collapsed: !idleOpen }">
          <button type="button" class="usv2-group-header" @click="idleOpen = !idleOpen">
            <svg class="usv2-chevron" :class="{ open: idleOpen }" viewBox="0 0 24 24" width="10" height="10"><path fill="currentColor" d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
            <span class="usv2-group-label">{{ label('idleThreads') }}</span>
            <span class="usv2-group-count">{{ grouped.idle.length }}</span>
          </button>
          <div class="usv2-group-body" v-show="idleOpen">
            <div
              v-for="t in grouped.idle"
              :key="t.id"
              class="usv2-thread"
              :class="{ selected: t.id === activeThreadId }"
              @click="onSelectThread(t)"
              @contextmenu.prevent="onRequestMerge(t)"
            >
              <span class="usv2-dot usv2-dot-idle"></span>
              <span class="usv2-thread-name">#{{ threadDisplayName(t) }}</span>
              <span v-if="t.forkedFrom" class="usv2-fork-icon" :title="forkSourceLabel(t)">
                <svg viewBox="0 0 24 24" width="11" height="11"><path fill="currentColor" d="M6 4a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm12 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM6 16a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM7 9v4a4 4 0 0 0 4 4h2v-2h-2a2 2 0 0 1-2-2V9H7zm10 0h-2v4h2V9z"/></svg>
              </span>
              <span class="usv2-thread-title">{{ t.title || t.goal || '' }}</span>
              <button
                v-if="t.id !== 'main'"
                type="button"
                class="usv2-thread-kebab"
                :title="label('mergeInto')"
                @click.stop="onRequestMerge(t)"
              >⋯</button>
            </div>
            <div class="usv2-empty" v-if="grouped.idle.length === 0">{{ label('emptyIdle') }}</div>
          </div>
        </section>

        <!-- Archived Threads (deeply collapsed) -->
        <section class="usv2-group usv2-group-archived" :class="{ collapsed: !archivedOpen }">
          <button type="button" class="usv2-group-header" @click="archivedOpen = !archivedOpen">
            <svg class="usv2-chevron" :class="{ open: archivedOpen }" viewBox="0 0 24 24" width="10" height="10"><path fill="currentColor" d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
            <span class="usv2-group-label">{{ label('archivedThreads') }}</span>
            <span class="usv2-group-count">{{ grouped.archived.length }}</span>
          </button>
          <div class="usv2-group-body" v-show="archivedOpen">
            <div
              v-for="t in grouped.archived"
              :key="t.id"
              class="usv2-thread usv2-thread-archived"
              :class="{ selected: t.id === activeThreadId }"
              @click="onSelectThread(t)"
            >
              <span class="usv2-dot usv2-dot-archived"></span>
              <span class="usv2-thread-name">#{{ threadDisplayName(t) }}</span>
              <span class="usv2-thread-title">{{ t.title || t.goal || '' }}</span>
            </div>
            <div class="usv2-empty" v-if="grouped.archived.length === 0">{{ label('emptyArchived') }}</div>
          </div>
        </section>

        <!-- Tasks Tree -->
        <section class="usv2-group usv2-group-tasks" v-if="!threadOnlyQuery" :class="{ collapsed: !tasksOpen }">
          <button type="button" class="usv2-group-header" @click="tasksOpen = !tasksOpen">
            <svg class="usv2-chevron" :class="{ open: tasksOpen }" viewBox="0 0 24 24" width="10" height="10"><path fill="currentColor" d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
            <span class="usv2-group-label">{{ label('tasks') }}</span>
            <span class="usv2-group-count">{{ filteredTasks.length }}</span>
          </button>
          <div class="usv2-group-body" v-show="tasksOpen">
            <div v-for="task in filteredTasks" :key="task.id">
              <div
                class="usv2-task usv2-task-lvl-0"
                :class="['usv2-task-status-' + (task.status || 'unknown'), { selected: task.id === activeTaskId }]"
                @click="onSelectTask(task)"
              >
                <span
                  class="usv2-task-toggle"
                  v-if="task.children && task.children.length > 0"
                  @click.stop="toggleTask(task.id)"
                >
                  <svg class="usv2-chevron" :class="{ open: isTaskExpanded(task.id) }" viewBox="0 0 24 24" width="9" height="9"><path fill="currentColor" d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
                </span>
                <span class="usv2-task-toggle-spacer" v-else></span>
                <span class="usv2-task-id">{{ task.id }}</span>
                <span class="usv2-task-title">{{ task.title }}</span>
                <span class="usv2-task-link" v-if="task.threadLink">→ #{{ threadLinkLabel(task.threadLink) }}</span>
              </div>
              <div v-if="isTaskExpanded(task.id) && task.children && task.children.length > 0">
                <div
                  v-for="child in task.children"
                  :key="child.id"
                  class="usv2-task usv2-task-lvl-1"
                  :class="['usv2-task-status-' + (child.status || 'unknown'), { selected: child.id === activeTaskId }]"
                  @click="onSelectTask(child)"
                >
                  <span class="usv2-task-toggle-spacer"></span>
                  <span class="usv2-task-id">{{ child.id }}</span>
                  <span class="usv2-task-title">{{ child.title }}</span>
                </div>
              </div>
            </div>
            <div class="usv2-empty" v-if="filteredTasks.length === 0">{{ label('emptyTasks') }}</div>
          </div>
        </section>

        <!-- task-339-F1: Groups section moved to top of sidebar (see above). -->

        <!-- task-334-ui-d: User Memory section -->
        <section class="usv2-group usv2-group-user-memory" :aria-label="$t('unify.userMemory.sidebarAria')">
          <div class="usv2-group-header">
            <span class="usv2-group-label usv2-user-memory-link" @click="$emit('open-user-memory')">📘 {{ $t('unify.userMemory.sidebarTitle') }}</span>
          </div>
        </section>
      </div>

      <!-- task-313: Merge target picker. Opens when the user triggers a merge
           from a thread row (kebab click or right-click). Lists every other
           non-archived thread as a candidate target. Selecting one advances
           to the irreversible-confirm dialog. Clicking the backdrop cancels. -->
      <div v-if="mergePicker.open" class="usv2-merge-overlay" @click.self="cancelMerge">
        <div class="usv2-merge-panel">
          <div class="usv2-merge-title">{{ label('mergeInto') }}</div>
          <div class="usv2-merge-source">#{{ sourceDisplayName }}</div>
          <div class="usv2-merge-body">
            <div class="usv2-merge-empty" v-if="mergeCandidates.length === 0">{{ label('mergeNoCandidates') }}</div>
            <button
              v-for="c in mergeCandidates"
              :key="c.id"
              type="button"
              class="usv2-merge-candidate"
              @click="pickMergeTarget(c)"
            >
              <span class="usv2-merge-candidate-name">#{{ threadDisplayName(c) }}</span>
              <span class="usv2-merge-candidate-title">{{ c.title || c.goal || '' }}</span>
            </button>
          </div>
          <div class="usv2-merge-actions">
            <button type="button" class="usv2-merge-cancel" @click="cancelMerge">{{ label('cancel') }}</button>
          </div>
        </div>
      </div>

      <!-- task-313: Irreversible confirm dialog. The merge is permanent — the
           source thread is archived and its messages are re-stamped onto the
           target. We explicitly spell that out before the user commits. -->
      <div v-if="mergeConfirm.open" class="usv2-merge-overlay usv2-merge-overlay-confirm" @click.self="cancelMerge">
        <div class="usv2-merge-panel usv2-merge-panel-confirm">
          <div class="usv2-merge-title">{{ label('mergeConfirmTitle') }}</div>
          <div class="usv2-merge-warning">{{ label('mergeIrreversible') }}</div>
          <div class="usv2-merge-summary">
            <span>#{{ confirmSourceName }}</span>
            <span class="usv2-merge-arrow">→</span>
            <span>#{{ confirmTargetName }}</span>
          </div>
          <div class="usv2-merge-actions">
            <button type="button" class="usv2-merge-cancel" @click="cancelMerge">{{ label('cancel') }}</button>
            <button type="button" class="usv2-merge-confirm" @click="confirmMerge">{{ label('mergeConfirm') }}</button>
          </div>
        </div>
      </div>
      <!-- task-334m: Create-group wizard (inline, modal overlay). -->
      <GroupCreateWizard
        v-if="groupWizardOpen"
        @close="groupWizardOpen = false"
        @created="onGroupCreated"
      />

      <!-- task-334m / Bug 8: Delete confirm modal (destructive 2nd-confirm). -->
      <div v-if="deleteConfirm.open" class="usv2-merge-overlay usv2-merge-overlay-confirm" @click.self="cancelGroupAction">
        <div class="usv2-merge-panel usv2-merge-panel-confirm">
          <div class="usv2-merge-title">{{ $t('unify.group.delete') }}</div>
          <div class="usv2-merge-warning">{{ $t('unify.group.deleteConfirm', { name: deleteConfirm.name }) }}</div>
          <div class="usv2-merge-actions">
            <button type="button" class="usv2-merge-cancel" @click="cancelGroupAction" :disabled="deleteConfirm.busy">
              {{ label('cancel') }}
            </button>
            <button type="button" class="usv2-merge-confirm" @click="confirmDeleteGroup" :disabled="deleteConfirm.busy">
              {{ deleteConfirm.busy ? $t('unify.group.deletingEllipsis') : $t('unify.group.delete') }}
            </button>
          </div>
        </div>
      </div>

      <!-- task-334m: Rename modal (inline, mirrors delete-confirm chrome). -->
      <div v-if="renameModal.open" class="usv2-merge-overlay" @click.self="cancelGroupAction">
        <div class="usv2-merge-panel">
          <div class="usv2-merge-title">{{ $t('unify.group.rename') }}</div>
          <div class="usv2-merge-body">
            <label class="usv2-rename-label">
              {{ $t('unify.group.renamePrompt', { name: renameModal.original }) }}
              <input
                type="text"
                v-model.trim="renameModal.value"
                class="usv2-rename-input"
                maxlength="60"
                @keydown.enter.prevent="confirmRenameGroup"
                ref="renameInput"
              />
            </label>
            <div v-if="renameModal.error" class="usv2-rename-error" role="alert">{{ renameModal.error }}</div>
          </div>
          <div class="usv2-merge-actions">
            <button type="button" class="usv2-merge-cancel" @click="cancelGroupAction" :disabled="renameModal.busy">
              {{ label('cancel') }}
            </button>
            <button type="button" class="usv2-merge-confirm" @click="confirmRenameGroup" :disabled="renameModal.busy || !canCommitRename">
              {{ renameModal.busy ? $t('unify.group.renamingEllipsis') : $t('unify.group.rename') }}
            </button>
          </div>
        </div>
      </div>

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
    threadsSource: { type: Array, default: null },
    tasksSource: { type: Array, default: null },
    // task-316: let tests inject messages the same way.
    messagesSource: { type: Array, default: null },
  },
  data() {
    return {
      searchQuery: '',
      activeOpen: true,
      idleOpen: false,
      archivedOpen: false,
      tasksOpen: true,
      expandedTasks: {},
      now: Date.now(),
      // task-313: merge-into flow state.
      //   mergePicker.open  — true while the target picker overlay is showing
      //   mergePicker.sourceId — thread we're merging AWAY from
      //   mergeConfirm.open — true while the irreversible-confirm dialog shows
      //   mergeConfirm.targetId — thread we're merging INTO
      mergePicker: { open: false, sourceId: null },
      mergeConfirm: { open: false, sourceId: null, targetId: null },
      // task-334m: group-create wizard visibility.
      groupWizardOpen: false,
      groupsOpen: true,
      // task-334m prev-2 rev: per-row action menu + rename/delete modals.
      groupMenu: { open: false, groupId: null },
      deleteConfirm: { open: false, groupId: null, name: '', busy: false },
      renameModal: { open: false, groupId: null, original: '', value: '', error: '', busy: false },
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
    canCommitRename() {
      const v = (this.renameModal.value || '').trim();
      return v.length > 0 && v !== this.renameModal.original;
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
    // task-301 Part 2: real-store threads (or injected for tests).
    // Each thread is the serialised shape from
    // agent/unify/web-bridge.js#sendThreadListUpdate.
    threads() {
      if (Array.isArray(this.threadsSource)) return this.threadsSource;
      return this.store?.unifyThreads || [];
    },
    tasks() {
      if (Array.isArray(this.tasksSource)) return this.tasksSource;
      return this.store?.unifyTasks || [];
    },
    activeThreadId() {
      return this.store?.unifyActiveThreadId || null;
    },
    activeTaskId() {
      return this.store?.unifyActiveTaskId || null;
    },
    // Localized placeholder. Falls back gracefully when $t is not injected
    // (e.g. stand-alone unit tests that don't mount the component).
    placeholderText() {
      if (typeof this.$t === 'function') {
        return this.$t('unify.sidebar.searchPlaceholder');
      }
      return 'Search… (#name for threads)';
    },
    // task-316: parser now lives in web/utils/search-parser.js.
    // Returned shape expanded with taskId + status filters; sidebar only
    // reads the fields it needs. Existing tests that depend on the
    // `{ keyword, threadPrefix, scopedField }` subset still pass because
    // those fields are still present.
    parsedQuery() {
      return parseSearchQuery(this.searchQuery || '');
    },
    searchActive() {
      return hasActiveQuery(this.parsedQuery);
    },
    threadOnlyQuery() {
      return this.parsedQuery.threadPrefix !== null;
    },
    filteredThreads() {
      const q = this.parsedQuery;
      if (!hasActiveQuery(q)) return this.threads;
      return this.threads.filter(t => _threadMatches(t, q));
    },
    grouped() {
      const out = { active: [], idle: [], archived: [] };
      for (const t of this.filteredThreads) {
        if (t.archived || t.status === 'archived') {
          out.archived.push(t);
        } else if (t.running || (this.now - (t.lastActivityAt || t.lastMessageAt || 0)) <= DAY_MS) {
          out.active.push(t);
        } else {
          out.idle.push(t);
        }
      }
      const byActivity = (a, b) =>
        (b.lastActivityAt || b.lastMessageAt || 0) - (a.lastActivityAt || a.lastMessageAt || 0);
      out.idle.sort(byActivity);
      out.archived.sort(byActivity);
      out.active.sort((a, b) => {
        if (a.id === 'main') return -1;
        if (b.id === 'main') return 1;
        return byActivity(a, b);
      });
      return out;
    },
    filteredTasks() {
      const q = this.parsedQuery;
      if (q.threadPrefix !== null) return [];
      if (!hasActiveQuery(q)) return this.tasks;
      // Keep task visible when itself OR any descendant matches so the
      // expand-chevron still renders the parent chain in the tree view.
      const matches = (task) => {
        if (_taskMatches(task, q)) return true;
        return (task.children || []).some(matches);
      };
      return this.tasks.filter(matches);
    },
    // task-312/316: flat ranked result list used by the results panel.
    // Threads come first, then tasks (nested children flattened), then
    // — new in task-316 — matching messages when the query includes
    // `in:body kw` or a plain keyword scoped by `task:N`. Grouping is
    // reported separately via `searchGroups` so the template can render
    // labelled sections without duplicating the flatten logic.
    searchResults() {
      if (!this.searchActive) return [];
      const q = this.parsedQuery;
      const { keyword, threadPrefix, scopedField } = q;
      const out = [];
      for (const t of this.filteredThreads) {
        out.push({
          kind: 'thread',
          id: t.id,
          title: t.title || t.goal || '',
          snippet: this.pickThreadSnippet(t, keyword, threadPrefix, scopedField),
          thread: t,
        });
      }
      if (threadPrefix === null) {
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
      }
      // Message hits — only included when query could meaningfully
      // match message content (task:N with any keyword, or in:body kw).
      if (threadPrefix === null && (q.taskId || q.scopedField === 'body')) {
        const msgs = this.messages || [];
        for (const m of msgs) {
          if (_messageMatches(m, q)) {
            out.push({
              kind: 'message',
              id: m.id || `msg-${out.length}`,
              title: this.truncate(typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''), 80),
              snippet: m.threadName ? `#${m.threadName}` : (m.threadId || ''),
              message: m,
            });
          }
        }
      }
      return out;
    },
    // task-313: merge target candidates. Excludes the source, the main
    // thread is always eligible as a target (you can fold a side-thread
    // back into the main inbox), archived threads are filtered out.
    mergeCandidates() {
      const src = this.mergePicker.sourceId;
      if (!src) return [];
      return this.threads.filter((t) => {
        if (t.id === src) return false;
        if (t.archived || t.status === 'archived') return false;
        return true;
      });
    },
    sourceDisplayName() {
      const t = this.threads.find((x) => x.id === this.mergePicker.sourceId);
      return t ? this.threadDisplayName(t) : '';
    },
    confirmSourceName() {
      const t = this.threads.find((x) => x.id === this.mergeConfirm.sourceId);
      return t ? this.threadDisplayName(t) : '';
    },
    confirmTargetName() {
      const t = this.threads.find((x) => x.id === this.mergeConfirm.targetId);
      return t ? this.threadDisplayName(t) : '';
    },
    // task-316: parallel grouping view for the template — splits the
    // flat searchResults into {threads, tasks, messages}. Groups with
    // zero entries are omitted by the template's v-if check.
    searchGroups() {
      const groups = { threads: [], tasks: [], messages: [] };
      for (const r of this.searchResults) {
        if (r.kind === 'thread') groups.threads.push(r);
        else if (r.kind === 'task') groups.tasks.push(r);
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
        activeThreads: 'Active',
        idleThreads: 'Idle',
        archivedThreads: 'Archived',
        tasks: 'Tasks',
        emptyActive: 'No active threads',
        emptyIdle: 'No idle threads',
        emptyArchived: 'No archived threads',
        emptyTasks: 'No tasks match',
        results: 'Results',
        resultsThreads: 'Threads',
        resultsTasks: 'Tasks',
        resultsMessages: 'Messages',
        emptyResults: 'No matches',
        kindThread: 'thread',
        kindTask: 'task',
        kindMessage: 'msg',
        clearSearch: 'Clear',
        mergeInto: 'Merge into…',
        mergeNoCandidates: 'No other threads to merge into',
        mergeConfirmTitle: 'Merge this thread?',
        mergeIrreversible: 'This cannot be undone. The source thread will be archived and its messages moved to the target.',
        mergeConfirm: 'Merge',
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
        if (ev && ev.target && ev.target.closest && ev.target.closest('.usv2-group-row-menu')) return;
        this.groupMenu = { open: false, groupId: null };
        window.removeEventListener('click', close, true);
      };
      setTimeout(() => window.addEventListener('click', close, true), 0);
      if (evt && typeof evt.stopPropagation === 'function') evt.stopPropagation();
    },
    startManageMembers(g) {
      // task-fix-group-member-editor: bubble up to UnifyPage which owns
      // the GroupMemberEditor modal. Sidebar stays a pure trigger so the
      // editor lifecycle is centralized at the page level.
      this.groupMenu = { open: false, groupId: null };
      if (!g || !g.id) return;
      this.$emit('manage-members', g.id);
    },
    startRenameGroup(g) {
      this.groupMenu = { open: false, groupId: null };
      if (!g || !g.id) return;
      const display = this.groupDisplayName(g);
      this.renameModal = {
        open: true, groupId: g.id,
        original: display,
        value: display,
        error: '', busy: false,
      };
      this.$nextTick(() => {
        const el = this.$refs.renameInput;
        if (el && typeof el.focus === 'function') el.focus();
      });
    },
    startDeleteGroup(g) {
      this.groupMenu = { open: false, groupId: null };
      if (!g || !g.id) return;
      this.deleteConfirm = {
        open: true, groupId: g.id,
        name: this.groupDisplayName(g),
        busy: false,
      };
    },
    cancelGroupAction() {
      if (this.deleteConfirm.busy || this.renameModal.busy) return;
      this.deleteConfirm = { open: false, groupId: null, name: '', busy: false };
      this.renameModal = { open: false, groupId: null, original: '', value: '', error: '', busy: false };
    },
    async confirmDeleteGroup() {
      const id = this.deleteConfirm.groupId;
      if (!id || this.deleteConfirm.busy) return;
      const chat = this.chatStore;
      if (!chat || typeof chat.groupCrudRequest !== 'function') {
        this.deleteConfirm.open = false;
        return;
      }
      this.deleteConfirm.busy = true;
      try {
        await chat.groupCrudRequest('delete', { groupId: id });
      } finally {
        this.deleteConfirm = { open: false, groupId: null, name: '', busy: false };
      }
    },
    async confirmRenameGroup() {
      if (!this.canCommitRename || this.renameModal.busy) return;
      const id = this.renameModal.groupId;
      const name = (this.renameModal.value || '').trim();
      const chat = this.chatStore;
      if (!chat || typeof chat.groupCrudRequest !== 'function') {
        this.renameModal.open = false;
        return;
      }
      this.renameModal.busy = true;
      this.renameModal.error = '';
      try {
        const res = await chat.groupCrudRequest('rename', { groupId: id, name });
        if (res && res.ok) {
          this.renameModal = { open: false, groupId: null, original: '', value: '', error: '', busy: false };
          return;
        }
        const code = (res && res.error && res.error.code) || 'unknown';
        const key = `unify.group.error.${code}`;
        const translated = typeof this.$t === 'function' ? this.$t(key) : key;
        this.renameModal.error = translated === key
          ? (typeof this.$t === 'function'
              ? this.$t('unify.group.error.unknown', { message: (res && res.error && res.error.message) || '' })
              : 'Operation failed')
          : translated;
      } catch (err) {
        this.renameModal.error = typeof this.$t === 'function'
          ? this.$t('unify.group.error.unknown', { message: err && err.message || String(err) })
          : 'Operation failed';
      } finally {
        this.renameModal.busy = false;
      }
    },
    // Display label for a thread row. The "main" thread (internal id
    // never changes) is shown as the localized "Inbox" label; all other
    // threads use their `name`.
    threadDisplayName(t) {
      if (t && t.id === 'main') {
        if (typeof this.$t === 'function') return this.$t('unify.inbox');
        return 'Inbox';
      }
      return t ? t.name : '';
    },
    // task-fix (5-bugs): explain what the Inbox thread is. Users asked
    // "收件箱 is what?" — this tooltip makes it explicit that `main` is
    // the default personal thread (1:1 with Unify), not a message queue.
    threadTooltip(t) {
      if (t && t.id === 'main') {
        if (typeof this.$t === 'function') return this.$t('unify.inbox.tooltip');
        return 'Your default thread — one-on-one chat with Unify.';
      }
      return t ? (t.title || t.goal || t.name || '') : '';
    },
    isTaskExpanded(id) {
      return !!this.expandedTasks[id];
    },
    threadLinkLabel(threadId) {
      const match = this.threads.find((t) => t.id === threadId);
      return match ? match.name : threadId;
    },
    // task-314: tooltip for sidebar fork icon
    forkSourceLabel(t) {
      if (!t || !t.forkedFrom) return '';
      const srcId = t.forkedFrom.threadId;
      const src = this.threads.find((x) => x.id === srcId);
      const name = src ? (src.id === 'main' ? 'Inbox' : src.name) : srcId;
      return `Forked from #${name}`;
    },
    toggleTask(id) {
      this.expandedTasks = { ...this.expandedTasks, [id]: !this.expandedTasks[id] };
    },
    onSelectThread(t) {
      this.$emit('select-thread', t.id);
    },
    onSelectTask(task) {
      this.$emit('select-task', task.id);
    },
    // task-312/316: unified click-through from the Results list.
    onSelectResult(r) {
      if (r.kind === 'thread') {
        this.$emit('select-thread', r.id);
        const kw = this.parsedQuery.keyword;
        if (kw) {
          this.$emit('jump-to-message', { threadId: r.id, keyword: kw });
        }
      } else if (r.kind === 'message') {
        // Message hit → switch to its thread (if known) and ask the
        // chat stream to scroll to this specific message id.
        const tid = r.message && r.message.threadId;
        if (tid) this.$emit('select-thread', tid);
        this.$emit('jump-to-message', {
          threadId: tid || null,
          messageId: r.message && r.message.id,
          keyword: this.parsedQuery.keyword || '',
        });
      } else {
        this.$emit('select-task', r.id);
      }
    },
    // task-312: Esc in the search box clears + asks parent to refocus
    // the chat input. Plain string empty also exits the results view.
    onSearchEscape() {
      this.searchQuery = '';
      this.$emit('search-escape');
    },
    // -------- snippet helpers (task-312) --------
    pickThreadSnippet(t, keyword, threadPrefix, scopedField) {
      if (threadPrefix) return '';
      const kw = keyword || '';
      if (!kw) return '';
      const candidates = scopedField === 'title'
        ? [t.title]
        : scopedField === 'summary'
          ? [t.goal, t.preview]
          : [t.title, t.goal, t.preview];
      for (const txt of candidates) {
        if (txt && String(txt).toLowerCase().includes(kw)) {
          return this.truncate(String(txt));
        }
      }
      return '';
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
    taskMatchesDirect(task, keyword, scopedField) {
      const kw = (keyword || '').toLowerCase();
      if (!kw) return true;
      if (scopedField === 'title') {
        return (task.title || '').toLowerCase().includes(kw)
          || (task.id || '').toLowerCase().includes(kw);
      }
      if (scopedField === 'summary') {
        return (task.summary || '').toLowerCase().includes(kw)
          || (task.description || '').toLowerCase().includes(kw);
      }
      return (task.title || '').toLowerCase().includes(kw)
        || (task.id || '').toLowerCase().includes(kw)
        || (task.summary || '').toLowerCase().includes(kw)
        || (task.description || '').toLowerCase().includes(kw);
    },
    truncate(s, n = 80) {
      if (!s) return '';
      return s.length > n ? s.slice(0, n - 1) + '…' : s;
    },
    // -------- merge flow (task-313) --------
    // Open the target-picker for `thread`. Main/inbox thread is not a valid
    // source because its id is hard-coded everywhere; archived threads are
    // also skipped so users don't re-merge something that is already merged.
    onRequestMerge(thread) {
      if (!thread || thread.id === 'main') return;
      if (thread.archived || thread.status === 'archived') return;
      this.mergePicker = { open: true, sourceId: thread.id };
    },
    pickMergeTarget(target) {
      if (!target) return;
      this.mergeConfirm = {
        open: true,
        sourceId: this.mergePicker.sourceId,
        targetId: target.id,
      };
      this.mergePicker = { open: false, sourceId: null };
    },
    confirmMerge() {
      const { sourceId, targetId } = this.mergeConfirm;
      if (sourceId && targetId && sourceId !== targetId) {
        this.$emit('merge-thread', { sourceId, targetId });
        if (this.store && typeof this.store.mergeUnifyThread === 'function') {
          this.store.mergeUnifyThread(sourceId, targetId);
        }
      }
      this.mergeConfirm = { open: false, sourceId: null, targetId: null };
    },
    cancelMerge() {
      this.mergePicker = { open: false, sourceId: null };
      this.mergeConfirm = { open: false, sourceId: null, targetId: null };
    }
  }
};
