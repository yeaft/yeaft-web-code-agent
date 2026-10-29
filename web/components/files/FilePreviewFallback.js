/** A readable terminal state for unsupported or failed previews. Never renders file HTML. */
export default {
  name: 'FilePreviewFallback',
  props: {
    file: { type: Object, required: true },
    error: { type: String, default: '' },
  },
  emits: ['download'],
  computed: {
    format() {
      const extension = this.file.name?.match(/\.([^.]+)$/)?.[1];
      return extension ? extension.toUpperCase() : this.$t('files.binaryFile');
    },
  },
  template: `
    <div class="file-preview-fallback" :role="error ? 'alert' : 'status'">
      <strong class="file-preview-fallback-name">{{ file.name }}</strong>
      <span class="file-preview-fallback-format">{{ format }}<template v-if="file.mimeType"> · {{ file.mimeType }}</template></span>
      <p class="file-preview-fallback-message">{{ error || $t('files.previewUnavailable') }}</p>
      <button type="button" class="btn-secondary" @click="$emit('download')">{{ $t('files.download') }}</button>
      <span class="file-preview-fallback-hint">{{ $t('files.downloadLimit') }}</span>
    </div>
  `,
};
