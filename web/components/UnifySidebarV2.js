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

export default {
  name: 'UnifySidebarV2',
  emits: ['select-thread', 'select-task'],
  template: `
    <aside class="unify-sidebar-v2">
      <div class="usv2-search">
        <svg class="usv2-search-icon" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
        <input
          type="text"
          class="usv2-search-input"
          v-model="searchQuery"
          :placeholder="placeholderText"
        />
      </div>

      <div class="usv2-scroll">
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
              @click="onSelectThread(t)"
            >
              <span class="usv2-dot usv2-dot-active" :class="{ running: t.running }"></span>
              <span class="usv2-thread-name">#{{ threadDisplayName(t) }}</span>
              <span class="usv2-thread-title">{{ t.title || t.goal || '' }}</span>
              <span class="usv2-unread" v-if="t.unread > 0">{{ t.unread }}</span>
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
            >
              <span class="usv2-dot usv2-dot-idle"></span>
              <span class="usv2-thread-name">#{{ threadDisplayName(t) }}</span>
              <span class="usv2-thread-title">{{ t.title || t.goal || '' }}</span>
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
      </div>
    </aside>
  `,
  props: {
    // Optional injection hooks — primarily for unit tests that don't
    // mount Pinia. When null the component reads from store.
    threadsSource: { type: Array, default: null },
    tasksSource: { type: Array, default: null },
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
    };
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
    parsedQuery() {
      const raw = (this.searchQuery || '').trim();
      if (!raw) return { keyword: '', threadPrefix: null };
      if (raw.startsWith('#') && raw.length > 1) {
        return { keyword: '', threadPrefix: raw.slice(1).toLowerCase() };
      }
      return { keyword: raw.toLowerCase(), threadPrefix: null };
    },
    threadOnlyQuery() {
      return this.parsedQuery.threadPrefix !== null;
    },
    filteredThreads() {
      const { keyword, threadPrefix } = this.parsedQuery;
      return this.threads.filter((t) => {
        if (threadPrefix !== null) {
          return (t.name || '').toLowerCase().includes(threadPrefix);
        }
        if (!keyword) return true;
        return (t.name || '').toLowerCase().includes(keyword)
          || (t.title || '').toLowerCase().includes(keyword)
          || (t.goal || '').toLowerCase().includes(keyword);
      });
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
      const { keyword, threadPrefix } = this.parsedQuery;
      if (threadPrefix !== null) return [];
      if (!keyword) return this.tasks;
      const kw = keyword;
      const matches = (task) => {
        const self = (task.title || '').toLowerCase().includes(kw)
          || (task.id || '').toLowerCase().includes(kw);
        if (self) return true;
        return (task.children || []).some(matches);
      };
      return this.tasks.filter(matches);
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
      };
      return fallback[key] || full;
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
    isTaskExpanded(id) {
      return !!this.expandedTasks[id];
    },
    threadLinkLabel(threadId) {
      const match = this.threads.find((t) => t.id === threadId);
      return match ? match.name : threadId;
    },
    toggleTask(id) {
      this.expandedTasks = { ...this.expandedTasks, [id]: !this.expandedTasks[id] };
    },
    onSelectThread(t) {
      this.$emit('select-thread', t.id);
    },
    onSelectTask(task) {
      this.$emit('select-task', task.id);
    }
  }
};
