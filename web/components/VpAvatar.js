/**
 * VpAvatar — VP head circle (color + initial + optional status dot).
 * task-334-ui-a §4.1.
 *
 * Props:
 *   vpId      — required; lookup key into vp store
 *   size      — px diameter (default 20). 14 chip / 20 bubble / 24 sidebar / 32 detail.
 *   status    — 'online' | 'busy' | null (this slice only renders dot from prop;
 *               status feed comes from 334-ui-n vp_status events)
 *   ariaLabel — optional; falls back to displayName
 */
import { useVpStore } from '../stores/vp.js';

export default {
  name: 'VpAvatar',
  props: {
    vpId: { type: String, required: true },
    size: { type: Number, default: 20 },
    status: { type: String, default: null },
    ariaLabel: { type: String, default: '' },
  },
  template: `
    <span
      class="vp-avatar"
      :class="{ 'is-busy': status === 'busy', 'is-online': status === 'online' }"
      :style="avatarStyle"
      :aria-label="ariaLabel || displayName"
      role="img"
    >
      <span class="vp-avatar-letter">{{ initial }}</span>
      <span
        v-if="status === 'online' || status === 'busy'"
        class="vp-avatar-status-dot"
        :class="'status-' + status"
      ></span>
    </span>
  `,
  setup(props) {
    const store = useVpStore();
    const initial = Vue.computed(() => store.vpInitial(props.vpId));
    const displayName = Vue.computed(() => store.vpLabel(props.vpId));
    const color = Vue.computed(() => store.vpColor(props.vpId));
    const avatarStyle = Vue.computed(() => ({
      width: props.size + 'px',
      height: props.size + 'px',
      background: color.value,
      fontSize: Math.round(props.size * 0.5) + 'px',
    }));
    return { initial, displayName, avatarStyle };
  },
};
