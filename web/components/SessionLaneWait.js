import { pickWaitingAnimation, waitingAnimation } from './waiting/index.js';

// A streaming sibling must not hide this lane's wait. Use the same
// animation/fallback as the single transcript, scoped to this user turn.
export default {
  name: 'SessionLaneWait',
  props: { preference: String, seed: Number, clockKey: String, status: String },
  template: `
    <div class="typing-indicator" :class="[animation ? 'is-' + animation.layout : '', status ? 'status-' + status : '']" aria-hidden="true">
      <component v-if="animation" :is="animation.component" :clock-key="clockKey" :status="status || ''" />
      <template v-else><span></span><span></span><span></span></template>
    </div>
  `,
  setup(props) {
    const animation = Vue.computed(() => waitingAnimation(pickWaitingAnimation(props.preference, props.seed)));
    return { animation };
  },
};
