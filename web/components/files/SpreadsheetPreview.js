import PreviewTable from './PreviewTable.js';
import { SPREADSHEET_PREVIEW_LIMITS } from '../../utils/spreadsheet-preview.js';

export default {
  name: 'SpreadsheetPreview',
  components: { PreviewTable },
  props: {
    buffer: { type: ArrayBuffer, required: true },
    name: { type: String, required: true },
    fontSize: { type: Number, default: 15 },
  },
  setup(props) {
    const names = Vue.ref([]);
    const sheetsLimited = Vue.ref(false);
    const activeSheet = Vue.ref(0);
    const parsed = Vue.shallowRef(null);
    const loading = Vue.ref(true);
    const error = Vue.ref('');
    let worker;
    let timer;
    let requestId = 0;
    const stop = () => {
      clearTimeout(timer);
      if (worker) { worker.onmessage = null; worker.onerror = null; worker.terminate(); }
      worker = null;
    };
    const fail = () => { stop(); loading.value = false; error.value = 'files.sheetError'; };
    function request(payload) {
      if (!worker || error.value) return;
      loading.value = true;
      error.value = '';
      parsed.value = null;
      clearTimeout(timer);
      timer = setTimeout(fail, SPREADSHEET_PREVIEW_LIMITS.timeoutMs);
      try { worker.postMessage({ ...payload, id: ++requestId }); }
      catch { fail(); }
    }
    function selectSheet(index) {
      if (!worker || error.value || !Number.isInteger(index) || index < 0 || index >= names.value.length) return;
      activeSheet.value = index;
      request({ name: names.value[index] });
    }
    function load() {
      stop();
      names.value = [];
      activeSheet.value = 0;
      if (!props.buffer.byteLength || props.buffer.byteLength > SPREADSHEET_PREVIEW_LIMITS.bytes) { fail(); return; }
      try {
        worker = new Worker(new URL(typeof SPREADSHEET_WORKER_URL === 'undefined' ? '../../spreadsheet-worker.js' : SPREADSHEET_WORKER_URL, import.meta.url));
        worker.onerror = fail;
        worker.onmessage = ({ data }) => {
          if (data.id !== requestId) return;
          clearTimeout(timer);
          if (data.error) { fail(); return; }
          if (data.result.names) {
            names.value = data.result.names;
            sheetsLimited.value = data.result.sheetsLimited;
            selectSheet(0);
          } else {
            parsed.value = data.result;
            loading.value = false;
          }
        };
        // Structured clone, not transfer: keep the original file buffer intact.
        error.value = '';
        request({ buffer: props.buffer });
      } catch { fail(); }
    }
    Vue.watch(() => props.buffer, load, { immediate: true });
    Vue.onBeforeUnmount(stop);
    const limited = Vue.computed(() => parsed.value && Object.values(parsed.value.limited).some(Boolean));
    return { names, sheetsLimited, activeSheet, parsed, loading, error, limited, selectSheet, load, limits: SPREADSHEET_PREVIEW_LIMITS };
  },
  template: `
    <div class="file-preview-container csv-preview-container spreadsheet-preview" :style="{ fontSize: fontSize + 'px' }">
      <div v-if="names.length" class="xlsx-sheet-tabs" :aria-label="$t('files.sheetWorksheets')">
        <button v-for="(sheet, index) in names" :key="index" type="button" class="xlsx-sheet-tab" :class="{ active: activeSheet === index }" :aria-pressed="activeSheet === index" :disabled="loading || !!error" @click="selectSheet(index)">{{ sheet }}</button>
      </div>
      <div v-if="sheetsLimited" class="csv-preview-notice" role="status">{{ $t('files.sheetNamesLimited', { sheets: limits.sheets }) }}</div>
      <div v-if="error" class="csv-preview-notice" role="alert">{{ $t(error) }} <button type="button" class="btn-ghost" @click="load">{{ $t('common.retry') }}</button></div>
      <div v-else-if="loading" class="preview-loading" role="status"><span class="spinner-mini" aria-hidden="true"></span>{{ $t('files.loadingPreview') }}</div>
      <div v-else-if="parsed && !parsed.rows.length" class="preview-unsupported" role="status">{{ $t('files.sheetPreviewRangeEmpty', { rows: limits.rows, columns: limits.columns }) }}</div>
      <template v-else-if="parsed">
        <div v-if="limited" class="csv-preview-notice" role="status">{{ $t('files.sheetLimited', { rows: limits.rows, columns: limits.columns, characters: limits.cellCharacters }) }}</div>
        <PreviewTable :key="activeSheet" :rows="parsed.rows" :column-count="parsed.columnCount" :name="name + ' · ' + names[activeSheet]" :default-header="false" />
      </template>
    </div>
  `,
};
