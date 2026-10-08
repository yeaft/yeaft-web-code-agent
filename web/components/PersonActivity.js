/** Readable activity projection only; raw traces belong to the debug surface. */
export default {
  name: 'PersonActivity',
  props: {
    activity: { type: Object, required: true },
  },
  computed: {
    hasDetails() { return !!(this.activity.rows.length || this.activity.limited); },
  },
  methods: {
    duration(value) {
      if (!Number.isFinite(value) || value < 0) return '';
      const seconds = Math.floor(value / 1000);
      return seconds < 60
        ? this.$t('person.activity.durationSeconds', { seconds })
        : this.$t('person.activity.durationMinutes', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
    },
  },
  template: `
    <component :is="hasDetails ? 'details' : 'div'" v-if="activity.visible" class="person-activity">
      <component :is="hasDetails ? 'summary' : 'div'" class="person-activity-summary">
        <span class="person-activity-status" :class="{ 'person-response-loading': activity.loading }" role="status" aria-live="polite" aria-atomic="true" :aria-label="$t(activity.label, activity.params)">
          <span>{{ $t(activity.label, activity.params) }}</span>
          <span v-if="activity.loading" class="typing-indicator" aria-hidden="true"><span></span><span></span><span></span></span>
        </span>
        <span v-if="hasDetails" class="person-activity-disclosure">{{ $t('person.activity.details') }}</span>
      </component>
      <template v-if="hasDetails">
        <ul class="person-activity-rows">
          <li v-for="row in activity.rows" :key="row.id" class="person-activity-row" :data-activity-status="row.status">
            <span class="person-activity-row-label">{{ $t(row.label, row.params) }}<span v-if="row.params?.name" class="person-activity-name"> · {{ row.params.name }}</span></span>
            <span class="person-activity-row-status">{{ $t('person.activity.status.' + row.status) }}</span>
            <span v-if="duration(row.durationMs)" class="person-activity-elapsed">{{ $t('person.activity.elapsed', { duration: duration(row.durationMs) }) }}</span>
          </li>
        </ul>
        <p v-if="activity.limited" class="person-activity-limited">{{ $t('person.activity.limited') }}</p>
      </template>
    </component>
  `,
};
