/**
 * UserAvatar — legacy human-side badge.
 *
 * User turns no longer render a separate avatar in the Yeaft Session view.
 * Keep this tiny letter-only component for any stale/legacy import path, but
 * never render an image tag or request a human avatar asset. Missing static
 * files should not spam the console.
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
      const explicit = String(props.initial || '').trim();
      if (explicit) return Array.from(explicit)[0].toUpperCase();
      const label = typeof t === 'function' ? String(t('yeaft.user.youLabel') || '') : '';
      return Array.from(label.trim() || 'Y')[0].toUpperCase();
    });

    const avatarStyle = Vue.computed(() => ({
      width: `${props.size}px`,
      height: `${props.size}px`,
      fontSize: `${Math.max(11, Math.round(props.size * 0.42))}px`,
    }));

    return { displayedInitial, avatarStyle };
  },
};
