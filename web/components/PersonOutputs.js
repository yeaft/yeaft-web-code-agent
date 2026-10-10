import { safeOutputUrl, staticOutputHtml } from '../stores/helpers/person-outputs.js';
import { renderSafeMessageMarkdown } from '../utils/safe-message-markdown.js';

export default {
  name: 'PersonOutputs',
  props: {
    state: { type: Object, required: true },
    supported: { type: Boolean, default: false },
    fileSupported: { type: Boolean, default: null },
    disabled: { type: Boolean, default: false },
    gate: { type: String, default: '' },
  },
  emits: ['select', 'refresh', 'more', 'retry'],
  setup(props) {
    const zoom = Vue.ref(1);
    const fit = Vue.ref(true);
    Vue.watch(() => props.state.selected?.id, () => { zoom.value = 1; fit.value = true; });
    const preview = Vue.computed(() => props.state.preview);
    const externalUrl = Vue.computed(() => safeOutputUrl(props.state.selected?.url));
    const html = Vue.computed(() => preview.value.kind === 'html' && preview.value.status === 'ready' ? staticOutputHtml(preview.value.text) : '');
    const markdown = Vue.computed(() => preview.value.kind === 'markdown' && preview.value.status === 'ready' ? renderSafeMessageMarkdown(preview.value.text) : '');
    const downloadName = Vue.computed(() => (props.state.selected?.title || 'output').replace(/[\/\\\u0000-\u001f\u007f]/g, '_'));
    const errorKey = Vue.computed(() => {
      const code = preview.value.error?.code;
      return ['tooLarge', 'unsafeUrl', 'invalidChunk'].includes(code) ? 'person.outputsError' + code[0].toUpperCase() + code.slice(1) : 'person.outputsReadFailed';
    });
    function changeZoom(delta) { fit.value = false; zoom.value = Math.max(.25, Math.min(4, zoom.value + delta)); }
    return { zoom, fit, preview, externalUrl, html, markdown, downloadName, errorKey, changeZoom };
  },
  template: `
    <section class="person-outputs person-journal" :aria-label="$t('person.outputs')">
      <p v-if="gate" class="person-panel-notice" role="status">{{ $t('person.' + gate) }}</p>
      <p v-else-if="!supported" class="person-panel-notice" role="status">{{ $t('person.outputsUnsupported') }}</p>
      <p v-else-if="fileSupported === false" class="person-panel-notice" role="status">{{ $t('person.outputsFileUnsupported') }}</p>
      <header class="person-outputs-toolbar">
        <span class="person-muted">{{ $t('person.outputsHistory') }}</span>
        <button type="button" class="btn-ghost" :disabled="disabled || !supported || state.loading" @click="$emit('refresh')">{{ $t('common.refresh') }}</button>
      </header>
      <div class="person-output-history" tabindex="0" :aria-label="$t('person.outputsHistory')" :aria-busy="state.loading">
        <p v-if="state.error" class="person-settings-error" role="alert">{{ $t('person.requestFailed') }} {{ state.error.message }}</p>
        <p v-if="state.loading" class="person-muted" role="status">{{ $t('person.loading') }}</p>
        <p v-else-if="supported && !state.items.length" class="person-muted">{{ $t('person.outputsEmpty') }}</p>
        <button v-for="item in state.items" :key="item.id" type="button" class="btn-ghost person-output-item" :class="{ active: state.selected?.id === item.id }"
          :aria-pressed="state.selected?.id === item.id" :disabled="disabled" @click="$emit('select', item)">
          <span>{{ item.title }}</span><small>{{ item.kind === 'link' ? $t('person.outputsLink') : item.mimeType }}<template v-if="item.size != null"> · {{ item.size.toLocaleString() }} B</template></small>
        </button>
        <button v-if="state.nextCursor != null" type="button" class="btn-ghost person-output-more" :disabled="disabled || state.loading || !supported" @click="$emit('more')">{{ $t('person.loadMore') }}</button>
      </div>
      <div v-if="state.selected" class="person-output-selection">
        <header class="person-output-title">
          <h3 :title="state.selected.title">{{ state.selected.title }}</h3>
          <a v-if="externalUrl" class="btn-ghost person-output-external" :href="externalUrl" target="_blank" rel="noopener noreferrer">{{ $t('person.outputsOpenExternal') }}</a>
          <a v-if="preview.url && preview.status === 'ready' && state.selected.kind === 'file'" class="btn-ghost" :href="preview.url" :download="downloadName" rel="noopener noreferrer">{{ $t('person.outputsDownload') }}</a>
        </header>
        <div v-if="preview.kind === 'image' && preview.status === 'ready'" class="person-output-image-tools">
          <button type="button" class="btn-ghost" :aria-pressed="fit" @click="fit = true; zoom = 1">{{ $t('person.outputsFit') }}</button>
          <button type="button" class="btn-ghost" :aria-label="$t('person.outputsZoomOut')" :disabled="!fit && zoom <= .25" @click="changeZoom(-.25)">−</button>
          <span class="person-muted">{{ Math.round(zoom * 100) }}%</span>
          <button type="button" class="btn-ghost" :aria-label="$t('person.outputsZoomIn')" :disabled="!fit && zoom >= 4" @click="changeZoom(.25)">+</button>
        </div>
      </div>
      <div class="person-output-preview" tabindex="0" :aria-label="$t('person.outputsPreview')" :aria-busy="preview.status === 'loading'">
        <p v-if="!state.selected" class="person-empty">{{ $t('person.outputsChoose') }}</p>
        <div v-else-if="preview.status === 'loading'" role="status" class="person-output-progress">
          <p>{{ $t('person.outputsLoading') }} {{ preview.bytes.toLocaleString() }} / {{ preview.totalBytes.toLocaleString() }} B</p>
          <progress :value="preview.bytes" :max="preview.totalBytes || 1" :aria-label="$t('person.outputsLoading')"></progress>
        </div>
        <div v-else-if="preview.status === 'error'" class="person-settings-error" role="alert">
          <p>{{ $t(errorKey) }}</p>
          <button v-if="preview.error?.code !== 'tooLarge' && preview.error?.code !== 'unsafeUrl'" type="button" class="btn-ghost" :disabled="disabled" @click="$emit('retry')">{{ $t('person.outputsRetry') }}</button>
        </div>
        <template v-else-if="preview.status === 'ready'">
          <div v-if="preview.kind === 'markdown'" class="markdown-body" v-html="markdown"></div>
          <pre v-else-if="preview.kind === 'text'" class="person-output-code"><code>{{ preview.text }}</code></pre>
          <img v-else-if="preview.kind === 'image'" :src="preview.url" :alt="state.selected.title" :class="{ 'is-fit': fit }" :style="fit ? {} : { width: (zoom * 100) + '%', maxWidth: 'none' }">
          <template v-else-if="preview.kind === 'html'">
            <p class="person-muted">{{ $t('person.outputsStaticHtml') }}</p>
            <iframe :srcdoc="html" sandbox="" tabindex="-1" referrerpolicy="no-referrer" :title="state.selected.title"></iframe>
          </template>
          <template v-else-if="preview.kind === 'link' && externalUrl">
            <p class="person-muted">{{ $t('person.outputsFrameNotice') }}</p>
            <iframe :src="externalUrl" sandbox="" tabindex="-1" referrerpolicy="no-referrer" :title="state.selected.title"></iframe>
          </template>
          <p v-else-if="preview.kind === 'pdf'" class="person-empty" role="status">{{ $t('person.outputsPdfDownload') }}</p>
          <p v-else class="person-empty">{{ $t('person.outputsBinary') }}</p>
        </template>
      </div>
    </section>
  `,
};
