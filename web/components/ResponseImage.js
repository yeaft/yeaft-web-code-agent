// Shared external image state: replacement/retry fence detached load/error events.
export default {
  name: 'ResponseImage',
  props: { block: { type: Object, required: true }, card: { type: Boolean, default: false } },
  data: () => ({ state: 'loading', expanded: false, revision: 0 }),
  watch: { 'block.url'() { this.retry(); } },
  computed: { host() { return new URL(this.block.url).host; } },
  methods: {
    retry() { this.revision++; this.state = 'loading'; this.expanded = false; },
    settle(event, state) {
      // A detached image can finish after URL replacement or retry.
      if (event.currentTarget?.dataset.imageRevision === String(this.revision)) this.state = state;
    },
  },
  template: `<figure class="response-image" :class="{ 'is-expanded': expanded, 'response-card-image': card, 'is-contain': card && block.fit === 'contain' }">
    <div v-if="state !== 'loaded'" class="response-image-placeholder" :aria-busy="state === 'loading'">
      <strong>{{ block.alt }}</strong><span>{{ host }}</span>
      <p role="status">{{ $t(state === 'error' ? (card ? 'richResponse.cardImageError' : 'richResponse.imageError') : 'richResponse.loading') }}</p>
      <button v-if="state === 'error'" type="button" class="btn-secondary" @click="retry">{{ $t('richResponse.retryImage') }}</button>
    </div>
    <img v-if="state === 'loading' || state === 'loaded'" :key="revision" :data-image-revision="revision"
      v-show="state === 'loaded'" :src="block.url" :alt="block.alt"
      referrerpolicy="no-referrer" decoding="async" @load="settle($event, 'loaded')" @error="settle($event, 'error')" />
    <figcaption v-if="block.caption">{{ block.caption }}</figcaption>
    <button v-if="!card && state === 'loaded'" type="button" class="btn-ghost" :aria-expanded="expanded" @click="expanded = !expanded">
      {{ $t(expanded ? 'richResponse.closePreview' : 'richResponse.previewImage') }}
    </button>
  </figure>`,
};
