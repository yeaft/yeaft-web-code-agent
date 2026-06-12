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
    chatLabel()  { return this.$t('sidebar.toggle.chat'); },
    yeaftLabel() { return this.$t('sidebar.toggle.yeaft'); },
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
        <span class="mode-toggle-thumb"></span>
      </span>
    </button>
  `,
};
