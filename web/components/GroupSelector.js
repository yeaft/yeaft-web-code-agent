/**
 * GroupSelector — task-338-F3.
 *
 * Compact topbar dropdown that displays the active group, lists all
 * non-archived groups with member counts, allows switching via click or
 * keyboard, provides rename/archive actions via a per-row kebab (routed
 * through <GroupEditModal>), and exposes a "+ New group" entry that mounts
 * the GroupCreateWizard.
 *
 * Data wiring:
 *   - Reads `groups[]` / `activeGroupId` from `useGroupsStore()` (pure UI
 *     pointer — no persistence side-effect).
 *   - CRUD round-trips via `useChatStore().groupCrudRequest(op, data)`
 *     which wraps the WS call in a 10 s-timeout promise.
 *
 * Visual language mirrors `unify-topbar-model` (see unify.css) — compact
 * label + chevron + floating dropdown — so the topbar looks coherent.
 *
 * Keyboard (when dropdown is open, focus on trigger):
 *   ↑ / ↓  — move highlight over group rows (wraps)
 *   Enter  — select highlighted row (calls setActive)
 *   Esc    — close dropdown
 * Highlight is exposed via `aria-activedescendant` pointing at stable
 * per-row ids `group-option-${g.id}`.
 */

import GroupCreateWizard from './GroupCreateWizard.js';
import GroupEditModal from './GroupEditModal.js';

export default {
  name: 'GroupSelector',
  components: { GroupCreateWizard, GroupEditModal },
  template: `
    <div class="unify-topbar-group" :class="{ 'is-open': open }">
      <div
        class="unify-topbar-group-trigger"
        @click.stop="toggle"
        @keydown="onTriggerKey"
        :title="$t('unify.group.sidebarTitle')"
        tabindex="0"
        role="combobox"
        aria-haspopup="listbox"
        :aria-expanded="open ? 'true' : 'false'"
        :aria-activedescendant="open && activeDescendantId ? activeDescendantId : null"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" class="unify-topbar-group-icon">
          <path fill="currentColor" d="M16 11c1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3 1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
        </svg>
        <span class="unify-topbar-group-name">{{ activeLabel }}</span>
        <span class="unify-topbar-group-count" v-if="activeCount !== null">({{ activeCount }})</span>
        <svg class="unify-model-chevron" :class="{ open }" viewBox="0 0 24 24" width="12" height="12">
          <path fill="currentColor" d="M7 10l5 5 5-5z"/>
        </svg>
      </div>

      <div
        v-if="open"
        class="unify-model-dropdown unify-topbar-group-dropdown"
        role="listbox"
        @click.stop
      >
        <div v-if="groupList.length === 0" class="unify-topbar-group-empty">
          {{ $t('unify.group.empty') }}
        </div>
        <div
          v-for="(g, idx) in groupList"
          :key="g.id"
          :id="'group-option-' + g.id"
          role="option"
          class="unify-model-option unify-topbar-group-option"
          :class="{
            active: g.id === activeGroupId,
            'is-highlighted': idx === highlightIdx,
            'is-busy': busyGroupIds.has(g.id)
          }"
          :aria-selected="g.id === activeGroupId ? 'true' : 'false'"
          :aria-busy="busyGroupIds.has(g.id) ? 'true' : 'false'"
          @click="selectGroup(g)"
          @mouseenter="highlightIdx = idx"
        >
          <span class="unify-model-check" v-if="g.id === activeGroupId">&#10003;</span>
          <span class="unify-model-check" v-else></span>
          <span class="unify-model-option-label">{{ groupDisplayName(g) }}</span>
          <span class="unify-model-option-ctx">{{ memberLabel(g) }}</span>

          <span
            v-if="busyGroupIds.has(g.id)"
            class="unify-topbar-group-spinner"
            role="status"
            aria-live="polite"
          >
            <span class="unify-topbar-group-spinner-dot"></span>
            <span class="unify-topbar-group-spinner-text">{{ busyLabelFor(g.id) }}</span>
          </span>

          <button
            v-else
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

      <GroupEditModal
        v-if="editModal.open"
        :mode="editModal.mode"
        :group="editModal.group"
        @close="closeEditModal"
        @confirm="onEditConfirm"
      />
    </div>
  `,
  data() {
    return {
      open: false,
      wizardOpen: false,
      menuFor: null,
      highlightIdx: -1,
      busyGroupIds: new Set(),
      busyOpByGroup: {},                        // groupId -> 'rename' | 'archive'
      editModal: { open: false, mode: null, group: null },
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
    activeDescendantId() {
      if (!this.open) return null;
      const list = this.groupList;
      if (!list.length) return null;
      const idx = this.highlightIdx >= 0 && this.highlightIdx < list.length
        ? this.highlightIdx
        : list.findIndex(g => g.id === this.activeGroupId);
      const g = idx >= 0 ? list[idx] : list[0];
      return g ? `group-option-${g.id}` : null;
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
      if (!this.open) {
        this.menuFor = null;
        this.highlightIdx = -1;
      } else {
        // Seed highlight on the active row.
        const list = this.groupList;
        const idx = list.findIndex(g => g.id === this.activeGroupId);
        this.highlightIdx = idx >= 0 ? idx : (list.length ? 0 : -1);
      }
    },
    closeAll() {
      this.open = false;
      this.menuFor = null;
      this.highlightIdx = -1;
    },
    onDocClick(ev) {
      if (!this.open) return;
      const root = this.$el;
      if (root && ev.target && !root.contains(ev.target)) this.closeAll();
    },
    onEsc(ev) {
      if (ev.key !== 'Escape') return;
      if (this.editModal.open) return;       // modal handles its own Esc
      if (this.wizardOpen) return;
      if (this.open) this.closeAll();
    },
    onTriggerKey(ev) {
      const list = this.groupList;
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        if (!this.open) { this.toggle(); return; }
        if (!list.length) return;
        this.highlightIdx = ((this.highlightIdx < 0 ? -1 : this.highlightIdx) + 1) % list.length;
      } else if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        if (!this.open) { this.toggle(); return; }
        if (!list.length) return;
        const cur = this.highlightIdx < 0 ? 0 : this.highlightIdx;
        this.highlightIdx = (cur - 1 + list.length) % list.length;
      } else if (ev.key === 'Enter') {
        if (!this.open) { this.toggle(); return; }
        const g = list[this.highlightIdx];
        if (g) {
          ev.preventDefault();
          this.selectGroup(g);
        }
      }
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
    busyLabelFor(gid) {
      const op = this.busyOpByGroup[gid];
      const key = op === 'archive' ? 'unify.group.archivingEllipsis' : 'unify.group.renamingEllipsis';
      if (typeof this.$t === 'function') return this.$t(key);
      return op === 'archive' ? 'Archiving…' : 'Renaming…';
    },
    selectGroup(g) {
      if (!g || !g.id) return;
      if (this.busyGroupIds.has(g.id)) return;     // don't select while busy
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
    onRename(g) {
      this.menuFor = null;
      if (!g || !g.id) return;
      this.editModal = { open: true, mode: 'rename', group: { id: g.id, name: g.name || '' } };
    },
    onArchive(g) {
      this.menuFor = null;
      if (!g || !g.id) return;
      this.editModal = { open: true, mode: 'archive', group: { id: g.id, name: g.name || '' } };
    },
    closeEditModal() {
      this.editModal = { open: false, mode: null, group: null };
    },
    async onEditConfirm(payload) {
      const { mode, groupId, name } = payload || {};
      const target = { ...this.editModal };
      this.closeEditModal();
      if (!mode || !groupId || !this.chatStore) return;
      this._markBusy(groupId, mode);
      try {
        if (mode === 'rename') {
          await this.chatStore.groupCrudRequest('rename', { groupId, name });
        } else if (mode === 'archive') {
          await this.chatStore.groupCrudRequest('archive', { groupId });
        }
      } finally {
        this._clearBusy(groupId);
        // Mark `target` as referenced so the linter sees it; also useful for future reason-codes.
        void target;
      }
    },
    _markBusy(gid, op) {
      const next = new Set(this.busyGroupIds);
      next.add(gid);
      this.busyGroupIds = next;
      this.busyOpByGroup = { ...this.busyOpByGroup, [gid]: op };
    },
    _clearBusy(gid) {
      const next = new Set(this.busyGroupIds);
      next.delete(gid);
      this.busyGroupIds = next;
      const map = { ...this.busyOpByGroup };
      delete map[gid];
      this.busyOpByGroup = map;
    },
  },
};
