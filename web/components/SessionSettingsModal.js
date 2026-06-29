/**
 * SessionSettingsModal — unified left-nav / right-pane settings dialog.
 *
 * Replaces the previous standalone SessionMemberEditor. Sections:
 *   - Session        (rename + announcement + delete)
 *   - Members        (roster checkboxes + ★ default-VP picker)
 *
 * Per the design lock: NOT tabs. Always-visible left nav with a single
 * pane on the right, Mac-System-Settings style. Active nav item uses
 * `var(--accent-blue)` so it's visually distinct from hover (lesson
 * from PR #690 review where hover/active were indistinguishable).
 *
 * All mutations route through the existing `chat.sessionCrudRequest()`
 * action, which has its own pending/timeout handling. Errors surface
 * inline per section.
 *
 * Mount contract: parent passes `group-id` and `initial-section`
 * ('session' | 'members' | 'memory', with legacy announcement/rename/danger
 * aliases mapped to 'session'); listens for
 * `close`. Parent owns visibility and re-mounts when the active group
 * changes (the modal re-derives state from the store on each render).
 */

const SESSION_SETTINGS_SECTION = 'session';
const LEGACY_SESSION_SETTINGS_SECTIONS = new Set(['announcement', 'rename', 'danger']);

function normalizeSettingsSection(section) {
  if (section === 'members' || section === 'memory' || section === SESSION_SETTINGS_SECTION) return section;
  if (LEGACY_SESSION_SETTINGS_SECTIONS.has(section)) return SESSION_SETTINGS_SECTION;
  return SESSION_SETTINGS_SECTION;
}

export default {
  name: 'SessionSettingsModal',
  emits: ['close', 'open-vp-library'],
  props: {
    groupId: { type: String, required: true },
    initialSection: {
      type: String,
      default: SESSION_SETTINGS_SECTION,
      validator: v => [SESSION_SETTINGS_SECTION, 'announcement', 'members', 'rename', 'memory', 'danger'].includes(v),
    },
    initialEditVpId: { type: String, default: '' },
  },
  data() {
    return {
      section: this.initialEditVpId ? 'members' : normalizeSettingsSection(this.initialSection),
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
      highlightedVpId: this.initialEditVpId || '',
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
    sessionsStore() {
      try { return window.Pinia?.useSessionsStore?.() || null; } catch (_) { return null; }
    },
    group() {
      const gs = this.sessionsStore;
      return gs && typeof gs.sessionById === 'function' ? gs.sessionById(this.groupId, this.chat?.currentAgent || null) : null;
    },
    groupDisplayName() {
      const g = this.group;
      if (!g) return '';
      if (g.id === 'grp_default' && (g.name === 'Default' || !g.name)) {
        return this.$t('yeaft.session.defaultName') || g.name || g.id;
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
        { id: SESSION_SETTINGS_SECTION, label: this.$t('yeaft.session.settings.nav.session') },
        { id: 'members', label: this.$t('yeaft.session.settings.nav.members') },
        { id: 'memory', label: this.$t('yeaft.session.settings.nav.memory') },
      ];
    },
    /**
     * v0.1.754 — reactive dream status for THIS group. Reads from
     * vpStore.groupDreamStatus so the "Run dream now" button flips
     * between idle / running / success / error states without manual
     * polling. Returns the same shape as `dreamStatusFor`.
     */
    groupDreamStatus() {
      const vs = this.vpStore;
      if (!vs) return { status: 'idle', lastRunAt: null, lastResult: null, lastError: null };
      return vs.groupDreamStatusFor(this.groupId);
    },
    dreamRunning() {
      return this.groupDreamStatus.status === 'running';
    },
  },
  watch: {
    section(next) {
      // Seed the relevant draft when entering a section so the user sees
      // the current value rather than a stale or empty input.
      if (next === SESSION_SETTINGS_SECTION) {
        this.announcementDraft = this.announcement;
        this.renameDraft = this.groupDisplayName;
      }
      // Clear unrelated errors so they don't haunt other sections.
      this.announcementError = '';
      this.renameError = '';
      this.membersError = '';
      this.deleteError = '';
      this.deleteConfirmText = '';
    },
    initialEditVpId(next) {
      this.highlightedVpId = next || '';
      if (next) this.section = 'members';
    },
    initialSection(next) {
      if (!this.initialEditVpId) this.section = normalizeSettingsSection(next);
    },
    groupId() {
      // Reset state when parent re-targets a different group while
      // open. Note: don't rely on the section() watcher to reseed
      // drafts — it doesn't fire when section is already equal to
      // initialSection. Seed directly here so the user never sees a
      // momentary empty input.
      this.section = this.initialEditVpId ? 'members' : normalizeSettingsSection(this.initialSection);
      this.highlightedVpId = this.initialEditVpId || '';
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
          chat.sendWsMessage({ type: 'yeaft_vp_subscribe' });
        }
      }
    } catch (_) { /* test env */ }
    // Seed initial draft for whatever the entry section is.
    if (this.section === SESSION_SETTINGS_SECTION) {
      this.announcementDraft = this.announcement;
      this.renameDraft = this.groupDisplayName;
    }
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
        const res = await this.chat.sessionCrudRequest('update', {
          sessionId: this.groupId,
          patch: { announcement: this.announcementDraft },
        });
        if (!res || !res.ok) {
          const code = (res && res.error && res.error.code) || 'unknown';
          const message = (res && res.error && res.error.message) || code;
          this.announcementError = this.$t('yeaft.session.announcement.saveFailed', { error: message });
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
        const res = await this.chat.sessionCrudRequest('rename', {
          sessionId: this.groupId,
          name: next,
        });
        if (!res || !res.ok) {
          const code = (res && res.error && res.error.code) || 'unknown';
          const message = (res && res.error && res.error.message) || code;
          this.renameError = this.$t('yeaft.session.error.unknown', { message });
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
    vpTextColorFor(vpId) {
      const fn = this.vpStore?.vpTextColor;
      return typeof fn === 'function' ? fn(vpId) : 'var(--vp-avatar-rat-fg)';
    },
    async toggleMember(vpId, checked) {
      if (this.membersBusy || !this.chat) return;
      this.membersBusy = true;
      this.membersError = '';
      try {
        const op = checked ? 'add_member' : 'remove_member';
        const res = await this.chat.sessionCrudRequest(op, { sessionId: this.groupId, vpId });
        if (!res || !res.ok) {
          const code = (res && res.error && res.error.code) || 'unknown';
          const message = (res && res.error && res.error.message) || code;
          this.membersError = this.$t('yeaft.session.members.actionFailed', { error: message });
        } else if (op === 'add_member' && !this.defaultVpId) {
          // First-add convenience: promote to default automatically.
          // Surface failures inline like the primary toggle — silent
          // retries hide bugs in the agent's roster mutator.
          const defRes = await this.chat.sessionCrudRequest('set_default_vp', {
            sessionId: this.groupId, vpId,
          });
          if (defRes && !defRes.ok) {
            const code2 = (defRes.error && defRes.error.code) || 'unknown';
            const message2 = (defRes.error && defRes.error.message) || code2;
            this.membersError = this.$t('yeaft.session.members.actionFailed', { error: message2 });
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
        const res = await this.chat.sessionCrudRequest('set_default_vp', {
          sessionId: this.groupId, vpId,
        });
        if (!res || !res.ok) {
          const code = (res && res.error && res.error.code) || 'unknown';
          const message = (res && res.error && res.error.message) || code;
          this.membersError = this.$t('yeaft.session.members.actionFailed', { error: message });
        }
      } finally {
        this.membersBusy = false;
      }
    },
    // ── Memory (manual dream trigger) ───────────────────────
    // v0.1.754: lets the user kick the dream scheduler for this group
    // after observing that the Resident layer is stuck on the bootstrap
    // seed. Status flows back as a `groupId`-tagged yeaft_dream_result
    // and lands in `vpStore.groupDreamStatus`.
    runDream() {
      if (!this.vpStore || this.dreamRunning) return;
      this.vpStore.triggerGroupDream(this.groupId);
    },
    formatDreamTimestamp(ms) {
      if (!ms) return '';
      try { return new Date(ms).toLocaleString(); } catch (_) { return ''; }
    },
    // ── Delete session ──────────────────────────────────────
    async confirmDelete() {
      if (!this.deleteConfirmReady || this.deleteBusy || !this.chat) return;
      this.deleteBusy = true;
      this.deleteError = '';
      try {
        const res = await this.chat.sessionCrudRequest('delete', { sessionId: this.groupId });
        if (!res || !res.ok) {
          const code = (res && res.error && res.error.code) || 'unknown';
          const message = (res && res.error && res.error.message) || code;
          this.deleteError = this.$t('yeaft.session.error.unknown', { message });
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
      :aria-label="$t('yeaft.session.settings.title', { name: groupDisplayName })"
    >
      <div class="group-settings-modal">
        <header class="group-settings-header">
          <span class="group-settings-title">
            {{ $t('yeaft.session.settings.title', { name: groupDisplayName }) }}
          </span>
          <button
            class="group-settings-close"
            type="button"
            @click="requestClose"
            :disabled="announcementBusy || renameBusy || membersBusy || deleteBusy"
            :aria-label="$t('yeaft.session.settings.close')"
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
              :class="{ 'is-active': section === s.id }"
              role="tab"
              :aria-selected="section === s.id"
              @click="selectSection(s.id)"
            >{{ s.label }}</button>
          </nav>

          <!-- Right pane -->
          <section class="group-settings-pane">
            <!-- Session management -->
            <div v-if="section === 'session'" class="group-settings-section group-settings-section-session">
              <section class="group-settings-card">
                <h3 class="group-settings-heading">{{ $t('yeaft.session.settings.rename.heading') }}</h3>
                <label class="group-settings-field-label">{{ $t('yeaft.session.settings.rename.label') }}</label>
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
                  >{{ renameBusy ? $t('yeaft.session.settings.rename.saving') : $t('yeaft.session.settings.rename.save') }}</button>
                </div>
              </section>

              <section class="group-settings-card">
                <h3 class="group-settings-heading">{{ $t('yeaft.session.settings.announcement.heading') }}</h3>
                <p class="group-settings-help">{{ $t('yeaft.session.settings.announcement.help') }}</p>
                <textarea
                  class="group-settings-textarea"
                  v-model="announcementDraft"
                  :placeholder="$t('yeaft.session.announcement.placeholder')"
                  :disabled="announcementBusy"
                  rows="8"
                ></textarea>
                <p v-if="announcementError" class="group-settings-error" role="alert">{{ announcementError }}</p>
                <div class="group-settings-actions">
                  <button
                    type="button"
                    class="group-settings-primary"
                    :disabled="announcementBusy || announcementDraft === announcement"
                    @click="saveAnnouncement"
                  >{{ announcementBusy ? $t('yeaft.session.announcement.saving') : $t('common.save') }}</button>
                </div>
              </section>

              <section class="group-settings-card group-settings-section-delete">
                <h3 class="group-settings-heading">{{ $t('yeaft.session.settings.danger.heading') }}</h3>
                <p class="group-settings-help">{{ $t('yeaft.session.settings.danger.deleteHelp') }}</p>
                <label class="group-settings-field-label">
                  {{ $t('yeaft.session.deleteConfirm', { name: groupDisplayName }) }}
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
                    class="group-settings-delete-btn"
                    :disabled="!deleteConfirmReady || deleteBusy"
                    @click="confirmDelete"
                  >{{ deleteBusy ? $t('yeaft.session.deletingEllipsis') : $t('yeaft.session.settings.danger.deleteBtn') }}</button>
                </div>
              </section>
            </div>

            <!-- Members -->
            <div v-else-if="section === 'members'" class="group-settings-section">
              <div class="group-settings-section-header">
                <h3 class="group-settings-heading">{{ $t('yeaft.session.settings.members.heading') }}</h3>
                <button
                  type="button"
                  class="group-settings-link-btn"
                  :title="$t('yeaft.session.members.openLibraryHint')"
                  @click="$emit('open-vp-library')"
                >{{ $t('yeaft.session.members.openLibrary') }}</button>
              </div>
              <p class="group-settings-help">{{ $t('yeaft.session.members.defaultHint') }}</p>
              <div v-if="vpList.length === 0 && vpLibraryEmpty" class="group-settings-empty">
                {{ $t('yeaft.session.members.empty') }}
              </div>
              <div v-else-if="vpList.length === 0" class="group-settings-empty">
                {{ $t('yeaft.session.members.loading') }}
              </div>
              <ul v-else class="group-settings-roster" role="listbox" aria-multiselectable="true">
                <li
                  v-for="vp in vpList"
                  :key="vp.vpId"
                  class="group-settings-roster-item"
                  :class="{ 'is-selected': isMember(vp.vpId), 'is-default': defaultVpId === vp.vpId, 'is-edit-target': highlightedVpId === vp.vpId }"
                >
                  <label class="group-settings-roster-row">
                    <input
                      type="checkbox"
                      :value="vp.vpId"
                      :checked="isMember(vp.vpId)"
                      :disabled="membersBusy"
                      @change="toggleMember(vp.vpId, $event.target.checked)"
                    />
                    <span class="group-settings-roster-name" :style="{ color: vpTextColorFor(vp.vpId) }">{{ vpLabelFor(vp.vpId) }}</span>
                  </label>
                  <button
                    v-if="isMember(vp.vpId)"
                    type="button"
                    class="group-settings-default-star"
                    :class="{ 'is-on': defaultVpId === vp.vpId }"
                    :title="$t('yeaft.session.create.defaultVpHint')"
                    :aria-pressed="defaultVpId === vp.vpId"
                    :disabled="membersBusy || defaultVpId === vp.vpId"
                    @click.stop="setDefault(vp.vpId)"
                  ><span aria-hidden="true">{{ defaultVpId === vp.vpId ? '★' : '☆' }}</span></button>
                </li>
              </ul>
              <p v-if="membersError" class="group-settings-error" role="alert">{{ membersError }}</p>
            </div>

            <!-- Memory (manual dream trigger) -->
            <div v-else-if="section === 'memory'" class="group-settings-section">
              <h3 class="group-settings-heading">{{ $t('yeaft.session.settings.memory.heading') }}</h3>
              <p class="group-settings-help">{{ $t('yeaft.session.settings.memory.help') }}</p>
              <div class="group-settings-actions">
                <button
                  type="button"
                  class="group-settings-primary"
                  :disabled="dreamRunning"
                  @click="runDream"
                >{{ dreamRunning
                    ? $t('yeaft.session.settings.memory.running')
                    : $t('yeaft.session.settings.memory.runNow') }}</button>
              </div>
              <p
                v-if="groupDreamStatus.status === 'success' && groupDreamStatus.lastRunAt"
                class="group-settings-help group-settings-memory-status group-settings-memory-status-success"
              >{{ $t('yeaft.session.settings.memory.lastSuccess', {
                  time: formatDreamTimestamp(groupDreamStatus.lastRunAt),
                  count: groupDreamStatus.lastResult?.entriesCreated ?? 0,
              }) }}</p>
              <p
                v-else-if="groupDreamStatus.status === 'error'"
                class="group-settings-error group-settings-memory-status"
                role="alert"
              >{{ $t('yeaft.session.settings.memory.lastError', { error: groupDreamStatus.lastError || 'unknown' }) }}</p>
            </div>

          </section>
        </div>
      </div>
    </div>
    </Teleport>
  `,
};
