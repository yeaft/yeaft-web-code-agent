/**
 * UserMemoryPage.js — task-334-ui-d R6 User Memory browser.
 *
 * Displays all user-memory entries grouped by shard. Supports:
 *   - Browse by shard (tab-like filter)
 *   - Pin/unpin toggle per entry
 *   - Delete entry (with confirm)
 *   - Empty state when 334l-core hasn't shipped yet
 *
 * WS events sent:
 *   unify_user_memory_write  { text, tags, pinned, requestId }
 *   unify_user_memory_remove { entryId, requestId }
 */

export default {
  name: 'UserMemoryPage',
  emits: ['back'],
  template: `
    <div class="user-memory-page" role="region" :aria-label="$t('unify.userMemory.title')">
      <div class="um-breadcrumb">
        <button
          class="um-back"
          type="button"
          :aria-label="$t('unify.userMemory.backAria')"
          :title="$t('unify.userMemory.backAria')"
          @click="$emit('back')"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/>
          </svg>
          <span>{{ $t('unify.userMemory.back') }}</span>
        </button>
        <h2 class="um-title">{{ $t('unify.userMemory.title') }}</h2>
        <span class="um-count" v-if="scopeEntries.length > 0">{{ $t('unify.userMemory.count', { count: scopeEntries.length }) }}</span>
        <span class="um-spacer"></span>
        <button type="button" class="um-scope-refresh" @click="refreshScope" :title="$t('unify.userMemory.backAria')">↻</button>
      </div>

      <!-- task-fix: single unified view — Memory entries from
           ~/.yeaft/memory/entries/*.md, organised as a folder tree by
           their 'scope' frontmatter (e.g. "work/claude-web-chat/auth").
           Replaces the previous stacked layout (pinned-entries view +
           folder view) which rendered two empty/loading sections at
           once and confused the user. -->
      <section class="um-scope-section">
        <!-- Loading: snapshot request still in flight. -->
        <div class="um-empty" v-if="!scopeLoaded">
          <p>{{ $t('unify.userMemory.loading') }}</p>
        </div>

        <!-- Empty: snapshot returned no entries. -->
        <div class="um-empty" v-else-if="scopeEntries.length === 0">
          <p>{{ $t('unify.userMemory.empty') }}</p>
          <p class="um-empty-hint">{{ $t('unify.userMemory.emptyHint') }}</p>
        </div>

        <!-- Folder tree. -->
        <ul class="um-scope-tree" v-else>
          <li v-for="node in scopeTree" :key="node.path" class="um-scope-node">
            <div class="um-scope-folder" @click="toggleFolder(node.path)">
              <span class="um-scope-toggle">{{ expanded[node.path] ? '▾' : '▸' }}</span>
              <span class="um-scope-folder-name">{{ node.label }}</span>
              <span class="um-scope-folder-count">({{ node.totalCount }})</span>
            </div>
            <div v-if="expanded[node.path]" class="um-scope-folder-body">
              <ul v-if="node.entries.length > 0" class="um-scope-entries">
                <li
                  v-for="entry in node.entries"
                  :key="entry.name"
                  class="um-scope-entry"
                  :class="{ 'is-open': openEntry === node.path + '/' + entry.name }"
                  @click.stop="toggleEntry(node.path + '/' + entry.name)"
                >
                  <div class="um-scope-entry-header">
                    <span class="um-scope-entry-name">{{ entry.name }}</span>
                    <span class="um-scope-entry-kind" v-if="entry.kind">{{ entry.kind }}</span>
                    <span class="um-scope-entry-imp" v-if="entry.importance">{{ entry.importance }}</span>
                  </div>
                  <div class="um-scope-entry-tags" v-if="entry.tags && entry.tags.length">
                    <span class="um-scope-entry-tag" v-for="tag in entry.tags" :key="tag">#{{ tag }}</span>
                  </div>
                  <div class="um-scope-entry-body" v-if="entry.content">
                    {{ openEntry === node.path + '/' + entry.name
                        ? fullBody(entry.content)
                        : truncateBody(entry.content) }}
                  </div>
                </li>
              </ul>
              <ul v-if="node.children.length > 0" class="um-scope-children">
                <li v-for="child in node.children" :key="child.path" class="um-scope-node">
                  <div class="um-scope-folder" @click.stop="toggleFolder(child.path)">
                    <span class="um-scope-toggle">{{ expanded[child.path] ? '▾' : '▸' }}</span>
                    <span class="um-scope-folder-name">{{ child.label }}</span>
                    <span class="um-scope-folder-count">({{ child.totalCount }})</span>
                  </div>
                  <div v-if="expanded[child.path]" class="um-scope-folder-body">
                    <ul v-if="child.entries.length > 0" class="um-scope-entries">
                      <li
                        v-for="entry in child.entries"
                        :key="entry.name"
                        class="um-scope-entry"
                        :class="{ 'is-open': openEntry === child.path + '/' + entry.name }"
                        @click.stop="toggleEntry(child.path + '/' + entry.name)"
                      >
                        <div class="um-scope-entry-header">
                          <span class="um-scope-entry-name">{{ entry.name }}</span>
                          <span class="um-scope-entry-kind" v-if="entry.kind">{{ entry.kind }}</span>
                        </div>
                        <div class="um-scope-entry-tags" v-if="entry.tags && entry.tags.length">
                          <span class="um-scope-entry-tag" v-for="tag in entry.tags" :key="tag">#{{ tag }}</span>
                        </div>
                        <div class="um-scope-entry-body" v-if="entry.content">
                          {{ openEntry === child.path + '/' + entry.name
                              ? fullBody(entry.content)
                              : truncateBody(entry.content) }}
                        </div>
                      </li>
                    </ul>
                  </div>
                </li>
              </ul>
            </div>
          </li>
        </ul>
      </section>
    </div>
  `,

  setup(props, { emit }) {
    const store = Vue.inject('store');

    // task-fix: local expand state for the scope-tree folder view.
    const expanded = Vue.reactive({});
    // task-fix: which scope entry is currently expanded to show full content.
    const openEntry = Vue.ref(null);

    // ── Helpers ───────────────────────────────────────────

    function genRequestId() {
      return 'umr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    }

    // ── task-fix: scope-tree (memory folder view) ─────────────

    const scopeEntries = Vue.computed(() => store?.unifyMemoryScopeEntries || []);
    const scopeLoaded = Vue.computed(() => !!store?.unifyMemoryScopeLoaded);

    /**
     * Build a folder tree from flat entry list.
     * Entries are grouped by their `scope` path (e.g. "work/claude-web-chat/auth")
     * into nested folders. Top-level grouping is on the first path segment;
     * deeper segments collapse into a single child folder (simple two-level
     * tree is enough for real usage; deeper paths flatten into the child).
     */
    const scopeTree = Vue.computed(() => {
      const roots = new Map();
      for (const e of scopeEntries.value) {
        const scopePath = (e && typeof e.scope === 'string' && e.scope.length > 0)
          ? e.scope
          : 'uncategorized';
        const parts = scopePath.split('/').filter(Boolean);
        const top = parts[0] || 'uncategorized';
        if (!roots.has(top)) {
          roots.set(top, {
            path: top,
            label: top,
            entries: [],
            childMap: new Map(),
            totalCount: 0,
          });
        }
        const rootNode = roots.get(top);
        rootNode.totalCount++;
        if (parts.length <= 1) {
          rootNode.entries.push(e);
        } else {
          const childKey = parts.slice(1).join('/');
          if (!rootNode.childMap.has(childKey)) {
            rootNode.childMap.set(childKey, {
              path: `${top}/${childKey}`,
              label: childKey,
              entries: [],
              totalCount: 0,
              children: [],
            });
          }
          const childNode = rootNode.childMap.get(childKey);
          childNode.entries.push(e);
          childNode.totalCount++;
        }
      }
      return [...roots.values()]
        .map(r => ({
          path: r.path,
          label: r.label,
          entries: r.entries,
          totalCount: r.totalCount,
          children: [...r.childMap.values()].sort((a, b) => a.label.localeCompare(b.label)),
        }))
        .sort((a, b) => a.label.localeCompare(b.label));
    });

    function toggleFolder(path) {
      expanded[path] = !expanded[path];
    }

    function refreshScope() {
      if (store && typeof store.fetchUnifyMemoryScope === 'function') {
        store.fetchUnifyMemoryScope();
      }
    }

    function truncateBody(text) {
      if (!text) return '';
      const s = String(text).replace(/^#+\s.*\n/, '').trim();
      if (s.length <= 200) return s;
      return s.slice(0, 200) + '…';
    }

    function fullBody(text) {
      if (!text) return '';
      return String(text).replace(/^#+\s.*\n/, '').trim();
    }

    function toggleEntry(key) {
      openEntry.value = openEntry.value === key ? null : key;
    }

    // Auto-fetch on mount; agents that ignore the message keep the view
    // empty rather than breaking the page.
    Vue.onMounted(() => {
      refreshScope();
    });

    return {
      expanded,
      openEntry,
      scopeEntries,
      scopeLoaded,
      scopeTree,
      toggleFolder,
      toggleEntry,
      refreshScope,
      truncateBody,
      fullBody,
    };
  },
};
