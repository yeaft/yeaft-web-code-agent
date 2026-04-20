/**
 * VpBadge — composite row (avatar + displayName + optional subtitle).
 * task-334-ui-a §4.2.
 *
 * task-334-ui-c: opt-in `clickable` prop turns the badge into a focusable
 * button that emits `open-detail` with the vpId. Consumers (speaker
 * header / activity lists) pass `clickable` and wire the emit to
 * chatStore.enterVpDetailView(vpId). Non-clickable default preserves
 * the 334-ui-a static-badge contract.
 */
import { useVpStore } from '../stores/vp.js';
import VpAvatar from './VpAvatar.js';

export default {
  name: 'VpBadge',
  components: { VpAvatar },
  emits: ['open-detail'],
  props: {
    vpId: { type: String, required: true },
    size: { type: Number, default: 20 },
    showSubtitle: { type: Boolean, default: false },
    status: { type: String, default: null },
    compact: { type: Boolean, default: false },
    clickable: { type: Boolean, default: false },
  },
  template: `
    <button
      v-if="clickable"
      class="vp-badge vp-badge-clickable"
      :class="{ compact }"
      type="button"
      :aria-label="displayName"
      @click.stop="$emit('open-detail', vpId)"
    >
      <VpAvatar :vp-id="vpId" :size="size" :status="status" />
      <span class="vp-badge-text">
        <span class="vp-badge-name">{{ displayName }}</span>
        <span
          v-if="showSubtitle && subtitle"
          class="vp-badge-subtitle"
        >{{ subtitle }}</span>
      </span>
    </button>
    <span v-else class="vp-badge" :class="{ compact }">
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
