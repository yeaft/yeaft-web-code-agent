/**
 * SidebarModeToggle — iOS-style left/right slide switch flipping the
 * sidebar (and the whole top-level view) between Chat and Yeaft.
 *
 * Replaces the lightning-icon button shipped in v0.1.879 (PR #885). The
 * widget is bound to `chat.currentView`; clicking the off-side calls
 * `enterYeaft()` / `leaveYeaft()` so the existing view-transition
 * helpers (snapshot/restore of `activeConversations`) still fire.
 *
 * Disabled when there are no online agents — same gate the old button
 * used.
 */

export default {
  name: 'SidebarModeToggle',
  props: {
    view: { type: String, required: true },     // 'chat' | 'yeaft'
    disabled: { type: Boolean, default: false },
  },
  emits: ['flip'],
  computed: {
    isYeaft() { return this.view === 'yeaft'; },
    chatLabel() {
      if (typeof this.$t === 'function') {
        const v = this.$t('sidebar.toggle.chat');
        if (v && v !== 'sidebar.toggle.chat') return v;
      }
      return 'Chat';
    },
    yeaftLabel() {
      if (typeof this.$t === 'function') {
        const v = this.$t('sidebar.toggle.yeaft');
        if (v && v !== 'sidebar.toggle.yeaft') return v;
      }
      return 'Yeaft';
    },
    titleText() {
      return this.isYeaft ? this.chatLabel : this.yeaftLabel;
    },
  },
  methods: {
    onClick() {
      if (this.disabled) return;
      this.$emit('flip', this.isYeaft ? 'chat' : 'yeaft');
    },
    onKeydown(e) {
      if (this.disabled) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.onClick();
      } else if (e.key === 'ArrowLeft' && this.isYeaft) {
        e.preventDefault();
        this.$emit('flip', 'chat');
      } else if (e.key === 'ArrowRight' && !this.isYeaft) {
        e.preventDefault();
        this.$emit('flip', 'yeaft');
      }
    },
  },
  template: `
    <button
      type="button"
      class="mode-toggle"
      :class="{ 'is-yeaft': isYeaft, disabled: disabled }"
      :disabled="disabled"
      :aria-pressed="isYeaft ? 'true' : 'false'"
      :aria-label="titleText"
      :title="titleText"
      role="switch"
      @click="onClick"
      @keydown="onKeydown"
    >
      <span class="mode-toggle-track">
        <span class="mode-toggle-label left" :class="{ active: !isYeaft }">
          <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
            <path fill="currentColor" d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/>
          </svg>
        </span>
        <span class="mode-toggle-label right" :class="{ active: isYeaft }">
          <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
            <path fill="currentColor" d="M7 2v11h3v9l7-12h-4l4-8z"/>
          </svg>
        </span>
        <span class="mode-toggle-thumb"></span>
      </span>
    </button>
  `,
};
