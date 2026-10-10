export default {
  name: 'PersonResponseLoading',
  props: { feedback: { type: Object, default: null } },
  methods: { time(value) { return value ? new Date(value).toLocaleString() : ''; } },
  template: `
    <div class="person-response-loading" role="status" aria-live="polite" aria-atomic="true" :aria-label="$t('sidebar.sessions.processing')">
      <div v-if="feedback" class="person-wait-feedback">
        <span>{{ $t(feedback.label) }}</span>
        <time :datetime="feedback.at">{{ $t('person.feedback.confirmedAt', { time: time(feedback.at) }) }}</time>
      </div>
      <span class="typing-indicator" aria-hidden="true"><span></span><span></span><span></span></span>
    </div>
  `,
};
