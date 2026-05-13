/**
 * UserAvatar — human-side circular avatar used by the Unify group-chat
 * dual-column layout (Issue C, IM-style: VP left / human right).
 *
 * Visual stack (back → front):
 *   1. Accent-coloured palette disk (background of `.user-avatar` in CSS)
 *   2. Illustrated SVG portrait — `/assets/avatars/user.svg`, generated
 *      with DiceBear `personas` style (same generator as the VP roster
 *      in `scripts/generate-avatars.mjs`) so the human side renders in
 *      the same visual language as the VPs.
 *   3. Letter (localised "you" character) — rendered ONLY when the SVG
 *      fails to load. Keeps the original Issue-C look as fallback.
 *
 * The illustration layer is the new piece. Failure path (404, corrupt
 * file, browser-blocked) falls back to the localised initial so the
 * avatar is never visually broken.
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
      <img
        v-if="!imgFailed"
        class="user-avatar-img"
        src="/assets/avatars/user.svg"
        alt=""
        draggable="false"
        @error="onImgError"
      />
      <span v-else class="user-avatar-letter">{{ displayedInitial }}</span>
    </span>
  `,
  setup(props) {
    const t = Vue.inject('t', null);
    const imgFailed = Vue.ref(false);
    function onImgError() {
      imgFailed.value = true;
    }
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
    return { displayedInitial, avatarStyle, imgFailed, onImgError };
  },
};
