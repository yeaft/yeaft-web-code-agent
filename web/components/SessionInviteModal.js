/**
 * SessionInviteModal — task-334m prev-2 rev.
 *
 * Shown whenever the active group has no default VP + empty roster
 * (i.e. `sessionsStore.activeNeedsInvite === true`). Drives the hard-
 * constraint (c) default-VP fallback path per R6 §Δ10.
 *
 * Two CTAs: "Open VP Library" (bubbles `open-library` up to YeaftPage
 * which flips vpLibraryOpen) and "Not now" (dismiss; sets a per-group
 * suppression flag so it won't re-pop mid-session).
 *
 * No Pinia imports at module scope — stores are resolved lazily via
 * window.Pinia so the component stays importable from node-only tests.
 */

export default {
  name: 'SessionInviteModal',
  emits: ['open-library', 'dismiss'],
  props: {
    groupName: { type: String, default: '' },
  },
  template: `
    <div class="group-invite-overlay" @click.self="onDismiss" role="dialog" aria-modal="true" :aria-label="$t('yeaft.session.invite.title')">
      <div class="group-invite-modal">
        <header class="group-invite-header">
          <span class="group-invite-title">{{ $t('yeaft.session.invite.title') }}</span>
        </header>
        <div class="group-invite-body">
          <p>{{ $t('yeaft.session.invite.body', { name: groupName || '' }) }}</p>
        </div>
        <div class="group-invite-actions">
          <button type="button" class="group-invite-dismiss" @click="onDismiss">
            {{ $t('yeaft.session.invite.dismiss') }}
          </button>
          <button type="button" class="group-invite-primary" @click="onOpen">
            {{ $t('yeaft.session.invite.openLibrary') }}
          </button>
        </div>
      </div>
    </div>
  `,
  mounted() {
    window.addEventListener('keydown', this.onEsc);
  },
  beforeUnmount() {
    window.removeEventListener('keydown', this.onEsc);
  },
  methods: {
    onEsc(e) {
      if (e.key === 'Escape') this.onDismiss();
    },
    onOpen() { this.$emit('open-library'); },
    onDismiss() { this.$emit('dismiss'); },
  },
};
