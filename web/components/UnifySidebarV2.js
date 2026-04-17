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
  emits: ['select-thread', 'select-task', 'jump-to-message', 'search-escape', 'merge-thread'],
  template: `
    <aside class="unify-sidebar-v2">
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

      <!-- task-312: unified search results list. Shown whenever a query is
           active; hides the Active/Idle/Archived/Tasks sections so the user
           sees a single flat ranked list with click-to-jump semantics. -->
      <div class="usv2-scroll" v-if="searchActive">
        <section class="usv2-group usv2-group-results">
          <div class="usv2-group-header usv2-results-header">
            <span class="usv2-group-label">{{ label('results') }}</span>
            <span class="usv2-group-count">{{ searchResults.length }}</span>
          </div>
          <div class="usv2-group-body">
            <div
              v-for="r in searchResults"
              :key="r.kind + ':' + r.id"
              class="usv2-result"
              :class="'usv2-result-' + r.kind"
              @click="onSelectResult(r)"
            >
              <span class="usv2-result-kind">{{ label(r.kind === 'thread' ? 'kindThread' : 'kindTask') }}</span>
              <span class="usv2-result-name" v-if="r.kind === 'thread'">#{{ threadDisplayName(r.thread) }}</span>
              <span class="usv2-result-name" v-else>{{ r.task.id }}</span>
              <span class="usv2-result-title">{{ r.title }}</span>
              <span class="usv2-result-snippet" v-if="r.snippet">{{ r.snippet }}</span>
            </div>
            <div class="usv2-empty" v-if="searchResults.length === 0">{{ label('emptyResults') }}</div>
          </div>
        </section>
      </div>

      <div class="usv2-scroll" v-else>
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
              @contextmenu.prevent="onRequestMerge(t)"
            >
              <span class="usv2-dot usv2-dot-active" :class="{ running: t.running }"></span>
              <span class="usv2-thread-name">#{{ threadDisplayName(t) }}</span>
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
      // task-313: merge-into flow state.
      //   mergePicker.open  — true while the target picker overlay is showing
      //   mergePicker.sourceId — thread we're merging AWAY from
      //   mergeConfirm.open — true while the irreversible-confirm dialog shows
      //   mergeConfirm.targetId — thread we're merging INTO
      mergePicker: { open: false, sourceId: null },
      mergeConfirm: { open: false, sourceId: null, targetId: null },
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
    // task-312: parser now recognises three mutually-exclusive prefixes:
    //   #<name>        → only match thread by name (hides tasks)
    //   in:<field> kw  → scope the keyword to a single field
    //   plain keyword  → full-text over name/title/goal/summary/preview
    //
    // Returned shape:
    //   { keyword, threadPrefix, scopedField }
    //   - keyword: lowercase search term (or '' when threadPrefix set)
    //   - threadPrefix: lowercased name substring, or null
    //   - scopedField: 'title' | 'summary' | null
    parsedQuery() {
      const raw = (this.searchQuery || '').trim();
      if (!raw) return { keyword: '', threadPrefix: null, scopedField: null };
      if (raw.startsWith('#') && raw.length > 1) {
        return { keyword: '', threadPrefix: raw.slice(1).toLowerCase(), scopedField: null };
      }
      // `in:<field> rest…` — field is bare alphanum identifier.
      const inMatch = raw.match(/^in:([a-zA-Z]+)\s+(.+)$/);
      if (inMatch) {
        const field = inMatch[1].toLowerCase();
        const kw = inMatch[2].trim().toLowerCase();
        // Only whitelisted scope fields are honoured; anything else falls
        // through to plain keyword to avoid silently dropping the query.
        if (field === 'title' || field === 'summary') {
          return { keyword: kw, threadPrefix: null, scopedField: field };
        }
      }
      return { keyword: raw.toLowerCase(), threadPrefix: null, scopedField: null };
    },
    searchActive() {
      const { keyword, threadPrefix } = this.parsedQuery;
      return !!(keyword || threadPrefix);
    },
    threadOnlyQuery() {
      return this.parsedQuery.threadPrefix !== null;
    },
    filteredThreads() {
      const { keyword, threadPrefix, scopedField } = this.parsedQuery;
      return this.threads.filter((t) => {
        if (threadPrefix !== null) {
          return (t.name || '').toLowerCase().includes(threadPrefix);
        }
        if (!keyword) return true;
        if (scopedField === 'title') {
          return (t.title || '').toLowerCase().includes(keyword);
        }
        if (scopedField === 'summary') {
          // "summary" for a thread maps to its goal/preview long text.
          return (t.goal || '').toLowerCase().includes(keyword)
            || (t.preview || '').toLowerCase().includes(keyword);
        }
        return (t.name || '').toLowerCase().includes(keyword)
          || (t.title || '').toLowerCase().includes(keyword)
          || (t.goal || '').toLowerCase().includes(keyword)
          || (t.preview || '').toLowerCase().includes(keyword);
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
      const { keyword, threadPrefix, scopedField } = this.parsedQuery;
      if (threadPrefix !== null) return [];
      if (!keyword) return this.tasks;
      const kw = keyword;
      // scopedField semantics for tasks:
      //   title   → match only task.title / task.id
      //   summary → match only task.summary / task.description
      //   null    → match any of the above (plus recursively children)
      const matches = (task) => {
        let self = false;
        if (scopedField === 'title') {
          self = (task.title || '').toLowerCase().includes(kw)
            || (task.id || '').toLowerCase().includes(kw);
        } else if (scopedField === 'summary') {
          self = (task.summary || '').toLowerCase().includes(kw)
            || (task.description || '').toLowerCase().includes(kw);
        } else {
          self = (task.title || '').toLowerCase().includes(kw)
            || (task.id || '').toLowerCase().includes(kw)
            || (task.summary || '').toLowerCase().includes(kw)
            || (task.description || '').toLowerCase().includes(kw);
        }
        if (self) return true;
        return (task.children || []).some(matches);
      };
      return this.tasks.filter(matches);
    },
    // task-312: flat ranked result list used by the results panel.
    // Threads come first, then tasks (including nested children matched
    // by filteredTasks). Each entry carries a short snippet pulled from
    // whichever field triggered the match, for visual confirmation.
    searchResults() {
      if (!this.searchActive) return [];
      const { keyword, threadPrefix, scopedField } = this.parsedQuery;
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
        const flatten = (task, depth = 0) => {
          const matched = this.taskMatchesDirect(task, keyword, scopedField);
          if (matched) {
            out.push({
              kind: 'task',
              id: task.id,
              title: task.title || '',
              snippet: this.pickTaskSnippet(task, keyword, scopedField),
              task,
            });
          }
          for (const c of (task.children || [])) flatten(c, depth + 1);
        };
        for (const task of this.filteredTasks) flatten(task, 0);
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
        emptyResults: 'No matches',
        kindThread: 'thread',
        kindTask: 'task',
        clearSearch: 'Clear',
        mergeInto: 'Merge into…',
        mergeNoCandidates: 'No other threads to merge into',
        mergeConfirmTitle: 'Merge this thread?',
        mergeIrreversible: 'This cannot be undone. The source thread will be archived and its messages moved to the target.',
        mergeConfirm: 'Merge',
        cancel: 'Cancel',
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
    },
    // task-312: unified click-through from the Results list.
    // Thread hit → select + ask MessageList to scroll/highlight the first
    // message whose text matches the keyword. Task hit → delegate to the
    // regular select-task path (task-detail deep-link lands in task-315).
    onSelectResult(r) {
      if (r.kind === 'thread') {
        this.$emit('select-thread', r.id);
        const kw = this.parsedQuery.keyword;
        if (kw) {
          this.$emit('jump-to-message', { threadId: r.id, keyword: kw });
        }
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
