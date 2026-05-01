/**
 * GroupSettingsModal — unified left-nav / right-pane settings dialog.
 *
 * Replaces the previous standalone GroupMemberEditor. Sections:
 *   - Announcement   (CLAUDE.md-style shared system-prompt prefix)
 *   - Members        (roster checkboxes + ★ default-VP picker)
 *   - Rename         (group display name)
 *   - Danger zone    (delete the group permanently)
 *
 * Per the design lock: NOT tabs. Always-visible left nav with a single
 * pane on the right, Mac-System-Settings style. Active nav item uses
 * `var(--accent-blue)` so it's visually distinct from hover (lesson
 * from PR #690 review where hover/active were indistinguishable).
 *
 * All mutations route through the existing `chat.groupCrudRequest()`
 * action, which has its own pending/timeout handling. Errors surface
 * inline per section.
 *
 * Mount contract: parent passes `group-id` and `initial-section`
 * ('announcement' | 'members' | 'rename' | 'danger'); listens for
 * `close`. Parent owns visibility and re-mounts when the active group
 * changes (the modal re-derives state from the store on each render).
 */

export default {
  name: 'GroupSettingsModal',
  emits: ['close'],
  props: {
    groupId: { type: String, required: true },
    initialSection: {
      type: String,
      default: 'announcement',
      validator: v => ['announcement', 'members', 'rename', 'danger'].includes(v),
    },
  },
  data() {
    return {
      section: this.initialSection,
      // Announcement editor draft (lazy-init from store on first edit).
      announcementDraft: '',
      announcementBusy: false,
      announcementError: '',
      // Rename draft.
      renameDraft: '',
      renameBusy: false,
      renameError: '',
      // Members busy flag — gates concurrent toggles.
      membersBusy: false,
      membersError: '',
      // Delete confirm flag.
      deleteConfirmText: '',
      deleteBusy: false,
      deleteError: '',
    };
  },
  computed: {
    chat() {
      try { return window.Pinia?.useChatStore?.() || null; } catch (_) { return null; }
    },
    vpStore() {
      try { return window.Pinia?.useVpStore?.() || null; } catch (_) { return null; }
    },
    groupsStore() {
      try { return window.Pinia?.useGroupsStore?.() || null; } catch (_) { return null; }
    },
    group() {
      const gs = this.groupsStore;
      return gs && gs.groups ? (gs.groups[this.groupId] || null) : null;
    },
    groupDisplayName() {
      const g = this.group;
      if (!g) return '';
      if (g.id === 'grp_default' && (g.name === 'Default' || !g.name)) {
        return this.$t('unify.group.defaultName') || g.name || g.id;
      }
      return g.name || g.id;
    },
    announcement() {
      return this.group && typeof this.group.announcement === 'string' ? this.group.announcement : '';
    },
    roster() {
      return this.group && Array.isArray(this.group.roster) ? this.group.roster : [];
    },
    defaultVpId() {
      return this.group ? (this.group.defaultVpId || null) : null;
    },
    vpList() { return this.vpStore?.vpList || []; },
    vpLibraryEmpty() {
      const s = this.vpStore;
      if (!s) return false;
      if (s.emptyLibrary === true) return true;
      return !!(s.lastSnapshotAt && s.lastSnapshotAt > 0 && (s.vpOrder?.length || 0) === 0);
    },
    deleteConfirmReady() {
      return this.deleteConfirmText.trim() === this.groupDisplayName;
    },
    sections() {
      return [
        { id: 'announcement', label: this.$t('unify.group.settings.nav.announcement') },
        { id: 'members', label: this.$t('unify.group.settings.nav.members') },
        { id: 'rename', label: this.$t('unify.group.settings.nav.rename') },
        { id: 'danger', label: this.$t('unify.group.settings.nav.danger') },
      ];
    },
  },
  watch: {
    section(next) {
      // Seed the relevant draft when entering a section so the user sees
      // the current value rather than a stale or empty input.
      if (next === 'announcement') this.announcementDraft = this.announcement;
      if (next === 'rename') this.renameDraft = this.groupDisplayName;
      // Clear unrelated errors so they don't haunt other sections.
      this.announcementError = '';
      this.renameError = '';
      this.membersError = '';
      this.deleteError = '';
      this.deleteConfirmText = '';
    },
    groupId() {
      // Reset state when parent re-targets a different group while
      // open. Note: don't rely on the section() watcher to reseed
      // drafts — it doesn't fire when section is already equal to
      // initialSection. Seed directly here so the user never sees a
      // momentary empty input.
      this.section = this.initialSection;
      this.announcementDraft = this.announcement;
      this.renameDraft = this.groupDisplayName;
      this.deleteConfirmText = '';
      this.announcementError = '';
      this.renameError = '';
      this.membersError = '';
      this.deleteError = '';
    },
    // I3: auto-close when the group disappears (deleted from another
    // tab, archived by agent, etc.) so the user isn't stuck on a stale
    // shell with a blank title and disabled buttons.
    group(next, prev) {
      if (prev && !next && !this.deleteBusy) {
        this.requestClose();
      }
    },
  },
  mounted() {
    window.addEventListener('keydown', this.onEsc);
    // Lazy-load VP library so the Members section doesn't render an
    // infinite "Loading..." for users who never opened the library.
    try {
      if (this.vpStore && this.vpStore.lastSnapshotAt === 0) {
        const chat = this.chat;
        if (chat && typeof chat.sendWsMessage === 'function') {
          chat.sendWsMessage({ type: 'unify_vp_subscribe' });
        }
      }
    } catch (_) { /* test env */ }
    // Seed initial draft for whatever the entry section is.
    if (this.section === 'announcement') this.announcementDraft = this.announcement;
    if (this.section === 'rename') this.renameDraft = this.groupDisplayName;
  },
  beforeUnmount() {
    window.removeEventListener('keydown', this.onEsc);
  },
  methods: {
    onEsc(e) {
      if (e.key !== 'Escape') return;
      // Don't close mid-busy operation.
      if (this.announcementBusy || this.renameBusy || this.membersBusy || this.deleteBusy) return;
      this.requestClose();
    },
    onOverlayClick() {
      if (this.announcementBusy || this.renameBusy || this.membersBusy || this.deleteBusy) return;
      this.requestClose();
    },
    requestClose() { this.$emit('close'); },
    selectSection(id) {
      if (id !== this.section) this.section = id;
    },
    // ── Announcement ───────────────────────────────────────
    async saveAnnouncement() {
      if (this.announcementBusy || !this.chat) return;
      this.announcementBusy = true;
      this.announcementError = '';
      try {
        const res = await this.chat.groupCrudRequest('update', {
          groupId: this.groupId,
          patch: { announcement: this.announcementDraft },
        });
        if (!res || !res.ok) {
          const code = (res && res.error && res.error.code) || 'unknown';
          const message = (res && res.error && res.error.message) || code;
          this.announcementError = this.$t('unify.group.announcement.saveFailed', { error: message });
        }
      } finally {
        this.announcementBusy = false;
      }
    },
    // ── Rename ─────────────────────────────────────────────
    async saveRename() {
      const next = (this.renameDraft || '').trim();
      if (!next || this.renameBusy || !this.chat) return;
      this.renameBusy = true;
      this.renameError = '';
      try {
        const res = await this.chat.groupCrudRequest('rename', {
          groupId: this.groupId,
          name: next,
        });
        if (!res || !res.ok) {
          const code = (res && res.error && res.error.code) || 'unknown';
          const message = (res && res.error && res.error.message) || code;
          this.renameError = this.$t('unify.group.error.unknown', { message });
        }
      } finally {
        this.renameBusy = false;
      }
    },
    // ── Members ────────────────────────────────────────────
    isMember(vpId) { return this.roster.includes(vpId); },
    vpLabelFor(vpId) {
      const fn = this.vpStore?.vpLabel;
      return typeof fn === 'function' ? fn(vpId) : vpId;
    },
    vpColorFor(vpId) {
      const fn = this.vpStore?.vpColor;
      return typeof fn === 'function' ? fn(vpId) : '#5B8DEF';
    },
    vpInitialFor(vpId) {
      const fn = this.vpStore?.vpInitial;
      return typeof fn === 'function' ? fn(vpId) : (vpId ? vpId.charAt(0).toUpperCase() : '?');
    },
    async toggleMember(vpId, checked) {
      if (this.membersBusy || !this.chat) return;
      this.membersBusy = true;
      this.membersError = '';
      try {
        const op = checked ? 'add_member' : 'remove_member';
        const res = await this.chat.groupCrudRequest(op, { groupId: this.groupId, vpId });
        if (!res || !res.ok) {
          const code = (res && res.error && res.error.code) || 'unknown';
          const message = (res && res.error && res.error.message) || code;
          this.membersError = this.$t('unify.group.members.actionFailed', { error: message });
        } else if (op === 'add_member' && !this.defaultVpId) {
          // First-add convenience: promote to default automatically.
          // Surface failures inline like the primary toggle — silent
          // retries hide bugs in the agent's roster mutator.
          const defRes = await this.chat.groupCrudRequest('set_default_vp', {
            groupId: this.groupId, vpId,
          });
          if (defRes && !defRes.ok) {
            const code2 = (defRes.error && defRes.error.code) || 'unknown';
            const message2 = (defRes.error && defRes.error.message) || code2;
            this.membersError = this.$t('unify.group.members.actionFailed', { error: message2 });
          }
        }
      } finally {
        this.membersBusy = false;
      }
    },
    async setDefault(vpId) {
      if (this.membersBusy || !this.chat || this.defaultVpId === vpId) return;
      this.membersBusy = true;
      this.membersError = '';
      try {
        const res = await this.chat.groupCrudRequest('set_default_vp', {
          groupId: this.groupId, vpId,
        });
        if (!res || !res.ok) {
          const code = (res && res.error && res.error.code) || 'unknown';
          const message = (res && res.error && res.error.message) || code;
          this.membersError = this.$t('unify.group.members.actionFailed', { error: message });
        }
      } finally {
        this.membersBusy = false;
      }
    },
    // ── Danger zone (delete) ────────────────────────────────
    async confirmDelete() {
      if (!this.deleteConfirmReady || this.deleteBusy || !this.chat) return;
      this.deleteBusy = true;
      this.deleteError = '';
      try {
        const res = await this.chat.groupCrudRequest('delete', { groupId: this.groupId });
        if (!res || !res.ok) {
          const code = (res && res.error && res.error.code) || 'unknown';
          const message = (res && res.error && res.error.message) || code;
          this.deleteError = this.$t('unify.group.error.unknown', { message });
          return;
        }
        // Success — close so the parent re-renders against the new
        // active group (the store rotates on delete).
        this.requestClose();
      } finally {
        this.deleteBusy = false;
      }
    },
  },
  template: `
    <Teleport to="body">
    <div
      class="group-settings-overlay"
      @click.self="onOverlayClick"
      role="dialog"
      aria-modal="true"
      :aria-label="$t('unify.group.settings.title', { name: groupDisplayName })"
    >
      <div class="group-settings-modal">
        <header class="group-settings-header">
          <span class="group-settings-title">
            {{ $t('unify.group.settings.title', { name: groupDisplayName }) }}
          </span>
          <button
            class="group-settings-close"
            type="button"
            @click="requestClose"
            :disabled="announcementBusy || renameBusy || membersBusy || deleteBusy"
            :aria-label="$t('unify.group.settings.close')"
          >×</button>
        </header>

        <div class="group-settings-body">
          <!-- Left nav -->
          <nav class="group-settings-nav" role="tablist" aria-orientation="vertical">
            <button
              v-for="s in sections"
              :key="s.id"
              type="button"
              class="group-settings-nav-item"
              :class="{ 'is-active': section === s.id, 'is-danger': s.id === 'danger' }"
              role="tab"
              :aria-selected="section === s.id"
              @click="selectSection(s.id)"
            >{{ s.label }}</button>
          </nav>

          <!-- Right pane -->
          <section class="group-settings-pane">
            <!-- Announcement -->
            <div v-if="section === 'announcement'" class="group-settings-section">
              <h3 class="group-settings-heading">{{ $t('unify.group.settings.announcement.heading') }}</h3>
              <p class="group-settings-help">{{ $t('unify.group.settings.announcement.help') }}</p>
              <textarea
                class="group-settings-textarea"
                v-model="announcementDraft"
                :placeholder="$t('unify.group.announcement.placeholder')"
                :disabled="announcementBusy"
                rows="10"
              ></textarea>
              <p v-if="announcementError" class="group-settings-error" role="alert">{{ announcementError }}</p>
              <div class="group-settings-actions">
                <button
                  type="button"
                  class="group-settings-primary"
                  :disabled="announcementBusy || announcementDraft === announcement"
                  @click="saveAnnouncement"
                >{{ announcementBusy ? $t('unify.group.announcement.saving') : $t('common.save') }}</button>
              </div>
            </div>

            <!-- Members -->
            <div v-else-if="section === 'members'" class="group-settings-section">
              <h3 class="group-settings-heading">{{ $t('unify.group.settings.members.heading') }}</h3>
              <p class="group-settings-help">{{ $t('unify.group.members.defaultHint') }}</p>
              <div v-if="vpList.length === 0 && vpLibraryEmpty" class="group-settings-empty">
                {{ $t('unify.group.members.empty') }}
              </div>
              <div v-else-if="vpList.length === 0" class="group-settings-empty">
                {{ $t('unify.group.members.loading') }}
              </div>
              <ul v-else class="group-settings-roster" role="listbox" aria-multiselectable="true">
                <li
                  v-for="vp in vpList"
                  :key="vp.vpId"
                  class="group-settings-roster-item"
                  :class="{ 'is-selected': isMember(vp.vpId), 'is-default': defaultVpId === vp.vpId }"
                >
                  <label class="group-settings-roster-row">
                    <input
                      type="checkbox"
                      :value="vp.vpId"
                      :checked="isMember(vp.vpId)"
                      :disabled="membersBusy"
                      @change="toggleMember(vp.vpId, $event.target.checked)"
                    />
                    <span class="group-settings-roster-avatar" :style="{ background: vpColorFor(vp.vpId) }">
                      {{ vpInitialFor(vp.vpId) }}
                    </span>
                    <span class="group-settings-roster-name">{{ vpLabelFor(vp.vpId) }}</span>
                  </label>
                  <button
                    v-if="isMember(vp.vpId)"
                    type="button"
                    class="group-settings-default-star"
                    :class="{ 'is-on': defaultVpId === vp.vpId }"
                    :title="$t('unify.group.wizard.defaultVpHint')"
                    :aria-pressed="defaultVpId === vp.vpId"
                    :disabled="membersBusy || defaultVpId === vp.vpId"
                    @click.stop="setDefault(vp.vpId)"
                  ><span aria-hidden="true">{{ defaultVpId === vp.vpId ? '★' : '☆' }}</span></button>
                </li>
              </ul>
              <p v-if="membersError" class="group-settings-error" role="alert">{{ membersError }}</p>
            </div>

            <!-- Rename -->
            <div v-else-if="section === 'rename'" class="group-settings-section">
              <h3 class="group-settings-heading">{{ $t('unify.group.settings.rename.heading') }}</h3>
              <label class="group-settings-field-label">{{ $t('unify.group.settings.rename.label') }}</label>
              <input
                type="text"
                class="group-settings-input"
                v-model="renameDraft"
                :disabled="renameBusy"
                @keydown.enter="saveRename"
              />
              <p v-if="renameError" class="group-settings-error" role="alert">{{ renameError }}</p>
              <div class="group-settings-actions">
                <button
                  type="button"
                  class="group-settings-primary"
                  :disabled="renameBusy || !renameDraft.trim() || renameDraft.trim() === groupDisplayName"
                  @click="saveRename"
                >{{ renameBusy ? $t('unify.group.settings.rename.saving') : $t('unify.group.settings.rename.save') }}</button>
              </div>
            </div>

            <!-- Danger zone -->
            <div v-else-if="section === 'danger'" class="group-settings-section group-settings-section-danger">
              <h3 class="group-settings-heading">{{ $t('unify.group.settings.danger.heading') }}</h3>
              <p class="group-settings-help">{{ $t('unify.group.settings.danger.deleteHelp') }}</p>
              <label class="group-settings-field-label">
                {{ $t('unify.group.deleteConfirm', { name: groupDisplayName }) }}
              </label>
              <input
                type="text"
                class="group-settings-input"
                v-model="deleteConfirmText"
                :placeholder="groupDisplayName"
                :disabled="deleteBusy"
              />
              <p v-if="deleteError" class="group-settings-error" role="alert">{{ deleteError }}</p>
              <div class="group-settings-actions">
                <button
                  type="button"
                  class="group-settings-danger-btn"
                  :disabled="!deleteConfirmReady || deleteBusy"
                  @click="confirmDelete"
                >{{ deleteBusy ? $t('unify.group.deletingEllipsis') : $t('unify.group.settings.danger.deleteBtn') }}</button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
    </Teleport>
  `,
};
