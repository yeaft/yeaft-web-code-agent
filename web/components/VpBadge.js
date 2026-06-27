/**
 * VpBadge — composite row (displayName + optional subtitle).
 * task-334-ui-a §4.2.
 *
 * Static identity badge. VP detail drill-down was removed, so the badge no
 * longer exposes a clickable mode.
 */
import { useVpStore } from '../stores/vp.js';

export default {
  name: 'VpBadge',
  props: {
    vpId: { type: String, required: true },
    size: { type: Number, default: 20 },
    showSubtitle: { type: Boolean, default: false },
    status: { type: String, default: null },
    typing: { type: Boolean, default: false },
    compact: { type: Boolean, default: false },
  },
  template: `
    <span class="vp-badge" :class="{ compact }">
      <span class="vp-badge-text">
        <span class="vp-badge-name" :style="nameStyle">{{ displayName }}</span>
        <span
          v-if="showSubtitle && subtitle"
          class="vp-badge-subtitle"
        >{{ subtitle }}</span>
      </span>
    </span>
  `,
  setup(props) {
    const store = useVpStore();
    const displayName = Vue.computed(() => store.vpLabel(props.vpId));
    const subtitle = Vue.computed(() => {
      const v = store.vpById(props.vpId);
      return v ? (v.subtitle || v.role || '') : '';
    });
    const nameStyle = Vue.computed(() => ({ color: store.vpTextColor(props.vpId) }));
    return { displayName, subtitle, nameStyle };
  },
};
