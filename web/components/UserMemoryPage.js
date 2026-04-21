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
        <span class="um-count" v-if="entryCount > 0">{{ $t('unify.userMemory.count', { count: entryCount }) }}</span>
      </div>

      <!-- Shard filter tabs -->
      <div class="um-shard-tabs" v-if="shardNames.length > 0" role="tablist">
        <button
          type="button"
          role="tab"
          class="um-shard-tab"
          :class="{ active: activeShard === null }"
          :aria-selected="activeShard === null ? 'true' : 'false'"
          @click="activeShard = null"
        >{{ $t('unify.userMemory.allShards') }}</button>
        <button
          v-for="shard in shardNames"
          :key="shard"
          type="button"
          role="tab"
          class="um-shard-tab"
          :class="{ active: activeShard === shard }"
          :aria-selected="activeShard === shard ? 'true' : 'false'"
          @click="activeShard = shard"
        >{{ shardLabel(shard) }}</button>
      </div>

      <!-- Entry list -->
      <div class="um-entries" v-if="filteredEntries.length > 0">
        <div
          v-for="entry in filteredEntries"
          :key="entry.id"
          class="um-entry"
          :class="{ pinned: entry.pinned }"
        >
          <div class="um-entry-header">
            <span class="um-entry-shard">{{ shardLabel(entry.shard) }}</span>
            <span class="um-entry-kind" v-if="entry.kind">{{ entry.kind }}</span>
            <span class="um-entry-tags" v-if="entry.tags && entry.tags.length">
              <span class="um-entry-tag" v-for="tag in entry.tags" :key="tag">{{ tag }}</span>
            </span>
            <span class="um-entry-spacer"></span>
            <button
              type="button"
              class="um-entry-pin"
              :class="{ active: entry.pinned }"
              :title="entry.pinned ? $t('unify.userMemory.unpin') : $t('unify.userMemory.pin')"
              :aria-label="entry.pinned ? $t('unify.userMemory.unpin') : $t('unify.userMemory.pin')"
              @click="onTogglePin(entry)"
            >📌</button>
            <button
              type="button"
              class="um-entry-delete"
              :title="$t('unify.userMemory.delete')"
              :aria-label="$t('unify.userMemory.delete')"
              @click="onDelete(entry)"
            >🗑</button>
          </div>
          <div class="um-entry-body">{{ entry.body }}</div>
          <div class="um-entry-meta">
            <span class="um-entry-author" v-if="entry.authoredBy">{{ entry.authoredBy }}</span>
            <span class="um-entry-time" v-if="entry.updatedAt" :title="entry.updatedAt">{{ formatTime(entry.updatedAt) }}</span>
          </div>
        </div>
      </div>

      <!-- Empty state -->
      <div class="um-empty" v-else>
        <p>{{ $t('unify.userMemory.empty') }}</p>
        <p class="um-empty-hint">{{ $t('unify.userMemory.emptyHint') }}</p>
      </div>

      <!-- Delete confirm modal -->
      <div v-if="deleteConfirm.open" class="um-delete-overlay" @click.self="cancelDelete">
        <div class="um-delete-panel">
          <p>{{ $t('unify.userMemory.deleteConfirm') }}</p>
          <div class="um-delete-preview">{{ deleteConfirm.body }}</div>
          <div class="um-delete-actions">
            <button type="button" class="um-delete-cancel" @click="cancelDelete">{{ $t('common.cancel') }}</button>
            <button type="button" class="um-delete-confirm" @click="confirmDelete">{{ $t('common.delete') }}</button>
          </div>
        </div>
      </div>
    </div>
  `,

  setup(props, { emit }) {
    const store = Vue.inject('store');
    const umStore = window.Pinia?.useUserMemoryStore?.()
      || (window.__useUserMemoryStore && window.__useUserMemoryStore());

    const activeShard = Vue.ref(null);
    const deleteConfirm = Vue.reactive({ open: false, entryId: null, body: '' });

    // ── Getters ───────────────────────────────────────────

    const entryList = Vue.computed(() => umStore?.entryList || []);
    const shardNames = Vue.computed(() => umStore?.shardNames || []);
    const entryCount = Vue.computed(() => umStore?.entryCount || 0);

    const filteredEntries = Vue.computed(() => {
      if (!activeShard.value) return entryList.value;
      return entryList.value.filter(e => (e.shard || 'general') === activeShard.value);
    });

    // ── Helpers ───────────────────────────────────────────

    function shardLabel(shard) {
      const labels = {
        profile: '👤 Profile',
        preferences: '⚙️ Preferences',
        projects: '📂 Projects',
        goals: '🎯 Goals',
        relations: '🤝 Relations',
        general: '📝 General',
      };
      return labels[shard] || shard;
    }

    function formatTime(iso) {
      if (!iso) return '';
      try {
        const d = new Date(iso);
        const now = new Date();
        const diff = now - d;
        if (diff < 60000) return 'just now';
        if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
        if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
        return d.toLocaleDateString();
      } catch { return iso; }
    }

    function genRequestId() {
      return 'umr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    }

    // ── Actions ───────────────────────────────────────────

    function onTogglePin(entry) {
      if (!entry || !entry.id) return;
      // Optimistic update in store
      if (umStore) umStore.togglePin(entry.id);

      // Send WS event
      const requestId = genRequestId();
      if (umStore) umStore.markPending(requestId, 'pin');
      try {
        store.sendMessage({
          type: 'unify_user_memory_write',
          entryId: entry.id,
          pinned: entry.pinned,
          text: entry.body || '',
          requestId,
        });
      } catch { /* best-effort */ }
    }

    function onDelete(entry) {
      if (!entry) return;
      deleteConfirm.open = true;
      deleteConfirm.entryId = entry.id;
      deleteConfirm.body = (entry.body || '').slice(0, 200);
    }

    function cancelDelete() {
      deleteConfirm.open = false;
      deleteConfirm.entryId = null;
      deleteConfirm.body = '';
    }

    function confirmDelete() {
      const entryId = deleteConfirm.entryId;
      cancelDelete();
      if (!entryId) return;

      // Optimistic removal
      if (umStore) umStore.applyRemoval({ entryId });

      // Send WS event
      const requestId = genRequestId();
      if (umStore) umStore.markPending(requestId, 'remove');
      try {
        store.sendMessage({
          type: 'unify_user_memory_remove',
          entryId,
          requestId,
        });
      } catch { /* best-effort */ }
    }

    return {
      activeShard,
      deleteConfirm,
      entryList,
      shardNames,
      entryCount,
      filteredEntries,
      shardLabel,
      formatTime,
      onTogglePin,
      onDelete,
      cancelDelete,
      confirmDelete,
    };
  },
};
