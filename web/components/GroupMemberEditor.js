/**
 * GroupMemberEditor — task-fix-group-member-editor.
 *
 * Modal for managing the roster of an *existing* group. Visually mirrors
 * GroupCreateWizard (reuses `.group-edit-*` and `.group-wizard-*` styles)
 * but each interaction commits immediately via `groupCrudRequest`:
 *
 *   - Toggle a VP checkbox        → add_member / remove_member
 *   - Click the ★ next to a VP    → set_default_vp
 *
 * No "Save" step — the group store applies the optimistic update on
 * every `group_roster_changed` and we re-derive selection state from
 * `group.roster` on each render. Errors surface inline.
 *
 * Why a separate component (vs. extending GroupCreateWizard):
 *   - Wizard's submit is one-shot (`create`); editor needs per-row ops.
 *   - Wizard owns its own form draft; editor must mirror server state.
 *
 * Mount contract: parent passes `group-id`, listens for `close`. Stores
 * are resolved via window.Pinia so the file stays node-importable for
 * unit tests that don't mount Pinia.
 */

export default {
  name: 'GroupMemberEditor',
  emits: ['close'],
  props: {
    groupId: { type: String, required: true },
  },
  template: `
    <Teleport to="body">
    <div
      class="group-edit-overlay group-wizard-overlay"
      @click.self="onOverlayClick"
      role="dialog"
      aria-modal="true"
      :aria-label="$t('unify.group.members.aria')"
    >
      <div class="group-edit-modal group-wizard-modal">
        <header class="group-edit-header">
          <span class="group-edit-title">
            {{ $t('unify.group.members.title', { name: groupDisplayName }) }}
          </span>
          <button
            class="group-edit-close"
            type="button"
            @click="requestClose"
            :aria-label="$t('unify.group.members.close')"
          >×</button>
        </header>

        <div class="group-wizard-body group-wizard-body-single">
          <div class="group-wizard-field">
            <span class="group-wizard-field-label">
              {{ $t('unify.group.wizard.roster') }}
              <span class="group-member-editor-count">
                · {{ $t('unify.group.members.memberCount', { count: roster.length }) }}
              </span>
            </span>
            <span class="group-wizard-hint">{{ $t('unify.group.members.defaultHint') }}</span>

            <div v-if="vpList.length === 0 && vpLibraryEmpty" class="group-wizard-empty">
              {{ $t('unify.group.members.empty') }}
            </div>
            <div v-else-if="vpList.length === 0" class="group-wizard-empty group-wizard-empty-loading">
              {{ $t('unify.group.members.loading') }}
            </div>
            <ul v-else class="group-wizard-roster-list" role="listbox" aria-multiselectable="true">
              <li
                v-for="vp in vpList"
                :key="vp.vpId"
                class="group-wizard-roster-item"
                :class="{ 'is-selected': isMember(vp.vpId), 'is-default': defaultVpId === vp.vpId }"
                role="option"
                :aria-selected="isMember(vp.vpId)"
              >
                <label class="group-wizard-roster-row">
                  <input
                    type="checkbox"
                    class="group-wizard-roster-check"
                    :value="vp.vpId"
                    :checked="isMember(vp.vpId)"
                    :disabled="busy"
                    @change="toggleMember(vp.vpId, $event.target.checked)"
                  />
                  <span class="group-wizard-roster-name" :style="{ color: vpTextColorFor(vp.vpId) }">{{ vpLabelFor(vp.vpId) }}</span>
                </label>
                <button
                  v-if="isMember(vp.vpId)"
                  type="button"
                  class="group-wizard-default-star"
                  :class="{ 'is-on': defaultVpId === vp.vpId }"
                  :aria-label="$t('unify.group.wizard.defaultVpHint')"
                  :aria-pressed="defaultVpId === vp.vpId"
                  :title="$t('unify.group.wizard.defaultVpHint')"
                  :disabled="busy || defaultVpId === vp.vpId"
                  @click.stop="setDefault(vp.vpId)"
                >
                  <span aria-hidden="true">{{ defaultVpId === vp.vpId ? '★' : '☆' }}</span>
                </button>
              </li>
            </ul>
          </div>

          <div v-if="actionError" class="group-wizard-error" role="alert">
            {{ actionError }}
          </div>

          <div class="group-wizard-actions">
            <button class="group-wizard-primary-btn" type="button" @click="requestClose" :disabled="busy">
              {{ $t('unify.group.members.done') }}
            </button>
          </div>
        </div>
      </div>
    </div>
    </Teleport>
  `,
  data() {
    return {
      busy: false,
      actionError: '',
    };
  },
  computed: {
    chat() {
      try {
        if (typeof window !== 'undefined' && window.Pinia?.useChatStore) {
          return window.Pinia.useChatStore();
        }
      } catch (_) {}
      return null;
    },
    vpStore() {
      try {
        if (typeof window !== 'undefined' && window.Pinia?.useVpStore) {
          return window.Pinia.useVpStore();
        }
      } catch (_) {}
      return null;
    },
    groupsStore() {
      try {
        if (typeof window !== 'undefined' && window.Pinia?.useGroupsStore) {
          return window.Pinia.useGroupsStore();
        }
      } catch (_) {}
      return null;
    },
    group() {
      const gs = this.groupsStore;
      if (!gs || !gs.groups) return null;
      return gs.groups[this.groupId] || null;
    },
    groupDisplayName() {
      const g = this.group;
      if (!g) return '';
      // D1 seed: render localized label for the seed Default group.
      if (g.id === 'grp_default' && (g.name === 'Default' || !g.name)) {
        return this.$t('unify.group.defaultName') || g.name || g.id;
      }
      return g.name || g.id;
    },
    roster() {
      const g = this.group;
      return g && Array.isArray(g.roster) ? g.roster : [];
    },
    defaultVpId() {
      const g = this.group;
      return g ? (g.defaultVpId || null) : null;
    },
    vpList() { return this.vpStore?.vpList || []; },
    vpLibraryEmpty() {
      const s = this.vpStore;
      if (!s) return false;
      if (s.emptyLibrary === true) return true;
      return !!(s.lastSnapshotAt && s.lastSnapshotAt > 0 && (s.vpOrder?.length || 0) === 0);
    },
  },
  mounted() {
    window.addEventListener('keydown', this.onEsc);
    // Make sure the VP library is loaded — without it the modal would
    // show "Loading..." forever for users who never opened the library.
    try {
      if (this.vpStore && this.vpStore.lastSnapshotAt === 0) {
        const chat = this.chat;
        if (chat && typeof chat.sendWsMessage === 'function') {
          chat.sendWsMessage({ type: 'unify_vp_subscribe' });
        }
      }
    } catch (_) { /* test env without Pinia/ws */ }
  },
  beforeUnmount() {
    window.removeEventListener('keydown', this.onEsc);
  },
  methods: {
    onEsc(e) {
      if (e.key === 'Escape' && !this.busy) this.requestClose();
    },
    onOverlayClick() {
      if (!this.busy) this.requestClose();
    },
    requestClose() { this.$emit('close'); },
    isMember(vpId) { return this.roster.includes(vpId); },
    vpLabelFor(vpId) {
      const fn = this.vpStore?.vpLabel;
      return typeof fn === 'function' ? fn(vpId) : vpId;
    },
    vpTextColorFor(vpId) {
      const fn = this.vpStore?.vpTextColor;
      return typeof fn === 'function' ? fn(vpId) : 'var(--vp-avatar-rat-fg)';
    },
    async toggleMember(vpId, checked) {
      if (this.busy || !this.chat) return;
      this.actionError = '';
      this.busy = true;
      try {
        const op = checked ? 'add_member' : 'remove_member';
        const res = await this.chat.groupCrudRequest(op, { groupId: this.groupId, vpId });
        if (!res || !res.ok) {
          this.surfaceError(res);
        } else if (op === 'add_member' && !this.defaultVpId) {
          // First member becomes the default automatically — saves the user
          // a second click on the star they couldn't see yet.
          await this.chat.groupCrudRequest('set_default_vp', { groupId: this.groupId, vpId });
        }
      } finally {
        this.busy = false;
      }
    },
    async setDefault(vpId) {
      if (this.busy || !this.chat || this.defaultVpId === vpId) return;
      this.actionError = '';
      this.busy = true;
      try {
        const res = await this.chat.groupCrudRequest('set_default_vp', {
          groupId: this.groupId, vpId,
        });
        if (!res || !res.ok) this.surfaceError(res);
      } finally {
        this.busy = false;
      }
    },
    surfaceError(res) {
      const code = (res && res.error && res.error.code) || 'unknown';
      const message = (res && res.error && res.error.message) || code;
      this.actionError = this.$t('unify.group.members.actionFailed', { error: message });
    },
  },
};
