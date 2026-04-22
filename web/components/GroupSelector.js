/**
 * GroupSelector — task-338-F3.
 *
 * Compact topbar dropdown that displays the active group, lists all
 * non-archived groups with member counts, allows switching via click,
 * provides rename/archive actions via a per-row kebab, and exposes a
 * "+ New group" entry that mounts the GroupCreateWizard.
 *
 * Data wiring:
 *   - Reads `groups[]` / `activeGroupId` from `useGroupsStore()` (pure UI
 *     pointer — no persistence side-effect).
 *   - CRUD round-trips via `useChatStore().groupCrudRequest(op, data)`
 *     which wraps the WS call in a 10 s-timeout promise.
 *
 * Visual language mirrors `unify-topbar-model` (see unify.css) — compact
 * label + chevron + floating dropdown — so the topbar looks coherent.
 */

import GroupCreateWizard from './GroupCreateWizard.js';

export default {
  name: 'GroupSelector',
  components: { GroupCreateWizard },
  template: `
    <div class="unify-topbar-group" :class="{ 'is-open': open }">
      <div class="unify-topbar-group-trigger" @click.stop="toggle" :title="$t('unify.group.sidebarTitle')">
        <svg viewBox="0 0 24 24" width="14" height="14" class="unify-topbar-group-icon">
          <path fill="currentColor" d="M16 11c1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3 1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
        </svg>
        <span class="unify-topbar-group-name">{{ activeLabel }}</span>
        <span class="unify-topbar-group-count" v-if="activeCount !== null">({{ activeCount }})</span>
        <svg class="unify-model-chevron" :class="{ open }" viewBox="0 0 24 24" width="12" height="12">
          <path fill="currentColor" d="M7 10l5 5 5-5z"/>
        </svg>
      </div>

      <div v-if="open" class="unify-model-dropdown unify-topbar-group-dropdown" @click.stop>
        <div v-if="groupList.length === 0" class="unify-topbar-group-empty">
          {{ $t('unify.group.empty') }}
        </div>
        <div
          v-for="g in groupList"
          :key="g.id"
          class="unify-model-option unify-topbar-group-option"
          :class="{ active: g.id === activeGroupId }"
          @click="selectGroup(g)"
        >
          <span class="unify-model-check" v-if="g.id === activeGroupId">&#10003;</span>
          <span class="unify-model-check" v-else></span>
          <span class="unify-model-option-label">{{ groupDisplayName(g) }}</span>
          <span class="unify-model-option-ctx">{{ memberLabel(g) }}</span>
          <button
            type="button"
            class="unify-topbar-group-kebab"
            :aria-label="$t('unify.group.moreActions')"
            @click.stop="toggleMenu(g.id)"
          >⋯</button>

          <div v-if="menuFor === g.id" class="unify-topbar-group-menu" @click.stop>
            <button type="button" class="unify-topbar-group-menu-item" @click="onRename(g)">
              {{ $t('unify.group.rename') }}
            </button>
            <button type="button" class="unify-topbar-group-menu-item is-danger" @click="onArchive(g)">
              {{ $t('unify.group.archive') }}
            </button>
          </div>
        </div>

        <div class="unify-topbar-group-sep" role="separator"></div>
        <button
          type="button"
          class="unify-model-option unify-topbar-group-new"
          @click="openWizard"
          :aria-label="$t('unify.group.newButtonAria')"
        >
          <span class="unify-topbar-group-new-plus">+</span>
          <span class="unify-model-option-label">{{ $t('unify.group.newButton') }}</span>
        </button>
      </div>

      <GroupCreateWizard
        v-if="wizardOpen"
        @close="wizardOpen = false"
        @created="onCreated"
      />
    </div>
  `,
  data() {
    return {
      open: false,
      wizardOpen: false,
      menuFor: null,
      busy: false,
    };
  },
  computed: {
    groupsStore() {
      try {
        if (typeof window !== 'undefined' && window.Pinia?.useGroupsStore) {
          return window.Pinia.useGroupsStore();
        }
      } catch (_) { /* no-pinia env */ }
      return null;
    },
    chatStore() {
      try {
        if (typeof window !== 'undefined' && window.Pinia?.useChatStore) {
          return window.Pinia.useChatStore();
        }
      } catch (_) { /* no-pinia env */ }
      return null;
    },
    groupList() {
      return this.groupsStore?.groupList || [];
    },
    activeGroupId() {
      return this.groupsStore?.activeGroupId || null;
    },
    activeGroup() {
      return this.groupsStore?.activeGroup || null;
    },
    activeLabel() {
      const g = this.activeGroup;
      if (g) return this.groupDisplayName(g);
      if (typeof this.$t === 'function') return this.$t('unify.group.defaultName');
      return 'Default';
    },
    activeCount() {
      const g = this.activeGroup;
      if (!g) return null;
      return Array.isArray(g.roster) ? g.roster.length : 0;
    },
  },
  mounted() {
    document.addEventListener('click', this.onDocClick);
    window.addEventListener('keydown', this.onEsc);
  },
  beforeUnmount() {
    document.removeEventListener('click', this.onDocClick);
    window.removeEventListener('keydown', this.onEsc);
  },
  methods: {
    toggle() {
      this.open = !this.open;
      if (!this.open) this.menuFor = null;
    },
    closeAll() {
      this.open = false;
      this.menuFor = null;
    },
    onDocClick(ev) {
      if (!this.open) return;
      const root = this.$el;
      if (root && ev.target && !root.contains(ev.target)) this.closeAll();
    },
    onEsc(ev) {
      if (ev.key === 'Escape' && this.open && !this.wizardOpen) this.closeAll();
    },
    groupDisplayName(g) {
      if (!g) return '';
      return g.name || g.id;
    },
    memberLabel(g) {
      const roster = Array.isArray(g?.roster) ? g.roster : [];
      const n = roster.length;
      if (typeof this.$t !== 'function') return `${n} members`;
      if (n === 0) return this.$t('unify.group.noMembers');
      if (n === 1) return this.$t('unify.group.oneMember');
      return this.$t('unify.group.membersCount', { count: n });
    },
    selectGroup(g) {
      if (!g || !g.id) return;
      if (this.groupsStore) this.groupsStore.setActive(g.id);
      this.closeAll();
    },
    toggleMenu(gid) {
      this.menuFor = this.menuFor === gid ? null : gid;
    },
    openWizard() {
      this.wizardOpen = true;
      this.closeAll();
    },
    onCreated(group) {
      this.wizardOpen = false;
      if (group && group.id && this.groupsStore) {
        this.groupsStore.setActive(group.id);
      }
    },
    async onRename(g) {
      this.menuFor = null;
      if (!g || !g.id || !this.chatStore) return;
      const t = typeof this.$t === 'function' ? this.$t.bind(this) : (k) => k;
      const prompt = t('unify.group.renamePrompt', { name: this.groupDisplayName(g) });
      // eslint-disable-next-line no-alert
      const next = typeof window !== 'undefined' && window.prompt
        ? window.prompt(prompt, g.name || '')
        : null;
      if (next == null) return;
      const trimmed = String(next).trim();
      if (!trimmed || trimmed === (g.name || '')) return;
      if (this.busy) return;
      this.busy = true;
      try {
        await this.chatStore.groupCrudRequest('rename', { groupId: g.id, name: trimmed });
      } finally {
        this.busy = false;
      }
    },
    async onArchive(g) {
      this.menuFor = null;
      if (!g || !g.id || !this.chatStore) return;
      const t = typeof this.$t === 'function' ? this.$t.bind(this) : (k) => k;
      const msg = t('unify.group.archiveConfirm', { name: this.groupDisplayName(g) });
      // eslint-disable-next-line no-alert
      const ok = typeof window !== 'undefined' && window.confirm
        ? window.confirm(msg)
        : false;
      if (!ok) return;
      if (this.busy) return;
      this.busy = true;
      try {
        await this.chatStore.groupCrudRequest('archive', { groupId: g.id });
      } finally {
        this.busy = false;
      }
    },
  },
};
