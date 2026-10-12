import { mapEmbedUrl, mapProviderUrl, mapDirectionsUrl } from '../utils/response-presentation.js';

/** Approved third-party frame only. A load event is not proof of cross-origin content availability. */
export default {
  name: 'ResponseMapEmbed',
  props: { block: { type: Object, required: true } },
  data: () => ({ selectedIndex: 0, state: 'loading', coordinatesOnly: false, revision: 0, loadTimer: null }),
  computed: {
    source() { return mapEmbedUrl(this.block, this.selectedIndex); },
    selectedPoint() { return this.block.points[this.selectedIndex] || this.block.points[0]; },
    providerUrl() { return mapProviderUrl(this.block, this.selectedIndex); },
    provider() { return this.block.embed.provider === 'google' ? 'Google Maps' : 'OpenStreetMap'; },
    statusKey() { return this.state === 'timeout' ? 'richResponse.mapTimeout' : this.state === 'error' ? 'richResponse.mapError' : 'richResponse.mapLoading'; },
  },
  watch: {
    source: { immediate: true, handler() { this.retry(); } },
    'block.points'(points) { if (this.selectedIndex >= points.length) this.selectedIndex = 0; },
  },
  beforeUnmount() { clearTimeout(this.loadTimer); },
  methods: {
    retry() {
      clearTimeout(this.loadTimer);
      this.revision++;
      this.state = 'loading';
      this.coordinatesOnly = false;
      const revision = this.revision;
      if (this.source) this.loadTimer = setTimeout(() => {
        if (this.revision === revision && this.state === 'loading') this.state = 'timeout';
      }, 12000);
    },
    settle(event, state) {
      // Ignore load/error from a frame detached by selection, retry, replacement or fallback.
      if (this.coordinatesOnly || event.currentTarget?.dataset.mapRevision !== String(this.revision)) return;
      clearTimeout(this.loadTimer);
      this.state = state;
    },
    showCoordinates() {
      clearTimeout(this.loadTimer);
      this.revision++;
      this.coordinatesOnly = true;
    },
    coordinates(point) { return `${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)}`; },
    mapDirectionsUrl,
  },
  template: `<div class="response-map-embed">
    <div class="response-map-caption"><strong>{{ provider }}</strong><span>{{ $t('richResponse.mapEmbedNotice') }}</span>
      <span v-if="block.embed.provider === 'google'">{{ $t('richResponse.googleShareNotice') }}</span>
      <span>{{ $t('richResponse.mapPrivacyNotice') }}</span>
    </div>
    <label v-if="block.embed.provider === 'openstreetmap' && block.points.length > 1" class="response-map-select">
      <span>{{ $t('richResponse.mapLocation') }}</span>
      <select v-model.number="selectedIndex"><option v-for="(point, pi) in block.points" :key="pi" :value="pi">{{ pi + 1 }} · {{ point.label }}</option></select>
    </label>
    <iframe v-if="source && !coordinatesOnly" :key="revision" :data-map-revision="revision" :src="source"
      :title="provider + ' · ' + (block.title || selectedPoint.label)" tabindex="0"
      sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer"
      @load="settle($event, 'loaded')" @error="settle($event, 'error')"></iframe>
    <p v-if="!coordinatesOnly && state !== 'loaded'" class="response-status" role="status" :aria-busy="state === 'loading'">{{ $t(statusKey) }}</p>
    <p v-if="coordinatesOnly" class="response-status" role="status">{{ $t('richResponse.coordinatesOnlyNotice') }}</p>
    <div class="response-map-actions">
      <button type="button" class="btn-secondary" @click="retry">{{ $t('richResponse.retryMap') }}</button>
      <button v-if="!coordinatesOnly" type="button" class="btn-ghost" @click="showCoordinates">{{ $t('richResponse.coordinatesOnly') }}</button>
      <span v-if="providerUrl" class="response-map-provider">
        <a :href="providerUrl" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">{{ $t(block.embed.provider === 'google' ? 'richResponse.openGoogleMaps' : 'richResponse.openOpenStreetMap') }}</a><a class="response-external" data-response-external :href="providerUrl" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" :aria-label="$t('richResponse.newTab') + ': ' + provider" :title="$t('richResponse.newTab')">↗</a>
      </span>
    </div>
    <ol class="response-map-list"><li v-for="(point, pi) in block.points" :key="pi">
      <div><strong>{{ point.label }}</strong><span>{{ coordinates(point) }}</span></div><p v-if="point.detail">{{ point.detail }}</p>
      <span class="response-map-directions"><a :href="mapDirectionsUrl(point)" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">{{ $t('richResponse.googleDirections') }}</a><a class="response-external" data-response-external :href="mapDirectionsUrl(point)" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" :aria-label="$t('richResponse.newTab') + ': ' + point.label" :title="$t('richResponse.newTab')">↗</a></span>
    </li></ol>
    <p class="response-notice">{{ $t('richResponse.directionsNotice') }}</p>
  </div>`,
};
