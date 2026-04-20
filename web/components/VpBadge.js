/**
 * VpBadge — composite row (avatar + displayName + optional subtitle).
 * task-334-ui-a §4.2.
 */
import { useVpStore } from '../stores/vp.js';
import VpAvatar from './VpAvatar.js';

export default {
  name: 'VpBadge',
  components: { VpAvatar },
  props: {
    vpId: { type: String, required: true },
    size: { type: Number, default: 20 },
    showSubtitle: { type: Boolean, default: false },
    status: { type: String, default: null },
    compact: { type: Boolean, default: false },
  },
  template: `
    <span class="vp-badge" :class="{ compact }">
      <VpAvatar :vp-id="vpId" :size="size" :status="status" />
      <span class="vp-badge-text">
        <span class="vp-badge-name">{{ displayName }}</span>
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
    return { displayName, subtitle };
  },
};
