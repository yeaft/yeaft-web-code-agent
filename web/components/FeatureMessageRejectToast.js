/**
 * FeatureMessageRejectToast — task-334j §F (renamed from TaskMessageRejectToast).
 *
 * Bottom-right toast stack for `feature_message_rejected` events.
 * Reads from `store.featureMessageRejects` (array of {id, code, at}).
 * Each toast auto-dismisses after 4s. Click to dismiss immediately.
 *
 * Styling pattern from CrewNotifications.js; positioned bottom-right
 * (not top-right) to avoid overlapping the breadcrumb / topbar area.
 */
import { i18nKeyForRejectCode } from '../utils/featureMessageRejectCodes.js';

export default {
  name: 'FeatureMessageRejectToast',
  template: `
    <transition-group name="feature-reject-toast" tag="div" class="feature-reject-toasts">
      <div
        v-for="r in rejects"
        :key="r.id"
        class="feature-reject-toast"
        @click="dismiss(r.id)"
      >
        <span class="feature-reject-icon">&#9888;</span>
        <span>{{ $t(i18nKey(r.code)) }}</span>
      </div>
    </transition-group>
  `,
  setup() {
    const store = Pinia.useChatStore();
    const rejects = Vue.computed(() => store.featureMessageRejects || []);

    // Track which ids we've already set timers for to avoid double-dismiss.
    const timerSet = new Set();

    Vue.watch(rejects, (list) => {
      for (const r of list) {
        if (timerSet.has(r.id)) continue;
        timerSet.add(r.id);
        setTimeout(() => {
          store.dismissFeatureMessageReject(r.id);
          timerSet.delete(r.id);
        }, 4000);
      }
    }, { deep: true, immediate: true });

    const dismiss = (id) => {
      store.dismissFeatureMessageReject(id);
      timerSet.delete(id);
    };

    const i18nKey = (code) => i18nKeyForRejectCode(code);

    return { rejects, dismiss, i18nKey };
  },
};
