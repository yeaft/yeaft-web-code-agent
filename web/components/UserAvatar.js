/**
 * UserAvatar — human-side circular avatar used by the Unify group-chat
 * dual-column layout (Issue C, IM-style: VP left / human right).
 *
 * The user identity here is intentionally minimal: this is a SINGLE-user
 * web app (the logged-in operator), so the avatar carries one initial
 * (the localised "you" character — `Y` for English, `我` for Chinese)
 * and a stable accent-color background that's distinct from any VP
 * color. The point of the avatar is layout symmetry with VP turns —
 * visual scaffolding for "this row was authored by the human" — not
 * user identification.
 *
 * Props:
 *   size      — px diameter (default 36, mirrors VpAvatar in turn blocks).
 *   initial   — optional override. When unset we fall back to the
 *               i18n-provided 'unify.user.youLabel' first char so zh
 *               users see "我" and en users see "Y". Passed strings
 *               longer than one character are reduced to first codepoint.
 *   ariaLabel — accessibility label (default 'You').
 */
export default {
  name: 'UserAvatar',
  props: {
    size: { type: Number, default: 36 },
    initial: { type: String, default: '' },
    ariaLabel: { type: String, default: 'You' },
  },
  template: `
    <span
      class="user-avatar"
      :style="avatarStyle"
      :aria-label="ariaLabel"
      role="img"
    >
      <span class="user-avatar-letter">{{ displayedInitial }}</span>
    </span>
  `,
  setup(props) {
    const t = Vue.inject('t', null);
    const displayedInitial = Vue.computed(() => {
      // Prop wins when explicitly set.
      let raw = (props.initial || '').trim();
      if (!raw) {
        // Fall back to the localised "you" label so the rendered glyph
        // matches the user's UI language (zh → 我, en → Y).
        raw = (t ? t('unify.user.youLabel') : 'Y').trim() || 'Y';
      }
      // First visible codepoint — handles CJK + emoji correctly.
      const first = Array.from(raw)[0] || 'Y';
      // CJK characters don't have a meaningful uppercase, so only
      // uppercase ASCII-ish ranges. This keeps "我" rendered as-is.
      return /[a-zA-Z]/.test(first) ? first.toUpperCase() : first;
    });
    const avatarStyle = Vue.computed(() => ({
      width: props.size + 'px',
      height: props.size + 'px',
      fontSize: Math.round(props.size * 0.5) + 'px',
    }));
    return { displayedInitial, avatarStyle };
  },
};
