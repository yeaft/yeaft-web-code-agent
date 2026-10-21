import { openImagePreview } from '../../utils/imagePreview.js';

/** Render workspace SVG only as an image, never as active markup/document.
 * Image mode preserves declarative animations but disables script, navigation,
 * and external resources. A data URL has an opaque origin even if the user opens
 * the image directly; an unsanitized app-origin Blob would expose app credentials.
 */
export default {
  name: 'SvgPreview',
  props: {
    content: { type: String, default: '' },
    name: { type: String, required: true },
  },
  template: `
    <div class="file-preview-container svg-preview-container">
      <div class="html-preview-note">{{ $t('files.svgPreviewSafe') }}</div>
      <div v-if="loading" class="preview-loading" role="status">
        <span class="spinner-mini" aria-hidden="true"></span> {{ $t('files.loadingPreview') }}
      </div>
      <div v-if="failed" class="preview-error" role="alert">{{ $t('files.svgPreviewLoadFailed') }}</div>
      <button v-else type="button" v-show="!loading" class="file-preview-image-button"
        :aria-label="$t('message.imagePreview')" @click="openPreview($event.currentTarget)">
        <img :key="previewUrl" :src="previewUrl" :alt="name" class="file-preview-image svg-preview-image"
          referrerpolicy="no-referrer" @load="onLoad" @error="onError" />
      </button>
    </div>
  `,
  setup(props) {
    const t = Vue.inject('t');
    const previewUrl = Vue.ref('');
    const loading = Vue.ref(true);
    const failed = Vue.ref(false);
    Vue.watch(() => props.content, content => {
      loading.value = true;
      failed.value = false;
      previewUrl.value = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(content.toWellFormed())}`;
    }, { immediate: true, flush: 'sync' });

    const settle = (event, error) => {
      // An earlier image decode must not settle an edited/switched preview.
      if (event.target?.src !== previewUrl.value) return;
      loading.value = false;
      failed.value = error;
    };
    const openPreview = trigger => {
      if (loading.value || failed.value) return;
      openImagePreview(previewUrl.value, {
        alt: props.name,
        closeLabel: t('common.close'),
        zoomOutLabel: t('message.zoomOut'),
        zoomInLabel: t('message.zoomIn'),
        resetZoomLabel: t('message.resetZoom'),
        trigger,
      });
    };
    return {
      previewUrl, loading, failed, openPreview,
      onLoad: event => settle(event, false),
      onError: event => settle(event, true),
    };
  },
};
