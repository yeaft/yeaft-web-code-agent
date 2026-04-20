/**
 * VpLibraryLink — sidebar footer entry into the VP library.
 * task-334-ui-a §4.3.
 *
 * Empty-library fallback (G1):
 *   vpCount === 0 → icon ➕, label "+ Create your first role".
 * Otherwise → icon 📗, label "VP Library", count pill.
 *
 * MVP: click emits `open-library`; the full modal lands in 334-ui-g.
 */
import { useVpStore } from '../stores/vp.js';

export default {
  name: 'VpLibraryLink',
  emits: ['open-library'],
  template: `
    <button
      class="vp-library-link"
      :class="{ 'is-empty': isEmpty }"
      type="button"
      :aria-label="ariaLabel"
      @click="$emit('open-library')"
    >
      <span class="vp-library-icon" aria-hidden="true">{{ icon }}</span>
      <span class="vp-library-label">{{ label }}</span>
      <span class="vp-library-count" v-if="!isEmpty && count > 0">{{ count }}</span>
      <span class="vp-library-arrow" aria-hidden="true">→</span>
    </button>
  `,
  computed: {
    vpStore() { return useVpStore(); },
    count() { return this.vpStore.vpCount; },
    isEmpty() { return this.vpStore.vpCount === 0; },
    icon() { return this.isEmpty ? '\u2795' : '\uD83D\uDCD7'; },
    label() {
      return this.isEmpty
        ? this.$t('unify.vp.createFirst')
        : this.$t('unify.vp.library');
    },
    ariaLabel() {
      return this.isEmpty
        ? this.$t('unify.vp.empty.aria')
        : this.$t('unify.vp.library');
    },
  },
};
