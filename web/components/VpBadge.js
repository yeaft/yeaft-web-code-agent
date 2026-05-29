/**
 * VpBadge — composite row (displayName + optional subtitle).
 * task-334-ui-a §4.2.
 *
 * task-334-ui-c: opt-in `clickable` prop turns the badge into a focusable
 * button that emits `open-detail` with the vpId. Consumers (speaker
 * header / activity lists) pass `clickable` and wire the emit to
 * chatStore.enterVpDetailView(vpId). Non-clickable default preserves
 * the 334-ui-a static-badge contract.
 */
import { useVpStore } from '../stores/vp.js';

export default {
  name: 'VpBadge',
  emits: ['open-detail'],
  props: {
    vpId: { type: String, required: true },
    size: { type: Number, default: 20 },
    showSubtitle: { type: Boolean, default: false },
    status: { type: String, default: null },
    typing: { type: Boolean, default: false },
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
      <span class="vp-badge-text">
        <span class="vp-badge-name" :style="nameStyle">{{ displayName }}</span>
        <span
          v-if="showSubtitle && subtitle"
          class="vp-badge-subtitle"
        >{{ subtitle }}</span>
      </span>
    </button>
    <span v-else class="vp-badge" :class="{ compact }">
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
