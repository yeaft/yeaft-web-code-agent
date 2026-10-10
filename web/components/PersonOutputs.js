import NavigationIcon from './NavigationIcon.js';
import { safeOutputUrl, staticOutputHtml } from '../stores/helpers/person-outputs.js';
import { renderSafeMessageMarkdown } from '../utils/safe-message-markdown.js';

export default {
  name: 'PersonOutputs',
  components: { NavigationIcon },
  props: {
    state: { type: Object, required: true },
    supported: { type: Boolean, default: false },
    fileSupported: { type: Boolean, default: null },
    disabled: { type: Boolean, default: false },
    gate: { type: String, default: '' },
    expanded: { type: Boolean, default: false },
    compact: { type: Boolean, default: false },
  },
  emits: ['select', 'close-tab', 'close', 'expand', 'refresh', 'more', 'retry'],
  setup(props, { emit, expose }) {
    const zoom = Vue.ref(1);
    const fit = Vue.ref(true);
    const libraryOpen = Vue.ref(false);
    const previewPane = Vue.ref(null);
    const closeButton = Vue.ref(null);
    const libraryButton = Vue.ref(null);
    const tabButtons = Vue.ref([]);
    let scrollDocument = null;
    const library = Vue.computed(() => !props.state.selected || libraryOpen.value);
    const preview = Vue.computed(() => props.state.preview);
    const externalUrl = Vue.computed(() => safeOutputUrl(props.state.selected?.url));
    const html = Vue.computed(() => preview.value.kind === 'html' && preview.value.status === 'ready' ? staticOutputHtml(preview.value.text) : '');
    const markdown = Vue.computed(() => preview.value.kind === 'markdown' && preview.value.status === 'ready' ? renderSafeMessageMarkdown(preview.value.text) : '');
    const downloadName = Vue.computed(() => (props.state.selected?.title || 'output').replace(/[\/\\\u0000-\u001f\u007f]/g, '_'));
    const errorKey = Vue.computed(() => {
      const code = preview.value.error?.code;
      return ['tooLarge', 'unsafeUrl', 'invalidChunk'].includes(code) ? 'person.outputsError' + code[0].toUpperCase() + code.slice(1) : 'person.outputsReadFailed';
    });
    function saveScroll(id = props.state.selected?.id) {
      const tab = props.state.tabs.find(tab => tab.item.id === id);
      if (tab && previewPane.value && scrollDocument === id) {
        tab.scrollTop = previewPane.value.scrollTop;
        tab.scrollLeft = previewPane.value.scrollLeft;
      }
    }
    async function restoreScroll() {
      const selected = props.state.selected?.id, activePreview = preview.value;
      await Vue.nextTick();
      if (selected !== props.state.selected?.id || activePreview !== preview.value || library.value || preview.value.status !== 'ready') return;
      const tab = props.state.tabs.find(tab => tab.item.id === selected);
      if (tab && previewPane.value) {
        previewPane.value.scrollTop = tab.scrollTop;
        previewPane.value.scrollLeft = tab.scrollLeft;
        scrollDocument = selected;
      }
    }
    Vue.watch(() => props.state.selected?.id, (_, old) => {
      saveScroll(old); scrollDocument = null; libraryOpen.value = false; zoom.value = 1; fit.value = true;
    }, { flush: 'sync' });
    Vue.watch([() => props.state.selected?.id, () => preview.value.status, library], restoreScroll, { flush: 'post' });
    Vue.onMounted(restoreScroll);
    Vue.onBeforeUnmount(() => saveScroll());
    function select(item) { saveScroll(); libraryOpen.value = false; emit('select', item); }
    async function closeTab(id) {
      saveScroll(); emit('close-tab', id);
      await Vue.nextTick();
      const selected = tabButtons.value.find(button => button.dataset.outputId === props.state.selected?.id);
      (selected || libraryButton.value)?.focus();
    }
    function toggleLibrary() { saveScroll(); libraryOpen.value = !libraryOpen.value; }
    function tabKeydown(event, index) {
      const tabs = props.state.tabs;
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      else if (event.key === 'Delete') { event.preventDefault(); closeTab(tabs[index].item.id); return; }
      if (next == null || props.disabled) return;
      event.preventDefault(); select(tabs[next].item);
      tabButtons.value.find(button => button.dataset.outputId === tabs[next].item.id)?.focus();
    }
    function changeZoom(delta) { fit.value = false; zoom.value = Math.max(.25, Math.min(4, zoom.value + delta)); }
    expose({ focusClose: () => closeButton.value?.focus() });
    return { zoom, fit, library, libraryOpen, previewPane, closeButton, libraryButton, tabButtons, preview, externalUrl, html, markdown, downloadName, errorKey, changeZoom, saveScroll, select, closeTab, toggleLibrary, tabKeydown };
  },
  template: `
    <section class="person-outputs person-journal" :aria-label="$t('person.outputs')">
      <header class="person-outputs-toolbar">
        <div class="person-output-tabs" role="tablist" :aria-label="$t('person.outputsOpenDocuments')">
          <div v-for="(tab, index) in state.tabs" :key="tab.item.id" class="person-output-tab" :class="{ active: state.selected?.id === tab.item.id }">
            <button ref="tabButtons" type="button" class="btn-ghost person-output-tab-select" role="tab" :data-output-id="tab.item.id" :aria-selected="state.selected?.id === tab.item.id" aria-controls="person-output-document" :tabindex="state.selected?.id === tab.item.id ? 0 : -1" :disabled="disabled" :title="tab.item.title" @click="select(tab.item)" @keydown="tabKeydown($event, index)">
              <NavigationIcon :name="tab.item.kind === 'link' ? 'globe' : 'file'" :size="14" /><span>{{ tab.item.title }}</span>
            </button>
            <button type="button" class="btn-ghost person-output-tab-close" :aria-label="$t('person.outputsCloseDocument') + ': ' + tab.item.title" :title="$t('person.outputsCloseDocument')" @click="closeTab(tab.item.id)"><NavigationIcon name="close" :size="12" /></button>
          </div>
          <span v-if="!state.tabs.length" class="person-output-library-label">{{ $t('person.outputs') }}</span>
        </div>
        <div class="person-output-actions">
          <button ref="libraryButton" type="button" class="btn-ghost person-output-library-button" :aria-label="$t('person.outputsHistory')" :title="$t('person.outputsHistory')" :aria-expanded="library" aria-controls="person-output-library" @click="toggleLibrary"><NavigationIcon name="file" /></button>
          <a v-if="externalUrl" class="btn-ghost person-output-external" :href="externalUrl" target="_blank" rel="noopener noreferrer" :aria-label="$t('person.outputsOpenExternal')" :title="$t('person.outputsOpenExternal')"><NavigationIcon name="external" /></a>
          <a v-if="preview.url && preview.status === 'ready' && state.selected?.kind === 'file'" class="btn-ghost" :href="preview.url" :download="downloadName" rel="noopener noreferrer" :aria-label="$t('person.outputsDownload')" :title="$t('person.outputsDownload')"><NavigationIcon name="download" /></a>
          <button v-if="!compact" type="button" class="btn-ghost person-output-expand" :aria-pressed="expanded" :aria-label="$t(expanded ? 'person.outputsCollapse' : 'person.outputsExpand')" :title="$t(expanded ? 'person.outputsCollapse' : 'person.outputsExpand')" @click="$emit('expand')"><NavigationIcon :name="expanded ? 'restore' : 'expand'" /></button>
          <button ref="closeButton" type="button" class="btn-ghost person-output-reader-close" :aria-label="$t('person.outputsCloseReader')" :title="$t('person.outputsCloseReader')" @click="$emit('close')"><NavigationIcon name="close" /></button>
        </div>
      </header>
      <p v-if="gate" class="person-panel-notice" role="status">{{ $t('person.' + gate) }}</p>
      <p v-else-if="!supported" class="person-panel-notice" role="status">{{ $t('person.outputsUnsupported') }}</p>
      <p v-else-if="fileSupported === false" class="person-panel-notice" role="status">{{ $t('person.outputsFileUnsupported') }}</p>
      <div v-if="library" id="person-output-library" class="person-output-library" tabindex="0" :aria-label="$t('person.outputsHistory')" :aria-busy="state.loading">
        <header class="person-output-library-heading"><h3>{{ $t('person.outputsHistory') }}</h3><button type="button" class="btn-ghost" :disabled="disabled || !supported || state.loading" @click="$emit('refresh')"><NavigationIcon name="refresh" :size="14" />{{ $t('common.refresh') }}</button></header>
        <p v-if="state.error" class="person-settings-error" role="alert">{{ $t('person.requestFailed') }} {{ state.error.message }}</p>
        <p v-if="state.loading" class="person-muted" role="status">{{ $t('person.loading') }}</p>
        <p v-else-if="supported && !state.items.length" class="person-muted">{{ $t('person.outputsEmpty') }}</p>
        <button v-for="item in state.items" :key="item.id" type="button" class="btn-ghost person-output-item" :class="{ active: state.selected?.id === item.id }" :aria-pressed="state.selected?.id === item.id" :disabled="disabled" @click="select(item)">
          <NavigationIcon :name="item.kind === 'link' ? 'globe' : 'file'" /><span>{{ item.title }}<small>{{ item.kind === 'link' ? $t('person.outputsLink') : item.mimeType }}<template v-if="item.size != null"> · {{ item.size.toLocaleString() }} B</template></small></span>
        </button>
        <button v-if="state.nextCursor != null" type="button" class="btn-ghost person-output-more" :disabled="disabled || state.loading || !supported" @click="$emit('more')">{{ $t('person.loadMore') }}</button>
      </div>
      <template v-else>
        <div v-if="preview.kind === 'image' && preview.status === 'ready'" class="person-output-image-tools">
          <button type="button" class="btn-ghost" :aria-pressed="fit" @click="fit = true; zoom = 1">{{ $t('person.outputsFit') }}</button>
          <button type="button" class="btn-ghost" :aria-label="$t('person.outputsZoomOut')" :disabled="!fit && zoom <= .25" @click="changeZoom(-.25)">−</button>
          <span class="person-muted">{{ Math.round(zoom * 100) }}%</span>
          <button type="button" class="btn-ghost" :aria-label="$t('person.outputsZoomIn')" :disabled="!fit && zoom >= 4" @click="changeZoom(.25)">+</button>
        </div>
        <div id="person-output-document" ref="previewPane" class="person-output-preview" role="tabpanel" tabindex="0" :aria-label="state.selected.title" :aria-busy="preview.status === 'loading'" @scroll.passive="preview.status === 'ready' && saveScroll()">
          <div v-if="preview.status === 'loading'" role="status" class="person-output-progress">
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
              <p class="person-output-safety-note">{{ $t('person.outputsStaticHtml') }}</p>
              <iframe :srcdoc="html" sandbox="" tabindex="-1" referrerpolicy="no-referrer" :title="state.selected.title"></iframe>
            </template>
            <template v-else-if="preview.kind === 'link' && externalUrl">
              <p class="person-output-safety-note">{{ $t('person.outputsFrameNotice') }}</p>
              <iframe :src="externalUrl" sandbox="" tabindex="-1" referrerpolicy="no-referrer" :title="state.selected.title"></iframe>
            </template>
            <p v-else-if="preview.kind === 'pdf'" class="person-empty" role="status">{{ $t('person.outputsPdfDownload') }}</p>
            <p v-else class="person-empty">{{ $t('person.outputsBinary') }}</p>
          </template>
        </div>
      </template>
    </section>
  `,
};
