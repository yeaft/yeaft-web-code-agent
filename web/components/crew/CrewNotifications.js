/**
 * CrewNotifications — Route notification toasts (top-right corner).
 *
 * Shows a brief toast when a crew_routing event fires.
 * Each toast auto-dismisses after 4 seconds, multiple stack vertically.
 */
import { shortName } from './crewHelpers.js';

export default {
  name: 'CrewNotifications',
  props: {
    notifications: { type: Array, default: () => [] }
  },
  emits: ['dismiss'],
  template: `
    <transition-group name="crew-notif" tag="div" class="crew-notifications">
      <div v-for="n in notifications" :key="n.id"
           class="crew-notif-toast"
           @click="$emit('dismiss', n.id)">
        <span v-if="n.fromIcon" class="crew-notif-icon">{{ n.fromIcon }}</span>
        <span class="crew-notif-name">{{ short(n.fromName) }}</span>
        <span class="crew-notif-arrow">&rarr;</span>
        <span v-if="n.toIcon" class="crew-notif-icon">{{ n.toIcon }}</span>
        <span class="crew-notif-name">{{ short(n.toName) }}</span>
        <span v-if="n.taskTitle" class="crew-notif-task">{{ n.taskTitle }}</span>
      </div>
    </transition-group>
  `,
  methods: {
    short(name) {
      return shortName(name);
    }
  },
  watch: {
    notifications: {
      handler(newList) {
        // Auto-dismiss after 4s for any new notification
        for (const n of newList) {
          if (!n._timerSet) {
            n._timerSet = true;
            setTimeout(() => this.$emit('dismiss', n.id), 4000);
          }
        }
      },
      deep: true,
      immediate: true
    }
  }
};
