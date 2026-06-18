/**
 * SessionAnnouncementBar — collapsible banner at the top of the message list
 * that surfaces the current Session's announcement (CLAUDE.md-style shared
 * prefix injected into every VP's system prompt).
 *
 * Mount contract: rendered inside MessageList ABOVE the message stream
 * when an active Session is selected and its `announcement` is non-empty
 * (or when the user explicitly expands an empty bar to author one).
 *
 * Behavior:
 *   - Collapsed by default (icon + 1-line preview), click to expand.
 *   - Click ✏️ to enter edit mode → textarea with Save / Cancel.
 *   - Save updates the Session via store.sessionCrudRequest('update').
 *   - Empty/whitespace announcements clear the field on the agent side.
 *   - "Open settings" link emits a request to the parent page so the user
 *     can jump to the full SessionSettingsModal (which surfaces the same
 *     editor in a richer layout alongside members + rename + danger zone).
 */
export default {
  name: 'SessionAnnouncementBar',
  emits: ['open-settings'],
  props: {
    sessionId: { type: String, default: '' },
    // Legacy prop alias for older callers; new callers must pass sessionId.
    groupId: { type: String, default: '' },
  },
  data() {
    return {
      expanded: false,
      editing: false,
      draft: '',
      busy: false,
      error: '',
    };
  },
  computed: {
    chat() {
      try {
        return window.Pinia?.useChatStore?.() || null;
      } catch (_) { return null; }
    },
    sessionsStore() {
      try {
        return window.Pinia?.useSessionsStore?.() || null;
      } catch (_) { return null; }
    },
    currentSessionId() {
      return this.sessionId || this.groupId || '';
    },
    session() {
      const gs = this.sessionsStore;
      if (!gs || !gs.sessions || !this.currentSessionId) return null;
      return gs.sessions[this.currentSessionId] || null;
    },
    announcement() {
      const session = this.session;
      return session && typeof session.announcement === 'string' ? session.announcement : '';
    },
    hasAnnouncement() {
      return !!this.announcement.trim();
    },
    preview() {
      // Single-line preview clamped to ~80 chars; full text shows when expanded.
      const text = this.announcement.replace(/\s+/g, ' ').trim();
      if (text.length <= 80) return text;
      return text.slice(0, 79) + '…';
    },
  },
  watch: {
    // If the Session flips out from under the bar, reset local edit state so
    // we don't leak draft text across sessions.
    sessionId() {
      this.resetLocalState();
    },
    groupId() {
      // Legacy prop alias watcher. Canonical callers use sessionId.
      this.resetLocalState();
    },
  },
  methods: {
    resetLocalState() {
      this.expanded = false;
      this.editing = false;
      this.draft = '';
      this.error = '';
    },
    toggleExpand() {
      if (this.editing) return;
      this.expanded = !this.expanded;
    },
    startEdit() {
      this.draft = this.announcement;
      this.error = '';
      this.editing = true;
      this.expanded = true;
      // Defer focus to next tick so the textarea exists.
      this.$nextTick(() => {
        const ta = this.$refs.textarea;
        if (ta && typeof ta.focus === 'function') ta.focus();
      });
    },
    cancelEdit() {
      this.editing = false;
      this.draft = '';
      this.error = '';
    },
    async saveEdit() {
      if (this.busy || !this.chat) return;
      this.busy = true;
      this.error = '';
      try {
        const res = await this.chat.sessionCrudRequest('update', {
          sessionId: this.currentSessionId,
          patch: { announcement: this.draft },
        });
        if (res && res.ok) {
          this.editing = false;
          // Keep `expanded` true so the user sees the saved text.
        } else {
          const code = (res && res.error && res.error.code) || 'unknown';
          const message = (res && res.error && res.error.message) || code;
          this.error = this.$t('yeaft.session.announcement.saveFailed', { error: message });
        }
      } finally {
        this.busy = false;
      }
    },
    onOpenSettings() {
      this.$emit('open-settings', { sessionId: this.currentSessionId, section: 'announcement' });
    },
  },
  template: `
    <div
      class="session-announcement-bar"
      :class="{
        'is-expanded': expanded,
        'is-editing': editing,
        'is-empty': !hasAnnouncement && !editing
      }"
    >
      <!-- Collapsed header: icon + preview + actions. Click body toggles expand. -->
      <div
        class="session-announcement-bar__header"
        @click="toggleExpand"
        role="button"
        tabindex="0"
        @keydown.enter="toggleExpand"
        @keydown.space.prevent="toggleExpand"
        :aria-expanded="expanded"
      >
        <span class="session-announcement-bar__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M18 11v3.5l-2.5-1.5h-7C7.67 13 7 12.33 7 11.5v-7C7 3.67 7.67 3 8.5 3h11c.83 0 1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5H18zm-13.5 1H6v3.5L8.5 14h7c.83 0 1.5-.67 1.5-1.5V12h2v.5c0 1.93-1.57 3.5-3.5 3.5h-6L4 19v-5.5C2.9 13.5 2 12.6 2 11.5v-5C2 5.4 2.9 4.5 4 4.5v6c0 .83.22 1.5.5 1.5z"/></svg>
        </span>
        <span class="session-announcement-bar__label">
          {{ $t('yeaft.session.announcement.label') }}
        </span>
        <span
          v-if="hasAnnouncement && !expanded"
          class="session-announcement-bar__preview"
        >{{ preview }}</span>
        <span
          v-else-if="!hasAnnouncement && !expanded"
          class="session-announcement-bar__hint"
        >{{ $t('yeaft.session.announcement.hintEmpty') }}</span>
        <button
          v-if="!editing"
          type="button"
          class="session-announcement-bar__edit-btn"
          :title="$t('yeaft.session.announcement.edit')"
          :aria-label="$t('yeaft.session.announcement.edit')"
          @click.stop="startEdit"
        >
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
        </button>
        <span class="session-announcement-bar__chevron" :class="{ open: expanded }" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
        </span>
      </div>

      <!-- Expanded body: read-only full text or editor textarea. -->
      <div v-if="expanded" class="session-announcement-bar__body" @click.stop>
        <pre
          v-if="!editing && hasAnnouncement"
          class="session-announcement-bar__text"
        >{{ announcement }}</pre>
        <p
          v-else-if="!editing"
          class="session-announcement-bar__empty"
        >{{ $t('yeaft.session.announcement.emptyBody') }}</p>
        <template v-else>
          <textarea
            ref="textarea"
            v-model="draft"
            class="session-announcement-bar__textarea"
            :placeholder="$t('yeaft.session.announcement.placeholder')"
            :disabled="busy"
            rows="6"
          ></textarea>
          <p v-if="error" class="session-announcement-bar__error" role="alert">{{ error }}</p>
          <div class="session-announcement-bar__actions">
            <button
              type="button"
              class="session-announcement-bar__cancel"
              :disabled="busy"
              @click="cancelEdit"
            >{{ $t('common.cancel') }}</button>
            <button
              type="button"
              class="session-announcement-bar__save"
              :disabled="busy || draft === announcement"
              @click="saveEdit"
            >{{ busy ? $t('yeaft.session.announcement.saving') : $t('common.save') }}</button>
          </div>
        </template>
        <button
          v-if="!editing"
          type="button"
          class="session-announcement-bar__settings-link"
          @click="onOpenSettings"
        >{{ $t('yeaft.session.announcement.openSettings') }}</button>
      </div>
    </div>
  `,
};
