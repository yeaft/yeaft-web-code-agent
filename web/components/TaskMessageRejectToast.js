/**
 * TaskMessageRejectToast — task-334j §F.
 *
 * Bottom-right toast stack for `task_message_rejected` events.
 * Reads from `store.taskMessageRejects` (array of {id, code, at}).
 * Each toast auto-dismisses after 4s. Click to dismiss immediately.
 *
 * Styling pattern from CrewNotifications.js; positioned bottom-right
 * (not top-right) to avoid overlapping the breadcrumb / topbar area.
 */
import { i18nKeyForRejectCode } from '../utils/taskMessageRejectCodes.js';

export default {
  name: 'TaskMessageRejectToast',
  template: `
    <transition-group name="task-reject-toast" tag="div" class="task-reject-toasts">
      <div
        v-for="r in rejects"
        :key="r.id"
        class="task-reject-toast"
        @click="dismiss(r.id)"
      >
        <span class="task-reject-icon">&#9888;</span>
        <span>{{ $t(i18nKey(r.code)) }}</span>
      </div>
    </transition-group>
  `,
  setup() {
    const store = Pinia.useChatStore();
    const rejects = Vue.computed(() => store.taskMessageRejects || []);

    // Track which ids we've already set timers for to avoid double-dismiss.
    const timerSet = new Set();

    Vue.watch(rejects, (list) => {
      for (const r of list) {
        if (timerSet.has(r.id)) continue;
        timerSet.add(r.id);
        setTimeout(() => {
          store.dismissTaskMessageReject(r.id);
          timerSet.delete(r.id);
        }, 4000);
      }
    }, { deep: true, immediate: true });

    const dismiss = (id) => {
      store.dismissTaskMessageReject(id);
      timerSet.delete(id);
    };

    const i18nKey = (code) => i18nKeyForRejectCode(code);

    return { rejects, dismiss, i18nKey };
  },
};
